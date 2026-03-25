/**
 * sessions_send agent-to-agent reply flow.
 *
 * Runs bounded ping-pong delivery, waits for target replies, and suppresses control-token messages.
 */
import crypto from "node:crypto";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { buildRelaySummary, relayTurn } from "../a2a/relay-delivery.js";
import type { RelayResult, RelayTargetResult } from "../a2a/types.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import {
  type AssistantReplySnapshot,
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

type SessionsSendA2AFlowParams = Parameters<typeof runSessionsSendA2AFlow>[0];

export async function prepareSessionsSendA2AFlow(
  params: {
    targetSessionKey: string;
    displayKey: string;
    message: string;
    announceTimeoutMs: number;
    maxPingPongTurns: number;
    timeoutSeconds: number;
    relayPolicy: RelayPolicy;
    requesterSessionKey?: string;
    requesterChannel?: GatewayMessageChannel;
  },
  deps?: Partial<{
    callGateway: GatewayCaller;
    resolveAnnounceTarget: AnnounceTargetResolver;
  }>,
): Promise<{
  flowParams: SessionsSendA2AFlowParams;
  defaultRelay: RelayResult;
}> {
  const gatewayCall = deps?.callGateway ?? sessionsSendA2ADeps.callGateway;
  const announceTargetResolver =
    deps?.resolveAnnounceTarget ?? sessionsSendA2ADeps.resolveAnnounceTarget;
  const requesterAgentId = params.requesterSessionKey
    ? (resolveAgentIdFromSessionKey(params.requesterSessionKey) ?? "requester")
    : "requester";
  const targetAgentId = resolveAgentIdFromSessionKey(params.targetSessionKey) ?? "target";
  const sourceRelayTarget =
    params.requesterSessionKey && params.requesterSessionKey !== params.targetSessionKey
      ? await announceTargetResolver(
          {
            sessionKey: params.requesterSessionKey,
            displayKey: params.requesterSessionKey,
          },
          {
            callGateway: gatewayCall,
          },
        )
      : null;
  const targetRelayTarget = await announceTargetResolver(
    {
      sessionKey: params.targetSessionKey,
      displayKey: params.displayKey,
    },
    {
      callGateway: gatewayCall,
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
      status: params.relayPolicy.enabled
        ? params.timeoutSeconds === 0
          ? "pending"
          : "not_applicable"
        : "disabled",
      mode: params.relayPolicy.mode,
      mirrorTurns: params.relayPolicy.mirrorTurns,
      targets: [],
    },
  };
}

export async function runSessionsSendA2AFlow(params: {
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
  relayPolicy?: RelayPolicy;
  sourceRelayTarget?: AnnounceTarget | null;
  targetRelayTarget?: AnnounceTarget | null;
  requesterAgentId?: string;
  targetAgentId?: string;
}): Promise<{ relay: RelayResult }> {
  const runContextId = params.waitRunId ?? "unknown";
  const relayTargets: RelayTargetResult[] = [];
  try {
    let primaryReply = params.roundOneReply;
    let latestReply = params.roundOneReply;
    if (!primaryReply && params.waitRunId) {
      const wait = await waitForAgentRun({
        runId: params.waitRunId,
        timeoutMs: Math.min(params.announceTimeoutMs, 60_000),
        callGateway: sessionsSendA2ADeps.callGateway,
      });
      if (wait.status === "ok") {
        const latestSnapshot = await readLatestAssistantReplySnapshot({
          sessionKey: params.targetSessionKey,
          callGateway: sessionsSendA2ADeps.callGateway,
        });
        const baselineFingerprint = params.baseline?.fingerprint;
        primaryReply =
          latestSnapshot.text &&
          (!baselineFingerprint || latestSnapshot.fingerprint !== baselineFingerprint)
            ? latestSnapshot.text
            : undefined;
        latestReply = primaryReply;
      }
    }

    const initialRelay = await relayTurn(
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
    // announce can learn stale ANNOUNCE_SKIP patterns from its own history and
    // silently drop a normal channel response.
    if (
      announceTarget &&
      params.requesterSessionKey &&
      params.requesterSessionKey === params.targetSessionKey &&
      params.requesterChannel === announceTarget.channel
    ) {
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
  }
  return { relay: buildRelaySummary({ policy: params.relayPolicy, targets: relayTargets }) };
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
