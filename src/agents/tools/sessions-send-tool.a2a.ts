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
  buildAgentToAgentRelayText,
  buildAgentToAgentReplyContext,
  isAnnounceSkip,
  isNonDeliverableSessionsReply,
  isReplySkip,
  type AnnounceTarget,
  type RelayPolicy,
} from "./sessions-send-helpers.js";

const log = createSubsystemLogger("agents/sessions-send");

type GatewayCaller = <T = unknown>(opts: CallGatewayOptions) => Promise<T>;

const defaultSessionsSendA2ADeps = {
  callGateway: async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
    const { callGateway } = await import("../../gateway/call.js");
    return callGateway<T>(opts);
  },
};

let sessionsSendA2ADeps: {
  callGateway: GatewayCaller;
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
}) {
  const runContextId = params.waitRunId ?? "unknown";
  const relayTargets = (() => {
    if (params.relayPolicy?.enabled !== true) {
      return [] as AnnounceTarget[];
    }
    if (params.relayPolicy.mode === "dual-channel") {
      return [params.sourceRelayTarget, params.targetRelayTarget].filter(
        Boolean,
      ) as AnnounceTarget[];
    }
    return [params.targetRelayTarget].filter(Boolean) as AnnounceTarget[];
  })();
  const relayTurn = async (fromAgent: string, toAgent: string, text: string) => {
    if (!text.trim() || relayTargets.length === 0) {
      return;
    }
    const relayText = buildAgentToAgentRelayText({
      handoffId: runContextId,
      fromAgent,
      toAgent,
      text,
    });
    await Promise.all(
      relayTargets.map((target, index) =>
        callGateway({
          method: "send",
          params: {
            to: target.to,
            message: relayText,
            channel: target.channel,
            accountId: target.accountId,
            threadId: target.threadId,
            idempotencyKey: `${runContextId}:relay:${fromAgent}:${toAgent}:${index}`,
          },
          timeoutMs: 10_000,
        }).catch((err) => {
          log.warn("sessions_send relay delivery failed", {
            runId: runContextId,
            channel: target.channel,
            to: target.to,
            error: formatErrorMessage(err),
          });
        }),
      ),
    );
  };
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
    if (!latestReply) {
      return;
    }
    if (isNonDeliverableSessionsReply(latestReply)) {
      return;
    }

    if (params.relayPolicy?.enabled === true) {
      await relayTurn(
        params.requesterAgentId ?? "requester",
        params.targetAgentId ?? "target",
        params.message,
      );
      if (params.relayPolicy.mirrorTurns === "round1" || params.relayPolicy.mirrorTurns === "all") {
        await relayTurn(
          params.targetAgentId ?? "target",
          params.requesterAgentId ?? "requester",
          latestReply,
        );
      }
    }

    const announceTarget =
      params.targetRelayTarget ??
      (await resolveAnnounceTarget({
        sessionKey: params.targetSessionKey,
        displayKey: params.displayKey,
      }));
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
        return;
      }
      await deliverAnnounceReply({
        announceTarget,
        message: latestReply,
        runContextId,
      });
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
        const replyText = await runAgentStep({
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
          await relayTurn(fromAgent, toAgent, replyText);
        }
        incomingMessage = replyText;
        const swap = currentSessionKey;
        currentSessionKey = nextSessionKey;
        nextSessionKey = swap;
      }
    }

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
  } catch (err) {
    log.warn("sessions_send announce flow failed", {
      runId: runContextId,
      error: formatErrorMessage(err),
    });
  }
}

export const testing = {
  setDepsForTest(overrides?: Partial<{ callGateway: GatewayCaller }>) {
    sessionsSendA2ADeps = overrides
      ? {
          ...defaultSessionsSendA2ADeps,
          ...overrides,
        }
      : defaultSessionsSendA2ADeps;
  },
};
export { testing as __testing };
