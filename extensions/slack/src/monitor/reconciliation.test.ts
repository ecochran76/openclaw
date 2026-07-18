import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSlackRuntime } from "../runtime.js";
import {
  readSlackAdmissionRecords,
  recordSlackAdmission,
  SLACK_ADMISSION_LEDGER_NAMESPACE,
} from "./admission-ledger.js";
import type { SlackMonitorContext } from "./context.js";
import { clearSlackInboundDeliveryStateForTest } from "./inbound-delivery-state.js";
import {
  ensureSlackReconciliationChannelState,
  readSlackReconciliationState,
  writeSlackReconciliationState,
} from "./reconciliation-state.js";
import { startSlackHistoryReconciliation } from "./reconciliation.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const tempDirs: string[] = [];

async function makeStateDir() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slack-reconcile-"));
  tempDirs.push(stateDir);
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return stateDir;
}

function makeContext(params?: {
  history?: ReturnType<typeof vi.fn>;
  replies?: ReturnType<typeof vi.fn>;
  list?: ReturnType<typeof vi.fn>;
  usergroupsUsersList?: ReturnType<typeof vi.fn>;
  isChannelAllowed?: boolean;
}): SlackMonitorContext {
  const history = params?.history ?? vi.fn().mockResolvedValue({ messages: [] });
  const replies = params?.replies ?? vi.fn().mockResolvedValue({ messages: [] });
  const list = params?.list;
  const usergroupsUsersList =
    params?.usergroupsUsersList ?? vi.fn().mockResolvedValue({ ok: true, users: [] });
  return {
    cfg: {},
    accountId: "work",
    botToken: "xoxb-token",
    app: {
      client: {
        conversations: {
          history,
          replies,
          ...(list ? { list } : {}),
        },
        usergroups: {
          users: {
            list: usergroupsUsersList,
          },
        },
      },
    },
    runtime: { log: vi.fn(), error: vi.fn() },
    botUserId: "UBOT",
    botId: "BBOT",
    teamId: "T1",
    apiAppId: "A1",
    historyLimit: 0,
    dmHistoryLimit: 0,
    channelHistories: new Map(),
    sessionScope: "per-sender",
    mainKey: "main",
    dmEnabled: true,
    dmPolicy: "open",
    allowFrom: ["*"],
    allowNameMatching: false,
    groupDmEnabled: false,
    groupDmChannels: [],
    defaultRequireMention: true,
    channelsConfig: { C123: { enabled: true, requireMention: true } },
    channelsConfigKeys: ["C123"],
    groupPolicy: "open",
    useAccessGroups: true,
    reactionMode: "own",
    reactionAllowlist: [],
    replyToMode: "off",
    threadHistoryScope: "thread",
    threadInheritParent: false,
    threadRequireExplicitMention: false,
    slashCommand: {
      enabled: true,
      command: "/openclaw",
      requireMention: false,
      allowInThreads: true,
      allowInChannels: true,
      allowInDms: true,
      statusCommand: "/agentstatus",
      statusEnabled: true,
    },
    textLimit: 4000,
    ackReactionScope: "group-mentions",
    typingReaction: "",
    mediaMaxBytes: 1024,
    removeAckAfterReply: false,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    markMessageSeen: vi.fn(() => true),
    releaseSeenMessage: vi.fn(),
    shouldDropMismatchedSlackEvent: vi.fn(() => false),
    resolveSlackSystemEventSessionKey: vi.fn(() => "main"),
    isChannelAllowed: vi.fn(() => params?.isChannelAllowed ?? true),
    resolveChannelName: vi.fn().mockResolvedValue({ name: "ask-lei", type: "channel" }),
    resolveUserName: vi.fn().mockResolvedValue({ name: "Ada" }),
    setSlackThreadStatus: vi.fn().mockResolvedValue(undefined),
    getSlackAssistantThreadContext: vi.fn(() => undefined),
    saveSlackAssistantThreadContext: vi.fn(),
    setSlackAssistantSuggestedPrompts: vi.fn().mockResolvedValue(false),
  } as unknown as SlackMonitorContext;
}

beforeEach(async () => {
  resetPluginStateStoreForTests();
  clearSlackInboundDeliveryStateForTest();
  await makeStateDir();
  setSlackRuntime({
    state: {
      openKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("slack", { ...options, env: process.env }),
    },
  } as never);
});

afterEach(async () => {
  setSlackRuntime(null as never);
  resetPluginStateStoreForTests();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

describe("startSlackHistoryReconciliation", () => {
  it("does not start history reconciliation when the monitor is already aborted", async () => {
    const history = vi.fn().mockResolvedValue({ messages: [] });
    const ctx = makeContext({ history });
    const abortController = new AbortController();
    abortController.abort();

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
      abortSignal: abortController.signal,
    });
    await controller.runOnce();

    expect(history).not.toHaveBeenCalled();
  });

  it("does not auto-recover after stop while history is in flight", async () => {
    let resolveHistory!: (value: {
      messages: Array<Record<string, unknown>>;
      response_metadata?: { next_cursor?: string };
    }) => void;
    const history = vi.fn(
      () =>
        new Promise<{
          messages: Array<Record<string, unknown>>;
          response_metadata?: { next_cursor?: string };
        }>((resolve) => {
          resolveHistory = resolve;
        }),
    );
    const ctx = makeContext({ history });
    const handleSlackMessage = vi.fn().mockResolvedValue(undefined);
    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, autoRecover: true },
      handleSlackMessage,
      hasInboundDelivery: vi.fn().mockResolvedValue(true),
    });
    await vi.waitFor(() => {
      expect(history).toHaveBeenCalledTimes(1);
    });

    controller.stop();
    resolveHistory({
      messages: [
        {
          type: "message",
          channel: "C123",
          ts: "1780182187.975600",
          user: "U1",
          text: "<@UBOT> do not replay after stop",
        },
      ],
      response_metadata: { next_cursor: "next-page" },
    });
    await controller.runOnce();

    expect(history).toHaveBeenCalledTimes(1);
    expect(handleSlackMessage).not.toHaveBeenCalled();
  });

  it("does not request another channel-list page after stop", async () => {
    let resolveList!: (value: {
      channels: Array<{ id: string; is_archived: boolean }>;
      response_metadata: { next_cursor: string };
    }) => void;
    const list = vi.fn(
      () =>
        new Promise<{
          channels: Array<{ id: string; is_archived: boolean }>;
          response_metadata: { next_cursor: string };
        }>((resolve) => {
          resolveList = resolve;
        }),
    );
    const history = vi.fn().mockResolvedValue({ messages: [] });
    const handleSlackMessage = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ list, history });
    ctx.channelsConfig = {
      C123: { enabled: true, requireMention: true },
      "*": { enabled: true, requireMention: true },
    };
    ctx.dmEnabled = false;

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, autoRecover: true },
      handleSlackMessage,
    });
    await vi.waitFor(() => {
      expect(list).toHaveBeenCalledTimes(1);
    });

    controller.stop();
    resolveList({
      channels: [{ id: "C123", is_archived: false }],
      response_metadata: { next_cursor: "next-page" },
    });
    await controller.runOnce();

    expect(list).toHaveBeenCalledTimes(1);
    expect(history).not.toHaveBeenCalled();
    expect(handleSlackMessage).not.toHaveBeenCalled();
  });

  it("finishes replay delivery bookkeeping when stopped after dispatch starts", async () => {
    let finishDispatch!: () => void;
    const handleSlackMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDispatch = resolve;
        }),
    );
    const hasInboundDelivery = vi.fn().mockResolvedValue(true);
    const controller = startSlackHistoryReconciliation({
      ctx: makeContext({
        history: vi.fn().mockResolvedValue({
          messages: [
            {
              type: "message",
              channel: "C123",
              ts: "1780182187.975601",
              user: "U1",
              text: "<@UBOT> finish replay bookkeeping",
            },
          ],
        }),
      }),
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, autoRecover: true },
      handleSlackMessage,
      hasInboundDelivery,
    });
    await vi.waitFor(() => {
      expect(handleSlackMessage).toHaveBeenCalledTimes(1);
    });

    controller.stop();
    finishDispatch();
    await controller.runOnce();

    expect(hasInboundDelivery).toHaveBeenCalledTimes(1);
    expect(await readSlackAdmissionRecords({ accountId: "work" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "replay-dispatched",
          reason: "history-reconcile-dispatched",
        }),
      ]),
    );
  });

  it("skips replay when admission state is unavailable", async () => {
    setSlackRuntime({
      state: {
        openKeyedStore: <T>(options: OpenKeyedStoreOptions) => {
          if (options.namespace === SLACK_ADMISSION_LEDGER_NAMESPACE) {
            throw new Error("state unavailable");
          }
          return createPluginStateKeyedStoreForTests<T>("slack", {
            ...options,
            env: process.env,
          });
        },
      },
    } as never);
    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          channel: "C123",
          ts: "1780182187.975599",
          user: "U1",
          text: "<@UBOT> please recover",
        },
      ],
    });
    const ctx = makeContext({ history });
    const handleSlackMessage = vi.fn().mockResolvedValue(undefined);

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, autoRecover: true },
      handleSlackMessage,
    });
    await vi.waitFor(() => {
      expect(ctx.runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("admission state unavailable"),
      );
    });
    controller.stop();

    expect(history).not.toHaveBeenCalled();
    expect(handleSlackMessage).not.toHaveBeenCalled();
  });

  it("records eligible missing mentions without replaying when auto recovery is disabled", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          channel: "C123",
          ts: "1780182187.975599",
          user: "U1",
          text: "openclaw ping <@UBOT>",
          client_msg_id: "client-1",
        },
      ],
    });
    const ctx = makeContext({ history });
    const status: Record<string, unknown> = {};
    const handleSlackMessage = vi.fn().mockResolvedValue(undefined);

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, autoRecover: false },
      handleSlackMessage,
      setStatus: (patch) => Object.assign(status, patch),
    });
    await vi.waitFor(() => {
      expect(
        (status.reconciliationStatus as { missingCandidates?: number }).missingCandidates,
      ).toBe(1);
    });
    controller.stop();

    expect(handleSlackMessage).not.toHaveBeenCalled();
    const state = await readSlackReconciliationState({ accountId: "work" });
    const candidate = state.candidates["C123:1780182187.975599"];
    expect(candidate).toMatchObject({
      channel: "C123",
      ts: "1780182187.975599",
      user: "U1",
      clientMsgId: "client-1",
      status: "missing-admission",
      reason: "eligible-missing-admission",
    });
    expect(candidate).not.toHaveProperty("text");
    expect(candidate.textHash).toEqual(expect.any(String));
    expect(history).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        inclusive: true,
      }),
    );
  });

  it("replays eligible missing mentions through the normal Slack message handler when enabled", async () => {
    const message = {
      type: "message",
      channel: "C123",
      ts: "1780182188.000001",
      user: "U1",
      text: "<@UBOT> please check",
    };
    const ctx = makeContext({
      history: vi.fn().mockResolvedValue({ messages: [message] }),
    });
    const status: Record<string, unknown> = {};
    const handleSlackMessage = vi.fn().mockResolvedValue(undefined);

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, autoRecover: true },
      handleSlackMessage,
      hasInboundDelivery: vi.fn().mockResolvedValue(true),
      setStatus: (patch) => Object.assign(status, patch),
    });
    await vi.waitFor(() => {
      expect(
        (status.reconciliationStatus as { recoveredCandidates?: number }).recoveredCandidates,
      ).toBe(1);
    });
    controller.stop();

    expect(handleSlackMessage).toHaveBeenCalledWith(message, {
      source: "history_reconcile",
      wasMentioned: true,
      awaitDispatch: true,
    });
    const state = await readSlackReconciliationState({ accountId: "work" });
    expect(state.candidates["C123:1780182188.000001"]).toMatchObject({
      status: "replayed",
      reason: "history-reconcile-dispatched",
    });
  });

  it("does not replay messages already recovered in the admission ledger", async () => {
    await recordSlackAdmission({
      accountId: "work",
      message: {
        type: "message",
        channel: "C123",
        ts: "1780182188.000003",
        user: "U1",
        text: "<@UBOT> already recovered",
      },
      source: "history_reconcile",
      outcome: "replay-dispatched",
      reason: "history-reconcile-dispatched",
      env: process.env,
    });
    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          channel: "C123",
          ts: "1780182188.000003",
          user: "U1",
          text: "<@UBOT> already recovered",
        },
      ],
    });
    const ctx = makeContext({ history });
    const handleSlackMessage = vi.fn().mockResolvedValue(undefined);

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, autoRecover: true },
      handleSlackMessage,
      hasInboundDelivery: vi.fn().mockResolvedValue(false),
    });
    await vi.waitFor(async () => {
      const state = await readSlackReconciliationState({ accountId: "work" });
      expect(state.candidates["C123:1780182188.000003"]).toMatchObject({
        status: "already-recorded",
        reason: "admission-ledger:replay-dispatched",
      });
    });
    controller.stop();

    expect(handleSlackMessage).not.toHaveBeenCalled();
  });

  it("records Slack Web API errors in reconciliation status without throwing", async () => {
    const error = Object.assign(new Error("not_in_channel"), {
      data: { error: "not_in_channel" },
    });
    const ctx = makeContext({
      history: vi.fn().mockRejectedValue(error),
    });
    const status: Record<string, unknown> = {};

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
      setStatus: (patch) => Object.assign(status, patch),
    });
    await vi.waitFor(() => {
      const reconciliationStatus = status.reconciliationStatus as {
        lastApiError?: { code?: string; channel?: string };
      };
      expect(reconciliationStatus.lastApiError).toMatchObject({
        code: "not_in_channel",
        channel: "C123",
      });
    });
    controller.stop();
  });

  it("records Slack channel discovery errors without rejecting the reconciliation cycle", async () => {
    const listError = Object.assign(new Error("missing_scope"), {
      data: { error: "missing_scope" },
    });
    const history = vi.fn().mockResolvedValue({ messages: [] });
    const ctx = makeContext({
      list: vi.fn().mockRejectedValue(listError),
      history,
    });
    ctx.channelsConfig = {
      C123: { enabled: true, requireMention: true },
      "*": { enabled: true, requireMention: true },
    };
    const status: Record<string, unknown> = {};

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
      setStatus: (patch) => Object.assign(status, patch),
    });
    await vi.waitFor(() => {
      const reconciliationStatus = status.reconciliationStatus as {
        lastApiError?: { code?: string; channel?: string };
      };
      expect(reconciliationStatus.lastApiError).toMatchObject({
        code: "missing_scope",
        channel: "__discovery",
      });
    });
    await vi.waitFor(() =>
      expect(history).toHaveBeenCalledWith(expect.objectContaining({ channel: "C123" })),
    );
    controller.stop();
  });

  it("logs unexpected reconciliation cycle failures without throwing", async () => {
    const badStateRoot = path.join(os.tmpdir(), `openclaw-reconciliation-state-file-${Date.now()}`);
    await fs.writeFile(badStateRoot, "not a directory");
    process.env.OPENCLAW_STATE_DIR = badStateRoot;
    const ctx = makeContext();

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(() => {
      expect(ctx.runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("slack history reconciliation cycle failed for work:"),
      );
    });
    controller.stop();
    await fs.rm(badStateRoot, { force: true });
  });

  it("paginates channel history and overlaps from the stored checkpoint", async () => {
    const nowMs = Date.now();
    const checkpointTs = ((nowMs - 60_000) / 1000).toFixed(6);
    const state = await readSlackReconciliationState({ accountId: "work" });
    ensureSlackReconciliationChannelState(state, "C123").latestProcessedTs = checkpointTs;
    await writeSlackReconciliationState({ accountId: "work", state });
    const history = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [],
        response_metadata: { next_cursor: "cursor-2" },
      })
      .mockResolvedValueOnce({
        messages: [
          {
            type: "message",
            channel: "C123",
            ts: ((nowMs - 10_000) / 1000).toFixed(6),
            user: "U1",
            text: "<@UBOT> page two",
          },
        ],
      });
    const ctx = makeContext({ history });
    const status: Record<string, unknown> = {};

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, lookbackMs: 600_000 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
      setStatus: (patch) => Object.assign(status, patch),
    });
    await vi.waitFor(() => {
      expect(history).toHaveBeenCalledTimes(2);
      expect(
        (status.reconciliationStatus as { missingCandidates?: number }).missingCandidates,
      ).toBe(1);
    });
    controller.stop();

    const firstArgs = history.mock.calls[0]?.[0] as { oldest?: string };
    expect(Number(firstArgs.oldest)).toBeLessThanOrEqual((nowMs - 660_000) / 1000 + 1);
    expect(Number(firstArgs.oldest)).toBeGreaterThan((nowMs - 660_000) / 1000 - 5);
    expect(history.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        cursor: "cursor-2",
      }),
    );
  });

  it("keeps a backlog cursor instead of advancing the checkpoint when a scan is capped", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          channel: "C123",
          ts: "1780182188.000001",
          user: "U1",
          text: "<@UBOT> newest",
        },
      ],
      response_metadata: { next_cursor: "older-page" },
    });
    const ctx = makeContext({ history });

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, maxMessagesPerCycle: 1 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(async () => {
      const state = await readSlackReconciliationState({ accountId: "work" });
      expect(state.channels.C123?.backlogLatestTs).toBe("1780182188.000000");
    });
    controller.stop();

    const state = await readSlackReconciliationState({ accountId: "work" });
    expect(state.channels.C123?.latestProcessedTs).toBeUndefined();
    expect(state.channels.C123?.backlogHighWaterTs).toEqual(expect.any(String));
  });

  it("applies maxMessagesPerCycle across the account cycle, not once per channel", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          ts: "1780182188.000001",
          user: "U1",
          text: "<@UBOT> one",
        },
      ],
    });
    const ctx = makeContext({ history });
    ctx.channelsConfig = {
      C123: { enabled: true, requireMention: true },
      C999: { enabled: true, requireMention: true },
    };

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, maxMessagesPerCycle: 1 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(() => {
      expect(history).toHaveBeenCalledTimes(1);
    });
    controller.stop();
  });

  it("rotates a one-message cycle budget across busy channels", async () => {
    const history = vi.fn().mockImplementation(async ({ channel }: { channel: string }) => ({
      messages: [
        {
          type: "message",
          channel,
          ts: channel === "C123" ? "1780182188.000001" : "1780182188.000002",
          user: "U1",
          text: "<@UBOT> busy",
        },
      ],
      response_metadata: { next_cursor: "more" },
    }));
    const ctx = makeContext({ history });
    ctx.channelsConfig = {
      C123: { enabled: true, requireMention: true },
      C999: { enabled: true, requireMention: true },
    };

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, maxMessagesPerCycle: 1 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(() => {
      expect(history).toHaveBeenCalledTimes(1);
    });
    await controller.runOnce();
    controller.stop();

    expect(history.mock.calls.map(([call]) => call.channel)).toEqual(["C123", "C999"]);
  });

  it("shares an available cycle budget across busy channels", async () => {
    const history = vi.fn().mockImplementation(async ({ channel }: { channel: string }) => ({
      messages: [
        {
          type: "message",
          channel,
          ts: channel === "C123" ? "1780182188.100001" : "1780182188.100002",
          user: "U1",
          text: "<@UBOT> busy",
        },
      ],
      response_metadata: { next_cursor: "more" },
    }));
    const ctx = makeContext({ history });
    ctx.channelsConfig = {
      C123: { enabled: true, requireMention: true },
      C999: { enabled: true, requireMention: true },
    };

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, maxMessagesPerCycle: 2 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(() => {
      expect(history).toHaveBeenCalledTimes(2);
    });
    controller.stop();

    expect(history.mock.calls.map(([call]) => [call.channel, call.limit])).toEqual([
      ["C123", 1],
      ["C999", 1],
    ]);
  });

  it("rotates a one-root budget while continuing zero-root history scans", async () => {
    const history = vi.fn().mockImplementation(async ({ channel }: { channel: string }) => ({
      messages: [
        {
          type: "message",
          channel,
          ts: channel === "C123" ? "1780182188.200001" : "1780182188.200002",
          user: "U1",
          text: "thread root",
          reply_count: 1,
        },
      ],
    }));
    const replies = vi.fn().mockImplementation(async ({ channel, ts }) => ({
      messages: [{ type: "message", channel, ts, text: "thread root" }],
    }));
    const ctx = makeContext({ history, replies });
    ctx.channelsConfig = {
      C123: { enabled: true, requireMention: true },
      C999: { enabled: true, requireMention: true },
    };

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: {
        enabled: true,
        intervalMs: 60_000,
        maxMessagesPerCycle: 10,
        maxThreadRootsPerCycle: 1,
      },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(() => {
      expect(history).toHaveBeenCalledTimes(2);
      expect(replies).toHaveBeenCalledTimes(1);
    });
    await controller.runOnce();
    controller.stop();

    expect(history.mock.calls.map(([call]) => call.channel)).toEqual([
      "C123",
      "C999",
      "C123",
      "C999",
    ]);
    expect(replies.mock.calls.map(([call]) => call.channel)).toEqual(["C123", "C999"]);
  });

  it("keeps fetched thread roots pending when top-level history fills the cycle cap", async () => {
    const root = {
      type: "message",
      channel: "C123",
      ts: "1780182188.000001",
      user: "U1",
      text: "root",
      reply_count: 1,
    };
    const reply = {
      type: "message",
      channel: "C123",
      ts: "1780182188.000002",
      thread_ts: root.ts,
      user: "U2",
      text: "<@UBOT> reply mention",
    };
    const history = vi.fn().mockResolvedValue({
      messages: [root],
      response_metadata: { next_cursor: "older-page" },
    });
    const replies = vi.fn().mockResolvedValue({ messages: [root, reply] });
    const ctx = makeContext({ history, replies });

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, maxMessagesPerCycle: 1 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(async () => {
      const state = await readSlackReconciliationState({ accountId: "work" });
      expect(state.channels.C123?.pendingThreadRoots).toEqual([{ ts: root.ts }]);
    });
    await controller.runOnce();
    await vi.waitFor(async () => {
      const state = await readSlackReconciliationState({ accountId: "work" });
      expect(state.candidates["C123:1780182188.000002"]).toMatchObject({
        status: "missing-admission",
        reason: "eligible-missing-admission",
      });
    });
    controller.stop();

    expect(replies).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        ts: root.ts,
        latest: history.mock.calls[0]?.[0]?.latest,
      }),
    );
  });

  it("persists a thread reply cursor when reply expansion reaches the cycle cap", async () => {
    const root = {
      type: "message",
      channel: "C123",
      ts: "1780182188.100001",
      user: "U1",
      text: "root",
      reply_count: 2,
    };
    const reply = {
      type: "message",
      channel: "C123",
      ts: "1780182188.100002",
      thread_ts: root.ts,
      user: "U2",
      text: "<@UBOT> reply mention",
    };
    const history = vi.fn().mockResolvedValue({ messages: [root] });
    const replies = vi.fn().mockResolvedValue({
      messages: [root, reply],
      response_metadata: { next_cursor: "reply-page-2" },
    });
    const ctx = makeContext({ history, replies });

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, maxMessagesPerCycle: 2 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(async () => {
      const state = await readSlackReconciliationState({ accountId: "work" });
      expect(state.channels.C123?.pendingThreadRoots).toEqual([
        { ts: root.ts, cursor: "reply-page-2" },
      ]);
    });
    controller.stop();
  });

  it("queues over-limit thread roots and advances the top-level backlog window", async () => {
    const newerRoot = {
      type: "message",
      channel: "C123",
      ts: "1780182188.500002",
      user: "U1",
      text: "newer root",
      reply_count: 1,
    };
    const olderRoot = {
      type: "message",
      channel: "C123",
      ts: "1780182188.500001",
      user: "U1",
      text: "older root",
      reply_count: 1,
    };
    const history = vi.fn().mockResolvedValue({ messages: [newerRoot, olderRoot] });
    const replies = vi.fn().mockResolvedValue({ messages: [newerRoot] });
    const ctx = makeContext({ history, replies });

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, maxThreadRootsPerCycle: 1 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(async () => {
      const state = await readSlackReconciliationState({ accountId: "work" });
      expect(state.channels.C123?.pendingThreadRoots).toEqual([{ ts: olderRoot.ts }]);
      expect(state.channels.C123?.backlogLatestTs).toBe("1780182188.500001");
    });
    const backlogHighWater = history.mock.calls[0]?.[0]?.latest;
    await controller.runOnce();
    controller.stop();

    expect(replies).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ ts: olderRoot.ts, latest: backlogHighWater }),
    );
  });

  it("applies the thread root cycle cap to pending roots", async () => {
    const state = await readSlackReconciliationState({ accountId: "work" });
    ensureSlackReconciliationChannelState(state, "C123").pendingThreadRoots = [
      { ts: "1780182188.600001" },
      { ts: "1780182188.600002" },
    ];
    await writeSlackReconciliationState({ accountId: "work", state });
    const history = vi.fn().mockResolvedValue({ messages: [] });
    const replies = vi.fn().mockResolvedValue({
      messages: [{ type: "message", channel: "C123", ts: "1780182188.600001", text: "root" }],
    });
    const ctx = makeContext({ history, replies });

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, maxThreadRootsPerCycle: 1 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(async () => {
      const next = await readSlackReconciliationState({ accountId: "work" });
      expect(replies).toHaveBeenCalledTimes(1);
      expect(next.channels.C123?.pendingThreadRoots).toEqual([{ ts: "1780182188.600002" }]);
    });
    controller.stop();
  });

  it("does not hold backlog open for over-limit known ledger thread roots", async () => {
    const baseSeconds = Math.floor(Date.now() / 1000) - 30;
    const threadRoots = [1, 2, 3].map(
      (offset) => `${baseSeconds}.${String(offset).padStart(6, "0")}`,
    );
    for (const [index, threadTs] of threadRoots.entries()) {
      await recordSlackAdmission({
        accountId: "work",
        message: {
          channel: "C123",
          ts: `${baseSeconds + 1}.${String(index + 1).padStart(6, "0")}`,
          thread_ts: threadTs,
          user: "U1",
          text: `ledger reply ${index + 1}`,
        },
        source: "message",
        outcome: "accepted",
        reason: "test-ledger-root",
        env: process.env,
      });
    }
    const history = vi.fn().mockResolvedValue({ messages: [] });
    const replies = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          channel: "C123",
          ts: threadRoots[0],
          text: "root",
        },
      ],
    });
    const ctx = makeContext({ history, replies });
    const status: Record<string, unknown> = {};

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, maxThreadRootsPerCycle: 1 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
      setStatus: (patch) => Object.assign(status, patch),
    });
    await vi.waitFor(async () => {
      const state = await readSlackReconciliationState({ accountId: "work" });
      expect(replies).toHaveBeenCalledTimes(1);
      expect(state.channels.C123?.pendingThreadRoots).toBeUndefined();
      expect(state.channels.C123?.backlogLatestTs).toBeUndefined();
      expect(state.channels.C123?.latestProcessedTs).toEqual(expect.any(String));
      expect(state.channels.C123?.expandedKnownThreadRoots).toEqual([threadRoots[2]]);
    });
    controller.stop();

    const reconciliationStatus = status.reconciliationStatus as { latestCheckpointTs?: string };
    expect(reconciliationStatus.latestCheckpointTs).toEqual(expect.any(String));
  });

  it("scans known old thread roots for current-window replies", async () => {
    const replyTs = `${Math.floor(Date.now() / 1000) - 30}.000001`;
    await recordSlackAdmission({
      accountId: "work",
      message: {
        channel: "C123",
        ts: "1700000000.000002",
        thread_ts: "1700000000.000001",
        user: "U1",
        text: "previous participated reply",
      },
      source: "message",
      outcome: "accepted",
      reason: "test-ledger-root",
      env: process.env,
    });
    const history = vi.fn().mockResolvedValue({ messages: [] });
    const replies = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          channel: "C123",
          ts: "1700000000.000001",
          text: "old root",
        },
        {
          type: "message",
          channel: "C123",
          ts: replyTs,
          thread_ts: "1700000000.000001",
          user: "U2",
          text: "<@UBOT> current missed reply",
        },
      ],
    });
    const ctx = makeContext({ history, replies });

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(async () => {
      expect(replies).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "C123",
          ts: "1700000000.000001",
        }),
      );
      const state = await readSlackReconciliationState({ accountId: "work" });
      expect(state.candidates[`C123:${replyTs}`]).toMatchObject({
        status: "missing-admission",
        reason: "eligible-missing-admission",
      });
    });
    controller.stop();
  });

  it("preserves known thread root source when reply pagination is pending", async () => {
    const rootTs = `${Math.floor(Date.now() / 1000) - 30}.000001`;
    await recordSlackAdmission({
      accountId: "work",
      message: {
        channel: "C123",
        ts: `${Math.floor(Date.now() / 1000) - 20}.000001`,
        thread_ts: rootTs,
        user: "U1",
        text: "known reply",
      },
      source: "message",
      outcome: "accepted",
      reason: "test-ledger-root",
      env: process.env,
    });
    const history = vi.fn().mockResolvedValue({ messages: [] });
    const replies = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          channel: "C123",
          ts: rootTs,
          text: "root",
        },
        {
          type: "message",
          channel: "C123",
          ts: `${Math.floor(Date.now() / 1000) - 10}.000001`,
          thread_ts: rootTs,
          user: "U2",
          text: "<@UBOT> paginated reply",
        },
      ],
      response_metadata: { next_cursor: "reply-page-2" },
    });
    const ctx = makeContext({ history, replies });

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, maxMessagesPerCycle: 1 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(async () => {
      const state = await readSlackReconciliationState({ accountId: "work" });
      expect(state.channels.C123?.pendingThreadRoots).toEqual([
        { ts: rootTs, cursor: "reply-page-2", source: "known" },
      ]);
    });
    controller.stop();
  });

  it("classifies thread broadcast mentions as eligible history candidates", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          subtype: "thread_broadcast",
          channel: "C123",
          ts: "1780182188.200001",
          user: "U1",
          text: "<@UBOT> broadcast reply",
        },
      ],
    });
    const ctx = makeContext({ history });

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(async () => {
      const state = await readSlackReconciliationState({ accountId: "work" });
      expect(state.candidates["C123:1780182188.200001"]).toMatchObject({
        status: "missing-admission",
        reason: "eligible-missing-admission",
      });
    });
    controller.stop();
  });

  it("classifies implicit replies to the bot in threads as eligible history candidates", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          channel: "C123",
          ts: "1780182188.300001",
          thread_ts: "1780182188.100000",
          parent_user_id: "UBOT",
          user: "U1",
          text: "implicit thread reply",
        },
      ],
    });
    const ctx = makeContext({ history });
    ctx.threadRequireExplicitMention = false;

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(async () => {
      const state = await readSlackReconciliationState({ accountId: "work" });
      expect(state.candidates["C123:1780182188.300001"]).toMatchObject({
        status: "missing-admission",
        reason: "eligible-missing-admission",
      });
    });
    controller.stop();
  });

  it("classifies mentioned bot messages as missing when bot mentions are allowed", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          channel: "C123",
          ts: "1780182189.000001",
          bot_id: "BOTHER",
          subtype: "bot_message",
          text: "<@UBOT> bot-authored mention",
        },
      ],
    });
    const ctx = makeContext({ history });
    ctx.channelsConfig = {
      C123: {
        enabled: true,
        requireMention: true,
        allowBots: "mentions",
        users: ["BOTHER"],
      },
    };
    const status: Record<string, unknown> = {};

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
      setStatus: (patch) => Object.assign(status, patch),
    });
    await vi.waitFor(() => {
      expect(
        (status.reconciliationStatus as { missingCandidates?: number }).missingCandidates,
      ).toBe(1);
    });
    controller.stop();

    const state = await readSlackReconciliationState({ accountId: "work" });
    expect(state.candidates["C123:1780182189.000001"]).toMatchObject({
      status: "missing-admission",
      reason: "eligible-missing-admission",
    });
  });

  it("drops OpenClaw bot-authored history messages before bot allow rules", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          channel: "C123",
          ts: "1780182189.500001",
          bot_id: "BBOT",
          subtype: "bot_message",
          text: "<@UBOT> own bot reply",
        },
      ],
    });
    const ctx = makeContext({ history });
    ctx.channelsConfig = {
      C123: {
        enabled: true,
        requireMention: true,
        allowBots: "mentions",
        users: ["BBOT"],
      },
    };
    const handleSlackMessage = vi.fn().mockResolvedValue(undefined);

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, autoRecover: true },
      handleSlackMessage,
    });
    await vi.waitFor(async () => {
      const state = await readSlackReconciliationState({ accountId: "work" });
      expect(state.candidates["C123:1780182189.500001"]).toMatchObject({
        status: "dropped",
        reason: "bot-self",
      });
    });
    expect(handleSlackMessage).not.toHaveBeenCalled();
    controller.stop();
  });

  it("applies bot room authorization in open channels without per-channel config", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          channel: "C999",
          ts: "1780182189.600001",
          bot_id: "BOTHER",
          subtype: "bot_message",
          text: "<@UBOT> third-party bot mention",
        },
      ],
    });
    const list = vi.fn().mockResolvedValue({
      channels: [{ id: "C999", name: "open", is_archived: false }],
    });
    const ctx = makeContext({ history, list });
    ctx.channelsConfig = {};
    const handleSlackMessage = vi.fn().mockResolvedValue(undefined);

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      accountAllowBots: "mentions",
      config: { enabled: true, intervalMs: 60_000, autoRecover: true },
      handleSlackMessage,
    });
    await vi.waitFor(async () => {
      const state = await readSlackReconciliationState({ accountId: "work" });
      expect(state.candidates["C999:1780182189.600001"]).toMatchObject({
        status: "dropped",
        reason: "bot-room-message-denied",
      });
    });
    expect(handleSlackMessage).not.toHaveBeenCalled();
    controller.stop();
  });

  it("classifies user-group mentions containing the bot as eligible history candidates", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          channel: "C123",
          ts: "1780182190.000001",
          user: "U1",
          text: "<!subteam^S123|ask-lei> please check this",
        },
      ],
    });
    const usergroupsUsersList = vi.fn().mockResolvedValue({ ok: true, users: ["UBOT"] });
    const ctx = makeContext({ history, usergroupsUsersList });

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(async () => {
      const state = await readSlackReconciliationState({ accountId: "work" });
      expect(state.candidates["C123:1780182190.000001"]).toMatchObject({
        status: "missing-admission",
        reason: "eligible-missing-admission",
      });
    });
    expect(usergroupsUsersList).toHaveBeenCalledWith({
      usergroup: "S123",
      team_id: "T1",
    });
    controller.stop();
  });

  it("enumerates Slack channels for wildcard channel config", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          channel: "C999",
          ts: "1780182190.000001",
          user: "U1",
          text: "<@UBOT> wildcard",
        },
      ],
    });
    const list = vi.fn().mockResolvedValue({
      channels: [{ id: "C999", name: "wildcard", is_archived: false }],
    });
    const ctx = makeContext({ history, list });
    ctx.channelsConfig = { "*": { enabled: true, requireMention: true } };
    const status: Record<string, unknown> = {};

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
      setStatus: (patch) => Object.assign(status, patch),
    });
    await vi.waitFor(() => {
      expect(list).toHaveBeenCalled();
      expect(history).toHaveBeenCalledWith(expect.objectContaining({ channel: "C999" }));
      expect(
        (status.reconciliationStatus as { missingCandidates?: number }).missingCandidates,
      ).toBe(1);
    });
    controller.stop();
  });

  it("enumerates every joined room for open group policy alongside explicit overrides", async () => {
    const history = vi.fn().mockResolvedValue({ messages: [] });
    const list = vi.fn((params: { types?: string }) =>
      Promise.resolve({
        channels:
          params.types === "public_channel,private_channel"
            ? [
                { id: "C123", name: "configured", is_archived: false },
                { id: "COTHER", name: "other", is_archived: false },
              ]
            : [],
      }),
    );
    const ctx = makeContext({ history, list });
    ctx.channelsConfig = { C123: { enabled: true, requireMention: false } };
    ctx.channelsConfigKeys = ["C123"];
    ctx.groupPolicy = "open";

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(() => {
      expect(history).toHaveBeenCalledWith(expect.objectContaining({ channel: "C123" }));
      expect(history).toHaveBeenCalledWith(expect.objectContaining({ channel: "COTHER" }));
    });
    controller.stop();
  });

  it("resolves named channel configs without scanning unrelated rooms", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          channel: "C999",
          ts: "1780182190.100001",
          user: "U1",
          text: "<@UBOT> named channel",
        },
      ],
    });
    const list = vi.fn((params: { types?: string }) =>
      Promise.resolve({
        channels:
          params.types === "public_channel,private_channel"
            ? [
                { id: "C999", name: "ask-lei", is_archived: false },
                { id: "COTHER", name: "general", is_archived: false },
              ]
            : [],
      }),
    );
    const ctx = makeContext({ history, list });
    ctx.channelsConfig = { "#ask-lei": { enabled: true, requireMention: true } };
    ctx.channelsConfigKeys = ["#ask-lei"];
    ctx.groupPolicy = "allowlist";
    const status: Record<string, unknown> = {};

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
      setStatus: (patch) => Object.assign(status, patch),
    });
    await vi.waitFor(() => {
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ types: "public_channel,private_channel" }),
      );
      expect(history).toHaveBeenCalledWith(expect.objectContaining({ channel: "C999" }));
      expect(history).not.toHaveBeenCalledWith(expect.objectContaining({ channel: "COTHER" }));
      expect(
        (status.reconciliationStatus as { missingCandidates?: number }).missingCandidates,
      ).toBe(1);
    });
    controller.stop();
  });

  it("enumerates DM conversations when direct messages are enabled", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          channel: "D999",
          channel_type: "im",
          ts: "1780182191.000000",
          user: "U1",
          text: "dm catch-up",
        },
      ],
    });
    const list = vi.fn((params: { types?: string }) =>
      Promise.resolve({
        channels: params.types === "im" ? [{ id: "D999", is_archived: false }] : [],
      }),
    );
    const ctx = makeContext({ history, list });
    ctx.channelsConfig = { C123: { enabled: true, requireMention: true } };

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(() => {
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ types: "im" }));
      expect(history).toHaveBeenCalledWith(expect.objectContaining({ channel: "D999" }));
    });
    controller.stop();
  });

  it("does not scan direct messages when DM policy is disabled", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [],
    });
    const list = vi.fn((params: { types?: string }) =>
      Promise.resolve({
        channels: params.types === "im" ? [{ id: "D999", is_archived: false }] : [],
      }),
    );
    const ctx = makeContext({ history, list });
    ctx.channelsConfig = {
      C123: { enabled: true, requireMention: true },
      D999: { enabled: true, requireMention: true },
    };
    ctx.dmPolicy = "disabled";

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(() => {
      expect(history).toHaveBeenCalledWith(expect.objectContaining({ channel: "C123" }));
    });
    expect(list).not.toHaveBeenCalledWith(expect.objectContaining({ types: "im" }));
    expect(history).not.toHaveBeenCalledWith(expect.objectContaining({ channel: "D999" }));
    controller.stop();
  });

  it("records channel user allowlist misses as policy drops", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          channel: "C123",
          ts: "1780182191.000000",
          user: "U_DENIED",
          text: "<@UBOT> should not replay",
        },
      ],
    });
    const ctx = makeContext({ history });
    ctx.channelsConfig = {
      C123: { enabled: true, requireMention: true, users: ["U_ALLOWED"] },
    };

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, autoRecover: true },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(async () => {
      const state = await readSlackReconciliationState({ accountId: "work" });
      expect(state.candidates["C123:1780182191.000000"]).toMatchObject({
        status: "dropped",
        reason: "channel-user-not-allowed",
      });
    });
    controller.stop();
  });

  it("applies the Slack allowlist to human room senders", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          channel: "C123",
          ts: "1780182191.000010",
          user: "U_ALLOWED",
          text: "<@UBOT> allowed room sender",
        },
        {
          type: "message",
          channel: "C123",
          ts: "1780182191.000011",
          user: "U_DENIED",
          text: "<@UBOT> denied room sender",
        },
      ],
    });
    const ctx = makeContext({ history });
    ctx.allowFrom = ["U_ALLOWED"];

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(async () => {
      const state = await readSlackReconciliationState({ accountId: "work" });
      expect(state.candidates["C123:1780182191.000010"]).toMatchObject({
        status: "missing-admission",
        reason: "eligible-missing-admission",
      });
      expect(state.candidates["C123:1780182191.000011"]).toMatchObject({
        status: "dropped",
        reason: "room-sender-not-allowed",
      });
    });
    controller.stop();
  });

  it("records unauthorized DMs as drops instead of replay candidates", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          channel: "D123",
          channel_type: "im",
          ts: "1780182191.000001",
          user: "U_DENIED",
          text: "<@UBOT> dm",
        },
      ],
    });
    const ctx = makeContext({ history });
    ctx.channelsConfig = { D123: { enabled: true, requireMention: true } };
    ctx.dmPolicy = "pairing";
    ctx.allowFrom = [];

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000, autoRecover: true },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(async () => {
      const state = await readSlackReconciliationState({ accountId: "work" });
      expect(state.candidates["D123:1780182191.000001"]).toMatchObject({
        status: "dropped",
        reason: "dm-unauthorized",
      });
    });
    controller.stop();
  });

  it("classifies allowlisted DMs under pairing policy as eligible recovery candidates", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          channel: "D123",
          channel_type: "im",
          ts: "1780182192.000001",
          user: "U_ALLOWED",
          text: "dm recovery",
        },
      ],
    });
    const ctx = makeContext({ history });
    ctx.channelsConfig = { D123: { enabled: true, requireMention: true } };
    ctx.dmPolicy = "pairing";
    ctx.allowFrom = ["U_ALLOWED"];

    const controller = startSlackHistoryReconciliation({
      ctx,
      accountId: "work",
      config: { enabled: true, intervalMs: 60_000 },
      handleSlackMessage: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(async () => {
      const state = await readSlackReconciliationState({ accountId: "work" });
      expect(state.candidates["D123:1780182192.000001"]).toMatchObject({
        status: "missing-admission",
        reason: "eligible-missing-admission",
      });
    });
    controller.stop();
  });
});
