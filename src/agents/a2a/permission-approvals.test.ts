import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  createPendingA2AApproval,
  expirePendingA2AApprovals,
  getPendingA2AApproval,
  resolvePendingA2AApproval,
  resolvePendingA2AApprovalStorePath,
} from "./permission-approvals.js";

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

describe("pending A2A approvals", () => {
  it("persists approvals to disk and reloads them from the state store", async () => {
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

      const storePath = resolvePendingA2AApprovalStorePath(baseDir);
      const raw = JSON.parse(await fs.readFile(storePath, "utf8")) as {
        approvals?: Record<string, unknown>;
      };
      expect(raw.approvals?.["approval-1"]).toBeDefined();

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
      });

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
        decision: "approve",
        actorId: "U-approve",
        nowMs: 500,
      });
      expect(first).toMatchObject({
        status: "resolved",
        record: {
          approvalId: "approval-dup",
          state: "approved",
          approvedBy: "U-approve",
        },
      });

      const second = await resolvePendingA2AApproval({
        baseDir,
        approvalId: "approval-dup",
        decision: "deny",
        actorId: "U-deny",
        nowMs: 600,
      });
      expect(second).toMatchObject({
        status: "already-resolved",
        record: {
          approvalId: "approval-dup",
          state: "approved",
          approvedBy: "U-approve",
        },
      });
    });
  });
});
