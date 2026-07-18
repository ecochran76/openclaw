import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  A2A_APPROVAL_CLAIM_LEASE_MS,
  A2A_APPROVAL_COMMIT_AUTHORIZATION_LEASE_MS,
  A2A_APPROVAL_RETENTION_AFTER_EXPIRY_MS,
  authorizePendingA2AApprovalClaim,
  claimPendingA2AApproval,
  createPendingA2AApproval,
  expirePendingA2AApprovals,
  finishPendingA2AApprovalClaim,
  getPendingA2AApproval,
  releasePendingA2AApprovalClaim,
  resolvePendingA2AApproval,
} from "./permission-approvals.js";

const execFileAsync = promisify(execFile);

const basePermissionRequest = {
  kind: "config_permission_request" as const,
  reason: "agent_to_agent_allow" as const,
  action: "send" as const,
  requesterAgentId: "dev-agent",
  targetAgentId: "gpod",
  retryable: true as const,
  askUser: "Allow dev-agent -> gpod?",
  suggestedChanges: [{ path: "tools.agentToAgent.allow" as const, value: ["dev-agent", "gpod"] }],
  missingAllowAgents: ["dev-agent"],
};

afterEach(() => {
  closeOpenClawStateDatabase();
});

async function claimInChildProcess(params: {
  approvalId: string;
  baseDir: string;
  actorId: string;
  readyPath: string;
  startPath: string;
}): Promise<{ status: string; claimId?: string }> {
  const workerSource = `
    const fs = await import("node:fs/promises");
    const approvals = await import(process.env.OPENCLAW_A2A_APPROVAL_MODULE_URL);
    const stateDb = await import(process.env.OPENCLAW_STATE_DB_MODULE_URL);
    try {
      await fs.writeFile(process.env.OPENCLAW_A2A_READY_PATH, "ready");
      while (true) {
        try {
          await fs.access(process.env.OPENCLAW_A2A_START_PATH);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      }
      const result = await approvals.claimPendingA2AApproval({
        approvalId: process.env.OPENCLAW_A2A_APPROVAL_ID,
        actorId: process.env.OPENCLAW_A2A_ACTOR_ID,
        baseDir: process.env.OPENCLAW_A2A_STATE_DIR,
        nowMs: 500,
      });
      console.log(JSON.stringify({ status: result.status, claimId: result.claimId }));
    } finally {
      stateDb.closeOpenClawStateDatabase();
    }
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", workerSource],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_A2A_ACTOR_ID: params.actorId,
        OPENCLAW_A2A_APPROVAL_ID: params.approvalId,
        OPENCLAW_A2A_APPROVAL_MODULE_URL: new URL("./permission-approvals.ts", import.meta.url)
          .href,
        OPENCLAW_A2A_READY_PATH: params.readyPath,
        OPENCLAW_A2A_START_PATH: params.startPath,
        OPENCLAW_A2A_STATE_DIR: params.baseDir,
        OPENCLAW_STATE_DB_MODULE_URL: new URL("../../state/openclaw-state-db.ts", import.meta.url)
          .href,
      },
      timeout: 15_000,
    },
  );
  const resultLine = stdout.trim().split("\n").at(-1);
  if (!resultLine) {
    throw new Error("A2A claim worker produced no result");
  }
  return JSON.parse(resultLine) as { status: string; claimId?: string };
}

async function waitForFiles(paths: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (true) {
    const ready = await Promise.all(
      paths.map(async (pathname) => {
        try {
          await fs.access(pathname);
          return true;
        } catch {
          return false;
        }
      }),
    );
    if (ready.every(Boolean)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for A2A claim workers");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 2);
    });
  }
}

describe("pending A2A approvals", () => {
  it("persists approvals in shared SQLite and reloads them after reopening", async () => {
    await withTempDir({ prefix: "openclaw-a2a-approvals-" }, async (baseDir) => {
      const created = await createPendingA2AApproval({
        baseDir,
        approvalId: "approval-1",
        nowMs: 1_000,
        ttlMs: 60_000,
        permissionRequest: basePermissionRequest,
        originalToolName: "sessions_send",
        originalArgs: { agentId: "gpod", message: "ping" },
        sessionKey: "agent:dev-agent:main",
      });

      expect(created).toMatchObject({
        approvalId: "approval-1",
        state: "pending",
        sessionKey: "agent:dev-agent:main",
      });

      closeOpenClawStateDatabase();

      const reloaded = await getPendingA2AApproval({
        approvalId: "approval-1",
        baseDir,
        nowMs: 2_000,
      });
      expect(reloaded).toMatchObject({
        approvalId: "approval-1",
        state: "pending",
        requesterAgentId: "dev-agent",
        targetAgentId: "gpod",
        originalToolName: "sessions_send",
      });
    });
  });

  it("additively creates the approval table and indexes in an existing schema-v2 database", async () => {
    await withTempDir({ prefix: "openclaw-a2a-approvals-" }, async (baseDir) => {
      const options = { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } };
      const initial = openOpenClawStateDatabase(options);
      const databasePath = initial.path;
      closeOpenClawStateDatabase();

      const { DatabaseSync } = requireNodeSqlite();
      const existing = new DatabaseSync(databasePath);
      existing.exec("DROP TABLE a2a_permission_approvals;");
      expect(existing.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
      existing.close();

      const reopened = openOpenClawStateDatabase(options);
      expect(reopened.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
      const objects = reopened.db
        .prepare(
          `SELECT type, name FROM sqlite_schema
           WHERE name IN (
             'a2a_permission_approvals',
             'idx_a2a_permission_approvals_expiry',
             'idx_a2a_permission_approvals_state_expiry'
           )
           ORDER BY type DESC, name ASC`,
        )
        .all();
      expect(objects).toEqual([
        { type: "table", name: "a2a_permission_approvals" },
        { type: "index", name: "idx_a2a_permission_approvals_expiry" },
        { type: "index", name: "idx_a2a_permission_approvals_state_expiry" },
      ]);
    });
  });

  it("atomically grants only one claim when duplicate workers race", async () => {
    await withTempDir({ prefix: "openclaw-a2a-approvals-" }, async (baseDir) => {
      await createPendingA2AApproval({
        baseDir,
        approvalId: "approval-claim-race",
        nowMs: 0,
        ttlMs: 60_000,
        permissionRequest: basePermissionRequest,
        originalToolName: "sessions_send",
        originalArgs: { agentId: "gpod", message: "ping" },
      });

      closeOpenClawStateDatabase();
      const startPath = path.join(baseDir, "claim-workers-start");
      const readyPaths = [
        path.join(baseDir, "claim-worker-a-ready"),
        path.join(baseDir, "claim-worker-b-ready"),
      ];
      const workers = [
        claimInChildProcess({
          baseDir,
          approvalId: "approval-claim-race",
          actorId: "worker-a",
          readyPath: readyPaths[0],
          startPath,
        }),
        claimInChildProcess({
          baseDir,
          approvalId: "approval-claim-race",
          actorId: "worker-b",
          readyPath: readyPaths[1],
          startPath,
        }),
      ];
      await waitForFiles(readyPaths);
      await fs.writeFile(startPath, "start");
      const results = await Promise.all(workers);

      expect(results.map((result) => result.status).toSorted()).toEqual([
        "already-resolved",
        "claimed",
      ]);
      const claimed = results.find((result) => result.status === "claimed");
      const stored = await getPendingA2AApproval({
        baseDir,
        approvalId: "approval-claim-race",
        nowMs: 500,
      });
      expect(stored).toMatchObject({
        state: "applying",
        claimId: claimed?.claimId,
      });

      const wrongClaim = await finishPendingA2AApprovalClaim({
        baseDir,
        approvalId: "approval-claim-race",
        claimId: "wrong-claim",
        decision: "approve",
        nowMs: 600,
      });
      expect(wrongClaim).toMatchObject({
        status: "already-resolved",
        record: { state: "applying", claimId: claimed?.claimId },
      });
    });
  });

  it("requires a live commit authorization before approving a claimed request", async () => {
    await withTempDir({ prefix: "openclaw-a2a-approvals-" }, async (baseDir) => {
      const createClaim = async (approvalId: string, nowMs: number) => {
        await createPendingA2AApproval({
          baseDir,
          approvalId,
          nowMs,
          ttlMs: 10 * 60 * 1000,
          permissionRequest: basePermissionRequest,
          originalToolName: "sessions_send",
          originalArgs: { message: approvalId },
        });
        const claimed = await claimPendingA2AApproval({
          baseDir,
          approvalId,
          nowMs: nowMs + 1,
        });
        expect(claimed.status).toBe("claimed");
        if (claimed.status !== "claimed") {
          throw new Error("expected claim");
        }
        return claimed;
      };

      const unauthorized = await createClaim("approval-never-authorized", 0);
      await expect(
        finishPendingA2AApprovalClaim({
          baseDir,
          approvalId: unauthorized.record.approvalId,
          claimId: unauthorized.claimId,
          decision: "approve",
          nowMs: 2,
        }),
      ).resolves.toMatchObject({
        status: "authorization-required",
        record: { state: "applying", claimId: unauthorized.claimId },
      });

      const expired = await createClaim("approval-expired-authorization", 1_000_000);
      await authorizePendingA2AApprovalClaim({
        baseDir,
        approvalId: expired.record.approvalId,
        claimId: expired.claimId,
        nowMs: 1_000_001,
      });
      await expect(
        finishPendingA2AApprovalClaim({
          baseDir,
          approvalId: expired.record.approvalId,
          claimId: expired.claimId,
          decision: "approve",
          nowMs: 1_000_001 + A2A_APPROVAL_COMMIT_AUTHORIZATION_LEASE_MS,
        }),
      ).resolves.toMatchObject({
        status: "authorization-required",
        record: { state: "pending" },
      });

      const authorized = await createClaim("approval-authorized", 2_000_000);
      const commitAuthorized = await authorizePendingA2AApprovalClaim({
        baseDir,
        approvalId: authorized.record.approvalId,
        claimId: authorized.claimId,
        nowMs: 2_000_001,
      });
      expect(commitAuthorized.status).toBe("authorized");
      if (commitAuthorized.status !== "authorized") {
        throw new Error("expected commit authorization");
      }
      await expect(
        finishPendingA2AApprovalClaim({
          baseDir,
          approvalId: authorized.record.approvalId,
          claimId: authorized.claimId,
          decision: "approve",
          commitAuthorization: commitAuthorized.commitAuthorization,
          nowMs: 2_000_002,
        }),
      ).resolves.toMatchObject({ status: "resolved", record: { state: "approved" } });

      const committedAcrossExpiry = await createClaim(
        "approval-committed-across-expiry",
        4_000_000,
      );
      const commitReceipt = await authorizePendingA2AApprovalClaim({
        baseDir,
        approvalId: committedAcrossExpiry.record.approvalId,
        claimId: committedAcrossExpiry.claimId,
        nowMs: 4_000_001,
      });
      expect(commitReceipt.status).toBe("authorized");
      if (commitReceipt.status !== "authorized") {
        throw new Error("expected commit authorization");
      }
      await expect(
        finishPendingA2AApprovalClaim({
          baseDir,
          approvalId: committedAcrossExpiry.record.approvalId,
          claimId: committedAcrossExpiry.claimId,
          decision: "approve",
          commitAuthorization: commitReceipt.commitAuthorization,
          nowMs: committedAcrossExpiry.record.expiresAt + 1,
        }),
      ).resolves.toMatchObject({ status: "resolved", record: { state: "approved" } });

      const obsolete = await createClaim("approval-obsolete-without-authorization", 3_000_000);
      await expect(
        finishPendingA2AApprovalClaim({
          baseDir,
          approvalId: obsolete.record.approvalId,
          claimId: obsolete.claimId,
          decision: "obsolete",
          nowMs: 3_000_002,
        }),
      ).resolves.toMatchObject({ status: "resolved", record: { state: "obsolete" } });
    });
  });

  it("allows an immediate retry after an awaited claim release", async () => {
    await withTempDir({ prefix: "openclaw-a2a-approvals-" }, async (baseDir) => {
      const created = await createPendingA2AApproval({
        baseDir,
        permissionRequest: basePermissionRequest,
        originalToolName: "sessions_send",
        originalArgs: { message: "retry" },
      });
      const first = await claimPendingA2AApproval({
        baseDir,
        approvalId: created.approvalId,
        actorId: "worker-a",
      });
      expect(first.status).toBe("claimed");
      if (first.status !== "claimed") {
        throw new Error("expected first claim");
      }

      await releasePendingA2AApprovalClaim({
        baseDir,
        approvalId: created.approvalId,
        claimId: first.claimId,
      });
      const retry = await claimPendingA2AApproval({
        baseDir,
        approvalId: created.approvalId,
        actorId: "worker-b",
      });

      expect(retry).toMatchObject({ status: "claimed", record: { applyingBy: "worker-b" } });
      if (retry.status === "claimed") {
        expect(retry.claimId).not.toBe(first.claimId);
      }
    });
  });

  it("recovers an abandoned commit authorization after its bounded lease", async () => {
    await withTempDir({ prefix: "openclaw-a2a-approvals-" }, async (baseDir) => {
      const created = await createPendingA2AApproval({
        baseDir,
        permissionRequest: basePermissionRequest,
        originalToolName: "sessions_send",
        originalArgs: { message: "recover" },
        nowMs: 0,
        ttlMs: 10 * 60 * 1000,
      });
      const claimed = await claimPendingA2AApproval({
        baseDir,
        approvalId: created.approvalId,
        nowMs: 1_000,
      });
      expect(claimed.status).toBe("claimed");
      if (claimed.status !== "claimed") {
        throw new Error("expected claim");
      }
      await expect(
        authorizePendingA2AApprovalClaim({
          baseDir,
          approvalId: created.approvalId,
          claimId: claimed.claimId,
          nowMs: 1_000,
        }),
      ).resolves.toMatchObject({ status: "authorized" });

      const beforeLeaseExpiry = 1_000 + A2A_APPROVAL_COMMIT_AUTHORIZATION_LEASE_MS - 1;
      await expect(
        getPendingA2AApproval({
          baseDir,
          approvalId: created.approvalId,
          nowMs: beforeLeaseExpiry,
        }),
      ).resolves.toMatchObject({ state: "applying", claimId: claimed.claimId });

      const afterLeaseExpiry = 1_000 + A2A_APPROVAL_COMMIT_AUTHORIZATION_LEASE_MS;
      await expect(
        getPendingA2AApproval({
          baseDir,
          approvalId: created.approvalId,
          nowMs: afterLeaseExpiry,
        }),
      ).resolves.toMatchObject({ state: "pending" });
      await expect(
        claimPendingA2AApproval({
          baseDir,
          approvalId: created.approvalId,
          actorId: "recovery-worker",
          nowMs: afterLeaseExpiry,
        }),
      ).resolves.toMatchObject({ status: "claimed", record: { applyingBy: "recovery-worker" } });
    });
  });

  it("recovers an abandoned claim before commit authorization after its bounded lease", async () => {
    await withTempDir({ prefix: "openclaw-a2a-approvals-" }, async (baseDir) => {
      const created = await createPendingA2AApproval({
        baseDir,
        permissionRequest: basePermissionRequest,
        originalToolName: "sessions_send",
        originalArgs: { message: "recover pre-authorization" },
        nowMs: 0,
        ttlMs: 10 * 60 * 1000,
      });
      const claimed = await claimPendingA2AApproval({
        baseDir,
        approvalId: created.approvalId,
        actorId: "abandoned-worker",
        nowMs: 1_000,
      });
      expect(claimed.status).toBe("claimed");
      if (claimed.status !== "claimed") {
        throw new Error("expected claim");
      }

      const beforeLeaseExpiry = 1_000 + A2A_APPROVAL_CLAIM_LEASE_MS - 1;
      await expect(
        getPendingA2AApproval({
          baseDir,
          approvalId: created.approvalId,
          nowMs: beforeLeaseExpiry,
        }),
      ).resolves.toMatchObject({
        state: "applying",
        claimId: claimed.claimId,
        applyingBy: "abandoned-worker",
      });

      const afterLeaseExpiry = 1_000 + A2A_APPROVAL_CLAIM_LEASE_MS;
      await expect(
        claimPendingA2AApproval({
          baseDir,
          approvalId: created.approvalId,
          actorId: "recovery-worker",
          nowMs: afterLeaseExpiry,
        }),
      ).resolves.toMatchObject({
        status: "claimed",
        record: { applyingBy: "recovery-worker" },
      });
    });
  });

  it("caps commit authorization at the approval expiry", async () => {
    await withTempDir({ prefix: "openclaw-a2a-approvals-" }, async (baseDir) => {
      const created = await createPendingA2AApproval({
        baseDir,
        permissionRequest: basePermissionRequest,
        originalToolName: "sessions_send",
        originalArgs: { message: "bounded" },
        nowMs: 0,
        ttlMs: 60_000,
      });
      const claimed = await claimPendingA2AApproval({
        baseDir,
        approvalId: created.approvalId,
        nowMs: 1_000,
      });
      expect(claimed.status).toBe("claimed");
      if (claimed.status !== "claimed") {
        throw new Error("expected claim");
      }

      const authorized = await authorizePendingA2AApprovalClaim({
        baseDir,
        approvalId: created.approvalId,
        claimId: claimed.claimId,
        nowMs: 1_000,
      });
      expect(authorized).toMatchObject({
        status: "authorized",
        record: { commitAuthorizationExpiresAt: created.expiresAt },
      });

      await expect(
        getPendingA2AApproval({
          baseDir,
          approvalId: created.approvalId,
          nowMs: created.expiresAt,
        }),
      ).resolves.toMatchObject({ state: "expired" });
    });
  });

  it("does not renew commit authorization past the approval expiry", async () => {
    await withTempDir({ prefix: "openclaw-a2a-approvals-" }, async (baseDir) => {
      const created = await createPendingA2AApproval({
        baseDir,
        permissionRequest: basePermissionRequest,
        originalToolName: "sessions_send",
        originalArgs: { message: "no renewal" },
        nowMs: 0,
        ttlMs: 310_000,
      });
      const claimed = await claimPendingA2AApproval({
        baseDir,
        approvalId: created.approvalId,
        nowMs: 1_000,
      });
      expect(claimed.status).toBe("claimed");
      if (claimed.status !== "claimed") {
        throw new Error("expected claim");
      }

      const first = await authorizePendingA2AApprovalClaim({
        baseDir,
        approvalId: created.approvalId,
        claimId: claimed.claimId,
        nowMs: 1_000,
      });
      expect(first).toMatchObject({ status: "authorized" });
      const renewed = await authorizePendingA2AApprovalClaim({
        baseDir,
        approvalId: created.approvalId,
        claimId: claimed.claimId,
        nowMs: 299_000,
      });
      expect(renewed).toMatchObject({
        status: "authorized",
        record: { commitAuthorizationExpiresAt: created.expiresAt },
      });

      await expect(
        getPendingA2AApproval({
          baseDir,
          approvalId: created.approvalId,
          nowMs: created.expiresAt,
        }),
      ).resolves.toMatchObject({ state: "expired" });
    });
  });

  it("marks pending approvals expired when their TTL elapses", async () => {
    await withTempDir({ prefix: "openclaw-a2a-approvals-" }, async (baseDir) => {
      await createPendingA2AApproval({
        baseDir,
        approvalId: "approval-expire",
        nowMs: 10,
        ttlMs: 1_000,
        permissionRequest: basePermissionRequest,
        originalToolName: "sessions_history",
        originalArgs: { sessionKey: "agent:gpod:main" },
      });

      const expired = await expirePendingA2AApprovals({
        baseDir,
        nowMs: 1_500,
      });
      expect(expired).toHaveLength(1);
      expect(expired[0]).toMatchObject({
        approvalId: "approval-expire",
        state: "expired",
        originalArgs: {},
        permissionRequest: { askUser: "", suggestedChanges: [] },
      });
      expect(expired[0]?.sessionKey).toBeUndefined();

      const reloaded = await getPendingA2AApproval({
        approvalId: "approval-expire",
        baseDir,
        nowMs: 1_500,
      });
      expect(reloaded).toMatchObject({
        approvalId: "approval-expire",
        state: "expired",
        expiredAt: 1_500,
      });
    });
  });

  it("refuses to resolve expired approvals", async () => {
    await withTempDir({ prefix: "openclaw-a2a-approvals-" }, async (baseDir) => {
      await createPendingA2AApproval({
        baseDir,
        approvalId: "approval-too-late",
        nowMs: 0,
        ttlMs: 1_000,
        permissionRequest: basePermissionRequest,
        originalToolName: "session_status",
        originalArgs: { sessionKey: "agent:gpod:main" },
      });

      const result = await resolvePendingA2AApproval({
        baseDir,
        approvalId: "approval-too-late",
        decision: "approve",
        actorId: "U123",
        nowMs: 2_000,
      });
      expect(result).toMatchObject({
        status: "expired",
        record: {
          approvalId: "approval-too-late",
          state: "expired",
        },
      });
    });
  });

  it("requires the claim and commit-authorization path for direct approvals", async () => {
    await withTempDir({ prefix: "openclaw-a2a-approvals-" }, async (baseDir) => {
      await createPendingA2AApproval({
        baseDir,
        approvalId: "approval-direct-approve",
        nowMs: 0,
        ttlMs: 60_000,
        permissionRequest: basePermissionRequest,
        originalToolName: "sessions_send",
        originalArgs: { agentId: "gpod", message: "ping" },
      });

      const result = await resolvePendingA2AApproval({
        baseDir,
        approvalId: "approval-direct-approve",
        decision: "approve",
        actorId: "U-approve",
        nowMs: 500,
      });

      expect(result).toMatchObject({
        status: "authorization-required",
        record: {
          approvalId: "approval-direct-approve",
          state: "pending",
        },
      });
      await expect(
        getPendingA2AApproval({
          baseDir,
          approvalId: "approval-direct-approve",
          nowMs: 500,
        }),
      ).resolves.toMatchObject({ state: "pending" });
    });
  });

  it("keeps the first resolution when duplicate clicks arrive", async () => {
    await withTempDir({ prefix: "openclaw-a2a-approvals-" }, async (baseDir) => {
      await createPendingA2AApproval({
        baseDir,
        approvalId: "approval-dup",
        nowMs: 0,
        ttlMs: 60_000,
        permissionRequest: basePermissionRequest,
        originalToolName: "sessions_send",
        originalArgs: { agentId: "gpod", message: "ping" },
      });

      const first = await resolvePendingA2AApproval({
        baseDir,
        approvalId: "approval-dup",
        decision: "deny",
        actorId: "U-deny",
        nowMs: 500,
      });
      expect(first).toMatchObject({
        status: "resolved",
        record: {
          approvalId: "approval-dup",
          state: "denied",
          deniedBy: "U-deny",
          originalArgs: {},
          permissionRequest: { askUser: "", suggestedChanges: [] },
        },
      });

      const second = await resolvePendingA2AApproval({
        baseDir,
        approvalId: "approval-dup",
        decision: "approve",
        actorId: "U-approve",
        nowMs: 600,
      });
      expect(second).toMatchObject({
        status: "already-resolved",
        record: {
          approvalId: "approval-dup",
          state: "denied",
          deniedBy: "U-deny",
        },
      });
    });
  });

  it("prunes approvals one hour after expiry when production creates the next request", async () => {
    await withTempDir({ prefix: "openclaw-a2a-approvals-" }, async (baseDir) => {
      for (const approvalId of ["approval-old-terminal", "approval-old-abandoned"]) {
        await createPendingA2AApproval({
          baseDir,
          approvalId,
          nowMs: 0,
          ttlMs: 1_000,
          permissionRequest: basePermissionRequest,
          originalToolName: "sessions_send",
          originalArgs: { message: "sensitive replay payload" },
        });
      }
      await resolvePendingA2AApproval({
        baseDir,
        approvalId: "approval-old-terminal",
        decision: "deny",
        nowMs: 500,
      });

      const pruneAtMs = 1_000 + A2A_APPROVAL_RETENTION_AFTER_EXPIRY_MS + 1;
      await createPendingA2AApproval({
        baseDir,
        approvalId: "approval-new",
        nowMs: pruneAtMs,
        ttlMs: 60_000,
        permissionRequest: basePermissionRequest,
        originalToolName: "sessions_send",
        originalArgs: { message: "new" },
      });

      await expect(
        getPendingA2AApproval({
          baseDir,
          approvalId: "approval-old-terminal",
          nowMs: pruneAtMs,
        }),
      ).resolves.toBeNull();
      await expect(
        getPendingA2AApproval({
          baseDir,
          approvalId: "approval-old-abandoned",
          nowMs: pruneAtMs,
        }),
      ).resolves.toBeNull();
      await expect(
        getPendingA2AApproval({ baseDir, approvalId: "approval-new", nowMs: pruneAtMs }),
      ).resolves.toMatchObject({ state: "pending" });
    });
  });
});
