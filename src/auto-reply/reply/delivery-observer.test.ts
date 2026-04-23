import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRecentTrackedTurn, resetTrackedTurnsForTests } from "../turn-tracker.js";
import type { ReplyPayload } from "../types.js";
import { createDeliveryObserver, type DeliveryObserver } from "./delivery-observer.js";

describe("delivery-observer", () => {
  beforeEach(() => {
    resetTrackedTurnsForTests();
  });

  it("classifies silent and maintenance suppression", () => {
    const silentObserver = createDeliveryObserver({
      sessionKey: "agent:main:main",
      visibleChannel: "slack",
      deliveryTarget: "same_channel",
      didMemoryFlushDuringTurn: () => false,
      onSendWatcherPayload: vi.fn(async () => true),
    });
    const maintenanceObserver = createDeliveryObserver({
      sessionKey: "agent:main:main",
      visibleChannel: "slack",
      deliveryTarget: "same_channel",
      didMemoryFlushDuringTurn: () => true,
      onSendWatcherPayload: vi.fn(async () => true),
    });

    expect(silentObserver.classifyPayloadVisibility({ text: "NO_REPLY" })).toEqual({
      visibility: "suppressed",
      suppressionReason: "silent",
    });
    expect(maintenanceObserver.classifyPayloadVisibility({ text: "NO_REPLY" })).toEqual({
      visibility: "suppressed",
      suppressionReason: "maintenance",
    });
  });

  it("builds stranded notices and finalizes reply_stranded turns", () => {
    const sessionKey = "agent:main:main";
    const observer = createDeliveryObserver({
      sessionKey,
      visibleChannel: "slack",
      trackedSessionId: "session-1",
      deliveryTarget: "same_channel",
      didMemoryFlushDuringTurn: () => false,
      onSendWatcherPayload: vi.fn(async () => true),
    });

    observer.startRun("run-1");
    observer.markReplyProduced();

    expect(observer.buildUndeliveredReplyNotice()).toContain(
      "status: turn finished but no visible reply was sent",
    );

    observer.finishRun({ status: "done", phase: "done" });

    const recent = getRecentTrackedTurn(sessionKey);
    expect(recent?.deliveryState).toBe("reply_stranded");
  });

  it("emits one stalled-turn notice after the stall threshold", async () => {
    vi.useFakeTimers();
    try {
      const sessionKey = "agent:main:main";
      let observer!: DeliveryObserver;
      const sendWatcherPayload = vi.fn(async (payload: ReplyPayload, failureText: string) => {
        observer.updateActiveTurn({
          replyProduced: true,
          deliveryTarget: "same_channel",
          lastDeliveryAttemptAt: Date.now(),
        });
        const at = Date.now();
        observer.updateActiveTurn({
          deliveryState: "block_sent",
          deliveryTarget: "same_channel",
          lastDeliveryAttemptAt: at,
          lastDeliverySuccessAt: at,
          lastDeliveryError: undefined,
          markVisible: true,
        });
        return !failureText.includes("rejected");
      });
      observer = createDeliveryObserver({
        sessionKey,
        visibleChannel: "slack",
        trackedSessionId: "session-1",
        deliveryTarget: "same_channel",
        didMemoryFlushDuringTurn: () => false,
        onSendWatcherPayload: sendWatcherPayload,
      });

      observer.startRun("run-stalled");

      await vi.advanceTimersByTimeAsync(20_000);
      const firstText = (sendWatcherPayload.mock.calls[0]?.[0] as ReplyPayload | undefined)?.text;
      expect(firstText).toContain("working:");

      await vi.advanceTimersByTimeAsync(100_000);
      const stalledTexts = sendWatcherPayload.mock.calls
        .map((call) => (call[0] as ReplyPayload | undefined)?.text ?? "")
        .filter((text) => text.includes("status: turn appears stalled"));
      expect(stalledTexts).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(180_000);
      const laterStalledTexts = sendWatcherPayload.mock.calls
        .map((call) => (call[0] as ReplyPayload | undefined)?.text ?? "")
        .filter((text) => text.includes("status: turn appears stalled"));
      expect(laterStalledTexts).toHaveLength(1);

      observer.finishRun({ status: "done", phase: "done" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits active-tool progress instead of a stalled notice while a tool is still running", async () => {
    vi.useFakeTimers();
    try {
      const sessionKey = "agent:main:main";
      let observer!: DeliveryObserver;
      const sendWatcherPayload = vi.fn(
        async (_payload: ReplyPayload, _failureText: string) => true,
      );
      observer = createDeliveryObserver({
        sessionKey,
        visibleChannel: "slack",
        trackedSessionId: "session-1",
        deliveryTarget: "same_channel",
        didMemoryFlushDuringTurn: () => false,
        onSendWatcherPayload: sendWatcherPayload,
      });

      observer.startRun("run-active-tool");
      observer.updateActiveTurn({
        phase: "tool_wait",
        activeTool: "exec",
        markProgress: true,
        at: Date.now(),
      });

      await vi.advanceTimersByTimeAsync(20_000);
      await vi.advanceTimersByTimeAsync(100_000);

      const texts = sendWatcherPayload.mock.calls.map(
        (call) => (call[0] as ReplyPayload | undefined)?.text ?? "",
      );
      expect(texts).toContain("working: tool still running (exec)");
      expect(texts.some((text) => text.includes("status: turn appears stalled"))).toBe(false);

      observer.finishRun({ status: "done", phase: "done" });
    } finally {
      vi.useRealTimers();
    }
  });
});
