/**
 * Status-safe channel account projection helpers for CLI, status APIs, and plugin SDK callers.
 * This file is the redaction boundary between runtime account objects and public snapshots.
 */
import { stripUrlUserInfo } from "@openclaw/net-policy/url-userinfo";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { isRecord } from "../utils.js";
import { asBoolean } from "../utils/boolean.js";
import type { ChannelAccountSnapshot } from "./plugins/types.core.js";

const CREDENTIAL_STATUS_KEYS = [
  "tokenStatus",
  "botTokenStatus",
  "appTokenStatus",
  "signingSecretStatus",
  "userTokenStatus",
] as const;

type CredentialStatusKey = (typeof CREDENTIAL_STATUS_KEYS)[number];

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  return asBoolean(record[key]);
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return asFiniteNumber(value);
}

function readNullableNumber(
  record: Record<string, unknown>,
  key: string,
): number | null | undefined {
  if (record[key] === null) {
    return null;
  }
  return readNumber(record, key);
}

function readTimedError(
  record: Record<string, unknown>,
  key: string,
): string | { at: number; error?: string } | null | undefined {
  const value = record[key];
  if (value === null || typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const at = readNumber(value, "at");
  if (at === undefined) {
    return undefined;
  }
  const error = normalizeOptionalString(value.error);
  return error ? { at, error } : { at };
}

function readNumberRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, number> | undefined {
  const value = record[key];
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [entryKey, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[entryKey] = Math.max(0, Math.trunc(raw));
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readStringUnion<T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  allowed: T,
): T[number] | undefined {
  const value = record[key];
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? value
    : undefined;
}

function readObjectRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, Record<string, unknown>> | undefined {
  const value = record[key];
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const [entryKey, raw] of Object.entries(value)) {
    if (isRecord(raw)) {
      out[entryKey] = { ...raw };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readSocketDisconnectReason(
  record: Record<string, unknown>,
): { at: number; reason?: string; kind?: string; expectedRefresh?: boolean } | null | undefined {
  const value = record.lastSocketDisconnectReason;
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const at = readNumber(value, "at");
  if (at === undefined) {
    return undefined;
  }
  return {
    at,
    ...(normalizeOptionalString(value.reason)
      ? { reason: normalizeOptionalString(value.reason) }
      : {}),
    ...(normalizeOptionalString(value.kind) ? { kind: normalizeOptionalString(value.kind) } : {}),
    ...(readBoolean(value, "expectedRefresh") !== undefined
      ? { expectedRefresh: readBoolean(value, "expectedRefresh") }
      : {}),
  };
}

function readSocketModeSettings(
  record: Record<string, unknown>,
): ChannelAccountSnapshot["socketModeSettings"] | undefined {
  const value = record.socketModeSettings;
  if (!isRecord(value)) {
    return undefined;
  }
  const clientPingTimeout = readNumber(value, "clientPingTimeout");
  const connectionCount = readNumber(value, "connectionCount");
  if (clientPingTimeout === undefined || connectionCount === undefined) {
    return undefined;
  }
  return {
    clientPingTimeout,
    connectionCount,
    ...(readNumber(value, "serverPingTimeout") !== undefined
      ? { serverPingTimeout: readNumber(value, "serverPingTimeout") }
      : {}),
    ...(readBoolean(value, "pingPongLoggingEnabled") !== undefined
      ? { pingPongLoggingEnabled: readBoolean(value, "pingPongLoggingEnabled") }
      : {}),
  };
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = normalizeStringEntries(
    value.map((entry) => (typeof entry === "string" || typeof entry === "number" ? entry : "")),
  );
  return normalized.length > 0 ? normalized : undefined;
}

function readCredentialStatus(record: Record<string, unknown>, key: CredentialStatusKey) {
  const value = record[key];
  return value === "available" || value === "configured_unavailable" || value === "missing"
    ? value
    : undefined;
}

/**
 * Infers whether any known credential status makes an account configured.
 *
 * Status commands need this metadata for "configured but unavailable" accounts without reading
 * raw credentials from runtime-only helpers.
 */
export function resolveConfiguredFromCredentialStatuses(account: unknown): boolean | undefined {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return undefined;
  }
  let sawCredentialStatus = false;
  for (const key of CREDENTIAL_STATUS_KEYS) {
    const status = readCredentialStatus(record, key);
    if (!status) {
      continue;
    }
    sawCredentialStatus = true;
    if (status !== "missing") {
      return true;
    }
  }
  return sawCredentialStatus ? false : undefined;
}

/** Infers configured state only from the credential status keys required by a channel. */
export function resolveConfiguredFromRequiredCredentialStatuses(
  account: unknown,
  requiredKeys: CredentialStatusKey[],
): boolean | undefined {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return undefined;
  }
  let sawCredentialStatus = false;
  for (const key of requiredKeys) {
    const status = readCredentialStatus(record, key);
    if (!status) {
      continue;
    }
    sawCredentialStatus = true;
    if (status === "missing") {
      return false;
    }
  }
  return sawCredentialStatus ? true : undefined;
}

/** Returns true when a credential exists but cannot be resolved at status-render time. */
export function hasConfiguredUnavailableCredentialStatus(account: unknown): boolean {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return false;
  }
  return CREDENTIAL_STATUS_KEYS.some(
    (key) => readCredentialStatus(record, key) === "configured_unavailable",
  );
}

/** Returns true when account data contains a resolved credential value or available status. */
export function hasResolvedCredentialValue(account: unknown): boolean {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return false;
  }
  return (
    ["token", "botToken", "appToken", "signingSecret", "userToken"].some((key) => {
      return normalizeOptionalString(record[key]) !== undefined;
    }) || CREDENTIAL_STATUS_KEYS.some((key) => readCredentialStatus(record, key) === "available")
  );
}

/** Projects credential source/status metadata while omitting raw credential values. */
export function projectCredentialSnapshotFields(
  account: unknown,
): Pick<
  Partial<ChannelAccountSnapshot>,
  | "tokenSource"
  | "botTokenSource"
  | "appTokenSource"
  | "signingSecretSource"
  | "tokenStatus"
  | "botTokenStatus"
  | "appTokenStatus"
  | "signingSecretStatus"
  | "userTokenStatus"
> {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return {};
  }
  const tokenSource = normalizeOptionalString(record.tokenSource);
  const botTokenSource = normalizeOptionalString(record.botTokenSource);
  const appTokenSource = normalizeOptionalString(record.appTokenSource);
  const signingSecretSource = normalizeOptionalString(record.signingSecretSource);

  // Only project source/status fields. Token-like values stay out of account snapshots even when
  // callers pass full runtime account objects.
  return {
    ...(tokenSource ? { tokenSource } : {}),
    ...(botTokenSource ? { botTokenSource } : {}),
    ...(appTokenSource ? { appTokenSource } : {}),
    ...(signingSecretSource ? { signingSecretSource } : {}),
    ...(readCredentialStatus(record, "tokenStatus")
      ? { tokenStatus: readCredentialStatus(record, "tokenStatus") }
      : {}),
    ...(readCredentialStatus(record, "botTokenStatus")
      ? { botTokenStatus: readCredentialStatus(record, "botTokenStatus") }
      : {}),
    ...(readCredentialStatus(record, "appTokenStatus")
      ? { appTokenStatus: readCredentialStatus(record, "appTokenStatus") }
      : {}),
    ...(readCredentialStatus(record, "signingSecretStatus")
      ? { signingSecretStatus: readCredentialStatus(record, "signingSecretStatus") }
      : {}),
    ...(readCredentialStatus(record, "userTokenStatus")
      ? { userTokenStatus: readCredentialStatus(record, "userTokenStatus") }
      : {}),
  };
}

/**
 * Projects status-safe account fields for read-only channel/account snapshots.
 *
 * This is the boundary between runtime account objects and status renderers; keep it explicit so
 * new channel fields do not accidentally expose webhook URLs, public keys, or raw credentials.
 */
export function projectSafeChannelAccountSnapshotFields(
  account: unknown,
): Partial<ChannelAccountSnapshot> {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return {};
  }
  const name = normalizeOptionalString(record.name);
  const statusState = normalizeOptionalString(record.statusState);
  const healthState = normalizeOptionalString(record.healthState);
  const mode = normalizeOptionalString(record.mode);
  const dmPolicy = normalizeOptionalString(record.dmPolicy);
  const baseUrl = normalizeOptionalString(record.baseUrl);
  const cliPath = normalizeOptionalString(record.cliPath);
  const dbPath = normalizeOptionalString(record.dbPath);

  return {
    ...(name ? { name } : {}),
    ...(readBoolean(record, "linked") !== undefined
      ? { linked: readBoolean(record, "linked") }
      : {}),
    ...(readBoolean(record, "running") !== undefined
      ? { running: readBoolean(record, "running") }
      : {}),
    ...(readBoolean(record, "connected") !== undefined
      ? { connected: readBoolean(record, "connected") }
      : {}),
    ...(readBoolean(record, "restartPending") !== undefined
      ? { restartPending: readBoolean(record, "restartPending") }
      : {}),
    ...(readNumber(record, "reconnectAttempts") !== undefined
      ? { reconnectAttempts: readNumber(record, "reconnectAttempts") }
      : {}),
    ...(readNullableNumber(record, "lastConnectedAt") !== undefined
      ? { lastConnectedAt: readNullableNumber(record, "lastConnectedAt") }
      : {}),
    ...(readNullableNumber(record, "lastSocketConnectedAt") !== undefined
      ? { lastSocketConnectedAt: readNullableNumber(record, "lastSocketConnectedAt") }
      : {}),
    ...(readNullableNumber(record, "lastSocketDisconnectedAt") !== undefined
      ? { lastSocketDisconnectedAt: readNullableNumber(record, "lastSocketDisconnectedAt") }
      : {}),
    ...(readNullableNumber(record, "lastSocketReconnectAt") !== undefined
      ? { lastSocketReconnectAt: readNullableNumber(record, "lastSocketReconnectAt") }
      : {}),
    ...(readNullableNumber(record, "lastSocketEnvelopeAt") !== undefined
      ? { lastSocketEnvelopeAt: readNullableNumber(record, "lastSocketEnvelopeAt") }
      : {}),
    ...(readNullableNumber(record, "lastSlackEventAt") !== undefined
      ? { lastSlackEventAt: readNullableNumber(record, "lastSlackEventAt") }
      : {}),
    ...(readStringUnion(record, "socketActiveState", ["active", "inactive", "unknown"] as const)
      ? {
          socketActiveState: readStringUnion(record, "socketActiveState", [
            "active",
            "inactive",
            "unknown",
          ] as const),
        }
      : {}),
    ...(readBoolean(record, "socketActiveStateAvailable") !== undefined
      ? { socketActiveStateAvailable: readBoolean(record, "socketActiveStateAvailable") }
      : {}),
    ...(readNumber(record, "socketConnectionCount") !== undefined
      ? { socketConnectionCount: readNumber(record, "socketConnectionCount") }
      : {}),
    ...(readSocketModeSettings(record) !== undefined
      ? { socketModeSettings: readSocketModeSettings(record) }
      : {}),
    ...(readObjectRecord(record, "socketConnections") !== undefined
      ? { socketConnections: readObjectRecord(record, "socketConnections") }
      : {}),
    ...(readSocketDisconnectReason(record) !== undefined
      ? { lastSocketDisconnectReason: readSocketDisconnectReason(record) }
      : {}),
    ...(readTimedError(record, "lastSocketError") !== undefined
      ? { lastSocketError: readTimedError(record, "lastSocketError") }
      : {}),
    ...(readNumberRecord(record, "slackTelemetry") !== undefined
      ? { slackTelemetry: readNumberRecord(record, "slackTelemetry") }
      : {}),
    ...(readNumber(record, "lastInboundAt") !== undefined
      ? { lastInboundAt: readNumber(record, "lastInboundAt") }
      : {}),
    ...(readNullableNumber(record, "lastOutboundAt") !== undefined
      ? { lastOutboundAt: readNullableNumber(record, "lastOutboundAt") }
      : {}),
    ...(readNullableNumber(record, "lastMessageAt") !== undefined
      ? { lastMessageAt: readNullableNumber(record, "lastMessageAt") }
      : {}),
    ...(readNullableNumber(record, "lastEventAt") !== undefined
      ? { lastEventAt: readNullableNumber(record, "lastEventAt") }
      : {}),
    ...(readNumber(record, "lastTransportActivityAt") !== undefined
      ? { lastTransportActivityAt: readNumber(record, "lastTransportActivityAt") }
      : {}),
    ...(statusState ? { statusState } : {}),
    ...(healthState ? { healthState } : {}),
    ...(readBoolean(record, "busy") !== undefined ? { busy: readBoolean(record, "busy") } : {}),
    ...(readNumber(record, "activeRuns") !== undefined
      ? { activeRuns: readNumber(record, "activeRuns") }
      : {}),
    ...(readNullableNumber(record, "lastRunActivityAt") !== undefined
      ? { lastRunActivityAt: readNullableNumber(record, "lastRunActivityAt") }
      : {}),
    ...(mode ? { mode } : {}),
    ...(dmPolicy ? { dmPolicy } : {}),
    ...(readStringArray(record, "allowFrom")
      ? { allowFrom: readStringArray(record, "allowFrom") }
      : {}),
    ...projectCredentialSnapshotFields(account),
    // Base URLs are useful diagnostics, but embedded userinfo would expose credentials.
    ...(baseUrl ? { baseUrl: stripUrlUserInfo(baseUrl) } : {}),
    ...(readBoolean(record, "allowUnmentionedGroups") !== undefined
      ? { allowUnmentionedGroups: readBoolean(record, "allowUnmentionedGroups") }
      : {}),
    ...(cliPath ? { cliPath } : {}),
    ...(dbPath ? { dbPath } : {}),
    ...(readNumber(record, "port") !== undefined ? { port: readNumber(record, "port") } : {}),
  };
}
