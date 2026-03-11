import crypto from "node:crypto";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { readLatestAssistantReply, runAgentStep } from "./agent-step.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import {
  buildAgentToAgentAnnounceContext,
  buildAgentToAgentRelayText,
  buildAgentToAgentReplyContext,
  isAnnounceSkip,
  isReplySkip,
  type AnnounceTarget,
  type RelayPolicy,
} from "./sessions-send-helpers.js";

const log = createSubsystemLogger("agents/sessions-send");

type RelayTargetStatus = "sent" | "failed" | "blocked" | "skipped";
type RelayStatus =
  | "disabled"
  | "not_applicable"
  | "sent"
  | "partial"
  | "failed"
  | "blocked"
  | "pending";

export type RelayTargetResult = {
  role: "source" | "target";
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
  status: RelayTargetStatus;
  messageId?: string;
  error?: string;
};

export type RelayResult = {
  status: RelayStatus;
  mode: "target-only" | "dual-channel";
  mirrorTurns: "round1" | "all";
  targets: RelayTargetResult[];
};

type RelayAttemptResult = {
  status: Exclude<RelayStatus, "disabled" | "pending">;
  targets: RelayTargetResult[];
  requiredFailure: boolean;
};

function buildRelaySummary(params: {
  policy?: RelayPolicy;
  targets: RelayTargetResult[];
  blocked?: boolean;
}): RelayResult {
  const mode = params.policy?.mode ?? "target-only";
  const mirrorTurns = params.policy?.mirrorTurns ?? "round1";
  if (params.policy?.enabled !== true) {
    return { status: "disabled", mode, mirrorTurns, targets: [] };
  }
  if (params.blocked) {
    return { status: "blocked", mode, mirrorTurns, targets: params.targets };
  }
  if (params.targets.length === 0) {
    return { status: "not_applicable", mode, mirrorTurns, targets: [] };
  }
  const sentCount = params.targets.filter((target) => target.status === "sent").length;
  const failureCount = params.targets.filter(
    (target) => target.status === "failed" || target.status === "blocked",
  ).length;
  if (failureCount === 0) {
    return {
      status: sentCount > 0 ? "sent" : "not_applicable",
      mode,
      mirrorTurns,
      targets: params.targets,
    };
  }
  if (sentCount === 0) {
    return { status: "failed", mode, mirrorTurns, targets: params.targets };
  }
  return { status: "partial", mode, mirrorTurns, targets: params.targets };
}

async function relayTurn(params: {
  runContextId: string;
  relayPolicy?: RelayPolicy;
  sourceRelayTarget?: AnnounceTarget | null;
  targetRelayTarget?: AnnounceTarget | null;
  fromAgent: string;
  toAgent: string;
  text: string;
}): Promise<RelayAttemptResult> {
  const policy = params.relayPolicy;
  if (policy?.enabled !== true) {
    return { status: "not_applicable", targets: [], requiredFailure: false };
  }
  if (!params.text.trim()) {
    return { status: "not_applicable", targets: [], requiredFailure: false };
  }
  const relayText = buildAgentToAgentRelayText({
    handoffId: params.runContextId,
    fromAgent: params.fromAgent,
    toAgent: params.toAgent,
    text: params.text,
    verbosity: policy.verbosity,
  });
  if (!relayText.trim()) {
    return { status: "not_applicable", targets: [], requiredFailure: false };
  }

  const targetSpecs = (
    policy.mode === "dual-channel"
      ? [
          { role: "source" as const, target: params.sourceRelayTarget },
          { role: "target" as const, target: params.targetRelayTarget },
        ]
      : [{ role: "target" as const, target: params.targetRelayTarget }]
  ).map(({ role, target }) => ({
    role,
    target,
    required: true,
  }));

  const results: RelayTargetResult[] = [];
  for (const [index, spec] of targetSpecs.entries()) {
    if (!spec.target) {
      const unresolved: RelayTargetResult = {
        role: spec.role,
        status: policy.requireDelivery ? "blocked" : "failed",
        error: "No relay target could be resolved.",
      };
      results.push(unresolved);
      if (spec.required && policy.requireDelivery) {
        return { status: "blocked", targets: results, requiredFailure: true };
      }
      continue;
    }

    try {
      const response = await callGateway<{ messageId?: string; id?: string; threadId?: string }>({
        method: "send",
        params: {
          to: spec.target.to,
          message: relayText,
          channel: spec.target.channel,
          accountId: spec.target.accountId,
          threadId: spec.target.threadId,
          idempotencyKey: `${params.runContextId}:relay:${params.fromAgent}:${params.toAgent}:${spec.role}:${index}`,
        },
        timeoutMs: 10_000,
      });
      results.push({
        role: spec.role,
        channel: spec.target.channel,
        to: spec.target.to,
        accountId: spec.target.accountId,
        threadId:
          (typeof response?.threadId === "string" ? response.threadId : undefined) ??
          spec.target.threadId,
        status: "sent",
        messageId:
          typeof response?.messageId === "string"
            ? response.messageId
            : typeof response?.id === "string"
              ? response.id
              : undefined,
      });
    } catch (err) {
      const error = formatErrorMessage(err);
      const failed: RelayTargetResult = {
        role: spec.role,
        channel: spec.target.channel,
        to: spec.target.to,
        accountId: spec.target.accountId,
        threadId: spec.target.threadId,
        status: policy.requireDelivery ? "blocked" : "failed",
        error,
      };
      results.push(failed);
      log.warn("sessions_send relay delivery failed", {
        runId: params.runContextId,
        channel: spec.target.channel,
        to: spec.target.to,
        role: spec.role,
        error,
      });
      if (spec.required && policy.requireDelivery) {
        return { status: "blocked", targets: results, requiredFailure: true };
      }
    }
  }

  const summary = buildRelaySummary({ policy, targets: results });
  return {
    status:
      summary.status === "disabled" || summary.status === "pending"
        ? "not_applicable"
        : summary.status,
    targets: results,
    requiredFailure: false,
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
      const waitMs = Math.min(params.announceTimeoutMs, 60_000);
      const wait = await callGateway<{ status: string }>({
        method: "agent.wait",
        params: {
          runId: params.waitRunId,
          timeoutMs: waitMs,
        },
        timeoutMs: waitMs + 2000,
      });
      if (wait?.status === "ok") {
        primaryReply = await readLatestAssistantReply({
          sessionKey: params.targetSessionKey,
        });
        latestReply = primaryReply;
      }
    }

    const initialRelay = await relayTurn({
      runContextId,
      relayPolicy: params.relayPolicy,
      sourceRelayTarget: params.sourceRelayTarget,
      targetRelayTarget: params.targetRelayTarget,
      fromAgent: params.requesterAgentId ?? "requester",
      toAgent: params.targetAgentId ?? "target",
      text: params.message,
    });
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

    if (
      latestReply &&
      (params.relayPolicy?.mirrorTurns === "round1" || params.relayPolicy?.mirrorTurns === "all")
    ) {
      const roundOneRelay = await relayTurn({
        runContextId,
        relayPolicy: params.relayPolicy,
        sourceRelayTarget: params.sourceRelayTarget,
        targetRelayTarget: params.targetRelayTarget,
        fromAgent: params.targetAgentId ?? "target",
        toAgent: params.requesterAgentId ?? "requester",
        text: latestReply,
      });
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
      (await resolveAnnounceTarget({
        sessionKey: params.targetSessionKey,
        displayKey: params.displayKey,
      }));
    const targetChannel = announceTarget?.channel ?? "unknown";

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
        const replyText = await runAgentStep({
          sessionKey: currentSessionKey,
          message: incomingMessage,
          extraSystemPrompt: replyPrompt,
          timeoutMs: params.announceTimeoutMs,
          lane: AGENT_LANE_NESTED,
          sourceSessionKey: nextSessionKey,
          sourceChannel:
            nextSessionKey === params.requesterSessionKey ? params.requesterChannel : targetChannel,
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
          const relayAttempt = await relayTurn({
            runContextId,
            relayPolicy: params.relayPolicy,
            sourceRelayTarget: params.sourceRelayTarget,
            targetRelayTarget: params.targetRelayTarget,
            fromAgent,
            toAgent,
            text: replyText,
          });
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
      const announceReply = await runAgentStep({
        sessionKey: params.targetSessionKey,
        message: "Agent-to-agent announce step.",
        extraSystemPrompt: announcePrompt,
        timeoutMs: params.announceTimeoutMs,
        lane: AGENT_LANE_NESTED,
        sourceSessionKey: params.requesterSessionKey,
        sourceChannel: params.requesterChannel,
        sourceTool: "sessions_send",
      });
      if (
        announceTarget &&
        announceReply &&
        announceReply.trim() &&
        !isAnnounceSkip(announceReply)
      ) {
        try {
          await callGateway({
            method: "send",
            params: {
              to: announceTarget.to,
              message: announceReply.trim(),
              channel: announceTarget.channel,
              accountId: announceTarget.accountId,
              idempotencyKey: crypto.randomUUID(),
            },
            timeoutMs: 10_000,
          });
        } catch (err) {
          log.warn("sessions_send announce delivery failed", {
            runId: runContextId,
            channel: announceTarget.channel,
            to: announceTarget.to,
            error: formatErrorMessage(err),
          });
        }
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
