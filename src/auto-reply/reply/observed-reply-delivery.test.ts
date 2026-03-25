import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
import { deliverObservedPayload } from "./observed-reply-delivery.js";

function createObserver() {
  return {
    classifyPayloadVisibility: vi.fn((payload: ReplyPayload) =>
      payload.text === "NO_REPLY"
        ? { visibility: "suppressed" as const, suppressionReason: "silent" as const }
        : payload.text === "EMPTY"
          ? { visibility: "empty" as const }
          : { visibility: "visible" as const },
    ),
    markReplyProduced: vi.fn(),
    recordDeliveryAttempt: vi.fn(),
    recordSuppressedReply: vi.fn(),
    recordDeliverySuccess: vi.fn(),
    recordDeliveryFailure: vi.fn(),
  };
}

describe("reply-delivery", () => {
  it("routes visible payloads and records success", async () => {
    const observer = createObserver();
    const deliver = vi.fn(async () => ({ ok: true as const }));

    const result = await deliverObservedPayload({
      payload: { text: "hello" },
      observer,
      successState: "final_sent",
      route: {
        enabled: true,
        deliver,
        failureText: "route failed",
      },
      dispatch: {
        send: vi.fn(() => true),
        failureText: "dispatcher rejected final reply",
      },
    });

    expect(result).toEqual({ delivered: true, routedCount: 1 });
    expect(observer.markReplyProduced).toHaveBeenCalled();
    expect(observer.recordDeliveryAttempt).toHaveBeenCalled();
    expect(observer.recordDeliverySuccess).toHaveBeenCalledWith("final_sent");
    expect(observer.recordDeliveryFailure).not.toHaveBeenCalled();
  });

  it("records route failures for visible payloads and logs them", async () => {
    const observer = createObserver();
    const logFailure = vi.fn();

    const result = await deliverObservedPayload({
      payload: { text: "hello" },
      observer,
      successState: "block_sent",
      route: {
        enabled: true,
        deliver: async () => ({ ok: false, error: "slack transport failed" }),
        failureText: "route failed",
        logMessage: "dispatch-from-config: route-reply (block) failed",
        logFailure,
      },
      dispatch: {
        send: vi.fn(() => true),
        failureText: "dispatcher rejected block reply",
      },
    });

    expect(result).toEqual({ delivered: false, routedCount: 0 });
    expect(observer.recordDeliveryFailure).toHaveBeenCalledWith("slack transport failed");
    expect(logFailure).toHaveBeenCalledWith(
      "dispatch-from-config: route-reply (block) failed: slack transport failed",
    );
  });

  it("dispatches empty payloads without visible delivery bookkeeping", async () => {
    const observer = createObserver();
    const send = vi.fn(() => true);

    const result = await deliverObservedPayload({
      payload: { text: "EMPTY" },
      observer,
      successState: "final_sent",
      dispatch: {
        send,
        failureText: "dispatcher rejected final reply",
      },
    });

    expect(result).toEqual({ delivered: true, routedCount: 0 });
    expect(observer.recordSuppressedReply).not.toHaveBeenCalled();
    expect(observer.markReplyProduced).not.toHaveBeenCalled();
    expect(observer.recordDeliveryAttempt).not.toHaveBeenCalled();
    expect(observer.recordDeliverySuccess).not.toHaveBeenCalled();
    expect(observer.recordDeliveryFailure).not.toHaveBeenCalled();
  });

  it("dispatches suppressed payloads without visible delivery bookkeeping", async () => {
    const observer = createObserver();
    const send = vi.fn(() => true);

    const result = await deliverObservedPayload({
      payload: { text: "NO_REPLY" },
      observer,
      successState: "final_sent",
      dispatch: {
        send,
        failureText: "dispatcher rejected final reply",
      },
    });

    expect(result).toEqual({ delivered: true, routedCount: 0 });
    expect(observer.recordSuppressedReply).toHaveBeenCalledWith("silent");
    expect(observer.markReplyProduced).not.toHaveBeenCalled();
    expect(observer.recordDeliveryAttempt).not.toHaveBeenCalled();
    expect(observer.recordDeliverySuccess).not.toHaveBeenCalled();
    expect(observer.recordDeliveryFailure).not.toHaveBeenCalled();
  });
});
