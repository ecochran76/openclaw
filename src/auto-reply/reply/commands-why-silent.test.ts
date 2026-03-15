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
  it("explains a stalled active turn", async () => {
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

    const params = buildCommandTestParams("/why-silent", {} as OpenClawConfig, {
      Provider: "slack",
      Surface: "slack",
    });

    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("turn appears stalled");
    expect(result.reply?.text).toContain("Phase: stalled");
    expect(result.reply?.text).toContain("Stalled threshold:");
  });

  it("explains a maintenance suppressed active turn", async () => {
    const turn = startTrackedTurn({
      sessionKey: "agent:main:main",
      channel: "slack",
      phase: "done",
      startedAt: Date.now() - 60_000,
    });
    updateTrackedTurn(turn.turnId, {
      markProgress: true,
      deliveryState: "suppressed",
      suppressionReason: "maintenance",
    });

    const params = buildCommandTestParams("/why-silent", {} as OpenClawConfig, {
      Provider: "slack",
      Surface: "slack",
    });

    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("maintenance-only turn");
    expect(result.reply?.text).toContain("intentionally produced no visible reply");
    expect(result.reply?.text).toContain("Suppression: maintenance turn");
  });
});
