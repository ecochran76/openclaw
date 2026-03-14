import { describe, expect, it, afterEach } from "vitest";
import {
  attachTrackedTurnRunId,
  buildTurnProgressLine,
  buildTurnStatusText,
  buildTurnSummaryLine,
  buildWhySilentText,
  finishTrackedTurn,
  resetTrackedTurnsForTests,
  startTrackedTurn,
  updateTrackedTurn,
} from "./turn-tracker.js";

afterEach(() => {
  resetTrackedTurnsForTests();
});

describe("turn tracker", () => {
  it("tracks active turn state and formats status text", () => {
    const turn = startTrackedTurn({
      sessionKey: "agent:main:main",
      channel: "slack",
      startedAt: 0,
      phase: "reasoning",
    });
    attachTrackedTurnRunId(turn.turnId, "run-123456789");
    updateTrackedTurn(turn.turnId, {
      phase: "tool_wait",
      activeTool: "exec",
      markProgress: true,
      at: 25_000,
    });
    updateTrackedTurn(turn.turnId, {
      markVisible: true,
      deliveryState: "block_sent",
      deliveryTarget: "same_channel",
      lastDeliveryAttemptAt: 29_000,
      lastDeliverySuccessAt: 30_000,
      replyProduced: true,
      at: 30_000,
    });

    const text = buildTurnStatusText({
      active: {
        ...turn,
        runId: "run-123456789",
        phase: "tool_wait",
        activeTool: "exec",
        lastProgressAt: 25_000,
        lastUserVisibleUpdateAt: 30_000,
        lastDeliveryAttemptAt: 29_000,
        lastDeliverySuccessAt: 30_000,
        deliveryState: "block_sent",
        deliveryTarget: "same_channel",
        replyProduced: true,
        durationClass: "medium",
      },
      now: 70_000,
    });

    expect(text).toContain("State: active");
    expect(text).toContain("Phase: tool wait");
    expect(text).toContain("Tool: exec");
    expect(text).toContain("Reply produced: yes");
    expect(text).toContain("Delivery: block sent");
    expect(text).toContain("Delivery target: same channel");
    expect(text).toContain("Run: run-1234");
    expect(
      buildTurnSummaryLine({
        active: {
          ...turn,
          phase: "tool_wait",
          activeTool: "exec",
          status: "active",
          durationClass: "medium",
          deliveryState: "block_sent",
          replyProduced: true,
          lastProgressAt: 25_000,
          lastUserVisibleUpdateAt: 30_000,
          startedAt: 0,
          updatedAt: 30_000,
          steerable: true,
        },
      }),
    ).toBe("🧭 Turn: active · tool wait · medium · block sent · exec");
    expect(
      buildTurnProgressLine({
        ...turn,
        phase: "tool_wait",
        activeTool: "exec",
        status: "active",
        durationClass: "medium",
        lastProgressAt: 25_000,
        updatedAt: 25_000,
        startedAt: 0,
        steerable: true,
      }),
    ).toBe("working: tool wait (exec)");
  });

  it("formats recent completed turn when no active turn exists", () => {
    const turn = startTrackedTurn({ sessionKey: "agent:main:main", startedAt: 0 });
    finishTrackedTurn({ turnId: turn.turnId, completedAt: 10_000, status: "done" });

    const text = buildTurnStatusText({
      recent: {
        ...turn,
        completedAt: 10_000,
        updatedAt: 10_000,
        lastProgressAt: 10_000,
        status: "done",
        phase: "done",
        durationClass: "short",
        steerable: true,
      },
      now: 20_000,
    });

    expect(text).toContain("State: done");
    expect(text).toContain("Phase: done");
  });

  it("explains silence reasons for active and recent turns", () => {
    const activeTurn = startTrackedTurn({
      sessionKey: "agent:main:main",
      channel: "slack",
      startedAt: 0,
      phase: "tool_wait",
    });
    updateTrackedTurn(activeTurn.turnId, {
      activeTool: "exec",
      deliveryState: "delivery_failed",
      deliveryTarget: "originating_channel",
      lastDeliveryAttemptAt: 20_000,
      lastDeliveryError: "route-reply failed",
      replyProduced: true,
      markProgress: true,
      at: 20_000,
    });
    const activeWhy = buildWhySilentText({
      active: {
        ...activeTurn,
        phase: "tool_wait",
        activeTool: "exec",
        deliveryState: "delivery_failed",
        deliveryTarget: "originating_channel",
        lastDeliveryAttemptAt: 20_000,
        lastDeliveryError: "route-reply failed",
        replyProduced: true,
        lastProgressAt: 20_000,
        durationClass: "medium",
        status: "active",
        steerable: true,
      },
      now: 30_000,
    });
    expect(activeWhy).toContain("the reply was produced, but delivery failed");
    expect(activeWhy).toContain("Delivery target: originating channel");
    expect(activeWhy).toContain("Delivery error: route-reply failed");

    const recentWhy = buildWhySilentText({
      recent: {
        ...activeTurn,
        completedAt: 40_000,
        updatedAt: 40_000,
        lastProgressAt: 40_000,
        status: "done",
        phase: "done",
        deliveryState: "suppressed",
        durationClass: "medium",
        steerable: true,
      },
      now: 50_000,
    });
    expect(recentWhy).toContain("intentionally produced no user-visible reply");
    expect(recentWhy).toContain("Delivery: suppressed");
  });
});
