import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { callGateway } from "../../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { formatTimeAgo } from "../../infra/format-time/format-relative.ts";
import { readPersistedInstalledPluginIndexSync } from "../../plugins/installed-plugin-index-store.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";

export type ChannelsWhySilentOptions = {
  channel?: string;
  account?: string;
  target?: string;
  limit?: string;
  timeout?: string;
  json?: boolean;
};

type ChannelAccountLike = Record<string, unknown> & {
  accountId?: string;
  lastStartAt?: number | null;
  lastInboundAt?: number | null;
  lastTransportActivityAt?: number | null;
  lastSocketConnectedAt?: number | null;
  lastSocketEnvelopeAt?: number | null;
  lastSlackEventAt?: number | null;
  lastSocketError?: string | { at?: number; error?: string } | null;
  slackTelemetry?: Record<string, number>;
  healthState?: string | null;
  connected?: boolean;
  running?: boolean;
};

type MessageLike = Record<string, unknown> & {
  ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
};

type SlackAdmissionRecordLike = {
  accountId?: string;
  channel?: string;
  ts?: string;
  outcome?: string;
  reason?: string;
};

type WhySilentReport = {
  channel: string;
  accountId: string;
  target: string;
  newestMessage?: {
    ts?: string;
    at?: number;
    ageMs?: number;
    user?: string;
    botId?: string;
    subtype?: string;
    textPreview?: string;
  };
  account: {
    running?: boolean;
    connected?: boolean;
    lastStartAt?: number | null;
    lastInboundAt?: number | null;
    lastTransportActivityAt?: number | null;
    lastSocketConnectedAt?: number | null;
    lastSocketEnvelopeAt?: number | null;
    lastSlackEventAt?: number | null;
    lastSocketErrorAt?: number | null;
    healthState?: string | null;
    slackTelemetry?: Record<string, number>;
  };
  verdict:
    | "no-messages"
    | "no-inbound-candidate"
    | "no-account-status"
    | "message-before-current-lifecycle"
    | "likely-not-ingested"
    | "receiver-active-admission-gap"
    | "receiver-dropped-by-policy"
    | "receiver-dropped-self-bot"
    | "socket-receiver-problem"
    | "account-inbound-after-message"
    | "inconclusive";
  explanation: string;
};

type SlackAdmissionApiSurface = {
  readSlackAdmissionRecords: (params: {
    accountId: string;
    env?: NodeJS.ProcessEnv;
    limit?: number;
  }) => Promise<SlackAdmissionRecordLike[]>;
};

const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const IS_SOURCE_CHECKOUT = CURRENT_MODULE_PATH.includes(`${path.sep}src${path.sep}`);

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseSlackTsMs(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.round(parsed * 1000);
}

function readFiniteNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function readTimedErrorAt(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  return readFiniteNumber((raw as { at?: unknown }).at);
}

function readNumberRecord(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = Math.max(0, Math.trunc(value));
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function textPreview(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return undefined;
  }
  return collapsed.length > 120 ? `${collapsed.slice(0, 117)}...` : collapsed;
}

function getAccountsForChannel(
  statusPayload: Record<string, unknown>,
  channel: string,
): ChannelAccountLike[] {
  const channelAccounts = statusPayload.channelAccounts;
  if (!channelAccounts || typeof channelAccounts !== "object" || Array.isArray(channelAccounts)) {
    return [];
  }
  const raw = (channelAccounts as Record<string, unknown>)[channel];
  return Array.isArray(raw) ? (raw as ChannelAccountLike[]) : [];
}

function extractReadMessages(payload: unknown): MessageLike[] {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const nested = root.payload && typeof root.payload === "object" ? root.payload : root;
  const messages = (nested as Record<string, unknown>).messages;
  return Array.isArray(messages) ? (messages as MessageLike[]) : [];
}

function isInboundCandidate(message: MessageLike): boolean {
  if (typeof message.bot_id === "string" && message.bot_id.trim()) {
    return false;
  }
  if (message.subtype === "bot_message") {
    return false;
  }
  return true;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadSlackAdmissionApiSurface(
  env?: NodeJS.ProcessEnv,
): Promise<SlackAdmissionApiSurface | null> {
  const index = readPersistedInstalledPluginIndexSync({ ...(env ? { env } : {}) });
  const plugin = index?.plugins.find((candidate) => candidate.pluginId === "slack");
  const rootDir = normalizeOptionalString(plugin?.rootDir);
  if (plugin?.enabled && rootDir) {
    for (const candidate of [path.join(rootDir, "dist", "api.js"), path.join(rootDir, "api.js")]) {
      if (await pathExists(candidate)) {
        return (await import(pathToFileURL(candidate).href)) as SlackAdmissionApiSurface;
      }
    }
  }
  if (IS_SOURCE_CHECKOUT) {
    return (await import("../../../extensions/slack/api.js")) as SlackAdmissionApiSurface;
  }
  return null;
}

async function readSlackAdmissionRecordsForWhySilent(params: {
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SlackAdmissionRecordLike[]> {
  const api = await loadSlackAdmissionApiSurface(params.env);
  return api?.readSlackAdmissionRecords
    ? await api.readSlackAdmissionRecords({
        accountId: params.accountId,
        ...(params.env ? { env: params.env } : {}),
        limit: 5000,
      })
    : [];
}

function parseSlackChannelTarget(target: string): string | undefined {
  const trimmed = target.trim();
  return trimmed.startsWith("channel:") ? trimmed.slice("channel:".length).trim() : trimmed;
}

function findSlackAdmissionRecord(params: {
  records: readonly SlackAdmissionRecordLike[];
  accountId: string;
  target: string;
  messageTs?: string;
}): SlackAdmissionRecordLike | undefined {
  const channel = parseSlackChannelTarget(params.target);
  return params.records.find(
    (record) =>
      record.accountId === params.accountId &&
      record.channel === channel &&
      record.ts === params.messageTs,
  );
}

function isPolicyDropReason(reason: string | undefined): boolean {
  return (
    reason === "channel-not-allowed" ||
    reason === "channel-user-not-allowed" ||
    reason === "no-mention" ||
    reason === "control-command-unauthorized" ||
    reason === "dm-denied" ||
    reason === "dm-disabled" ||
    reason === "dm-unauthorized"
  );
}

function isSelfBotDropReason(reason: string | undefined): boolean {
  return (
    reason === "bot-self" ||
    reason === "bot-message-disabled" ||
    reason === "bot-room-message-denied" ||
    reason === "bot-message-missing-mention"
  );
}

export function buildChannelsWhySilentReport(params: {
  channel: string;
  accountId: string;
  target: string;
  account?: ChannelAccountLike;
  messages: MessageLike[];
  admissionRecords?: readonly SlackAdmissionRecordLike[];
  now?: number;
}): WhySilentReport {
  const now = params.now ?? Date.now();
  const newest = params.messages.find(isInboundCandidate);
  const newestAny = params.messages[0];
  const newestAt = parseSlackTsMs(newest?.ts);
  const newestMessage = newest
    ? {
        ...(typeof newest.ts === "string" ? { ts: newest.ts } : {}),
        ...(newestAt ? { at: newestAt, ageMs: Math.max(0, now - newestAt) } : {}),
        ...(typeof newest.user === "string" ? { user: newest.user } : {}),
        ...(typeof newest.bot_id === "string" ? { botId: newest.bot_id } : {}),
        ...(typeof newest.subtype === "string" ? { subtype: newest.subtype } : {}),
        ...(textPreview(newest.text) ? { textPreview: textPreview(newest.text) } : {}),
      }
    : undefined;

  const account = params.account;
  const lastStartAt = readFiniteNumber(account?.lastStartAt);
  const lastInboundAt = readFiniteNumber(account?.lastInboundAt);
  const lastSocketConnectedAt = readFiniteNumber(account?.lastSocketConnectedAt);
  const lastSocketEnvelopeAt = readFiniteNumber(account?.lastSocketEnvelopeAt);
  const lastSlackEventAt = readFiniteNumber(account?.lastSlackEventAt);
  const lastSocketErrorAt = readTimedErrorAt(account?.lastSocketError);
  const latestReceiverAt = Math.max(lastSocketEnvelopeAt ?? 0, lastSlackEventAt ?? 0) || undefined;
  const socketErrorIsCurrent =
    lastSocketErrorAt !== undefined &&
    lastSocketErrorAt >= Math.max(lastStartAt ?? 0, lastSocketConnectedAt ?? 0);
  const healthState =
    typeof account?.healthState === "string" && account.healthState.trim()
      ? account.healthState
      : undefined;
  const accountSummary = {
    running: account?.running,
    connected: account?.connected,
    lastStartAt,
    lastInboundAt,
    lastTransportActivityAt: account?.lastTransportActivityAt,
    lastSocketConnectedAt,
    lastSocketEnvelopeAt,
    lastSlackEventAt,
    lastSocketErrorAt,
    healthState,
    slackTelemetry: readNumberRecord(account?.slackTelemetry),
  };
  const admissionRecord =
    params.channel === "slack"
      ? findSlackAdmissionRecord({
          records: params.admissionRecords ?? [],
          accountId: params.accountId,
          target: params.target,
          messageTs: newest?.ts ?? newestAny?.ts,
        })
      : undefined;

  if (params.messages.length === 0) {
    return {
      channel: params.channel,
      accountId: params.accountId,
      target: params.target,
      account: accountSummary,
      verdict: "no-messages",
      explanation: "The channel read returned no recent messages.",
    };
  }

  if (!newest) {
    if (admissionRecord?.outcome === "dropped" && isSelfBotDropReason(admissionRecord.reason)) {
      return {
        channel: params.channel,
        accountId: params.accountId,
        target: params.target,
        account: accountSummary,
        verdict: "receiver-dropped-self-bot",
        explanation:
          "OpenClaw recorded a candidate-specific Slack admission ledger drop for a self/bot message.",
      };
    }
    return {
      channel: params.channel,
      accountId: params.accountId,
      target: params.target,
      account: accountSummary,
      verdict: "no-inbound-candidate",
      explanation: "Recent channel history contains no non-bot inbound candidate messages.",
    };
  }

  if (admissionRecord?.outcome === "dropped") {
    if (isPolicyDropReason(admissionRecord.reason)) {
      return {
        channel: params.channel,
        accountId: params.accountId,
        target: params.target,
        newestMessage,
        account: accountSummary,
        verdict: "receiver-dropped-by-policy",
        explanation:
          "OpenClaw recorded a candidate-specific Slack admission ledger drop by policy.",
      };
    }
    if (isSelfBotDropReason(admissionRecord.reason)) {
      return {
        channel: params.channel,
        accountId: params.accountId,
        target: params.target,
        newestMessage,
        account: accountSummary,
        verdict: "receiver-dropped-self-bot",
        explanation:
          "OpenClaw recorded a candidate-specific Slack admission ledger drop for a self/bot message.",
      };
    }
  }
  if (admissionRecord?.outcome === "accepted") {
    return {
      channel: params.channel,
      accountId: params.accountId,
      target: params.target,
      newestMessage,
      account: accountSummary,
      verdict: "account-inbound-after-message",
      explanation:
        "OpenClaw has candidate-specific Slack admission ledger proof for the newest message. If no reply appeared, inspect dispatch, turn, or reply delivery next.",
    };
  }

  if (!account) {
    return {
      channel: params.channel,
      accountId: params.accountId,
      target: params.target,
      newestMessage,
      account: accountSummary,
      verdict: "no-account-status",
      explanation: "The gateway did not return a matching runtime account snapshot.",
    };
  }

  if (
    params.channel === "slack" &&
    (account.connected === false ||
      socketErrorIsCurrent ||
      healthState === "reconnecting" ||
      healthState === "disconnecting" ||
      healthState === "socket-unhealthy")
  ) {
    return {
      channel: params.channel,
      accountId: params.accountId,
      target: params.target,
      newestMessage,
      account: accountSummary,
      verdict: "socket-receiver-problem",
      explanation:
        "Slack receiver lifecycle evidence indicates a current Slack/network receiver problem.",
    };
  }

  if (newestAt && lastStartAt && newestAt < lastStartAt) {
    return {
      channel: params.channel,
      accountId: params.accountId,
      target: params.target,
      newestMessage,
      account: accountSummary,
      verdict: "message-before-current-lifecycle",
      explanation:
        "The newest inbound candidate predates the current gateway lifecycle, so current runtime activity cannot prove whether that message was ingested.",
    };
  }

  if (newestAt && (!lastInboundAt || newestAt > lastInboundAt + 1000)) {
    if (params.channel === "slack" && latestReceiverAt && latestReceiverAt >= newestAt - 1000) {
      return {
        channel: params.channel,
        accountId: params.accountId,
        target: params.target,
        newestMessage,
        account: accountSummary,
        verdict: "receiver-active-admission-gap",
        explanation:
          "Slack receiver activity is at or after the newest message, but OpenClaw has no account-level inbound/admission proof for it.",
      };
    }
    return {
      channel: params.channel,
      accountId: params.accountId,
      target: params.target,
      newestMessage,
      account: accountSummary,
      verdict: "likely-not-ingested",
      explanation:
        "Slack history contains a newer message than OpenClaw's last inbound timestamp for this account.",
    };
  }

  if (newestAt && lastInboundAt && lastInboundAt >= newestAt) {
    return {
      channel: params.channel,
      accountId: params.accountId,
      target: params.target,
      newestMessage,
      account: accountSummary,
      verdict: "account-inbound-after-message",
      explanation:
        "OpenClaw recorded account-level inbound activity at or after the newest message. If this specific message was missed, inspect turn/session routing next.",
    };
  }

  return {
    channel: params.channel,
    accountId: params.accountId,
    target: params.target,
    newestMessage,
    account: accountSummary,
    verdict: "inconclusive",
    explanation:
      "The latest message timestamp or account inbound timestamp is unavailable, so ingestion cannot be proven from status alone.",
  };
}

function formatTimestamp(raw: number | null | undefined): string {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return "n/a";
  }
  return `${new Date(raw).toISOString()} (${formatTimeAgo(Date.now() - raw)})`;
}

export function formatChannelsWhySilentReport(report: WhySilentReport): string[] {
  const lines = [theme.heading("Why Silent")];
  lines.push(`Verdict: ${report.verdict}`);
  lines.push(`Answer: ${report.explanation}`);
  lines.push(`Channel: ${report.channel}`);
  lines.push(`Account: ${report.accountId}`);
  lines.push(`Target: ${report.target}`);
  lines.push(
    `Runtime: running=${String(report.account.running ?? "unknown")} connected=${String(
      report.account.connected ?? "unknown",
    )}`,
  );
  lines.push(`Last start: ${formatTimestamp(report.account.lastStartAt)}`);
  lines.push(`Last inbound: ${formatTimestamp(report.account.lastInboundAt)}`);
  if (report.channel === "slack") {
    lines.push(`Last socket envelope: ${formatTimestamp(report.account.lastSocketEnvelopeAt)}`);
    lines.push(`Last Slack event: ${formatTimestamp(report.account.lastSlackEventAt)}`);
    lines.push(`Last socket error: ${formatTimestamp(report.account.lastSocketErrorAt)}`);
    if (report.account.healthState) {
      lines.push(`Health state: ${report.account.healthState}`);
    }
    const telemetry = report.account.slackTelemetry;
    if (telemetry) {
      const facts = [
        ["raw", telemetry.rawSlackEvents],
        ["messages", telemetry.messageEvents],
        ["dropped", telemetry.droppedEvents],
        ["policyDrops", telemetry.droppedPolicyEvents],
        ["selfBotDrops", telemetry.droppedSelfBotEvents],
        ["admissions", telemetry.admissionsRecorded],
        ["dispatchFailures", telemetry.dispatchFailures],
      ]
        .filter((entry): entry is [string, number] => typeof entry[1] === "number")
        .map(([label, value]) => `${label}=${value}`);
      if (facts.length > 0) {
        lines.push(`Slack counters: ${facts.join(", ")}`);
      }
    }
  } else {
    lines.push(`Last transport: ${formatTimestamp(report.account.lastTransportActivityAt)}`);
  }
  if (report.newestMessage) {
    lines.push(`Newest message: ${report.newestMessage.ts ?? "unknown"}`);
    if (report.newestMessage.at) {
      lines.push(`Newest message time: ${formatTimestamp(report.newestMessage.at)}`);
    }
    if (report.newestMessage.user) {
      lines.push(`Newest user: ${report.newestMessage.user}`);
    }
    if (report.newestMessage.botId) {
      lines.push(`Newest bot: ${report.newestMessage.botId}`);
    }
    if (report.newestMessage.subtype) {
      lines.push(`Newest subtype: ${report.newestMessage.subtype}`);
    }
    if (report.newestMessage.textPreview) {
      lines.push(`Newest text: ${report.newestMessage.textPreview}`);
    }
  }
  return lines;
}

export async function channelsWhySilentCommand(
  opts: ChannelsWhySilentOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const channel = normalizeOptionalString(opts.channel) ?? "slack";
  const accountId = normalizeOptionalString(opts.account) ?? "default";
  const target = normalizeOptionalString(opts.target);
  if (!target) {
    throw new Error("channels why-silent requires --target <channel-or-dm>.");
  }

  const timeoutMs = parsePositiveInteger(opts.timeout, 10_000);
  const limit = parsePositiveInteger(opts.limit, 5);
  const statusPayload = await callGateway({
    method: "channels.status",
    params: { probe: false, timeoutMs },
    timeoutMs,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  });
  const actionPayload = await callGateway({
    method: "message.action",
    params: {
      channel,
      action: "read",
      accountId,
      params: {
        to: target,
        limit,
        accountId,
      },
      idempotencyKey: `channels-why-silent:${randomUUID()}`,
    },
    timeoutMs,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  });

  const account = getAccountsForChannel(statusPayload, channel).find(
    (candidate) => candidate.accountId === accountId,
  );
  const admissionRecords =
    channel === "slack" ? await readSlackAdmissionRecordsForWhySilent({ accountId }) : [];
  const report = buildChannelsWhySilentReport({
    channel,
    accountId,
    target,
    account,
    messages: extractReadMessages(actionPayload),
    admissionRecords,
  });

  if (opts.json) {
    writeRuntimeJson(runtime, report);
    return;
  }
  runtime.log(formatChannelsWhySilentReport(report).join("\n"));
}
