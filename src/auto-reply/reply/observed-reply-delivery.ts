import type { ReplyPayload } from "../types.js";
import type { DeliveryObserver } from "./delivery-observer.js";

export type ReplyDeliveryLog = (message: string) => void;

export async function deliverObservedPayload(params: {
  payload: ReplyPayload;
  observer: Pick<
    DeliveryObserver,
    | "classifyPayloadVisibility"
    | "markReplyProduced"
    | "recordDeliveryAttempt"
    | "recordSuppressedReply"
    | "recordDeliverySuccess"
    | "recordDeliveryFailure"
  >;
  successState: "block_sent" | "final_sent";
  route?: {
    enabled: boolean;
    deliver: () => Promise<{ ok: boolean; error?: string }>;
    failureText: string;
    logMessage?: string;
    logFailure?: ReplyDeliveryLog;
  };
  dispatch: {
    send: () => boolean;
    failureText: string;
  };
}): Promise<{ delivered: boolean; routedCount: number }> {
  const visibility = params.observer.classifyPayloadVisibility(params.payload);
  if (visibility.visibility === "visible") {
    params.observer.markReplyProduced();
    params.observer.recordDeliveryAttempt();
  } else if (visibility.visibility === "suppressed") {
    params.observer.recordSuppressedReply(visibility.suppressionReason);
  }

  if (params.route?.enabled) {
    const result = await params.route.deliver();
    if (!result.ok && params.route.logMessage && params.route.logFailure) {
      params.route.logFailure(`${params.route.logMessage}: ${result.error ?? "unknown error"}`);
    }
    if (visibility.visibility === "visible") {
      if (result.ok) {
        params.observer.recordDeliverySuccess(params.successState);
      } else {
        params.observer.recordDeliveryFailure(result.error ?? params.route.failureText);
      }
    }
    return {
      delivered: result.ok,
      routedCount: result.ok ? 1 : 0,
    };
  }

  const queued = params.dispatch.send();
  if (visibility.visibility === "visible") {
    if (queued) {
      params.observer.recordDeliverySuccess(params.successState);
    } else {
      params.observer.recordDeliveryFailure(params.dispatch.failureText);
    }
  }
  return {
    delivered: queued,
    routedCount: 0,
  };
}
