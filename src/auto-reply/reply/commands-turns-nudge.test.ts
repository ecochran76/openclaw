import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  finishTrackedTurn,
  getActiveTrackedTurn,
  resetTrackedTurnsForTests,
  startTrackedTurn,
  updateTrackedTurn,
} from "../turn-tracker.js";
import { handleCommands } from "./commands.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const queueEmbeddedPiMessageMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("../../agents/pi-embedded.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/pi-embedded.js")>(
    "../../agents/pi-embedded.js",
  );
  return {
    ...actual,
    queueEmbeddedPiMessage: queueEmbeddedPiMessageMock,
  };
});

afterEach(() => {
  resetTrackedTurnsForTests();
  queueEmbeddedPiMessageMock.mockReset();
  queueEmbeddedPiMessageMock.mockReturnValue(false);
});

describe("/turns, /nudge, and /turn-steer", () => {
  it("lists active and recent turns", async () => {
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
    const active = startTrackedTurn({
      sessionKey: "agent:main:main",
      channel: "slack",
      phase: "tool_wait",
      startedAt: Date.now() - 20_000,
    });
    updateTrackedTurn(active.turnId, {
      activeTool: "browser",
      markProgress: true,
    });

    const params = buildCommandTestParams("/turns", {} as OpenClawConfig, {
      Provider: "slack",
      Surface: "slack",
    });

    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("🧭 Turns");
    expect(result.reply?.text).toContain("active · tool wait");
    expect(result.reply?.text).toContain("browser");
    expect(result.reply?.text).toContain("done · done");
  });

  it("nudges the active turn and marks it visibly updated", async () => {
    const turn = startTrackedTurn({
      sessionKey: "agent:main:main",
      channel: "slack",
      phase: "tool_wait",
      startedAt: Date.now() - 20_000,
    });
    updateTrackedTurn(turn.turnId, {
      activeTool: "exec",
      markProgress: true,
    });

    const before = getActiveTrackedTurn("agent:main:main");
    const params = buildCommandTestParams("/nudge", {} as OpenClawConfig, {
      Provider: "slack",
      Surface: "slack",
    });

    const result = await handleCommands(params);
    const after = getActiveTrackedTurn("agent:main:main");

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("🧭 Nudge");
    expect(result.reply?.text).toContain("working: tool wait (exec)");
    expect(after?.lastUserVisibleUpdateAt).toBeDefined();
    expect((after?.lastUserVisibleUpdateAt ?? 0) >= (before?.lastUserVisibleUpdateAt ?? 0)).toBe(
      true,
    );
  });

  it("nudges stalled active turns as stalled", async () => {
    const turn = startTrackedTurn({
      sessionKey: "agent:main:main",
      channel: "slack",
      phase: "tool_wait",
      startedAt: Date.now() - 180_000,
    });
    updateTrackedTurn(turn.turnId, {
      activeTool: "exec",
      markProgress: true,
      at: Date.now() - 180_000,
    });

    const params = buildCommandTestParams("/nudge", {} as OpenClawConfig, {
      Provider: "slack",
      Surface: "slack",
    });

    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("stalled: no recent progress (exec)");
    expect(result.reply?.text).toContain("Stalled threshold:");
  });

  it("shows turn-steer usage when text is missing", async () => {
    const params = buildCommandTestParams("/turn-steer", {} as OpenClawConfig, {
      Provider: "slack",
      Surface: "slack",
    });

    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toBe("🧭 Turn steer\nUsage: /turn-steer <text>");
  });

  it("targets only the active steerable turn for the current session", async () => {
    startTrackedTurn({
      sessionKey: "agent:other:main",
      sessionId: "session-other-1",
      channel: "slack",
      phase: "tool_wait",
      startedAt: Date.now() - 20_000,
      steerable: true,
    });

    const params = buildCommandTestParams(
      "/turn-steer focus on tests first",
      {} as OpenClawConfig,
      {
        Provider: "slack",
        Surface: "slack",
      },
    );

    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toBe("🧭 Turn steer\nNo active steerable turn for this session.");
    expect(queueEmbeddedPiMessageMock).not.toHaveBeenCalled();
  });

  it("reports when the active turn cannot accept live steering right now", async () => {
    const turn = startTrackedTurn({
      sessionKey: "agent:main:main",
      sessionId: "session-steer-1",
      channel: "slack",
      phase: "tool_wait",
      startedAt: Date.now() - 20_000,
      steerable: true,
    });
    updateTrackedTurn(turn.turnId, {
      activeTool: "exec",
      markProgress: true,
    });

    const params = buildCommandTestParams(
      "/turn-steer focus on tests first",
      {} as OpenClawConfig,
      {
        Provider: "slack",
        Surface: "slack",
      },
    );

    const result = await handleCommands(params);
    const active = getActiveTrackedTurn("agent:main:main");

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toBe(
      "🧭 Turn steer\nActive turn is not accepting live steering right now.",
    );
    expect(queueEmbeddedPiMessageMock).toHaveBeenCalledWith(
      "session-steer-1",
      "focus on tests first",
    );
    expect(active?.steerCount).toBeUndefined();
  });

  it("steers the active tracked turn and records steering metadata", async () => {
    queueEmbeddedPiMessageMock.mockReturnValue(true);
    const turn = startTrackedTurn({
      sessionKey: "agent:main:main",
      sessionId: "session-steer-1",
      channel: "slack",
      phase: "tool_wait",
      startedAt: Date.now() - 20_000,
      steerable: true,
    });
    updateTrackedTurn(turn.turnId, {
      activeTool: "exec",
      markProgress: true,
    });

    const params = buildCommandTestParams(
      "/turn-steer run tests before more edits",
      {} as OpenClawConfig,
      {
        Provider: "slack",
        Surface: "slack",
      },
    );

    const result = await handleCommands(params);
    const active = getActiveTrackedTurn("agent:main:main");

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toBe(
      "🧭 Turn steer\nSent to active turn.\nInstruction: run tests before more edits",
    );
    expect(queueEmbeddedPiMessageMock).toHaveBeenCalledWith(
      "session-steer-1",
      "run tests before more edits",
    );
    expect(active?.steerCount).toBe(1);
    expect(active?.lastSteerText).toBe("run tests before more edits");
    expect(active?.lastSteerAt).toBeDefined();
  });
});
