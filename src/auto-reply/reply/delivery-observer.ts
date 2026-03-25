import {
  attachTrackedTurnRunId,
  buildTurnProgressLine,
  finishTrackedTurn,
  getActiveTrackedTurn,
  startTrackedTurn,
  TRACKED_TURN_STALL_THRESHOLD_MS,
  type TrackedTurnDeliveryState,
  type TrackedTurnDeliveryTarget,
  type TrackedTurnPhase,
  type TrackedTurnSnapshot,
  type TrackedTurnStatus,
  type TrackedTurnSuppressionReason,
  updateTrackedTurn,
} from "../turn-tracker.js";
import type { ReplyPayload } from "../types.js";
import { normalizeReplyPayload } from "./normalize-reply.js";

type PayloadVisibility =
  | { visibility: "visible" | "empty" }
  | { visibility: "suppressed"; suppressionReason: TrackedTurnSuppressionReason };

type FinishTrackedTurnDeliveryState =
  | "pending"
  | "block_sent"
  | "final_sent"
  | "reply_stranded"
  | "delivery_failed"
  | "suppressed"
  | "none";

export type DeliveryObserver = {
  classifyPayloadVisibility: (payload: ReplyPayload) => PayloadVisibility;
  updateActiveTurn: (
    patch: Partial<
      Pick<
        TrackedTurnSnapshot,
        | "phase"
        | "activeTool"
        | "lastError"
        | "steerable"
        | "deliveryState"
        | "deliveryTarget"
        | "status"
        | "lastDeliveryAttemptAt"
        | "lastDeliverySuccessAt"
        | "lastDeliveryError"
        | "replyProduced"
        | "suppressionReason"
      >
    > & { markProgress?: boolean; markVisible?: boolean; at?: number },
  ) => TrackedTurnSnapshot | undefined;
  startRun: (runId: string) => void;
  markReplyProduced: () => void;
  recordDeliveryAttempt: () => void;
  recordDeliverySuccess: (state: "block_sent" | "final_sent") => void;
  recordDeliveryFailure: (error: string) => void;
  recordSuppressedReply: (suppressionReason: TrackedTurnSuppressionReason) => void;
  finishRun: (opts?: {
    status?: TrackedTurnStatus;
    phase?: TrackedTurnPhase;
    error?: string;
    deliveryState?: FinishTrackedTurnDeliveryState;
  }) => void;
  buildUndeliveredReplyNotice: () => string | undefined;
  markNoticeDelivered: () => void;
};

export function createDeliveryObserver(params: {
  sessionKey?: string;
  visibleChannel?: string;
  trackedSessionId?: string;
  threadId?: string | number;
  deliveryTarget: TrackedTurnDeliveryTarget;
  didMemoryFlushDuringTurn: () => boolean;
  onSendWatcherPayload: (payload: ReplyPayload, failureText: string) => Promise<boolean>;
}): DeliveryObserver {
  let trackedTurnId: string | undefined;
  let turnNudgeTimer: ReturnType<typeof setTimeout> | undefined;
  let firstTurnNudgeSent = false;
  let stalledNoticeSent = false;

  const clearTurnNudgeTimer = () => {
    if (turnNudgeTimer) {
      clearTimeout(turnNudgeTimer);
      turnNudgeTimer = undefined;
    }
  };

  const updateActiveTurn: DeliveryObserver["updateActiveTurn"] = (patch) => {
    if (!trackedTurnId) {
      return undefined;
    }
    return updateTrackedTurn(trackedTurnId, patch);
  };

  const classifyPayloadVisibility = (payload: ReplyPayload): PayloadVisibility => {
    let skipReason: "empty" | "silent" | "heartbeat" | undefined;
    const normalized = normalizeReplyPayload(payload, {
      onSkip: (reason) => {
        skipReason = reason;
      },
    });
    if (normalized) {
      return { visibility: "visible" };
    }
    if (skipReason === "heartbeat") {
      return { visibility: "suppressed", suppressionReason: "heartbeat" };
    }
    if (skipReason === "silent") {
      return {
        visibility: "suppressed",
        suppressionReason: params.didMemoryFlushDuringTurn() ? "maintenance" : "silent",
      };
    }
    return { visibility: "empty" };
  };

  const markReplyProduced = () => {
    updateActiveTurn({
      replyProduced: true,
      deliveryTarget: params.deliveryTarget,
      markProgress: true,
    });
  };

  const recordDeliveryAttempt = () => {
    updateActiveTurn({
      deliveryTarget: params.deliveryTarget,
      lastDeliveryAttemptAt: Date.now(),
      markProgress: true,
    });
  };

  const recordDeliverySuccess = (state: "block_sent" | "final_sent") => {
    const at = Date.now();
    updateActiveTurn({
      deliveryState: state,
      deliveryTarget: params.deliveryTarget,
      suppressionReason: undefined,
      lastDeliveryAttemptAt: at,
      lastDeliverySuccessAt: at,
      lastDeliveryError: undefined,
      markVisible: true,
    });
  };

  const recordDeliveryFailure = (error: string) => {
    updateActiveTurn({
      deliveryState: "delivery_failed",
      deliveryTarget: params.deliveryTarget,
      suppressionReason: undefined,
      lastDeliveryAttemptAt: Date.now(),
      lastDeliveryError: error,
      markProgress: true,
    });
  };

  const recordSuppressedReply = (suppressionReason: TrackedTurnSuppressionReason) => {
    updateActiveTurn({
      deliveryState: "suppressed",
      deliveryTarget: params.deliveryTarget,
      suppressionReason,
      markProgress: true,
    });
  };

  const recordReplyStranded = () => {
    updateActiveTurn({
      deliveryState: "reply_stranded",
      deliveryTarget: params.deliveryTarget,
      markProgress: true,
    });
  };

  const deriveTrackedTurnDeliveryState = (
    snapshot?: ReturnType<typeof getActiveTrackedTurn>,
    explicit?: FinishTrackedTurnDeliveryState,
  ): TrackedTurnDeliveryState | undefined => {
    if (explicit) {
      return explicit;
    }
    if (!snapshot) {
      return undefined;
    }
    if (snapshot.deliveryState === "delivery_failed") {
      return "delivery_failed";
    }
    if (snapshot.lastDeliverySuccessAt) {
      return snapshot.deliveryState;
    }
    if (snapshot.deliveryState === "suppressed") {
      return "suppressed";
    }
    if (snapshot.replyProduced) {
      return "reply_stranded";
    }
    return "none";
  };

  const finalizeTrackedTurnDeliveryState = (explicit?: FinishTrackedTurnDeliveryState) => {
    const snapshot = params.sessionKey ? getActiveTrackedTurn(params.sessionKey) : undefined;
    const derived = deriveTrackedTurnDeliveryState(snapshot, explicit);
    if (derived === "reply_stranded") {
      recordReplyStranded();
    }
    return { snapshot, derived };
  };

  const startRun = (runId: string) => {
    if (!params.sessionKey || params.visibleChannel !== "slack") {
      return;
    }
    const snapshot = startTrackedTurn({
      sessionKey: params.sessionKey,
      sessionId: params.trackedSessionId,
      channel: params.visibleChannel,
      threadId: params.threadId,
      phase: "reasoning",
      steerable: Boolean(params.trackedSessionId),
      deliveryTarget: params.deliveryTarget,
    });
    trackedTurnId = snapshot.turnId;
    attachTrackedTurnRunId(snapshot.turnId, runId);
    const schedule = (delayMs: number) => {
      clearTurnNudgeTimer();
      turnNudgeTimer = setTimeout(
        () => {
          void (async () => {
            const active =
              trackedTurnId && params.sessionKey
                ? getActiveTrackedTurn(params.sessionKey)
                : undefined;
            if (!active || active.turnId !== trackedTurnId) {
              return;
            }
            const now = Date.now();
            if (stalledNoticeSent && active.phase !== "stalled") {
              stalledNoticeSent = false;
            }
            const lastVisible = active.lastUserVisibleUpdateAt ?? active.startedAt;
            const thresholdMs = firstTurnNudgeSent ? 90_000 : 20_000;
            const timeUntilVisible = thresholdMs - (now - lastVisible);
            const timeUntilStall = stalledNoticeSent
              ? Number.POSITIVE_INFINITY
              : TRACKED_TURN_STALL_THRESHOLD_MS - (now - active.lastProgressAt);
            if (!stalledNoticeSent && active.phase === "stalled") {
              updateActiveTurn({
                phase: "stalled",
                deliveryTarget: params.deliveryTarget,
              });
              await params.onSendWatcherPayload(
                {
                  text: `status: turn appears stalled${active.activeTool ? ` (${active.activeTool})` : ""}`,
                },
                "dispatcher rejected stalled notice",
              );
              stalledNoticeSent = true;
              firstTurnNudgeSent = true;
              schedule(90_000);
              return;
            }
            if (
              timeUntilStall > 0 &&
              (timeUntilStall < timeUntilVisible ||
                (timeUntilVisible <= 0 && timeUntilStall <= 15_000))
            ) {
              schedule(timeUntilStall);
              return;
            }
            if (timeUntilVisible > 0) {
              schedule(timeUntilVisible);
              return;
            }
            if (stalledNoticeSent && active.phase === "stalled") {
              schedule(90_000);
              return;
            }
            await params.onSendWatcherPayload(
              { text: buildTurnProgressLine(active) },
              "dispatcher rejected block reply",
            );
            firstTurnNudgeSent = true;
            schedule(90_000);
          })();
        },
        Math.max(1000, delayMs),
      );
    };
    schedule(20_000);
  };

  const finishRun: DeliveryObserver["finishRun"] = (opts) => {
    clearTurnNudgeTimer();
    if (!trackedTurnId) {
      return;
    }
    const { derived } = finalizeTrackedTurnDeliveryState(opts?.deliveryState);
    finishTrackedTurn({
      turnId: trackedTurnId,
      status: opts?.status,
      phase: opts?.phase,
      error: opts?.error,
      deliveryState: derived,
    });
    trackedTurnId = undefined;
  };

  const buildUndeliveredReplyNotice = () => {
    if (!params.sessionKey || params.visibleChannel !== "slack") {
      return undefined;
    }
    const { snapshot, derived } = finalizeTrackedTurnDeliveryState();
    if (!snapshot || derived === "suppressed" || derived === "none") {
      return undefined;
    }
    if (derived === "delivery_failed") {
      return snapshot.lastDeliveryError
        ? `status: reply delivery failed (${snapshot.lastDeliveryError})`
        : "status: reply delivery failed";
    }
    if (derived === "reply_stranded") {
      return "status: turn finished but no visible reply was sent";
    }
    return undefined;
  };

  const markNoticeDelivered = () => {
    updateActiveTurn({
      markVisible: true,
      markProgress: true,
    });
  };

  return {
    classifyPayloadVisibility,
    updateActiveTurn,
    startRun,
    markReplyProduced,
    recordDeliveryAttempt,
    recordDeliverySuccess,
    recordDeliveryFailure,
    recordSuppressedReply,
    finishRun,
    buildUndeliveredReplyNotice,
    markNoticeDelivered,
  };
}
