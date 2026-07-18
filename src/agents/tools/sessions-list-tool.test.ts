// sessions_list tool tests cover session metadata projection, visibility
// helpers, and numeric argument validation.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionsListTool } from "./sessions-list-tool.js";

const mocks = vi.hoisted(() => ({
  gatewayCall: vi.fn(),
  createAgentToAgentPolicy: vi.fn(() => ({})),
  createSessionVisibilityRowChecker: vi.fn((_params?: unknown) => ({
    check: () => ({ allowed: true }),
  })),
  buildPendingSessionApprovalOutput: vi.fn(async () => ({})),
  resolveEffectiveSessionToolsVisibility: vi.fn(() => "all"),
  resolveSandboxedSessionToolContext: vi.fn(() => ({
    mainKey: "main",
    alias: "main",
    requesterInternalKey: undefined,
    restrictToSpawned: false,
  })),
  getSessionStateVersions: vi.fn(
    (_refs: Array<{ sessionKey: string; agentId: string }>) =>
      ({}) as Record<string, Record<string, number>>,
  ),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => mocks.gatewayCall(opts),
}));

vi.mock("../../sessions/session-state-events.js", () => ({
  getSessionStateVersions: (refs: Array<{ sessionKey: string; agentId: string }>) =>
    mocks.getSessionStateVersions(refs),
}));

vi.mock("./sessions-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("./sessions-helpers.js")>();
  return {
    ...actual,
    createAgentToAgentPolicy: () => mocks.createAgentToAgentPolicy(),
    createSessionVisibilityRowChecker: (params: unknown) =>
      mocks.createSessionVisibilityRowChecker(params),
    resolveEffectiveSessionToolsVisibility: () => mocks.resolveEffectiveSessionToolsVisibility(),
    resolveSandboxedSessionToolContext: () => mocks.resolveSandboxedSessionToolContext(),
  };
});

vi.mock("./sessions-pending-approvals.js", () => ({
  buildPendingSessionApprovalOutput: (params: unknown) =>
    mocks.buildPendingSessionApprovalOutput(params),
}));

type SessionsListDetails = {
  status?: string;
  error?: string;
  permissionRequest?: Record<string, unknown>;
  pendingApproval?: Record<string, unknown>;
  sessions?: Array<{
    channel?: string;
    deliveryContext?: {
      accountId?: string;
      channel?: string;
      threadId?: string | number;
      to?: string;
    };
    elevatedLevel?: string;
    effectiveFastMode?: boolean | "auto";
    effectiveFastModeSource?: "session" | "agent" | "config" | "default";
    fastMode?: boolean | "auto";
    fastAutoOnSeconds?: number;
    archived?: boolean;
    archivedAt?: number;
    pinned?: boolean;
    pinnedAt?: number;
    stateVersion?: number;
    reasoningLevel?: string;
    responseUsage?: string;
    thinkingLevel?: string;
    verboseLevel?: string;
  }>;
};

function getSessionsListDetails(result: { details?: unknown }): SessionsListDetails {
  return result.details as SessionsListDetails;
}

describe("sessions-list-tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAgentToAgentPolicy.mockReturnValue({});
    mocks.createSessionVisibilityRowChecker.mockReturnValue({
      check: () => ({ allowed: true }),
    });
    mocks.buildPendingSessionApprovalOutput.mockResolvedValue({});
    mocks.resolveEffectiveSessionToolsVisibility.mockReturnValue("all");
    mocks.resolveSandboxedSessionToolContext.mockReturnValue({
      mainKey: "main",
      alias: "main",
      requesterInternalKey: undefined,
      restrictToSpawned: false,
    });
    mocks.getSessionStateVersions.mockReturnValue({});
  });

  it("adds nonzero state versions with one batch lookup", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        { key: "agent:main:main", kind: "main", sessionId: "main-1" },
        { key: "agent:main:subagent:child", kind: "other", sessionId: "child-1" },
      ],
    });
    mocks.getSessionStateVersions.mockReturnValue({
      main: { "agent:main:main": 7, "agent:main:subagent:child": 0 },
    });

    const result = await createSessionsListTool({ config: {} as never }).execute("call-state", {});

    expect(mocks.getSessionStateVersions).toHaveBeenCalledWith([
      { sessionKey: "agent:main:main", agentId: "main" },
      { sessionKey: "agent:main:subagent:child", agentId: "main" },
    ]);
    expect(getSessionsListDetails(result).sessions?.[0]?.stateVersion).toBe(7);
    expect(getSessionsListDetails(result).sessions?.[1]?.stateVersion).toBeUndefined();
  });

  it.each([
    ["absent", []],
    ["hidden", [{ key: "agent:ops:main", kind: "main", agentId: "ops" }]],
  ])(
    "returns the same pre-lookup approval when the explicit target is %s",
    async (_scenario, sessions) => {
      const permissionRequest = {
        kind: "config_permission_request" as const,
        reason: "session_visibility" as const,
        action: "list" as const,
        requesterAgentId: "main",
        targetAgentId: "ops",
        retryable: true as const,
        askUser: "Allow cross-agent session list access?",
        suggestedChanges: [{ path: "tools.sessions.visibility" as const, value: "all" }],
      };
      mocks.gatewayCall.mockResolvedValue({ path: "/tmp/sessions.json", sessions });
      mocks.createSessionVisibilityRowChecker.mockReturnValue({
        check: (row: { key: string }) =>
          row.key === "agent:ops:main"
            ? {
                allowed: false as const,
                status: "forbidden" as const,
                error: "Session list visibility is restricted.",
                permissionRequest,
              }
            : { allowed: true as const },
      });
      mocks.buildPendingSessionApprovalOutput.mockResolvedValue({
        pendingApproval: {
          approvalId: "approval-list-1",
          state: "pending",
          expiresAt: 1234,
        },
      });
      const tool = createSessionsListTool({
        agentSessionKey: "agent:main:main",
        config: {} as never,
      });

      const result = await tool.execute("call-list-approval", { agentId: "ops" });
      const details = getSessionsListDetails(result);

      expect(details).toMatchObject({
        status: "forbidden",
        error: "Session list visibility is restricted.",
        permissionRequest,
        pendingApproval: {
          approvalId: "approval-list-1",
          state: "pending",
        },
      });
      expect(mocks.buildPendingSessionApprovalOutput).toHaveBeenCalledWith({
        permissionRequest,
        requesterSessionKey: "agent:main:main",
        originalToolName: "sessions_list",
        originalArgs: { agentId: "ops" },
      });
      expect(mocks.gatewayCall).not.toHaveBeenCalled();
      expect(mocks.createSessionVisibilityRowChecker).toHaveBeenCalledWith({
        action: "list",
        requesterSessionKey: "main",
        visibility: "all",
        a2aPolicy: {},
      });
    },
  );

  it("queries and returns an explicitly authorized cross-agent scope", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [{ key: "agent:ops:main", kind: "main", agentId: "ops" }],
    });
    const check = vi.fn(() => ({ allowed: true as const }));
    mocks.createSessionVisibilityRowChecker.mockReturnValue({ check });
    const tool = createSessionsListTool({
      agentSessionKey: "agent:main:main",
      config: {} as never,
    });

    const result = await tool.execute("call-list-authorized", { agentId: "ops" });

    expect(check).toHaveBeenNthCalledWith(1, {
      key: "agent:ops:main",
      agentId: "ops",
    });
    expect(mocks.gatewayCall).toHaveBeenCalledOnce();
    expect(mocks.gatewayCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.list",
        params: expect.objectContaining({ agentId: "ops" }),
      }),
    );
    expect(getSessionsListDetails(result).sessions).toHaveLength(1);
  });

  it("keeps deliveryContext.threadId in sessions_list results", async () => {
    // Thread/topic ids are required for channel-specific follow-up routing, so
    // list results must preserve both string and numeric variants.
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:dashboard:child",
              kind: "direct",
              sessionId: "sess-dashboard-child",
              deliveryContext: {
                channel: "discord",
                to: "discord:child",
                accountId: "acct-1",
                threadId: "thread-1",
              },
            },
            {
              key: "agent:main:telegram:topic",
              kind: "direct",
              sessionId: "sess-telegram-topic",
              deliveryContext: {
                channel: "telegram",
                to: "telegram:topic",
                accountId: "acct-2",
                threadId: 271,
              },
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-1", {});
    const details = getSessionsListDetails(result);

    expect(details.sessions?.[0]?.deliveryContext).toEqual({
      channel: "discord",
      to: "discord:child",
      accountId: "acct-1",
      threadId: "thread-1",
    });
    expect(Object.hasOwn(details.sessions?.[0] ?? {}, "effectiveFastMode")).toBe(false);
    expect(details.sessions?.[1]?.deliveryContext).toEqual({
      channel: "telegram",
      to: "telegram:topic",
      accountId: "acct-2",
      threadId: "271",
    });
  });

  it("normalizes numeric deliveryContext.threadId in sessions_list results", async () => {
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:telegram:group:-100123:topic:99",
              kind: "group",
              sessionId: "sess-telegram-topic",
              deliveryContext: {
                channel: "telegram",
                to: "-100123",
                accountId: "acct-1",
                threadId: 99,
              },
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-2", {});
    const details = getSessionsListDetails(result);

    expect(details.sessions?.[0]?.deliveryContext).toEqual({
      channel: "telegram",
      to: "-100123",
      accountId: "acct-1",
      threadId: "99",
    });
  });

  it("derives channels only from structurally valid group session keys", async () => {
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:slack:channel:C123:thread:1710000000.000100",
              kind: "group",
              sessionId: "sess-slack-thread",
            },
            {
              key: "discord:group:ops",
              kind: "group",
              sessionId: "sess-discord-group",
            },
            {
              key: "agent:main:matrix:channel:!room:[2001:db8::1]",
              kind: "group",
              sessionId: "sess-matrix-room",
            },
            {
              key: "agent:main:agent:plugin:slack:channel:C123",
              kind: "group",
              sessionId: "sess-nested-agent",
            },
            {
              key: "agent::slack:channel:C123",
              kind: "group",
              sessionId: "sess-malformed-agent",
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-agent-scoped-channel", {});
    const details = getSessionsListDetails(result);

    expect(details.sessions?.map((session) => session.channel)).toEqual([
      "slack",
      "discord",
      "matrix",
      "unknown",
      "unknown",
    ]);
  });

  it("keeps live session setting metadata in sessions_list results", async () => {
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "main",
              kind: "direct",
              sessionId: "sess-main",
              thinkingLevel: "high",
              fastMode: "auto",
              effectiveFastMode: "auto",
              effectiveFastModeSource: "config",
              fastAutoOnSeconds: 30,
              verboseLevel: "on",
              reasoningLevel: "deep",
              elevatedLevel: "on",
              responseUsage: "full",
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-3", {});
    const details = getSessionsListDetails(result);

    const session = details.sessions?.[0];
    expect(session?.thinkingLevel).toBe("high");
    expect(session?.fastMode).toBe("auto");
    expect(session?.effectiveFastMode).toBe("auto");
    expect(session?.effectiveFastModeSource).toBe("config");
    expect(session?.fastAutoOnSeconds).toBe(30);
    expect(session?.verboseLevel).toBe("on");
    expect(session?.reasoningLevel).toBe("deep");
    expect(session?.elevatedLevel).toBe("on");
    expect(session?.responseUsage).toBe("full");
  });

  it("requests archived sessions and keeps management metadata", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:dashboard:archived",
          kind: "direct",
          archived: true,
          archivedAt: 20,
          pinned: false,
        },
      ],
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-archived", { archived: true });

    expect(mocks.gatewayCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.list",
        params: expect.objectContaining({ archived: true }),
      }),
    );
    expect(getSessionsListDetails(result).sessions?.[0]).toMatchObject({
      archived: true,
      archivedAt: 20,
      pinned: false,
    });
  });

  it.each([
    [{ limit: 1.5 }, "limit must be a positive integer"],
    [{ activeMinutes: 0 }, "activeMinutes must be a positive integer"],
    [{ messageLimit: 1.5 }, "messageLimit must be a non-negative integer"],
    [{ messageLimit: -1 }, "messageLimit must be a non-negative integer"],
  ])("rejects invalid numeric parameter %o", async (params, message) => {
    // Reject before gateway dispatch so malformed limits cannot reach session
    // store queries.
    const tool = createSessionsListTool({ config: {} as never });

    await expect(tool.execute("call-4", params)).rejects.toThrow(message);
    expect(mocks.gatewayCall).not.toHaveBeenCalled();
  });
});
