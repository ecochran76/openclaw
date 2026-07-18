import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveTrackedTurn,
  getRecentTrackedTurn,
  resetTrackedTurnsForTests,
} from "../turn-tracker.js";
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

  it("ignores a late completion after a newer turn supersedes the observer", () => {
    const sessionKey = "agent:main:main";
    const createObserver = () =>
      createDeliveryObserver({
        sessionKey,
        visibleChannel: "slack",
        trackedSessionId: "session-1",
        deliveryTarget: "same_channel",
        didMemoryFlushDuringTurn: () => false,
        onSendWatcherPayload: vi.fn(async () => true),
      });
    const previousObserver = createObserver();
    const currentObserver = createObserver();
    previousObserver.startRun("run-previous");
    currentObserver.startRun("run-current");
    currentObserver.markReplyProduced();
    const currentBeforeLateFinish = getActiveTrackedTurn(sessionKey);

    previousObserver.finishRun({ status: "done", phase: "done" });

    expect(getActiveTrackedTurn(sessionKey)).toEqual(currentBeforeLateFinish);
    expect(getRecentTrackedTurn(sessionKey)).toMatchObject({
      runId: "run-previous",
      status: "error",
      lastError: "superseded by a newer turn",
      deliveryState: "pending",
    });
    expect(previousObserver.buildUndeliveredReplyNotice()).toBeUndefined();
  });

  it("emits one stalled-turn notice after the stall threshold", async () => {
    vi.useFakeTimers();
    try {
      const sessionKey = "agent:main:main";
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
        return true;
      });
      const observer: DeliveryObserver = createDeliveryObserver({
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
        .filter((text) => text.includes("working: still waiting for agent progress"));
      expect(stalledTexts).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(180_000);
      const laterStalledTexts = sendWatcherPayload.mock.calls
        .map((call) => (call[0] as ReplyPayload | undefined)?.text ?? "")
        .filter((text) => text.includes("working: still waiting for agent progress"));
      expect(laterStalledTexts).toHaveLength(1);

      observer.finishRun({ status: "done", phase: "done" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps watcher visibility separate from agent progress", () => {
    vi.useFakeTimers();
    try {
      const sessionKey = "agent:main:main";
      const observer = createDeliveryObserver({
        sessionKey,
        visibleChannel: "slack",
        trackedSessionId: "session-1",
        deliveryTarget: "same_channel",
        didMemoryFlushDuringTurn: () => false,
        onSendWatcherPayload: async () => true,
      });
      observer.startRun("run-watcher-visibility");
      const started = getActiveTrackedTurn(sessionKey);

      vi.advanceTimersByTime(20_000);
      observer.updateActiveTurn({ markVisible: true });
      const updated = getActiveTrackedTurn(sessionKey);

      expect(updated?.lastUserVisibleUpdateAt).toBe(Date.now());
      expect(updated?.lastProgressAt).toBe(started?.lastProgressAt);
      expect(updated?.replyProduced).toBe(false);
      expect(updated?.lastDeliveryAttemptAt).toBeUndefined();
      observer.finishRun({ status: "done", phase: "done" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits active-tool progress instead of a stalled notice while a tool is still running", async () => {
    vi.useFakeTimers();
    try {
      const sessionKey = "agent:main:main";
      const sendWatcherPayload = vi.fn(
        async (_payload: ReplyPayload, _failureText: string) => true,
      );
      const observer: DeliveryObserver = createDeliveryObserver({
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
      expect(texts.some((text) => text.includes("still waiting for agent progress"))).toBe(false);

      observer.finishRun({ status: "done", phase: "done" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets later progress recover a previously noticed stalled turn", async () => {
    vi.useFakeTimers();
    try {
      const sessionKey = "agent:main:main";
      const sendWatcherPayload = vi.fn(
        async (_payload: ReplyPayload, _failureText: string) => true,
      );
      const observer = createDeliveryObserver({
        sessionKey,
        visibleChannel: "slack",
        trackedSessionId: "session-1",
        deliveryTarget: "same_channel",
        didMemoryFlushDuringTurn: () => false,
        onSendWatcherPayload: sendWatcherPayload,
      });

      observer.startRun("run-stalled-then-active");
      await vi.advanceTimersByTimeAsync(120_000);

      expect(
        sendWatcherPayload.mock.calls
          .map((call) => (call[0] as ReplyPayload | undefined)?.text ?? "")
          .filter((text) => text.includes("working: still waiting for agent progress")),
      ).toHaveLength(1);
      expect(getActiveTrackedTurn(sessionKey)?.phase).toBe("stalled");

      observer.updateActiveTurn({ markProgress: true, at: Date.now() });

      expect(getActiveTrackedTurn(sessionKey)?.phase).toBe("reasoning");
      expect(
        sendWatcherPayload.mock.calls
          .map((call) => (call[0] as ReplyPayload | undefined)?.text ?? "")
          .filter((text) => text.includes("working: still waiting for agent progress")),
      ).toHaveLength(1);

      observer.finishRun({ status: "done", phase: "done" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reschedules watcher payload failures without an unhandled rejection", async () => {
    vi.useFakeTimers();
    try {
      const sendWatcherPayload = vi
        .fn<(payload: ReplyPayload, failureText: string) => Promise<boolean>>()
        .mockRejectedValueOnce(new Error("watcher transport failed"))
        .mockResolvedValue(true);
      const observer = createDeliveryObserver({
        sessionKey: "agent:main:main",
        visibleChannel: "slack",
        trackedSessionId: "session-1",
        deliveryTarget: "same_channel",
        didMemoryFlushDuringTurn: () => false,
        onSendWatcherPayload: sendWatcherPayload,
      });

      observer.startRun("run-watcher-retry");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sendWatcherPayload).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(100_000);
      expect(sendWatcherPayload).toHaveBeenCalledTimes(2);

      observer.finishRun({ status: "done", phase: "done" });
      await vi.advanceTimersByTimeAsync(180_000);
      expect(sendWatcherPayload).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries watcher payloads that resolve false without marking the notice sent", async () => {
    vi.useFakeTimers();
    try {
      const sendWatcherPayload = vi
        .fn<(payload: ReplyPayload, failureText: string) => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true);
      const observer = createDeliveryObserver({
        sessionKey: "agent:main:main",
        visibleChannel: "slack",
        trackedSessionId: "session-1",
        deliveryTarget: "same_channel",
        didMemoryFlushDuringTurn: () => false,
        onSendWatcherPayload: sendWatcherPayload,
      });

      observer.startRun("run-watcher-false-retry");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sendWatcherPayload).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(100_000);
      expect(sendWatcherPayload).toHaveBeenCalledTimes(2);

      observer.finishRun({ status: "done", phase: "done" });
    } finally {
      vi.useRealTimers();
    }
  });
});
