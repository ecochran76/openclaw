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
        turnId: "request",
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

  it("blocks required delivery when verbosity none suppresses the relay payload", async () => {
    const callGateway = vi.fn();

    const result = await relayTurn(
      {
        runContextId: "run-none",
        turnId: "request",
        relayPolicy: { ...basePolicy, verbosity: "none", requireDelivery: true },
        targetRelayTarget: { channel: "slack", to: "channel:C123" },
        fromAgent: "main",
        toAgent: "dev-openclaw",
        text: "hello",
      },
      { callGateway, logger: createLogger() },
    );

    expect(result).toEqual({
      status: "blocked",
      requiredFailure: true,
      targets: [
        {
          role: "target",
          status: "blocked",
          error: "Relay verbosity 'none' suppresses required delivery.",
        },
      ],
    });
    expect(callGateway).not.toHaveBeenCalled();
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
        turnId: "request",
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

  it("uses a stable idempotency key per logical turn and distinct keys across turns", async () => {
    const callGateway = vi.fn(async () => ({ messageId: "m-relay" }));
    const relay = (turnId: string) =>
      relayTurn(
        {
          runContextId: "run-stable",
          turnId,
          relayPolicy: basePolicy,
          targetRelayTarget: { channel: "slack", to: "channel:C123" },
          fromAgent: "main",
          toAgent: "dev-openclaw",
          text: "hello",
        },
        { callGateway, logger: createLogger() },
      );

    await relay("ping-pong-1");
    await relay("ping-pong-1");
    await relay("ping-pong-2");

    const keys = callGateway.mock.calls.map(
      ([request]) => (request.params as { idempotencyKey?: string }).idempotencyKey,
    );
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});
