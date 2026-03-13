// Verifies sessions list/history/send behavior across gateway and channel targets.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelMessagingAdapter } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  addSubagentRunForTests,
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

type SessionsSuiteConfig = {
  session: {
    mainKey: string;
    scope: "per-sender";
    agentToAgent: {
      maxPingPongTurns: number;
      ingressEcho: { enabled: boolean; requireDelivery: boolean };
      guard: { allowNestedSessionsSend: boolean };
      relay: {
        enabled: boolean;
        mode: "target-only" | "dual-channel";
        mirrorTurns: "round1" | "always";
        verbosity: "sender-message" | "combined-note";
        requireDelivery: boolean;
      };
    };
  };
  tools: {
    sessions: { visibility: "all" };
    agentToAgent: { enabled: true; allow: ["*"] };
  };
};

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));
const loadSessionEntryByKeyMock = vi.fn();
vi.mock("./subagent-announce-delivery.js", () => ({
  loadSessionEntryByKey: (sessionKey: string) => loadSessionEntryByKeyMock(sessionKey),
}));

type SessionsToolsTestConfig = {
  session: {
    mainKey: string;
    scope: "per-sender";
    agentToAgent: {
      maxPingPongTurns: number;
      ingressEcho: { enabled: boolean; requireDelivery: boolean };
      guard: { allowNestedSessionsSend: boolean };
      relay: {
        enabled: boolean;
        mode: "target-only" | "dual-channel";
        mirrorTurns: "round1" | "all";
        verbosity: "none" | "sender-message" | "full-payload";
        requireDelivery: boolean;
      };
    };
  };
  tools: {
    sessions: { visibility: "all" | "self" | "tree" | "agent" };
    agentToAgent: { enabled: boolean; allow: string[] };
  };
};

const testConfig: SessionsToolsTestConfig = {
  session: {
    mainKey: "main",
    scope: "per-sender",
    agentToAgent: {
      maxPingPongTurns: 2,
      ingressEcho: { enabled: false, requireDelivery: false },
      guard: { allowNestedSessionsSend: false },
      relay: {
        enabled: false,
        mode: "target-only",
        mirrorTurns: "round1",
        verbosity: "sender-message",
        requireDelivery: false,
      },
    },
  },
  tools: {
    // Keep sessions tools permissive in this suite; dedicated visibility tests cover defaults.
    sessions: { visibility: "all" },
    agentToAgent: { enabled: true, allow: ["*"] },
  },
};

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => structuredClone(testConfig),
    loadConfig: () => structuredClone(testConfig),
    resolveGatewayPort: () => 18789,
  };
});

import "./test-helpers/fast-openclaw-tools-sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  testing as embeddedRunsTesting,
  setActiveEmbeddedRun,
} from "./embedded-agent-runner/runs.js";
import {
  __testing as openClawToolsTesting,
  createOpenClawTools as createRuntimeOpenClawTools,
} from "./openclaw-tools.js";
import { __testing as subagentControlTesting } from "./subagent-control.js";
import { __testing as agentStepTesting } from "./tools/agent-step.js";
import { __testing as sessionsResolutionTesting } from "./tools/sessions-resolution.js";
import { __testing as sessionsSendA2ATesting } from "./tools/sessions-send-tool.a2a.js";

const TEST_CONFIG: SessionsSuiteConfig = {
  session: {
    mainKey: "main",
    scope: "per-sender",
    agentToAgent: {
      maxPingPongTurns: 2,
      ingressEcho: { enabled: false, requireDelivery: false },
      guard: { allowNestedSessionsSend: false },
      relay: {
        enabled: false,
        mode: "target-only",
        mirrorTurns: "round1",
        verbosity: "sender-message",
        requireDelivery: false,
      },
    },
  },
  tools: {
    sessions: { visibility: "all" },
    agentToAgent: { enabled: true, allow: ["*"] },
  },
};

const createTestTools = (options?: Parameters<typeof createRuntimeOpenClawTools>[0]) =>
  createRuntimeOpenClawTools({ config: structuredClone(testConfig) as OpenClawConfig, ...options });
const createOpenClawTools = createTestTools;

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean) {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

const resolveSessionConversationStub: NonNullable<
  ChannelMessagingAdapter["resolveSessionConversation"]
> = ({ rawId }) => ({
  id: rawId,
});
const resolveSessionTargetStub: NonNullable<ChannelMessagingAdapter["resolveSessionTarget"]> = ({
  kind,
  id,
  threadId,
}) => (threadId ? `${kind}:${id}:thread:${threadId}` : `${kind}:${id}`);

function installMessagingTestRegistry() {
  // Registry stubs expose enough channel target resolution for session-send tests.
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: {
          id: "discord",
          meta: {
            id: "discord",
            label: "Discord",
            selectionLabel: "Discord",
            docsPath: "/channels/discord",
            blurb: "Discord test stub.",
          },
          capabilities: { chatTypes: ["direct", "channel", "thread"] },
          messaging: {
            resolveSessionConversation: resolveSessionConversationStub,
            resolveSessionTarget: resolveSessionTargetStub,
          },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
      {
        pluginId: "whatsapp",
        source: "test",
        plugin: {
          id: "whatsapp",
          meta: {
            id: "whatsapp",
            label: "WhatsApp",
            selectionLabel: "WhatsApp",
            docsPath: "/channels/whatsapp",
            blurb: "WhatsApp test stub.",
            preferSessionLookupForAnnounceTarget: true,
          },
          capabilities: { chatTypes: ["direct", "group"] },
          messaging: {
            resolveSessionConversation: resolveSessionConversationStub,
            resolveSessionTarget: resolveSessionTargetStub,
          },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
    ]),
  );
}

const waitForCalls = async (getCount: () => number, count: number, timeoutMs = 2000) => {
  await vi.waitFor(
    () => {
      expect(getCount()).toBeGreaterThanOrEqual(count);
    },
    { timeout: timeoutMs, interval: 5 },
  );
};

type GatewayCall = {
  method?: string;
  params?: Record<string, unknown>;
};

type AgentCallParams = {
  message?: string;
  lane?: string;
  channel?: string;
  sessionKey?: string;
  extraSystemPrompt?: string;
  inputProvenance?: {
    kind?: string;
    sourceSessionKey?: string;
    sourceChannel?: string;
    sourceTool?: string;
  };
};

type SessionsSendDetails = {
  status?: string;
  runId?: string;
  reply?: string;
  error?: string;
  sentBeforeError?: boolean;
  sessionKey?: string;
  delivery?: {
    status?: string;
    mode?: string;
  };
};

function requireGatewayCall(call: unknown, method: string): GatewayCall {
  const request = call as GatewayCall | undefined;
  if (request?.method !== method) {
    throw new Error(`expected ${method} gateway call`);
  }
  return request;
}

function agentParams(call: { params?: unknown }): AgentCallParams {
  return (call.params ?? {}) as AgentCallParams;
}

function expectInterSessionAgentCall(call: { params?: unknown }): void {
  // Inter-session sends should be marked as nested non-user agent calls.
  const params = agentParams(call);
  expect(params.message).toContain("[Inter-session message");
  expect(params.message).toContain("isUser=false");
  expect(params.lane).toMatch(/^nested(?::|$)/);
  expect(params.channel).toBe("webchat");
  expect(params.inputProvenance?.kind).toBe("inter_session");
}

function sessionsSendDetails(details: unknown): SessionsSendDetails {
  return details as SessionsSendDetails;
}

let sessionsModule: typeof import("../config/sessions.js");

describe("sessions tools", () => {
  beforeAll(async () => {
    sessionsModule = await import("../config/sessions.js");
  });

  beforeEach(() => {
    callGatewayMock.mockClear();
    embeddedRunsTesting.resetActiveEmbeddedRuns();
    loadSessionEntryByKeyMock.mockReset();
    loadSessionEntryByKeyMock.mockReturnValue(undefined);
    installMessagingTestRegistry();
    openClawToolsTesting.setDepsForTest({
      callGateway: (opts: unknown) => callGatewayMock(opts),
      config: TEST_CONFIG as OpenClawConfig,
    });
    agentStepTesting.setDepsForTest({
      agentCommandFromIngress: async () => ({
        payloads: [{ text: "ANNOUNCE_SKIP", mediaUrl: null }],
        meta: { durationMs: 1 },
      }),
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });
    sessionsResolutionTesting.setDepsForTest({
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });
    sessionsSendA2ATesting.setDepsForTest({
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });
    subagentControlTesting.setDepsForTest({
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });
    resetSubagentRegistryForTests();
    testConfig.session.agentToAgent.ingressEcho.enabled = false;
    testConfig.session.agentToAgent.ingressEcho.requireDelivery = false;
    TEST_CONFIG.session.agentToAgent.ingressEcho.enabled = false;
    TEST_CONFIG.session.agentToAgent.ingressEcho.requireDelivery = false;
    testConfig.session.agentToAgent.guard.allowNestedSessionsSend = false;
    TEST_CONFIG.session.agentToAgent.guard.allowNestedSessionsSend = false;
    testConfig.session.agentToAgent.relay.enabled = false;
    testConfig.session.agentToAgent.relay.mode = "target-only";
    testConfig.session.agentToAgent.relay.mirrorTurns = "round1";
    testConfig.session.agentToAgent.relay.requireDelivery = false;
    TEST_CONFIG.session.agentToAgent.relay.enabled = false;
    TEST_CONFIG.session.agentToAgent.relay.mode = "target-only";
    TEST_CONFIG.session.agentToAgent.relay.mirrorTurns = "round1";
    TEST_CONFIG.session.agentToAgent.relay.requireDelivery = false;
    testConfig.session.agentToAgent.relay.verbosity = "sender-message";
    TEST_CONFIG.session.agentToAgent.relay.verbosity = "sender-message";
    testConfig.tools.sessions = { visibility: "all" };
    testConfig.tools.agentToAgent = { enabled: true, allow: ["*"] };
    TEST_CONFIG.tools.sessions = { visibility: "all" };
    TEST_CONFIG.tools.agentToAgent = { enabled: true, allow: ["*"] };
  });

  it("uses integer schemas for session count and window parameters", () => {
    const tools = createTestTools();
    const byName = (name: string) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        throw new Error(`missing ${name} tool`);
      }
      return tool;
    };

    const schemaProp = (toolName: string, prop: string) => {
      const tool = byName(toolName);
      const schema = tool.parameters as {
        anyOf?: unknown;
        oneOf?: unknown;
        properties?: Record<string, unknown>;
      };
      expect(schema.anyOf).toBeUndefined();
      expect(schema.oneOf).toBeUndefined();

      const properties = schema.properties ?? {};
      const value = properties[prop] as { type?: unknown } | undefined;
      if (!value) {
        throw new Error(`missing ${toolName} schema prop: ${prop}`);
      }
      return value;
    };
    const hasSchemaProp = (toolName: string, prop: string) => {
      const tool = byName(toolName);
      const schema = tool.parameters as {
        properties?: Record<string, unknown>;
      };
      return Object.hasOwn(schema.properties ?? {}, prop);
    };

    expect(schemaProp("sessions_history", "limit").type).toBe("integer");
    expect(schemaProp("sessions_list", "limit").type).toBe("integer");
    expect(schemaProp("sessions_list", "activeMinutes").type).toBe("integer");
    expect(schemaProp("sessions_list", "messageLimit").type).toBe("integer");
    expect(schemaProp("sessions_list", "label").type).toBe("string");
    expect(schemaProp("sessions_list", "agentId").type).toBe("string");
    expect(schemaProp("sessions_list", "search").type).toBe("string");
    expect(schemaProp("sessions_list", "includeDerivedTitles").type).toBe("boolean");
    expect(schemaProp("sessions_list", "includeLastMessage").type).toBe("boolean");
    expect(schemaProp("sessions_send", "message").type).toBe("string");
    expect(hasSchemaProp("sessions_send", "SendMessage")).toBe(false);
    expect(hasSchemaProp("sessions_send", "content")).toBe(false);
    expect(hasSchemaProp("sessions_send", "text")).toBe(false);
    expect(schemaProp("sessions_send", "timeoutSeconds").type).toBe("integer");
    const sendRequired =
      (byName("sessions_send").parameters as { required?: string[] }).required ?? [];
    expect(sendRequired).toContain("message");
    expect(schemaProp("sessions_spawn", "thinking").type).toBe("string");
    expect(schemaProp("sessions_spawn", "runTimeoutSeconds").type).toBe("number");
    expect(schemaProp("sessions_spawn", "thread").type).toBe("boolean");
    expect(schemaProp("sessions_spawn", "mode").type).toBe("string");
    expect(schemaProp("sessions_spawn", "sandbox").type).toBe("string");
    expect(schemaProp("sessions_spawn", "streamTo").type).toBe("string");
    expect(schemaProp("sessions_spawn", "runtime").type).toBe("string");
    expect(schemaProp("sessions_spawn", "cwd").type).toBe("string");
    expect(schemaProp("subagents", "recentMinutes").type).toBe("number");
  });

  it.each([
    { alias: "SendMessage", value: "hello from SendMessage" },
    { alias: "content", value: "hello from content" },
    { alias: "text", value: "hello from text" },
  ])("sessions_send prepares hidden $alias alias before validation", ({ alias, value }) => {
    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }
    if (!tool.prepareArguments) {
      throw new Error("sessions_send missing prepareArguments");
    }

    const prepared = tool.prepareArguments({
      sessionKey: "main",
      [alias]: value,
      timeoutSeconds: 0,
    }) as Record<string, unknown>;

    expect(prepared.message).toBe(value);
    expect(prepared[alias]).toBeUndefined();
  });

  it.each([
    { alias: "SendMessage", value: "hello from SendMessage" },
    { alias: "content", value: "hello from content" },
    { alias: "text", value: "hello from text" },
  ])("sessions_send normalizes $alias alias to message", async ({ alias, value }) => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-alias", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-alias", {
      sessionKey: "main",
      [alias]: value,
      timeoutSeconds: 0,
    });

    expect(sessionsSendDetails(result.details).status).toBe("accepted");
    const agentCall = callGatewayMock.mock.calls
      .map((call) => call[0] as GatewayCall)
      .find((call) => call.method === "agent");
    expect(agentCall).toBeDefined();
    expect(agentParams(agentCall ?? {}).message).toContain(value);
  });

  it("sessions_send sanitizes formatted reasoning from aliases", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-alias", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-alias", {
      sessionKey: "main",
      SendMessage: "Reasoning:\n_internal plan_\n\nVisible answer",
      timeoutSeconds: 0,
    });

    expect(sessionsSendDetails(result.details).status).toBe("accepted");
    const agentCall = callGatewayMock.mock.calls
      .map((call) => call[0] as GatewayCall)
      .find((call) => call.method === "agent");
    expect(agentCall).toBeDefined();
    expect(agentParams(agentCall ?? {}).message).toContain("Visible answer");
    expect(agentParams(agentCall ?? {}).message).not.toContain("internal plan");
  });

  it("sessions_send prepares sanitized aliases without exposing alias keys", () => {
    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_send");
    if (!tool?.prepareArguments) {
      throw new Error("missing sessions_send prepareArguments");
    }

    const prepared = tool.prepareArguments({
      sessionKey: "main",
      SendMessage: "Reasoning:\n_internal plan_\n\nVisible answer",
      timeoutSeconds: 0,
    }) as Record<string, unknown>;

    expect(prepared.message).toBe("Visible answer");
    expect(prepared.SendMessage).toBeUndefined();
  });

  it("sessions_list forwards mailbox filters and includes messages", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "main",
              kind: "direct",
              sessionId: "s-main",
              updatedAt: 10,
              lastChannel: "whatsapp",
              derivedTitle: "Main mailbox",
              lastMessagePreview: "Latest assistant update",
            },
            {
              key: "discord:group:dev",
              kind: "group",
              sessionId: "s-group",
              updatedAt: 11,
              channel: "discord",
              displayName: "discord:g-dev",
              status: "running",
              startedAt: 100,
              runtimeMs: 42,
              estimatedCostUsd: 0.0042,
              childSessions: ["agent:main:subagent:worker"],
              derivedTitle: "Dev room",
              lastMessagePreview: "Need review on the patch",
              deliveryContext: {
                channel: "discord",
                to: "channel:dev",
                threadId: 999,
              },
            },
            {
              key: "agent:main:dashboard:child",
              kind: "direct",
              sessionId: "s-dashboard-child",
              updatedAt: 12,
              parentSessionKey: "agent:main:main",
            },
            {
              key: "agent:main:subagent:worker",
              kind: "direct",
              sessionId: "s-subagent-worker",
              updatedAt: 13,
              spawnedBy: "agent:main:main",
            },
            {
              key: "cron:job-1",
              kind: "direct",
              sessionId: "s-cron",
              updatedAt: 9,
            },
            { key: "global", kind: "global" },
            { key: "unknown", kind: "unknown" },
          ],
        };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            { role: "toolResult", content: [] },
            {
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
            },
          ],
        };
      }
      return {};
    });

    const tool = createTestTools().find((candidate) => candidate.name === "sessions_list");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_list tool");
    }

    const result = await tool.execute("call1", {
      agentId: "main",
      label: "mailbox",
      search: "review",
      includeDerivedTitles: true,
      includeLastMessage: true,
      messageLimit: 1,
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(1, {
      method: "sessions.list",
      params: {
        activeMinutes: undefined,
        agentId: "main",
        includeDerivedTitles: false,
        includeLastMessage: false,
        includeGlobal: true,
        includeUnknown: true,
        label: "mailbox",
        limit: undefined,
        search: "review",
        spawnedBy: undefined,
      },
    });
    const details = result.details as {
      sessions?: Array<{
        key?: string;
        agentId?: string;
        channel?: string;
        derivedTitle?: string;
        lastMessagePreview?: string;
        spawnedBy?: string;
        status?: string;
        startedAt?: number;
        runtimeMs?: number;
        estimatedCostUsd?: number;
        childSessions?: string[];
        parentSessionKey?: string;
        deliveryContext?: { channel?: string; threadId?: string; to?: string };
        messages?: Array<{ role?: string }>;
      }>;
    };
    expect(details.sessions).toHaveLength(5);
    const main = details.sessions?.find((s) => s.key === "main");
    expect(main?.agentId).toBe("main");
    expect(main?.channel).toBe("whatsapp");
    expect(main?.derivedTitle).toBe("Main mailbox");
    expect(main?.lastMessagePreview).toBe("Latest assistant update");
    expect(main?.messages?.length).toBe(1);
    expect(main?.messages?.[0]?.role).toBe("assistant");

    const group = details.sessions?.find((s) => s.key === "discord:group:dev");
    expect(group?.status).toBe("running");
    expect(group?.startedAt).toBe(100);
    expect(group?.runtimeMs).toBe(42);
    expect(group?.estimatedCostUsd).toBe(0.0042);
    expect(group?.childSessions).toEqual(["agent:main:subagent:worker"]);
    expect(group?.derivedTitle).toBe("Dev room");
    expect(group?.lastMessagePreview).toBe("Need review on the patch");
    expect(group?.deliveryContext).toEqual({
      channel: "discord",
      to: "channel:dev",
      threadId: "999",
    });

    const dashboardChild = details.sessions?.find((s) => s.key === "agent:main:dashboard:child");
    expect(dashboardChild?.parentSessionKey).toBe("agent:main:main");

    const subagentWorker = details.sessions?.find((s) => s.key === "agent:main:subagent:worker");
    expect(subagentWorker?.spawnedBy).toBe("agent:main:main");

    const cronOnly = await tool.execute("call2", { kinds: ["cron"] });
    const cronDetails = cronOnly.details as {
      sessions?: Array<Record<string, unknown>>;
    };
    expect(cronDetails.sessions).toHaveLength(1);
    expect(cronDetails.sessions?.[0]?.kind).toBe("cron");
  });

  it("derives mailbox previews only after agent visibility filtering", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-list-preview-"));
    const storePath = path.join(tmpDir, "sessions.json");
    try {
      fs.writeFileSync(
        path.join(tmpDir, "visible.jsonl"),
        [
          JSON.stringify({ type: "session", id: "visible" }),
          JSON.stringify({ message: { role: "user", content: "Visible project kickoff" } }),
          JSON.stringify({ message: { role: "assistant", content: "Visible latest reply" } }),
        ].join("\n"),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(tmpDir, "hidden.jsonl"),
        [
          JSON.stringify({ type: "session", id: "hidden" }),
          JSON.stringify({ message: { role: "user", content: "Hidden cross-agent topic" } }),
          JSON.stringify({ message: { role: "assistant", content: "Hidden latest reply" } }),
        ].join("\n"),
        "utf-8",
      );

      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string; params?: Record<string, unknown> };
        if (request.method === "sessions.list") {
          expect(request.params?.includeDerivedTitles).toBe(false);
          expect(request.params?.includeLastMessage).toBe(false);
          return {
            path: storePath,
            sessions: [
              {
                key: "agent:main:main",
                kind: "direct",
                sessionId: "visible",
                updatedAt: 20,
              },
              {
                key: "agent:other:main",
                kind: "direct",
                sessionId: "hidden",
                updatedAt: 21,
              },
            ],
          };
        }
        return {};
      });

      const tool = createTestTools({
        agentSessionKey: "agent:main:main",
        config: {
          ...TEST_CONFIG,
          tools: {
            sessions: { visibility: "agent" },
            agentToAgent: { enabled: false },
          },
        } as OpenClawConfig,
      }).find((candidate) => candidate.name === "sessions_list");
      if (!tool) {
        throw new Error("missing sessions_list tool");
      }

      const result = await tool.execute("call-preview", {
        includeDerivedTitles: true,
        includeLastMessage: true,
      });
      const details = result.details as { sessions?: Array<Record<string, unknown>> };
      expect(details.sessions).toStrictEqual([
        {
          key: "agent:main:main",
          agentId: "main",
          kind: "other",
          channel: "unknown",
          origin: undefined,
          spawnedBy: undefined,
          label: undefined,
          displayName: undefined,
          derivedTitle: "Visible project kickoff",
          lastMessagePreview: "Visible latest reply",
          parentSessionKey: undefined,
          deliveryContext: undefined,
          updatedAt: 20,
          sessionId: "visible",
          model: undefined,
          contextTokens: undefined,
          totalTokens: undefined,
          estimatedCostUsd: undefined,
          status: undefined,
          startedAt: undefined,
          endedAt: undefined,
          runtimeMs: undefined,
          childSessions: undefined,
          thinkingLevel: undefined,
          fastMode: undefined,
          verboseLevel: undefined,
          reasoningLevel: undefined,
          elevatedLevel: undefined,
          responseUsage: undefined,
          systemSent: undefined,
          abortedLastRun: undefined,
          sendPolicy: undefined,
          lastChannel: undefined,
          lastTo: undefined,
          lastAccountId: undefined,
          transcriptPath: path.join(fs.realpathSync(tmpDir), "visible.jsonl"),
        },
      ]);
      expect(JSON.stringify(details.sessions)).not.toContain("Hidden");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("sessions_list resolves transcriptPath from agent state dir for multi-store listings", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "(multiple)",
          sessions: [
            {
              key: "main",
              kind: "direct",
              sessionId: "sess-main",
              updatedAt: 12,
            },
          ],
        };
      }
      return {};
    });

    const tool = createTestTools().find((candidate) => candidate.name === "sessions_list");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_list tool");
    }

    const result = await tool.execute("call2b", {});
    const details = result.details as {
      sessions?: Array<{
        key?: string;
        transcriptPath?: string;
      }>;
    };
    const main = details.sessions?.find((session) => session.key === "main");
    expect(typeof main?.transcriptPath).toBe("string");
    expect(main?.transcriptPath).not.toContain("(multiple)");
    expect(main?.transcriptPath).toContain(
      path.join("agents", "main", "sessions", "sess-main.jsonl"),
    );
  });

  it("sessions_history filters tool messages by default", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return {
          messages: [
            { role: "toolResult", content: [] },
            {
              role: "assistant",
              provider: "openclaw",
              model: "delivery-mirror",
              content: [{ type: "text", text: "mirrored" }],
            },
            {
              role: "assistant",
              provider: "openclaw",
              model: "gateway-injected",
              content: [{ type: "text", text: "injected" }],
            },
            { role: "assistant", content: [{ type: "text", text: "ok" }] },
          ],
        };
      }
      return {};
    });

    const tool = createTestTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call3", { sessionKey: "main" });
    const details = result.details as { messages?: unknown[] };
    expect(details.messages).toHaveLength(3);
    expect(details.messages).toContainEqual(
      expect.objectContaining({ provider: "openclaw", model: "gateway-injected" }),
    );
    expect(details.messages).toContainEqual(
      expect.objectContaining({ provider: "openclaw", model: "delivery-mirror" }),
    );

    const withTools = await tool.execute("call4", {
      sessionKey: "main",
      includeTools: true,
    });
    const withToolsDetails = withTools.details as { messages?: unknown[] };
    expect(withToolsDetails.messages).toHaveLength(4);
    expect(withToolsDetails.messages).toContainEqual(
      expect.objectContaining({ provider: "openclaw", model: "delivery-mirror" }),
    );
    expect(withToolsDetails.messages).toContainEqual(
      expect.objectContaining({ provider: "openclaw", model: "gateway-injected" }),
    );
  });

  it("sessions_history caps oversized payloads and strips heavy fields", async () => {
    const oversized = Array.from({ length: 80 }, (_, idx) => ({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `${String(idx)}:${"x".repeat(5000)}`,
        },
        {
          type: "thinking",
          thinking: "y".repeat(7000),
          thinkingSignature: "sig".repeat(4000),
          openclawReasoningReplay: {
            v: 1,
            source: "openai-responses",
            provider: "openai",
            api: "openai-chatgpt-responses",
            model: "gpt-5.5",
          },
        },
      ],
      details: {
        giant: "z".repeat(12000),
      },
      usage: {
        input: 1,
        output: 1,
      },
    }));
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return { messages: oversized };
      }
      return {};
    });

    const tool = createTestTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call4b", {
      sessionKey: "main",
      includeTools: true,
    });
    const details = result.details as {
      messages?: Array<Record<string, unknown>>;
      truncated?: boolean;
      droppedMessages?: boolean;
      contentTruncated?: boolean;
      contentRedacted?: boolean;
      bytes?: number;
    };
    expect(details.truncated).toBe(true);
    expect(details.droppedMessages).toBe(true);
    expect(details.contentTruncated).toBe(true);
    expect(details.contentRedacted).toBe(false);
    expect(typeof details.bytes).toBe("number");
    expect((details.bytes ?? 0) <= 80 * 1024).toBe(true);
    expect(details.messages && details.messages.length > 0).toBe(true);

    const first = details.messages?.[0] as
      | {
          details?: unknown;
          usage?: unknown;
          content?: Array<{
            type?: string;
            text?: string;
            thinking?: string;
            thinkingSignature?: string;
            openclawReasoningReplay?: unknown;
          }>;
        }
      | undefined;
    expect(first?.details).toBeUndefined();
    expect(first?.usage).toBeUndefined();
    const textBlock = first?.content?.find((block) => block.type === "text");
    expect(typeof textBlock?.text).toBe("string");
    expect((textBlock?.text ?? "").length <= 4015).toBe(true);
    const thinkingBlock = first?.content?.find((block) => block.type === "thinking");
    expect(thinkingBlock?.thinkingSignature).toBeUndefined();
    expect(thinkingBlock?.openclawReasoningReplay).toBeUndefined();
  });

  it("sessions_history enforces a hard byte cap even when a single message is huge", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
              extra: "x".repeat(200_000),
            },
          ],
        };
      }
      return {};
    });

    const tool = createTestTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call4c", {
      sessionKey: "main",
      includeTools: true,
    });
    const details = result.details as {
      messages?: Array<Record<string, unknown>>;
      truncated?: boolean;
      droppedMessages?: boolean;
      contentTruncated?: boolean;
      contentRedacted?: boolean;
      bytes?: number;
    };
    expect(details.truncated).toBe(true);
    expect(details.droppedMessages).toBe(true);
    expect(details.contentTruncated).toBe(false);
    expect(details.contentRedacted).toBe(false);
    expect(typeof details.bytes).toBe("number");
    expect((details.bytes ?? 0) <= 80 * 1024).toBe(true);
    expect(details.messages).toHaveLength(1);
    expect(details.messages?.[0]?.content).toContain(
      "[sessions_history omitted: message too large]",
    );
  });

  it("sessions_history sets contentRedacted when sensitive data is redacted", async () => {
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text", text: "Use sk-1234567890abcdef1234 to authenticate with the API." },
              ],
            },
          ],
        };
      }
      return {};
    });

    const tool = createTestTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call-redact-1", { sessionKey: "main" });
    const details = result.details as {
      messages?: Array<Record<string, unknown>>;
      truncated?: boolean;
      contentTruncated?: boolean;
      contentRedacted?: boolean;
    };
    expect(details.contentRedacted).toBe(true);
    expect(details.contentTruncated).toBe(false);
    expect(details.truncated).toBe(false);
    const msg = details.messages?.[0] as { content?: Array<{ type?: string; text?: string }> };
    const textBlock = msg?.content?.find((b) => b.type === "text");
    expect(typeof textBlock?.text).toBe("string");
    expect(textBlock?.text).not.toContain("sk-1234567890abcdef1234");
  });

  it("sessions_history sets both contentRedacted and contentTruncated independently", async () => {
    callGatewayMock.mockReset();
    const longPrefix = "safe text ".repeat(420);
    const sensitiveText = `${longPrefix} sk-9876543210fedcba9876 end`;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: sensitiveText }],
            },
          ],
        };
      }
      return {};
    });

    const tool = createTestTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call-redact-2", { sessionKey: "main" });
    const details = result.details as {
      truncated?: boolean;
      contentTruncated?: boolean;
      contentRedacted?: boolean;
    };
    expect(details.contentRedacted).toBe(true);
    expect(details.contentTruncated).toBe(true);
    expect(details.truncated).toBe(true);
  });

  it("sessions_history resolves sessionId inputs", async () => {
    const sessionId = "sess-group";
    const targetKey = "agent:main:discord:channel:1457165743010611293";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as {
        method?: string;
        params?: Record<string, unknown>;
      };
      if (request.method === "sessions.resolve") {
        return {
          key: targetKey,
        };
      }
      if (request.method === "chat.history") {
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
        };
      }
      return {};
    });

    const tool = createTestTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call5", { sessionKey: sessionId });
    const details = result.details as { messages?: unknown[] };
    expect(details.messages).toStrictEqual([
      {
        content: [{ text: "ok", type: "text" }],
        role: "assistant",
      },
    ]);
    const historyCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method?: string }).method === "chat.history",
    );
    const request = requireGatewayCall(historyCall?.[0], "chat.history");
    expect(request.params?.sessionKey).toBe(targetKey);
  });

  it("sessions_history errors on missing sessionId", async () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.resolve") {
        throw new Error("No session found");
      }
      return {};
    });

    const tool = createTestTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call6", { sessionKey: sessionId });
    const details = result.details as { status?: string; error?: string };
    expect(details.status).toBe("error");
    expect(details.error).toMatch(/Session not found|No session found/);
  });

  it("sessions_send supports fire-and-forget and wait", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let historyCallCount = 0;
    let waitCallCount = 0;
    let sendCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    const requesterKey = "discord:group:req";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as { message?: string; sessionKey?: string } | undefined;
        const message = params?.message ?? "";
        let reply = "REPLY_SKIP";
        if (message.includes("ping") || message.includes("wait")) {
          reply = "done";
        } else if (message.includes("Agent-to-agent announce step.")) {
          reply = "ANNOUNCE_SKIP";
        } else if (params?.sessionKey === requesterKey) {
          reply = "pong";
        }
        replyByRunId.set(runId, reply);
        return {
          runId,
          status: "accepted",
          acceptedAt: 1234 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        waitCallCount += 1;
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        historyCallCount += 1;
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text,
                },
              ],
              timestamp: 20,
            },
          ],
        };
      }
      if (request.method === "send") {
        sendCallCount += 1;
        return { messageId: "m1" };
      }
      return {};
    });

    const tool = createTestTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const fire = await tool.execute("call5", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 0,
    });
    const fireDetails = sessionsSendDetails(fire.details);
    expect(fireDetails.status).toBe("accepted");
    expect(fireDetails.runId).toBe("run-1");
    expect(fireDetails.delivery?.status).toBe("pending");
    expect(fireDetails.delivery?.mode).toBe("announce");
    await waitForCalls(() => agentCallCount, 3);
    await waitForCalls(() => waitCallCount, 3);
    await waitForCalls(() => historyCallCount, 3);

    const waitPromise = tool.execute("call6", {
      sessionKey: "main",
      message: "wait",
      timeoutSeconds: 1,
    });
    const waited = await waitPromise;
    const waitedDetails = sessionsSendDetails(waited.details);
    expect(waitedDetails.status).toBe("ok");
    expect(waitedDetails.reply).toBe("done");
    expect(waitedDetails.delivery?.status).toBe("pending");
    expect(waitedDetails.delivery?.mode).toBe("announce");
    expect(typeof (waited.details as { runId?: string }).runId).toBe("string");
    await waitForCalls(() => agentCallCount, 6);
    await waitForCalls(() => waitCallCount, 6);
    await waitForCalls(() => historyCallCount, 7);

    const agentCalls = calls.filter((call) => call.method === "agent");
    const waitCalls = calls.filter((call) => call.method === "agent.wait");
    const historyOnlyCalls = calls.filter((call) => call.method === "chat.history");
    expect(agentCalls).toHaveLength(6);
    for (const call of agentCalls) {
      expectInterSessionAgentCall(call);
    }
    expect(
      agentCalls.some(
        (call) =>
          typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
          (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt?.includes(
            "Agent-to-agent message context",
          ),
      ),
    ).toBe(true);
    const initialAgentCall = agentCalls.find((call) =>
      agentParams(call).extraSystemPrompt?.includes("Agent-to-agent message context"),
    );
    const initialAgentParams = agentParams(initialAgentCall ?? {});
    expect(initialAgentParams.extraSystemPrompt).toContain(
      "Agent 1 (requester) session: <REQUESTER_SESSION>.",
    );
    expect(initialAgentParams.extraSystemPrompt).toContain("Agent 1 (requester) channel: discord.");
    expect(initialAgentParams.extraSystemPrompt).toContain(
      "Agent 2 (target) session: <TARGET_SESSION>.",
    );
    expect(initialAgentParams.extraSystemPrompt).not.toContain(requesterKey);
    expect(initialAgentParams.inputProvenance).toMatchObject({
      kind: "inter_session",
      sourceSessionKey: requesterKey,
      sourceChannel: "discord",
      sourceTool: "sessions_send",
    });
    expect(
      agentCalls.some(
        (call) =>
          typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
          (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt?.includes(
            "Agent-to-agent reply step",
          ),
      ),
    ).toBe(true);
    expect(
      agentCalls.some(
        (call) =>
          typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
          (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt?.includes(
            "Agent-to-agent announce step",
          ),
      ),
    ).toBe(true);
    expect(waitCalls).toHaveLength(8);
    expect(historyOnlyCalls.length).toBeGreaterThanOrEqual(8);
    expect(sendCallCount).toBe(0);
  });

  it("sessions_send returns pending agent error diagnostics on timeout", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      if (request.method === "agent") {
        return {
          runId: "run-pending-model-error",
          status: "accepted",
          acceptedAt: 1234,
        };
      }
      if (request.method === "agent.wait") {
        return {
          runId: "run-pending-model-error",
          status: "timeout",
          error: "429 RESOURCE_EXHAUSTED",
          pendingError: true,
        };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-pending-error", {
      sessionKey: "main",
      message: "check status",
      timeoutSeconds: 1,
    });

    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("timeout");
    expect(details.error).toBe("429 RESOURCE_EXHAUSTED");
    expect(details.runId).toBe("run-pending-model-error");
    expect(details.sentBeforeError).toBe(true);
    expect(details.delivery?.status).toBe("pending");
    expect(calls.filter((call) => call.method === "agent")).toHaveLength(1);
    await vi.waitFor(() =>
      expect(calls.filter((call) => call.method === "agent.wait").length).toBeGreaterThanOrEqual(2),
    );
  });

  it("sessions_send supports per-call a2a turn and timeout bounds", async () => {
    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>([
      ["run-1", "done"],
      ["run-2", "ANNOUNCE_SKIP"],
    ]);

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        return {
          runId: `run-${agentCallCount}`,
          status: "accepted",
          acceptedAt: 2000 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        lastWaitedRunId =
          typeof request.params?.runId === "string" ? request.params.runId : undefined;
        return { runId: lastWaitedRunId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text }],
              timestamp: 20,
            },
          ],
        };
      }
      return {};
    });

    const tool = createTestTools({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-bounds", {
      sessionKey: "main",
      message: "wait",
      timeoutSeconds: 30,
      maxPingPongTurns: 0,
      a2aTimeoutSeconds: 7,
    });

    expect(result.details).toMatchObject({ status: "ok", reply: "done" });
    const agentCalls = calls.filter((call) => call.method === "agent");
    const waitCalls = calls.filter((call) => call.method === "agent.wait");
    expect(agentCalls).toHaveLength(2);
    expect(waitCalls).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ runId: "run-1", timeoutMs: 30000 }),
      }),
      expect.objectContaining({
        params: expect.objectContaining({ runId: "run-2", timeoutMs: 7000 }),
      }),
    ]);
  });

  it("sessions_send resolves sessionId inputs", async () => {
    const sessionId = "sess-send";
    const targetKey = "agent:main:discord:channel:123";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as {
        method?: string;
        params?: Record<string, unknown>;
      };
      if (request.method === "sessions.resolve") {
        return { key: targetKey };
      }
      if (request.method === "agent") {
        return { runId: "run-1", acceptedAt: 123 };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });

    const tool = createTestTools({
      agentSessionKey: "main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call7", {
      sessionKey: sessionId,
      message: "ping",
      timeoutSeconds: 0,
    });
    const details = result.details as { status?: string };
    expect(details.status).toBe("accepted");
    const agentCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method?: string }).method === "agent",
    );
    const request = requireGatewayCall(agentCall?.[0], "agent");
    expect(request.params?.sessionKey).toBe(targetKey);
  });

  it("sessions_send resolves selector inputs via sessions.resolve", async () => {
    const targetKey = "agent:dev-openclaw:slack:channel:c0ag96mgjtv:thread:1773000000.222222";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as {
        method?: string;
        params?: Record<string, unknown>;
      };
      if (request.method === "sessions.resolve") {
        return {
          key: targetKey,
          agentId: "dev-openclaw",
          deliveryContext: {
            channel: "slack",
            to: "channel:C0AG96MGJTV",
            threadId: "1773000000.222222",
          },
          resolution: {
            matchedBy: "search",
            threadPolicy: "prefer-thread",
            selection: "most-recent",
            search: "a2a feature dev",
            searchFields: ["derivedTitle"],
          },
        };
      }
      if (request.method === "agent") {
        return { runId: "run-selector", acceptedAt: 456 };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });

    const tool = createTestTools({
      agentSessionKey: "agent:dev-openclaw:main",
      agentChannel: "slack",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call7b", {
      agentId: "dev-openclaw",
      search: "a2a feature dev",
      searchFields: ["derivedTitle"],
      selection: "most-recent",
      threadPolicy: "prefer-thread",
      message: "ping",
      timeoutSeconds: 0,
    });
    const details = result.details as {
      status?: string;
      resolvedTarget?: {
        sessionKey?: string;
        agentId?: string;
        deliveryContext?: { channel?: string; to?: string; threadId?: string };
        resolution?: { matchedBy?: string; threadPolicy?: string; selection?: string };
      };
    };
    expect(details.status).toBe("accepted");
    expect(details.resolvedTarget).toEqual({
      sessionKey: targetKey,
      agentId: "dev-openclaw",
      deliveryContext: {
        channel: "slack",
        to: "channel:C0AG96MGJTV",
        threadId: "1773000000.222222",
      },
      resolution: {
        matchedBy: "search",
        threadPolicy: "prefer-thread",
        selection: "most-recent",
        search: "a2a feature dev",
        searchFields: ["derivedTitle"],
      },
    });
    const resolveCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method?: string }).method === "sessions.resolve",
    );
    expect(resolveCall?.[0]).toMatchObject({
      method: "sessions.resolve",
      params: {
        agentId: "dev-openclaw",
        search: "a2a feature dev",
        searchFields: ["derivedTitle"],
        selection: "most-recent",
        threadPolicy: "prefer-thread",
      },
    });
    const agentCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method?: string }).method === "agent",
    );
    expect(agentCall?.[0]).toMatchObject({
      method: "agent",
      params: { sessionKey: targetKey },
    });
  });

  it("sessions_send translates natural sessionKey selectors into sessions.resolve filters", async () => {
    const targetKey = "agent:dev-openclaw:slack:channel:c0ag96mgjtv:thread:1773000000.222222";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as {
        method?: string;
        params?: Record<string, unknown>;
      };
      if (request.method === "sessions.resolve") {
        return {
          key: targetKey,
          agentId: "dev-openclaw",
          deliveryContext: {
            channel: "slack",
            to: "channel:C0AG96MGJTV",
            threadId: "1773000000.222222",
          },
          resolution: {
            matchedBy: "search",
            threadPolicy: "prefer-thread",
            selection: "most-recent",
            search: "a2a feature dev",
            searchFields: ["derivedTitle"],
          },
        };
      }
      if (request.method === "agent") {
        return { runId: "run-natural", acceptedAt: 456 };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });

    const tool = createTestTools({
      agentSessionKey: "agent:dev-openclaw:main",
      agentChannel: "slack",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call7c", {
      sessionKey: "the most recent a2a feature dev session managed by dev-openclaw",
      message: "ping",
      timeoutSeconds: 0,
    });
    const details = result.details as {
      status?: string;
      resolvedTarget?: {
        sessionKey?: string;
        resolution?: { matchedBy?: string; threadPolicy?: string; selection?: string };
      };
    };
    expect(details.status).toBe("accepted");
    expect(details.resolvedTarget?.sessionKey).toBe(targetKey);
    const resolveCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method?: string }).method === "sessions.resolve",
    );
    expect(resolveCall?.[0]).toMatchObject({
      method: "sessions.resolve",
      params: {
        agentId: "dev-openclaw",
        search: "a2a feature dev",
        searchFields: ["derivedTitle"],
        selection: "most-recent",
        threadPolicy: "prefer-thread",
      },
    });
  });

  it("sessions_send includes ingressEcho when pre-run echo succeeds", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "send") {
        const params = request.params as { message?: string } | undefined;
        if ((params?.message ?? "").includes("A2A ingress echo:")) {
          return { messageId: "m-ingress" };
        }
        return { messageId: "m-announce" };
      }
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as { extraSystemPrompt?: string } | undefined;
        let reply = "done";
        if (params?.extraSystemPrompt?.includes("Agent-to-agent reply step")) {
          reply = "REPLY_SKIP";
        }
        if (params?.extraSystemPrompt?.includes("Agent-to-agent announce step")) {
          reply = "ANNOUNCE_SKIP";
        }
        replyByRunId.set(runId, reply);
        return { runId, status: "accepted", acceptedAt: 5000 + agentCallCount };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "done";
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text }], timestamp: 20 }],
        };
      }
      return {};
    });

    testConfig.session.agentToAgent.ingressEcho.enabled = true;
    const tool = createTestTools({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
      config: testConfig,
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-ingress-ok", {
      sessionKey: "discord:group:target",
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      ingressEcho: {
        status: "sent",
        channel: "discord",
        to: "group:target",
        messageId: "m-ingress",
      },
    });
    const firstSendIndex = calls.findIndex((call) => call.method === "send");
    const firstAgentIndex = calls.findIndex((call) => call.method === "agent");
    expect(firstSendIndex).toBeGreaterThanOrEqual(0);
    expect(firstAgentIndex).toBeGreaterThan(firstSendIndex);
  });

  it("sessions_send blocks nested relay by default for inter-session sessions_send inputs", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "user",
              provenance: { kind: "inter_session", sourceTool: "sessions_send" },
              content: [{ type: "text", text: "relay this onward" }],
            },
          ],
        };
      }
      if (request.method === "agent") {
        throw new Error("agent should not run");
      }
      return {};
    });

    const tool = createTestTools({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-nested-blocked", {
      sessionKey: "discord:group:target",
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({
      status: "forbidden",
    });
    expect((result.details as { error?: string }).error).toContain(
      "Nested sessions_send relay blocked",
    );
  });

  it("sessions_send reports not_applicable when ingress echo target cannot be resolved in best-effort mode", async () => {
    testConfig.session.agentToAgent.ingressEcho.enabled = true;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      if (request.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 7777 };
      }
      if (request.method === "agent.wait") {
        return { runId: "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        const params = request.params as { sessionKey?: string } | undefined;
        if (params?.sessionKey === "discord:group:target") {
          return {
            messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
          };
        }
        return { messages: [] };
      }
      if (request.method === "sessions.list") {
        return { sessions: [{ key: "something-else" }] };
      }
      return {};
    });

    const tool = createTestTools({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-ingress-no-target", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      ingressEcho: { status: "not_applicable" },
    });
  });

  it("sessions_send includes ingressEcho on fire-and-forget accepted path", async () => {
    testConfig.session.agentToAgent.ingressEcho.enabled = true;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      if (request.method === "send") {
        const params = request.params as { message?: string } | undefined;
        if ((params?.message ?? "").includes("A2A ingress echo:")) {
          return { messageId: "m-ingress-fire" };
        }
        return { messageId: "m-announce" };
      }
      if (request.method === "agent") {
        return { runId: "run-fire", status: "accepted", acceptedAt: 8888 };
      }
      if (request.method === "agent.wait") {
        return { runId: "run-fire", status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text: "REPLY_SKIP" }] }],
        };
      }
      return {};
    });

    const tool = createTestTools({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-ingress-fire", {
      sessionKey: "discord:group:target",
      message: "ping",
      timeoutSeconds: 0,
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      ingressEcho: {
        status: "sent",
        messageId: "m-ingress-fire",
      },
    });
  });

  it("sessions_send blocks target run when strict ingress echo delivery fails", async () => {
    testConfig.session.agentToAgent.ingressEcho.enabled = true;
    testConfig.session.agentToAgent.ingressEcho.requireDelivery = true;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "send") {
        throw new Error("send failed");
      }
      if (request.method === "agent") {
        throw new Error("agent should not run");
      }
      return {};
    });

    const tool = createTestTools({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
      config: testConfig,
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-ingress-blocked", {
      sessionKey: "discord:group:target",
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({
      status: "error",
      ingressEcho: { status: "blocked" },
    });
    expect(
      callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string }).method === "agent",
      ),
    ).toBe(false);
  });

  it("sessions_send allows nested relay when explicitly enabled", async () => {
    testConfig.session.agentToAgent.guard.allowNestedSessionsSend = true;
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      if (request.method === "chat.history") {
        const params = request.params as { sessionKey?: string } | undefined;
        if (params?.sessionKey === "discord:group:req") {
          return {
            messages: [
              {
                role: "user",
                provenance: { kind: "inter_session", sourceTool: "sessions_send" },
                content: [{ type: "text", text: "relay this onward" }],
              },
            ],
          };
        }
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "done";
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text }], timestamp: 20 }],
        };
      }
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as { extraSystemPrompt?: string } | undefined;
        let reply = "done";
        if (params?.extraSystemPrompt?.includes("Agent-to-agent reply step")) {
          reply = "REPLY_SKIP";
        }
        if (params?.extraSystemPrompt?.includes("Agent-to-agent announce step")) {
          reply = "ANNOUNCE_SKIP";
        }
        replyByRunId.set(runId, reply);
        return { runId, status: "accepted", acceptedAt: 9000 + agentCallCount };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      return {};
    });

    const tool = createTestTools({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-nested-allowed", {
      sessionKey: "discord:group:target",
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({ status: "ok", reply: "done" });
  });

  it("sessions_send relays round1 turns to both source and target channels in dual-channel mode and suppresses announce", async () => {
    testConfig.session.agentToAgent.relay.enabled = true;
    testConfig.session.agentToAgent.relay.mode = "dual-channel";
    testConfig.session.agentToAgent.relay.mirrorTurns = "round1";

    const sends: Array<{ to?: string; channel?: string; message?: string }> = [];
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "send") {
        sends.push({
          to: request.params?.to as string | undefined,
          channel: request.params?.channel as string | undefined,
          message: request.params?.message as string | undefined,
        });
        return { messageId: `m-${sends.length}` };
      }
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const extra = request.params?.extraSystemPrompt as string | undefined;
        let reply = "done";
        if (extra?.includes("Agent-to-agent reply step")) {
          reply = "REPLY_SKIP";
        }
        if (extra?.includes("Agent-to-agent announce step")) {
          reply = "ANNOUNCE_SKIP";
        }
        replyByRunId.set(runId, reply);
        return { runId, status: "accepted", acceptedAt: 12000 + agentCallCount };
      }
      if (request.method === "agent.wait") {
        lastWaitedRunId = request.params?.runId as string | undefined;
        return { runId: request.params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        const sessionKey = request.params?.sessionKey as string | undefined;
        if (sessionKey === "discord:group:req") {
          return { messages: [] };
        }
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "done",
                },
              ],
              timestamp: 20,
            },
          ],
        };
      }
      return {};
    });

    const tool = createTestTools({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-relay-dual", {
      sessionKey: "discord:group:target",
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      relay: { status: "sent", mode: "dual-channel", mirrorTurns: "round1" },
    });

    await waitForCalls(() => sends.length, 4);
    const relaySends = sends.filter((entry) => (entry.message ?? "").includes(" -> "));
    expect(relaySends).toHaveLength(4);
    expect(
      relaySends.map((entry) => entry.to).toSorted((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(["channel:req", "channel:req", "channel:target", "channel:target"]);
    expect(relaySends.every((entry) => (entry.message ?? "").includes(" -> "))).toBe(true);
    expect(relaySends.some((entry) => (entry.message ?? "").includes("ping"))).toBe(true);
    expect(relaySends.some((entry) => (entry.message ?? "").includes("done"))).toBe(true);
    expect(relaySends.every((entry) => !(entry.message ?? "").includes("[A2A handoff:"))).toBe(
      true,
    );
    expect(sends).toHaveLength(4);
  });

  it("sessions_send blocks sync result when strict target-only relay delivery fails", async () => {
    testConfig.session.agentToAgent.relay.enabled = true;
    testConfig.session.agentToAgent.relay.mode = "target-only";
    testConfig.session.agentToAgent.relay.mirrorTurns = "round1";
    testConfig.session.agentToAgent.relay.requireDelivery = true;

    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "send") {
        throw new Error("relay send failed");
      }
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const extra = request.params?.extraSystemPrompt as string | undefined;
        let reply = "done";
        if (extra?.includes("Agent-to-agent reply step")) {
          reply = "REPLY_SKIP";
        }
        if (extra?.includes("Agent-to-agent announce step")) {
          reply = "ANNOUNCE_SKIP";
        }
        replyByRunId.set(runId, reply);
        return { runId, status: "accepted", acceptedAt: 12500 + agentCallCount };
      }
      if (request.method === "agent.wait") {
        lastWaitedRunId = request.params?.runId as string | undefined;
        return { runId: request.params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "done",
                },
              ],
              timestamp: 20,
            },
          ],
        };
      }
      return {};
    });

    const tool = createTestTools({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-relay-strict-target", {
      sessionKey: "discord:group:target",
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({
      status: "error",
      error: "Required relay delivery failed.",
      relay: {
        status: "blocked",
        mode: "target-only",
        mirrorTurns: "round1",
        targets: [
          {
            role: "target",
            status: "blocked",
            error: "relay send failed",
          },
        ],
      },
    });
  });

  it("sessions_send reports partial relay success in dual-channel best-effort mode", async () => {
    testConfig.session.agentToAgent.relay.enabled = true;
    testConfig.session.agentToAgent.relay.mode = "dual-channel";
    testConfig.session.agentToAgent.relay.mirrorTurns = "round1";
    testConfig.session.agentToAgent.relay.requireDelivery = false;

    const sends: Array<{ to?: string; channel?: string; message?: string }> = [];
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "send") {
        const to = request.params?.to as string | undefined;
        if (to === "channel:req") {
          throw new Error("source relay failed");
        }
        sends.push({
          to,
          channel: request.params?.channel as string | undefined,
          message: request.params?.message as string | undefined,
        });
        return { messageId: `m-${sends.length}` };
      }
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const extra = request.params?.extraSystemPrompt as string | undefined;
        let reply = "done";
        if (extra?.includes("Agent-to-agent reply step")) {
          reply = "REPLY_SKIP";
        }
        if (extra?.includes("Agent-to-agent announce step")) {
          reply = "ANNOUNCE_SKIP";
        }
        replyByRunId.set(runId, reply);
        return { runId, status: "accepted", acceptedAt: 12700 + agentCallCount };
      }
      if (request.method === "agent.wait") {
        lastWaitedRunId = request.params?.runId as string | undefined;
        return { runId: request.params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "done",
                },
              ],
              timestamp: 20,
            },
          ],
        };
      }
      return {};
    });

    const tool = createTestTools({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-relay-partial", {
      sessionKey: "discord:group:target",
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      relay: {
        status: "partial",
        mode: "dual-channel",
        mirrorTurns: "round1",
      },
    });
    expect(
      (result.details as { relay?: { targets?: Array<{ role?: string; status?: string }> } }).relay
        ?.targets,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "source", status: "failed" }),
        expect.objectContaining({ role: "target", status: "sent" }),
      ]),
    );
  });

  it("sessions_send relay verbosity full-payload includes handoff metadata", async () => {
    testConfig.session.agentToAgent.relay.enabled = true;
    testConfig.session.agentToAgent.relay.mode = "target-only";
    testConfig.session.agentToAgent.relay.mirrorTurns = "round1";
    testConfig.session.agentToAgent.relay.verbosity = "full-payload";

    const sends: Array<{ message?: string }> = [];
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    let agentCallCount = 0;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "send") {
        sends.push({ message: request.params?.message as string | undefined });
        return { messageId: `m-${sends.length}` };
      }
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const extra = request.params?.extraSystemPrompt as string | undefined;
        let reply = "done";
        if (extra?.includes("Agent-to-agent reply step")) {
          reply = "REPLY_SKIP";
        }
        if (extra?.includes("Agent-to-agent announce step")) {
          reply = "ANNOUNCE_SKIP";
        }
        replyByRunId.set(runId, reply);
        return { runId, status: "accepted", acceptedAt: 13000 + agentCallCount };
      }
      if (request.method === "agent.wait") {
        lastWaitedRunId = request.params?.runId as string | undefined;
        return { runId: request.params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "done",
                },
              ],
              timestamp: 20,
            },
          ],
        };
      }
      return {};
    });

    const tool = createTestTools({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    await tool.execute("call-relay-full", {
      sessionKey: "discord:group:target",
      message: "ping",
      timeoutSeconds: 1,
    });

    await waitForCalls(() => sends.length, 2);
    const relaySends = sends.filter((entry) => (entry.message ?? "").includes("[A2A handoff:"));
    expect(relaySends.length).toBeGreaterThanOrEqual(2);
  });

  it("sessions_send relay verbosity none suppresses mirrored sends", async () => {
    testConfig.session.agentToAgent.relay.enabled = true;
    testConfig.session.agentToAgent.relay.mode = "dual-channel";
    testConfig.session.agentToAgent.relay.mirrorTurns = "round1";
    testConfig.session.agentToAgent.relay.verbosity = "none";

    const sends: Array<{ message?: string }> = [];
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "send") {
        sends.push({ message: request.params?.message as string | undefined });
        return { messageId: `m-${sends.length}` };
      }
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const extra = request.params?.extraSystemPrompt as string | undefined;
        let reply = "done";
        if (extra?.includes("Agent-to-agent reply step")) {
          reply = "REPLY_SKIP";
        }
        if (extra?.includes("Agent-to-agent announce step")) {
          reply = "ANNOUNCE_SKIP";
        }
        replyByRunId.set(runId, reply);
        return { runId, status: "accepted", acceptedAt: 14000 + agentCallCount };
      }
      if (request.method === "agent.wait") {
        lastWaitedRunId = request.params?.runId as string | undefined;
        return { runId: request.params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "done",
                },
              ],
              timestamp: 20,
            },
          ],
        };
      }
      return {};
    });

    const tool = createTestTools({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    await tool.execute("call-relay-none", {
      sessionKey: "discord:group:target",
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(sends).toHaveLength(0);
  });

  it("sessions_send runs ping-pong then announces", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    const requesterKey = "discord:group:req";
    const targetKey = "discord:group:target";
    let sendParams: { to?: string; channel?: string; message?: string } = {};
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as
          | {
              message?: string;
              sessionKey?: string;
              extraSystemPrompt?: string;
            }
          | undefined;
        let reply = "initial";
        if (params?.extraSystemPrompt?.includes("Agent-to-agent reply step")) {
          reply = params.sessionKey === requesterKey ? "pong-1" : "pong-2";
        }
        if (params?.extraSystemPrompt?.includes("Agent-to-agent announce step")) {
          reply = "announce now";
        }
        replyByRunId.set(runId, reply);
        return {
          runId,
          status: "accepted",
          acceptedAt: 2000 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text }],
              timestamp: 20,
            },
          ],
        };
      }
      if (request.method === "send") {
        const params = request.params as
          | { to?: string; channel?: string; message?: string }
          | undefined;
        sendParams = {
          to: params?.to,
          channel: params?.channel,
          message: params?.message,
        };
        return { messageId: "m-announce" };
      }
      return {};
    });
    agentStepTesting.setDepsForTest({
      agentCommandFromIngress: async () => ({
        payloads: [{ text: "announce now", mediaUrl: null }],
        meta: { durationMs: 1 },
      }),
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });

    const tool = createTestTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const waited = await tool.execute("call7", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });
    const waitedDetails = sessionsSendDetails(waited.details);
    expect(waitedDetails.status).toBe("ok");
    expect(waitedDetails.reply).toBe("initial");
    await vi.waitFor(
      () => {
        expect(countMatching(calls, (call) => call.method === "agent")).toBe(3);
      },
      { timeout: 2_000, interval: 5 },
    );

    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(3);
    for (const call of agentCalls) {
      const params = agentParams(call);
      expect(params.lane).toMatch(/^nested(?::|$)/);
      expect(params.channel).toBe("webchat");
      expect(params.inputProvenance?.kind).toBe("inter_session");
    }

    const replySteps = calls.filter(
      (call) =>
        call.method === "agent" &&
        typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
        (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt?.includes(
          "Agent-to-agent reply step",
        ),
    );
    expect(replySteps).toHaveLength(2);
    expect(sendParams.to).toBe("group:target");
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.message).toBe("announce now");
  });

  it("sessions_send keeps delayed requester replies alive after a wait timeout", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const requesterKey = "agent:main:main";
    const targetKey = "agent:director1:main";
    let targetWaitCount = 0;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        const params = request.params as { sessionKey?: string } | undefined;
        if (params?.sessionKey === targetKey) {
          return { runId: "run-target", status: "accepted", acceptedAt: 2000 };
        }
        if (params?.sessionKey === requesterKey) {
          return { runId: "run-requester", status: "accepted", acceptedAt: 2001 };
        }
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        if (params?.runId === "run-target") {
          targetWaitCount += 1;
          return targetWaitCount === 1
            ? { runId: "run-target", status: "timeout" }
            : { runId: "run-target", status: "ok" };
        }
        if (params?.runId === "run-requester") {
          return { runId: "run-requester", status: "ok" };
        }
      }
      if (request.method === "chat.history") {
        const params = request.params as { sessionKey?: string } | undefined;
        if (params?.sessionKey === targetKey && targetWaitCount > 1) {
          return {
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "late director reply" }],
                timestamp: 20,
              },
            ],
          };
        }
        if (params?.sessionKey === requesterKey) {
          return {
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "requester saw director" }],
                timestamp: 21,
              },
            ],
          };
        }
        return { messages: [] };
      }
      return {};
    });

    const tool = createTestTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
      config: {
        ...TEST_CONFIG,
        session: {
          ...TEST_CONFIG.session,
          agentToAgent: { maxPingPongTurns: 1 },
        },
      },
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-delayed", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });
    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("accepted");
    expect(details.sessionKey).toBe(targetKey);
    expect(details.delivery?.status).toBe("pending");
    expect(details.delivery?.mode).toBe("announce");

    await vi.waitFor(
      () => {
        const requesterReplyCall = calls.find(
          (call) =>
            call.method === "agent" &&
            (call.params as { sessionKey?: string } | undefined)?.sessionKey === requesterKey,
        );
        if (!requesterReplyCall) {
          throw new Error("expected requester reply call");
        }
      },
      { timeout: 2_000, interval: 5 },
    );

    const requesterReplyCall = calls.find(
      (call) =>
        call.method === "agent" &&
        (call.params as { sessionKey?: string } | undefined)?.sessionKey === requesterKey,
    );
    const replyParams = requesterReplyCall?.params as
      | {
          extraSystemPrompt?: string;
          inputProvenance?: { sourceSessionKey?: string };
          message?: string;
          sessionKey?: string;
        }
      | undefined;
    expect(replyParams?.sessionKey).toBe(requesterKey);
    expect(replyParams?.inputProvenance?.sourceSessionKey).toBe(targetKey);
    expect(replyParams?.message).toContain("late director reply");
    expect(replyParams?.extraSystemPrompt).toContain("Agent-to-agent reply step");
    expect(replyParams?.extraSystemPrompt).toContain("Current agent: Agent 1 (requester)");
    expect(calls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("sessions_send reports active-run queue rejection without durable-session fallback", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const requesterKey = "agent:re-portal:main";
    const runScopedCallerKey = "agent:leasing-ops:cron:monthly-utility:run:run-fast";
    const queueMessage = vi.fn(async (_text: string, _options?: unknown) => {
      throw new Error("active session ended before queued steering message was committed");
    });
    setActiveEmbeddedRun(
      "caller-active-session",
      {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        supportsTranscriptCommitWait: true,
        sourceReplyDeliveryMode: "message_tool_only",
        abort: () => {},
      },
      runScopedCallerKey,
    );
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "fallback-run", status: "accepted", acceptedAt: 2000 };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "telegram",
      config: {
        ...TEST_CONFIG,
        session: {
          ...TEST_CONFIG.session,
          agentToAgent: { maxPingPongTurns: 0 },
        },
      },
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-run-scoped-caller", {
      sessionKey: runScopedCallerKey,
      message: "[TASK-COMPLETE] re-portal occupancy ready",
      timeoutSeconds: 0,
    });
    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("error");
    expect(details.sessionKey).toBe(runScopedCallerKey);
    expect(details.error).toContain("queue_message_failed reason=runtime_rejected");
    expect(details.error).toContain("caller-active-session");
    expect(details.error).not.toContain("fallback_failed");
    const queuedText = queueMessage.mock.calls[0]?.[0];
    expect(queuedText).toContain("[Inter-session message]");
    expect(queuedText).toContain("[TASK-COMPLETE] re-portal occupancy ready");
    expect(queueMessage).toHaveBeenCalledWith(queuedText, {
      steeringMode: "all",
      debounceMs: 0,
      deliveryTimeoutMs: 30_000,
      waitForTranscriptCommit: true,
      sourceReplyDeliveryMode: "message_tool_only",
    });
    expect(calls.some((call) => call.method === "agent")).toBe(false);
  });

  it("sessions_send reports source reply delivery mode mismatch without durable-session fallback", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const runScopedCallerKey = "agent:leasing-ops:cron:monthly-utility:run:run-fast";
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "caller-active-session",
      {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        supportsTranscriptCommitWait: true,
        sourceReplyDeliveryMode: "automatic",
        abort: () => {},
      },
      runScopedCallerKey,
    );
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "fallback-run", status: "accepted", acceptedAt: 2000 };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:re-portal:main",
      agentChannel: "telegram",
      config: {
        ...TEST_CONFIG,
        session: {
          ...TEST_CONFIG.session,
          agentToAgent: { maxPingPongTurns: 0 },
        },
      },
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-run-scoped-caller", {
      sessionKey: runScopedCallerKey,
      message: "[TASK-COMPLETE] re-portal occupancy ready",
      timeoutSeconds: 0,
    });

    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("error");
    expect(details.sessionKey).toBe(runScopedCallerKey);
    expect(details.error).toContain(
      "queue_message_failed reason=source_reply_delivery_mode_mismatch",
    );
    expect(queueMessage).not.toHaveBeenCalled();
    expect(calls.some((call) => call.method === "agent")).toBe(false);
  });

  it("sessions_send keeps ordinary active session targets on the gateway agent path", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const ordinaryActiveKey = "agent:main:main";
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "ordinary-active-session",
      {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        supportsTranscriptCommitWait: true,
        sourceReplyDeliveryMode: "automatic",
        abort: () => {},
      },
      ordinaryActiveKey,
    );
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "ordinary-agent-run", status: "accepted", acceptedAt: 2000 };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:re-portal:main",
      agentChannel: "telegram",
      config: {
        ...TEST_CONFIG,
        session: {
          ...TEST_CONFIG.session,
          agentToAgent: { maxPingPongTurns: 0 },
        },
      },
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-ordinary-active", {
      sessionKey: ordinaryActiveKey,
      message: "ordinary active target should stay gateway routed",
      timeoutSeconds: 0,
    });

    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("accepted");
    expect(details.runId).toBe("ordinary-agent-run");
    expect(details.sessionKey).toBe(ordinaryActiveKey);
    expect(queueMessage).not.toHaveBeenCalled();
    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(1);
    expect(agentParams(agentCalls[0] ?? {}).sessionKey).toBe(ordinaryActiveKey);
  });

  it("sessions_send falls back from stranded cron run key to durable cron parent", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const runScopedCallerKey = "agent:leasing-ops:cron:monthly-utility:run:run-fast";
    const durableCronCallerKey = "agent:leasing-ops:cron:monthly-utility";
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "caller-active-session",
      {
        queueMessage,
        isStreaming: () => false,
        isCompacting: () => false,
        supportsTranscriptCommitWait: true,
        sourceReplyDeliveryMode: "message_tool_only",
        abort: () => {},
      },
      runScopedCallerKey,
    );
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "durable-fallback-run", status: "accepted", acceptedAt: 2000 };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:re-portal:main",
      agentChannel: "telegram",
      config: {
        ...TEST_CONFIG,
        session: {
          ...TEST_CONFIG.session,
          agentToAgent: { maxPingPongTurns: 0 },
        },
      },
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-run-scoped-caller", {
      sessionKey: runScopedCallerKey,
      message: "[TASK-COMPLETE] re-portal occupancy ready",
      timeoutSeconds: 0,
    });

    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("accepted");
    expect(details.runId).toBe("durable-fallback-run");
    expect(details.sessionKey).toBe(runScopedCallerKey);
    expect(queueMessage).not.toHaveBeenCalled();
    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(1);
    const params = agentParams(agentCalls[0] ?? {});
    expect(params.sessionKey).toBe(durableCronCallerKey);
    expect(params.message).toContain("[Inter-session message]");
    expect(params.message).toContain("[TASK-COMPLETE] re-portal occupancy ready");
  });

  it("sessions_send rejects non-cron run-looking keys without durable-session fallback", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const runScopedCallerKey = "agent:leasing-ops:slack:channel:c-room:run:run-fast";
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "caller-active-session",
      {
        queueMessage,
        isStreaming: () => false,
        isCompacting: () => false,
        supportsTranscriptCommitWait: true,
        sourceReplyDeliveryMode: "message_tool_only",
        abort: () => {},
      },
      runScopedCallerKey,
    );
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "durable-fallback-run", status: "accepted", acceptedAt: 2000 };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:re-portal:main",
      agentChannel: "telegram",
      config: {
        ...TEST_CONFIG,
        session: {
          ...TEST_CONFIG.session,
          agentToAgent: { maxPingPongTurns: 0 },
        },
      },
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-run-scoped-caller", {
      sessionKey: runScopedCallerKey,
      message: "[TASK-COMPLETE] re-portal occupancy ready",
      timeoutSeconds: 0,
    });

    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("error");
    expect(details.sessionKey).toBe(runScopedCallerKey);
    expect(details.error).toContain("queue_message_failed reason=not_streaming");
    expect(queueMessage).not.toHaveBeenCalled();
    expect(calls.some((call) => call.method === "agent")).toBe(false);
  });

  it("sessions_send preserves active delivery when transcript commit wait is unsupported", async () => {
    const calls: Array<{ method?: string }> = [];
    const runScopedCallerKey = "agent:leasing-ops:cron:monthly-utility:run:run-fast";
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "caller-active-session",
      {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        sourceReplyDeliveryMode: "message_tool_only",
        abort: () => {},
      },
      runScopedCallerKey,
    );
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      calls.push(request);
      if (request.method === "agent") {
        throw new Error("fallback agent should not start");
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:re-portal:main",
      agentChannel: "telegram",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-run-scoped-caller", {
      sessionKey: runScopedCallerKey,
      message: "[TASK-COMPLETE] re-portal occupancy ready",
      timeoutSeconds: 0,
    });

    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("accepted");
    expect(details.sessionKey).toBe(runScopedCallerKey);
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(queueMessage).toHaveBeenCalledWith(expect.stringContaining("[Inter-session message]"), {
      steeringMode: "all",
      debounceMs: 0,
      deliveryTimeoutMs: 30_000,
      sourceReplyDeliveryMode: "message_tool_only",
    });
    expect(calls.some((call) => call.method === "agent")).toBe(false);
  });

  it("sessions_send reports run-scoped queue admission failures without gateway fallback", async () => {
    const runScopedCallerKey = "agent:leasing-ops:cron:monthly-utility:run:run-fast";
    const queueMessage = vi.fn(async () => {
      throw new Error("active session ended before queued steering message was committed");
    });
    setActiveEmbeddedRun(
      "caller-active-session",
      {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        supportsTranscriptCommitWait: true,
        sourceReplyDeliveryMode: "message_tool_only",
        abort: () => {},
      },
      runScopedCallerKey,
    );
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      if (request.method === "agent") {
        throw new Error("gateway request timeout for agent");
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:re-portal:main",
      agentChannel: "telegram",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-run-scoped-caller", {
      sessionKey: runScopedCallerKey,
      message: "[TASK-COMPLETE] re-portal occupancy ready",
      timeoutSeconds: 0,
    });

    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("error");
    expect(details.sessionKey).toBe(runScopedCallerKey);
    expect(details.error).toContain("queue_message_failed reason=runtime_rejected");
    expect(details.error).not.toContain("fallback_failed");
    expect(
      callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string } | undefined)?.method === "agent",
      ),
    ).toBe(false);
  });

  it("sessions_send preserves terminal timeouts without starting A2A", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const requesterKey = "agent:main:main";
    const targetKey = "agent:director1:main";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "run-terminal", status: "accepted", acceptedAt: 2000 };
      }
      if (request.method === "agent.wait") {
        return {
          runId: "run-terminal",
          status: "timeout",
          endedAt: 3000,
          stopReason: "timeout",
          error: "agent run timed out",
        };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });

    const tool = createTestTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-terminal", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });
    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("timeout");
    expect(details.error).toBe("agent run timed out");
    expect(details.sentBeforeError).toBe(true);
    expect(details.sessionKey).toBe(targetKey);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(countMatching(calls, (call) => call.method === "agent")).toBe(1);
  });

  it("sessions_send preserves delivery evidence for post-start agent errors", async () => {
    const targetKey = "agent:director1:main";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-error", status: "accepted", acceptedAt: 2000 };
      }
      if (request.method === "agent.wait") {
        return { runId: "run-error", status: "error", error: "agent failed" };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-error", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });
    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("error");
    expect(details.error).toBe("agent failed");
    expect(details.sentBeforeError).toBe(true);
    expect(details.sessionKey).toBe(targetKey);
  });

  it("sessions_send skips duplicate A2A delivery for waited parent-owned native subagents", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const requesterKey = "agent:main:discord:direct:parent";
    const targetKey = "agent:main:subagent:child";
    let historyCallCount = 0;
    loadSessionEntryByKeyMock.mockImplementation((sessionKey: string) =>
      sessionKey === targetKey
        ? {
            sessionId: "child-session",
            updatedAt: 1,
            spawnedBy: requesterKey,
            deliveryContext: {
              channel: "discord",
              to: "direct:parent",
            },
          }
        : undefined,
    );
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "run-child", status: "accepted", acceptedAt: 2000 };
      }
      if (request.method === "agent.wait") {
        return { runId: "run-child", status: "ok" };
      }
      if (request.method === "chat.history") {
        historyCallCount += 1;
        return {
          messages:
            historyCallCount === 1
              ? []
              : [
                  {
                    role: "assistant",
                    content: [{ type: "text", text: "child reply" }],
                    timestamp: 20,
                  },
                ],
        };
      }
      return {};
    });

    const tool = createTestTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const waited = await tool.execute("call-parent-owned-native-subagent", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });

    const waitedDetails = sessionsSendDetails(waited.details);
    expect(waitedDetails.status).toBe("ok");
    expect(waitedDetails.reply).toBe("child reply");
    expect(waitedDetails.delivery?.status).toBe("skipped");
    expect(waitedDetails.delivery?.mode).toBe("announce");
    expect(countMatching(calls, (call) => call.method === "agent")).toBe(1);
    const replyPromptAgentCalls = calls.filter(
      (call) =>
        call.method === "agent" &&
        typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
        (call.params as { extraSystemPrompt?: string }).extraSystemPrompt?.includes(
          "Agent-to-agent reply step",
        ),
    );
    expect(replyPromptAgentCalls).toStrictEqual([]);
    expect(calls.some((call) => call.method === "send")).toBe(false);
  });

  it("sessions_send preserves threadId when announce target is hydrated via sessions.list", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    const requesterKey = "discord:group:req";
    const targetKey = "agent:main:worker";
    let sendParams: {
      to?: string;
      channel?: string;
      accountId?: string;
      message?: string;
      threadId?: string;
    } = {};

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as
          | {
              sessionKey?: string;
              extraSystemPrompt?: string;
            }
          | undefined;
        let reply = "initial";
        if (params?.extraSystemPrompt?.includes("Agent-to-agent reply step")) {
          reply = params.sessionKey === requesterKey ? "pong-1" : "pong-2";
        }
        if (params?.extraSystemPrompt?.includes("Agent-to-agent announce step")) {
          reply = "announce now";
        }
        replyByRunId.set(runId, reply);
        return {
          runId,
          status: "accepted",
          acceptedAt: 3000 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text }],
              timestamp: 20,
            },
          ],
        };
      }
      if (request.method === "sessions.list") {
        return {
          sessions: [
            {
              key: targetKey,
              deliveryContext: {
                channel: "whatsapp",
                to: "123@g.us",
                accountId: "work",
                threadId: 99,
              },
            },
          ],
        };
      }
      if (request.method === "send") {
        const params = request.params as
          | {
              to?: string;
              channel?: string;
              accountId?: string;
              message?: string;
              threadId?: string;
            }
          | undefined;
        sendParams = {
          to: params?.to,
          channel: params?.channel,
          accountId: params?.accountId,
          message: params?.message,
          threadId: params?.threadId,
        };
        return { messageId: "m-threaded-announce" };
      }
      return {};
    });
    agentStepTesting.setDepsForTest({
      agentCommandFromIngress: async () => ({
        payloads: [{ text: "announce now", mediaUrl: null }],
        meta: { durationMs: 1 },
      }),
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });

    const tool = createTestTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const waited = await tool.execute("call-thread", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });
    const waitedDetails = sessionsSendDetails(waited.details);
    expect(waitedDetails.status).toBe("ok");
    expect(waitedDetails.reply).toBe("initial");
    await vi.waitFor(
      () => {
        expect(countMatching(calls, (call) => call.method === "send")).toBe(1);
      },
      { timeout: 2_000, interval: 5 },
    );

    expect(sendParams.to).toBe("123@g.us");
    expect(sendParams.channel).toBe("whatsapp");
    expect(sendParams.accountId).toBe("work");
    expect(sendParams.message).toBe("announce now");
    expect(sendParams.threadId).toBe("99");
  });

  it("subagents lists active and recent runs", async () => {
    resetSubagentRegistryForTests();
    const now = Date.now();
    addSubagentRunForTests({
      runId: "run-active",
      childSessionKey: "agent:main:subagent:active",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "investigate auth",
      cleanup: "keep",
      createdAt: now - 2 * 60_000,
      startedAt: now - 2 * 60_000,
    });
    addSubagentRunForTests({
      runId: "run-child",
      childSessionKey: "agent:main:subagent:active:subagent:child",
      requesterSessionKey: "agent:main:subagent:active",
      requesterDisplayKey: "subagent:active",
      task: "child worker",
      cleanup: "keep",
      createdAt: now - 60_000,
      startedAt: now - 60_000,
    });
    addSubagentRunForTests({
      runId: "run-recent",
      childSessionKey: "agent:main:subagent:recent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "summarize findings",
      cleanup: "keep",
      createdAt: now - 15 * 60_000,
      startedAt: now - 14 * 60_000,
      endedAt: now - 5 * 60_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-old",
      childSessionKey: "agent:main:subagent:old",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old completed run",
      cleanup: "keep",
      createdAt: now - 90 * 60_000,
      startedAt: now - 89 * 60_000,
      endedAt: now - 80 * 60_000,
      outcome: { status: "ok" },
    });

    const tool = createTestTools({
      agentSessionKey: "agent:main:main",
    }).find((candidate) => candidate.name === "subagents");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing subagents tool");
    }

    const result = await tool.execute("call-subagents-list", { action: "list" });
    const details = result.details as {
      status?: string;
      active?: Array<{ runId?: string; childSessions?: string[] }>;
      recent?: unknown[];
      text?: string;
    };
    expect(details.status).toBe("ok");
    expect(details.active).toHaveLength(1);
    expect(details.active?.[0]).toMatchObject({
      runId: "run-active",
      childSessions: ["agent:main:subagent:active:subagent:child"],
    });
    expect(details.recent).toHaveLength(1);
    expect(details.text).toContain("active subagents:");
    expect(details.text).toContain("recent (last 30m):");
  });

  it("subagents list keeps ended orchestrators active while descendants are pending", async () => {
    resetSubagentRegistryForTests();
    const now = Date.now();
    addSubagentRunForTests({
      runId: "run-orchestrator-ended",
      childSessionKey: "agent:main:subagent:orchestrator-ended",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrate child workers",
      cleanup: "keep",
      createdAt: now - 5 * 60_000,
      startedAt: now - 5 * 60_000,
      endedAt: now - 4 * 60_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-orchestrator-child-active",
      childSessionKey: "agent:main:subagent:orchestrator-ended:subagent:child",
      requesterSessionKey: "agent:main:subagent:orchestrator-ended",
      requesterDisplayKey: "subagent:orchestrator-ended",
      task: "child worker still running",
      cleanup: "keep",
      createdAt: now - 60_000,
      startedAt: now - 60_000,
    });

    const tool = createTestTools({
      agentSessionKey: "agent:main:main",
    }).find((candidate) => candidate.name === "subagents");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing subagents tool");
    }

    const result = await tool.execute("call-subagents-list-orchestrator", { action: "list" });
    const details = result.details as {
      status?: string;
      active?: Array<{ runId?: string; status?: string; pendingDescendants?: number }>;
      recent?: Array<{ runId?: string }>;
      text?: string;
    };

    expect(details.status).toBe("ok");
    expect(details.active).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-orchestrator-ended",
          status: "active (waiting on 1 child)",
          pendingDescendants: 1,
        }),
      ]),
    );
    expect(details.recent?.find((entry) => entry.runId === "run-orchestrator-ended")).toBeFalsy();
    expect(details.text).toContain("active (waiting on 1 child)");
  });

  it("subagents list does not double-count restarted descendants on one child session", async () => {
    resetSubagentRegistryForTests();
    const now = Date.now();
    const parentKey = "agent:main:subagent:orchestrator-restarted-child";
    const childKey = `${parentKey}:subagent:worker`;
    addSubagentRunForTests({
      runId: "run-orchestrator-ended-restarted",
      childSessionKey: parentKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrate restarted child worker",
      cleanup: "keep",
      createdAt: now - 5 * 60_000,
      startedAt: now - 5 * 60_000,
      endedAt: now - 4 * 60_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-restarted-child-stale",
      childSessionKey: childKey,
      requesterSessionKey: parentKey,
      requesterDisplayKey: parentKey,
      task: "stale child run",
      cleanup: "keep",
      createdAt: now - 90_000,
      startedAt: now - 90_000,
      endedAt: now - 70_000,
      cleanupCompletedAt: undefined,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-restarted-child-current",
      childSessionKey: childKey,
      requesterSessionKey: parentKey,
      requesterDisplayKey: parentKey,
      task: "current child run",
      cleanup: "keep",
      createdAt: now - 60_000,
      startedAt: now - 60_000,
    });

    const tool = createTestTools({
      agentSessionKey: "agent:main:main",
    }).find((candidate) => candidate.name === "subagents");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing subagents tool");
    }

    const result = await tool.execute("call-subagents-list-restarted-child", { action: "list" });
    const details = result.details as {
      status?: string;
      active?: Array<{ runId?: string; status?: string; pendingDescendants?: number }>;
      text?: string;
    };

    expect(details.status).toBe("ok");
    expect(details.active).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-orchestrator-ended-restarted",
          status: "active (waiting on 1 child)",
          pendingDescendants: 1,
        }),
      ]),
    );
    expect(details.text).toContain("active (waiting on 1 child)");
    expect(details.text).not.toContain("active (waiting on 2 children)");
  });

  it("subagents list does not keep childSessions attached to a stale older parent", async () => {
    resetSubagentRegistryForTests();
    const now = Date.now();
    const oldParentKey = "agent:main:subagent:old-parent";
    const newParentKey = "agent:main:subagent:new-parent";
    const childKey = "agent:main:subagent:shared-child";

    addSubagentRunForTests({
      runId: "run-old-parent",
      childSessionKey: oldParentKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old parent task",
      cleanup: "keep",
      createdAt: now - 10_000,
      startedAt: now - 9_000,
    });
    addSubagentRunForTests({
      runId: "run-new-parent",
      childSessionKey: newParentKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new parent task",
      cleanup: "keep",
      createdAt: now - 8_000,
      startedAt: now - 7_000,
    });
    addSubagentRunForTests({
      runId: "run-shared-child-stale-parent",
      childSessionKey: childKey,
      requesterSessionKey: oldParentKey,
      requesterDisplayKey: oldParentKey,
      controllerSessionKey: oldParentKey,
      task: "shared child stale parent",
      cleanup: "keep",
      createdAt: now - 6_000,
      startedAt: now - 5_000,
      endedAt: now - 4_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-shared-child-current-parent",
      childSessionKey: childKey,
      requesterSessionKey: newParentKey,
      requesterDisplayKey: newParentKey,
      controllerSessionKey: newParentKey,
      task: "shared child current parent",
      cleanup: "keep",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const tool = createTestTools({
      agentSessionKey: "agent:main:main",
    }).find((candidate) => candidate.name === "subagents");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing subagents tool");
    }

    const result = await tool.execute("call-subagents-list-stale-parent", { action: "list" });
    const details = result.details as {
      status?: string;
      active?: Array<{
        runId?: string;
        childSessions?: string[];
        pendingDescendants?: number;
        status?: string;
      }>;
    };

    expect(details.status).toBe("ok");
    const oldParent = details.active?.find((entry) => entry.runId === "run-old-parent");
    const newParent = details.active?.find((entry) => entry.runId === "run-new-parent");
    expect(oldParent).toMatchObject({
      runId: "run-old-parent",
      pendingDescendants: 0,
      status: "running",
    });
    expect(oldParent?.childSessions).toBeUndefined();
    expect(newParent).toMatchObject({
      runId: "run-new-parent",
      childSessions: [childKey],
      pendingDescendants: 1,
      status: "active (waiting on 1 child)",
    });
  });

  it("subagents list dedupes stale rows for the same child session", async () => {
    resetSubagentRegistryForTests();
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:list-dedupe-worker";
    addSubagentRunForTests({
      runId: "run-list-current",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current worker label",
      cleanup: "keep",
      createdAt: now - 60_000,
      startedAt: now - 60_000,
    });
    addSubagentRunForTests({
      runId: "run-list-stale",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale worker label",
      cleanup: "keep",
      createdAt: now - 120_000,
      startedAt: now - 120_000,
      endedAt: now - 90_000,
      outcome: { status: "ok" },
    });

    const tool = createTestTools({
      agentSessionKey: "agent:main:main",
    }).find((candidate) => candidate.name === "subagents");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing subagents tool");
    }

    const result = await tool.execute("call-subagents-list-dedupe", { action: "list" });
    const details = result.details as {
      status?: string;
      total?: number;
      active?: Array<{ runId?: string }>;
      recent?: Array<{ runId?: string }>;
      text?: string;
    };

    expect(details.status).toBe("ok");
    expect(details.total).toBe(1);
    expect(details.active).toEqual([
      expect.objectContaining({
        runId: "run-list-current",
      }),
    ]);
    expect(details.recent?.find((entry) => entry.runId === "run-list-stale")).toBeFalsy();
    expect(details.text).toContain("current worker label");
    expect(details.text).not.toContain("stale worker label");
  });

  it("subagents list usage separates io tokens from prompt/cache", async () => {
    resetSubagentRegistryForTests();
    const now = Date.now();
    addSubagentRunForTests({
      runId: "run-usage-active",
      childSessionKey: "agent:main:subagent:usage-active",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "wait and check weather",
      cleanup: "keep",
      createdAt: now - 2 * 60_000,
      startedAt: now - 2 * 60_000,
    });

    const loadSessionStoreSpy = vi
      .spyOn(sessionsModule, "loadSessionStore")
      .mockImplementation(() => ({
        "agent:main:subagent:usage-active": {
          sessionId: "session-usage-active",
          updatedAt: now,
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
          inputTokens: 12,
          outputTokens: 1000,
          totalTokens: 197000,
        },
      }));

    try {
      const tool = createTestTools({
        agentSessionKey: "agent:main:main",
      }).find((candidate) => candidate.name === "subagents");
      expect(tool).toBeDefined();
      if (!tool) {
        throw new Error("missing subagents tool");
      }

      const result = await tool.execute("call-subagents-list-usage", { action: "list" });
      const details = result.details as {
        status?: string;
        text?: string;
      };
      expect(details.status).toBe("ok");
      expect(details.text).toMatch(/tokens 1(\.0)?k \(in 12 \/ out 1(\.0)?k\)/);
      expect(details.text).toContain("prompt/cache 197k");
      expect(details.text).not.toContain("1.0k io");
    } finally {
      loadSessionStoreSpy.mockRestore();
    }
  });

  it("subagents steer sends guidance to a running run", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-steer-1" };
      }
      return {};
    });
    addSubagentRunForTests({
      runId: "run-steer",
      childSessionKey: "agent:main:subagent:steer",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "prepare release notes",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });

    const loadSessionStoreSpy = vi
      .spyOn(sessionsModule, "loadSessionStore")
      .mockImplementation(() => ({
        "agent:main:subagent:steer": {
          sessionId: "child-session-steer",
          updatedAt: Date.now(),
        },
      }));

    try {
      const tool = createTestTools({
        agentSessionKey: "agent:main:main",
      }).find((candidate) => candidate.name === "subagents");
      expect(tool).toBeDefined();
      if (!tool) {
        throw new Error("missing subagents tool");
      }

      const result = await tool.execute("call-subagents-steer", {
        action: "steer",
        target: "1",
        message: "skip changelog and focus on tests",
      });
      const details = result.details as { status?: string; runId?: string; text?: string };
      expect(details.status).toBe("accepted");
      expect(details.runId).toBe("run-steer-1");
      expect(details.text).toContain("steered");
      const steerWaitIndex = callGatewayMock.mock.calls.findIndex(
        (call) =>
          (call[0] as { method?: string; params?: { runId?: string } }).method === "agent.wait" &&
          (call[0] as { method?: string; params?: { runId?: string } }).params?.runId ===
            "run-steer",
      );
      expect(steerWaitIndex).toBeGreaterThanOrEqual(0);
      const steerRunIndex = callGatewayMock.mock.calls.findIndex(
        (call) => (call[0] as { method?: string }).method === "agent",
      );
      expect(steerRunIndex).toBeGreaterThan(steerWaitIndex);
      expect(callGatewayMock.mock.calls[steerWaitIndex]?.[0]).toMatchObject({
        method: "agent.wait",
        params: { runId: "run-steer", timeoutMs: 5_000 },
        timeoutMs: 7_000,
      });
      expect(callGatewayMock.mock.calls[steerRunIndex]?.[0]).toMatchObject({
        method: "agent",
        params: {
          lane: "subagent",
          sessionKey: "agent:main:subagent:steer",
          sessionId: "child-session-steer",
          timeout: 0,
        },
      });

      const trackedRuns = listSubagentRunsForRequester("agent:main:main");
      expect(trackedRuns).toHaveLength(1);
      expect(trackedRuns[0].runId).toBe("run-steer-1");
      expect(trackedRuns[0].endedAt).toBeUndefined();
    } finally {
      loadSessionStoreSpy.mockRestore();
    }
  });

  it("subagents numeric targets follow active-first list ordering", async () => {
    resetSubagentRegistryForTests();
    addSubagentRunForTests({
      runId: "run-active",
      childSessionKey: "agent:main:subagent:active",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "active task",
      cleanup: "keep",
      createdAt: Date.now() - 120_000,
      startedAt: Date.now() - 120_000,
    });
    addSubagentRunForTests({
      runId: "run-recent",
      childSessionKey: "agent:main:subagent:recent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "recent task",
      cleanup: "keep",
      createdAt: Date.now() - 30_000,
      startedAt: Date.now() - 30_000,
      endedAt: Date.now() - 10_000,
      outcome: { status: "ok" },
    });

    const tool = createTestTools({
      agentSessionKey: "agent:main:main",
    }).find((candidate) => candidate.name === "subagents");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing subagents tool");
    }

    const result = await tool.execute("call-subagents-kill-order", {
      action: "kill",
      target: "1",
    });
    const details = result.details as { status?: string; runId?: string; text?: string };
    expect(details.status).toBe("ok");
    expect(details.runId).toBe("run-active");
    expect(details.text).toContain("killed");
  });

  it("subagents numeric targets treat ended orchestrators waiting on children as active", async () => {
    resetSubagentRegistryForTests();
    const now = Date.now();
    addSubagentRunForTests({
      runId: "run-orchestrator-ended",
      childSessionKey: "agent:main:subagent:orchestrator-ended",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrator",
      cleanup: "keep",
      createdAt: now - 90_000,
      startedAt: now - 90_000,
      endedAt: now - 60_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-leaf-active",
      childSessionKey: "agent:main:subagent:orchestrator-ended:subagent:leaf",
      requesterSessionKey: "agent:main:subagent:orchestrator-ended",
      requesterDisplayKey: "subagent:orchestrator-ended",
      task: "leaf",
      cleanup: "keep",
      createdAt: now - 30_000,
      startedAt: now - 30_000,
    });
    addSubagentRunForTests({
      runId: "run-running",
      childSessionKey: "agent:main:subagent:running",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "running",
      cleanup: "keep",
      createdAt: now - 20_000,
      startedAt: now - 20_000,
    });

    const tool = createTestTools({
      agentSessionKey: "agent:main:main",
    }).find((candidate) => candidate.name === "subagents");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing subagents tool");
    }

    const list = await tool.execute("call-subagents-list-order-waiting", {
      action: "list",
    });
    const listDetails = list.details as {
      active?: Array<{ runId?: string; status?: string }>;
    };
    expect(listDetails.active).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-orchestrator-ended",
          status: "active (waiting on 1 child)",
        }),
      ]),
    );

    const result = await tool.execute("call-subagents-kill-order-waiting", {
      action: "kill",
      target: "1",
    });
    const details = result.details as { status?: string; runId?: string };
    expect(details.status).toBe("ok");
    expect(details.runId).toBe("run-running");
  });

  it("subagents kill stops a running run", async () => {
    resetSubagentRegistryForTests();
    addSubagentRunForTests({
      runId: "run-kill",
      childSessionKey: "agent:main:subagent:kill",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "long running task",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });

    const tool = createTestTools({
      agentSessionKey: "agent:main:main",
    }).find((candidate) => candidate.name === "subagents");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing subagents tool");
    }

    const result = await tool.execute("call-subagents-kill", {
      action: "kill",
      target: "1",
    });
    const details = result.details as { status?: string; text?: string };
    expect(details.status).toBe("ok");
    expect(details.text).toContain("killed");
  });

  it("subagents kill-all cascades through ended parents to active descendants", async () => {
    resetSubagentRegistryForTests();
    const now = Date.now();
    const endedParentKey = "agent:main:subagent:parent-ended";
    const activeChildKey = "agent:main:subagent:parent-ended:subagent:worker";
    addSubagentRunForTests({
      runId: "run-parent-ended",
      childSessionKey: endedParentKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrator",
      cleanup: "keep",
      createdAt: now - 120_000,
      startedAt: now - 120_000,
      endedAt: now - 60_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-worker-active",
      childSessionKey: activeChildKey,
      requesterSessionKey: endedParentKey,
      requesterDisplayKey: endedParentKey,
      task: "leaf worker",
      cleanup: "keep",
      createdAt: now - 30_000,
      startedAt: now - 30_000,
    });

    const tool = createTestTools({
      agentSessionKey: "agent:main:main",
    }).find((candidate) => candidate.name === "subagents");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing subagents tool");
    }

    const result = await tool.execute("call-subagents-kill-all-cascade-ended", {
      action: "kill",
      target: "all",
    });
    const details = result.details as { status?: string; killed?: number; text?: string };
    expect(details.status).toBe("ok");
    expect(details.killed).toBe(1);
    expect(details.text).toContain("killed 1 subagent");

    const descendants = listSubagentRunsForRequester(endedParentKey);
    const worker = descendants.find((entry) => entry.runId === "run-worker-active");
    expect(worker?.endedAt).toBeTypeOf("number");
  });
});
