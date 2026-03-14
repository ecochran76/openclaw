import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => {
  resetTrackedTurnsForTests();
});

describe("/turns and /nudge", () => {
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
});
