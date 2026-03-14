import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  attachTrackedTurnRunId,
  recordTrackedTurnSteer,
  resetTrackedTurnsForTests,
  startTrackedTurn,
  updateTrackedTurn,
} from "../turn-tracker.js";
import { handleCommands } from "./commands.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

afterEach(() => {
  resetTrackedTurnsForTests();
});

describe("/turn-status", () => {
  it("reports when there is no active turn", async () => {
    const params = buildCommandTestParams("/turn-status", {} as OpenClawConfig, {
      Provider: "slack",
      Surface: "slack",
    });

    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("No active turn");
  });

  it("reports active turn details", async () => {
    const turn = startTrackedTurn({
      sessionKey: "agent:main:main",
      channel: "slack",
      phase: "reasoning",
      startedAt: Date.now() - 30_000,
    });
    attachTrackedTurnRunId(turn.turnId, "run-abcdef12");
    updateTrackedTurn(turn.turnId, {
      phase: "tool_wait",
      activeTool: "browser",
      replyProduced: true,
      deliveryState: "delivery_failed",
      deliveryTarget: "originating_channel",
      lastDeliveryAttemptAt: Date.now() - 5_000,
      lastDeliveryError: "route-reply failed",
      markProgress: true,
      markVisible: true,
    });
    recordTrackedTurnSteer(turn.turnId, {
      text: "skip polish and run tests first",
      at: Date.now() - 2_000,
    });

    const params = buildCommandTestParams("/turn-status", {} as OpenClawConfig, {
      Provider: "slack",
      Surface: "slack",
    });

    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("State: active");
    expect(result.reply?.text).toContain("Steers: 1");
    expect(result.reply?.text).toContain("Last steer:");
    expect(result.reply?.text).toContain("Last steer text: skip polish and run tests first");
    expect(result.reply?.text).toContain("Tool: browser");
    expect(result.reply?.text).toContain("Reply produced: yes");
    expect(result.reply?.text).toContain("Delivery: delivery failed");
    expect(result.reply?.text).toContain("Delivery target: originating channel");
    expect(result.reply?.text).toContain("Delivery error: route-reply failed");
    expect(result.reply?.text).toContain("Run: run-abcd");
  });

  it("reports maintenance suppression details", async () => {
    const turn = startTrackedTurn({
      sessionKey: "agent:main:main",
      channel: "slack",
      phase: "done",
      startedAt: Date.now() - 30_000,
    });
    updateTrackedTurn(turn.turnId, {
      replyProduced: false,
      deliveryState: "suppressed",
      suppressionReason: "maintenance",
      markProgress: true,
      markVisible: false,
    });

    const params = buildCommandTestParams("/turn-status", {} as OpenClawConfig, {
      Provider: "slack",
      Surface: "slack",
    });

    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Delivery: suppressed");
    expect(result.reply?.text).toContain("Suppression: maintenance turn");
  });
});
