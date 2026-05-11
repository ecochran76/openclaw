import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { getA2APermissionApprovalReplyMetadata } from "../../agents/a2a/permission-approval-reply.js";
import { shouldSuppressLocalExecApprovalPrompt } from "../../channels/plugins/exec-approval-local.js";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { BlockReplyContext, ReplyPayload } from "../types.js";
import type { DeliveryObserver } from "./delivery-observer.js";
import { deliverObservedPayload } from "./observed-reply-delivery.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";

export type DispatchStreamDeliveryCoordinator = {
  deliverToolResult: (payload: ReplyPayload) => Promise<void>;
  deliverBlockReply: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void>;
  getAccumulatedBlockText: () => string;
  getBlockCount: () => number;
};

export function createDispatchStreamDeliveryCoordinator(params: {
  cfg: OpenClawConfig;
  currentChannel?: string;
  accountId?: string;
  shouldSendToolSummaries: boolean;
  observer: DeliveryObserver;
  applyTts: (kind: "tool" | "block", payload: ReplyPayload) => Promise<ReplyPayload>;
  onBlockReplyQueued?: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void;
  shouldRouteToOriginating: boolean;
  sendPayloadAsync: (
    payload: ReplyPayload,
    abortSignal?: AbortSignal,
    mirror?: boolean,
  ) => Promise<boolean>;
  dispatcher: Pick<ReplyDispatcher, "sendToolResult" | "sendBlockReply">;
}): DispatchStreamDeliveryCoordinator {
  let accumulatedBlockText = "";
  let blockCount = 0;

  const resolveToolDeliveryPayload = (payload: ReplyPayload): ReplyPayload | null => {
    if (
      shouldSuppressLocalExecApprovalPrompt({
        channel: normalizeMessageChannel(params.currentChannel),
        cfg: params.cfg,
        accountId: params.accountId,
        payload,
      })
    ) {
      return null;
    }
    if (params.shouldSendToolSummaries) {
      return payload;
    }
    const execApproval =
      payload.channelData &&
      typeof payload.channelData === "object" &&
      !Array.isArray(payload.channelData)
        ? payload.channelData.execApproval
        : undefined;
    if (execApproval && typeof execApproval === "object" && !Array.isArray(execApproval)) {
      return payload;
    }
    if (getA2APermissionApprovalReplyMetadata(payload) !== null) {
      return payload;
    }
    const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
    if (!hasMedia) {
      return null;
    }
    return { ...payload, text: undefined };
  };

  const observeBlockReply = (payload: ReplyPayload) => {
    if (payload.isReasoning === true) {
      return;
    }
    if (payload.text && !payload.isCompactionNotice) {
      if (accumulatedBlockText.length > 0) {
        accumulatedBlockText += "\n";
      }
      accumulatedBlockText += payload.text;
      blockCount++;
    }
  };

  const deliverToolResult = async (payload: ReplyPayload) => {
    const ttsPayload = await params.applyTts("tool", payload);
    const deliveryPayload = resolveToolDeliveryPayload(ttsPayload);
    if (!deliveryPayload) {
      return;
    }
    await deliverObservedPayload({
      payload: deliveryPayload,
      observer: params.observer,
      successState: "block_sent",
      route: {
        enabled: params.shouldRouteToOriginating,
        deliver: async () => ({
          ok: await params.sendPayloadAsync(deliveryPayload, undefined, false),
        }),
        failureText: "route-reply failed",
      },
      dispatch: {
        send: () => params.dispatcher.sendToolResult(deliveryPayload),
        failureText: "dispatcher rejected tool reply",
      },
    });
  };

  const deliverBlockReply = async (payload: ReplyPayload, context?: BlockReplyContext) => {
    if (payload.isReasoning === true) {
      return;
    }
    observeBlockReply(payload);
    const payloadMetadata = getReplyPayloadMetadata(payload);
    const queuedContext =
      payloadMetadata?.assistantMessageIndex !== undefined
        ? {
            ...context,
            assistantMessageIndex: payloadMetadata.assistantMessageIndex,
          }
        : context;
    await params.onBlockReplyQueued?.(payload, queuedContext);
    const ttsPayload = await params.applyTts("block", payload);
    await deliverObservedPayload({
      payload: ttsPayload,
      observer: params.observer,
      successState: "block_sent",
      route: {
        enabled: params.shouldRouteToOriginating,
        deliver: async () => ({
          ok: await params.sendPayloadAsync(ttsPayload, context?.abortSignal, false),
        }),
        failureText: "route-reply failed",
      },
      dispatch: {
        send: () => params.dispatcher.sendBlockReply(ttsPayload),
        failureText: "dispatcher rejected block reply",
      },
    });
  };

  return {
    deliverToolResult,
    deliverBlockReply,
    getAccumulatedBlockText: () => accumulatedBlockText,
    getBlockCount: () => blockCount,
  };
}
