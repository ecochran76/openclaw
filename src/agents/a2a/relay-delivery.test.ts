import { describe, expect, it, vi } from "vitest";
import type { RelayPolicy } from "../tools/sessions-send-helpers.js";
import { buildRelaySummary, relayTurn, type RelayDeliveryLogger } from "./relay-delivery.js";

const basePolicy: RelayPolicy = {
  enabled: true,
  mode: "target-only",
  mirrorTurns: "round1",
  verbosity: "sender-message",
  requireDelivery: false,
};

function createLogger(): RelayDeliveryLogger {
  return {
    warn: vi.fn(),
  };
}

describe("relay-delivery", () => {
  it("builds a sent summary when all targets succeed", () => {
    const summary = buildRelaySummary({
      policy: basePolicy,
      targets: [{ role: "target", status: "sent", channel: "slack", to: "channel:C123" }],
    });

    expect(summary).toEqual({
      status: "sent",
      mode: "target-only",
      mirrorTurns: "round1",
      targets: [{ role: "target", status: "sent", channel: "slack", to: "channel:C123" }],
    });
  });

  it("returns blocked on strict target-only delivery failure", async () => {
    const logger = createLogger();
    const callGateway = vi.fn(async () => {
      throw new Error("relay send failed");
    });

    const result = await relayTurn(
      {
        runContextId: "run-1",
        relayPolicy: { ...basePolicy, requireDelivery: true },
        targetRelayTarget: { channel: "slack", to: "channel:C123" },
        fromAgent: "main",
        toAgent: "dev-openclaw",
        text: "hello",
      },
      { callGateway, logger },
    );

    expect(result).toMatchObject({
      status: "blocked",
      requiredFailure: true,
      targets: [
        {
          role: "target",
          status: "blocked",
          error: "relay send failed",
        },
      ],
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("returns partial on dual-channel best-effort mixed delivery", async () => {
    const logger = createLogger();
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "m-source", threadId: "171" })
      .mockRejectedValueOnce(new Error("target delivery failed"));

    const result = await relayTurn(
      {
        runContextId: "run-2",
        relayPolicy: {
          ...basePolicy,
          mode: "dual-channel",
          mirrorTurns: "all",
        },
        sourceRelayTarget: { channel: "slack", to: "channel:C-source", threadId: "170" },
        targetRelayTarget: { channel: "slack", to: "channel:C-target", threadId: "171" },
        fromAgent: "main",
        toAgent: "dev-openclaw",
        text: "hello",
      },
      { callGateway, logger },
    );

    expect(result.status).toBe("partial");
    expect(result.requiredFailure).toBe(false);
    expect(result.targets).toMatchObject([
      {
        role: "source",
        status: "sent",
        messageId: "m-source",
        threadId: "171",
      },
      {
        role: "target",
        status: "failed",
        error: "target delivery failed",
      },
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
