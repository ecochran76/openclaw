import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { readChannelIngressStoreAllowFromForDmPolicy } from "../../channels/message-access/store-allow-from.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
} from "../../config/runtime-group-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { collectChannelStatusIssues } from "../../infra/channels-status-issues.js";
import { type FileLockOptions, withFileLock } from "../../infra/file-lock.js";
import { formatTimeAgo } from "../../infra/format-time/format-relative.js";
import { writeTextAtomic } from "../../infra/json-files.js";
import { buildOutboundBaseSessionKey } from "../../infra/outbound/base-session-key.js";
import {
  createPluginStateKeyedStore,
  type OpenKeyedStoreOptions,
  type PluginStateKeyedStore,
} from "../../plugin-state/plugin-state-store.js";
import { readPersistedInstalledPluginIndexSync } from "../../plugins/installed-plugin-index-store.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../../routing/session-key.js";
import {
  defaultRuntime,
  type OutputRuntimeEnv,
  type RuntimeEnv,
  writeRuntimeJson,
} from "../../runtime.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../../shared/store-writer-queue.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";

export type ChannelsSlackWatchdogScanOptions = {
  account?: string;
  tenantLabel?: string;
  target?: string;
  permalink?: string;
  channelName?: string;
  limit?: string;
  since?: string;
  botUser?: string;
  directMessage?: boolean;
  activeThread?: string;
  thread?: string;
  alertTarget?: string;
  alertAccount?: string;
  alertState?: string;
  replyMissed?: boolean;
  replyAccount?: string;
  replyState?: string;
  dryRunReplies?: boolean;
  maxReplies?: string;
  ledgerLimit?: string;
  timeout?: string;
  json?: boolean;
};

export type ChannelsSlackWatchdogScanDeps = {
  cfg?: OpenClawConfig;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  callGateway?: typeof callGateway;
  readSlackMessages?: WatchdogHistoryReader;
};

export type ChannelsSlackWatchdogReplayOptions = {
  account?: string;
  target?: string;
  permalink?: string;
  ts?: string;
  thread?: string;
  since?: string;
  limit?: string;
  botUser?: string;
  directMessage?: boolean;
  activeThread?: string;
  agent?: string;
  state?: string;
  ledgerLimit?: string;
  timeout?: string;
  execute?: boolean;
  json?: boolean;
};

export type ChannelsSlackWatchdogStatusOptions = {
  account?: string;
  state?: string;
  json?: boolean;
};

export type ChannelsSlackWatchdogReplayDeps = ChannelsSlackWatchdogScanDeps & {
  agentCommandFromIngress?: AgentCommandFromIngressFn;
};

type AgentCommandFromIngressFn =
  (typeof import("../../agents/agent-command.js"))["agentCommandFromIngress"];

type ScanTarget = {
  channelId: string;
  directMessage: boolean;
};

type SlackWatchdogPermalink = {
  channelId: string;
  ts: string;
  threadTs?: string;
};

type WatchdogVerdict = "admitted" | "explicitly-ignored" | "not-relevant" | "missing-admission";

type WatchdogMessage = {
  channel?: string;
  ts?: string;
  thread_ts?: string;
  client_msg_id?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  files?: unknown;
  attachments?: unknown;
  blocks?: unknown;
};

type WatchdogHistoryReader = (params: {
  cfg: OpenClawConfig;
  accountId: string;
  channelId: string;
  threadId?: string;
  limit: number;
  oldest: string;
  latest: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<WatchdogMessage[]>;

type AdmissionRecord = {
  version: 1;
  recordedAt: string;
  accountId: string;
  channel?: string;
  ts?: string;
  threadTs?: string;
  clientMsgId?: string;
  outcome: AdmissionOutcome;
  reason?: string;
  routeAgentId?: string;
  sessionKey?: string;
  user?: string;
  botId?: string;
  subtype?: string;
  textHash?: string;
  textLength?: number;
};

type AdmissionOutcome =
  | "accepted"
  | "dropped"
  | "replay-attempted"
  | "replay-dispatched"
  | "replay-failed";

type WatchdogScanRecord = {
  accountId: string;
  channel: string;
  ts?: string;
  threadTs?: string;
  clientMsgId?: string;
  user?: string;
  botId?: string;
  subtype?: string;
  verdict: WatchdogVerdict;
  reason: string;
  replayEligible?: boolean;
  replayBlockedReason?: string;
  suggestedReplayCommand?: string;
  ledgerRecord?: Pick<
    AdmissionRecord,
    "recordedAt" | "outcome" | "reason" | "routeAgentId" | "sessionKey"
  >;
};

type WatchdogScanReport = {
  accountId: string;
  channel: string;
  presentation?: WatchdogScanPresentation;
  health?: WatchdogHealthDiagnostics;
  scanned: number;
  counts: Record<WatchdogVerdict, number>;
  records: WatchdogScanRecord[];
  alert?: WatchdogAlertResult;
  sourceReplies?: WatchdogSourceReplyResult;
};

type WatchdogScanPresentation = {
  timeZone: string;
  tenant: string;
  channel: string;
  windowStart?: string;
  windowEnd?: string;
};

type WatchdogHealthDiagnostics = {
  attempted: boolean;
  available: boolean;
  accountId: string;
  healthState?: string;
  connected?: boolean;
  running?: boolean;
  lastInboundAt?: string;
  lastInboundAge?: string;
  lastTransportActivityAt?: string;
  lastTransportActivityAge?: string;
  lastSocketEnvelopeAt?: string;
  lastSocketEnvelopeAge?: string;
  lastSlackEventAt?: string;
  lastSlackEventAge?: string;
  lastSocketErrorAt?: string;
  lastSocketErrorAge?: string;
  lastDisconnectAt?: string;
  slackTelemetry?: Record<string, number>;
  reconciliation?: {
    lastScanAt?: string;
    missingCandidates?: number;
    recoveredCandidates?: number;
    failedCandidates?: number;
    lastApiError?: string;
  };
  issues?: string[];
  error?: string;
};

type WatchdogAlertResult = {
  target: string;
  accountId: string;
  attempted: boolean;
  sent: number;
  failed: number;
  skippedKnown: number;
  statePath: string;
  error?: string;
};

type WatchdogActionStateEntry = {
  operatorAlertedAt?: string;
  sourceRepliedAt?: string;
  sourceReplyTs?: string;
  replayAttemptedAt?: string;
  replayOutcome?: string;
  replayReservationId?: string;
  replayReservedAt?: string;
  replayAgentReplyPlan?: string[];
  replayAgentReplyParts?: Record<
    string,
    { attemptedAt?: string; sentAt?: string; sourceReplyTs?: string }
  >;
  replayCompleteReply?: {
    attemptedAt: string;
    sentAt?: string;
    sourceReplyTs?: string;
    error?: string;
  };
};

type WatchdogActionState = Record<string, WatchdogActionStateEntry>;

const SLACK_WATCHDOG_REPLAY_STATE_LOCK_OPTIONS = {
  retries: {
    retries: 100,
    factor: 1.2,
    minTimeout: 10,
    maxTimeout: 100,
    randomize: true,
  },
  stale: 5 * 60_000,
  staleRecovery: "fail-closed",
} satisfies FileLockOptions;
const SLACK_WATCHDOG_REPLAY_STATE_WRITER_QUEUES = new Map<string, StoreWriterQueue>();

type WatchdogSourceReplyRecordResult = {
  channel: string;
  ts?: string;
  threadTs?: string;
  target: string;
  attempted: boolean;
  sent: boolean;
  skippedKnown: boolean;
  dryRun: boolean;
  message: string;
  sourceReplyTs?: string;
  error?: string;
};

type WatchdogSourceReplyResult = {
  accountId: string;
  attempted: boolean;
  dryRun: boolean;
  sent: number;
  skippedKnown: number;
  failed: number;
  statePath: string;
  maxReplies: number;
  records: WatchdogSourceReplyRecordResult[];
};

type WatchdogReplayFollowUpResult = {
  attempted: boolean;
  sent: boolean;
  target: string;
  threadTs?: string;
  message?: string;
  payloadCount?: number;
  sentCount?: number;
  sourceReplyTs?: string;
  error?: string;
};

type WatchdogReplayOutcome =
  | "dry-run"
  | "dispatched"
  | "failed"
  | "blocked-not-missing"
  | "blocked-already-replayed"
  | "blocked-already-replaying"
  | "blocked-already-attempted"
  | "blocked-message-not-found";

type WatchdogReplayReport = {
  accountId: string;
  target: string;
  ts: string;
  threadTs?: string;
  outcome: WatchdogReplayOutcome;
  execute: boolean;
  attempted: boolean;
  dispatched: boolean;
  reason?: string;
  agentId?: string;
  sessionKey?: string;
  delivery?: {
    channel: "slack";
    to: string;
    accountId: string;
    threadId?: string;
  };
  record?: WatchdogScanRecord;
  agentReply?: WatchdogReplayFollowUpResult;
  recoveryReply?: WatchdogReplayFollowUpResult;
  statePath: string;
};

type WatchdogStatusReport = {
  accountId: string;
  statePath: string;
  knownMessages: number;
  operatorAlerted: number;
  sourceReplied: number;
  replayAttempted: number;
  replayDispatched: number;
  replayFailed: number;
  latestOperatorAlertedAt?: string;
  latestSourceRepliedAt?: string;
  latestReplayAttemptedAt?: string;
};

type SlackChannelPolicy = {
  allowed: boolean;
  requireMention: boolean;
  users?: Array<string | number>;
  dmPolicy?: string;
};

type SlackWatchdogApiSurface = {
  appendSlackAdmissionRecord: (params: {
    accountId: string;
    record: AdmissionRecord;
    openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>;
  }) => Promise<boolean>;
  readSlackAdmissionRecords: (params: {
    accountId: string;
    limit?: number;
    openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>;
  }) => Promise<AdmissionRecord[]>;
  readSlackMessages: (
    channelId: string,
    opts: {
      cfg: OpenClawConfig;
      accountId: string;
      limit?: number;
      before?: string;
      after?: string;
      threadId?: string;
      messageId?: string;
    },
  ) => Promise<{
    messages: WatchdogMessage[];
    hasMore: boolean;
  }>;
  scanSlackAdmissionGaps: (params: {
    accountId: string;
    channel: string;
    messages: readonly WatchdogMessage[];
    ledgerRecords: readonly AdmissionRecord[];
    botUserIds?: readonly string[];
    directMessage?: boolean;
    activeThreadTs?: readonly string[];
    channelRequiresMention?: boolean;
    allowedUserIds?: readonly string[];
  }) => WatchdogScanReport;
};

const DURATION_RE = /^(\d+)(ms|s|m|h|d)?$/;
const SLACK_WATCHDOG_REPORT_TIME_ZONE = "America/Chicago";
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const IS_SOURCE_CHECKOUT = CURRENT_MODULE_PATH.includes(`${path.sep}src${path.sep}`);

const installedSlackWatchdogApiSurfaces = new Map<string, Promise<unknown>>();

export function isSlackWatchdogApiSurface(value: unknown): value is SlackWatchdogApiSurface {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.appendSlackAdmissionRecord === "function" &&
    typeof value.readSlackAdmissionRecords === "function" &&
    typeof value.readSlackMessages === "function" &&
    typeof value.scanSlackAdmissionGaps === "function"
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function importSlackWatchdogApiSurface(filePath: string): Promise<unknown> {
  return await import(pathToFileURL(filePath).href);
}

async function resolveInstalledSlackApiPath(env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  const index = readPersistedInstalledPluginIndexSync({ ...(env ? { env } : {}) });
  const plugin = index?.plugins.find((candidate) => candidate.pluginId === "slack");
  if (!plugin?.enabled) {
    return undefined;
  }
  const rootDir = normalizeOptionalString(plugin.rootDir);
  if (!rootDir) {
    return undefined;
  }
  for (const candidate of [path.join(rootDir, "dist", "api.js"), path.join(rootDir, "api.js")]) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function loadInstalledSlackWatchdogApiSurface(
  env?: NodeJS.ProcessEnv,
): Promise<SlackWatchdogApiSurface | null> {
  const apiPath = await resolveInstalledSlackApiPath(env);
  if (!apiPath) {
    return null;
  }
  const cacheKey = path.resolve(apiPath);
  let cached = installedSlackWatchdogApiSurfaces.get(cacheKey);
  if (!cached) {
    cached = importSlackWatchdogApiSurface(apiPath);
    installedSlackWatchdogApiSurfaces.set(cacheKey, cached);
  }
  const installed = await cached;
  return isSlackWatchdogApiSurface(installed) ? installed : null;
}

async function loadSlackWatchdogScanSurface(env?: NodeJS.ProcessEnv): Promise<{
  scanSlackAdmissionGaps: SlackWatchdogApiSurface["scanSlackAdmissionGaps"];
}> {
  const installed = await loadInstalledSlackWatchdogApiSurface(env);
  if (installed) {
    return installed;
  }
  if (IS_SOURCE_CHECKOUT) {
    return (await import("../../../extensions/slack/src/monitor/watchdog-scan.js")) as Pick<
      SlackWatchdogApiSurface,
      "scanSlackAdmissionGaps"
    >;
  }
  throw new Error(
    "Slack watchdog scan requires the installed Slack plugin public API. Run `openclaw plugins install @openclaw/slack --force` or `openclaw plugins registry --refresh`.",
  );
}

async function loadSlackWatchdogApiSurface(
  env?: NodeJS.ProcessEnv,
): Promise<SlackWatchdogApiSurface> {
  const installed = await loadInstalledSlackWatchdogApiSurface(env);
  if (installed) {
    return installed;
  }
  if (IS_SOURCE_CHECKOUT) {
    return (await import("../../../extensions/slack/api.js")) as SlackWatchdogApiSurface;
  }
  throw new Error(
    "Slack watchdog replay requires the installed Slack plugin public API. Run `openclaw plugins install @openclaw/slack --force` or `openclaw plugins registry --refresh`.",
  );
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function parseSlackWatchdogDurationMs(raw: string | undefined, fallbackMs: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return fallbackMs;
  }
  const match = trimmed.match(DURATION_RE);
  if (!match) {
    throw new Error(
      `Invalid watchdog duration "${trimmed}"; expected values like 30m, 2h, or 300s.`,
    );
  }
  const value = Number.parseInt(match[1] ?? "", 10);
  const unit = match[2] ?? "ms";
  const multiplier =
    unit === "d"
      ? 86_400_000
      : unit === "h"
        ? 3_600_000
        : unit === "m"
          ? 60_000
          : unit === "s"
            ? 1_000
            : 1;
  return value * multiplier;
}

export function parseSlackWatchdogTarget(raw: string | undefined): ScanTarget {
  const target = normalizeOptionalString(raw);
  if (!target) {
    throw new Error("channels watchdog requires --target <channel-or-dm> or --permalink <url>.");
  }
  const channelId = target.startsWith("channel:") ? target.slice("channel:".length) : target;
  if (!channelId.trim()) {
    throw new Error("channels watchdog-scan requires a non-empty Slack channel id.");
  }
  return {
    channelId: channelId.trim(),
    directMessage: channelId.startsWith("D"),
  };
}

export function parseSlackWatchdogPermalink(raw: string | undefined): SlackWatchdogPermalink {
  const permalink = normalizeOptionalString(raw);
  if (!permalink) {
    throw new Error("channels watchdog requires a non-empty Slack permalink.");
  }
  const match = permalink.match(/\/archives\/([^/]+)\/p(\d{10})(\d{6})(?:\b|[/?#])/);
  if (!match) {
    throw new Error(
      "Invalid Slack permalink; expected a URL containing /archives/<channel>/p<timestamp>.",
    );
  }
  let threadTs: string | undefined;
  try {
    threadTs = normalizeOptionalString(new URL(permalink).searchParams.get("thread_ts"));
  } catch {
    // The matched Slack archive path remains authoritative for non-URL input.
  }
  return {
    channelId: match[1] ?? "",
    ts: `${match[2]}.${match[3]}`,
    ...(threadTs ? { threadTs } : {}),
  };
}

function resolveSlackWatchdogTarget(params: { target?: string; permalink?: string }): ScanTarget {
  if (normalizeOptionalString(params.target)) {
    return parseSlackWatchdogTarget(params.target);
  }
  const permalink = parseSlackWatchdogPermalink(params.permalink);
  return {
    channelId: permalink.channelId,
    directMessage: permalink.channelId.startsWith("D"),
  };
}

function resolveSlackWatchdogReplayTs(params: { ts?: string; permalink?: string }): string {
  const ts = normalizeOptionalString(params.ts);
  if (ts) {
    return ts;
  }
  return parseSlackWatchdogPermalink(params.permalink).ts;
}

function splitCsv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function normalizeAllowedUsers(raw: Array<string | number> | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  return raw.map((value) => String(value).trim()).filter((value) => value.length > 0);
}

function normalizeSlackDmAllowedUsers(
  raw: Array<string | number> | undefined,
): string[] | undefined {
  const normalized = normalizeAllowedUsers(raw)?.map((value) =>
    value
      .replace(/^<(?:@)?([^>]+)>$/, "$1")
      .replace(/^(?:slack|user):/i, "")
      .trim(),
  );
  if (normalized?.includes("*")) {
    return undefined;
  }
  return normalized;
}

function formatSlackEpochSeconds(date: Date): string {
  const seconds = date.getTime() / 1000;
  return Number.isInteger(seconds)
    ? String(seconds)
    : seconds.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function slackTsToDate(raw: string | undefined): Date | undefined {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return undefined;
  }
  const seconds = Number.parseFloat(trimmed);
  if (!Number.isFinite(seconds)) {
    return undefined;
  }
  return new Date(seconds * 1000);
}

function exclusiveSlackUpperBound(ts: string): string {
  const match = /^(\d+)\.(\d{1,6})$/.exec(ts);
  if (!match) {
    return ts;
  }
  const seconds = BigInt(match[1] ?? "0");
  const micros = BigInt((match[2] ?? "").padEnd(6, "0"));
  const exclusiveMicros = seconds * 1_000_000n + micros + 1n;
  const wholeSeconds = exclusiveMicros / 1_000_000n;
  const fractionalMicros = String(exclusiveMicros % 1_000_000n).padStart(6, "0");
  return `${wholeSeconds}.${fractionalMicros}`;
}

function formatChicagoTime(date: Date | undefined): string {
  if (!date) {
    return "<unknown>";
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone: SLACK_WATCHDOG_REPORT_TIME_ZONE,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function resolveOpenClawStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCLAW_STATE_DIR?.trim()) {
    return path.resolve(env.OPENCLAW_STATE_DIR.trim());
  }
  if (env.OPENCLAW_HOME?.trim()) {
    return path.resolve(env.OPENCLAW_HOME.trim());
  }
  return path.join(os.homedir(), ".openclaw");
}

function sanitizePathSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_") || "default";
}

function resolveSlackWatchdogAlertStatePath(params: {
  accountId: string;
  env?: NodeJS.ProcessEnv;
  explicitPath?: string;
}): string {
  const explicit = normalizeOptionalString(params.explicitPath);
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(
    resolveOpenClawStateDir(params.env),
    "slack",
    "watchdog-alerts",
    `${sanitizePathSegment(params.accountId)}.json`,
  );
}

function resolveSlackWatchdogReplyStatePath(params: {
  accountId: string;
  env?: NodeJS.ProcessEnv;
  explicitPath?: string;
}): string {
  const explicit = normalizeOptionalString(params.explicitPath);
  if (explicit) {
    return path.resolve(explicit);
  }
  return resolveSlackWatchdogAlertStatePath(params);
}

async function readAdmissionRecords(params: {
  accountId: string;
  limit: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ records: AdmissionRecord[]; truncated: boolean }> {
  const api = await loadSlackWatchdogApiSurface(params.env);
  const records = await api.readSlackAdmissionRecords({
    accountId: params.accountId,
    limit: params.limit + 1,
    openKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateKeyedStore<T>("slack", {
        ...options,
        ...(params.env ? { env: params.env } : {}),
      }),
  });
  return {
    records: records.slice(-params.limit),
    truncated: records.length > params.limit,
  };
}

function hashAdmissionText(text: string | undefined): { textHash?: string; textLength?: number } {
  if (!text) {
    return {};
  }
  return {
    textHash: createHash("sha256").update(text).digest("hex"),
    textLength: text.length,
  };
}

function buildWatchdogReplayAdmissionRecord(params: {
  accountId: string;
  message: WatchdogMessage;
  outcome: Extract<AdmissionOutcome, "replay-attempted" | "replay-dispatched" | "replay-failed">;
  reason: string;
  routeAgentId?: string;
  sessionKey?: string;
  now: Date;
}): AdmissionRecord {
  return {
    version: 1,
    recordedAt: params.now.toISOString(),
    accountId: params.accountId,
    channel: normalizeOptionalString(params.message.channel),
    ts: normalizeOptionalString(params.message.ts),
    threadTs: normalizeOptionalString(params.message.thread_ts),
    clientMsgId: normalizeOptionalString(params.message.client_msg_id),
    outcome: params.outcome,
    reason: params.reason,
    routeAgentId: normalizeOptionalString(params.routeAgentId),
    sessionKey: normalizeOptionalString(params.sessionKey),
    user: normalizeOptionalString(params.message.user),
    botId: normalizeOptionalString(params.message.bot_id),
    subtype: normalizeOptionalString(params.message.subtype),
    ...hashAdmissionText(params.message.text),
  };
}

async function appendWatchdogReplayAdmissionRecord(params: {
  accountId: string;
  env?: NodeJS.ProcessEnv;
  record: AdmissionRecord;
}) {
  const api = await loadSlackWatchdogApiSurface(params.env);
  const stored = await api.appendSlackAdmissionRecord({
    accountId: params.accountId,
    record: params.record,
    openKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateKeyedStore<T>("slack", {
        ...options,
        ...(params.env ? { env: params.env } : {}),
      }),
  });
  if (!stored) {
    throw new Error("failed writing Slack watchdog replay admission state");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readConfigRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readChannelsConfig(cfg: OpenClawConfig, accountId: string): Record<string, unknown> {
  const slack = readConfigRecord((cfg.channels as Record<string, unknown> | undefined)?.slack);
  const accounts = readConfigRecord(slack.accounts);
  const account = readConfigRecord(accounts[accountId]);
  return {
    ...slack,
    ...account,
    channels: account.channels ?? slack.channels,
    requireMention: account.requireMention ?? slack.requireMention,
  };
}

function resolveSlackAccountLabel(params: {
  cfg: OpenClawConfig;
  accountId: string;
  explicit?: string;
}): string {
  const explicit = normalizeOptionalString(params.explicit);
  if (explicit) {
    return `${explicit} (${params.accountId})`;
  }
  const slack = readConfigRecord(
    (params.cfg.channels as Record<string, unknown> | undefined)?.slack,
  );
  const accounts = readConfigRecord(slack.accounts);
  const account = readConfigRecord(accounts[params.accountId]);
  const label =
    normalizeOptionalString(account.name) ??
    normalizeOptionalString(account.teamName) ??
    normalizeOptionalString(account.workspaceName) ??
    normalizeOptionalString(slack.name) ??
    normalizeOptionalString(slack.teamName) ??
    normalizeOptionalString(slack.workspaceName);
  return label ? `${label} (${params.accountId})` : params.accountId;
}

function resolveSlackChannelLabel(params: { channelId: string; explicitName?: string }): string {
  const explicitName = normalizeOptionalString(params.explicitName)?.replace(/^#+/, "");
  if (explicitName) {
    return `#${explicitName} (${params.channelId})`;
  }
  if (params.channelId.startsWith("D")) {
    return `DM ${params.channelId}`;
  }
  return `<#${params.channelId}> (${params.channelId})`;
}

function attachSlackWatchdogPresentation(params: {
  report: WatchdogScanReport;
  cfg: OpenClawConfig;
  accountId: string;
  channelId: string;
  tenantLabel?: string;
  channelName?: string;
  windowStart: Date;
  windowEnd: Date;
}): void {
  params.report.presentation = {
    timeZone: SLACK_WATCHDOG_REPORT_TIME_ZONE,
    tenant: resolveSlackAccountLabel({
      cfg: params.cfg,
      accountId: params.accountId,
      explicit: params.tenantLabel,
    }),
    channel: resolveSlackChannelLabel({
      channelId: params.channelId,
      explicitName: params.channelName,
    }),
    windowStart: formatChicagoTime(params.windowStart),
    windowEnd: formatChicagoTime(params.windowEnd),
  };
}

function resolveSlackChannelPolicy(params: {
  cfg: OpenClawConfig;
  accountId: string;
  channelId: string;
  directMessage?: boolean;
}): SlackChannelPolicy {
  const slack = readChannelsConfig(params.cfg, params.accountId);
  if (params.directMessage) {
    const dm = readConfigRecord(slack.dm);
    const dmPolicy = normalizeOptionalString(slack.dmPolicy ?? dm.policy) ?? "pairing";
    const allowFrom = Array.isArray(slack.allowFrom)
      ? (slack.allowFrom as Array<string | number>)
      : Array.isArray(dm.allowFrom)
        ? (dm.allowFrom as Array<string | number>)
        : undefined;
    const allowed = dm.enabled !== false && dmPolicy !== "disabled";
    const users =
      dmPolicy === "open"
        ? undefined
        : (normalizeSlackDmAllowedUsers(allowFrom) ?? (allowFrom ? undefined : []));
    return {
      allowed,
      requireMention: false,
      dmPolicy,
      ...(allowed ? { users } : {}),
    };
  }
  const channels = readConfigRecord(slack.channels);
  const channelId = params.channelId;
  const candidates = [
    channelId,
    channelId.toLowerCase(),
    channelId.toUpperCase(),
    `channel:${channelId}`,
    `channel:${channelId.toLowerCase()}`,
    `channel:${channelId.toUpperCase()}`,
  ];
  const matched = candidates.map((key) => channels[key]).find(isRecord);
  const fallback = readConfigRecord(channels["*"]);
  const entry = readConfigRecord(matched ?? fallback);
  const configuredGroupPolicy =
    slack.groupPolicy === "open" ||
    slack.groupPolicy === "allowlist" ||
    slack.groupPolicy === "disabled"
      ? slack.groupPolicy
      : undefined;
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.slack !== undefined,
    groupPolicy: configuredGroupPolicy,
    defaultGroupPolicy: resolveDefaultGroupPolicy(params.cfg),
  });
  const defaultRequireMention =
    typeof slack.requireMention === "boolean" ? slack.requireMention : true;
  const allowed =
    typeof entry.enabled === "boolean"
      ? entry.enabled
      : Boolean(matched ?? fallback) || groupPolicy === "open";
  const requireMention =
    typeof entry.requireMention === "boolean" ? entry.requireMention : defaultRequireMention;
  const users = Array.isArray(entry.users) ? (entry.users as Array<string | number>) : undefined;
  return {
    allowed,
    requireMention,
    ...(users ? { users } : {}),
  };
}

async function resolveSlackWatchdogAllowedUsers(params: {
  policy: SlackChannelPolicy;
  accountId: string;
  directMessage: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<string[] | undefined> {
  if (!params.policy.allowed) {
    return [];
  }
  const configured = normalizeAllowedUsers(params.policy.users) ?? [];
  if (!params.directMessage || params.policy.dmPolicy !== "pairing") {
    return params.policy.users ? configured : undefined;
  }
  const paired = await readChannelIngressStoreAllowFromForDmPolicy({
    provider: "slack",
    accountId: params.accountId,
    dmPolicy: params.policy.dmPolicy,
    readStore: async (provider, accountId) => {
      const { readChannelAllowFromStore } = await import("../../pairing/pairing-store.js");
      return await readChannelAllowFromStore(provider, params.env ?? process.env, accountId);
    },
  });
  return normalizeSlackDmAllowedUsers([...configured, ...paired]) ?? [];
}

function resolveActiveThreadTsFromLedger(params: {
  accountId: string;
  channelId: string;
  records: readonly AdmissionRecord[];
}): string[] {
  const active = new Set<string>();
  for (const record of params.records) {
    if (
      record.accountId !== params.accountId ||
      record.channel !== params.channelId ||
      record.outcome !== "accepted"
    ) {
      continue;
    }
    const threadTs = normalizeOptionalString(record.threadTs);
    if (threadTs) {
      active.add(threadTs);
    }
  }
  return [...active];
}

async function scanAdmissionGaps(params: {
  env?: NodeJS.ProcessEnv;
  accountId: string;
  channel: string;
  messages: readonly WatchdogMessage[];
  ledgerRecords: readonly AdmissionRecord[];
  botUserIds?: readonly string[];
  directMessage?: boolean;
  activeThreadTs?: readonly string[];
  channelRequiresMention?: boolean;
  allowedUserIds?: readonly string[];
}): Promise<WatchdogScanReport> {
  const { scanSlackAdmissionGaps } = await loadSlackWatchdogScanSurface(params.env);
  const report = scanSlackAdmissionGaps(params);
  return {
    ...report,
    records: report.records.map((record) =>
      record.verdict === "missing-admission" && !record.suggestedReplayCommand
        ? {
            ...record,
            suggestedReplayCommand: formatSlackWatchdogReplayCommand(record, params.botUserIds),
          }
        : record,
    ),
  };
}

function formatSlackWatchdogReplayCommand(
  record: WatchdogScanRecord,
  botUserIds?: readonly string[],
): string | undefined {
  if (!record.ts) {
    return undefined;
  }
  const args = [
    "openclaw",
    "channels",
    "watchdog-replay",
    "--account",
    record.accountId,
    "--target",
    `channel:${record.channel}`,
    "--ts",
    record.ts,
  ];
  if (record.threadTs && record.threadTs !== record.ts) {
    args.push("--thread", record.threadTs);
  }
  if (botUserIds && botUserIds.length > 0) {
    args.push("--bot-user", botUserIds.join(","));
  }
  return args.join(" ");
}

function formatSlackWatchdogScanReport(report: WatchdogScanReport): string {
  const presentation = report.presentation;
  const lines = [
    theme.heading("Slack Watchdog Scan"),
    `Slack tenant: ${presentation?.tenant ?? report.accountId}`,
    `Channel: ${presentation?.channel ?? report.channel}`,
    presentation?.windowStart && presentation?.windowEnd
      ? `Window: ${presentation.windowStart} to ${presentation.windowEnd} (${presentation.timeZone})`
      : `Time zone: ${SLACK_WATCHDOG_REPORT_TIME_ZONE}`,
    `Scanned: ${report.scanned}`,
    `Counts: admitted=${report.counts.admitted} explicitly-ignored=${report.counts["explicitly-ignored"]} not-relevant=${report.counts["not-relevant"]} missing-admission=${report.counts["missing-admission"]}`,
  ];
  lines.push(...formatSlackWatchdogHealthLines(report.health));
  const missing = report.records.filter((record) => record.verdict === "missing-admission");
  if (missing.length === 0) {
    lines.push("Missing admissions: none");
    if (report.alert?.attempted) {
      lines.push(
        `Alert: sent=${report.alert.sent} failed=${report.alert.failed} skipped-known=${report.alert.skippedKnown} target=${report.alert.accountId}:${report.alert.target}${report.alert.error ? ` error=${report.alert.error}` : ""}`,
      );
    }
    return lines.join("\n");
  }
  lines.push("Missing admissions:");
  for (const record of missing.slice(0, 20)) {
    lines.push(
      `- ${formatChicagoTime(slackTsToDate(record.ts))} - ts=${record.ts ?? "<unknown>"} - reason=${record.reason}`,
    );
  }
  if (report.alert?.attempted) {
    lines.push(
      `Alert: sent=${report.alert.sent} failed=${report.alert.failed} skipped-known=${report.alert.skippedKnown} target=${report.alert.accountId}:${report.alert.target}${report.alert.error ? ` error=${report.alert.error}` : ""}`,
    );
  }
  if (report.sourceReplies?.attempted) {
    lines.push(
      `Source replies: sent=${report.sourceReplies.sent} skipped-known=${report.sourceReplies.skippedKnown} failed=${report.sourceReplies.failed} dry-run=${report.sourceReplies.dryRun}`,
    );
  }
  return lines.join("\n");
}

function slackWatchdogAlertKey(record: WatchdogScanRecord): string {
  const threadTs = record.threadTs && record.threadTs !== record.ts ? record.threadTs : undefined;
  return [
    record.accountId,
    record.channel,
    record.ts ?? "",
    record.clientMsgId ?? "",
    threadTs ?? "",
  ].join("\0");
}

function slackWatchdogSourceReplyIdempotencyKey(record: WatchdogScanRecord): string {
  const recordHash = createHash("sha256").update(slackWatchdogAlertKey(record)).digest("hex");
  return `channels-watchdog-source-reply:${recordHash}`;
}

function slackWatchdogReplayCompleteIdempotencyKey(record: WatchdogScanRecord): string {
  const recordHash = createHash("sha256").update(slackWatchdogAlertKey(record)).digest("hex");
  return `channels-watchdog-replay-complete:${recordHash}`;
}

export function slackWatchdogOperatorAlertIdempotencyKey(params: {
  alertAccountId: string;
  alertTarget: string;
  records: readonly WatchdogScanRecord[];
}): string {
  const alertedKeys = params.records.map(slackWatchdogAlertKey).toSorted();
  const alertHash = createHash("sha256")
    .update(JSON.stringify([params.alertAccountId, params.alertTarget, alertedKeys]))
    .digest("hex");
  return `channels-watchdog-alert:${alertHash}`;
}

function normalizeSlackWatchdogStateEntry(value: unknown): WatchdogActionStateEntry | undefined {
  if (typeof value === "string" && value.trim()) {
    return { operatorAlertedAt: value };
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const entry: WatchdogActionStateEntry = {};
  const operatorAlertedAt = normalizeOptionalString(value.operatorAlertedAt);
  const sourceRepliedAt = normalizeOptionalString(value.sourceRepliedAt);
  const sourceReplyTs = normalizeOptionalString(value.sourceReplyTs);
  const replayAttemptedAt = normalizeOptionalString(value.replayAttemptedAt);
  const replayOutcome = normalizeOptionalString(value.replayOutcome);
  const replayReservationId = normalizeOptionalString(value.replayReservationId);
  const replayReservedAt = normalizeOptionalString(value.replayReservedAt);
  const replayAgentReplyPlan = Array.isArray(value.replayAgentReplyPlan)
    ? value.replayAgentReplyPlan
        .map((entry) => normalizeOptionalString(entry))
        .filter((entry): entry is string => Boolean(entry))
    : undefined;
  const replayAgentReplyParts = isRecord(value.replayAgentReplyParts)
    ? Object.fromEntries(
        Object.entries(value.replayAgentReplyParts).flatMap(([part, partValue]) => {
          if (!isRecord(partValue)) {
            return [];
          }
          const attemptedAt = normalizeOptionalString(partValue.attemptedAt);
          const sentAt = normalizeOptionalString(partValue.sentAt);
          if (!attemptedAt && !sentAt) {
            return [];
          }
          const sourceReplyTs = normalizeOptionalString(partValue.sourceReplyTs);
          return [
            [
              part,
              {
                ...(attemptedAt ? { attemptedAt } : {}),
                ...(sentAt ? { sentAt } : {}),
                ...(sourceReplyTs ? { sourceReplyTs } : {}),
              },
            ],
          ];
        }),
      )
    : undefined;
  const replayCompleteReply = isRecord(value.replayCompleteReply)
    ? (() => {
        const attemptedAt = normalizeOptionalString(value.replayCompleteReply.attemptedAt);
        if (!attemptedAt) {
          return undefined;
        }
        const sentAt = normalizeOptionalString(value.replayCompleteReply.sentAt);
        const completionSourceReplyTs = normalizeOptionalString(
          value.replayCompleteReply.sourceReplyTs,
        );
        const error = normalizeOptionalString(value.replayCompleteReply.error);
        return {
          attemptedAt,
          ...(sentAt ? { sentAt } : {}),
          ...(completionSourceReplyTs ? { sourceReplyTs: completionSourceReplyTs } : {}),
          ...(error ? { error } : {}),
        };
      })()
    : undefined;
  if (operatorAlertedAt) {
    entry.operatorAlertedAt = operatorAlertedAt;
  }
  if (sourceRepliedAt) {
    entry.sourceRepliedAt = sourceRepliedAt;
  }
  if (sourceReplyTs) {
    entry.sourceReplyTs = sourceReplyTs;
  }
  if (replayAttemptedAt) {
    entry.replayAttemptedAt = replayAttemptedAt;
  }
  if (replayOutcome) {
    entry.replayOutcome = replayOutcome;
  }
  if (replayReservationId) {
    entry.replayReservationId = replayReservationId;
  }
  if (replayReservedAt) {
    entry.replayReservedAt = replayReservedAt;
  }
  if (replayAgentReplyPlan?.length) {
    entry.replayAgentReplyPlan = replayAgentReplyPlan;
  }
  if (replayAgentReplyParts && Object.keys(replayAgentReplyParts).length > 0) {
    entry.replayAgentReplyParts = replayAgentReplyParts;
  }
  if (replayCompleteReply) {
    entry.replayCompleteReply = replayCompleteReply;
  }
  return Object.keys(entry).length > 0 ? entry : undefined;
}

async function readSlackWatchdogActionState(statePath: string): Promise<WatchdogActionState> {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, value]) => {
        const entry = normalizeSlackWatchdogStateEntry(value);
        return entry ? [[key, entry]] : [];
      }),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeSlackWatchdogActionState(
  statePath: string,
  state: WatchdogActionState,
): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await writeTextAtomic(statePath, JSON.stringify(state, null, 2), {
    trailingNewline: true,
    tempPrefix: path.basename(statePath),
  });
}

function formatSlackWatchdogPlainReason(record: WatchdogScanRecord): string {
  if (record.reason === "activation-without-ledger-record") {
    return "Slack has the message, but OpenClaw has no admission, ignore, session, or trajectory record.";
  }
  if (record.reason === "ledger-accepted") {
    return "OpenClaw admitted this message.";
  }
  if (record.reason === "ledger-dropped") {
    return "OpenClaw explicitly ignored or dropped this message.";
  }
  return record.reason;
}

function formatSlackWatchdogThreadLabel(record: WatchdogScanRecord): string {
  if (!record.threadTs || record.threadTs === record.ts) {
    return "top-level";
  }
  return record.threadTs;
}

function formatSlackWatchdogMissedEvidence(record: WatchdogScanRecord): string[] {
  const lines = [
    `- ${formatChicagoTime(slackTsToDate(record.ts))}`,
    `- Slack ts: ${record.ts ?? "<unknown>"}`,
    `- Channel: ${record.channel}`,
    `- Thread: ${formatSlackWatchdogThreadLabel(record)}`,
  ];
  if (record.user) {
    lines.push(`- Sender: ${record.user}`);
  }
  if (record.ledgerRecord?.routeAgentId) {
    lines.push(`- Intended agent: ${record.ledgerRecord.routeAgentId}`);
  }
  lines.push(`- Reason: ${formatSlackWatchdogPlainReason(record)}`);
  if (record.suggestedReplayCommand) {
    lines.push(`- Replay preflight: ${record.suggestedReplayCommand}`);
  }
  return lines;
}

function formatSlackWatchdogHealthLines(health: WatchdogHealthDiagnostics | undefined): string[] {
  if (!health) {
    return [];
  }
  if (!health.available) {
    return health.error
      ? [`Nearby channel health: unavailable (${health.error})`]
      : ["Nearby channel health: unavailable"];
  }
  const facts = [
    health.healthState ? `health=${health.healthState}` : null,
    typeof health.connected === "boolean" ? `connected=${health.connected}` : null,
    typeof health.running === "boolean" ? `running=${health.running}` : null,
    health.lastSocketEnvelopeAge ? `socketEnvelope=${health.lastSocketEnvelopeAge}` : null,
    health.lastSlackEventAge ? `slackEvent=${health.lastSlackEventAge}` : null,
    health.lastSocketErrorAge ? `socketError=${health.lastSocketErrorAge}` : null,
    health.lastTransportActivityAge ? `transport=${health.lastTransportActivityAge}` : null,
    health.lastInboundAge ? `inbound=${health.lastInboundAge}` : null,
    health.lastDisconnectAt ? `last disconnect=${health.lastDisconnectAt}` : null,
  ].filter((fact): fact is string => Boolean(fact));
  const lines = [`Nearby channel health: ${facts.length ? facts.join(", ") : "no live facts"}`];
  for (const issue of health.issues?.slice(0, 3) ?? []) {
    lines.push(`- Health warning: ${issue}`);
  }
  if (health.slackTelemetry) {
    const telemetryFacts = [
      ["raw", health.slackTelemetry.rawSlackEvents],
      ["messages", health.slackTelemetry.messageEvents],
      ["dropped", health.slackTelemetry.droppedEvents],
      ["policyDrops", health.slackTelemetry.droppedPolicyEvents],
      ["selfBotDrops", health.slackTelemetry.droppedSelfBotEvents],
      ["prepared", health.slackTelemetry.preparedForDispatch],
      ["admissions", health.slackTelemetry.admissionsRecorded],
      ["dispatchFailures", health.slackTelemetry.dispatchFailures],
    ]
      .filter((entry): entry is [string, number] => typeof entry[1] === "number")
      .map(([label, value]) => `${label}=${value}`);
    if (telemetryFacts.length > 0) {
      lines.push(`- Slack receiver counters: ${telemetryFacts.join(", ")}`);
    }
  }
  if (health.reconciliation) {
    const reconciliationFacts = [
      health.reconciliation.lastScanAt ? `lastScan=${health.reconciliation.lastScanAt}` : null,
      typeof health.reconciliation.missingCandidates === "number"
        ? `missing=${health.reconciliation.missingCandidates}`
        : null,
      typeof health.reconciliation.recoveredCandidates === "number"
        ? `recovered=${health.reconciliation.recoveredCandidates}`
        : null,
      typeof health.reconciliation.failedCandidates === "number"
        ? `failed=${health.reconciliation.failedCandidates}`
        : null,
      health.reconciliation.lastApiError ? `apiError=${health.reconciliation.lastApiError}` : null,
    ].filter((fact): fact is string => Boolean(fact));
    lines.push(
      `- Slack reconciliation: ${reconciliationFacts.length ? reconciliationFacts.join(", ") : "not checked"}`,
    );
  } else {
    lines.push("- Slack reconciliation: not checked");
  }
  return lines;
}

function formatSlackWatchdogAlert(params: {
  report: WatchdogScanReport;
  missing: readonly WatchdogScanRecord[];
}): string {
  const presentation = params.report.presentation;
  const count = params.missing.length;
  const plural = count === 1 ? "message" : "messages";
  const tenant = presentation?.tenant ?? params.report.accountId;
  const channel = presentation?.channel ?? params.report.channel;
  const lines = [
    `OpenClaw missed ${count} Slack ${plural} that looked eligible for an agent.`,
    "",
    `Where: ${tenant} ${channel}`,
    presentation?.windowStart && presentation?.windowEnd
      ? `When checked: ${presentation.windowStart} to ${presentation.windowEnd}`
      : `Time zone: ${SLACK_WATCHDOG_REPORT_TIME_ZONE}`,
    "What checked: Slack history vs OpenClaw admission ledger",
    `Messages scanned: ${params.report.scanned}`,
    ...formatSlackWatchdogHealthLines(params.report.health),
    "",
    count === 1 ? "Missed message:" : "Missed messages:",
  ];
  for (const record of params.missing.slice(0, 10)) {
    lines.push(...formatSlackWatchdogMissedEvidence(record), "");
  }
  if (params.missing.length > 10) {
    lines.push(`- ... ${params.missing.length - 10} more`);
  }
  lines.push("Next action: inspect the permalink/window, then run the replay preflight if needed.");
  return lines.join("\n");
}

function formatSlackMissedMessageReply(): string {
  return "OpenClaw missed this message before it reached the agent. I have flagged it for recovery so it is not silently ignored.";
}

function formatSlackRecoveryCompleteReply(): string {
  return "Recovery complete: OpenClaw has replayed this missed message into the agent.";
}

function extractReadMessages(payload: unknown): WatchdogMessage[] {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const nested = root.payload && typeof root.payload === "object" ? root.payload : root;
  const messages = (nested as Record<string, unknown>).messages;
  return Array.isArray(messages) ? (messages as WatchdogMessage[]) : [];
}

async function readSlackMessagesViaGateway(params: {
  callGatewayFn: typeof callGateway;
  accountId: string;
  channelId: string;
  threadId?: string;
  limit: number;
  oldest: string;
  latest: string;
  timeoutMs: number;
}): Promise<WatchdogMessage[]> {
  const threadId = normalizeOptionalString(params.threadId);
  const actionPayload = await params.callGatewayFn({
    method: "message.action",
    params: {
      channel: "slack",
      action: "read",
      accountId: params.accountId,
      params: {
        to: `channel:${params.channelId}`,
        accountId: params.accountId,
        limit: params.limit,
        after: params.oldest,
        before: params.latest,
        ...(threadId ? { threadId } : {}),
      },
      idempotencyKey: `channels-watchdog-scan:${randomUUID()}`,
    },
    timeoutMs: params.timeoutMs,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  });
  return extractReadMessages(actionPayload);
}

async function readSlackMessagesViaSlackPlugin(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  accountId: string;
  channelId: string;
  threadId?: string;
  limit: number;
  oldest: string;
  latest: string;
}): Promise<WatchdogMessage[]> {
  const { readSlackMessages } = await loadSlackWatchdogApiSurface(params.env);
  const result = await readSlackMessages(params.channelId, {
    cfg: params.cfg,
    accountId: params.accountId,
    limit: params.limit,
    after: params.oldest,
    before: params.latest,
    ...(params.threadId ? { threadId: params.threadId } : {}),
  });
  return result.messages.map((message) => ({
    ...message,
    channel: params.channelId,
  }));
}

async function readSlackMessagesForWatchdog(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  readSlackMessagesFn?: WatchdogHistoryReader;
  callGatewayFn?: typeof callGateway;
  accountId: string;
  channelId: string;
  threadId?: string;
  limit: number;
  oldest: string;
  latest: string;
  timeoutMs: number;
}): Promise<WatchdogMessage[]> {
  const readDirect = async (read: (signal: AbortSignal) => Promise<WatchdogMessage[]>) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);
    timer.unref?.();
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error(`Slack history read timed out after ${params.timeoutMs}ms`)),
        { once: true },
      );
    });
    try {
      return await Promise.race([read(controller.signal), aborted]);
    } finally {
      clearTimeout(timer);
    }
  };
  if (params.readSlackMessagesFn) {
    return await readDirect(async (signal) =>
      params.readSlackMessagesFn!({
        cfg: params.cfg,
        accountId: params.accountId,
        channelId: params.channelId,
        threadId: params.threadId,
        limit: params.limit,
        oldest: params.oldest,
        latest: params.latest,
        timeoutMs: params.timeoutMs,
        signal,
      }),
    );
  }
  if (params.callGatewayFn) {
    return await readSlackMessagesViaGateway({
      callGatewayFn: params.callGatewayFn,
      accountId: params.accountId,
      channelId: params.channelId,
      threadId: params.threadId,
      limit: params.limit,
      oldest: params.oldest,
      latest: params.latest,
      timeoutMs: params.timeoutMs,
    });
  }
  return await readDirect(async () =>
    readSlackMessagesViaSlackPlugin({
      cfg: params.cfg,
      env: params.env,
      accountId: params.accountId,
      channelId: params.channelId,
      threadId: params.threadId,
      limit: params.limit,
      oldest: params.oldest,
      latest: params.latest,
    }),
  );
}

function unwrapGatewayPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  return isRecord(value.payload) ? value.payload : value;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNumberRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = Math.max(0, Math.trunc(raw));
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function formatWatchdogStatusTime(value: number | undefined): string | undefined {
  return value === undefined ? undefined : formatChicagoTime(new Date(value));
}

function formatWatchdogStatusAge(value: number | undefined, now: Date): string | undefined {
  return value === undefined ? undefined : formatTimeAgo(now.getTime() - value);
}

function findSlackWatchdogStatusAccount(params: {
  payload: Record<string, unknown>;
  accountId: string;
}): Record<string, unknown> | undefined {
  const channelAccounts = isRecord(params.payload.channelAccounts)
    ? params.payload.channelAccounts
    : {};
  const slackAccounts = Array.isArray(channelAccounts.slack) ? channelAccounts.slack : [];
  for (const account of slackAccounts) {
    if (!isRecord(account)) {
      continue;
    }
    const accountId = normalizeOptionalString(account.accountId) ?? "default";
    if (accountId === params.accountId) {
      return account;
    }
  }
  return undefined;
}

function formatSlackWatchdogHealthError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message.trim();
  }
  if (typeof err === "string" && err.trim()) {
    return err.trim();
  }
  return "unknown error";
}

async function collectSlackWatchdogHealthDiagnostics(params: {
  callGatewayFn: typeof callGateway;
  accountId: string;
  timeoutMs: number;
  now: Date;
}): Promise<WatchdogHealthDiagnostics> {
  try {
    const raw = await params.callGatewayFn({
      method: "channels.status",
      params: {
        channel: "slack",
        probe: false,
        timeoutMs: params.timeoutMs,
      },
      timeoutMs: params.timeoutMs,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
    });
    const payload = unwrapGatewayPayload(raw);
    const account = findSlackWatchdogStatusAccount({
      payload,
      accountId: params.accountId,
    });
    if (!account) {
      return {
        attempted: true,
        available: false,
        accountId: params.accountId,
        error: "Slack account was not present in channels.status output",
      };
    }
    const lastInboundAt = readFiniteNumber(account.lastInboundAt);
    const lastTransportActivityAt = readFiniteNumber(account.lastTransportActivityAt);
    const lastSocketEnvelopeAt = readFiniteNumber(account.lastSocketEnvelopeAt);
    const lastSlackEventAt = readFiniteNumber(account.lastSlackEventAt);
    const lastSocketError = isRecord(account.lastSocketError) ? account.lastSocketError : {};
    const lastSocketErrorAt = readFiniteNumber(lastSocketError.at);
    const slackTelemetry = readNumberRecord(account.slackTelemetry);
    const reconciliationStatus = isRecord(account.reconciliationStatus)
      ? account.reconciliationStatus
      : undefined;
    const reconciliationLastApiError = isRecord(reconciliationStatus?.lastApiError)
      ? reconciliationStatus.lastApiError
      : undefined;
    const lastDisconnect = isRecord(account.lastDisconnect) ? account.lastDisconnect : {};
    const lastDisconnectAt = readFiniteNumber(lastDisconnect.at);
    const issues = collectChannelStatusIssues(payload)
      .filter((issue) => issue.channel === "slack" && issue.accountId === params.accountId)
      .map((issue) => `${issue.message}${issue.fix ? ` (${issue.fix})` : ""}`);
    return {
      attempted: true,
      available: true,
      accountId: params.accountId,
      ...(normalizeOptionalString(account.healthState)
        ? { healthState: normalizeOptionalString(account.healthState) }
        : {}),
      ...(readBoolean(account.connected) !== undefined
        ? { connected: readBoolean(account.connected) }
        : {}),
      ...(readBoolean(account.running) !== undefined
        ? { running: readBoolean(account.running) }
        : {}),
      ...(lastInboundAt !== undefined
        ? {
            lastInboundAt: formatWatchdogStatusTime(lastInboundAt),
            lastInboundAge: formatWatchdogStatusAge(lastInboundAt, params.now),
          }
        : {}),
      ...(lastTransportActivityAt !== undefined
        ? {
            lastTransportActivityAt: formatWatchdogStatusTime(lastTransportActivityAt),
            lastTransportActivityAge: formatWatchdogStatusAge(lastTransportActivityAt, params.now),
          }
        : {}),
      ...(lastSocketEnvelopeAt !== undefined
        ? {
            lastSocketEnvelopeAt: formatWatchdogStatusTime(lastSocketEnvelopeAt),
            lastSocketEnvelopeAge: formatWatchdogStatusAge(lastSocketEnvelopeAt, params.now),
          }
        : {}),
      ...(lastSlackEventAt !== undefined
        ? {
            lastSlackEventAt: formatWatchdogStatusTime(lastSlackEventAt),
            lastSlackEventAge: formatWatchdogStatusAge(lastSlackEventAt, params.now),
          }
        : {}),
      ...(lastSocketErrorAt !== undefined
        ? {
            lastSocketErrorAt: formatWatchdogStatusTime(lastSocketErrorAt),
            lastSocketErrorAge: formatWatchdogStatusAge(lastSocketErrorAt, params.now),
          }
        : {}),
      ...(lastDisconnectAt !== undefined
        ? { lastDisconnectAt: formatWatchdogStatusTime(lastDisconnectAt) }
        : {}),
      ...(slackTelemetry ? { slackTelemetry } : {}),
      ...(reconciliationStatus
        ? {
            reconciliation: {
              ...(readFiniteNumber(reconciliationStatus.lastScanAt) !== undefined
                ? {
                    lastScanAt: formatWatchdogStatusTime(
                      readFiniteNumber(reconciliationStatus.lastScanAt),
                    ),
                  }
                : {}),
              ...(readFiniteNumber(reconciliationStatus.missingCandidates) !== undefined
                ? {
                    missingCandidates: readFiniteNumber(reconciliationStatus.missingCandidates),
                  }
                : {}),
              ...(readFiniteNumber(reconciliationStatus.recoveredCandidates) !== undefined
                ? {
                    recoveredCandidates: readFiniteNumber(reconciliationStatus.recoveredCandidates),
                  }
                : {}),
              ...(readFiniteNumber(reconciliationStatus.failedCandidates) !== undefined
                ? {
                    failedCandidates: readFiniteNumber(reconciliationStatus.failedCandidates),
                  }
                : {}),
              ...(normalizeOptionalString(reconciliationLastApiError?.code)
                ? {
                    lastApiError: normalizeOptionalString(reconciliationLastApiError?.code),
                  }
                : {}),
            },
          }
        : {}),
      ...(issues.length > 0 ? { issues } : {}),
    };
  } catch (err) {
    return {
      attempted: true,
      available: false,
      accountId: params.accountId,
      error: formatSlackWatchdogHealthError(err),
    };
  }
}

async function sendSlackWatchdogAlert(params: {
  callGatewayFn: typeof callGateway;
  report: WatchdogScanReport;
  alertAccountId: string;
  alertTarget: string;
  statePath: string;
  timeoutMs: number;
  now: Date;
}): Promise<WatchdogAlertResult> {
  // Selection, send, and commit share the cross-process state lock. Releasing it before the
  // transport result lets overlapping but non-identical batches alert the same record twice.
  return await withSlackWatchdogReplayStateLock(params.statePath, async () => {
    const state = await readSlackWatchdogActionState(params.statePath);
    const missing = params.report.records.filter(
      (record) => record.verdict === "missing-admission",
    );
    const newMissing = missing.filter(
      (record) => !state[slackWatchdogAlertKey(record)]?.operatorAlertedAt,
    );
    if (newMissing.length === 0) {
      return {
        target: params.alertTarget,
        accountId: params.alertAccountId,
        attempted: true,
        sent: 0,
        failed: 0,
        skippedKnown: missing.length,
        statePath: params.statePath,
      };
    }

    try {
      await params.callGatewayFn({
        method: "message.action",
        params: {
          channel: "slack",
          action: "send",
          accountId: params.alertAccountId,
          params: {
            to: params.alertTarget,
            accountId: params.alertAccountId,
            message: formatSlackWatchdogAlert({ report: params.report, missing: newMissing }),
          },
          idempotencyKey: slackWatchdogOperatorAlertIdempotencyKey({
            alertAccountId: params.alertAccountId,
            alertTarget: params.alertTarget,
            records: newMissing,
          }),
        },
        timeoutMs: params.timeoutMs,
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      });
    } catch (error) {
      return {
        target: params.alertTarget,
        accountId: params.alertAccountId,
        attempted: true,
        sent: 0,
        failed: newMissing.length,
        skippedKnown: missing.length - newMissing.length,
        statePath: params.statePath,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const alertedAt = params.now.toISOString();
    // Reread after transport even while holding the cooperative lock: operators and older
    // binaries may still update the JSON directly, and alert state must merge rather than erase it.
    const currentState = await readSlackWatchdogActionState(params.statePath);
    for (const record of newMissing) {
      const key = slackWatchdogAlertKey(record);
      currentState[key] = {
        ...currentState[key],
        operatorAlertedAt: alertedAt,
      };
    }
    await writeSlackWatchdogActionState(params.statePath, currentState);
    return {
      target: params.alertTarget,
      accountId: params.alertAccountId,
      attempted: true,
      sent: newMissing.length,
      failed: 0,
      skippedKnown: missing.length - newMissing.length,
      statePath: params.statePath,
    };
  });
}

function resolveSlackMissedMessageReplyThreadTs(record: WatchdogScanRecord): string | undefined {
  return normalizeOptionalString(record.threadTs) ?? normalizeOptionalString(record.ts);
}

function resolveSlackWatchdogReplayStatePath(params: {
  accountId: string;
  env?: NodeJS.ProcessEnv;
  explicitPath?: string;
}): string {
  return resolveSlackWatchdogReplyStatePath(params);
}

function findSlackWatchdogMessageByTs(
  messages: readonly WatchdogMessage[],
  ts: string,
): WatchdogMessage | undefined {
  return messages.find((message) => normalizeOptionalString(message.ts) === ts);
}

function buildSlackReplayTarget(params: {
  target: ScanTarget;
  channelId: string;
  message: WatchdogMessage;
}): {
  to: string;
  peer: { kind: "direct" | "channel" | "group"; id: string };
  chatType: "direct" | "channel";
} {
  if (params.target.directMessage) {
    const userId = normalizeOptionalString(params.message.user) ?? params.channelId;
    return {
      to: `user:${userId}`,
      peer: { kind: "direct", id: userId },
      chatType: "direct",
    };
  }
  const peerKind = params.channelId.startsWith("G") ? "group" : "channel";
  return {
    to: `channel:${params.channelId}`,
    peer: { kind: peerKind, id: params.channelId },
    chatType: "channel",
  };
}

function formatSlackWatchdogReplayReport(report: WatchdogReplayReport): string {
  const lines = [
    theme.heading("Slack Watchdog Replay"),
    `Target: ${report.target}`,
    `Message: ${report.ts}`,
    `Outcome: ${report.outcome}`,
  ];
  if (report.reason) {
    lines.push(`Reason: ${report.reason}`);
  }
  if (report.agentId) {
    lines.push(`Agent: ${report.agentId}`);
  }
  if (report.sessionKey) {
    lines.push(`Session: ${report.sessionKey}`);
  }
  if (report.delivery) {
    lines.push(
      `Delivery: ${report.delivery.accountId}:${report.delivery.to}${
        report.delivery.threadId ? ` thread=${report.delivery.threadId}` : ""
      }`,
    );
  }
  if (!report.execute && report.outcome === "dry-run") {
    lines.push("No agent turn was started. Re-run with --execute to replay this missed message.");
  }
  return lines.join("\n");
}

function createJsonReplayAgentRuntime(runtime: RuntimeEnv): OutputRuntimeEnv {
  return {
    ...runtime,
    log() {},
    writeStdout() {},
    writeJson() {},
  };
}

function extractSlackSendTs(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const nested = isRecord(payload.payload) ? payload.payload : payload;
  return (
    normalizeOptionalString(nested.messageId) ??
    normalizeOptionalString(nested.ts) ??
    normalizeOptionalString(nested.id)
  );
}

type SlackReplayAgentReplyPayload = {
  message?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  presentation?: unknown;
  interactive?: unknown;
};

function normalizeSlackReplayStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function extractSlackReplayBlocks(payload: Record<string, unknown>): unknown {
  const slackData = isRecord(payload.channelData)
    ? (payload.channelData.slack as unknown)
    : undefined;
  if (!isRecord(slackData)) {
    return undefined;
  }
  return slackData.presentationBlocks ?? slackData.blocks;
}

function readSlackBlockText(block: Record<string, unknown>): string | undefined {
  const text = block.text;
  if (typeof text === "string") {
    return normalizeOptionalString(text);
  }
  if (isRecord(text)) {
    return normalizeOptionalString(text.text);
  }
  return undefined;
}

function convertSlackBlocksToPresentation(blocks: unknown): unknown {
  if (!Array.isArray(blocks)) {
    return undefined;
  }
  const presentationBlocks = blocks.flatMap((block): Array<Record<string, unknown>> => {
    if (!isRecord(block)) {
      return [];
    }
    const blockType = normalizeOptionalString(block.type);
    if (blockType === "divider") {
      return [{ type: "divider" }];
    }
    if (blockType === "context") {
      const elements = Array.isArray(block.elements) ? block.elements : [];
      const text = normalizeOptionalString(
        elements
          .map((element) => (isRecord(element) ? normalizeOptionalString(element.text) : undefined))
          .filter((part): part is string => Boolean(part))
          .join(" "),
      );
      return text ? [{ type: "context", text }] : [];
    }
    const text = readSlackBlockText(block);
    return text ? [{ type: "text", text }] : [];
  });
  return presentationBlocks.length > 0 ? { blocks: presentationBlocks } : undefined;
}

function extractSlackReplayAgentReplyPayloads(result: unknown): SlackReplayAgentReplyPayload[] {
  if (!isRecord(result) || !Array.isArray(result.payloads)) {
    return [];
  }
  return result.payloads
    .flatMap((payload): SlackReplayAgentReplyPayload[] => {
      if (!isRecord(payload)) {
        return [];
      }
      const message = normalizeOptionalString(payload.text);
      const mediaUrl = normalizeOptionalString(payload.mediaUrl);
      const mediaUrls = Array.from(
        new Set([
          ...(mediaUrl ? [mediaUrl] : []),
          ...normalizeSlackReplayStringArray(payload.mediaUrls),
        ]),
      );
      const presentation =
        payload.presentation ?? convertSlackBlocksToPresentation(extractSlackReplayBlocks(payload));
      const interactive = payload.interactive;
      if (
        !message &&
        mediaUrls.length === 0 &&
        presentation === undefined &&
        interactive === undefined
      ) {
        return [];
      }
      return [
        {
          ...(message ? { message } : {}),
          ...(mediaUrl ? { mediaUrl } : {}),
          ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
          ...(presentation !== undefined ? { presentation } : {}),
          ...(interactive !== undefined ? { interactive } : {}),
        },
      ];
    })
    .filter((payload) =>
      Boolean(
        payload.message ||
        payload.mediaUrl ||
        payload.mediaUrls?.length ||
        payload.presentation ||
        payload.interactive,
      ),
    );
}

function summarizeSlackReplayAgentReplyPayloads(
  payloads: SlackReplayAgentReplyPayload[],
): string | undefined {
  return normalizeOptionalString(
    payloads
      .map((payload) => payload.message)
      .filter((message): message is string => Boolean(message))
      .join("\n\n"),
  );
}

function createSlackReplayAgentReplySends(params: {
  payloads: SlackReplayAgentReplyPayload[];
  target: string;
  accountId: string;
  threadTs?: string;
}): Array<Record<string, unknown>> {
  const sends: Array<Record<string, unknown>> = [];
  for (const payload of params.payloads) {
    const mediaUrls = payload.mediaUrls?.length
      ? payload.mediaUrls
      : payload.mediaUrl
        ? [payload.mediaUrl]
        : [];
    const safeMediaUrls = mediaUrls.map(normalizeSlackReplayMediaReference);
    if (safeMediaUrls.length <= 1) {
      sends.push({
        to: params.target,
        accountId: params.accountId,
        ...(payload.message ? { message: payload.message } : {}),
        ...(safeMediaUrls[0] ? { media: safeMediaUrls[0] } : {}),
        ...(payload.presentation !== undefined ? { presentation: payload.presentation } : {}),
        ...(payload.interactive !== undefined ? { interactive: payload.interactive } : {}),
        ...(params.threadTs ? { threadId: params.threadTs } : {}),
      });
      continue;
    }
    for (const mediaUrl of safeMediaUrls) {
      sends.push({
        to: params.target,
        accountId: params.accountId,
        media: mediaUrl,
        ...(params.threadTs ? { threadId: params.threadTs } : {}),
      });
    }
    if (
      payload.message ||
      payload.presentation !== undefined ||
      payload.interactive !== undefined
    ) {
      sends.push({
        to: params.target,
        accountId: params.accountId,
        ...(payload.message ? { message: payload.message } : {}),
        ...(payload.presentation !== undefined ? { presentation: payload.presentation } : {}),
        ...(payload.interactive !== undefined ? { interactive: payload.interactive } : {}),
        ...(params.threadTs ? { threadId: params.threadTs } : {}),
      });
    }
  }
  return sends;
}

function normalizeSlackReplayMediaReference(media: string): string {
  if (/^https?:\/\//i.test(media) || /^file:\/\//i.test(media) || path.isAbsolute(media)) {
    return media;
  }
  throw new Error(
    `Watchdog replay cannot safely deliver relative media reference ${JSON.stringify(media)}; rerun through normal delivery or use an absolute/file/HTTP media URL.`,
  );
}

export function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "bigint") {
    return `bigint:${value.toString()}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return `number:${String(value)}`;
  }
  if (typeof value === "symbol") {
    return `symbol:${JSON.stringify(value.description ?? "")}`;
  }
  if (typeof value === "function") {
    return `function:${JSON.stringify(value.name)}`;
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, (entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function hashSlackReplaySendParams(params: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(params)).digest("hex");
}

function assertReplayAgentReplyPlanStable(params: {
  stateEntry: WatchdogActionStateEntry;
  sendPlanHashes: string[];
}) {
  const existingParts = params.stateEntry.replayAgentReplyParts ?? {};
  const existingPlan = params.stateEntry.replayAgentReplyPlan;
  if (!existingPlan) {
    if (Object.keys(existingParts).length > 0) {
      throw new Error(
        "Watchdog replay has partial agent reply state without a saved send plan; refusing to risk duplicate delivery.",
      );
    }
    return;
  }
  if (
    existingPlan.length !== params.sendPlanHashes.length ||
    existingPlan.some((hash, index) => hash !== params.sendPlanHashes[index])
  ) {
    throw new Error(
      "Watchdog replay agent reply plan changed after partial delivery; refusing to risk mismatched Slack delivery.",
    );
  }
}

async function sendSlackMissedMessageReplies(params: {
  callGatewayFn: typeof callGateway;
  report: WatchdogScanReport;
  replyAccountId: string;
  statePath: string;
  timeoutMs: number;
  now: Date;
  dryRun: boolean;
  maxReplies: number;
}): Promise<WatchdogSourceReplyResult> {
  const state = await readSlackWatchdogActionState(params.statePath);
  const missing = params.report.records.filter((record) => record.verdict === "missing-admission");
  const candidates = missing
    .filter((record) => record.channel && record.ts)
    .filter((record) => !state[slackWatchdogAlertKey(record)]?.sourceRepliedAt);
  const selected = candidates.slice(0, params.maxReplies);
  const message = formatSlackMissedMessageReply();
  const results: WatchdogSourceReplyRecordResult[] = [];
  const successfulUpdates: Array<{
    key: string;
    repliedAt: string;
    sourceReplyTs?: string;
  }> = [];

  for (const record of selected) {
    const target = `channel:${record.channel}`;
    const threadTs = resolveSlackMissedMessageReplyThreadTs(record);
    if (params.dryRun) {
      results.push({
        channel: record.channel,
        ...(record.ts ? { ts: record.ts } : {}),
        ...(threadTs ? { threadTs } : {}),
        target,
        attempted: false,
        sent: false,
        skippedKnown: false,
        dryRun: true,
        message,
      });
      continue;
    }
    try {
      const response = await params.callGatewayFn({
        method: "message.action",
        params: {
          channel: "slack",
          action: "send",
          accountId: params.replyAccountId,
          params: {
            to: target,
            accountId: params.replyAccountId,
            message,
            ...(threadTs ? { threadId: threadTs } : {}),
          },
          // Stable per source message: a send accepted before state persistence can
          // be retried without producing a second Slack reply.
          idempotencyKey: slackWatchdogSourceReplyIdempotencyKey(record),
        },
        timeoutMs: params.timeoutMs,
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      });
      const sourceReplyTs = extractSlackSendTs(response);
      const repliedAt = params.now.toISOString();
      const key = slackWatchdogAlertKey(record);
      successfulUpdates.push({ key, repliedAt, ...(sourceReplyTs ? { sourceReplyTs } : {}) });
      results.push({
        channel: record.channel,
        ...(record.ts ? { ts: record.ts } : {}),
        ...(threadTs ? { threadTs } : {}),
        target,
        attempted: true,
        sent: true,
        skippedKnown: false,
        dryRun: false,
        message,
        ...(sourceReplyTs ? { sourceReplyTs } : {}),
      });
    } catch (error) {
      results.push({
        channel: record.channel,
        ...(record.ts ? { ts: record.ts } : {}),
        ...(threadTs ? { threadTs } : {}),
        target,
        attempted: true,
        sent: false,
        skippedKnown: false,
        dryRun: false,
        message,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const skippedKnown = missing.length - candidates.length;
  const sent = results.filter((result) => result.sent).length;
  const failed = results.filter((result) => result.error).length;
  if (!params.dryRun && sent > 0) {
    await withSlackWatchdogReplayStateLock(params.statePath, async () => {
      const currentState = await readSlackWatchdogActionState(params.statePath);
      for (const update of successfulUpdates) {
        currentState[update.key] = {
          ...currentState[update.key],
          sourceRepliedAt: update.repliedAt,
          ...(update.sourceReplyTs ? { sourceReplyTs: update.sourceReplyTs } : {}),
        };
      }
      await writeSlackWatchdogActionState(params.statePath, currentState);
    });
  }
  return {
    accountId: params.replyAccountId,
    attempted: true,
    dryRun: params.dryRun,
    sent,
    skippedKnown,
    failed,
    statePath: params.statePath,
    maxReplies: params.maxReplies,
    records: results,
  };
}

async function sendSlackReplayAgentReply(params: {
  callGatewayFn: typeof callGateway;
  record: WatchdogScanRecord;
  accountId: string;
  statePath: string;
  agentId: string;
  sessionKey: string;
  timeoutMs: number;
  now: Date;
  payloads: SlackReplayAgentReplyPayload[];
}): Promise<WatchdogReplayFollowUpResult> {
  const target = `channel:${params.record.channel}`;
  const threadTs = resolveSlackMissedMessageReplyThreadTs(params.record);
  const message = summarizeSlackReplayAgentReplyPayloads(params.payloads);
  const sends = createSlackReplayAgentReplySends({
    payloads: params.payloads,
    target,
    accountId: params.accountId,
    ...(threadTs ? { threadTs } : {}),
  });
  const sendPlanHashes = sends.map((sendParams) => hashSlackReplaySendParams(sendParams));
  try {
    const stateKey = slackWatchdogAlertKey(params.record);
    await withSlackWatchdogReplayStateLock(params.statePath, async () => {
      const state = await readSlackWatchdogActionState(params.statePath);
      const stateEntry = state[stateKey] ?? {};
      assertReplayAgentReplyPlanStable({ stateEntry, sendPlanHashes });
      if (!stateEntry.replayAgentReplyPlan) {
        state[stateKey] = { ...stateEntry, replayAgentReplyPlan: sendPlanHashes };
        await writeSlackWatchdogActionState(params.statePath, state);
      }
    });
    let sourceReplyTs: string | undefined;
    for (const [index, sendParams] of sends.entries()) {
      const partKey = String(index);
      const existingPart = await withSlackWatchdogReplayStateLock(params.statePath, async () => {
        const state = await readSlackWatchdogActionState(params.statePath);
        const stateEntry = state[stateKey] ?? {};
        assertReplayAgentReplyPlanStable({ stateEntry, sendPlanHashes });
        const replayAgentReplyParts = { ...stateEntry.replayAgentReplyParts };
        const part = replayAgentReplyParts[partKey];
        if (part?.sentAt || part?.attemptedAt) {
          return part;
        }
        replayAgentReplyParts[partKey] = { attemptedAt: params.now.toISOString() };
        state[stateKey] = { ...stateEntry, replayAgentReplyParts };
        await writeSlackWatchdogActionState(params.statePath, state);
        return undefined;
      });
      if (existingPart?.sentAt) {
        sourceReplyTs = existingPart.sourceReplyTs ?? sourceReplyTs;
        continue;
      }
      if (existingPart?.attemptedAt) {
        throw new Error(
          `Watchdog replay agent reply part ${partKey} has ambiguous prior delivery at ${existingPart.attemptedAt}; refusing automatic retry to avoid duplicate Slack delivery.`,
        );
      }
      const response = await params.callGatewayFn({
        method: "message.action",
        params: {
          channel: "slack",
          action: "send",
          accountId: params.accountId,
          params: sendParams,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          toolContext: {
            currentChannelId: params.record.channel,
            ...(threadTs ? { currentThreadTs: threadTs } : {}),
          },
          idempotencyKey: [
            "channels-watchdog-replay-agent-reply",
            params.accountId,
            params.record.channel,
            params.record.ts,
            String(index),
          ].join(":"),
        },
        timeoutMs: params.timeoutMs,
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      });
      sourceReplyTs = extractSlackSendTs(response) ?? sourceReplyTs;
      await withSlackWatchdogReplayStateLock(params.statePath, async () => {
        const state = await readSlackWatchdogActionState(params.statePath);
        const stateEntry = state[stateKey] ?? {};
        const replayAgentReplyParts = { ...stateEntry.replayAgentReplyParts };
        replayAgentReplyParts[partKey] = {
          attemptedAt: params.now.toISOString(),
          sentAt: params.now.toISOString(),
          ...(sourceReplyTs ? { sourceReplyTs } : {}),
        };
        state[stateKey] = { ...stateEntry, replayAgentReplyParts };
        await writeSlackWatchdogActionState(params.statePath, state);
      });
    }
    return {
      attempted: true,
      sent: true,
      target,
      ...(threadTs ? { threadTs } : {}),
      ...(message ? { message } : {}),
      payloadCount: params.payloads.length,
      sentCount: sends.length,
      ...(sourceReplyTs ? { sourceReplyTs } : {}),
    };
  } catch (error) {
    return {
      attempted: true,
      sent: false,
      target,
      ...(threadTs ? { threadTs } : {}),
      ...(message ? { message } : {}),
      payloadCount: params.payloads.length,
      sentCount: sends.length,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function sendSlackReplayCompleteReply(params: {
  callGatewayFn: typeof callGateway;
  record: WatchdogScanRecord;
  accountId: string;
  statePath: string;
  timeoutMs: number;
  now: Date;
}): Promise<WatchdogReplayFollowUpResult> {
  const target = `channel:${params.record.channel}`;
  const threadTs = resolveSlackMissedMessageReplyThreadTs(params.record);
  const message = formatSlackRecoveryCompleteReply();
  const stateKey = slackWatchdogAlertKey(params.record);
  const attemptedAt = params.now.toISOString();
  try {
    const existing = await withSlackWatchdogReplayStateLock(params.statePath, async () => {
      const state = await readSlackWatchdogActionState(params.statePath);
      const stateEntry = state[stateKey] ?? {};
      if (stateEntry.replayOutcome !== "dispatched") {
        throw new Error(
          "Watchdog replay completion reply requires a durably dispatched replay state.",
        );
      }
      if (stateEntry.replayCompleteReply?.sentAt) {
        return stateEntry.replayCompleteReply;
      }
      state[stateKey] = {
        ...stateEntry,
        replayCompleteReply: { attemptedAt },
      };
      await writeSlackWatchdogActionState(params.statePath, state);
      return undefined;
    });
    if (existing?.sentAt) {
      return {
        attempted: false,
        sent: true,
        target,
        ...(threadTs ? { threadTs } : {}),
        message,
        ...(existing.sourceReplyTs ? { sourceReplyTs: existing.sourceReplyTs } : {}),
      };
    }
    const response = await params.callGatewayFn({
      method: "message.action",
      params: {
        channel: "slack",
        action: "send",
        accountId: params.accountId,
        params: {
          to: target,
          accountId: params.accountId,
          message,
          ...(threadTs ? { threadId: threadTs } : {}),
        },
        // Stable per replay: a send accepted before state persistence can be retried safely.
        idempotencyKey: slackWatchdogReplayCompleteIdempotencyKey(params.record),
      },
      timeoutMs: params.timeoutMs,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
    });
    const sourceReplyTs = extractSlackSendTs(response);
    await withSlackWatchdogReplayStateLock(params.statePath, async () => {
      const state = await readSlackWatchdogActionState(params.statePath);
      const stateEntry = state[stateKey] ?? {};
      state[stateKey] = {
        ...stateEntry,
        replayCompleteReply: {
          attemptedAt,
          sentAt: params.now.toISOString(),
          ...(sourceReplyTs ? { sourceReplyTs } : {}),
        },
      };
      await writeSlackWatchdogActionState(params.statePath, state);
    });
    return {
      attempted: true,
      sent: true,
      target,
      ...(threadTs ? { threadTs } : {}),
      message,
      ...(sourceReplyTs ? { sourceReplyTs } : {}),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await withSlackWatchdogReplayStateLock(params.statePath, async () => {
      const state = await readSlackWatchdogActionState(params.statePath);
      const stateEntry = state[stateKey] ?? {};
      if (stateEntry.replayCompleteReply?.sentAt) {
        return;
      }
      state[stateKey] = {
        ...stateEntry,
        replayCompleteReply: { attemptedAt, error: errorMessage },
      };
      await writeSlackWatchdogActionState(params.statePath, state);
    });
    return {
      attempted: true,
      sent: false,
      target,
      ...(threadTs ? { threadTs } : {}),
      message,
      error: errorMessage,
    };
  }
}

type SlackWatchdogReplayReservationResult =
  | { status: "reserved"; reservationId: string }
  | { status: "already-dispatched" }
  | { status: "already-replaying" }
  | { status: "already-attempted" };

async function withSlackWatchdogReplayStateLock<T>(
  statePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return await runQueuedStoreWrite({
    queues: SLACK_WATCHDOG_REPLAY_STATE_WRITER_QUEUES,
    storePath: statePath,
    label: "withSlackWatchdogReplayStateLock",
    fn: async () => {
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      return await withFileLock(statePath, SLACK_WATCHDOG_REPLAY_STATE_LOCK_OPTIONS, fn);
    },
  });
}

async function reserveSlackWatchdogReplay(params: {
  statePath: string;
  record: WatchdogScanRecord;
  now: Date;
}): Promise<SlackWatchdogReplayReservationResult> {
  return await withSlackWatchdogReplayStateLock(params.statePath, async () => {
    const state = await readSlackWatchdogActionState(params.statePath);
    const key = slackWatchdogAlertKey(params.record);
    const existing = state[key];
    if (existing?.replayOutcome === "dispatched") {
      return { status: "already-dispatched" };
    }
    if (existing?.replayOutcome === "in-progress" && existing.replayReservationId) {
      return { status: "already-replaying" };
    }
    // Any prior attempt may already have run agent tools or delivered part of a reply.
    // Fail closed until an operator repairs the state; automatic retry risks duplicates.
    if (existing?.replayAttemptedAt || existing?.replayOutcome === "failed") {
      return { status: "already-attempted" };
    }
    const reservationId = randomUUID();
    const reservedAt = params.now.toISOString();
    state[key] = {
      ...existing,
      replayAttemptedAt: reservedAt,
      replayOutcome: "in-progress",
      replayReservationId: reservationId,
      replayReservedAt: reservedAt,
    };
    await writeSlackWatchdogActionState(params.statePath, state);
    return { status: "reserved", reservationId };
  });
}

async function finishSlackWatchdogReplayReservation(params: {
  statePath: string;
  record: WatchdogScanRecord;
  reservationId: string;
  now: Date;
  outcome: Extract<WatchdogReplayOutcome, "failed" | "dispatched">;
}): Promise<void> {
  await withSlackWatchdogReplayStateLock(params.statePath, async () => {
    const state = await readSlackWatchdogActionState(params.statePath);
    const key = slackWatchdogAlertKey(params.record);
    const existing = state[key];
    if (existing?.replayOutcome === "dispatched") {
      return;
    }
    if (
      existing?.replayOutcome !== "in-progress" ||
      existing.replayReservationId !== params.reservationId
    ) {
      throw new Error("Slack watchdog replay reservation ownership changed before completion.");
    }
    const finished: WatchdogActionStateEntry = {
      ...existing,
      replayAttemptedAt: params.now.toISOString(),
      replayOutcome: params.outcome,
    };
    delete finished.replayReservationId;
    delete finished.replayReservedAt;
    state[key] = finished;
    await writeSlackWatchdogActionState(params.statePath, state);
  });
}

async function hasSlackWatchdogReplayDispatched(params: {
  statePath: string;
  record: WatchdogScanRecord;
}): Promise<boolean> {
  const state = await readSlackWatchdogActionState(params.statePath);
  return state[slackWatchdogAlertKey(params.record)]?.replayOutcome === "dispatched";
}

function newestIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return right > left ? right : left;
}

function buildSlackWatchdogStatusReport(params: {
  accountId: string;
  statePath: string;
  state: WatchdogActionState;
}): WatchdogStatusReport {
  let operatorAlerted = 0;
  let sourceReplied = 0;
  let replayAttempted = 0;
  let replayDispatched = 0;
  let replayFailed = 0;
  let latestOperatorAlertedAt: string | undefined;
  let latestSourceRepliedAt: string | undefined;
  let latestReplayAttemptedAt: string | undefined;

  for (const entry of Object.values(params.state)) {
    if (entry.operatorAlertedAt) {
      operatorAlerted += 1;
      latestOperatorAlertedAt = newestIso(latestOperatorAlertedAt, entry.operatorAlertedAt);
    }
    if (entry.sourceRepliedAt) {
      sourceReplied += 1;
      latestSourceRepliedAt = newestIso(latestSourceRepliedAt, entry.sourceRepliedAt);
    }
    if (entry.replayAttemptedAt) {
      replayAttempted += 1;
      latestReplayAttemptedAt = newestIso(latestReplayAttemptedAt, entry.replayAttemptedAt);
    }
    if (entry.replayOutcome === "dispatched") {
      replayDispatched += 1;
    }
    if (entry.replayOutcome === "failed") {
      replayFailed += 1;
    }
  }

  return {
    accountId: params.accountId,
    statePath: params.statePath,
    knownMessages: Object.keys(params.state).length,
    operatorAlerted,
    sourceReplied,
    replayAttempted,
    replayDispatched,
    replayFailed,
    ...(latestOperatorAlertedAt ? { latestOperatorAlertedAt } : {}),
    ...(latestSourceRepliedAt ? { latestSourceRepliedAt } : {}),
    ...(latestReplayAttemptedAt ? { latestReplayAttemptedAt } : {}),
  };
}

function formatSlackWatchdogStatusReport(report: WatchdogStatusReport): string {
  const lines = [
    theme.heading("Slack Watchdog Status"),
    `Slack account: ${report.accountId}`,
    `State path: ${report.statePath}`,
    `Known messages: ${report.knownMessages}`,
    `Operator alerts: ${report.operatorAlerted}`,
    `Source replies: ${report.sourceReplied}`,
    `Replay attempts: ${report.replayAttempted}`,
    `Replay dispatched: ${report.replayDispatched}`,
    `Replay failed: ${report.replayFailed}`,
  ];
  if (report.latestOperatorAlertedAt) {
    lines.push(`Latest operator alert: ${report.latestOperatorAlertedAt}`);
  }
  if (report.latestSourceRepliedAt) {
    lines.push(`Latest source reply: ${report.latestSourceRepliedAt}`);
  }
  if (report.latestReplayAttemptedAt) {
    lines.push(`Latest replay attempt: ${report.latestReplayAttemptedAt}`);
  }
  return lines.join("\n");
}

export async function channelsSlackWatchdogStatusCommand(
  opts: ChannelsSlackWatchdogStatusOptions,
  runtime: RuntimeEnv = defaultRuntime,
  deps: Pick<ChannelsSlackWatchdogScanDeps, "env"> = {},
) {
  const accountId = normalizeOptionalString(opts.account) ?? "default";
  // Alert, source-reply, and replay actions share this path by default. An explicit
  // --state selects the single action-state file that this status command inspects.
  const statePath = resolveSlackWatchdogReplayStatePath({
    accountId,
    env: deps.env,
    explicitPath: opts.state,
  });
  const state = await readSlackWatchdogActionState(statePath);
  const report = buildSlackWatchdogStatusReport({ accountId, statePath, state });
  if (opts.json) {
    writeRuntimeJson(runtime, report);
    return;
  }
  runtime.log(formatSlackWatchdogStatusReport(report));
}

export async function channelsSlackWatchdogReplayCommand(
  opts: ChannelsSlackWatchdogReplayOptions,
  runtime: RuntimeEnv = defaultRuntime,
  deps: ChannelsSlackWatchdogReplayDeps = {},
) {
  const cfg = deps.cfg ?? getRuntimeConfig();
  const accountId = normalizeOptionalString(opts.account) ?? "default";
  const parsedTarget = resolveSlackWatchdogTarget({
    target: opts.target,
    permalink: opts.permalink,
  });
  const target: ScanTarget = {
    ...parsedTarget,
    directMessage: opts.directMessage === true || parsedTarget.directMessage,
  };
  const messageTs = resolveSlackWatchdogReplayTs({
    ts: opts.ts,
    permalink: opts.permalink,
  });
  const now = deps.now ?? new Date();
  const sinceMs = parseSlackWatchdogDurationMs(opts.since, 24 * 60 * 60_000);
  const historyReference = slackTsToDate(messageTs) ?? now;
  const oldest = formatSlackEpochSeconds(new Date(historyReference.getTime() - sinceMs));
  const latest = exclusiveSlackUpperBound(messageTs);
  const limit = parsePositiveInteger(opts.limit, 100);
  const ledgerLimit = parsePositiveInteger(opts.ledgerLimit, 5_000);
  const timeoutMs = parsePositiveInteger(opts.timeout, 30_000);
  const permalink = opts.permalink ? parseSlackWatchdogPermalink(opts.permalink) : undefined;
  const threadId = normalizeOptionalString(opts.thread) ?? permalink?.threadTs;
  const callGatewayFn = deps.callGateway ?? callGateway;
  const statePath = resolveSlackWatchdogReplayStatePath({
    accountId,
    env: deps.env,
    explicitPath: opts.state,
  });

  const [messages, ledgerRead] = await Promise.all([
    readSlackMessagesForWatchdog({
      cfg,
      env: deps.env,
      readSlackMessagesFn: deps.readSlackMessages,
      callGatewayFn: deps.callGateway,
      accountId,
      channelId: target.channelId,
      threadId,
      limit,
      oldest,
      latest,
      timeoutMs,
    }),
    readAdmissionRecords({ accountId, limit: ledgerLimit, env: deps.env }),
  ]);
  const ledgerRecords = ledgerRead.records;
  const selectedMessage = findSlackWatchdogMessageByTs(messages, messageTs);
  if (!selectedMessage) {
    const report: WatchdogReplayReport = {
      accountId,
      target: `channel:${target.channelId}`,
      ts: messageTs,
      outcome: "blocked-message-not-found",
      execute: opts.execute === true,
      attempted: false,
      dispatched: false,
      reason: "Slack history read did not return the requested message timestamp.",
      statePath,
    };
    if (opts.json) {
      writeRuntimeJson(runtime, report);
      return;
    }
    runtime.log(formatSlackWatchdogReplayReport(report));
    return;
  }
  // The history query target is authoritative even when Slack omits `channel`
  // from a message payload; replay ledger rows must remain channel-correlatable.
  const message: WatchdogMessage = { ...selectedMessage, channel: target.channelId };

  const channelPolicy = resolveSlackChannelPolicy({
    cfg,
    accountId,
    channelId: target.channelId,
    directMessage: target.directMessage,
  });
  const allowedUserIds = await resolveSlackWatchdogAllowedUsers({
    policy: channelPolicy,
    accountId,
    directMessage: target.directMessage,
    env: deps.env,
  });
  const scan = await scanAdmissionGaps({
    env: deps.env,
    accountId,
    channel: target.channelId,
    messages: [message],
    ledgerRecords,
    botUserIds: splitCsv(opts.botUser),
    directMessage: target.directMessage,
    activeThreadTs: [
      ...new Set([
        ...(threadId ? [threadId] : []),
        ...splitCsv(opts.activeThread),
        ...resolveActiveThreadTsFromLedger({
          accountId,
          channelId: target.channelId,
          records: ledgerRecords,
        }),
      ]),
    ],
    channelRequiresMention: channelPolicy.requireMention,
    allowedUserIds,
  });
  const record = scan.records[0];
  if (!record || record.verdict !== "missing-admission") {
    const report: WatchdogReplayReport = {
      accountId,
      target: `channel:${target.channelId}`,
      ts: messageTs,
      ...(normalizeOptionalString(message.thread_ts) ? { threadTs: message.thread_ts } : {}),
      outcome: "blocked-not-missing",
      execute: opts.execute === true,
      attempted: false,
      dispatched: false,
      reason: record
        ? `Current watchdog verdict is ${record.verdict} (${record.reason}).`
        : "The watchdog scan did not produce a record for the requested message.",
      ...(record ? { record } : {}),
      statePath,
    };
    if (opts.json) {
      writeRuntimeJson(runtime, report);
      return;
    }
    runtime.log(formatSlackWatchdogReplayReport(report));
    return;
  }

  if (await hasSlackWatchdogReplayDispatched({ statePath, record })) {
    const recoveryReply =
      opts.execute === true
        ? await sendSlackReplayCompleteReply({
            callGatewayFn,
            record,
            accountId,
            statePath,
            timeoutMs,
            now,
          })
        : undefined;
    const report: WatchdogReplayReport = {
      accountId,
      target: `channel:${target.channelId}`,
      ts: messageTs,
      ...(record.threadTs ? { threadTs: record.threadTs } : {}),
      outcome: "blocked-already-replayed",
      execute: opts.execute === true,
      attempted: false,
      dispatched: false,
      reason: "This missed message already has a dispatched watchdog replay in state.",
      record,
      ...(recoveryReply ? { recoveryReply } : {}),
      statePath,
    };
    if (opts.json) {
      writeRuntimeJson(runtime, report);
      return;
    }
    runtime.log(formatSlackWatchdogReplayReport(report));
    return;
  }

  if (record.replayEligible === false || ledgerRead.truncated) {
    const replayBlockedReason =
      record.replayBlockedReason ??
      (ledgerRead.truncated ? "admission-ledger-window-truncated" : "watchdog-replay-not-eligible");
    const report: WatchdogReplayReport = {
      accountId,
      target: `channel:${target.channelId}`,
      ts: messageTs,
      ...(record.threadTs ? { threadTs: record.threadTs } : {}),
      outcome: "blocked-not-missing",
      execute: opts.execute === true,
      attempted: false,
      dispatched: false,
      reason: `Watchdog replay is blocked (${replayBlockedReason}).`,
      record: { ...record, replayEligible: false, replayBlockedReason },
      statePath,
    };
    if (opts.json) {
      writeRuntimeJson(runtime, report);
      return;
    }
    runtime.log(formatSlackWatchdogReplayReport(report));
    return;
  }

  if (
    (Array.isArray(message.files) && message.files.length > 0) ||
    (Array.isArray(message.attachments) && message.attachments.length > 0) ||
    (Array.isArray(message.blocks) && message.blocks.length > 0) ||
    !normalizeOptionalString(message.text)
  ) {
    const report: WatchdogReplayReport = {
      accountId,
      target: `channel:${target.channelId}`,
      ts: messageTs,
      ...(record.threadTs ? { threadTs: record.threadTs } : {}),
      outcome: "blocked-not-missing",
      execute: opts.execute === true,
      attempted: false,
      dispatched: false,
      reason:
        "Watchdog replay supports text-only Slack messages; files, attachments, blocks, and file-only messages require faithful ingress replay.",
      record,
      statePath,
    };
    if (opts.json) {
      writeRuntimeJson(runtime, report);
      return;
    }
    runtime.log(formatSlackWatchdogReplayReport(report));
    return;
  }

  const replayTarget = buildSlackReplayTarget({
    target,
    channelId: target.channelId,
    message,
  });
  const route = resolveAgentRoute({
    cfg,
    channel: "slack",
    accountId,
    peer: replayTarget.peer,
  });
  const agentId =
    normalizeOptionalString(opts.agent) ?? route.agentId ?? resolveDefaultAgentId(cfg);
  const baseSessionKey = buildOutboundBaseSessionKey({
    cfg,
    agentId,
    channel: "slack",
    accountId,
    peer: replayTarget.peer,
  });
  const effectiveThreadId = resolveSlackMissedMessageReplyThreadTs(record);
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId: replayTarget.chatType === "channel" ? effectiveThreadId : undefined,
  });
  const sessionKey = threadKeys.sessionKey;
  const delivery = {
    channel: "slack" as const,
    to: replayTarget.to,
    accountId,
    ...(effectiveThreadId ? { threadId: effectiveThreadId } : {}),
  };
  const baseReport: WatchdogReplayReport = {
    accountId,
    target: `channel:${target.channelId}`,
    ts: messageTs,
    ...(record.threadTs ? { threadTs: record.threadTs } : {}),
    outcome: opts.execute === true ? "dispatched" : "dry-run",
    execute: opts.execute === true,
    attempted: opts.execute === true,
    dispatched: false,
    agentId,
    sessionKey,
    delivery,
    record,
    statePath,
  };
  if (opts.execute !== true) {
    if (opts.json) {
      writeRuntimeJson(runtime, baseReport);
      return;
    }
    runtime.log(formatSlackWatchdogReplayReport(baseReport));
    return;
  }

  const reservation = await reserveSlackWatchdogReplay({ statePath, record, now });
  if (reservation.status !== "reserved") {
    const alreadyDispatched = reservation.status === "already-dispatched";
    const alreadyAttempted = reservation.status === "already-attempted";
    const report: WatchdogReplayReport = {
      ...baseReport,
      outcome: alreadyDispatched
        ? "blocked-already-replayed"
        : alreadyAttempted
          ? "blocked-already-attempted"
          : "blocked-already-replaying",
      attempted: false,
      dispatched: false,
      reason: alreadyDispatched
        ? "This missed message already has a dispatched watchdog replay in state."
        : alreadyAttempted
          ? "This missed message already has an attempted watchdog replay in state; manual repair is required before retry."
          : "This missed message already has a watchdog replay in progress.",
    };
    if (opts.json) {
      writeRuntimeJson(runtime, report);
      return;
    }
    runtime.log(formatSlackWatchdogReplayReport(report));
    return;
  }
  const reservationId = reservation.reservationId;
  try {
    const runAgentFromIngress =
      deps.agentCommandFromIngress ??
      (await import("../../agents/agent-command.js")).agentCommandFromIngress;
    await appendWatchdogReplayAdmissionRecord({
      accountId,
      env: deps.env,
      record: buildWatchdogReplayAdmissionRecord({
        accountId,
        message,
        outcome: "replay-attempted",
        reason: "watchdog-replay-attempted",
        routeAgentId: agentId,
        sessionKey,
        now,
      }),
    });
    const agentResult = await runAgentFromIngress(
      {
        message: normalizeOptionalString(message.text) ?? "",
        transcriptMessage: normalizeOptionalString(message.text) ?? "",
        agentId,
        channel: "slack",
        messageChannel: "slack",
        messageProvider: "slack",
        accountId,
        to: replayTarget.to,
        replyTo: replayTarget.to,
        replyChannel: "slack",
        replyAccountId: accountId,
        ...(effectiveThreadId ? { threadId: effectiveThreadId } : {}),
        sessionKey,
        deliver: false,
        allowModelOverride: false,
        senderIsOwner: false,
        runContext: {
          messageChannel: "slack",
          accountId,
          currentChannelId: target.channelId,
          ...(effectiveThreadId ? { currentThreadTs: effectiveThreadId } : {}),
          replyToMode: "first",
        },
        inputProvenance: {
          kind: "external_user",
          sourceChannel: "slack",
          sourceTool: "channels watchdog-replay",
        },
      },
      opts.json ? createJsonReplayAgentRuntime(runtime) : runtime,
    );
    const agentReplyPayloads = extractSlackReplayAgentReplyPayloads(agentResult);
    if (agentReplyPayloads.length === 0) {
      throw new Error("Watchdog replay completed without deliverable agent reply payloads.");
    }
    const agentReply = await sendSlackReplayAgentReply({
      callGatewayFn,
      record,
      accountId,
      statePath,
      agentId,
      sessionKey,
      timeoutMs,
      now,
      payloads: agentReplyPayloads,
    });
    if (!agentReply.sent) {
      baseReport.agentReply = agentReply;
      throw new Error(agentReply.error ?? "Watchdog replay agent reply delivery failed.");
    }
    baseReport.agentReply = agentReply;
  } catch (error) {
    const failedReport: WatchdogReplayReport = {
      ...baseReport,
      outcome: "failed",
      dispatched: false,
      reason: error instanceof Error ? error.message : String(error),
    };
    // Record the ambiguous terminal attempt before diagnostic persistence. Automatic retry is
    // fail-closed because agent tools or reply delivery may already have produced side effects.
    await finishSlackWatchdogReplayReservation({
      statePath,
      record,
      reservationId,
      now,
      outcome: "failed",
    });
    await appendWatchdogReplayAdmissionRecord({
      accountId,
      env: deps.env,
      record: buildWatchdogReplayAdmissionRecord({
        accountId,
        message,
        outcome: "replay-failed",
        reason: "watchdog-replay-failed",
        routeAgentId: agentId,
        sessionKey,
        now,
      }),
    });
    if (opts.json) {
      writeRuntimeJson(runtime, failedReport);
      return;
    }
    throw error;
  }
  // Persist the terminal idempotency state before the diagnostic ledger. If the latter fails,
  // another executor must still observe that all replay side effects already completed.
  await finishSlackWatchdogReplayReservation({
    statePath,
    record,
    reservationId,
    now,
    outcome: "dispatched",
  });
  await appendWatchdogReplayAdmissionRecord({
    accountId,
    env: deps.env,
    record: buildWatchdogReplayAdmissionRecord({
      accountId,
      message,
      outcome: "replay-dispatched",
      reason: "watchdog-replay-dispatched",
      routeAgentId: agentId,
      sessionKey,
      now,
    }),
  });
  const recoveryReply = await sendSlackReplayCompleteReply({
    callGatewayFn,
    record,
    accountId,
    statePath,
    timeoutMs,
    now,
  });
  const report = { ...baseReport, dispatched: true, recoveryReply };
  if (opts.json) {
    writeRuntimeJson(runtime, report);
    return;
  }
  runtime.log(formatSlackWatchdogReplayReport(report));
}

export async function channelsSlackWatchdogScanCommand(
  opts: ChannelsSlackWatchdogScanOptions,
  runtime: RuntimeEnv = defaultRuntime,
  deps: ChannelsSlackWatchdogScanDeps = {},
) {
  const cfg = deps.cfg ?? getRuntimeConfig();
  const accountId = normalizeOptionalString(opts.account) ?? "default";
  const target = resolveSlackWatchdogTarget({
    target: opts.target,
    permalink: opts.permalink,
  });
  const now = deps.now ?? new Date();
  const sinceMs = parseSlackWatchdogDurationMs(opts.since, 30 * 60_000);
  const permalink = opts.permalink ? parseSlackWatchdogPermalink(opts.permalink) : undefined;
  const permalinkDate = slackTsToDate(permalink?.ts);
  const windowEnd = permalinkDate ?? now;
  const windowStart = new Date(windowEnd.getTime() - sinceMs);
  const oldest = formatSlackEpochSeconds(windowStart);
  const latest = permalink
    ? exclusiveSlackUpperBound(permalink.ts)
    : formatSlackEpochSeconds(windowEnd);
  const limit = parsePositiveInteger(opts.limit, 50);
  const ledgerLimit = parsePositiveInteger(opts.ledgerLimit, 5_000);
  const timeoutMs = parsePositiveInteger(opts.timeout, 10_000);
  const maxReplies = parsePositiveInteger(opts.maxReplies, 3);
  const threadId = normalizeOptionalString(opts.thread) ?? permalink?.threadTs;
  const channelPolicy = resolveSlackChannelPolicy({
    cfg,
    accountId,
    channelId: target.channelId,
    directMessage: opts.directMessage === true || target.directMessage,
  });
  const allowedUserIds = await resolveSlackWatchdogAllowedUsers({
    policy: channelPolicy,
    accountId,
    directMessage: opts.directMessage === true || target.directMessage,
    env: deps.env,
  });

  const [messages, ledgerRead] = await Promise.all([
    readSlackMessagesForWatchdog({
      cfg,
      env: deps.env,
      readSlackMessagesFn: deps.readSlackMessages,
      callGatewayFn: deps.callGateway,
      accountId,
      channelId: target.channelId,
      threadId,
      limit,
      oldest,
      latest,
      timeoutMs,
    }),
    readAdmissionRecords({ accountId, limit: ledgerLimit, env: deps.env }),
  ]);
  const ledgerRecords = ledgerRead.records;

  const report = await scanAdmissionGaps({
    env: deps.env,
    accountId,
    channel: target.channelId,
    messages,
    ledgerRecords,
    botUserIds: splitCsv(opts.botUser),
    directMessage: opts.directMessage === true || target.directMessage,
    activeThreadTs: [
      ...new Set([
        ...(threadId ? [threadId] : []),
        ...splitCsv(opts.activeThread),
        ...resolveActiveThreadTsFromLedger({
          accountId,
          channelId: target.channelId,
          records: ledgerRecords,
        }),
      ]),
    ],
    channelRequiresMention: channelPolicy.requireMention,
    allowedUserIds,
  });
  if (ledgerRead.truncated) {
    for (const record of report.records) {
      if (record.verdict === "missing-admission" && record.replayEligible !== false) {
        record.replayEligible = false;
        record.replayBlockedReason = "admission-ledger-window-truncated";
      }
    }
  }
  attachSlackWatchdogPresentation({
    report,
    cfg,
    accountId,
    channelId: target.channelId,
    tenantLabel: opts.tenantLabel,
    channelName: opts.channelName,
    windowStart,
    windowEnd,
  });
  const hasActionableMissingAdmissions =
    !ledgerRead.truncated &&
    report.records.some(
      (record) => record.verdict === "missing-admission" && record.replayEligible !== false,
    );
  const alertTarget = normalizeOptionalString(opts.alertTarget);
  if (alertTarget && hasActionableMissingAdmissions) {
    report.health = await collectSlackWatchdogHealthDiagnostics({
      callGatewayFn: deps.callGateway ?? callGateway,
      accountId,
      timeoutMs,
      now,
    });
  }
  if (alertTarget && hasActionableMissingAdmissions) {
    report.alert = await sendSlackWatchdogAlert({
      callGatewayFn: deps.callGateway ?? callGateway,
      report,
      alertAccountId: normalizeOptionalString(opts.alertAccount) ?? "default",
      alertTarget,
      statePath: resolveSlackWatchdogAlertStatePath({
        accountId,
        env: deps.env,
        explicitPath: opts.alertState,
      }),
      timeoutMs,
      now,
    });
  }
  if ((opts.replyMissed || opts.dryRunReplies) && hasActionableMissingAdmissions) {
    report.sourceReplies = await sendSlackMissedMessageReplies({
      callGatewayFn: deps.callGateway ?? callGateway,
      report,
      replyAccountId: normalizeOptionalString(opts.replyAccount) ?? accountId,
      statePath: resolveSlackWatchdogReplyStatePath({
        accountId,
        env: deps.env,
        explicitPath: opts.replyState,
      }),
      timeoutMs,
      now,
      dryRun: opts.dryRunReplies === true,
      maxReplies,
    });
  }

  if (opts.json) {
    writeRuntimeJson(runtime, report);
    return;
  }
  runtime.log(formatSlackWatchdogScanReport(report));
}
