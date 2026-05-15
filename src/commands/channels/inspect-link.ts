import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimeConfig } from "../../config/config.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { callGateway } from "../../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../gateway/protocol/client-info.js";
import { formatTimeAgo } from "../../infra/format-time/format-relative.ts";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { theme } from "../../terminal/theme.js";
import { resolveSessionStoreTargetsOrExit } from "../session-store-targets.js";

export type ChannelsInspectLinkOptions = {
  account?: string;
  agent?: string;
  limit?: string;
  timeout?: string;
  json?: boolean;
};

export type ParsedSlackPermalink = {
  permalink: string;
  host: string;
  channelId: string;
  target: string;
  messageTs: string;
  rawMessageTs: string;
  threadTs?: string;
};

type RelatedSlackMessage = {
  role: "linked" | "thread-root" | "nearby-human-prompt";
  ts: string;
  user?: string;
  botId?: string;
  subtype?: string;
  textPreview?: string;
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

type SessionMatch = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  sessionFile?: string;
  updatedAt?: number;
  score: number;
  reasons: string[];
};

type FileMatch = {
  agentId: string;
  path: string;
  bytes: number;
  hits: string[];
  trajectory?: TrajectorySummary;
};

type TrajectorySummary = {
  events: number;
  runs: number;
  incompleteRuns: Array<{ runId: string; startedAt?: string }>;
};

type InspectIngressReport = {
  channel: "slack";
  accountId: string;
  target: string;
  linkedMessage?: {
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
    | "linked-message-not-found"
    | "no-account-status"
    | "message-before-current-lifecycle"
    | "likely-not-ingested"
    | "account-inbound-after-message"
    | "inconclusive";
  explanation: string;
};

type InspectLinkReport = {
  ok: true;
  channel: "slack";
  accountId: string;
  parsed: ParsedSlackPermalink;
  relatedSlackMessages: RelatedSlackMessage[];
  ingress: InspectIngressReport;
  sessionScan: {
    storesScanned: Array<{ agentId: string; storePath: string }>;
    sessionMatches: SessionMatch[];
    fileMatches: FileMatch[];
  };
};

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function slackTsToMs(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 1000) : undefined;
}

function normalizeSlackTs(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  if (/^\d+\.\d{6}$/.test(raw)) {
    return raw;
  }
  if (/^\d{16}$/.test(raw)) {
    return `${raw.slice(0, -6)}.${raw.slice(-6)}`;
  }
  return undefined;
}

export function parseSlackPermalink(raw: string): ParsedSlackPermalink {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("inspect-link requires a valid Slack permalink URL.");
  }
  const match = url.pathname.match(/\/archives\/([^/]+)\/p(\d{16})/);
  if (!match) {
    throw new Error("inspect-link only supports Slack permalinks with /archives/<channel>/p<ts>.");
  }
  const messageTs = normalizeSlackTs(match[2]);
  if (!messageTs) {
    throw new Error("Slack permalink timestamp is not in the expected p<16 digits> form.");
  }
  const threadTs = normalizeSlackTs(url.searchParams.get("thread_ts") ?? undefined);
  return {
    permalink: raw,
    host: url.host,
    channelId: match[1],
    target: `channel:${match[1]}`,
    messageTs,
    rawMessageTs: match[2],
    ...(threadTs ? { threadTs } : {}),
  };
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

function messageSummary(
  role: RelatedSlackMessage["role"],
  message: MessageLike,
): RelatedSlackMessage {
  return {
    role,
    ts: String(message.ts),
    ...(typeof message.user === "string" ? { user: message.user } : {}),
    ...(typeof message.bot_id === "string" ? { botId: message.bot_id } : {}),
    ...(typeof message.subtype === "string" ? { subtype: message.subtype } : {}),
    ...(textPreview(message.text) ? { textPreview: textPreview(message.text) } : {}),
  };
}

function isHumanMessage(message: MessageLike): boolean {
  if (typeof message.ts !== "string") {
    return false;
  }
  if (typeof message.bot_id === "string" && message.bot_id.trim()) {
    return false;
  }
  return message.subtype !== "bot_message";
}

export function buildRelatedSlackMessages(params: {
  parsed: ParsedSlackPermalink;
  messages: MessageLike[];
}): RelatedSlackMessage[] {
  const seen = new Set<string>();
  const related: RelatedSlackMessage[] = [];
  const add = (role: RelatedSlackMessage["role"], message: MessageLike | undefined) => {
    if (typeof message?.ts !== "string" || seen.has(`${role}:${message.ts}`)) {
      return;
    }
    seen.add(`${role}:${message.ts}`);
    related.push(messageSummary(role, message));
  };
  add(
    "linked",
    params.messages.find((message) => message.ts === params.parsed.messageTs),
  );
  if (params.parsed.threadTs && params.parsed.threadTs !== params.parsed.messageTs) {
    add(
      "thread-root",
      params.messages.find((message) => message.ts === params.parsed.threadTs),
    );
  }
  const linkedAt = slackTsToMs(params.parsed.messageTs);
  if (linkedAt !== undefined) {
    for (const message of params.messages) {
      const at = slackTsToMs(message.ts);
      if (at === undefined || message.ts === params.parsed.messageTs || !isHumanMessage(message)) {
        continue;
      }
      if (at >= linkedAt - 15_000 && at <= linkedAt + 2_000) {
        add("nearby-human-prompt", message);
      }
    }
  }
  return related;
}

export function buildInspectLinkIngressReport(params: {
  accountId: string;
  target: string;
  account?: ChannelAccountLike;
  linkedMessage?: MessageLike;
  now?: number;
}): InspectIngressReport {
  const now = params.now ?? Date.now();
  const linkedAt = slackTsToMs(params.linkedMessage?.ts);
  const linkedMessage = params.linkedMessage
    ? {
        ...(typeof params.linkedMessage.ts === "string" ? { ts: params.linkedMessage.ts } : {}),
        ...(linkedAt ? { at: linkedAt, ageMs: Math.max(0, now - linkedAt) } : {}),
        ...(typeof params.linkedMessage.user === "string"
          ? { user: params.linkedMessage.user }
          : {}),
        ...(typeof params.linkedMessage.bot_id === "string"
          ? { botId: params.linkedMessage.bot_id }
          : {}),
        ...(typeof params.linkedMessage.subtype === "string"
          ? { subtype: params.linkedMessage.subtype }
          : {}),
        ...(textPreview(params.linkedMessage.text)
          ? { textPreview: textPreview(params.linkedMessage.text) }
          : {}),
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
  if (!params.linkedMessage) {
    return {
      channel: "slack",
      accountId: params.accountId,
      target: params.target,
      account: accountSummary,
      verdict: "linked-message-not-found",
      explanation: "Slack history did not return the exact linked message through message.action.",
    };
  }
  if (!account) {
    return {
      channel: "slack",
      accountId: params.accountId,
      target: params.target,
      linkedMessage,
      account: accountSummary,
      verdict: "no-account-status",
      explanation: "The gateway did not return a matching Slack runtime account snapshot.",
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
  if (linkedAt && lastStartAt && linkedAt < lastStartAt) {
    return {
      channel: "slack",
      accountId: params.accountId,
      target: params.target,
      linkedMessage,
      account: accountSummary,
      verdict: "message-before-current-lifecycle",
      explanation:
        "The linked message predates the current gateway lifecycle, so current runtime activity cannot prove whether that message was ingested.",
    };
  }
  if (linkedAt && (!lastInboundAt || linkedAt > lastInboundAt + 1000)) {
    return {
      channel: "slack",
      accountId: params.accountId,
      target: params.target,
      linkedMessage,
      account: accountSummary,
      verdict: "likely-not-ingested",
      explanation:
        "Slack history contains a linked message newer than OpenClaw's last inbound timestamp for this account.",
    };
  }
  if (linkedAt && lastInboundAt && lastInboundAt >= linkedAt) {
    return {
      channel: "slack",
      accountId: params.accountId,
      target: params.target,
      linkedMessage,
      account: accountSummary,
      verdict: "account-inbound-after-message",
      explanation:
        "OpenClaw recorded account-level inbound activity at or after the linked message. Inspect turn/session routing next.",
    };
  }
  return {
    channel: "slack",
    accountId: params.accountId,
    target: params.target,
    linkedMessage,
    account: accountSummary,
    verdict: "inconclusive",
    explanation:
      "The linked message timestamp or account inbound timestamp is unavailable, so ingestion cannot be proven from status alone.",
  };
}

function stringValues(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())))];
}

function scoreSessionEntry(params: {
  agentId: string;
  sessionKey: string;
  entry: SessionEntry;
  parsed: ParsedSlackPermalink;
  accountId: string;
  needles: string[];
}): SessionMatch | undefined {
  const reasons: string[] = [];
  let score = 0;
  const keyLower = params.sessionKey.toLowerCase();
  const channelLower = params.parsed.channelId.toLowerCase();
  if (keyLower.includes(channelLower)) {
    score += 20;
    reasons.push("session key contains channel id");
  }
  for (const needle of params.needles) {
    if (keyLower.includes(needle.toLowerCase())) {
      score += 40;
      reasons.push(`session key contains ${needle}`);
    }
  }
  const delivery = params.entry.deliveryContext;
  if (delivery?.channel === "slack" || params.entry.lastChannel === "slack") {
    score += 10;
    reasons.push("session is Slack-routed");
  }
  if (delivery?.to === params.parsed.target || params.entry.groupId === params.parsed.channelId) {
    score += 30;
    reasons.push("delivery target matches channel");
  }
  const entryAccount = delivery?.accountId ?? params.entry.lastAccountId;
  if (entryAccount === params.accountId) {
    score += 15;
    reasons.push("account matches");
  }
  const threadId = delivery?.threadId ?? params.entry.lastThreadId;
  if (threadId != null && params.needles.includes(String(threadId))) {
    score += 50;
    reasons.push("thread id matches");
  }
  const linkedAt = slackTsToMs(params.parsed.messageTs);
  if (linkedAt !== undefined && params.entry.updatedAt >= linkedAt - 60_000) {
    score += 5;
    reasons.push("session updated after linked message window");
  }
  if (score <= 0) {
    return undefined;
  }
  return {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.entry.sessionId,
    ...(params.entry.sessionFile ? { sessionFile: params.entry.sessionFile } : {}),
    ...(params.entry.updatedAt ? { updatedAt: params.entry.updatedAt } : {}),
    score,
    reasons,
  };
}

export function buildSessionMatches(params: {
  targets: Array<{ agentId: string; storePath: string; store: Record<string, SessionEntry> }>;
  parsed: ParsedSlackPermalink;
  accountId: string;
  relatedSlackMessages: RelatedSlackMessage[];
}): SessionMatch[] {
  const needles = stringValues([
    params.parsed.messageTs,
    params.parsed.threadTs,
    ...params.relatedSlackMessages.map((message) => message.ts),
  ]);
  return params.targets
    .flatMap((target) =>
      Object.entries(target.store).flatMap(([sessionKey, entry]) => {
        const match = scoreSessionEntry({
          agentId: target.agentId,
          sessionKey,
          entry,
          parsed: params.parsed,
          accountId: params.accountId,
          needles,
        });
        return match ? [match] : [];
      }),
    )
    .toSorted(
      (left, right) => right.score - left.score || (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
    );
}

function findRunId(event: Record<string, unknown>): string | undefined {
  for (const key of ["runId", "run_id", "id"]) {
    const value = event[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  const payload = event.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return findRunId(payload as Record<string, unknown>);
  }
  return undefined;
}

export async function summarizeTrajectoryFile(
  filePath: string,
): Promise<TrajectorySummary | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
  const runs = new Map<string, { started?: boolean; ended?: boolean; startedAt?: string }>();
  let events = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    events += 1;
    const type = typeof event.type === "string" ? event.type : undefined;
    const runId = findRunId(event) ?? "unknown";
    const state = runs.get(runId) ?? {};
    if (type === "session.started") {
      state.started = true;
      if (typeof event.timestamp === "string") {
        state.startedAt = event.timestamp;
      }
    }
    if (type === "session.ended") {
      state.ended = true;
    }
    runs.set(runId, state);
  }
  if (events === 0) {
    return undefined;
  }
  return {
    events,
    runs: runs.size,
    incompleteRuns: [...runs.entries()]
      .filter(([, state]) => state.started && !state.ended)
      .map(([runId, state]) => {
        const run: { runId: string; startedAt?: string } = { runId };
        if (state.startedAt) {
          run.startedAt = state.startedAt;
        }
        return run;
      }),
  };
}

async function scanFileForNeedles(params: {
  agentId: string;
  filePath: string;
  needles: string[];
}): Promise<FileMatch | undefined> {
  let raw: string;
  let stat;
  try {
    [raw, stat] = await Promise.all([
      fs.readFile(params.filePath, "utf8"),
      fs.stat(params.filePath),
    ]);
  } catch {
    return undefined;
  }
  const hits = params.needles.filter((needle) => raw.includes(needle));
  if (hits.length === 0) {
    return undefined;
  }
  const trajectoryPath = params.filePath.endsWith(".trajectory.jsonl")
    ? params.filePath
    : params.filePath.replace(/\.jsonl$/, ".trajectory.jsonl");
  const trajectory = await summarizeTrajectoryFile(trajectoryPath);
  return {
    agentId: params.agentId,
    path: params.filePath,
    bytes: stat.size,
    hits,
    ...(trajectory ? { trajectory } : {}),
  };
}

async function collectFileMatches(params: {
  matches: SessionMatch[];
  needles: string[];
}): Promise<FileMatch[]> {
  const candidates = new Map<string, { agentId: string; filePath: string }>();
  for (const match of params.matches) {
    if (!match.sessionFile) {
      continue;
    }
    candidates.set(match.sessionFile, { agentId: match.agentId, filePath: match.sessionFile });
    const trajectoryPath = match.sessionFile.replace(/\.jsonl$/, ".trajectory.jsonl");
    candidates.set(trajectoryPath, { agentId: match.agentId, filePath: trajectoryPath });
    const pointerPath = match.sessionFile.replace(/\.jsonl$/, ".trajectory-path.json");
    candidates.set(pointerPath, { agentId: match.agentId, filePath: pointerPath });
  }
  const scanned = await Promise.all(
    [...candidates.values()].map((candidate) =>
      scanFileForNeedles({
        agentId: candidate.agentId,
        filePath: candidate.filePath,
        needles: params.needles,
      }),
    ),
  );
  return scanned.filter((match): match is FileMatch => Boolean(match));
}

function formatTimestamp(raw: number | undefined): string {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return "n/a";
  }
  return `${new Date(raw).toISOString()} (${formatTimeAgo(Date.now() - raw)})`;
}

export function formatChannelsInspectLinkReport(report: InspectLinkReport): string[] {
  const lines = [theme.heading("Inspect Link")];
  lines.push(`Slack: channel=${report.parsed.channelId} message=${report.parsed.messageTs}`);
  lines.push(`Thread: ${report.parsed.threadTs ?? "n/a"}`);
  lines.push(`Account: ${report.accountId}`);
  lines.push(`Ingress: ${report.ingress.verdict} - ${report.ingress.explanation}`);
  if (report.relatedSlackMessages.length > 0) {
    lines.push("");
    lines.push(theme.heading("Related Slack Messages"));
    for (const message of report.relatedSlackMessages) {
      const actor = message.botId ? `bot:${message.botId}` : (message.user ?? "unknown");
      lines.push(`- ${message.role} ${message.ts} ${actor}`);
      if (message.textPreview) {
        lines.push(`  ${message.textPreview}`);
      }
    }
  }
  lines.push("");
  lines.push(theme.heading("Session Matches"));
  if (report.sessionScan.sessionMatches.length === 0) {
    lines.push("No likely session-store entries found.");
  } else {
    for (const match of report.sessionScan.sessionMatches.slice(0, 8)) {
      lines.push(`- score=${match.score} agent=${match.agentId} key=${match.sessionKey}`);
      lines.push(`  updated=${formatTimestamp(match.updatedAt)}`);
      if (match.sessionFile) {
        lines.push(`  file=${path.relative(process.cwd(), match.sessionFile)}`);
      }
      lines.push(`  reasons=${match.reasons.join("; ")}`);
    }
  }
  lines.push("");
  lines.push(theme.heading("File Matches"));
  if (report.sessionScan.fileMatches.length === 0) {
    lines.push("No matching transcript or trajectory sidecars found for likely sessions.");
  } else {
    for (const match of report.sessionScan.fileMatches.slice(0, 8)) {
      lines.push(`- agent=${match.agentId} file=${path.relative(process.cwd(), match.path)}`);
      lines.push(`  hits=${match.hits.join(", ")} bytes=${match.bytes}`);
      const incomplete = match.trajectory?.incompleteRuns ?? [];
      if (incomplete.length > 0) {
        lines.push(
          `  incomplete trajectory runs=${incomplete
            .map((run) => `${run.runId}${run.startedAt ? ` started=${run.startedAt}` : ""}`)
            .join(", ")}`,
        );
      }
    }
  }
  return lines;
}

async function readSlackMessagesViaGateway(params: {
  parsed: ParsedSlackPermalink;
  accountId: string;
  timeoutMs: number;
  messageId?: string;
  before?: string;
  limit?: number;
  threadId?: string;
}): Promise<MessageLike[]> {
  const actionPayload = await callGateway({
    method: "message.action",
    params: {
      channel: "slack",
      action: "read",
      accountId: params.accountId,
      params: {
        to: params.parsed.target,
        accountId: params.accountId,
        ...(params.limit ? { limit: params.limit } : {}),
        ...(params.messageId ? { messageId: params.messageId } : {}),
        ...(params.before ? { before: params.before } : {}),
        ...(params.threadId ? { threadId: params.threadId } : {}),
      },
      idempotencyKey: `channels-inspect-link:${randomUUID()}`,
    },
    timeoutMs: params.timeoutMs,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  });
  return extractReadMessages(actionPayload);
}

export async function channelsInspectLinkCommand(
  permalink: string,
  opts: ChannelsInspectLinkOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const parsed = parseSlackPermalink(permalink);
  const accountId = normalizeOptionalString(opts.account) ?? "default";
  const timeoutMs = parsePositiveInteger(opts.timeout, 10_000);
  const limit = parsePositiveInteger(opts.limit, 10);
  const statusPayload = await callGateway({
    method: "channels.status",
    params: { probe: false, timeoutMs },
    timeoutMs,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  });
  const exactMessages = await readSlackMessagesViaGateway({
    parsed,
    accountId,
    timeoutMs,
    messageId: parsed.messageTs,
    ...(parsed.threadTs && parsed.threadTs !== parsed.messageTs
      ? { threadId: parsed.threadTs }
      : {}),
  });
  const nearbyMessages = await readSlackMessagesViaGateway({
    parsed,
    accountId,
    timeoutMs,
    before: parsed.messageTs,
    limit,
  });
  const messages = [...exactMessages, ...nearbyMessages];
  const account = getAccountsForChannel(statusPayload, "slack").find(
    (candidate) => candidate.accountId === accountId,
  );
  const linkedMessage = messages.find((message) => message.ts === parsed.messageTs);
  const ingress = buildInspectLinkIngressReport({
    accountId,
    target: parsed.target,
    account,
    linkedMessage,
  });
  const relatedSlackMessages = buildRelatedSlackMessages({ parsed, messages });
  const cfg = getRuntimeConfig();
  const targets = resolveSessionStoreTargetsOrExit({
    cfg,
    opts: opts.agent ? { agent: opts.agent } : { allAgents: true },
    runtime,
  });
  if (!targets) {
    return;
  }
  const stores = targets.map((target) => ({
    agentId: target.agentId,
    storePath: target.storePath,
    store: loadSessionStore(target.storePath),
  }));
  const sessionMatches = buildSessionMatches({
    targets: stores,
    parsed,
    accountId,
    relatedSlackMessages,
  });
  const needles = stringValues([
    parsed.messageTs,
    parsed.threadTs,
    ...relatedSlackMessages.map((message) => message.ts),
  ]);
  const fileMatches = await collectFileMatches({ matches: sessionMatches.slice(0, 20), needles });
  const report: InspectLinkReport = {
    ok: true,
    channel: "slack",
    accountId,
    parsed,
    relatedSlackMessages,
    ingress,
    sessionScan: {
      storesScanned: targets.map((target) => ({
        agentId: target.agentId,
        storePath: target.storePath,
      })),
      sessionMatches,
      fileMatches,
    },
  };
  if (opts.json) {
    writeRuntimeJson(runtime, report);
    return;
  }
  runtime.log(formatChannelsInspectLinkReport(report).join("\n"));
}
