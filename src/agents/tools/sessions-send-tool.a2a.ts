/**
 * sessions_send agent-to-agent reply flow.
 *
 * Runs bounded ping-pong delivery, waits for target replies, and suppresses control-token messages.
 */
import crypto from "node:crypto";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { buildRelaySummary, relayTurn } from "../a2a/relay-delivery.js";
import type { RelayResult, RelayTargetResult } from "../a2a/types.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import {
  type AgentWaitResult,
  type AssistantReplySnapshot,
  hasUpdatedAssistantReplySnapshot,
  isRecoverableAgentWaitError,
  readLatestAssistantReplySnapshot,
  waitForAgentRun,
} from "../run-wait.js";
import { runAgentStep } from "./agent-step.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import {
  type AnnounceTarget,
  buildAgentToAgentAnnounceContext,
  buildAgentToAgentReplyContext,
  isAnnounceSkip,
  isNonDeliverableSessionsReply,
  isReplySkip,
  type RelayPolicy,
} from "./sessions-send-helpers.js";

const log = createSubsystemLogger("agents/sessions-send");

type GatewayCaller = <T = unknown>(opts: CallGatewayOptions) => Promise<T>;
type AnnounceTargetResolver = typeof resolveAnnounceTarget;
type AgentStepRunner = typeof runAgentStep;

const defaultSessionsSendA2ADeps = {
  callGateway: async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
    const { callGateway } = await import("../../gateway/call.js");
    return callGateway<T>(opts);
  },
  resolveAnnounceTarget,
  runAgentStep,
};

let sessionsSendA2ADeps: {
  callGateway: GatewayCaller;
  resolveAnnounceTarget: AnnounceTargetResolver;
  runAgentStep: AgentStepRunner;
} = defaultSessionsSendA2ADeps;

function isDeliveryFailureWait(wait: AgentWaitResult): boolean {
  return (
    (wait.status === "error" && !isRecoverableAgentWaitError(wait.error)) ||
    (wait.status === "timeout" && wait.pendingError === true)
  );
}

async function deliverAnnounceReply(params: {
  announceTarget: AnnounceTarget;
  message: string;
  runContextId: string;
}) {
  const message = params.message.trim();
  if (!message) {
    return;
  }
  try {
    await sessionsSendA2ADeps.callGateway({
      method: "send",
      params: {
        to: params.announceTarget.to,
        message,
        channel: params.announceTarget.channel,
        accountId: params.announceTarget.accountId,
        threadId: params.announceTarget.threadId,
        idempotencyKey: crypto.randomUUID(),
      },
      timeoutMs: 10_000,
    });
  } catch (err) {
    log.warn("sessions_send announce delivery failed", {
      runId: params.runContextId,
      channel: params.announceTarget.channel,
      to: params.announceTarget.to,
      error: formatErrorMessage(err),
    });
  }
}

export type SessionsSendA2AFlowParams = {
  runContextId?: string;
  targetSessionKey: string;
  displayKey: string;
  message: string;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  baseline?: AssistantReplySnapshot;
  roundOneReply?: string;
  waitRunId?: string;
  notifyRequesterOnWaitFailure?: boolean;
  relayPolicy?: RelayPolicy;
  sourceRelayTarget?: AnnounceTarget | null;
  targetRelayTarget?: AnnounceTarget | null;
  requesterAgentId?: string;
  targetAgentId?: string;
};

export type StartedSessionsSendA2AFlow = {
  relay: RelayResult;
  completion?: Promise<{ relay: RelayResult } | undefined>;
};

export async function startSessionsSendA2AFlow(
  params: SessionsSendA2AFlowParams,
): Promise<StartedSessionsSendA2AFlow> {
  const runContextId = params.runContextId ?? params.waitRunId ?? crypto.randomUUID();
  const relayTargets: RelayTargetResult[] = [];
  try {
    // The request relay is independent of the target's reply. Attempt it before
    // waiting so strict delivery cannot be reported as pending without proof.
    const initialRelay = await relayTurn(
      {
        runContextId,
        turnId: "request",
        relayPolicy: params.relayPolicy,
        sourceRelayTarget: params.sourceRelayTarget,
        targetRelayTarget: params.targetRelayTarget,
        fromAgent: params.requesterAgentId ?? "requester",
        toAgent: params.targetAgentId ?? "target",
        text: params.message,
      },
      {
        callGateway: sessionsSendA2ADeps.callGateway,
      },
    );
    relayTargets.push(...initialRelay.targets);
    if (initialRelay.requiredFailure) {
      return {
        relay: buildRelaySummary({
          policy: params.relayPolicy,
          targets: relayTargets,
          blocked: true,
        }),
      };
    }

    return {
      relay: buildRelaySummary({ policy: params.relayPolicy, targets: relayTargets }),
      completion: continueSessionsSendA2AFlow(params, runContextId, relayTargets),
    };
  } catch (err) {
    log.warn("sessions_send initial relay failed", {
      runId: runContextId,
      error: formatErrorMessage(err),
    });
    return {
      relay: buildRelaySummary({ policy: params.relayPolicy, targets: relayTargets }),
    };
  }
}

async function continueSessionsSendA2AFlow(
  params: SessionsSendA2AFlowParams,
  runContextId: string,
  relayTargets: RelayTargetResult[],
): Promise<{ relay: RelayResult } | undefined> {
  try {
    let primaryReply = params.roundOneReply;
    let latestReply = params.roundOneReply;
    if (!primaryReply && params.waitRunId) {
      const wait = await waitForAgentRun({
        runId: params.waitRunId,
        timeoutMs: params.announceTimeoutMs,
        callGateway: sessionsSendA2ADeps.callGateway,
      });
      if (wait.status === "ok") {
        const latestSnapshot = await readLatestAssistantReplySnapshot({
          sessionKey: params.targetSessionKey,
          stopAtTranscriptArtifact: true,
          callGateway: sessionsSendA2ADeps.callGateway,
        });
        primaryReply = hasUpdatedAssistantReplySnapshot(latestSnapshot, params.baseline)
          ? latestSnapshot.text
          : undefined;
        latestReply = primaryReply;
      } else {
        if (
          params.notifyRequesterOnWaitFailure === true &&
          params.requesterSessionKey &&
          isDeliveryFailureWait(wait)
        ) {
          const error =
            typeof wait.error === "string" && wait.error.trim() ? `: ${wait.error.trim()}` : "";
          await runAgentStep({
            sessionKey: params.requesterSessionKey,
            message:
              `sessions_send delivery to ${params.displayKey} failed${error}. ` +
              "The target may not have received the message; retry or report the failure instead of assuming delivery succeeded.",
            extraSystemPrompt:
              "A previous sessions_send delivery failed after it was accepted. Decide whether to retry, use another route, or report the failure. Do not assume the target received the message.",
            timeoutMs: params.announceTimeoutMs,
            lane: resolveNestedAgentLaneForSession(params.requesterSessionKey),
            sourceSessionKey: params.targetSessionKey,
            sourceTool: "sessions_send",
          });
        }
        const requiredReplyRelayMissed =
          params.relayPolicy?.requireDelivery === true &&
          (params.relayPolicy.mirrorTurns === "round1" || params.relayPolicy.mirrorTurns === "all");
        return {
          relay: buildRelaySummary({
            policy: params.relayPolicy,
            targets: relayTargets,
            blocked: requiredReplyRelayMissed,
          }),
        };
      }
    }
    if (isNonDeliverableSessionsReply(latestReply)) {
      return { relay: buildRelaySummary({ policy: params.relayPolicy, targets: relayTargets }) };
    }

    if (
      latestReply &&
      (params.relayPolicy?.mirrorTurns === "round1" || params.relayPolicy?.mirrorTurns === "all")
    ) {
      const roundOneRelay = await relayTurn(
        {
          runContextId,
          turnId: "round-1-reply",
          relayPolicy: params.relayPolicy,
          sourceRelayTarget: params.sourceRelayTarget,
          targetRelayTarget: params.targetRelayTarget,
          fromAgent: params.targetAgentId ?? "target",
          toAgent: params.requesterAgentId ?? "requester",
          text: latestReply,
        },
        {
          callGateway: sessionsSendA2ADeps.callGateway,
        },
      );
      relayTargets.push(...roundOneRelay.targets);
      if (roundOneRelay.requiredFailure) {
        return {
          relay: buildRelaySummary({
            policy: params.relayPolicy,
            targets: relayTargets,
            blocked: true,
          }),
        };
      }
    }

    if (!latestReply) {
      return { relay: buildRelaySummary({ policy: params.relayPolicy, targets: relayTargets }) };
    }

    const announceTarget =
      params.targetRelayTarget ??
      (await sessionsSendA2ADeps.resolveAnnounceTarget(
        {
          sessionKey: params.targetSessionKey,
          displayKey: params.displayKey,
        },
        {
          callGateway: sessionsSendA2ADeps.callGateway,
        },
      ));
    const targetChannel = announceTarget?.channel ?? "unknown";

    // A same-session send is a human-facing source-channel reply, not a true
    // agent-to-agent announcement. Asking the same session to decide whether to
    // announce can re-run the same prompt and duplicate source-reply side effects.
    const sameSessionSourceReply =
      params.requesterSessionKey && params.requesterSessionKey === params.targetSessionKey;
    const canDirectDeliverSameSessionReply =
      announceTarget &&
      (!params.requesterChannel || params.requesterChannel === announceTarget.channel);
    if (sameSessionSourceReply && canDirectDeliverSameSessionReply) {
      if (params.waitRunId && !params.roundOneReply && !params.baseline) {
        return { relay: buildRelaySummary({ policy: params.relayPolicy, targets: relayTargets }) };
      }
      await deliverAnnounceReply({
        announceTarget,
        message: latestReply,
        runContextId,
      });
      return { relay: buildRelaySummary({ policy: params.relayPolicy, targets: relayTargets }) };
    }
    if (sameSessionSourceReply && !announceTarget) {
      return;
    }

    if (
      params.maxPingPongTurns > 0 &&
      params.requesterSessionKey &&
      params.requesterSessionKey !== params.targetSessionKey
    ) {
      let currentSessionKey = params.requesterSessionKey;
      let nextSessionKey = params.targetSessionKey;
      let incomingMessage = latestReply;
      for (let turn = 1; turn <= params.maxPingPongTurns; turn += 1) {
        const currentRole =
          currentSessionKey === params.requesterSessionKey ? "requester" : "target";
        const replyPrompt = buildAgentToAgentReplyContext({
          requesterSessionKey: params.requesterSessionKey,
          requesterChannel: params.requesterChannel,
          targetSessionKey: params.displayKey,
          targetChannel,
          currentRole,
          turn,
          maxTurns: params.maxPingPongTurns,
        });
        const replyText = await sessionsSendA2ADeps.runAgentStep({
          sessionKey: currentSessionKey,
          message: incomingMessage,
          extraSystemPrompt: replyPrompt,
          timeoutMs: params.announceTimeoutMs,
          lane: resolveNestedAgentLaneForSession(currentSessionKey),
          sourceSessionKey: nextSessionKey,
          sourceChannel:
            nextSessionKey === params.requesterSessionKey ? params.requesterChannel : targetChannel,
          sourceTool: "sessions_send",
        });
        if (!replyText || isReplySkip(replyText) || isNonDeliverableSessionsReply(replyText)) {
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
              runContextId,
              turnId: `ping-pong-${turn}`,
              relayPolicy: params.relayPolicy,
              sourceRelayTarget: params.sourceRelayTarget,
              targetRelayTarget: params.targetRelayTarget,
              fromAgent,
              toAgent,
              text: replyText,
            },
            {
              callGateway: sessionsSendA2ADeps.callGateway,
            },
          );
          relayTargets.push(...relayAttempt.targets);
          if (relayAttempt.requiredFailure) {
            return {
              relay: buildRelaySummary({
                policy: params.relayPolicy,
                targets: relayTargets,
                blocked: true,
              }),
            };
          }
        }
        incomingMessage = replyText;
        const swap = currentSessionKey;
        currentSessionKey = nextSessionKey;
        nextSessionKey = swap;
      }
    }

    const suppressAnnounceForRelay =
      params.relayPolicy?.enabled === true && params.relayPolicy.mode === "dual-channel";
    if (!suppressAnnounceForRelay) {
      const announcePrompt = buildAgentToAgentAnnounceContext({
        requesterSessionKey: params.requesterSessionKey,
        requesterChannel: params.requesterChannel,
        targetSessionKey: params.displayKey,
        targetChannel,
        originalMessage: params.message,
        roundOneReply: primaryReply,
        latestReply,
      });
      const announceReply = await sessionsSendA2ADeps.runAgentStep({
        sessionKey: params.targetSessionKey,
        message: "Agent-to-agent announce step.",
        extraSystemPrompt: announcePrompt,
        timeoutMs: params.announceTimeoutMs,
        lane: resolveNestedAgentLaneForSession(params.targetSessionKey),
        transcriptMessage: "",
        sourceSessionKey: params.requesterSessionKey,
        sourceChannel: params.requesterChannel,
        sourceTool: "sessions_send",
      });
      if (
        announceTarget &&
        announceReply &&
        announceReply.trim() &&
        !isAnnounceSkip(announceReply) &&
        !isNonDeliverableSessionsReply(announceReply)
      ) {
        await deliverAnnounceReply({
          announceTarget,
          message: announceReply,
          runContextId,
        });
      }
    }
  } catch (err) {
    log.warn("sessions_send announce flow failed", {
      runId: runContextId,
      error: formatErrorMessage(err),
    });
    return {
      relay: buildRelaySummary({
        policy: params.relayPolicy,
        targets: relayTargets,
        blocked: params.relayPolicy?.requireDelivery === true,
      }),
    };
  }
  return {
    relay: buildRelaySummary({ policy: params.relayPolicy, targets: relayTargets }),
  };
}

export async function runSessionsSendA2AFlow(
  params: SessionsSendA2AFlowParams,
): Promise<{ relay: RelayResult } | undefined> {
  const started = await startSessionsSendA2AFlow(params);
  return started.completion ? await started.completion : { relay: started.relay };
}

export const __testing = {
  setDepsForTest(
    overrides?: Partial<{
      callGateway: GatewayCaller;
      resolveAnnounceTarget: AnnounceTargetResolver;
      runAgentStep: AgentStepRunner;
    }>,
  ) {
    sessionsSendA2ADeps = overrides
      ? {
          ...defaultSessionsSendA2ADeps,
          ...overrides,
        }
      : defaultSessionsSendA2ADeps;
  },
};
