import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";

const routeReplyMock = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => ({ ok: true, messageId: "mock-message" })),
);

vi.mock("./route-reply.runtime.js", () => ({
  isRoutableChannel: (channel: string | undefined) =>
    Boolean(channel && ["slack", "telegram", "discord"].includes(channel)),
  routeReply: (params: unknown) => routeReplyMock(params),
}));

function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
}

function createCtx(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    Provider: "slack",
    Surface: "slack",
    OriginatingChannel: undefined,
    OriginatingTo: undefined,
    SessionKey: "agent:test:session",
    AccountId: "default",
    SenderId: "U123",
    SenderName: "Tester",
    SenderUsername: "tester",
    SenderE164: undefined,
    ExplicitDeliverRoute: false,
    ...overrides,
  } as FinalizedMsgContext;
}

describe("createDispatchFromConfigDeliveryCompat", () => {
  beforeEach(() => {
    routeReplyMock.mockReset().mockResolvedValue({ ok: true, messageId: "mock-message" });
  });

  it("falls back to the dispatcher for binding notices when routing stays on the same channel", async () => {
    const dispatcher = createDispatcher();
    const { createDispatchFromConfigDeliveryCompat } =
      await import("./dispatch-from-config.delivery-compat.js");

    const compat = await createDispatchFromConfigDeliveryCompat({
      cfg: {} as OpenClawConfig,
      ctx: createCtx(),
      dispatcher,
      isGroup: false,
      suppressDirectUserDelivery: false,
    });

    const payload: ReplyPayload = { text: "notice" };
    const sent = await compat.sendBindingNotice(payload, "additive");

    expect(sent).toBe(true);
    expect(routeReplyMock).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(payload);
  });

  it("routes replies to the originating channel when the current surface differs", async () => {
    const dispatcher = createDispatcher();
    const { createDispatchFromConfigDeliveryCompat } =
      await import("./dispatch-from-config.delivery-compat.js");

    const compat = await createDispatchFromConfigDeliveryCompat({
      cfg: {} as OpenClawConfig,
      ctx: createCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "telegram",
        OriginatingTo: "chat-42",
      }),
      dispatcher,
      isGroup: false,
      routeThreadId: "thread-1",
      suppressDirectUserDelivery: false,
    });

    const sent = await compat.sendPayloadAsync({ text: "hello" });

    expect(sent).toBe(true);
    expect(compat.shouldRouteToOriginating).toBe(true);
    expect(compat.deliveryTarget).toBe("originating_channel");
    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "chat-42",
        threadId: "thread-1",
        payload: { text: "hello" },
      }),
    );
  });

  it("does not route internal webchat turns unless delivery is explicitly forced", async () => {
    const dispatcher = createDispatcher();
    const { createDispatchFromConfigDeliveryCompat } =
      await import("./dispatch-from-config.delivery-compat.js");

    const compat = await createDispatchFromConfigDeliveryCompat({
      cfg: {} as OpenClawConfig,
      ctx: createCtx({
        Provider: INTERNAL_MESSAGE_CHANNEL,
        Surface: INTERNAL_MESSAGE_CHANNEL,
        OriginatingChannel: "telegram",
        OriginatingTo: "chat-42",
        ExplicitDeliverRoute: false,
      }),
      dispatcher,
      isGroup: false,
      suppressDirectUserDelivery: false,
    });

    expect(compat.shouldRouteToOriginating).toBe(false);
    expect(compat.deliveryTarget).toBe("same_channel");
    await compat.sendPayloadAsync({ text: "hello" });
    expect(routeReplyMock).not.toHaveBeenCalled();
  });
});
