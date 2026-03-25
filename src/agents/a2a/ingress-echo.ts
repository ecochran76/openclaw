import crypto from "node:crypto";
import { callGateway } from "../../gateway/call.js";
import { resolveAnnounceTarget as defaultResolveAnnounceTarget } from "../tools/sessions-announce-target.js";
import {
  buildAgentToAgentIngressEchoText,
  type IngressEchoPolicy,
} from "../tools/sessions-send-helpers.js";
import type { AnnounceTarget } from "../tools/sessions-send-helpers.js";

export type IngressEchoResult = {
  status: "disabled" | "not_applicable" | "sent" | "failed" | "blocked";
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
  messageId?: string;
  error?: string;
};

export type IngressEchoAttemptResult = {
  ingressEcho: IngressEchoResult;
  requiredFailure: boolean;
};

export type IngressEchoDeps = {
  callGateway?: typeof callGateway;
  resolveAnnounceTarget?: typeof defaultResolveAnnounceTarget;
};

export type IngressEchoParams = {
  policy: IngressEchoPolicy;
  sessionKey: string;
  displayKey: string;
  message: string;
  requesterSessionKey?: string;
  requesterChannel?: string;
};

function errorText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function buildSentIngressEcho(
  target: AnnounceTarget,
  response: { threadId?: unknown; messageId?: unknown; id?: unknown },
): IngressEchoResult {
  return {
    status: "sent",
    channel: target.channel,
    to: target.to,
    accountId: target.accountId,
    threadId:
      (typeof response.threadId === "string" ? response.threadId : undefined) ?? target.threadId,
    messageId:
      typeof response.messageId === "string"
        ? response.messageId
        : typeof response.id === "string"
          ? response.id
          : undefined,
  };
}

export async function attemptIngressEcho(
  params: IngressEchoParams,
  deps?: IngressEchoDeps,
): Promise<IngressEchoAttemptResult> {
  const gatewayCall = deps?.callGateway ?? callGateway;
  const resolveAnnounceTarget = deps?.resolveAnnounceTarget ?? defaultResolveAnnounceTarget;

  if (!params.policy.enabled) {
    return {
      ingressEcho: { status: "disabled" },
      requiredFailure: false,
    };
  }

  let announceTarget: AnnounceTarget | null = null;
  try {
    announceTarget = await resolveAnnounceTarget({
      sessionKey: params.sessionKey,
      displayKey: params.displayKey,
    });
  } catch (err) {
    const error = errorText(err);
    return {
      ingressEcho: params.policy.requireDelivery
        ? { status: "blocked", error }
        : { status: "failed", error },
      requiredFailure: params.policy.requireDelivery,
    };
  }

  if (!announceTarget) {
    const error = "No ingress echo target could be resolved.";
    return {
      ingressEcho: params.policy.requireDelivery
        ? { status: "blocked", error }
        : { status: "not_applicable" },
      requiredFailure: params.policy.requireDelivery,
    };
  }

  const echoMessage = buildAgentToAgentIngressEchoText({
    requesterSessionKey: params.requesterSessionKey,
    requesterChannel: params.requesterChannel,
    targetSessionKey: params.displayKey,
    message: params.message,
  });

  try {
    const response = await gatewayCall({
      method: "send",
      params: {
        to: announceTarget.to,
        message: echoMessage,
        channel: announceTarget.channel,
        accountId: announceTarget.accountId,
        threadId: announceTarget.threadId,
        idempotencyKey: crypto.randomUUID(),
      },
      timeoutMs: 10_000,
    });

    return {
      ingressEcho: buildSentIngressEcho(announceTarget, response ?? {}),
      requiredFailure: false,
    };
  } catch (err) {
    const error = errorText(err);
    return {
      ingressEcho: {
        status: params.policy.requireDelivery ? "blocked" : "failed",
        channel: announceTarget.channel,
        to: announceTarget.to,
        accountId: announceTarget.accountId,
        threadId: announceTarget.threadId,
        error,
      },
      requiredFailure: params.policy.requireDelivery,
    };
  }
}
