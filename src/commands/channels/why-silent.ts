import { randomUUID } from "node:crypto";
import { callGateway } from "../../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../gateway/protocol/client-info.js";
import { formatTimeAgo } from "../../infra/format-time/format-relative.ts";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { theme } from "../../terminal/theme.js";

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
  };
  verdict:
    | "no-messages"
    | "no-inbound-candidate"
    | "no-account-status"
    | "message-before-current-lifecycle"
    | "likely-not-ingested"
    | "account-inbound-after-message"
    | "inconclusive";
  explanation: string;
};

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

export function buildChannelsWhySilentReport(params: {
  channel: string;
  accountId: string;
  target: string;
  account?: ChannelAccountLike;
  messages: MessageLike[];
  now?: number;
}): WhySilentReport {
  const now = params.now ?? Date.now();
  const newest = params.messages.find(isInboundCandidate);
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
  const accountSummary = {
    running: account?.running,
    connected: account?.connected,
    lastStartAt: account?.lastStartAt,
    lastInboundAt: account?.lastInboundAt,
    lastTransportActivityAt: account?.lastTransportActivityAt,
  };

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
    return {
      channel: params.channel,
      accountId: params.accountId,
      target: params.target,
      account: accountSummary,
      verdict: "no-inbound-candidate",
      explanation: "Recent channel history contains no non-bot inbound candidate messages.",
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

  const lastInboundAt =
    typeof account.lastInboundAt === "number" && Number.isFinite(account.lastInboundAt)
      ? account.lastInboundAt
      : undefined;
  const lastStartAt =
    typeof account.lastStartAt === "number" && Number.isFinite(account.lastStartAt)
      ? account.lastStartAt
      : undefined;

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
  lines.push(`Last transport: ${formatTimestamp(report.account.lastTransportActivityAt)}`);
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
  const report = buildChannelsWhySilentReport({
    channel,
    accountId,
    target,
    account,
    messages: extractReadMessages(actionPayload),
  });

  if (opts.json) {
    writeRuntimeJson(runtime, report);
    return;
  }
  runtime.log(formatChannelsWhySilentReport(report).join("\n"));
}
