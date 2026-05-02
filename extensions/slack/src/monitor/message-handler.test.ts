// Slack tests cover message handler plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueMock = vi.fn(async (_entry: unknown) => {});
const flushKeyMock = vi.fn(async (_key: string) => {});
const onFlushCallbacks: Array<(entries: Array<Record<string, unknown>>) => Promise<void>> = [];
const prepareSlackMessageMock = vi.fn(async () => ({ ctxPayload: {} }));
const dispatchPreparedSlackMessageMock = vi.fn(async () => {});
const resolveThreadTsMock = vi.fn(async ({ message }: { message: Record<string, unknown> }) => ({
  ...message,
}));
const reactSlackMessageMock = vi.hoisted(() => vi.fn(async () => {}));
const { createSlackMessageHandler } = await import("./message-handler.js");

vi.mock("../actions.js", () => ({
  reactSlackMessage: reactSlackMessageMock,
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    createChannelInboundDebouncer: (params: {
      onFlush: (entries: Array<Record<string, unknown>>) => Promise<void>;
    }) => {
      onFlushCallbacks.push(params.onFlush);
      return {
        debounceMs: 10,
        debouncer: {
          enqueue: (entry: unknown) => enqueueMock(entry),
          flushKey: (key: string) => flushKeyMock(key),
        },
      };
    },
    shouldDebounceTextInbound: ({ hasMedia }: { hasMedia?: boolean }) => !hasMedia,
  };
});

vi.mock("./thread-resolution.js", () => ({
  createSlackThreadTsResolver: () => ({
    resolve: (entry: { message: Record<string, unknown> }) => resolveThreadTsMock(entry),
  }),
}));

vi.mock("./message-handler/pipeline.runtime.js", () => ({
  prepareSlackMessage: prepareSlackMessageMock,
  dispatchPreparedSlackMessage: dispatchPreparedSlackMessageMock,
}));

vi.mock("./inbound-delivery-state.js", () => ({
  hasSlackInboundMessageDelivery: vi.fn(async () => false),
  recordSlackInboundMessageDeliveries: vi.fn(async () => {}),
}));

function createContext(overrides?: {
  markMessageSeen?: (channel: string | undefined, ts: string | undefined) => boolean;
  releaseSeenMessage?: (channel: string | undefined, ts: string | undefined) => void;
  isChannelAllowed?: () => boolean;
  channelsConfig?: Record<string, { enabled?: boolean; requireMention?: boolean }>;
  defaultRequireMention?: boolean;
  typingReaction?: string;
}) {
  const channelsConfig = overrides?.channelsConfig ?? {};
  return {
    cfg: {},
    accountId: "default",
    botToken: "xoxb-test",
    botUserId: "UOPENCLAW",
    app: {
      client: {},
    },
    runtime: {},
    ackReactionScope: "group-mentions",
    typingReaction: overrides?.typingReaction ?? "",
    channelsConfig,
    channelsConfigKeys: Object.keys(channelsConfig),
    defaultRequireMention: overrides?.defaultRequireMention ?? true,
    logger: {},
    isChannelAllowed: () => overrides?.isChannelAllowed?.() ?? true,
    markMessageSeen: (channel: string | undefined, ts: string | undefined) =>
      overrides?.markMessageSeen?.(channel, ts) ?? false,
    releaseSeenMessage: (channel: string | undefined, ts: string | undefined) =>
      overrides?.releaseSeenMessage?.(channel, ts),
  } as Parameters<typeof createSlackMessageHandler>[0]["ctx"];
}

function createHandlerWithTracker(overrides?: {
  markMessageSeen?: (channel: string | undefined, ts: string | undefined) => boolean;
  releaseSeenMessage?: (channel: string | undefined, ts: string | undefined) => void;
  isChannelAllowed?: () => boolean;
  channelsConfig?: Record<string, { enabled?: boolean; requireMention?: boolean }>;
  defaultRequireMention?: boolean;
  typingReaction?: string;
}) {
  const trackEvent = vi.fn();
  const handler = createSlackMessageHandler({
    ctx: createContext(overrides),
    account: { accountId: "default" } as Parameters<typeof createSlackMessageHandler>[0]["account"],
    trackEvent,
  });
  return { handler, trackEvent };
}

async function handleDirectMessage(
  handler: ReturnType<typeof createHandlerWithTracker>["handler"],
) {
  await handler(
    {
      type: "message",
      channel: "D1",
      ts: "123.456",
      text: "hello",
    } as never,
    { source: "message" },
  );
}

describe("createSlackMessageHandler", () => {
  beforeEach(() => {
    enqueueMock.mockClear();
    flushKeyMock.mockClear();
    onFlushCallbacks.length = 0;
    prepareSlackMessageMock.mockClear();
    dispatchPreparedSlackMessageMock.mockClear();
    resolveThreadTsMock.mockClear();
    reactSlackMessageMock.mockClear();
  });

  it("does not track invalid non-message events from the message stream", async () => {
    const trackEvent = vi.fn();
    const handler = createSlackMessageHandler({
      ctx: createContext(),
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
      trackEvent,
    });

    await handler(
      {
        type: "reaction_added",
        channel: "D1",
        ts: "123.456",
      } as never,
      { source: "message" },
    );

    expect(trackEvent).not.toHaveBeenCalled();
    expect(resolveThreadTsMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("does not track duplicate messages that are already seen", async () => {
    const { handler, trackEvent } = createHandlerWithTracker({ markMessageSeen: () => true });

    await handleDirectMessage(handler);

    expect(trackEvent).not.toHaveBeenCalled();
    expect(resolveThreadTsMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("tracks accepted non-duplicate messages", async () => {
    const { handler, trackEvent } = createHandlerWithTracker();

    await handleDirectMessage(handler);

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(resolveThreadTsMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("starts an app mention ack before thread resolution and pipeline work", async () => {
    const { handler } = createHandlerWithTracker();

    await handler(
      {
        type: "app_mention",
        channel: "C111",
        channel_type: "channel",
        user: "U111",
        ts: "1709000000.000100",
        text: "<@UOPENCLAW> hello",
      } as never,
      { source: "app_mention", wasMentioned: true },
    );

    expect(reactSlackMessageMock).toHaveBeenCalledWith("C111", "1709000000.000100", "👀", {
      token: "xoxb-test",
      client: {},
    });
    expect(reactSlackMessageMock.mock.invocationCallOrder[0]).toBeLessThan(
      resolveThreadTsMock.mock.invocationCallOrder[0],
    );
    expect(resolveThreadTsMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("starts an ack for message events that directly mention the bot", async () => {
    const { handler } = createHandlerWithTracker();

    await handler(
      {
        type: "message",
        channel: "C111",
        channel_type: "channel",
        user: "U111",
        ts: "1709000000.000100",
        text: "<@UOPENCLAW> hello",
      } as never,
      { source: "message" },
    );

    expect(reactSlackMessageMock).toHaveBeenCalledWith("C111", "1709000000.000100", "👀", {
      token: "xoxb-test",
      client: {},
    });
    expect(reactSlackMessageMock.mock.invocationCallOrder[0]).toBeLessThan(
      resolveThreadTsMock.mock.invocationCallOrder[0],
    );
  });

  it("starts a typing reaction for accepted non-mention channel messages before thread resolution", async () => {
    const { handler } = createHandlerWithTracker({
      channelsConfig: { C111: { enabled: true, requireMention: false } },
      typingReaction: "hourglass_flowing_sand",
    });

    await handler(
      {
        type: "message",
        channel: "C111",
        channel_type: "channel",
        user: "U111",
        ts: "1709000000.000100",
        text: "hello",
      } as never,
      { source: "message" },
    );

    expect(reactSlackMessageMock).toHaveBeenCalledWith(
      "C111",
      "1709000000.000100",
      "hourglass_flowing_sand",
      {
        token: "xoxb-test",
        client: {},
      },
    );
    expect(reactSlackMessageMock).not.toHaveBeenCalledWith("C111", "1709000000.000100", "👀", {
      token: "xoxb-test",
      client: {},
    });
    expect(reactSlackMessageMock.mock.invocationCallOrder[0]).toBeLessThan(
      resolveThreadTsMock.mock.invocationCallOrder[0],
    );
  });

  it("does not start a typing reaction for unmentioned mention-required channel messages", async () => {
    const { handler } = createHandlerWithTracker({
      channelsConfig: { C111: { enabled: true, requireMention: true } },
      typingReaction: "hourglass_flowing_sand",
    });

    await handler(
      {
        type: "message",
        channel: "C111",
        channel_type: "channel",
        user: "U111",
        ts: "1709000000.000100",
        text: "ambient channel chatter",
      } as never,
      { source: "message" },
    );

    expect(reactSlackMessageMock).not.toHaveBeenCalled();
    expect(resolveThreadTsMock).toHaveBeenCalledTimes(1);
  });

  it("does not pre-ack app mentions in disallowed channels", async () => {
    const { handler } = createHandlerWithTracker({ isChannelAllowed: () => false });

    await handler(
      {
        type: "app_mention",
        channel: "C111",
        channel_type: "channel",
        user: "U111",
        ts: "1709000000.000100",
        text: "<@UOPENCLAW> hello",
      } as never,
      { source: "app_mention", wasMentioned: true },
    );

    expect(reactSlackMessageMock).not.toHaveBeenCalled();
    expect(resolveThreadTsMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("accepts thread_broadcast messages from the message stream", async () => {
    const { handler, trackEvent } = createHandlerWithTracker();

    await handler(
      {
        type: "message",
        subtype: "thread_broadcast",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000300",
        text: "also send to channel",
        thread_ts: "1709000000.000100",
      } as never,
      { source: "message" },
    );

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(resolveThreadTsMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("drops message subtypes that do not carry user message text", async () => {
    const { handler, trackEvent } = createHandlerWithTracker();

    await handler(
      {
        type: "message",
        subtype: "channel_join",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000400",
        text: "<@U111> joined the channel",
      } as never,
      { source: "message" },
    );

    expect(trackEvent).not.toHaveBeenCalled();
    expect(resolveThreadTsMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("flushes pending top-level buffered keys before immediate non-debounce follow-ups", async () => {
    const handler = createSlackMessageHandler({
      ctx: createContext(),
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
    });

    await handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000100",
        text: "first buffered text",
      } as never,
      { source: "message" },
    );
    await handler(
      {
        type: "message",
        subtype: "file_share",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000200",
        text: "file follows",
        files: [{ id: "F1" }],
      } as never,
      { source: "message" },
    );

    expect(flushKeyMock).toHaveBeenCalledWith("slack:default:C111:1709000000.000100:U111");
  });

  it("waits for debounced dispatch completion when requested by relay delivery", async () => {
    const { handler } = createHandlerWithTracker();
    const handled = handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000500",
        text: "relay message",
      } as never,
      { source: "message", awaitDispatch: true },
    );

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    let settled = false;
    void handled.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await onFlushCallbacks[0]?.([entry]);
    await expect(handled).resolves.toBeUndefined();
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  it("propagates debounced dispatch failures to relay delivery", async () => {
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(new Error("dispatch failed"));
    const { handler } = createHandlerWithTracker();
    const handled = handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000600",
        text: "relay message",
      } as never,
      { source: "message", awaitDispatch: true },
    );

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const handledFailure = expect(handled).rejects.toThrow("dispatch failed");
    const flushFailure = expect(onFlushCallbacks[0]?.([entry])).rejects.toThrow("dispatch failed");
    await Promise.all([handledFailure, flushFailure]);
  });
});
