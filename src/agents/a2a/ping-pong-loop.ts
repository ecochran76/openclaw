import { callGateway } from "../../gateway/call.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { runAgentStep } from "../tools/agent-step.js";
import {
  buildAgentToAgentReplyContext,
  type AnnounceTarget,
  type RelayPolicy,
} from "../tools/sessions-send-helpers.js";
import { isReplySkip } from "../tools/sessions-send-tokens.js";
import { relayTurn } from "./relay-delivery.js";
import type { RelayTargetResult } from "./types.js";

export type PingPongLoopDeps = {
  callGateway?: typeof callGateway;
  runAgentStep?: typeof runAgentStep;
};

export type PingPongLoopParams = {
  runContextId: string;
  latestReply: string;
  targetChannel: string;
  targetSessionKey: string;
  displayKey: string;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  relayPolicy?: RelayPolicy;
  sourceRelayTarget?: AnnounceTarget | null;
  targetRelayTarget?: AnnounceTarget | null;
  requesterAgentId?: string;
  targetAgentId?: string;
};

export type PingPongLoopResult = {
  latestReply: string;
  relayTargets: RelayTargetResult[];
  requiredFailure: boolean;
};

export async function runPingPongLoop(
  params: PingPongLoopParams,
  deps?: PingPongLoopDeps,
): Promise<PingPongLoopResult> {
  if (
    params.maxPingPongTurns <= 0 ||
    !params.requesterSessionKey ||
    params.requesterSessionKey === params.targetSessionKey
  ) {
    return {
      latestReply: params.latestReply,
      relayTargets: [],
      requiredFailure: false,
    };
  }

  const runStep = deps?.runAgentStep ?? runAgentStep;
  const gatewayCall = deps?.callGateway ?? callGateway;

  let latestReply = params.latestReply;
  const relayTargets: RelayTargetResult[] = [];
  let currentSessionKey = params.requesterSessionKey;
  let nextSessionKey = params.targetSessionKey;
  let incomingMessage = latestReply;

  for (let turn = 1; turn <= params.maxPingPongTurns; turn += 1) {
    const currentRole = currentSessionKey === params.requesterSessionKey ? "requester" : "target";
    const replyPrompt = buildAgentToAgentReplyContext({
      requesterSessionKey: params.requesterSessionKey,
      requesterChannel: params.requesterChannel,
      targetSessionKey: params.displayKey,
      targetChannel: params.targetChannel,
      currentRole,
      turn,
      maxTurns: params.maxPingPongTurns,
    });
    const replyText = await runStep({
      sessionKey: currentSessionKey,
      message: incomingMessage,
      extraSystemPrompt: replyPrompt,
      timeoutMs: params.announceTimeoutMs,
      sourceSessionKey: nextSessionKey,
      sourceChannel:
        nextSessionKey === params.requesterSessionKey
          ? params.requesterChannel
          : params.targetChannel,
      sourceTool: "sessions_send",
    });
    if (!replyText || isReplySkip(replyText)) {
      break;
    }

    latestReply = replyText;
    if (params.relayPolicy?.enabled === true && params.relayPolicy.mirrorTurns === "all") {
      const fromAgent =
        currentRole === "requester"
          ? (params.requesterAgentId ?? "requester")
          : (params.targetAgentId ?? "target");
      const toAgent =
        currentRole === "requester"
          ? (params.targetAgentId ?? "target")
          : (params.requesterAgentId ?? "requester");
      const relayAttempt = await relayTurn(
        {
          runContextId: params.runContextId,
          relayPolicy: params.relayPolicy,
          sourceRelayTarget: params.sourceRelayTarget,
          targetRelayTarget: params.targetRelayTarget,
          fromAgent,
          toAgent,
          text: replyText,
        },
        {
          callGateway: gatewayCall,
        },
      );
      relayTargets.push(...relayAttempt.targets);
      if (relayAttempt.requiredFailure) {
        return {
          latestReply,
          relayTargets,
          requiredFailure: true,
        };
      }
    }

    incomingMessage = replyText;
    const swap = currentSessionKey;
    currentSessionKey = nextSessionKey;
    nextSessionKey = swap;
  }

  return {
    latestReply,
    relayTargets,
    requiredFailure: false,
  };
}
