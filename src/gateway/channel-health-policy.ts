// Gateway channel health policy.
// Evaluates channel lifecycle snapshots for restart/readiness decisions.
import type { ChannelId } from "../channels/plugins/types.public.js";

type ChannelHealthSnapshot = {
  running?: boolean;
  connected?: boolean;
  enabled?: boolean;
  configured?: boolean;
  restartPending?: boolean;
  busy?: boolean;
  activeRuns?: number;
  lastRunActivityAt?: number | null;
  lastEventAt?: number | null;
  lastConnectedAt?: number | null;
  lastTransportActivityAt?: number | null;
  lastSocketConnectedAt?: number | null;
  lastSocketDisconnectedAt?: number | null;
  lastSocketReconnectAt?: number | null;
  lastSocketEnvelopeAt?: number | null;
  lastSlackEventAt?: number | null;
  socketActiveState?: "active" | "inactive" | "unknown";
  socketActiveStateAvailable?: boolean;
  lastSocketError?: string | { at?: number; error?: string } | null;
  lastStartAt?: number | null;
  reconnectAttempts?: number;
  healthState?: string | null;
  mode?: string;
};

type ChannelHealthEvaluationReason =
  | "healthy"
  | "unmanaged"
  | "not-running"
  | "busy"
  | "stuck"
  | "startup-connect-grace"
  | "disconnected"
  | "stale-socket"
  | "socket-unhealthy";

export type ChannelHealthEvaluation = {
  healthy: boolean;
  reason: ChannelHealthEvaluationReason;
};

export type ChannelHealthPolicy = {
  channelId: ChannelId;
  now: number;
  staleEventThresholdMs: number;
  channelConnectGraceMs: number;
};

type ChannelRestartReason =
  | "gave-up"
  | "stopped"
  | "stale-socket"
  | "stuck"
  | "disconnected"
  | "socket-unhealthy";

function isManagedAccount(snapshot: ChannelHealthSnapshot): boolean {
  return snapshot.enabled !== false && snapshot.configured !== false;
}

const BUSY_ACTIVITY_STALE_THRESHOLD_MS = 25 * 60_000;
// Keep these shared between the background health monitor and on-demand readiness
// probes so both surfaces evaluate channel lifecycle windows consistently.
export const DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS = 10 * 60_000;
export const DEFAULT_CHANNEL_CONNECT_GRACE_MS = 120_000;

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readTimedErrorAt(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return readFiniteNumber((value as { at?: unknown }).at);
}

function latestNumber(...values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value != null);
  return finite.length > 0 ? Math.max(...finite) : null;
}

function isAtOrAfterLifecycle(value: number | null, lifecycleAnchor: number | null): boolean {
  return value != null && (lifecycleAnchor == null || value >= lifecycleAnchor);
}

function isSlackSocketMode(snapshot: ChannelHealthSnapshot, channelId: string): boolean {
  return channelId === "slack" && snapshot.mode !== "http";
}

export function evaluateChannelHealth(
  snapshot: ChannelHealthSnapshot,
  policy: ChannelHealthPolicy,
): ChannelHealthEvaluation {
  if (!isManagedAccount(snapshot)) {
    return { healthy: true, reason: "unmanaged" };
  }
  if (!snapshot.running) {
    return { healthy: false, reason: "not-running" };
  }
  const activeRuns =
    typeof snapshot.activeRuns === "number" && Number.isFinite(snapshot.activeRuns)
      ? Math.max(0, Math.trunc(snapshot.activeRuns))
      : 0;
  const isBusy = snapshot.busy === true || activeRuns > 0;
  const lastStartAt = readFiniteNumber(snapshot.lastStartAt);
  const lastRunActivityAt = readFiniteNumber(snapshot.lastRunActivityAt);
  const lastTransportActivityAt = readFiniteNumber(snapshot.lastTransportActivityAt);
  const lastSocketConnectedAt = readFiniteNumber(snapshot.lastSocketConnectedAt);
  const lastSocketDisconnectedAt = readFiniteNumber(snapshot.lastSocketDisconnectedAt);
  const lastSocketReconnectAt = readFiniteNumber(snapshot.lastSocketReconnectAt);
  const lastSocketEnvelopeAt = readFiniteNumber(snapshot.lastSocketEnvelopeAt);
  const lastSlackEventAt = readFiniteNumber(snapshot.lastSlackEventAt);
  const lastSocketErrorAt = readTimedErrorAt(snapshot.lastSocketError);
  const lifecycleAnchor = latestNumber(lastStartAt, lastSocketConnectedAt);
  const currentSocketErrorAt = isAtOrAfterLifecycle(lastSocketErrorAt, lifecycleAnchor)
    ? lastSocketErrorAt
    : null;
  const currentSocketDisconnectedAt =
    isAtOrAfterLifecycle(lastSocketDisconnectedAt, lifecycleAnchor) &&
    lastSocketDisconnectedAt != null &&
    (lastSocketConnectedAt == null || lastSocketDisconnectedAt > lastSocketConnectedAt)
      ? lastSocketDisconnectedAt
      : null;
  const currentSocketReconnectAt =
    isAtOrAfterLifecycle(lastSocketReconnectAt, lifecycleAnchor) &&
    lastSocketReconnectAt != null &&
    (lastSocketConnectedAt == null || lastSocketReconnectAt >= lastSocketConnectedAt)
      ? lastSocketReconnectAt
      : null;
  const hasActiveSlackSocket =
    isSlackSocketMode(snapshot, policy.channelId) &&
    snapshot.connected === true &&
    snapshot.socketActiveStateAvailable === true &&
    snapshot.socketActiveState === "active";
  const latestReceiverActivityAt = latestNumber(lastSocketEnvelopeAt, lastSlackEventAt);
  const hasCurrentReceiverActivity = isAtOrAfterLifecycle(
    latestReceiverActivityAt,
    lifecycleAnchor,
  );
  const busyStateInitializedForLifecycle =
    lastStartAt == null || (lastRunActivityAt != null && lastRunActivityAt >= lastStartAt);

  // Runtime snapshots are patch-merged, so a restarted lifecycle can temporarily
  // inherit stale busy fields from the previous instance. Ignore busy short-circuit
  // until run activity is known to belong to the current lifecycle.
  if (isBusy) {
    if (!busyStateInitializedForLifecycle) {
      // Fall through to normal startup/disconnect checks below.
    } else {
      const runActivityAge =
        lastRunActivityAt == null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, policy.now - lastRunActivityAt);
      if (runActivityAge < BUSY_ACTIVITY_STALE_THRESHOLD_MS) {
        return { healthy: true, reason: "busy" };
      }
      return { healthy: false, reason: "stuck" };
    }
  }
  if (lastStartAt != null) {
    const upDuration = policy.now - lastStartAt;
    if (upDuration < policy.channelConnectGraceMs) {
      return { healthy: true, reason: "startup-connect-grace" };
    }
  }
  if (snapshot.connected === false) {
    return { healthy: false, reason: "disconnected" };
  }
  if (
    isSlackSocketMode(snapshot, policy.channelId) &&
    snapshot.socketActiveStateAvailable === true &&
    snapshot.socketActiveState === "inactive"
  ) {
    return { healthy: false, reason: "socket-unhealthy" };
  }
  if (!hasActiveSlackSocket && currentSocketDisconnectedAt != null) {
    return { healthy: false, reason: "disconnected" };
  }
  if (!hasActiveSlackSocket && currentSocketErrorAt != null) {
    return { healthy: false, reason: "socket-unhealthy" };
  }
  if (
    !hasActiveSlackSocket &&
    (snapshot.healthState === "reconnecting" ||
      snapshot.healthState === "disconnecting" ||
      snapshot.healthState === "socket-error")
  ) {
    return { healthy: false, reason: "socket-unhealthy" };
  }
  if (
    currentSocketReconnectAt != null &&
    latestNumber(lastSocketEnvelopeAt, lastSlackEventAt, lastSocketConnectedAt) ===
      currentSocketReconnectAt
  ) {
    return { healthy: false, reason: "socket-unhealthy" };
  }
  // App-level events are not socket liveness: quiet Slack/Discord workspaces can
  // go idle while their upstream clients maintain heartbeats internally.
  const shouldCheckStaleSocket =
    snapshot.connected === true &&
    lastTransportActivityAt != null &&
    !isSlackSocketMode(snapshot, policy.channelId);
  if (shouldCheckStaleSocket) {
    if (
      hasCurrentReceiverActivity &&
      latestReceiverActivityAt != null &&
      policy.now - latestReceiverActivityAt <= policy.staleEventThresholdMs
    ) {
      return { healthy: true, reason: "healthy" };
    }
    if (lastStartAt != null && lastTransportActivityAt < lastStartAt) {
      const lifecycleEventGap = Math.max(0, policy.now - lastStartAt);
      if (lifecycleEventGap <= policy.staleEventThresholdMs) {
        return { healthy: true, reason: "healthy" };
      }
      return { healthy: false, reason: "stale-socket" };
    }
    const eventAge = policy.now - lastTransportActivityAt;
    if (eventAge > policy.staleEventThresholdMs) {
      return { healthy: false, reason: "stale-socket" };
    }
  }
  return { healthy: true, reason: "healthy" };
}

export function resolveChannelRestartReason(
  snapshot: ChannelHealthSnapshot,
  evaluation: ChannelHealthEvaluation,
): ChannelRestartReason {
  // Restart reasons are intentionally coarse: downstream logs/UI need stable
  // categories, while detailed channel state stays in the health snapshot.
  if (evaluation.reason === "stale-socket") {
    return "stale-socket";
  }
  if (evaluation.reason === "not-running") {
    return snapshot.reconnectAttempts && snapshot.reconnectAttempts >= 10 ? "gave-up" : "stopped";
  }
  if (evaluation.reason === "disconnected") {
    return "disconnected";
  }
  if (evaluation.reason === "socket-unhealthy") {
    return "socket-unhealthy";
  }
  return "stuck";
}
