import { describe, expect, it, vi } from "vitest";
import { runPingPongLoop } from "./ping-pong-loop.js";

describe("ping-pong-loop", () => {
  it("returns immediately when ping-pong is not applicable", async () => {
    const runAgentStep = vi.fn();
    const callGateway = vi.fn();

    const result = await runPingPongLoop(
      {
        runContextId: "run-1",
        latestReply: "initial",
        targetChannel: "discord",
        targetSessionKey: "agent:target:main",
        displayKey: "agent:target:main",
        maxPingPongTurns: 0,
      },
      { runAgentStep, callGateway },
    );

    expect(result).toEqual({
      latestReply: "initial",
      relayTargets: [],
      requiredFailure: false,
    });
    expect(runAgentStep).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("alternates reply turns and returns the final latest reply", async () => {
    const runAgentStep = vi.fn().mockResolvedValueOnce("pong-1").mockResolvedValueOnce("pong-2");

    const result = await runPingPongLoop(
      {
        runContextId: "run-1",
        latestReply: "initial",
        targetChannel: "discord",
        targetSessionKey: "discord:group:target",
        displayKey: "discord:group:target",
        requesterSessionKey: "discord:group:req",
        requesterChannel: "discord",
        announceTimeoutMs: 1_000,
        maxPingPongTurns: 2,
      },
      { runAgentStep },
    );

    expect(result).toEqual({
      latestReply: "pong-2",
      relayTargets: [],
      requiredFailure: false,
    });
    expect(runAgentStep).toHaveBeenCalledTimes(2);
    expect(runAgentStep).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionKey: "discord:group:req",
        message: "initial",
      }),
    );
    expect(runAgentStep).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionKey: "discord:group:target",
        message: "pong-1",
      }),
    );
  });

  it("mirrors reply turns when relay mirrorTurns is all", async () => {
    const runAgentStep = vi.fn().mockResolvedValueOnce("pong-1");
    const callGateway = vi.fn(async () => ({ messageId: "m-1" }));

    const result = await runPingPongLoop(
      {
        runContextId: "run-1",
        latestReply: "initial",
        targetChannel: "discord",
        targetSessionKey: "discord:group:target",
        displayKey: "discord:group:target",
        requesterSessionKey: "discord:group:req",
        requesterChannel: "discord",
        announceTimeoutMs: 1_000,
        maxPingPongTurns: 1,
        relayPolicy: {
          enabled: true,
          mode: "target-only",
          mirrorTurns: "all",
          verbosity: "sender-message",
          requireDelivery: false,
        },
        targetRelayTarget: {
          channel: "discord",
          to: "group:target",
        },
        requesterAgentId: "requester",
        targetAgentId: "target",
      },
      { runAgentStep, callGateway },
    );

    expect(result.latestReply).toBe("pong-1");
    expect(result.requiredFailure).toBe(false);
    expect(result.relayTargets).toEqual([
      expect.objectContaining({
        role: "target",
        status: "sent",
        to: "group:target",
      }),
    ]);
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "send",
      }),
    );
  });

  it("stops and reports required failure when mirrored relay delivery blocks", async () => {
    const runAgentStep = vi.fn().mockResolvedValueOnce("pong-1");
    const callGateway = vi.fn(async () => {
      throw new Error("relay send failed");
    });

    const result = await runPingPongLoop(
      {
        runContextId: "run-1",
        latestReply: "initial",
        targetChannel: "discord",
        targetSessionKey: "discord:group:target",
        displayKey: "discord:group:target",
        requesterSessionKey: "discord:group:req",
        requesterChannel: "discord",
        announceTimeoutMs: 1_000,
        maxPingPongTurns: 1,
        relayPolicy: {
          enabled: true,
          mode: "target-only",
          mirrorTurns: "all",
          verbosity: "sender-message",
          requireDelivery: true,
        },
        targetRelayTarget: {
          channel: "discord",
          to: "group:target",
        },
      },
      { runAgentStep, callGateway },
    );

    expect(result.latestReply).toBe("pong-1");
    expect(result.requiredFailure).toBe(true);
    expect(result.relayTargets).toEqual([
      expect.objectContaining({
        role: "target",
        status: "blocked",
        error: "relay send failed",
      }),
    ]);
  });
});
