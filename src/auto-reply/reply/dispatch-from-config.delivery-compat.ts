import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";
import { resolveReplyRoutingDecision } from "./routing-policy.js";

let routeReplyRuntimePromise: Promise<typeof import("./route-reply.runtime.js")> | null = null;

function loadRouteReplyRuntime() {
  routeReplyRuntimePromise ??= import("./route-reply.runtime.js");
  return routeReplyRuntimePromise;
}

type RouteReplyResult = Awaited<
  ReturnType<Awaited<ReturnType<typeof loadRouteReplyRuntime>>["routeReply"]>
>;

async function routeReplyToOriginatingChannel(params: {
  payload: ReplyPayload;
  shouldRouteToOriginating: boolean;
  routeReplyRuntime?: Awaited<ReturnType<typeof loadRouteReplyRuntime>>;
  originatingChannel?: string;
  originatingTo?: string;
  routeThreadId?: string | number;
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  isGroup: boolean;
  groupId?: string;
  accountId?: string;
  policyConversationType?: "direct" | "group";
  abortSignal?: AbortSignal;
  mirror?: boolean;
  markReplayUnsafe?: () => void;
}): Promise<RouteReplyResult | null> {
  if (
    !params.shouldRouteToOriginating ||
    !params.routeReplyRuntime ||
    !params.originatingChannel ||
    !params.originatingTo
  ) {
    return null;
  }
  params.markReplayUnsafe?.();
  return await params.routeReplyRuntime.routeReply({
    payload: params.payload,
    channel: params.originatingChannel,
    to: params.originatingTo,
    sessionKey: params.ctx.SessionKey,
    policySessionKey: resolveCommandTurnTargetSessionKey(params.ctx) ?? params.ctx.SessionKey,
    policyConversationType: params.policyConversationType,
    accountId: params.accountId ?? params.ctx.AccountId,
    requesterSenderId: params.ctx.SenderId,
    requesterSenderName: params.ctx.SenderName,
    requesterSenderUsername: params.ctx.SenderUsername,
    requesterSenderE164: params.ctx.SenderE164,
    threadId: params.routeThreadId,
    cfg: params.cfg,
    abortSignal: params.abortSignal,
    mirror: params.mirror,
    isGroup: params.isGroup,
    groupId: params.groupId,
  });
}

export type DispatchFromConfigDeliveryCompat = {
  currentSurface?: string;
  deliveryTarget: "originating_channel" | "same_channel";
  originatingChannel?: string;
  originatingTo?: string;
  sendBindingNotice: (payload: ReplyPayload, mode: "additive" | "terminal") => Promise<boolean>;
  sendPayloadAsync: (
    payload: ReplyPayload,
    abortSignal?: AbortSignal,
    mirror?: boolean,
  ) => Promise<boolean>;
  shouldRouteToOriginating: boolean;
  shouldSuppressTyping: boolean;
  ttsChannel?: string;
  visibleChannel?: string;
  routeReplyToOriginating: (
    payload: ReplyPayload,
    options?: { abortSignal?: AbortSignal; mirror?: boolean },
  ) => Promise<RouteReplyResult | null>;
};

export async function createDispatchFromConfigDeliveryCompat(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  dispatcher: ReplyDispatcher;
  groupId?: string;
  isGroup: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  routeThreadId?: string | number;
  suppressDirectUserDelivery: boolean;
  accountId?: string;
  policyConversationType?: "direct" | "group";
  markReplayUnsafe?: () => void;
}): Promise<DispatchFromConfigDeliveryCompat> {
  const normalizedOriginatingChannel = normalizeMessageChannel(
    params.originatingChannel ?? params.ctx.OriginatingChannel,
  );
  const normalizedProviderChannel = normalizeMessageChannel(params.ctx.Provider);
  const normalizedSurfaceChannel = normalizeMessageChannel(params.ctx.Surface);
  const normalizedCurrentSurface = normalizedProviderChannel ?? normalizedSurfaceChannel;
  const originatingTo = params.originatingTo ?? params.ctx.OriginatingTo;
  const isInternalWebchatTurn =
    normalizedCurrentSurface === INTERNAL_MESSAGE_CHANNEL &&
    (normalizedSurfaceChannel === INTERNAL_MESSAGE_CHANNEL || !normalizedSurfaceChannel) &&
    params.ctx.ExplicitDeliverRoute !== true;
  const hasRouteReplyCandidate = Boolean(
    !params.suppressDirectUserDelivery &&
    !isInternalWebchatTurn &&
    normalizedOriginatingChannel &&
    originatingTo &&
    normalizedOriginatingChannel !== normalizedCurrentSurface,
  );
  const routeReplyRuntime = hasRouteReplyCandidate ? await loadRouteReplyRuntime() : undefined;
  const { originatingChannel, currentSurface, shouldRouteToOriginating, shouldSuppressTyping } =
    resolveReplyRoutingDecision({
      provider: params.ctx.Provider,
      surface: params.ctx.Surface,
      explicitDeliverRoute: params.ctx.ExplicitDeliverRoute,
      originatingChannel: normalizedOriginatingChannel,
      originatingTo,
      suppressDirectUserDelivery: params.suppressDirectUserDelivery,
      isRoutableChannel: routeReplyRuntime?.isRoutableChannel ?? (() => false),
    });
  const ttsChannel = shouldRouteToOriginating ? originatingChannel : currentSurface;
  const visibleChannel = shouldRouteToOriginating ? originatingChannel : currentSurface;
  const deliveryTarget = shouldRouteToOriginating ? "originating_channel" : "same_channel";

  const routeReplyToOriginating = async (
    payload: ReplyPayload,
    options?: { abortSignal?: AbortSignal; mirror?: boolean },
  ) =>
    await routeReplyToOriginatingChannel({
      payload,
      shouldRouteToOriginating,
      routeReplyRuntime,
      originatingChannel,
      originatingTo,
      routeThreadId: params.routeThreadId,
      cfg: params.cfg,
      ctx: params.ctx,
      isGroup: params.isGroup,
      groupId: params.groupId,
      accountId: params.accountId,
      policyConversationType: params.policyConversationType,
      abortSignal: options?.abortSignal,
      mirror: options?.mirror,
      markReplayUnsafe: params.markReplayUnsafe,
    });

  const sendPayloadAsync = async (
    payload: ReplyPayload,
    abortSignal?: AbortSignal,
    mirror?: boolean,
  ): Promise<boolean> => {
    if (!routeReplyRuntime || !originatingChannel || !originatingTo || abortSignal?.aborted) {
      return false;
    }
    const result = await routeReplyToOriginating(payload, {
      abortSignal,
      mirror,
    });
    if (result && !result.ok) {
      logVerbose(`dispatch-from-config: route-reply failed: ${result.error ?? "unknown error"}`);
    }
    return result?.ok === true;
  };

  const sendBindingNotice = async (
    payload: ReplyPayload,
    mode: "additive" | "terminal",
  ): Promise<boolean> => {
    const result = await routeReplyToOriginating(payload);
    if (result) {
      if (!result.ok) {
        logVerbose(
          `dispatch-from-config: route-reply (plugin binding notice) failed: ${result.error ?? "unknown error"}`,
        );
      }
      return result.ok;
    }
    params.markReplayUnsafe?.();
    return mode === "additive"
      ? params.dispatcher.sendToolResult(payload)
      : params.dispatcher.sendFinalReply(payload);
  };

  return {
    currentSurface,
    deliveryTarget,
    originatingChannel,
    originatingTo,
    sendBindingNotice,
    sendPayloadAsync,
    shouldRouteToOriginating,
    shouldSuppressTyping,
    ttsChannel,
    visibleChannel,
    routeReplyToOriginating,
  };
}
