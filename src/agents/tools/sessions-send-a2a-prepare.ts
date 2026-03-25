import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnnounceTarget, RelayPolicy } from "./sessions-send-helpers.js";
import type { RelayResult } from "../a2a/types.js";

type GatewayCaller = typeof import("../../gateway/call.js").callGateway;
type ResolveAnnounceTarget = typeof import("./sessions-announce-target.js").resolveAnnounceTarget;

export type SessionsSendA2AFlowParams = {
  targetSessionKey: string;
  displayKey: string;
  message: string;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  roundOneReply?: string;
  waitRunId?: string;
  relayPolicy?: RelayPolicy;
  sourceRelayTarget?: AnnounceTarget | null;
  targetRelayTarget?: AnnounceTarget | null;
  requesterAgentId?: string;
  targetAgentId?: string;
};

export type PreparedSessionsSendA2AFlowParams = Omit<
  SessionsSendA2AFlowParams,
  "roundOneReply" | "waitRunId"
>;

export type PrepareSessionsSendA2AFlowParams = PreparedSessionsSendA2AFlowParams & {
  timeoutSeconds?: number;
};

export type PrepareSessionsSendA2AFlowDeps = {
  callGateway: GatewayCaller;
  resolveAnnounceTarget: ResolveAnnounceTarget;
};

export async function prepareSessionsSendA2AFlow(
  params: PrepareSessionsSendA2AFlowParams,
  deps: PrepareSessionsSendA2AFlowDeps,
): Promise<{
  flowParams: PreparedSessionsSendA2AFlowParams;
  defaultRelay: RelayResult;
}> {
  const requesterAgentId =
    params.requesterAgentId ??
    (params.requesterSessionKey
      ? (resolveAgentIdFromSessionKey(params.requesterSessionKey) ?? "requester")
      : "requester");
  const targetAgentId =
    params.targetAgentId ?? resolveAgentIdFromSessionKey(params.targetSessionKey) ?? "target";
  const sourceRelayTarget =
    params.sourceRelayTarget !== undefined
      ? params.sourceRelayTarget
      : params.requesterSessionKey && params.requesterSessionKey !== params.targetSessionKey
        ? await deps.resolveAnnounceTarget(
            {
              sessionKey: params.requesterSessionKey,
              displayKey: params.requesterSessionKey,
            },
            {
              callGateway: deps.callGateway,
            },
          )
        : null;
  const targetRelayTarget =
    params.targetRelayTarget !== undefined
      ? params.targetRelayTarget
      : await deps.resolveAnnounceTarget(
          {
            sessionKey: params.targetSessionKey,
            displayKey: params.displayKey,
          },
          {
            callGateway: deps.callGateway,
          },
        );

  return {
    flowParams: {
      targetSessionKey: params.targetSessionKey,
      displayKey: params.displayKey,
      message: params.message,
      announceTimeoutMs: params.announceTimeoutMs,
      maxPingPongTurns: params.maxPingPongTurns,
      requesterSessionKey: params.requesterSessionKey,
      requesterChannel: params.requesterChannel,
      relayPolicy: params.relayPolicy,
      sourceRelayTarget,
      targetRelayTarget,
      requesterAgentId,
      targetAgentId,
    },
    defaultRelay: {
      status:
        params.relayPolicy?.enabled === true
          ? params.timeoutSeconds === 0
            ? "pending"
            : "not_applicable"
          : "disabled",
      mode: params.relayPolicy?.mode ?? "target-only",
      mirrorTurns: params.relayPolicy?.mirrorTurns ?? "round1",
      targets: [],
    },
  };
}
