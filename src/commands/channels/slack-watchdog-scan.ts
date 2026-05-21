import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../gateway/protocol/client-info.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { theme } from "../../terminal/theme.js";

export type ChannelsSlackWatchdogScanOptions = {
  account?: string;
  target?: string;
  limit?: string;
  since?: string;
  botUser?: string;
  directMessage?: boolean;
  activeThread?: string;
  thread?: string;
  alertTarget?: string;
  alertAccount?: string;
  alertState?: string;
  ledgerLimit?: string;
  timeout?: string;
  json?: boolean;
};

export type ChannelsSlackWatchdogScanDeps = {
  cfg?: OpenClawConfig;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  callGateway?: typeof callGateway;
};

type ScanTarget = {
  channelId: string;
  directMessage: boolean;
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
};

type AdmissionRecord = {
  version: 1;
  recordedAt: string;
  accountId: string;
  channel?: string;
  ts?: string;
  threadTs?: string;
  clientMsgId?: string;
  outcome: "accepted" | "dropped";
  reason?: string;
  routeAgentId?: string;
  sessionKey?: string;
};

type WatchdogScanRecord = {
  accountId: string;
  channel: string;
  ts?: string;
  threadTs?: string;
  clientMsgId?: string;
  verdict: WatchdogVerdict;
  reason: string;
  ledgerRecord?: Pick<
    AdmissionRecord,
    "recordedAt" | "outcome" | "reason" | "routeAgentId" | "sessionKey"
  >;
};

type WatchdogScanReport = {
  accountId: string;
  channel: string;
  scanned: number;
  counts: Record<WatchdogVerdict, number>;
  records: WatchdogScanRecord[];
  alert?: WatchdogAlertResult;
};

type WatchdogAlertResult = {
  target: string;
  accountId: string;
  attempted: boolean;
  sent: number;
  skippedKnown: number;
  statePath: string;
};

type SlackChannelPolicy = {
  allowed: boolean;
  requireMention: boolean;
  users?: Array<string | number>;
};

const DURATION_RE = /^(\d+)(ms|s|m|h|d)?$/;

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
    throw new Error("channels watchdog-scan requires --target <channel-or-dm>.");
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

function formatSlackEpochSeconds(date: Date): string {
  const seconds = date.getTime() / 1000;
  return Number.isInteger(seconds)
    ? String(seconds)
    : seconds.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
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

export function resolveSlackWatchdogLedgerPath(params: {
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return path.join(
    resolveOpenClawStateDir(params.env),
    "slack",
    "admission-ledger",
    `${sanitizePathSegment(params.accountId)}.jsonl`,
  );
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

async function readAdmissionRecords(params: {
  accountId: string;
  limit: number;
  env?: NodeJS.ProcessEnv;
}): Promise<AdmissionRecord[]> {
  const ledgerPath = resolveSlackWatchdogLedgerPath({
    accountId: params.accountId,
    env: params.env,
  });
  let raw: string;
  try {
    raw = await fs.readFile(ledgerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-params.limit);
  const records: AdmissionRecord[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Partial<AdmissionRecord>;
      if (parsed.version === 1 && parsed.accountId === params.accountId) {
        records.push(parsed as AdmissionRecord);
      }
    } catch {
      // Ignore malformed rows. The watchdog is diagnostic and should not fail
      // the whole scan because of one partial append or hand-edited line.
    }
  }
  return records;
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

function resolveSlackChannelPolicy(params: {
  cfg: OpenClawConfig;
  accountId: string;
  channelId: string;
}): SlackChannelPolicy {
  const slack = readChannelsConfig(params.cfg, params.accountId);
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
  const defaultRequireMention =
    typeof slack.requireMention === "boolean" ? slack.requireMention : true;
  const allowed = typeof entry.enabled === "boolean" ? entry.enabled : Boolean(matched ?? fallback);
  const requireMention =
    typeof entry.requireMention === "boolean" ? entry.requireMention : defaultRequireMention;
  const users = Array.isArray(entry.users) ? (entry.users as Array<string | number>) : undefined;
  return {
    allowed,
    requireMention,
    ...(users ? { users } : {}),
  };
}

function isBotMessage(message: WatchdogMessage): boolean {
  return Boolean(normalizeOptionalString(message.bot_id)) || message.subtype === "bot_message";
}

function messageContainsBotMention(
  message: WatchdogMessage,
  botUserIds: readonly string[],
): boolean {
  const text = message.text ?? "";
  return botUserIds.some((botUserId) => text.includes(`<@${botUserId}>`));
}

function isAllowedSender(
  message: WatchdogMessage,
  allowedUserIds: readonly string[] | undefined,
): boolean {
  if (!allowedUserIds) {
    return true;
  }
  const user = normalizeOptionalString(message.user);
  return Boolean(user && allowedUserIds.includes(user));
}

function messageKey(message: WatchdogMessage, channel: string): string {
  const ts = normalizeOptionalString(message.ts) ?? "";
  const clientMsgId = normalizeOptionalString(message.client_msg_id) ?? "";
  return `${channel}\0${ts}\0${clientMsgId}`;
}

function ledgerKey(record: AdmissionRecord): string {
  const channel = normalizeOptionalString(record.channel) ?? "";
  const ts = normalizeOptionalString(record.ts) ?? "";
  const clientMsgId = normalizeOptionalString(record.clientMsgId) ?? "";
  return `${channel}\0${ts}\0${clientMsgId}`;
}

function buildLedgerIndex(records: readonly AdmissionRecord[]) {
  const index = new Map<string, AdmissionRecord>();
  for (const record of records) {
    if (!record.channel || !record.ts) {
      continue;
    }
    index.set(ledgerKey(record), record);
    index.set(`${record.channel}\0${record.ts}\0`, record);
  }
  return index;
}

function summarizeLedgerRecord(record: AdmissionRecord): WatchdogScanRecord["ledgerRecord"] {
  return {
    recordedAt: record.recordedAt,
    outcome: record.outcome,
    ...(record.reason ? { reason: record.reason } : {}),
    ...(record.routeAgentId ? { routeAgentId: record.routeAgentId } : {}),
    ...(record.sessionKey ? { sessionKey: record.sessionKey } : {}),
  };
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

function scanAdmissionGaps(params: {
  accountId: string;
  channel: string;
  messages: readonly WatchdogMessage[];
  ledgerRecords: readonly AdmissionRecord[];
  botUserIds?: readonly string[];
  directMessage?: boolean;
  activeThreadTs?: readonly string[];
  channelRequiresMention?: boolean;
  allowedUserIds?: readonly string[];
}): WatchdogScanReport {
  const botUserIds = params.botUserIds ?? [];
  const activeThreadTs = new Set(params.activeThreadTs ?? []);
  const ledger = buildLedgerIndex(
    params.ledgerRecords.filter((record) => record.accountId === params.accountId),
  );
  const records: WatchdogScanRecord[] = [];
  const counts: Record<WatchdogVerdict, number> = {
    admitted: 0,
    "explicitly-ignored": 0,
    "not-relevant": 0,
    "missing-admission": 0,
  };

  for (const message of params.messages) {
    const ts = normalizeOptionalString(message.ts);
    const threadTs = normalizeOptionalString(message.thread_ts);
    const channel = normalizeOptionalString(message.channel) ?? params.channel;
    const base = {
      accountId: params.accountId,
      channel,
      ...(ts ? { ts } : {}),
      ...(threadTs ? { threadTs } : {}),
      ...(normalizeOptionalString(message.client_msg_id)
        ? { clientMsgId: normalizeOptionalString(message.client_msg_id) }
        : {}),
    };

    const admission =
      ledger.get(messageKey(message, channel)) ??
      (ts ? ledger.get(`${channel}\0${ts}\0`) : undefined);
    if (admission?.outcome === "accepted") {
      records.push({
        ...base,
        verdict: "admitted",
        reason: "ledger-accepted",
        ledgerRecord: summarizeLedgerRecord(admission),
      });
      counts.admitted += 1;
      continue;
    }
    if (admission?.outcome === "dropped") {
      records.push({
        ...base,
        verdict: "explicitly-ignored",
        reason: admission.reason ?? "ledger-dropped",
        ledgerRecord: summarizeLedgerRecord(admission),
      });
      counts["explicitly-ignored"] += 1;
      continue;
    }

    const botMessage = isBotMessage(message);
    const allowedSender = isAllowedSender(message, params.allowedUserIds);
    const relevant =
      !botMessage &&
      allowedSender &&
      (params.directMessage === true ||
        params.channelRequiresMention === false ||
        messageContainsBotMention(message, botUserIds) ||
        Boolean(threadTs && activeThreadTs.has(threadTs)));
    if (!relevant) {
      records.push({
        ...base,
        verdict: "not-relevant",
        reason: botMessage
          ? "bot-message"
          : !allowedSender
            ? "sender-not-allowlisted"
            : "no-activation-signal",
      });
      counts["not-relevant"] += 1;
      continue;
    }

    records.push({
      ...base,
      verdict: "missing-admission",
      reason: "activation-without-ledger-record",
    });
    counts["missing-admission"] += 1;
  }

  return {
    accountId: params.accountId,
    channel: params.channel,
    scanned: params.messages.length,
    counts,
    records,
  };
}

function formatSlackWatchdogScanReport(report: WatchdogScanReport): string {
  const lines = [
    theme.heading("Slack Watchdog Scan"),
    `Account: ${report.accountId}`,
    `Channel: ${report.channel}`,
    `Scanned: ${report.scanned}`,
    `Counts: admitted=${report.counts.admitted} explicitly-ignored=${report.counts["explicitly-ignored"]} not-relevant=${report.counts["not-relevant"]} missing-admission=${report.counts["missing-admission"]}`,
  ];
  const missing = report.records.filter((record) => record.verdict === "missing-admission");
  if (missing.length === 0) {
    lines.push("Missing admissions: none");
    if (report.alert?.attempted) {
      lines.push(
        `Alert: sent=${report.alert.sent} skipped-known=${report.alert.skippedKnown} target=${report.alert.accountId}:${report.alert.target}`,
      );
    }
    return lines.join("\n");
  }
  lines.push("Missing admissions:");
  for (const record of missing.slice(0, 20)) {
    lines.push(`- ts=${record.ts ?? "<unknown>"} reason=${record.reason}`);
  }
  if (report.alert?.attempted) {
    lines.push(
      `Alert: sent=${report.alert.sent} skipped-known=${report.alert.skippedKnown} target=${report.alert.accountId}:${report.alert.target}`,
    );
  }
  return lines.join("\n");
}

function slackWatchdogAlertKey(record: WatchdogScanRecord): string {
  return [
    record.accountId,
    record.channel,
    record.ts ?? "",
    record.clientMsgId ?? "",
    record.threadTs ?? "",
  ].join("\0");
}

async function readSlackWatchdogAlertState(statePath: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed)
      ? Object.fromEntries(
          Object.entries(parsed).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeSlackWatchdogAlertState(
  statePath: string,
  state: Record<string, string>,
): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function formatSlackWatchdogAlert(params: {
  report: WatchdogScanReport;
  missing: readonly WatchdogScanRecord[];
}): string {
  const lines = [
    ":warning: OpenClaw Slack admission watchdog detected missed inbound messages",
    `source_account=${params.report.accountId} channel=${params.report.channel}`,
    `scanned=${params.report.scanned} missing=${params.missing.length}`,
    "new_missing:",
  ];
  for (const record of params.missing.slice(0, 10)) {
    lines.push(
      `- ts=${record.ts ?? "<unknown>"} thread=${record.threadTs ?? "<none>"} reason=${record.reason}`,
    );
  }
  if (params.missing.length > 10) {
    lines.push(`- ... ${params.missing.length - 10} more`);
  }
  lines.push("Run `openclaw channels watchdog-scan --json` for full records.");
  return lines.join("\n");
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

async function sendSlackWatchdogAlert(params: {
  callGatewayFn: typeof callGateway;
  report: WatchdogScanReport;
  alertAccountId: string;
  alertTarget: string;
  statePath: string;
  timeoutMs: number;
  now: Date;
}): Promise<WatchdogAlertResult> {
  const state = await readSlackWatchdogAlertState(params.statePath);
  const missing = params.report.records.filter((record) => record.verdict === "missing-admission");
  const newMissing = missing.filter((record) => !state[slackWatchdogAlertKey(record)]);
  if (newMissing.length === 0) {
    return {
      target: params.alertTarget,
      accountId: params.alertAccountId,
      attempted: true,
      sent: 0,
      skippedKnown: missing.length,
      statePath: params.statePath,
    };
  }

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
      idempotencyKey: `channels-watchdog-alert:${randomUUID()}`,
    },
    timeoutMs: params.timeoutMs,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  });

  const alertedAt = params.now.toISOString();
  for (const record of newMissing) {
    state[slackWatchdogAlertKey(record)] = alertedAt;
  }
  await writeSlackWatchdogAlertState(params.statePath, state);
  return {
    target: params.alertTarget,
    accountId: params.alertAccountId,
    attempted: true,
    sent: newMissing.length,
    skippedKnown: missing.length - newMissing.length,
    statePath: params.statePath,
  };
}

export async function channelsSlackWatchdogScanCommand(
  opts: ChannelsSlackWatchdogScanOptions,
  runtime: RuntimeEnv = defaultRuntime,
  deps: ChannelsSlackWatchdogScanDeps = {},
) {
  const cfg = deps.cfg ?? getRuntimeConfig();
  const accountId = normalizeOptionalString(opts.account) ?? "default";
  const target = parseSlackWatchdogTarget(opts.target);
  const now = deps.now ?? new Date();
  const sinceMs = parseSlackWatchdogDurationMs(opts.since, 30 * 60_000);
  const oldest = formatSlackEpochSeconds(new Date(now.getTime() - sinceMs));
  const limit = parsePositiveInteger(opts.limit, 50);
  const ledgerLimit = parsePositiveInteger(opts.ledgerLimit, 5_000);
  const timeoutMs = parsePositiveInteger(opts.timeout, 10_000);
  const threadId = normalizeOptionalString(opts.thread);
  const channelPolicy = resolveSlackChannelPolicy({
    cfg,
    accountId,
    channelId: target.channelId,
  });

  const [messages, ledgerRecords] = await Promise.all([
    readSlackMessagesViaGateway({
      callGatewayFn: deps.callGateway ?? callGateway,
      accountId,
      channelId: target.channelId,
      threadId,
      limit,
      oldest,
      timeoutMs,
    }),
    readAdmissionRecords({ accountId, limit: ledgerLimit, env: deps.env }),
  ]);

  const report = scanAdmissionGaps({
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
    allowedUserIds:
      channelPolicy.allowed === false ? [] : normalizeAllowedUsers(channelPolicy.users),
  });
  const alertTarget = normalizeOptionalString(opts.alertTarget);
  if (alertTarget && report.counts["missing-admission"] > 0) {
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

  if (opts.json) {
    writeRuntimeJson(runtime, report);
    return;
  }
  runtime.log(formatSlackWatchdogScanReport(report));
}
