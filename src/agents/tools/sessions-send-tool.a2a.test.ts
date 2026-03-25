// sessions_send A2A tests cover announce delivery, same-session replies, delayed
// reply baselines, and channel target/account routing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { readLatestAssistantReplySnapshot, waitForAgentRun } from "../run-wait.js";
import { runAgentStep } from "./agent-step.js";
import type { SessionListRow } from "./sessions-helpers.js";
import {
  runSessionsSendA2AFlow,
  __testing as sessionsSendA2AStaticTesting,
} from "./sessions-send-tool.a2a.js";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../run-wait.js", () => ({
  waitForAgentRun: vi.fn().mockResolvedValue({ status: "ok" }),
  readLatestAssistantReplySnapshot: vi.fn().mockResolvedValue({
    text: "Test announce reply",
    fingerprint: "test-announce-reply",
  }),
}));

vi.mock("./agent-step.js", () => ({
  runAgentStep: vi.fn().mockResolvedValue("Test announce reply"),
}));

function firstMockArg(
  mock: { mock: { calls: unknown[][] } },
  label: string,
): Record<string, unknown> {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`Expected ${label} to be called`);
  }
  return call[0] as Record<string, unknown>;
}

describe("runSessionsSendA2AFlow announce delivery", () => {
  let gatewayCalls: CallGatewayOptions[];
  let sessionListRows: SessionListRow[];

  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    gatewayCalls = [];
    sessionListRows = [];
    callGatewayMock.mockReset();
    const callGateway = async <T = Record<string, unknown>>(opts: CallGatewayOptions) => {
      gatewayCalls.push(opts);
      if (opts.method === "sessions.list") {
        return { sessions: sessionListRows } as T;
      }
      return {} as T;
    };
    callGatewayMock.mockImplementation(callGateway);
    vi.clearAllMocks();
    vi.mocked(runAgentStep).mockResolvedValue("Test announce reply");
    vi.mocked(waitForAgentRun).mockResolvedValue({ status: "ok" });
    vi.mocked(readLatestAssistantReplySnapshot).mockResolvedValue({
      text: "Test announce reply",
      fingerprint: "test-announce-reply",
    });
    sessionsSendA2AStaticTesting.setDepsForTest({
      callGateway,
      runAgentStep: async (...args) => await vi.mocked(runAgentStep)(...args),
    });
  });

  function requireGatewayCall(method: string): CallGatewayOptions {
    const call = gatewayCalls.find((entry) => entry.method === method);
    if (!call) {
      throw new Error(`expected gateway call ${method}`);
    }
    return call;
  }

  afterEach(() => {
    sessionsSendA2AStaticTesting.setDepsForTest();
    vi.restoreAllMocks();
  });

  it("passes threadId through to gateway send for Telegram forum topics", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:telegram:group:-100123:topic:554",
      displayKey: "agent:main:telegram:group:-100123:topic:554",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    const sendCall = requireGatewayCall("send");
    const sendParams = sendCall.params as Record<string, unknown>;
    expect(sendParams.to).toBe("-100123");
    expect(sendParams.channel).toBe("telegram");
    expect(sendParams.threadId).toBe("554");
  });

  it("omits threadId for non-topic sessions", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    const sendCall = requireGatewayCall("send");
    const sendParams = sendCall.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.threadId).toBeUndefined();
  });

  it("bypasses the announce decider for same-session channel replies", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterChannel: "discord",
      roundOneReply: "Substantive channel reply",
    });

    expect(runAgentStep).not.toHaveBeenCalled();
    const sendCall = requireGatewayCall("send");
    const sendParams = sendCall.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.to).toBe("channel:target-room");
    expect(sendParams.message).toBe("Substantive channel reply");
  });

  it("bypasses the announce decider for delayed same-session channel replies", async () => {
    vi.mocked(readLatestAssistantReplySnapshot).mockResolvedValueOnce({
      text: "Delayed channel reply",
      fingerprint: "delayed-channel-reply",
    });

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterChannel: "discord",
      baseline: {
        text: "Previous channel reply",
        fingerprint: "previous-channel-reply",
      },
      waitRunId: "run-delayed-channel",
    });

    expect(firstMockArg(vi.mocked(waitForAgentRun), "agent run wait").runId).toBe(
      "run-delayed-channel",
    );
    expect(
      firstMockArg(vi.mocked(readLatestAssistantReplySnapshot), "assistant reply snapshot")
        .sessionKey,
    ).toBe("agent:main:discord:channel:target-room");
    expect(runAgentStep).not.toHaveBeenCalled();
    const sendCall = requireGatewayCall("send");
    const sendParams = sendCall.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.to).toBe("channel:target-room");
    expect(sendParams.message).toBe("Delayed channel reply");
  });

  it("does not direct-deliver a delayed same-session reply that matches the baseline", async () => {
    vi.mocked(readLatestAssistantReplySnapshot).mockResolvedValueOnce({
      text: "Previous channel reply",
      fingerprint: "previous-channel-reply",
    });

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterChannel: "discord",
      baseline: {
        text: "Previous channel reply",
        fingerprint: "previous-channel-reply",
      },
      waitRunId: "run-delayed-channel",
    });

    expect(firstMockArg(vi.mocked(waitForAgentRun), "agent run wait").runId).toBe(
      "run-delayed-channel",
    );
    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("does not direct-deliver a delayed same-session reply without a baseline", async () => {
    // Without a baseline fingerprint, a delayed assistant reply may be stale;
    // avoid direct delivery unless freshness is provable.
    vi.mocked(readLatestAssistantReplySnapshot).mockResolvedValueOnce({
      text: "Maybe stale channel reply",
      fingerprint: "maybe-stale-channel-reply",
    });

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterChannel: "discord",
      waitRunId: "run-delayed-channel",
    });

    expect(firstMockArg(vi.mocked(waitForAgentRun), "agent run wait").runId).toBe(
      "run-delayed-channel",
    );
    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("keeps the announce decider for same-session sends from a different channel", async () => {
    vi.mocked(runAgentStep).mockResolvedValueOnce("ANNOUNCE_SKIP");

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterChannel: "webchat",
      roundOneReply: "Substantive channel reply",
    });

    expect(runAgentStep).toHaveBeenCalledTimes(1);
    const stepInput = firstMockArg(vi.mocked(runAgentStep), "agent step");
    expect(stepInput.message).toBe("Agent-to-agent announce step.");
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it.each([
    {
      source: "deliveryContext.accountId",
      accountId: "thinker",
      session: {
        key: "agent:main:discord:channel:target-room",
        kind: "group",
        channel: "discord",
        deliveryContext: {
          channel: "discord",
          to: "channel:target-room",
          accountId: "thinker",
        },
      } satisfies SessionListRow,
    },
    {
      source: "lastAccountId",
      accountId: "scout",
      session: {
        key: "agent:main:discord:channel:target-room",
        kind: "group",
        channel: "discord",
        lastChannel: "discord",
        lastTo: "channel:target-room",
        lastAccountId: "scout",
      } satisfies SessionListRow,
    },
  ])("uses Discord session $source for announce accountId", async ({ accountId, session }) => {
    sessionListRows = [session];

    await runSessionsSendA2AFlow({
      targetSessionKey: session.key,
      displayKey: session.key,
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    requireGatewayCall("sessions.list");
    const sendCall = requireGatewayCall("send");
    const sendParams = sendCall.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.to).toBe("channel:target-room");
    expect(sendParams.accountId).toBe(accountId);
  });

  it.each(["NO_REPLY", "HEARTBEAT_OK", "ANNOUNCE_SKIP", "REPLY_SKIP"])(
    "does not re-inject exact control reply %s into agent-to-agent flow",
    async (roundOneReply) => {
      await runSessionsSendA2AFlow({
        targetSessionKey: "agent:main:discord:group:dev",
        displayKey: "agent:main:discord:group:dev",
        message: "Test message",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 2,
        requesterSessionKey: "agent:main:discord:group:req",
        requesterChannel: "discord",
        roundOneReply,
      });

      expect(runAgentStep).not.toHaveBeenCalled();
      expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
    },
  );

  it("does not inject a delayed reply that matches the baseline", async () => {
    vi.mocked(readLatestAssistantReplySnapshot).mockResolvedValueOnce({
      text: "same reply",
      fingerprint: "same-reply",
    });

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:group:req",
      requesterChannel: "discord",
      baseline: {
        text: "same reply",
        fingerprint: "same-reply",
      },
      waitRunId: "run-delayed",
    });

    expect(firstMockArg(vi.mocked(waitForAgentRun), "agent run wait").runId).toBe("run-delayed");
    expect(
      firstMockArg(vi.mocked(readLatestAssistantReplySnapshot), "assistant reply snapshot")
        .sessionKey,
    ).toBe("agent:main:discord:group:dev");
    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it.each(["NO_REPLY", "HEARTBEAT_OK", "ANNOUNCE_SKIP"])(
    "suppresses exact announce control reply %s before channel delivery",
    async (announceReply) => {
      vi.mocked(runAgentStep).mockResolvedValueOnce(announceReply);

      await runSessionsSendA2AFlow({
        targetSessionKey: "agent:main:discord:group:dev",
        displayKey: "agent:main:discord:group:dev",
        message: "Test message",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        roundOneReply: "Worker completed successfully",
      });

      const stepInput = firstMockArg(vi.mocked(runAgentStep), "agent step");
      expect(stepInput.message).toBe("Agent-to-agent announce step.");
      expect(stepInput.transcriptMessage).toBe("");
      expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
    },
  );
});

const dynamicCallGatewayMock = vi.fn();
const runAgentStepMock = vi.fn();
let announceTargetTesting: (typeof import("./sessions-announce-target.js"))["__testing"];
let resolveAnnounceTarget: (typeof import("./sessions-announce-target.js"))["resolveAnnounceTarget"];
let sessionsSendA2ADynamicTesting: (typeof import("./sessions-send-tool.a2a.js"))["__testing"];
let runSessionsSendA2AFlowDynamic: (typeof import("./sessions-send-tool.a2a.js"))["runSessionsSendA2AFlow"];

async function loadFreshModules() {
  vi.resetModules();
  vi.doMock("../../gateway/call.js", () => ({
    callGateway: (opts: unknown) => dynamicCallGatewayMock(opts),
  }));
  vi.doMock("./agent-step.js", () => ({
    readLatestAssistantReply: vi.fn(),
    runAgentStep: (...args: unknown[]) => runAgentStepMock(...args),
  }));
  ({ __testing: announceTargetTesting, resolveAnnounceTarget } =
    await import("./sessions-announce-target.js"));
  ({
    __testing: sessionsSendA2ADynamicTesting,
    runSessionsSendA2AFlow: runSessionsSendA2AFlowDynamic,
  } = await import("./sessions-send-tool.a2a.js"));
}

describe("sessions-send-tool.a2a announce target injection", () => {
  beforeEach(async () => {
    dynamicCallGatewayMock.mockReset();
    runAgentStepMock.mockReset();
    setActivePluginRegistry(createTestRegistry([]));
    await loadFreshModules();
    sessionsSendA2ADynamicTesting.setDepsForTest();
    announceTargetTesting.setDepsForTest();
  });

  it("uses the injected announce target resolver instead of the built-in resolver", async () => {
    const resolveAnnounceTargetMock = vi.fn(async () => ({
      channel: "discord",
      to: "group:dev",
      accountId: "default",
      threadId: "7",
    }));

    sessionsSendA2ADynamicTesting.setDepsForTest({
      callGateway: async (opts) => await dynamicCallGatewayMock(opts),
      resolveAnnounceTarget: resolveAnnounceTargetMock,
      runAgentStep: async (...args) => await runAgentStepMock(...args),
    });
    dynamicCallGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "send") {
        return { messageId: "msg-1" };
      }
      throw new Error(`unexpected gateway call: ${request.method ?? "unknown"}`);
    });
    runAgentStepMock.mockResolvedValue("announce payload");

    await runSessionsSendA2AFlowDynamic({
      targetSessionKey: "agent:main:main",
      displayKey: "agent:main:main",
      message: "hello",
      announceTimeoutMs: 1_000,
      maxPingPongTurns: 0,
      roundOneReply: "round one reply",
    });

    expect(resolveAnnounceTargetMock).toHaveBeenCalledTimes(1);
    expect(resolveAnnounceTargetMock).toHaveBeenCalledWith(
      {
        sessionKey: "agent:main:main",
        displayKey: "agent:main:main",
      },
      {
        callGateway: expect.any(Function),
      },
    );
    expect(dynamicCallGatewayMock).toHaveBeenCalledTimes(1);
    expect(dynamicCallGatewayMock).toHaveBeenCalledWith({
      method: "send",
      params: {
        to: "group:dev",
        message: "announce payload",
        channel: "discord",
        accountId: "default",
        threadId: "7",
        idempotencyKey: expect.any(String),
      },
      timeoutMs: 10_000,
    });
  });

  it("hydrates announce targets through the injected callGateway dependency", async () => {
    setActivePluginRegistry(
      createTestRegistry([
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
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({}),
            },
          },
        },
      ]),
    );

    announceTargetTesting.setDepsForTest({
      callGateway: async (opts) => await dynamicCallGatewayMock(opts),
    });
    dynamicCallGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:main:whatsapp:group:123@g.us",
          deliveryContext: {
            channel: "whatsapp",
            to: "123@g.us",
            accountId: "work",
            threadId: 42,
          },
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      displayKey: "agent:main:whatsapp:group:123@g.us",
    });

    expect(target).toEqual({
      channel: "whatsapp",
      to: "123@g.us",
      accountId: "work",
      threadId: "42",
    });
    expect(dynamicCallGatewayMock).toHaveBeenCalledTimes(1);
    expect(dynamicCallGatewayMock).toHaveBeenCalledWith({
      method: "sessions.list",
      params: {
        includeGlobal: true,
        includeUnknown: true,
        limit: 200,
      },
    });
  });
});
