import type { WebClient } from "@slack/web-api";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
  ledgerLimit?: string;
  json?: boolean;
};

type SlackApi = typeof import("@openclaw/slack/api.js");

export type ChannelsSlackWatchdogScanDeps = {
  cfg?: OpenClawConfig;
  slackApi?: Pick<
    SlackApi,
    | "createSlackWebClient"
    | "readSlackAdmissionRecords"
    | "readSlackMessages"
    | "resolveSlackChannelConfig"
    | "resolveSlackAccount"
    | "scanSlackAdmissionGaps"
  >;
  now?: Date;
};

type ScanTarget = {
  channelId: string;
  directMessage: boolean;
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

function formatSlackWatchdogScanReport(
  report: ReturnType<SlackApi["scanSlackAdmissionGaps"]>,
): string {
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
    return lines.join("\n");
  }
  lines.push("Missing admissions:");
  for (const record of missing.slice(0, 20)) {
    lines.push(`- ts=${record.ts ?? "<unknown>"} reason=${record.reason}`);
  }
  return lines.join("\n");
}

async function loadSlackApi(): Promise<ChannelsSlackWatchdogScanDeps["slackApi"]> {
  return await import("@openclaw/slack/api.js");
}

async function resolveBotUserId(params: {
  slackApi: NonNullable<ChannelsSlackWatchdogScanDeps["slackApi"]>;
  cfg: OpenClawConfig;
  accountId: string;
  explicitBotUser?: string;
}): Promise<string | undefined> {
  const explicit = normalizeOptionalString(params.explicitBotUser);
  if (explicit) {
    return explicit;
  }
  const account = params.slackApi.resolveSlackAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!account.botToken) {
    throw new Error(
      `Slack account ${params.accountId} has no resolved bot token for watchdog scan.`,
    );
  }
  const client = params.slackApi.createSlackWebClient(account.botToken) as WebClient;
  const auth = await client.auth.test();
  return normalizeOptionalString(auth.user_id);
}

export async function channelsSlackWatchdogScanCommand(
  opts: ChannelsSlackWatchdogScanOptions,
  runtime: RuntimeEnv = defaultRuntime,
  deps: ChannelsSlackWatchdogScanDeps = {},
) {
  const cfg = deps.cfg ?? getRuntimeConfig();
  const slackApi = deps.slackApi ?? (await loadSlackApi());
  const accountId = normalizeOptionalString(opts.account) ?? "default";
  const target = parseSlackWatchdogTarget(opts.target);
  const now = deps.now ?? new Date();
  const sinceMs = parseSlackWatchdogDurationMs(opts.since, 30 * 60_000);
  const oldest = formatSlackEpochSeconds(new Date(now.getTime() - sinceMs));
  const limit = parsePositiveInteger(opts.limit, 50);
  const ledgerLimit = parsePositiveInteger(opts.ledgerLimit, 5_000);
  const account = slackApi.resolveSlackAccount({ cfg, accountId });
  const channelConfig = slackApi.resolveSlackChannelConfig({
    channelId: target.channelId,
    channels: account.config.channels,
    defaultRequireMention: account.config.requireMention,
  });
  const botUserId = await resolveBotUserId({
    slackApi,
    cfg,
    accountId,
    explicitBotUser: opts.botUser,
  });

  const [messages, ledgerRecords] = await Promise.all([
    slackApi.readSlackMessages(target.channelId, {
      cfg,
      accountId,
      limit,
      after: oldest,
    }),
    slackApi.readSlackAdmissionRecords({ accountId, limit: ledgerLimit }),
  ]);

  const report = slackApi.scanSlackAdmissionGaps({
    accountId,
    channel: target.channelId,
    messages: messages.messages,
    ledgerRecords,
    botUserIds: botUserId ? [botUserId] : [],
    directMessage: opts.directMessage === true || target.directMessage,
    activeThreadTs: splitCsv(opts.activeThread),
    channelRequiresMention: channelConfig?.requireMention,
    allowedUserIds:
      channelConfig?.allowed === false ? [] : normalizeAllowedUsers(channelConfig?.users),
  });

  if (opts.json) {
    writeRuntimeJson(runtime, report);
    return;
  }
  runtime.log(formatSlackWatchdogScanReport(report));
}
