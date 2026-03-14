import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resetTrackedTurnsForTests, startTrackedTurn, updateTrackedTurn } from "../turn-tracker.js";
import { handleCommands } from "./commands.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

afterEach(() => {
  resetTrackedTurnsForTests();
});

describe("/why-silent", () => {
  it("reports when there is no active or recent turn", async () => {
    const params = buildCommandTestParams("/why-silent", {} as OpenClawConfig, {
      Provider: "slack",
      Surface: "slack",
    });

    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("No active or recent turn");
  });

  it("explains a delivery-failed active turn", async () => {
    const turn = startTrackedTurn({
      sessionKey: "agent:main:main",
      channel: "slack",
      phase: "tool_wait",
      startedAt: Date.now() - 30_000,
    });
    updateTrackedTurn(turn.turnId, {
      activeTool: "browser",
      replyProduced: true,
      deliveryState: "delivery_failed",
      deliveryTarget: "originating_channel",
      lastDeliveryAttemptAt: Date.now() - 5_000,
      lastDeliveryError: "route-reply failed",
      markProgress: true,
      markVisible: true,
    });

    const params = buildCommandTestParams("/why-silent", {} as OpenClawConfig, {
      Provider: "slack",
      Surface: "slack",
    });

    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("delivery failed");
    expect(result.reply?.text).toContain("Tool: browser");
    expect(result.reply?.text).toContain("Delivery target: originating channel");
    expect(result.reply?.text).toContain("Delivery error: route-reply failed");
  });
});
