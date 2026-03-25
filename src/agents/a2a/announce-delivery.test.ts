import { describe, expect, it, vi } from "vitest";
import { deliverAnnounceStep } from "./announce-delivery.js";

describe("announce-delivery", () => {
  it("suppresses announce delivery for dual-channel relay", async () => {
    const runAgentStep = vi.fn();
    const callGateway = vi.fn();

    const result = await deliverAnnounceStep(
      {
        runContextId: "run-1",
        relayPolicy: {
          enabled: true,
          mode: "dual-channel",
          mirrorTurns: "round1",
          verbosity: "sender-message",
          requireDelivery: false,
        },
        announceTarget: {
          channel: "discord",
          to: "group:dev",
        },
        targetSessionKey: "agent:target:main",
        targetChannel: "discord",
        displayKey: "agent:target:main",
        originalMessage: "hello",
        latestReply: "reply",
        announceTimeoutMs: 1_000,
      },
      { runAgentStep, callGateway },
    );

    expect(result).toEqual({ status: "suppressed" });
    expect(runAgentStep).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("sends the announce reply when a target exists", async () => {
    const runAgentStep = vi.fn(async () => "announce payload");
    const callGateway = vi.fn(async () => ({ messageId: "m-1" }));

    const result = await deliverAnnounceStep(
      {
        runContextId: "run-1",
        relayPolicy: {
          enabled: true,
          mode: "target-only",
          mirrorTurns: "round1",
          verbosity: "sender-message",
          requireDelivery: false,
        },
        announceTarget: {
          channel: "discord",
          to: "group:dev",
          accountId: "default",
        },
        requesterSessionKey: "agent:requester:main",
        requesterChannel: "discord",
        targetSessionKey: "agent:target:main",
        targetChannel: "discord",
        displayKey: "agent:target:main",
        originalMessage: "hello",
        roundOneReply: "round one",
        latestReply: "latest",
        announceTimeoutMs: 1_000,
      },
      { runAgentStep, callGateway },
    );

    expect(result).toEqual({
      status: "sent",
      reply: "announce payload",
      messageId: "m-1",
    });
    expect(runAgentStep).toHaveBeenCalledOnce();
    expect(callGateway).toHaveBeenCalledWith({
      method: "send",
      params: {
        to: "group:dev",
        message: "announce payload",
        channel: "discord",
        accountId: "default",
        idempotencyKey: expect.any(String),
      },
      timeoutMs: 10_000,
    });
  });

  it("skips when the announce step returns ANNOUNCE_SKIP", async () => {
    const runAgentStep = vi.fn(async () => "ANNOUNCE_SKIP");
    const callGateway = vi.fn();

    const result = await deliverAnnounceStep(
      {
        runContextId: "run-1",
        targetSessionKey: "agent:target:main",
        targetChannel: "discord",
        displayKey: "agent:target:main",
        originalMessage: "hello",
        latestReply: "latest",
        announceTimeoutMs: 1_000,
      },
      { runAgentStep, callGateway },
    );

    expect(result).toEqual({
      status: "skipped",
      reply: "ANNOUNCE_SKIP",
    });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("logs and returns failed when send delivery fails", async () => {
    const runAgentStep = vi.fn(async () => "announce payload");
    const callGateway = vi.fn(async () => {
      throw new Error("send failed");
    });
    const logger = { warn: vi.fn() };

    const result = await deliverAnnounceStep(
      {
        runContextId: "run-1",
        announceTarget: {
          channel: "discord",
          to: "group:dev",
        },
        targetSessionKey: "agent:target:main",
        targetChannel: "discord",
        displayKey: "agent:target:main",
        originalMessage: "hello",
        latestReply: "latest",
        announceTimeoutMs: 1_000,
      },
      { runAgentStep, callGateway, logger },
    );

    expect(result).toEqual({
      status: "failed",
      reply: "announce payload",
      error: "send failed",
    });
    expect(logger.warn).toHaveBeenCalledWith("sessions_send announce delivery failed", {
      runId: "run-1",
      channel: "discord",
      to: "group:dev",
      error: "send failed",
    });
  });
});
