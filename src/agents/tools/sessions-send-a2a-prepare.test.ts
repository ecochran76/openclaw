import { describe, expect, it, vi } from "vitest";
import { prepareSessionsSendA2AFlow } from "./sessions-send-a2a-prepare.js";

describe("flow-prepare", () => {
  it("prepares flow params and default relay through the injected announce target resolver", async () => {
    const resolveAnnounceTargetMock = vi.fn(async ({ sessionKey }: { sessionKey: string }) => {
      if (sessionKey === "agent:source-agent:source") {
        return {
          channel: "slack",
          to: "source-room",
          accountId: "default",
        };
      }
      return {
        channel: "discord",
        to: "group:dev",
        accountId: "default",
        threadId: "7",
      };
    });

    const prepared = await prepareSessionsSendA2AFlow(
      {
        targetSessionKey: "agent:target-agent:target",
        displayKey: "agent:target-agent:target",
        message: "hello",
        announceTimeoutMs: 1_000,
        maxPingPongTurns: 0,
        timeoutSeconds: 0,
        relayPolicy: {
          enabled: true,
          mode: "dual-channel",
          mirrorTurns: "all",
          verbosity: "sender-message",
          requireDelivery: false,
        },
        requesterSessionKey: "agent:source-agent:source",
        requesterChannel: "slack",
      },
      {
        callGateway: vi.fn(),
        resolveAnnounceTarget: resolveAnnounceTargetMock,
      },
    );

    expect(resolveAnnounceTargetMock).toHaveBeenCalledTimes(2);
    expect(resolveAnnounceTargetMock).toHaveBeenNthCalledWith(
      1,
      {
        sessionKey: "agent:source-agent:source",
        displayKey: "agent:source-agent:source",
      },
      {
        callGateway: expect.any(Function),
      },
    );
    expect(resolveAnnounceTargetMock).toHaveBeenNthCalledWith(
      2,
      {
        sessionKey: "agent:target-agent:target",
        displayKey: "agent:target-agent:target",
      },
      {
        callGateway: expect.any(Function),
      },
    );
    expect(prepared.flowParams).toMatchObject({
      targetSessionKey: "agent:target-agent:target",
      displayKey: "agent:target-agent:target",
      message: "hello",
      announceTimeoutMs: 1_000,
      maxPingPongTurns: 0,
      relayPolicy: {
        enabled: true,
        mode: "dual-channel",
        mirrorTurns: "all",
        verbosity: "sender-message",
        requireDelivery: false,
      },
      requesterSessionKey: "agent:source-agent:source",
      requesterChannel: "slack",
      requesterAgentId: "source-agent",
      targetAgentId: "target-agent",
    });
    expect(prepared.flowParams.sourceRelayTarget).toEqual({
      channel: "slack",
      to: "source-room",
      accountId: "default",
    });
    expect(prepared.flowParams.targetRelayTarget).toEqual({
      channel: "discord",
      to: "group:dev",
      accountId: "default",
      threadId: "7",
    });
    expect(prepared.defaultRelay).toEqual({
      status: "pending",
      mode: "dual-channel",
      mirrorTurns: "all",
      targets: [],
    });
  });

  it("skips source relay lookup when requester and target session keys match", async () => {
    const resolveAnnounceTargetMock = vi.fn(async () => ({
      channel: "discord",
      to: "group:dev",
      accountId: "default",
      threadId: "7",
    }));

    const prepared = await prepareSessionsSendA2AFlow(
      {
        targetSessionKey: "agent:target-agent:target",
        displayKey: "agent:target-agent:target",
        message: "hello",
        announceTimeoutMs: 1_000,
        maxPingPongTurns: 0,
        timeoutSeconds: 30,
        relayPolicy: {
          enabled: true,
          mode: "dual-channel",
          mirrorTurns: "round1",
          verbosity: "sender-message",
          requireDelivery: false,
        },
        requesterSessionKey: "agent:target-agent:target",
      },
      {
        callGateway: vi.fn(),
        resolveAnnounceTarget: resolveAnnounceTargetMock,
      },
    );

    expect(resolveAnnounceTargetMock).toHaveBeenCalledTimes(1);
    expect(prepared.flowParams.sourceRelayTarget).toBeNull();
  });

  it("uses explicit relay targets and agent ids without resolver-derived overrides", async () => {
    const resolveAnnounceTargetMock = vi.fn();

    const prepared = await prepareSessionsSendA2AFlow(
      {
        targetSessionKey: "agent:target-agent:target",
        displayKey: "agent:target-agent:target",
        message: "hello",
        announceTimeoutMs: 1_000,
        maxPingPongTurns: 1,
        requesterSessionKey: "agent:source-agent:source",
        requesterAgentId: "requester-explicit",
        targetAgentId: "target-explicit",
        sourceRelayTarget: {
          channel: "slack",
          to: "channel:C1",
          accountId: "default",
        },
        targetRelayTarget: {
          channel: "discord",
          to: "group:dev",
          accountId: "default",
          threadId: "7",
        },
      },
      {
        callGateway: vi.fn(),
        resolveAnnounceTarget: resolveAnnounceTargetMock,
      },
    );

    expect(resolveAnnounceTargetMock).not.toHaveBeenCalled();
    expect(prepared.flowParams.requesterAgentId).toBe("requester-explicit");
    expect(prepared.flowParams.targetAgentId).toBe("target-explicit");
    expect(prepared.flowParams.sourceRelayTarget).toEqual({
      channel: "slack",
      to: "channel:C1",
      accountId: "default",
    });
    expect(prepared.flowParams.targetRelayTarget).toEqual({
      channel: "discord",
      to: "group:dev",
      accountId: "default",
      threadId: "7",
    });
  });
});
