import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache } from "../../config/config.js";
import { withEnvAsync } from "../../test-utils/env.js";
import type { SessionAccessPermissionRequest } from "../tools/sessions-access.js";
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
  it("builds approval payloads with metadata for channel-owned presentation", () => {
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
    expect(payload.interactive).toBeUndefined();
    expect(payload.text).toContain("membership-wide, not pair-scoped");
    expect(payload.text).toContain("every other agent matched by the allow list");
    expect(payload.text).not.toContain("narrow config change");
  });

  it.each([
    {
      reason: "agent_to_agent_disabled" as const,
      suggestedChanges: [{ path: "tools.agentToAgent.enabled" as const, value: true }],
      expectedScope: "global A2A gate",
    },
    {
      reason: "agent_to_agent_allow" as const,
      suggestedChanges: [
        { path: "tools.agentToAgent.allow" as const, value: ["gpod", "dev-agent"] },
      ],
      missingAllowAgents: ["dev-agent"],
      expectedScope: "membership-wide, not pair-scoped",
    },
    {
      reason: "session_visibility" as const,
      suggestedChanges: [{ path: "tools.sessions.visibility" as const, value: "all" }],
      expectedScope: "globally exposes all agents' sessions",
    },
  ])("discloses the actual $reason approval scope", (testCase) => {
    const permissionRequest: SessionAccessPermissionRequest = {
      kind: "config_permission_request",
      reason: testCase.reason,
      action: "send",
      requesterAgentId: "dev-agent",
      targetAgentId: "gpod",
      retryable: true,
      askUser: "Approve?",
      suggestedChanges: testCase.suggestedChanges,
      ...(testCase.missingAllowAgents ? { missingAllowAgents: testCase.missingAllowAgents } : {}),
    };

    const payload = buildA2APermissionApprovalPendingReplyPayload({
      approvalId: `approval-${testCase.reason}`,
      permissionRequest,
    });

    expect(payload.text).toContain(testCase.expectedScope);
    expect(payload.text).toContain("config change described above");
  });
});

describe("resolvePendingA2APermissionApproval", () => {
  it("applies sequential narrow approvals while later independent gates remain", async () => {
    await withTempConfigState(
      {
        tools: {
          sessions: { visibility: "tree" },
          agentToAgent: { enabled: false, allow: ["dev-agent"] },
        },
      },
      async ({ configPath, stateDir }) => {
        const visibility = await createPendingA2AApproval({
          permissionRequest: {
            kind: "config_permission_request",
            reason: "session_visibility",
            action: "send",
            requesterAgentId: "dev-agent",
            targetAgentId: "gpod",
            requesterSessionKey: "agent:dev-agent:main",
            targetSessionKey: "agent:gpod:main",
            retryable: true,
            askUser: "Allow cross-agent session sends?",
            suggestedChanges: [{ path: "tools.sessions.visibility", value: "all" }],
          },
          originalToolName: "sessions_send",
          originalArgs: { agentId: "gpod", message: "hi" },
          baseDir: stateDir,
        });

        await expect(
          resolvePendingA2APermissionApproval({
            approvalId: visibility.approvalId,
            decision: "approve",
            actorId: "U123",
            baseDir: stateDir,
          }),
        ).resolves.toMatchObject({
          status: "approved",
          changedPaths: ["tools.sessions.visibility"],
        });

        const enablement = await createPendingA2AApproval({
          permissionRequest: {
            kind: "config_permission_request",
            reason: "agent_to_agent_disabled",
            action: "send",
            requesterAgentId: "dev-agent",
            targetAgentId: "gpod",
            retryable: true,
            askUser: "Enable agent-to-agent sends?",
            suggestedChanges: [{ path: "tools.agentToAgent.enabled", value: true }],
          },
          originalToolName: "sessions_send",
          originalArgs: { agentId: "gpod", message: "hi" },
          baseDir: stateDir,
        });

        await expect(
          resolvePendingA2APermissionApproval({
            approvalId: enablement.approvalId,
            decision: "approve",
            actorId: "U123",
            baseDir: stateDir,
          }),
        ).resolves.toMatchObject({
          status: "approved",
          changedPaths: ["tools.agentToAgent.enabled"],
        });

        const allowlist = await createPendingA2AApproval({
          permissionRequest: {
            kind: "config_permission_request",
            reason: "agent_to_agent_allow",
            action: "send",
            requesterAgentId: "dev-agent",
            targetAgentId: "gpod",
            retryable: true,
            askUser: "Allow gpod for agent-to-agent sends?",
            missingAllowAgents: ["gpod"],
            suggestedChanges: [{ path: "tools.agentToAgent.allow", value: ["dev-agent", "gpod"] }],
          },
          originalToolName: "sessions_send",
          originalArgs: { agentId: "gpod", message: "hi" },
          baseDir: stateDir,
        });

        await expect(
          resolvePendingA2APermissionApproval({
            approvalId: allowlist.approvalId,
            decision: "approve",
            actorId: "U123",
            baseDir: stateDir,
          }),
        ).resolves.toMatchObject({
          status: "approved",
          changedPaths: ["tools.agentToAgent.allow"],
        });
        expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
          tools: {
            sessions: { visibility: "all" },
            agentToAgent: { enabled: true, allow: ["dev-agent", "gpod"] },
          },
        });
      },
    );
  });

  it("applies a narrow allowlist patch and marks the approval approved", async () => {
    await withTempConfigState(
      {
        tools: {
          sessions: { visibility: "all" },
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

  it("approves a sessions_list visibility request so the caller can retry", async () => {
    await withTempConfigState(
      {
        tools: {
          sessions: { visibility: "tree" },
          agentToAgent: { enabled: true, allow: ["*"] },
        },
      },
      async ({ configPath, stateDir }) => {
        const record = await createPendingA2AApproval({
          permissionRequest: {
            kind: "config_permission_request",
            reason: "session_visibility",
            action: "list",
            requesterAgentId: "dev-agent",
            targetAgentId: "gpod",
            requesterSessionKey: "agent:dev-agent:slack:channel:C1:thread:100.100",
            targetSessionKey: "agent:gpod:subagent:worker-1",
            retryable: true,
            askUser: "Allow cross-agent session list access?",
            suggestedChanges: [{ path: "tools.sessions.visibility", value: "all" }],
          },
          originalToolName: "sessions_list",
          originalArgs: { agentId: "gpod" },
          baseDir: stateDir,
        });
        expect(record.permissionRequest).toMatchObject({
          requesterSessionKey: "agent:dev-agent:slack:channel:C1:thread:100.100",
          targetSessionKey: "agent:gpod:subagent:worker-1",
        });

        const resolved = await resolvePendingA2APermissionApproval({
          approvalId: record.approvalId,
          decision: "approve",
          actorId: "U123",
          baseDir: stateDir,
        });

        expect(resolved).toMatchObject({
          status: "approved",
          changedPaths: ["tools.sessions.visibility"],
          record: {
            state: "approved",
            action: "list",
            originalToolName: "sessions_list",
          },
        });
        expect(buildA2APermissionApprovalResolvedText(resolved)).toContain("Retry the request");
        expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
          tools: { sessions: { visibility: "all" } },
        });
      },
    );
  });

  it("does not write config when the claim expires during async patch planning", async () => {
    await withTempConfigState(
      {
        tools: {
          sessions: { visibility: "all" },
          agentToAgent: { enabled: true, allow: ["gpod"] },
        },
      },
      async ({ configPath, stateDir }) => {
        const original = await fs.readFile(configPath, "utf8");
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
          nowMs: 0,
          ttlMs: 1_000,
        });

        const resolved = await resolvePendingA2APermissionApproval({
          approvalId: record.approvalId,
          decision: "approve",
          actorId: "U123",
          baseDir: stateDir,
          // The claim is live at acquisition, but the real clock used at the commit boundary
          // has passed its expiry while config snapshot planning was in flight.
          nowMs: 0,
        });

        expect(resolved).toMatchObject({ status: "expired" });
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
        await expect(
          getPendingA2AApproval({ approvalId: record.approvalId, baseDir: stateDir }),
        ).resolves.toMatchObject({ state: "expired" });
      },
    );
  });

  it("compares normalized allowlists by value and lets only one concurrent approver mutate config", async () => {
    await withTempConfigState(
      {
        tools: {
          sessions: { visibility: "all" },
          agentToAgent: { enabled: true, allow: ["gpod", "gpod"] },
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

        const results = await Promise.all([
          resolvePendingA2APermissionApproval({
            approvalId: record.approvalId,
            decision: "approve",
            actorId: "U123",
            baseDir: stateDir,
          }),
          resolvePendingA2APermissionApproval({
            approvalId: record.approvalId,
            decision: "approve",
            actorId: "U456",
            baseDir: stateDir,
          }),
        ]);

        expect(results.map((result) => result.status).toSorted()).toEqual([
          "already-resolved",
          "approved",
        ]);
        expect(JSON.parse(await fs.readFile(configPath, "utf-8"))).toMatchObject({
          tools: { agentToAgent: { allow: ["gpod", "dev-agent"] } },
        });
      },
    );
  });

  it("preserves every independently approved allowlist edit across concurrent config writes", async () => {
    await withTempConfigState(
      {
        tools: {
          sessions: { visibility: "all" },
          agentToAgent: { enabled: true, allow: ["gpod"] },
        },
      },
      async ({ configPath, stateDir }) => {
        const requesterAgentIds = ["dev-agent", "ops-agent", "qa-agent", "release-agent"];
        const records = await Promise.all(
          requesterAgentIds.map(
            async (requesterAgentId) =>
              await createPendingA2AApproval({
                permissionRequest: {
                  kind: "config_permission_request",
                  reason: "agent_to_agent_allow",
                  action: "send",
                  requesterAgentId,
                  targetAgentId: "gpod",
                  retryable: true,
                  askUser: `Allow agent-to-agent send for ${requesterAgentId} -> gpod?`,
                  missingAllowAgents: [requesterAgentId],
                  suggestedChanges: [
                    {
                      path: "tools.agentToAgent.allow",
                      value: ["gpod", requesterAgentId],
                    },
                  ],
                },
                originalToolName: "sessions_send",
                originalArgs: { agentId: "gpod", message: "hi" },
                baseDir: stateDir,
              }),
          ),
        );

        const results = await Promise.all(
          records.map(
            async (record, index) =>
              await resolvePendingA2APermissionApproval({
                approvalId: record.approvalId,
                decision: "approve",
                actorId: `U${index}`,
                baseDir: stateDir,
              }),
          ),
        );

        expect(results.map((result) => result.status)).toEqual([
          "approved",
          "approved",
          "approved",
          "approved",
        ]);
        const persisted = JSON.parse(await fs.readFile(configPath, "utf-8"));
        expect(persisted.tools.agentToAgent.allow).toHaveLength(requesterAgentIds.length + 1);
        expect(persisted.tools.agentToAgent.allow).toEqual(
          expect.arrayContaining(["gpod", ...requesterAgentIds]),
        );
      },
    );
  });

  it("releases the approval claim when config validation fails", async () => {
    await withTempConfigState({ gateway: { port: "invalid" } }, async ({ stateDir }) => {
      const record = await createPendingA2AApproval({
        permissionRequest: {
          kind: "config_permission_request",
          reason: "agent_to_agent_disabled",
          action: "send",
          requesterAgentId: "dev-agent",
          targetAgentId: "gpod",
          retryable: true,
          askUser: "Enable agent-to-agent sends?",
          suggestedChanges: [{ path: "tools.agentToAgent.enabled", value: true }],
        },
        originalToolName: "sessions_send",
        originalArgs: { agentId: "gpod", message: "hi" },
        baseDir: stateDir,
      });

      await expect(
        resolvePendingA2APermissionApproval({
          approvalId: record.approvalId,
          decision: "approve",
          actorId: "U123",
          baseDir: stateDir,
        }),
      ).resolves.toMatchObject({ status: "error" });
      expect(
        await getPendingA2AApproval({ approvalId: record.approvalId, baseDir: stateDir }),
      ).toMatchObject({ state: "pending" });
    });
  });

  it("marks approvals obsolete when the requested config is already in place", async () => {
    await withTempConfigState(
      {
        tools: {
          sessions: { visibility: "all" },
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

  const driftCases: Array<{
    name: string;
    config: Record<string, unknown>;
    permissionRequest: SessionAccessPermissionRequest;
  }> = [
    {
      name: "visibility approval after enablement becomes the blocker",
      config: {
        tools: {
          sessions: { visibility: "all" },
          agentToAgent: { enabled: false, allow: ["dev-agent", "gpod"] },
        },
      },
      permissionRequest: {
        kind: "config_permission_request",
        reason: "session_visibility",
        action: "send",
        requesterAgentId: "dev-agent",
        targetAgentId: "gpod",
        retryable: true,
        askUser: "Allow cross-agent session sends?",
        suggestedChanges: [{ path: "tools.sessions.visibility", value: "all" }],
      },
    },
    {
      name: "enablement approval after the allowlist becomes the blocker",
      config: {
        tools: {
          sessions: { visibility: "all" },
          agentToAgent: { enabled: true, allow: ["dev-agent"] },
        },
      },
      permissionRequest: {
        kind: "config_permission_request",
        reason: "agent_to_agent_disabled",
        action: "send",
        requesterAgentId: "dev-agent",
        targetAgentId: "gpod",
        retryable: true,
        askUser: "Enable agent-to-agent sends?",
        suggestedChanges: [{ path: "tools.agentToAgent.enabled", value: true }],
      },
    },
    {
      name: "allowlist approval after visibility becomes the blocker",
      config: {
        tools: {
          sessions: { visibility: "tree" },
          agentToAgent: { enabled: true, allow: ["dev-agent", "gpod"] },
        },
      },
      permissionRequest: {
        kind: "config_permission_request",
        reason: "agent_to_agent_allow",
        action: "send",
        requesterAgentId: "dev-agent",
        targetAgentId: "gpod",
        retryable: true,
        askUser: "Allow agent-to-agent sends?",
        missingAllowAgents: ["gpod"],
        suggestedChanges: [{ path: "tools.agentToAgent.allow", value: ["dev-agent", "gpod"] }],
      },
    },
  ];

  it.each(driftCases)("marks $name obsolete without writing config", async (testCase) => {
    await withTempConfigState(testCase.config, async ({ configPath, stateDir }) => {
      const original = await fs.readFile(configPath, "utf8");
      const record = await createPendingA2AApproval({
        permissionRequest: testCase.permissionRequest,
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
      expect(buildA2APermissionApprovalResolvedText(resolved)).toContain(
        "request a fresh approval",
      );
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      await expect(
        getPendingA2AApproval({ approvalId: record.approvalId, baseDir: stateDir }),
      ).resolves.toMatchObject({
        state: "obsolete",
        obsoleteReason: "access requirements changed; request a fresh approval",
      });
    });
  });

  it("marks an allowlist approval obsolete when the exact membership gap drifts", async () => {
    await withTempConfigState(
      {
        tools: {
          sessions: { visibility: "all" },
          agentToAgent: { enabled: true, allow: ["gpod"] },
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
        const driftedConfig = {
          tools: {
            sessions: { visibility: "all" },
            agentToAgent: { enabled: true, allow: ["other"] },
          },
        };
        const driftedRaw = `${JSON.stringify(driftedConfig, null, 2)}\n`;
        await fs.writeFile(configPath, driftedRaw, "utf8");

        const resolved = await resolvePendingA2APermissionApproval({
          approvalId: record.approvalId,
          decision: "approve",
          actorId: "U123",
          baseDir: stateDir,
        });

        expect(resolved).toMatchObject({ status: "obsolete" });
        expect(await fs.readFile(configPath, "utf8")).toBe(driftedRaw);
        await expect(
          getPendingA2AApproval({ approvalId: record.approvalId, baseDir: stateDir }),
        ).resolves.toMatchObject({
          state: "obsolete",
          obsoleteReason: "access requirements changed; request a fresh approval",
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
