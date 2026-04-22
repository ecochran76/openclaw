import crypto from "node:crypto";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { runAgentStep } from "../tools/agent-step.js";
import {
  buildAgentToAgentAnnounceContext,
  type AnnounceTarget,
  type RelayPolicy,
} from "../tools/sessions-send-helpers.js";
import { isAnnounceSkip } from "../tools/sessions-send-tokens.js";

export type AnnounceDeliveryStatus =
  | "suppressed"
  | "not_applicable"
  | "skipped"
  | "sent"
  | "failed";

export type AnnounceDeliveryResult = {
  status: AnnounceDeliveryStatus;
  reply?: string;
  messageId?: string;
  error?: string;
};

export type AnnounceDeliveryLogger = {
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

export type AnnounceDeliveryDeps = {
  callGateway?: typeof callGateway;
  runAgentStep?: typeof runAgentStep;
  logger?: AnnounceDeliveryLogger;
};

export type AnnounceDeliveryParams = {
  runContextId: string;
  relayPolicy?: RelayPolicy;
  announceTarget?: AnnounceTarget | null;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  targetSessionKey: string;
  targetChannel: string;
  displayKey: string;
  originalMessage: string;
  roundOneReply?: string;
  latestReply: string;
  announceTimeoutMs: number;
};

const log = createSubsystemLogger("agents/sessions-send");

function resolveAnnounceDeliveryDeps(overrides?: AnnounceDeliveryDeps) {
  return {
    callGateway: overrides?.callGateway ?? callGateway,
    runAgentStep: overrides?.runAgentStep ?? runAgentStep,
    logger: overrides?.logger ?? log,
  };
}

export function buildAnnounceDeliveryPrompt(params: AnnounceDeliveryParams): string {
  return buildAgentToAgentAnnounceContext({
    requesterSessionKey: params.requesterSessionKey,
    requesterChannel: params.requesterChannel,
    targetSessionKey: params.displayKey,
    targetChannel: params.targetChannel,
    originalMessage: params.originalMessage,
    roundOneReply: params.roundOneReply,
    latestReply: params.latestReply,
  });
}

export async function deliverAnnounceStep(
  params: AnnounceDeliveryParams,
  deps?: AnnounceDeliveryDeps,
): Promise<AnnounceDeliveryResult> {
  const {
    callGateway: gatewayCall,
    runAgentStep: runStep,
    logger,
  } = resolveAnnounceDeliveryDeps(deps);

  const suppressAnnounceForRelay =
    params.relayPolicy?.enabled === true && params.relayPolicy.mode === "dual-channel";
  if (suppressAnnounceForRelay) {
    return { status: "suppressed" };
  }

  const announceReply = await runStep({
    sessionKey: params.targetSessionKey,
    message: "Agent-to-agent announce step.",
    extraSystemPrompt: buildAnnounceDeliveryPrompt(params),
    timeoutMs: params.announceTimeoutMs,
    lane: AGENT_LANE_NESTED,
    sourceSessionKey: params.requesterSessionKey,
    sourceChannel: params.requesterChannel,
    sourceTool: "sessions_send",
  });
  const trimmedReply = announceReply?.trim();
  if (!trimmedReply || isAnnounceSkip(trimmedReply)) {
    return { status: "skipped", reply: trimmedReply };
  }
  if (!params.announceTarget) {
    return { status: "not_applicable", reply: trimmedReply };
  }

  try {
    const response = await gatewayCall({
      method: "send",
      params: {
        to: params.announceTarget.to,
        message: trimmedReply,
        channel: params.announceTarget.channel,
        accountId: params.announceTarget.accountId,
        idempotencyKey: crypto.randomUUID(),
      },
      timeoutMs: 10_000,
    });
    return {
      status: "sent",
      reply: trimmedReply,
      messageId:
        typeof response?.messageId === "string"
          ? response.messageId
          : typeof response?.id === "string"
            ? response.id
            : undefined,
    };
  } catch (err) {
    const error = formatErrorMessage(err);
    logger.warn("sessions_send announce delivery failed", {
      runId: params.runContextId,
      channel: params.announceTarget.channel,
      to: params.announceTarget.to,
      error,
    });
    return {
      status: "failed",
      reply: trimmedReply,
      error,
    };
  }
}
