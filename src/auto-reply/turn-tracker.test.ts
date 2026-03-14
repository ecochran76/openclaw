import { describe, expect, it, afterEach } from "vitest";
import {
  attachTrackedTurnRunId,
  buildNudgeText,
  buildTurnProgressLine,
  buildTurnsText,
  buildTurnStatusText,
  buildTurnSummaryLine,
  buildWhySilentText,
  recordTrackedTurnSteer,
  finishTrackedTurn,
  getRecentTrackedTurns,
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
    recordTrackedTurnSteer(turn.turnId, {
      text: "focus on the failing delivery path only",
      at: 35_000,
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
        steerCount: 1,
        lastSteerAt: 35_000,
        lastSteerText: "focus on the failing delivery path only",
        durationClass: "medium",
      },
      now: 70_000,
    });

    expect(text).toContain("State: active");
    expect(text).toContain("Phase: tool wait");
    expect(text).toContain("Steers: 1");
    expect(text).toContain("Last steer: 35s ago");
    expect(text).toContain("Last steer text: focus on the failing delivery path only");
    expect(text).toContain("Tool: exec");
    expect(text).toContain("Steers: 1");
    expect(text).toContain("Last steer: 35s ago");
    expect(text).toContain("Last steer text: focus on the failing delivery path only");
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
        now: 70_000,
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
        suppressionReason: "maintenance",
        durationClass: "medium",
        steerable: true,
      },
      now: 50_000,
    });
    expect(recentWhy).toContain("maintenance-only turn");
    expect(recentWhy).toContain("Delivery: suppressed");
    expect(recentWhy).toContain("Suppression: maintenance turn");
  });
  it("lists recent turns and builds nudge text", () => {
    const first = startTrackedTurn({
      sessionKey: "agent:main:main",
      startedAt: 0,
      phase: "reasoning",
    });
    finishTrackedTurn({
      turnId: first.turnId,
      completedAt: 5_000,
      status: "done",
      deliveryState: "final_sent",
    });
    const second = startTrackedTurn({
      sessionKey: "agent:main:main",
      startedAt: 10_000,
      phase: "tool_wait",
    });
    finishTrackedTurn({
      turnId: second.turnId,
      completedAt: 40_000,
      status: "error",
      phase: "error",
      deliveryState: "delivery_failed",
    });
    const active = startTrackedTurn({
      sessionKey: "agent:main:main",
      startedAt: 50_000,
      phase: "tool_wait",
      channel: "slack",
    });
    updateTrackedTurn(active.turnId, { activeTool: "exec", markProgress: true, at: 60_000 });

    const recent = getRecentTrackedTurns("agent:main:main");
    expect(recent).toHaveLength(2);
    const turnsText = buildTurnsText({
      active: {
        ...active,
        activeTool: "exec",
        lastProgressAt: 60_000,
        durationClass: "short",
        steerable: true,
        steerCount: 1,
        status: "active",
      },
      recents: recent,
      now: 70_000,
    });
    expect(turnsText).toContain("🧭 Turns");
    expect(turnsText).toContain(
      "active · tool wait · medium · reply pending · steerable · steers:1 · exec",
    );
    expect(turnsText).toContain("error · error · medium · delivery failed");
    expect(turnsText).toContain("done · done · short · final sent");

    const turnsWithSuppression = buildTurnsText({
      recents: [
        {
          ...second,
          status: "error",
          phase: "error",
          completedAt: 40_000,
          durationClass: "medium",
          deliveryState: "suppressed",
          suppressionReason: "maintenance",
        },
      ],
      now: 70_000,
    });
    expect(turnsWithSuppression).toContain(
      "error · error · medium · suppressed · maintenance turn",
    );

    const nudge = buildNudgeText({
      active: {
        ...active,
        activeTool: "exec",
        lastProgressAt: 60_000,
        durationClass: "short",
        steerable: true,
        status: "active",
      },
      now: 70_000,
    });
    expect(nudge).toContain("working: tool wait (exec)");
    expect(nudge).toContain("Last progress: 10s ago");
  });

  it("derives stalled state for long-silent active turns", () => {
    const turn = startTrackedTurn({
      sessionKey: "agent:main:main",
      startedAt: 0,
      phase: "tool_wait",
      channel: "slack",
    });
    updateTrackedTurn(turn.turnId, {
      activeTool: "exec",
      markProgress: true,
      at: 0,
    });

    const status = buildTurnStatusText({
      active: {
        ...turn,
        activeTool: "exec",
        lastProgressAt: 0,
        status: "active",
        steerable: true,
      },
      now: 180_000,
    });
    expect(status).toContain("Phase: stalled");
    expect(status).toContain("Stalled threshold:");

    const why = buildWhySilentText({
      active: {
        ...turn,
        activeTool: "exec",
        lastProgressAt: 0,
        status: "active",
        steerable: true,
      },
      now: 180_000,
    });
    expect(why).toContain("turn appears stalled");

    const turns = buildTurnsText({
      active: {
        ...turn,
        activeTool: "exec",
        lastProgressAt: 0,
        status: "active",
        steerable: true,
      },
      now: 180_000,
    });
    expect(turns).toContain("active · stalled · long · reply pending · steerable · exec");

    const nudge = buildNudgeText({
      active: {
        ...turn,
        activeTool: "exec",
        lastProgressAt: 0,
        status: "active",
        steerable: true,
      },
      now: 180_000,
    });
    expect(nudge).toContain("stalled: no recent progress (exec)");
    expect(nudge).toContain("Stalled threshold:");
  });

  it("lists recent turns and builds nudge text", () => {
    const first = startTrackedTurn({
      sessionKey: "agent:main:main",
      startedAt: 0,
      phase: "reasoning",
    });
    finishTrackedTurn({
      turnId: first.turnId,
      completedAt: 5_000,
      status: "done",
      deliveryState: "final_sent",
    });
    const second = startTrackedTurn({
      sessionKey: "agent:main:main",
      startedAt: 10_000,
      phase: "tool_wait",
    });
    finishTrackedTurn({
      turnId: second.turnId,
      completedAt: 40_000,
      status: "error",
      phase: "error",
      deliveryState: "delivery_failed",
    });
    const active = startTrackedTurn({
      sessionKey: "agent:main:main",
      startedAt: 50_000,
      phase: "tool_wait",
      channel: "slack",
    });
    updateTrackedTurn(active.turnId, { activeTool: "exec", markProgress: true, at: 60_000 });

    const recent = getRecentTrackedTurns("agent:main:main");
    expect(recent).toHaveLength(2);
    const turnsText = buildTurnsText({
      active: {
        ...active,
        activeTool: "exec",
        lastProgressAt: 60_000,
        durationClass: "short",
        steerable: true,
        steerCount: 1,
        status: "active",
      },
      recents: recent,
      now: 70_000,
    });
    expect(turnsText).toContain("🧭 Turns");
    expect(turnsText).toContain(
      "active · tool wait · medium · reply pending · steerable · steers:1 · exec",
    );
    expect(turnsText).toContain("error · error · medium · delivery failed");
    expect(turnsText).toContain("done · done · short · final sent");

    const nudge = buildNudgeText({
      active: {
        ...active,
        activeTool: "exec",
        lastProgressAt: 60_000,
        durationClass: "short",
        steerable: true,
        status: "active",
      },
      now: 70_000,
    });
    expect(nudge).toContain("working: tool wait (exec)");
    expect(nudge).toContain("Last progress: 10s ago");
  });

  it("derives stalled state for long-silent active turns", () => {
    const turn = startTrackedTurn({
      sessionKey: "agent:main:main",
      startedAt: 0,
      phase: "tool_wait",
      channel: "slack",
    });
    updateTrackedTurn(turn.turnId, {
      activeTool: "exec",
      markProgress: true,
      at: 0,
    });

    const status = buildTurnStatusText({
      active: {
        ...turn,
        activeTool: "exec",
        lastProgressAt: 0,
        status: "active",
        steerable: true,
      },
      now: 180_000,
    });
    expect(status).toContain("Phase: stalled");
    expect(status).toContain("Stalled threshold:");

    const why = buildWhySilentText({
      active: {
        ...turn,
        activeTool: "exec",
        lastProgressAt: 0,
        status: "active",
        steerable: true,
      },
      now: 180_000,
    });
    expect(why).toContain("turn appears stalled");

    const turns = buildTurnsText({
      active: {
        ...turn,
        activeTool: "exec",
        lastProgressAt: 0,
        status: "active",
        steerable: true,
      },
      now: 180_000,
    });
    expect(turns).toContain("active · stalled · long · reply pending · steerable · exec");

    const nudge = buildNudgeText({
      active: {
        ...turn,
        activeTool: "exec",
        lastProgressAt: 0,
        status: "active",
        steerable: true,
      },
      now: 180_000,
    });
    expect(nudge).toContain("stalled: no recent progress (exec)");
    expect(nudge).toContain("Stalled threshold:");
  });
});
