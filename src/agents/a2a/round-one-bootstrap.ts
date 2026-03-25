import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnnounceTarget, RelayPolicy } from "../tools/sessions-send-helpers.js";
import type { RelayTargetResult } from "./types.js";

type GatewayCaller = typeof import("../../gateway/call.js").callGateway;
type ReadLatestAssistantReply = typeof import("../tools/agent-step.js").readLatestAssistantReply;
type RelayTurn = typeof import("./relay-delivery.js").relayTurn;

export type RoundOneBootstrapDeps = {
  callGateway: GatewayCaller;
  readLatestAssistantReply: ReadLatestAssistantReply;
  relayTurn: RelayTurn;
};

export type RoundOneBootstrapParams = {
  runContextId?: string;
  waitRunId?: string;
  targetSessionKey: string;
  message: string;
  announceTimeoutMs: number;
  relayPolicy?: RelayPolicy;
  sourceRelayTarget?: AnnounceTarget | null;
  targetRelayTarget?: AnnounceTarget | null;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  requesterAgentId?: string;
  targetAgentId?: string;
  roundOneReply?: string;
};

export type RoundOneBootstrapResult = {
  primaryReply?: string;
  latestReply?: string;
  relayTargets: RelayTargetResult[];
  requiredFailure: boolean;
};

export async function runRoundOneBootstrap(
  params: RoundOneBootstrapParams,
  deps: RoundOneBootstrapDeps,
): Promise<RoundOneBootstrapResult> {
  const runContextId = params.runContextId ?? params.waitRunId ?? "unknown";
  const relayTargets: RelayTargetResult[] = [];
  let primaryReply = params.roundOneReply;
  let latestReply = params.roundOneReply;

  if (!primaryReply && params.waitRunId) {
    const waitMs = Math.min(params.announceTimeoutMs, 60_000);
    const wait = await deps.callGateway<{ status?: string }>({
      method: "agent.wait",
      params: {
        runId: params.waitRunId,
        timeoutMs: waitMs,
      },
      timeoutMs: waitMs + 2000,
    });
    if (wait?.status === "ok") {
      primaryReply = await deps.readLatestAssistantReply({
        sessionKey: params.targetSessionKey,
      });
      latestReply = primaryReply;
    }
  }

  const initialRelay = await deps.relayTurn(
    {
      runContextId,
      relayPolicy: params.relayPolicy,
      sourceRelayTarget: params.sourceRelayTarget,
      targetRelayTarget: params.targetRelayTarget,
      fromAgent: params.requesterAgentId ?? "requester",
      toAgent: params.targetAgentId ?? "target",
      text: params.message,
    },
    {
      callGateway: deps.callGateway,
    },
  );
  relayTargets.push(...initialRelay.targets);
  if (initialRelay.requiredFailure) {
    return {
      primaryReply,
      latestReply,
      relayTargets,
      requiredFailure: true,
    };
  }

  if (
    latestReply &&
    (params.relayPolicy?.mirrorTurns === "round1" || params.relayPolicy?.mirrorTurns === "all")
  ) {
    const roundOneRelay = await deps.relayTurn(
      {
        runContextId,
        relayPolicy: params.relayPolicy,
        sourceRelayTarget: params.sourceRelayTarget,
        targetRelayTarget: params.targetRelayTarget,
        fromAgent: params.targetAgentId ?? "target",
        toAgent: params.requesterAgentId ?? "requester",
        text: latestReply,
      },
      {
        callGateway: deps.callGateway,
      },
    );
    relayTargets.push(...roundOneRelay.targets);
    if (roundOneRelay.requiredFailure) {
      return {
        primaryReply,
        latestReply,
        relayTargets,
        requiredFailure: true,
      };
    }
  }

  return {
    primaryReply,
    latestReply,
    relayTargets,
    requiredFailure: false,
  };
}
