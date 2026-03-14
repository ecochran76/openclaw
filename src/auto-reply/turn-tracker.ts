import crypto from "node:crypto";
import { formatDurationCompact } from "../infra/format-time/format-duration.js";

export type TrackedTurnPhase =
  | "received"
  | "reasoning"
  | "tool_wait"
  | "compaction"
  | "delivery_prepare"
  | "done"
  | "error";

export type TrackedTurnStatus = "active" | "done" | "error";

export type TrackedTurnDurationClass = "instant" | "short" | "medium" | "long";

export type TrackedTurnDeliveryState =
  | "pending"
  | "block_sent"
  | "final_sent"
  | "reply_stranded"
  | "delivery_failed"
  | "suppressed"
  | "none";

export type TrackedTurnDeliveryTarget = "same_channel" | "originating_channel";

export type TrackedTurnSuppressionReason = "silent" | "heartbeat" | "maintenance";

export type TrackedTurnSnapshot = {
  turnId: string;
  runId?: string;
  sessionKey: string;
  sessionId?: string;
  channel?: string;
  threadId?: string | number;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  durationClass: TrackedTurnDurationClass;
  phase: TrackedTurnPhase;
  status: TrackedTurnStatus;
  steerable: boolean;
  lastProgressAt: number;
  lastUserVisibleUpdateAt?: number;
  activeTool?: string;
  deliveryState?: TrackedTurnDeliveryState;
  deliveryTarget?: TrackedTurnDeliveryTarget;
  lastDeliveryAttemptAt?: number;
  lastDeliverySuccessAt?: number;
  lastDeliveryError?: string;
  replyProduced?: boolean;
  suppressionReason?: TrackedTurnSuppressionReason;
  lastError?: string;
  steerCount?: number;
  lastSteerAt?: number;
  lastSteerText?: string;
};

const RECENT_TURN_LIMIT = 5;

const activeBySession = new Map<string, TrackedTurnSnapshot>();
const recentListBySession = new Map<string, TrackedTurnSnapshot[]>();
const turnIdToSession = new Map<string, string>();
const runIdToTurnId = new Map<string, string>();

function clone(snapshot: TrackedTurnSnapshot): TrackedTurnSnapshot {
  return { ...snapshot };
}

export function classifyTurnDuration(elapsedMs: number): TrackedTurnDurationClass {
  if (elapsedMs < 5_000) {
    return "instant";
  }
  if (elapsedMs < 20_000) {
    return "short";
  }
  if (elapsedMs < 90_000) {
    return "medium";
  }
  return "long";
}

function applyElapsed(snapshot: TrackedTurnSnapshot, now = Date.now()): TrackedTurnSnapshot {
  const end = snapshot.completedAt ?? now;
  return {
    ...snapshot,
    durationClass: classifyTurnDuration(Math.max(0, end - snapshot.startedAt)),
  };
}

export function startTrackedTurn(params: {
  sessionKey: string;
  sessionId?: string;
  channel?: string;
  threadId?: string | number;
  startedAt?: number;
  phase?: TrackedTurnPhase;
  steerable?: boolean;
  deliveryTarget?: TrackedTurnDeliveryTarget;
}): TrackedTurnSnapshot {
  const startedAt = params.startedAt ?? Date.now();
  const snapshot: TrackedTurnSnapshot = {
    turnId: crypto.randomUUID(),
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    channel: params.channel,
    threadId: params.threadId,
    startedAt,
    updatedAt: startedAt,
    durationClass: "instant",
    phase: params.phase ?? "received",
    status: "active",
    steerable: params.steerable ?? true,
    lastProgressAt: startedAt,
    deliveryState: "pending",
    deliveryTarget: params.deliveryTarget,
    replyProduced: false,
  };
  activeBySession.set(params.sessionKey, snapshot);
  turnIdToSession.set(snapshot.turnId, params.sessionKey);
  return clone(snapshot);
}

export function attachTrackedTurnRunId(turnId: string, runId: string): void {
  const sessionKey = turnIdToSession.get(turnId);
  if (!sessionKey) {
    return;
  }
  const current = activeBySession.get(sessionKey);
  if (!current || current.turnId !== turnId) {
    return;
  }
  current.runId = runId;
  current.updatedAt = Date.now();
  runIdToTurnId.set(runId, turnId);
}

export function updateTrackedTurn(
  turnId: string,
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
): TrackedTurnSnapshot | undefined {
  const sessionKey = turnIdToSession.get(turnId);
  if (!sessionKey) {
    return undefined;
  }
  const current = activeBySession.get(sessionKey);
  if (!current || current.turnId !== turnId) {
    return undefined;
  }
  const at = patch.at ?? Date.now();
  if (patch.phase) {
    current.phase = patch.phase;
  }
  if (patch.activeTool !== undefined) {
    current.activeTool = patch.activeTool || undefined;
  }
  if (patch.lastError !== undefined) {
    current.lastError = patch.lastError || undefined;
  }
  if (patch.steerable !== undefined) {
    current.steerable = patch.steerable;
  }
  if (patch.deliveryState !== undefined) {
    current.deliveryState = patch.deliveryState;
  }
  if (patch.deliveryTarget !== undefined) {
    current.deliveryTarget = patch.deliveryTarget;
  }
  if (patch.lastDeliveryAttemptAt !== undefined) {
    current.lastDeliveryAttemptAt = patch.lastDeliveryAttemptAt;
  }
  if (patch.lastDeliverySuccessAt !== undefined) {
    current.lastDeliverySuccessAt = patch.lastDeliverySuccessAt;
  }
  if (patch.lastDeliveryError !== undefined) {
    current.lastDeliveryError = patch.lastDeliveryError || undefined;
  }
  if (patch.replyProduced !== undefined) {
    current.replyProduced = patch.replyProduced;
  }
  if ("suppressionReason" in patch) {
    current.suppressionReason = patch.suppressionReason;
  }
  if (patch.status) {
    current.status = patch.status;
  }
  if (patch.markProgress) {
    current.lastProgressAt = at;
  }
  if (patch.markVisible) {
    current.lastUserVisibleUpdateAt = at;
  }
  current.updatedAt = at;
  activeBySession.set(sessionKey, current);
  return clone(applyElapsed(current, at));
}

export function finishTrackedTurn(params: {
  turnId: string;
  status?: TrackedTurnStatus;
  phase?: TrackedTurnPhase;
  error?: string;
  deliveryState?: TrackedTurnSnapshot["deliveryState"];
  completedAt?: number;
}): TrackedTurnSnapshot | undefined {
  const sessionKey = turnIdToSession.get(params.turnId);
  if (!sessionKey) {
    return undefined;
  }
  const current = activeBySession.get(sessionKey);
  if (!current || current.turnId !== params.turnId) {
    return undefined;
  }
  const completedAt = params.completedAt ?? Date.now();
  current.status = params.status ?? (params.error ? "error" : "done");
  current.phase = params.phase ?? (current.status === "error" ? "error" : "done");
  current.lastError = params.error ?? current.lastError;
  current.completedAt = completedAt;
  current.updatedAt = completedAt;
  current.lastProgressAt = completedAt;
  if (params.deliveryState !== undefined) {
    current.deliveryState = params.deliveryState;
  }
  const finalized = applyElapsed(current, completedAt);
  activeBySession.delete(sessionKey);
  const recent = recentListBySession.get(sessionKey) ?? [];
  recent.unshift(finalized);
  recentListBySession.set(sessionKey, recent.slice(0, RECENT_TURN_LIMIT));
  if (current.runId) {
    runIdToTurnId.delete(current.runId);
  }
  turnIdToSession.delete(params.turnId);
  return clone(finalized);
}

export function getActiveTrackedTurn(sessionKey: string): TrackedTurnSnapshot | undefined {
  const current = activeBySession.get(sessionKey);
  return current ? clone(applyElapsed(current)) : undefined;
}

export function getRecentTrackedTurn(sessionKey: string): TrackedTurnSnapshot | undefined {
  const recent = recentListBySession.get(sessionKey)?.[0];
  return recent ? clone(applyElapsed(recent)) : undefined;
}

export function getRecentTrackedTurns(
  sessionKey: string,
  limit = RECENT_TURN_LIMIT,
): TrackedTurnSnapshot[] {
  return (recentListBySession.get(sessionKey) ?? [])
    .slice(0, limit)
    .map((turn) => clone(applyElapsed(turn)));
}

export function recordTrackedTurnSteer(
  turnId: string,
  params: {
    text: string;
    at?: number;
  },
): TrackedTurnSnapshot | undefined {
  const sessionKey = turnIdToSession.get(turnId);
  if (!sessionKey) {
    return undefined;
  }
  const current = activeBySession.get(sessionKey);
  if (!current || current.turnId !== turnId) {
    return undefined;
  }
  const at = params.at ?? Date.now();
  current.steerCount = (current.steerCount ?? 0) + 1;
  current.lastSteerAt = at;
  current.lastSteerText = params.text;
  current.updatedAt = at;
  activeBySession.set(sessionKey, current);
  return clone(applyElapsed(current, at));
}
export function formatTrackedTurnAgo(at?: number, now = Date.now()): string {
  if (!at) {
    return "n/a";
  }
  const delta = Math.max(0, now - at);
  return formatDurationCompact(delta, { spaced: true }) ?? "0s";
}

function formatTrackedTurnTextPreview(text: string, maxChars = 120): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function getTrackedTurnSteerCount(snapshot: TrackedTurnSnapshot): number {
  return snapshot.steerCount ?? (snapshot.lastSteerAt ? 1 : 0);
}

function describePhase(phase: TrackedTurnPhase): string {
  switch (phase) {
    case "received":
      return "received";
    case "reasoning":
      return "reasoning";
    case "tool_wait":
      return "tool wait";
    case "compaction":
      return "compacting context";
    case "delivery_prepare":
      return "preparing reply";
    case "done":
      return "done";
    case "error":
      return "error";
  }
}

function describeDeliveryState(state?: TrackedTurnDeliveryState): string {
  switch (state) {
    case "pending":
      return "reply pending";
    case "block_sent":
      return "block sent";
    case "final_sent":
      return "final sent";
    case "reply_stranded":
      return "reply stranded";
    case "delivery_failed":
      return "delivery failed";
    case "suppressed":
      return "suppressed";
    case "none":
      return "no visible reply";
    default:
      return "unknown";
  }
}

function describeDeliveryTarget(target?: TrackedTurnDeliveryTarget): string {
  switch (target) {
    case "same_channel":
      return "same channel";
    case "originating_channel":
      return "originating channel";
    default:
      return "unknown";
  }
}

function describeSuppressionReason(reason?: TrackedTurnSuppressionReason): string | undefined {
  switch (reason) {
    case "silent":
      return "ordinary silent reply";
    case "heartbeat":
      return "heartbeat suppression";
    case "maintenance":
      return "maintenance turn";
    default:
      return undefined;
  }
}

export function buildTurnProgressLine(snapshot: TrackedTurnSnapshot): string {
  const toolSuffix = snapshot.activeTool ? ` (${snapshot.activeTool})` : "";
  return `working: ${describePhase(snapshot.phase)}${toolSuffix}`;
}

function buildTurnLine(
  snapshot: TrackedTurnSnapshot,
  opts?: { active?: boolean; index?: number },
): string {
  const label = opts?.active ? "active" : snapshot.status;
  const parts = [
    label,
    describePhase(snapshot.phase),
    snapshot.durationClass,
    describeDeliveryState(snapshot.deliveryState),
  ];
  const suppressionReason = describeSuppressionReason(snapshot.suppressionReason);
  if (suppressionReason) {
    parts.push(suppressionReason);
  }
  if (snapshot.steerable && opts?.active) {
    parts.push("steerable");
  }
  const steerCount = getTrackedTurnSteerCount(snapshot);
  if (steerCount > 0) {
    parts.push(`steers:${steerCount}`);
  }
  if (snapshot.activeTool) {
    parts.push(snapshot.activeTool);
  }
  const prefix = typeof opts?.index === "number" ? `${opts.index + 1}. ` : "- ";
  return `${prefix}${parts.join(" · ")}`;
}
export function buildTurnSummaryLine(params: {
  active?: TrackedTurnSnapshot;
  recent?: TrackedTurnSnapshot;
}): string | undefined {
  const snapshot = params.active ?? params.recent;
  if (!snapshot) {
    return undefined;
  }
  const prefix = params.active ? "🧭 Turn" : "🧭 Recent turn";
  const parts = [
    params.active ? "active" : snapshot.status,
    describePhase(snapshot.phase),
    snapshot.durationClass,
    describeDeliveryState(snapshot.deliveryState),
  ];
  const suppressionReason = describeSuppressionReason(snapshot.suppressionReason);
  if (suppressionReason) {
    parts.push(suppressionReason);
  }
  if (snapshot.activeTool) {
    parts.push(snapshot.activeTool);
  }
  return `${prefix}: ${parts.join(" · ")}`;
}

export function buildTurnsText(params: {
  active?: TrackedTurnSnapshot;
  recents?: TrackedTurnSnapshot[];
  now?: number;
}): string {
  const active = params.active;
  const recents = params.recents ?? [];
  if (!active && recents.length === 0) {
    return "🧭 Turns\nNo active or recent turns for this session.";
  }
  const lines = ["🧭 Turns"];
  if (active) {
    lines.push(buildTurnLine(active, { active: true }));
  }
  for (const [index, turn] of recents.entries()) {
    lines.push(buildTurnLine(turn, { index }));
  }
  return lines.join("\n");
}

export function buildNudgeText(params: {
  active?: TrackedTurnSnapshot;
  recent?: TrackedTurnSnapshot;
  now?: number;
}): string {
  const now = params.now ?? Date.now();
  if (params.active) {
    const active = params.active;
    const lines = ["🧭 Nudge", buildTurnProgressLine(active)];
    lines.push(`Delivery: ${describeDeliveryState(active.deliveryState)}`);
    lines.push(`Last progress: ${formatTrackedTurnAgo(active.lastProgressAt, now)} ago`);
    if (active.activeTool) {
      lines.push(`Tool: ${active.activeTool}`);
    }
    return lines.join("\n");
  }
  if (params.recent) {
    return `🧭 Nudge\nNo active turn to nudge.\nRecent: ${buildTurnLine(params.recent).slice(2)}`;
  }
  return "🧭 Nudge\nNo active turn to nudge.";
}

export function buildWhySilentText(params: {
  active?: TrackedTurnSnapshot;
  recent?: TrackedTurnSnapshot;
  now?: number;
}): string {
  const now = params.now ?? Date.now();
  const snapshot = params.active ?? params.recent;
  if (!snapshot) {
    return "🤫 Why silent\nNo active or recent turn for this session.";
  }
  const lines = ["🤫 Why silent"];
  if (params.active) {
    if (snapshot.deliveryState === "delivery_failed") {
      lines.push("Answer: the reply was produced, but delivery failed.");
    } else if (snapshot.deliveryState === "suppressed") {
      if (snapshot.suppressionReason === "maintenance") {
        lines.push(
          "Answer: the turn is a maintenance-only turn that intentionally produced no visible reply.",
        );
      } else {
        lines.push("Answer: the turn is intentionally silent right now.");
      }
    } else if (snapshot.deliveryState === "reply_stranded") {
      lines.push("Answer: the turn looks stranded after producing a reply.");
    } else {
      lines.push("Answer: the turn is still working.");
    }
  } else {
    switch (snapshot.deliveryState) {
      case "delivery_failed":
        lines.push("Answer: the last turn produced a reply, but delivery failed.");
        break;
      case "reply_stranded":
        lines.push("Answer: the last turn finished, but no visible reply was sent.");
        break;
      case "suppressed":
        if (snapshot.suppressionReason === "maintenance") {
          lines.push(
            "Answer: the last turn was a maintenance-only turn that intentionally produced no visible reply.",
          );
        } else {
          lines.push(
            "Answer: the last turn intentionally produced no user-visible reply (for example NO_REPLY or heartbeat suppression).",
          );
        }
        break;
      case "block_sent":
      case "final_sent":
        lines.push("Answer: the runtime believes a visible reply was already delivered.");
        break;
      default:
        lines.push("Answer: there is no active silent failure right now.");
        break;
    }
  }
  lines.push(`Phase: ${describePhase(snapshot.phase)}`);
  lines.push(`State: ${params.active ? "active" : snapshot.status}`);
  lines.push(`Delivery: ${describeDeliveryState(snapshot.deliveryState)}`);
  const suppressionReason = describeSuppressionReason(snapshot.suppressionReason);
  if (suppressionReason) {
    lines.push(`Suppression: ${suppressionReason}`);
  }
  if (snapshot.deliveryTarget) {
    lines.push(`Delivery target: ${describeDeliveryTarget(snapshot.deliveryTarget)}`);
  }
  if (snapshot.activeTool) {
    lines.push(`Tool: ${snapshot.activeTool}`);
  }
  lines.push(`Last progress: ${formatTrackedTurnAgo(snapshot.lastProgressAt, now)} ago`);
  if (snapshot.lastUserVisibleUpdateAt) {
    lines.push(
      `Last visible update: ${formatTrackedTurnAgo(snapshot.lastUserVisibleUpdateAt, now)} ago`,
    );
  }
  if (snapshot.lastDeliveryAttemptAt) {
    lines.push(
      `Last delivery attempt: ${formatTrackedTurnAgo(snapshot.lastDeliveryAttemptAt, now)} ago`,
    );
  }
  if (snapshot.lastDeliveryError) {
    lines.push(`Delivery error: ${snapshot.lastDeliveryError}`);
  }
  return lines.join("\n");
}

export function buildTurnStatusText(params: {
  active?: TrackedTurnSnapshot;
  recent?: TrackedTurnSnapshot;
  now?: number;
}): string {
  const now = params.now ?? Date.now();
  const snapshot = params.active ?? params.recent;
  if (!snapshot) {
    return "🧭 Turn status\nNo active turn for this session.";
  }
  const elapsed = Math.max(0, (snapshot.completedAt ?? now) - snapshot.startedAt);
  const elapsedText = formatDurationCompact(elapsed, { spaced: true }) ?? "0s";
  const lines = ["🧭 Turn status"];
  lines.push(`State: ${params.active ? "active" : snapshot.status}`);
  lines.push(`Phase: ${describePhase(snapshot.phase)}`);
  lines.push(`Duration: ${elapsedText} (${snapshot.durationClass})`);
  lines.push(`Steerable: ${snapshot.steerable ? "yes" : "no"}`);
  const steerCount = getTrackedTurnSteerCount(snapshot);
  if (steerCount > 0) {
    lines.push(`Steers: ${steerCount}`);
    lines.push(`Last steer: ${formatTrackedTurnAgo(snapshot.lastSteerAt, now)} ago`);
    if (snapshot.lastSteerText) {
      lines.push(`Last steer text: ${formatTrackedTurnTextPreview(snapshot.lastSteerText)}`);
    }
  }
  if (snapshot.activeTool) {
    lines.push(`Tool: ${snapshot.activeTool}`);
  }
  lines.push(`Reply produced: ${snapshot.replyProduced ? "yes" : "no"}`);
  lines.push(`Delivery: ${describeDeliveryState(snapshot.deliveryState)}`);
  const suppressionReason = describeSuppressionReason(snapshot.suppressionReason);
  if (suppressionReason) {
    lines.push(`Suppression: ${suppressionReason}`);
  }
  if (snapshot.deliveryTarget) {
    lines.push(`Delivery target: ${describeDeliveryTarget(snapshot.deliveryTarget)}`);
  }
  if (snapshot.lastDeliveryAttemptAt) {
    lines.push(
      `Last delivery attempt: ${formatTrackedTurnAgo(snapshot.lastDeliveryAttemptAt, now)} ago`,
    );
  }
  if (snapshot.lastDeliverySuccessAt) {
    lines.push(
      `Last delivery success: ${formatTrackedTurnAgo(snapshot.lastDeliverySuccessAt, now)} ago`,
    );
  }
  lines.push(`Last progress: ${formatTrackedTurnAgo(snapshot.lastProgressAt, now)} ago`);
  lines.push(
    `Last visible update: ${snapshot.lastUserVisibleUpdateAt ? `${formatTrackedTurnAgo(snapshot.lastUserVisibleUpdateAt, now)} ago` : "none"}`,
  );
  if (snapshot.runId) {
    lines.push(`Run: ${snapshot.runId.slice(0, 8)}`);
  }
  if (snapshot.lastDeliveryError) {
    lines.push(`Delivery error: ${snapshot.lastDeliveryError}`);
  }
  if (snapshot.lastError) {
    lines.push(`Error: ${snapshot.lastError}`);
  }
  return lines.join("\n");
}

export function resetTrackedTurnsForTests(): void {
  activeBySession.clear();
  recentListBySession.clear();
  turnIdToSession.clear();
  runIdToTurnId.clear();
}
