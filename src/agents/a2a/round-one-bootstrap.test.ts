import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayPolicy } from "../tools/sessions-send-helpers.js";
import { runRoundOneBootstrap, type RoundOneBootstrapDeps } from "./round-one-bootstrap.js";

const callGatewayMock = vi.fn();
const readLatestAssistantReplyMock = vi.fn();
const relayTurnMock = vi.fn();

const relayPolicy: RelayPolicy = {
  enabled: true,
  mode: "target-only",
  mirrorTurns: "round1",
  verbosity: "sender-message",
  requireDelivery: false,
};

function createDeps(): RoundOneBootstrapDeps {
  return {
    callGateway: (request) => callGatewayMock(request),
    readLatestAssistantReply: (request) => readLatestAssistantReplyMock(request),
    relayTurn: (params, deps) => relayTurnMock(params, deps),
  };
}

describe("round-one bootstrap", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    readLatestAssistantReplyMock.mockReset();
    relayTurnMock.mockReset();
  });

  it("waits for the target reply, relays the initial message, and mirrors the round-one reply", async () => {
    callGatewayMock.mockResolvedValueOnce({ status: "ok" });
    readLatestAssistantReplyMock.mockResolvedValueOnce("target reply");
    relayTurnMock.mockImplementation(async (params: { text: string }) => {
      if (params.text === "hello") {
        return {
          status: "sent",
          targets: [{ role: "target", status: "sent", channel: "slack", to: "channel:target" }],
          requiredFailure: false,
        };
      }
      if (params.text === "target reply") {
        return {
          status: "sent",
          targets: [{ role: "target", status: "sent", channel: "slack", to: "channel:reply" }],
          requiredFailure: false,
        };
      }
      throw new Error(`unexpected relay text: ${params.text}`);
    });

    const result = await runRoundOneBootstrap(
      {
        runContextId: "run-1",
        waitRunId: "wait-1",
        targetSessionKey: "agent:target:main",
        message: "hello",
        announceTimeoutMs: 2_500,
        relayPolicy,
        requesterAgentId: "source",
        targetAgentId: "target",
      },
      createDeps(),
    );

    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "agent.wait",
      params: {
        runId: "wait-1",
        timeoutMs: 2_500,
      },
      timeoutMs: 4_500,
    });
    expect(readLatestAssistantReplyMock).toHaveBeenCalledTimes(1);
    expect(readLatestAssistantReplyMock).toHaveBeenCalledWith({
      sessionKey: "agent:target:main",
    });
    expect(relayTurnMock).toHaveBeenCalledTimes(2);
    expect(relayTurnMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        runContextId: "run-1",
        fromAgent: "source",
        toAgent: "target",
        text: "hello",
      }),
      expect.objectContaining({ callGateway: expect.any(Function) }),
    );
    expect(relayTurnMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        runContextId: "run-1",
        fromAgent: "target",
        toAgent: "source",
        text: "target reply",
      }),
      expect.objectContaining({ callGateway: expect.any(Function) }),
    );
    expect(result).toEqual({
      primaryReply: "target reply",
      latestReply: "target reply",
      relayTargets: [
        { role: "target", status: "sent", channel: "slack", to: "channel:target" },
        { role: "target", status: "sent", channel: "slack", to: "channel:reply" },
      ],
      requiredFailure: false,
    });
  });

  it("skips the wait/read step when the round-one reply is already provided", async () => {
    relayTurnMock.mockResolvedValue({
      status: "sent",
      targets: [{ role: "target", status: "sent", channel: "slack", to: "channel:sent" }],
      requiredFailure: false,
    });

    const result = await runRoundOneBootstrap(
      {
        runContextId: "run-2",
        waitRunId: "wait-2",
        targetSessionKey: "agent:target:main",
        message: "hello",
        announceTimeoutMs: 1_000,
        relayPolicy: { ...relayPolicy, mirrorTurns: "all" },
        roundOneReply: "already-known",
      },
      createDeps(),
    );

    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(readLatestAssistantReplyMock).not.toHaveBeenCalled();
    expect(relayTurnMock).toHaveBeenCalledTimes(2);
    expect(relayTurnMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        runContextId: "run-2",
        fromAgent: "requester",
        toAgent: "target",
        text: "hello",
      }),
      expect.objectContaining({ callGateway: expect.any(Function) }),
    );
    expect(relayTurnMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        runContextId: "run-2",
        fromAgent: "target",
        toAgent: "requester",
        text: "already-known",
      }),
      expect.objectContaining({ callGateway: expect.any(Function) }),
    );
    expect(result).toEqual({
      primaryReply: "already-known",
      latestReply: "already-known",
      relayTargets: [
        { role: "target", status: "sent", channel: "slack", to: "channel:sent" },
        { role: "target", status: "sent", channel: "slack", to: "channel:sent" },
      ],
      requiredFailure: false,
    });
  });

  it("returns early when the initial relay is required to fail", async () => {
    readLatestAssistantReplyMock.mockResolvedValueOnce("target reply");
    relayTurnMock.mockResolvedValueOnce({
      status: "blocked",
      targets: [{ role: "target", status: "blocked", error: "relay blocked" }],
      requiredFailure: true,
    });

    const result = await runRoundOneBootstrap(
      {
        runContextId: "run-3",
        targetSessionKey: "agent:target:main",
        message: "hello",
        announceTimeoutMs: 1_000,
        relayPolicy: { ...relayPolicy, mirrorTurns: "all", requireDelivery: true },
        roundOneReply: "target reply",
      },
      createDeps(),
    );

    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(readLatestAssistantReplyMock).not.toHaveBeenCalled();
    expect(relayTurnMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      primaryReply: "target reply",
      latestReply: "target reply",
      relayTargets: [{ role: "target", status: "blocked", error: "relay blocked" }],
      requiredFailure: true,
    });
  });
});
