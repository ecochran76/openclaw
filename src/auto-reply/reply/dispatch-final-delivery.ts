import { logVerbose } from "../../globals.js";
import type { ReplyPayload } from "../types.js";
import type { DeliveryObserver } from "./delivery-observer.js";
import { deliverObservedPayload } from "./observed-reply-delivery.js";

export async function sendDispatchFinalPayload(params: {
  payload: ReplyPayload;
  applyTts: (payload: ReplyPayload) => Promise<ReplyPayload>;
  observer: DeliveryObserver;
  updateTrackedTurnState: (
    patch: Parameters<DeliveryObserver["updateActiveTurn"]>[0],
  ) => ReturnType<DeliveryObserver["updateActiveTurn"]>;
  route?: {
    enabled: boolean;
    deliver: (payload: ReplyPayload) => Promise<{ ok: boolean; error?: string }>;
    logMessage: string;
  };
  dispatch: {
    sendFinalReply: (payload: ReplyPayload) => boolean;
  };
}): Promise<{ queuedFinal: boolean; routedFinalCount: number }> {
  const ttsPayload = await params.applyTts(params.payload);
  params.updateTrackedTurnState({
    phase: "delivery_prepare",
    markVisible: true,
    markProgress: true,
  });
  const result = await deliverObservedPayload({
    payload: ttsPayload,
    observer: params.observer,
    successState: "final_sent",
    route: params.route
      ? {
          enabled: params.route.enabled,
          deliver: async () => await params.route!.deliver(ttsPayload),
          failureText: "route-reply failed",
          logMessage: params.route.logMessage,
          logFailure: logVerbose,
        }
      : undefined,
    dispatch: {
      send: () => params.dispatch.sendFinalReply(ttsPayload),
      failureText: "dispatcher rejected final reply",
    },
  });
  return {
    queuedFinal: result.delivered,
    routedFinalCount: result.routedCount,
  };
}

export async function maybeSendSyntheticBlockTtsFinal(params: {
  ttsMode: string | undefined;
  repliesLength: number;
  blockCount: number;
  accumulatedBlockText: string;
  synthesizeFinalTts: (payload: ReplyPayload) => Promise<ReplyPayload>;
  observer: DeliveryObserver;
  route?: {
    enabled: boolean;
    deliver: (payload: ReplyPayload) => Promise<{ ok: boolean; error?: string }>;
    logMessage: string;
  };
  dispatch: {
    sendFinalReply: (payload: ReplyPayload) => boolean;
  };
}): Promise<{ queuedFinal: boolean; routedFinalCount: number }> {
  if (
    params.ttsMode !== "final" ||
    params.repliesLength !== 0 ||
    params.blockCount <= 0 ||
    !params.accumulatedBlockText.trim()
  ) {
    return { queuedFinal: false, routedFinalCount: 0 };
  }

  try {
    const ttsSyntheticReply = await params.synthesizeFinalTts({
      text: params.accumulatedBlockText,
    });
    if (!ttsSyntheticReply.mediaUrl) {
      return { queuedFinal: false, routedFinalCount: 0 };
    }
    const ttsOnlyPayload: ReplyPayload = {
      mediaUrl: ttsSyntheticReply.mediaUrl,
      audioAsVoice: ttsSyntheticReply.audioAsVoice,
    };
    const result = await deliverObservedPayload({
      payload: ttsOnlyPayload,
      observer: params.observer,
      successState: "final_sent",
      route: params.route
        ? {
            enabled: params.route.enabled,
            deliver: async () => await params.route!.deliver(ttsOnlyPayload),
            failureText: "route-reply failed",
            logMessage: params.route.logMessage,
            logFailure: logVerbose,
          }
        : undefined,
      dispatch: {
        send: () => params.dispatch.sendFinalReply(ttsOnlyPayload),
        failureText: "dispatcher rejected final TTS reply",
      },
    });
    return {
      queuedFinal: result.delivered,
      routedFinalCount: result.routedCount,
    };
  } catch (err) {
    logVerbose(
      `dispatch-from-config: accumulated block TTS failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { queuedFinal: false, routedFinalCount: 0 };
  }
}
