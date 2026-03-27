import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache } from "../../config/config.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  buildA2APermissionApprovalResolvedText,
  resolvePendingA2APermissionApproval,
} from "./permission-approval-action.js";
import {
  buildA2APermissionApprovalPendingReplyPayload,
  getA2APermissionApprovalReplyMetadata,
  parseA2APermissionApprovalCustomId,
} from "./permission-approval-reply.js";
import { createPendingA2AApproval, getPendingA2AApproval } from "./permission-approvals.js";

afterEach(() => {
  clearConfigCache();
});

async function withTempConfigState(
  config: Record<string, unknown>,
  run: (params: { configPath: string; stateDir: string }) => Promise<void>,
): Promise<void> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-a2a-approval-"));
  const configPath = path.join(fixtureRoot, "openclaw.json");
  const stateDir = path.join(fixtureRoot, "state");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  try {
    await withEnvAsync(
      {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_CONFIG_CACHE: "1",
        OPENCLAW_STATE_DIR: stateDir,
      },
      async () => {
        clearConfigCache();
        await run({ configPath, stateDir });
      },
    );
  } finally {
    clearConfigCache();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

describe("A2A permission approval reply helpers", () => {
  it("builds Slack approval payloads with metadata and interactive buttons", () => {
    const payload = buildA2APermissionApprovalPendingReplyPayload({
      approvalId: "approval-123",
      sessionKey: "agent:dev-agent:slack:channel:C1:thread:100.100",
      expiresAt: 60_000,
      nowMs: 0,
      permissionRequest: {
        kind: "config_permission_request",
        reason: "agent_to_agent_allow",
        action: "send",
        requesterAgentId: "dev-agent",
        targetAgentId: "gpod",
        retryable: true,
        askUser: "Allow agent-to-agent send for dev-agent -> gpod?",
        missingAllowAgents: ["dev-agent"],
        suggestedChanges: [{ path: "tools.agentToAgent.allow", value: ["gpod", "dev-agent"] }],
      },
    });

    expect(parseA2APermissionApprovalCustomId("a2aapproval:approval-123:a")).toEqual({
      approvalId: "approval-123",
      decision: "approve",
    });
    expect(parseA2APermissionApprovalCustomId("a2aapproval:approval-123:d")).toEqual({
      approvalId: "approval-123",
      decision: "deny",
    });
    expect(getA2APermissionApprovalReplyMetadata(payload)).toEqual({
      approvalId: "approval-123",
      requesterAgentId: "dev-agent",
      targetAgentId: "gpod",
      reason: "agent_to_agent_allow",
      action: "send",
      expiresAt: 60_000,
    });
    expect(payload.interactive).toEqual(
      expect.objectContaining({
        blocks: expect.arrayContaining([
          expect.objectContaining({ type: "text" }),
          expect.objectContaining({ type: "buttons" }),
        ]),
      }),
    );
  });
});

describe("resolvePendingA2APermissionApproval", () => {
  it("applies a narrow allowlist patch and marks the approval approved", async () => {
    await withTempConfigState(
      {
        tools: {
          agentToAgent: {
            enabled: true,
            allow: ["gpod"],
          },
        },
      },
      async ({ configPath, stateDir }) => {
        const record = await createPendingA2AApproval({
          permissionRequest: {
            kind: "config_permission_request",
            reason: "agent_to_agent_allow",
            action: "send",
            requesterAgentId: "dev-agent",
            targetAgentId: "gpod",
            retryable: true,
            askUser: "Allow agent-to-agent send for dev-agent -> gpod?",
            missingAllowAgents: ["dev-agent"],
            suggestedChanges: [{ path: "tools.agentToAgent.allow", value: ["gpod", "dev-agent"] }],
          },
          originalToolName: "sessions_send",
          originalArgs: { agentId: "gpod", message: "hi" },
          baseDir: stateDir,
        });

        const resolved = await resolvePendingA2APermissionApproval({
          approvalId: record.approvalId,
          decision: "approve",
          actorId: "U123",
          baseDir: stateDir,
        });

        expect(resolved).toMatchObject({
          status: "approved",
          changedPaths: ["tools.agentToAgent.allow"],
        });
        expect(buildA2APermissionApprovalResolvedText(resolved)).toContain(
          "Updated `tools.agentToAgent.allow`",
        );
        expect(JSON.parse(await fs.readFile(configPath, "utf-8"))).toMatchObject({
          tools: {
            agentToAgent: {
              enabled: true,
              allow: ["gpod", "dev-agent"],
            },
          },
        });
        expect(
          await getPendingA2AApproval({ approvalId: record.approvalId, baseDir: stateDir }),
        ).toMatchObject({
          state: "approved",
          approvedBy: "U123",
        });
      },
    );
  });

  it("marks approvals obsolete when the requested config is already in place", async () => {
    await withTempConfigState(
      {
        tools: {
          agentToAgent: {
            enabled: true,
            allow: ["gpod", "dev-agent"],
          },
        },
      },
      async ({ configPath, stateDir }) => {
        const original = await fs.readFile(configPath, "utf-8");
        const record = await createPendingA2AApproval({
          permissionRequest: {
            kind: "config_permission_request",
            reason: "agent_to_agent_allow",
            action: "send",
            requesterAgentId: "dev-agent",
            targetAgentId: "gpod",
            retryable: true,
            askUser: "Allow agent-to-agent send for dev-agent -> gpod?",
            missingAllowAgents: ["dev-agent"],
            suggestedChanges: [{ path: "tools.agentToAgent.allow", value: ["gpod", "dev-agent"] }],
          },
          originalToolName: "sessions_send",
          originalArgs: { agentId: "gpod", message: "hi" },
          baseDir: stateDir,
        });

        const resolved = await resolvePendingA2APermissionApproval({
          approvalId: record.approvalId,
          decision: "approve",
          actorId: "U123",
          baseDir: stateDir,
        });

        expect(resolved).toMatchObject({ status: "obsolete" });
        expect(buildA2APermissionApprovalResolvedText(resolved)).toContain("already in place");
        expect(await fs.readFile(configPath, "utf-8")).toBe(original);
        expect(
          await getPendingA2AApproval({ approvalId: record.approvalId, baseDir: stateDir }),
        ).toMatchObject({
          state: "obsolete",
          obsoleteBy: "U123",
        });
      },
    );
  });

  it("marks denied approvals without touching config", async () => {
    await withTempConfigState(
      {
        tools: {
          agentToAgent: {
            enabled: false,
          },
        },
      },
      async ({ configPath, stateDir }) => {
        const original = await fs.readFile(configPath, "utf-8");
        const record = await createPendingA2AApproval({
          permissionRequest: {
            kind: "config_permission_request",
            reason: "agent_to_agent_disabled",
            action: "status",
            requesterAgentId: "dev-agent",
            targetAgentId: "gpod",
            retryable: true,
            askUser: "Allow agent-to-agent status for dev-agent -> gpod?",
            suggestedChanges: [{ path: "tools.agentToAgent.enabled", value: true }],
          },
          originalToolName: "session_status",
          originalArgs: { sessionKey: "agent:gpod:main" },
          baseDir: stateDir,
        });

        const resolved = await resolvePendingA2APermissionApproval({
          approvalId: record.approvalId,
          decision: "deny",
          actorId: "U123",
          baseDir: stateDir,
        });

        expect(resolved).toMatchObject({ status: "denied" });
        expect(buildA2APermissionApprovalResolvedText(resolved)).toContain(
          "No config changes were made",
        );
        expect(await fs.readFile(configPath, "utf-8")).toBe(original);
        expect(
          await getPendingA2AApproval({ approvalId: record.approvalId, baseDir: stateDir }),
        ).toMatchObject({
          state: "denied",
          deniedBy: "U123",
        });
      },
    );
  });
});
