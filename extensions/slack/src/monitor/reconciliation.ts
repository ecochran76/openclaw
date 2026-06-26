import type {
  SlackAccountConfig,
  SlackReconciliationConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { hasSlackThreadParticipationWithPersistence } from "../sent-thread-cache.js";
import type { SlackMessageEvent } from "../types.js";
import { readSlackAdmissionRecords, recordSlackAdmission } from "./admission-ledger.js";
import {
  allowListMatches,
  normalizeAllowListLower,
  normalizeSlackSlug,
  resolveSlackAllowListMatch,
} from "./allow-list.js";
import { authorizeSlackBotRoomMessage, resolveSlackEffectiveAllowFrom } from "./auth.js";
import { resolveSlackChannelConfig } from "./channel-config.js";
import type { SlackMonitorContext } from "./context.js";
import { hasSlackInboundMessageDelivery } from "./inbound-delivery-state.js";
import type { SlackMessageHandler } from "./message-handler.js";
import {
  isSlackSubteamMentionForBot,
  normalizeSlackId,
} from "./message-handler/subteam-mentions.js";
import {
  ensureSlackReconciliationChannelState,
  hashSlackReconciliationText,
  readSlackReconciliationState,
  slackReconciliationCandidateKey,
  type SlackReconciliationCandidateRecord,
  type SlackReconciliationCandidateStatus,
  type SlackReconciliationState,
  writeSlackReconciliationState,
} from "./reconciliation-state.js";

type SlackHistoryMessage = SlackMessageEvent & {
  type?: string;
  reply_count?: number;
};

type SlackHistoryResponse = {
  messages?: SlackHistoryMessage[];
  response_metadata?: { next_cursor?: string };
};

type SlackConversationsClient = {
  conversations: {
    history(params: Record<string, unknown>): Promise<SlackHistoryResponse>;
    replies(params: Record<string, unknown>): Promise<SlackHistoryResponse>;
    list?(params: Record<string, unknown>): Promise<{
      channels?: Array<{ id?: string; name?: string; is_archived?: boolean }>;
      response_metadata?: { next_cursor?: string };
    }>;
  };
};

type SlackReconciliationConfigResolved = {
  enabled: boolean;
  intervalMs: number;
  lookbackMs: number;
  maxMessagesPerCycle: number;
  maxThreadRootsPerCycle: number;
  autoRecover: boolean;
};

const ADMISSION_OUTCOME_PRECEDENCE = new Map<string, number>([
  ["accepted", 4],
  ["dropped", 3],
  ["replay-dispatched", 2],
  ["replay-attempted", 1],
  ["replay-failed", 1],
]);
const SLACK_USER_MENTION_RE = /<@([^>|]+)(?:\|[^>]+)?>/g;

export type SlackReconciliationRecentCandidate = Pick<
  SlackReconciliationCandidateRecord,
  "channel" | "ts" | "threadTs" | "user" | "clientMsgId" | "status" | "reason" | "lastSeenAt"
>;

export type SlackReconciliationStatus = {
  enabled: boolean;
  autoRecover: boolean;
  intervalMs: number;
  lookbackMs: number;
  lastScanAt?: number;
  latestCheckpointTs?: string;
  missingCandidates: number;
  recoveredCandidates: number;
  failedCandidates: number;
  lastApiError?: { at: number; code: string; channel?: string };
  recentCandidates?: SlackReconciliationRecentCandidate[];
};

export type SlackHistoryReconciliationController = {
  stop: () => void;
  runOnce: () => Promise<void>;
};

const DEFAULT_RECONCILIATION_INTERVAL_MS = 60_000;
const DEFAULT_RECONCILIATION_LOOKBACK_MS = 10 * 60_000;
const DEFAULT_RECONCILIATION_MAX_MESSAGES = 200;
const DEFAULT_RECONCILIATION_MAX_THREAD_ROOTS = 50;
const RECENT_CANDIDATE_LIMIT = 20;
const MAX_STORED_CANDIDATES = 500;

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function resolveSlackReconciliationConfig(
  config: SlackReconciliationConfig | undefined,
): SlackReconciliationConfigResolved {
  return {
    enabled: config?.enabled === true,
    intervalMs: positiveInteger(config?.intervalMs, DEFAULT_RECONCILIATION_INTERVAL_MS),
    lookbackMs: positiveInteger(config?.lookbackMs, DEFAULT_RECONCILIATION_LOOKBACK_MS),
    maxMessagesPerCycle: positiveInteger(
      config?.maxMessagesPerCycle,
      DEFAULT_RECONCILIATION_MAX_MESSAGES,
    ),
    maxThreadRootsPerCycle: positiveInteger(
      config?.maxThreadRootsPerCycle,
      DEFAULT_RECONCILIATION_MAX_THREAD_ROOTS,
    ),
    autoRecover: config?.autoRecover === true,
  };
}

function parseSlackTsMs(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 1000) : undefined;
}

function formatSlackOldestTs(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(6);
}

function decrementSlackTs(ts: string): string | undefined {
  const parsed = Number(ts);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(0, parsed - 0.000001).toFixed(6)
    : undefined;
}

function isSlackChannelId(value: string): boolean {
  return /^[CDG][A-Z0-9]+$/i.test(value);
}

function normalizeSlackTargetChannel(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "*") {
    return undefined;
  }
  const prefixed = /^(?:channel:|slack:)([CDG][A-Z0-9]+)$/i.exec(trimmed);
  if (prefixed?.[1]) {
    return prefixed[1].toUpperCase();
  }
  return isSlackChannelId(trimmed) ? trimmed.toUpperCase() : undefined;
}

function normalizeSlackTargetChannelName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "*") {
    return undefined;
  }
  const withoutPrefix = trimmed
    .replace(/^(?:channel:|slack:)/i, "")
    .replace(/^#/, "")
    .trim();
  if (!withoutPrefix || isSlackChannelId(withoutPrefix)) {
    return undefined;
  }
  const slug = normalizeSlackSlug(withoutPrefix);
  return slug || withoutPrefix.toLowerCase();
}

function needsBroadSlackChannelEnumeration(ctx: SlackMonitorContext): boolean {
  const keys = Object.keys(ctx.channelsConfig ?? {});
  if (keys.length === 0) {
    return ctx.groupPolicy === "open";
  }
  return keys.some((key) => key === "*");
}

function shouldScanDirectMessages(ctx: SlackMonitorContext): boolean {
  return Boolean(ctx.dmEnabled && ctx.dmPolicy !== "disabled");
}

async function listSlackScanChannels(
  client: SlackConversationsClient,
  types: readonly string[],
  allowedNames?: ReadonlySet<string>,
): Promise<string[]> {
  if (!client.conversations.list) {
    return [];
  }
  const channels = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.conversations.list({
      types: types.join(","),
      exclude_archived: false,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const channel of page.channels ?? []) {
      const channelName = normalizeOptionalString(channel.name);
      const normalizedName = channelName ? normalizeSlackSlug(channelName) : undefined;
      if (
        channel.id &&
        !channel.is_archived &&
        (!allowedNames || (normalizedName ? allowedNames.has(normalizedName) : false))
      ) {
        channels.add(channel.id);
      }
    }
    cursor = normalizeOptionalString(page.response_metadata?.next_cursor);
  } while (cursor);
  return Array.from(channels).sort();
}

async function resolveScanChannels(
  ctx: SlackMonitorContext,
  client: SlackConversationsClient,
): Promise<string[]> {
  const channels = new Set<string>();
  const channelNames = new Set<string>();
  for (const key of Object.keys(ctx.channelsConfig ?? {})) {
    const resolved = normalizeSlackTargetChannel(key);
    if (resolved) {
      if (resolved.startsWith("D") && !shouldScanDirectMessages(ctx)) {
        continue;
      }
      channels.add(resolved);
      continue;
    }
    const channelName = normalizeSlackTargetChannelName(key);
    if (channelName) {
      channelNames.add(channelName);
    }
  }
  const roomTypes =
    needsBroadSlackChannelEnumeration(ctx) || channelNames.size > 0
      ? ["public_channel", "private_channel"]
      : [];
  if (roomTypes.length > 0) {
    const allowedNames =
      !needsBroadSlackChannelEnumeration(ctx) && channelNames.size > 0 ? channelNames : undefined;
    for (const channel of await listSlackScanChannels(client, roomTypes, allowedNames)) {
      channels.add(channel);
    }
  }
  const conversationTypes = [
    ...(shouldScanDirectMessages(ctx) ? ["im"] : []),
    ...(ctx.groupDmEnabled ? ["mpim"] : []),
  ];
  if (conversationTypes.length > 0) {
    for (const channel of await listSlackScanChannels(client, conversationTypes)) {
      channels.add(channel);
    }
  }
  return Array.from(channels).sort();
}

function getSlackApiErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error || "unknown_error");
  }
  const record = error as Record<string, unknown>;
  return (
    normalizeOptionalString(record.code) ??
    normalizeOptionalString(
      record.data && typeof record.data === "object"
        ? (record.data as Record<string, unknown>).error
        : undefined,
    ) ??
    normalizeOptionalString(record.message) ??
    "unknown_error"
  );
}

function admissionKey(channel: string | undefined, ts: string | undefined): string | undefined {
  return channel && ts ? `${channel}:${ts}` : undefined;
}

function isSupportedHistoryMessage(message: SlackHistoryMessage): boolean {
  return (
    (!message.type || message.type === "message") &&
    (!message.subtype ||
      message.subtype === "file_share" ||
      message.subtype === "bot_message" ||
      message.subtype === "thread_broadcast")
  );
}

function isSelfOrBotMessage(ctx: SlackMonitorContext, message: SlackHistoryMessage): boolean {
  return (
    Boolean(normalizeOptionalString(message.bot_id)) ||
    message.subtype === "bot_message" ||
    Boolean(ctx.botUserId && message.user === ctx.botUserId)
  );
}

function textMentionsSlackUser(text: string | undefined, userId: string | undefined): boolean {
  const normalizedUserId = normalizeSlackId(userId);
  if (!text || !normalizedUserId) {
    return false;
  }
  SLACK_USER_MENTION_RE.lastIndex = 0;
  for (const match of text.matchAll(SLACK_USER_MENTION_RE)) {
    if (normalizeSlackId(match[1]) === normalizedUserId) {
      return true;
    }
  }
  return false;
}

async function messageMentionsBot(
  ctx: SlackMonitorContext,
  message: SlackHistoryMessage,
): Promise<boolean> {
  if (textMentionsSlackUser(message.text, ctx.botUserId)) {
    return true;
  }
  return await isSlackSubteamMentionForBot({
    client: ctx.app.client,
    text: message.text,
    botUserId: ctx.botUserId,
    teamId: ctx.teamId,
    log: ctx.runtime.log,
  });
}

function isDirectMessage(message: SlackHistoryMessage): boolean {
  return message.channel_type === "im" || Boolean(message.channel?.startsWith("D"));
}

function isRoomMessage(message: SlackHistoryMessage): boolean {
  return (
    message.channel_type === "channel" ||
    message.channel_type === "group" ||
    Boolean(message.channel?.startsWith("C") || message.channel?.startsWith("G"))
  );
}

async function classifyDmAuthorization(
  ctx: SlackMonitorContext,
  message: SlackHistoryMessage,
): Promise<{ allowed: boolean; reason: string }> {
  if (!ctx.dmEnabled || ctx.dmPolicy === "disabled") {
    return { allowed: false, reason: "dm-disabled" };
  }
  if (!message.user) {
    return { allowed: false, reason: "dm-missing-user" };
  }
  const allowFromLower = await resolveSlackEffectiveAllowFrom(ctx, {
    includePairingStore: true,
  });
  const senderName = ctx.allowNameMatching
    ? (await ctx.resolveUserName(message.user)).name
    : undefined;
  const allowMatch = resolveSlackAllowListMatch({
    allowList: allowFromLower,
    id: message.user,
    name: senderName,
    allowNameMatching: ctx.allowNameMatching,
  });
  return allowMatch.allowed
    ? { allowed: true, reason: "dm-authorized" }
    : { allowed: false, reason: "dm-unauthorized" };
}

async function classifyRoomSenderAuthorization(params: {
  ctx: SlackMonitorContext;
  message: SlackHistoryMessage;
  channelUsers?: Array<string | number>;
  allowBotsMode: "off" | "all" | "mentions";
}): Promise<{ allowed: boolean; reason: string }> {
  const { ctx, message } = params;
  const senderId = message.user ?? message.bot_id;
  if (!senderId) {
    return { allowed: false, reason: "missing-sender" };
  }
  const allowFromLower = await resolveSlackEffectiveAllowFrom(ctx);
  const senderName = ctx.allowNameMatching
    ? (normalizeOptionalString(message.username) ?? (await ctx.resolveUserName(senderId)).name)
    : undefined;
  const channelUsers = normalizeAllowListLower(params.channelUsers).filter(
    (entry) => entry !== "*",
  );
  if (
    channelUsers.length > 0 &&
    !allowListMatches({
      allowList: channelUsers,
      id: senderId,
      name: senderName,
      allowNameMatching: ctx.allowNameMatching,
    })
  ) {
    return { allowed: false, reason: "channel-user-not-allowed" };
  }
  if (
    isSelfOrBotMessage(ctx, message) &&
    params.allowBotsMode !== "off" &&
    !(await authorizeSlackBotRoomMessage({
      ctx,
      channelId: message.channel,
      senderId,
      senderName,
      channelUsers: params.channelUsers,
      allowFromLower,
    }))
  ) {
    return { allowed: false, reason: "bot-room-message-denied" };
  }
  return { allowed: true, reason: "room-authorized" };
}

async function isImplicitThreadReplyRelevant(params: {
  ctx: SlackMonitorContext;
  accountId: string;
  message: SlackHistoryMessage;
}): Promise<boolean> {
  const { ctx, message } = params;
  if (!message.channel || !message.thread_ts || ctx.threadRequireExplicitMention) {
    return false;
  }
  if (message.parent_user_id && ctx.botUserId && message.parent_user_id === ctx.botUserId) {
    return true;
  }
  return await hasSlackThreadParticipationWithPersistence({
    accountId: params.accountId,
    channelId: message.channel,
    threadTs: message.thread_ts,
  });
}

function resolveAllowBotsMode(params: {
  accountAllowBots?: SlackAccountConfig["allowBots"];
  channelAllowBots?: SlackAccountConfig["allowBots"];
  rootAllowBots?: SlackAccountConfig["allowBots"];
}): "off" | "all" | "mentions" {
  const setting =
    params.channelAllowBots ?? params.accountAllowBots ?? params.rootAllowBots ?? false;
  return setting === "mentions" ? "mentions" : setting ? "all" : "off";
}

async function classifySlackHistoryMessage(params: {
  ctx: SlackMonitorContext;
  accountId: string;
  accountAllowBots?: SlackAccountConfig["allowBots"];
  message: SlackHistoryMessage;
  admissionOutcomes: Map<string, string>;
}): Promise<{ status: SlackReconciliationCandidateStatus; reason: string; wasMentioned: boolean }> {
  const { ctx, accountId, message, admissionOutcomes } = params;
  const key = admissionKey(message.channel, message.ts);
  const admissionOutcome = key ? admissionOutcomes.get(key) : undefined;
  const wasMentioned = await messageMentionsBot(ctx, message);
  if (!message.channel || !message.ts) {
    return { status: "dropped", reason: "missing-channel-or-ts", wasMentioned };
  }
  if (
    admissionOutcome === "accepted" ||
    admissionOutcome === "dropped" ||
    admissionOutcome === "replay-dispatched"
  ) {
    return {
      status: "already-recorded",
      reason: `admission-ledger:${admissionOutcome}`,
      wasMentioned,
    };
  }
  if (
    await hasSlackInboundMessageDelivery({
      accountId,
      channelId: message.channel,
      ts: message.ts,
    })
  ) {
    return { status: "already-delivered", reason: "inbound-delivery-state", wasMentioned };
  }
  if (!isSupportedHistoryMessage(message)) {
    return { status: "dropped", reason: "unsupported-message-subtype", wasMentioned };
  }
  if (
    (ctx.botUserId && message.user === ctx.botUserId) ||
    (ctx.botId && message.bot_id === ctx.botId)
  ) {
    return { status: "dropped", reason: "bot-self", wasMentioned };
  }
  const channelInfo = await ctx.resolveChannelName(message.channel);
  if (
    !ctx.isChannelAllowed({
      channelId: message.channel,
      channelName: channelInfo.name,
      channelType: message.channel_type,
    })
  ) {
    return { status: "dropped", reason: "policy-blocked", wasMentioned };
  }
  const channelConfig = resolveSlackChannelConfig({
    channelId: message.channel,
    channelName: channelInfo.name,
    channels: ctx.channelsConfig,
    channelKeys: Object.keys(ctx.channelsConfig ?? {}),
    defaultRequireMention: ctx.defaultRequireMention,
    allowNameMatching: ctx.allowNameMatching,
  });
  const allowBotsMode = resolveAllowBotsMode({
    accountAllowBots: params.accountAllowBots,
    channelAllowBots: channelConfig?.allowBots,
    rootAllowBots: params.ctx.cfg.channels?.slack?.allowBots,
  });
  if (isSelfOrBotMessage(ctx, message)) {
    if (allowBotsMode === "off") {
      return { status: "dropped", reason: "bot-message-disabled", wasMentioned };
    }
    if (allowBotsMode === "mentions" && !wasMentioned && !isDirectMessage(message)) {
      return { status: "dropped", reason: "bot-message-missing-mention", wasMentioned };
    }
  }
  const directMessage = isDirectMessage(message);
  if (directMessage) {
    const dmAuthorization = await classifyDmAuthorization(ctx, message);
    if (!dmAuthorization.allowed) {
      return { status: "dropped", reason: dmAuthorization.reason, wasMentioned };
    }
  }
  if (isRoomMessage(message)) {
    const roomAuthorization = await classifyRoomSenderAuthorization({
      ctx,
      message,
      channelUsers: channelConfig?.users,
      allowBotsMode,
    });
    if (!roomAuthorization.allowed) {
      return { status: "dropped", reason: roomAuthorization.reason, wasMentioned };
    }
  }
  const relevant =
    directMessage ||
    channelConfig?.requireMention === false ||
    wasMentioned ||
    (await isImplicitThreadReplyRelevant({ ctx, accountId, message }));
  if (!relevant) {
    return { status: "dropped", reason: "not-relevant", wasMentioned };
  }
  return { status: "missing-admission", reason: "eligible-missing-admission", wasMentioned };
}

function rememberCandidate(params: {
  state: SlackReconciliationState;
  message: SlackHistoryMessage;
  status: SlackReconciliationCandidateStatus;
  reason: string;
  nowIso: string;
}) {
  const { state, message, status, reason, nowIso } = params;
  if (!message.channel || !message.ts) {
    return;
  }
  const key = slackReconciliationCandidateKey(message.channel, message.ts);
  const previous = state.candidates[key];
  state.candidates[key] = {
    channel: message.channel,
    ts: message.ts,
    status,
    reason,
    firstSeenAt: previous?.firstSeenAt ?? nowIso,
    lastSeenAt: nowIso,
    ...(message.thread_ts ? { threadTs: message.thread_ts } : {}),
    ...(message.user ? { user: message.user } : {}),
    ...(message.client_msg_id ? { clientMsgId: message.client_msg_id } : {}),
    ...hashSlackReconciliationText(message.text),
    ...(status === "replayed" || status === "failed" ? { lastAttemptAt: nowIso } : {}),
  };
}

function incrementChannelCount(
  state: SlackReconciliationState,
  channel: string,
  status: SlackReconciliationCandidateStatus,
) {
  const channelState = ensureSlackReconciliationChannelState(state, channel);
  channelState.counts.scanned += 1;
  if (status === "missing-admission") {
    channelState.counts.missing += 1;
  } else if (status === "dropped") {
    channelState.counts.dropped += 1;
  } else if (status === "replayed") {
    channelState.counts.replayed += 1;
  } else if (status === "failed") {
    channelState.counts.failed += 1;
  } else {
    channelState.counts.skipped += 1;
  }
}

function buildReconciliationStatus(params: {
  accountId: string;
  config: SlackReconciliationConfigResolved;
  state: SlackReconciliationState;
}): SlackReconciliationStatus {
  const { config, state } = params;
  const channelStates = Object.values(state.channels);
  const candidates = Object.values(state.candidates);
  const latestCheckpointTs = channelStates
    .map((entry) => entry.latestProcessedTs)
    .filter((entry): entry is string => Boolean(entry))
    .sort()
    .at(-1);
  const lastScanAtIso = channelStates
    .map((entry) => entry.lastScanAt)
    .filter((entry): entry is string => Boolean(entry))
    .sort()
    .at(-1);
  const apiErrors = Object.entries(state.channels)
    .flatMap(([channel, entry]) => (entry.lastApiError ? [{ ...entry.lastApiError, channel }] : []))
    .sort((a, b) => a.at.localeCompare(b.at));
  const lastApiError = apiErrors.at(-1);
  const recentCandidates = candidates
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, RECENT_CANDIDATE_LIMIT)
    .map((entry) => ({
      channel: entry.channel,
      ts: entry.ts,
      ...(entry.threadTs ? { threadTs: entry.threadTs } : {}),
      ...(entry.user ? { user: entry.user } : {}),
      ...(entry.clientMsgId ? { clientMsgId: entry.clientMsgId } : {}),
      status: entry.status,
      reason: entry.reason,
      lastSeenAt: entry.lastSeenAt,
    }));
  return {
    enabled: config.enabled,
    autoRecover: config.autoRecover,
    intervalMs: config.intervalMs,
    lookbackMs: config.lookbackMs,
    ...(lastScanAtIso ? { lastScanAt: Date.parse(lastScanAtIso) } : {}),
    ...(latestCheckpointTs ? { latestCheckpointTs } : {}),
    missingCandidates: candidates.filter((entry) => entry.status === "missing-admission").length,
    recoveredCandidates: candidates.filter((entry) => entry.status === "replayed").length,
    failedCandidates: candidates.filter((entry) => entry.status === "failed").length,
    ...(lastApiError
      ? {
          lastApiError: {
            at: Date.parse(lastApiError.at),
            code: lastApiError.code,
            channel: lastApiError.channel,
          },
        }
      : {}),
    ...(recentCandidates.length > 0 ? { recentCandidates } : {}),
  };
}

function pruneStoredCandidates(state: SlackReconciliationState) {
  const entries = Object.entries(state.candidates).sort((a, b) =>
    b[1].lastSeenAt.localeCompare(a[1].lastSeenAt),
  );
  for (const [key] of entries.slice(MAX_STORED_CANDIDATES)) {
    delete state.candidates[key];
  }
}

async function collectHistoryMessages(params: {
  client: SlackConversationsClient;
  channel: string;
  oldest: string;
  latest: string;
  maxMessages: number;
  maxThreadRoots: number;
  pendingThreadRoots?: Array<{ ts: string; cursor?: string; source?: "known" }>;
  knownThreadRoots?: readonly string[];
  expandedKnownThreadRoots?: ReadonlySet<string>;
}): Promise<{
  messages: SlackHistoryMessage[];
  exhausted: boolean;
  threadRootsUsed: number;
  backlogLatestTs?: string;
  pendingThreadRoots?: Array<{ ts: string; cursor?: string; source?: "known" }>;
  expandedKnownThreadRoots?: string[];
}> {
  const messages: SlackHistoryMessage[] = [];
  let cursor: string | undefined;
  let threadRoots = 0;
  let exhausted = true;
  let oldestHistoryMessageTs: string | undefined;
  let backlogLatestTs: string | undefined;
  const nextPendingThreadRoots: Array<{ ts: string; cursor?: string; source?: "known" }> = [];
  const expandedKnownThreadRoots = new Set<string>();
  const fetchThreadReplies = async (root: {
    ts: string;
    cursor?: string;
    source?: "known";
  }): Promise<boolean> => {
    let replyCursor: string | undefined = root.cursor;
    do {
      const remaining = params.maxMessages - messages.length;
      if (remaining <= 0) {
        nextPendingThreadRoots.push(root);
        exhausted = false;
        return false;
      }
      const page = await params.client.conversations.replies({
        channel: params.channel,
        ts: root.ts,
        oldest: params.oldest,
        latest: params.latest,
        inclusive: true,
        limit: Math.min(200, remaining),
        ...(replyCursor ? { cursor: replyCursor } : {}),
      });
      for (const message of page.messages ?? []) {
        if (message.ts === root.ts || messages.length >= params.maxMessages) {
          continue;
        }
        messages.push({ ...message, channel: message.channel ?? params.channel });
      }
      replyCursor = normalizeOptionalString(page.response_metadata?.next_cursor);
      if (replyCursor && messages.length >= params.maxMessages) {
        nextPendingThreadRoots.push({
          ts: root.ts,
          cursor: replyCursor,
          ...(root.source === "known" ? { source: root.source } : {}),
        });
        exhausted = false;
        return false;
      }
    } while (replyCursor);
    if (root.source === "known") {
      expandedKnownThreadRoots.add(root.ts);
    }
    return true;
  };

  const pendingThreadRoots = params.pendingThreadRoots ?? [];
  for (const [index, root] of pendingThreadRoots.entries()) {
    if (threadRoots >= params.maxThreadRoots) {
      nextPendingThreadRoots.push(...pendingThreadRoots.slice(index));
      return {
        messages: messages.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? "")),
        exhausted: false,
        threadRootsUsed: threadRoots,
        backlogLatestTs: params.latest,
        pendingThreadRoots: nextPendingThreadRoots,
      };
    }
    threadRoots += 1;
    if (!(await fetchThreadReplies(root))) {
      nextPendingThreadRoots.push(...pendingThreadRoots.slice(index + 1));
      return {
        messages: messages.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? "")),
        exhausted: false,
        threadRootsUsed: threadRoots,
        backlogLatestTs: params.latest,
        pendingThreadRoots: nextPendingThreadRoots,
      };
    }
  }

  do {
    const remaining = params.maxMessages - messages.length;
    if (remaining <= 0) {
      exhausted = false;
      backlogLatestTs = params.latest;
      break;
    }
    const page = await params.client.conversations.history({
      channel: params.channel,
      oldest: params.oldest,
      latest: params.latest,
      inclusive: true,
      limit: Math.min(200, remaining),
      ...(cursor ? { cursor } : {}),
    });
    for (const message of page.messages ?? []) {
      if (messages.length >= params.maxMessages) {
        break;
      }
      messages.push({ ...message, channel: message.channel ?? params.channel });
      if (message.ts && (!oldestHistoryMessageTs || message.ts < oldestHistoryMessageTs)) {
        oldestHistoryMessageTs = message.ts;
      }
    }
    cursor = normalizeOptionalString(page.response_metadata?.next_cursor);
  } while (cursor && messages.length < params.maxMessages);
  if (cursor && messages.length >= params.maxMessages) {
    backlogLatestTs = oldestHistoryMessageTs
      ? decrementSlackTs(oldestHistoryMessageTs)
      : params.latest;
    exhausted = false;
  }

  type ThreadRootEntry = {
    message: SlackHistoryMessage;
    source: "history" | "known";
  };
  const rootMap = new Map<string, ThreadRootEntry>();
  for (const message of messages) {
    if (message.ts && message.reply_count && message.reply_count > 0) {
      rootMap.set(message.ts, { message, source: "history" });
    }
  }
  for (const ts of params.knownThreadRoots ?? []) {
    if (!params.expandedKnownThreadRoots?.has(ts) && !rootMap.has(ts)) {
      rootMap.set(ts, {
        message: {
          type: "message",
          channel: params.channel,
          ts,
          reply_count: 1,
        },
        source: "known",
      });
    }
  }
  const roots = Array.from(rootMap.values()).sort((a, b) =>
    (b.message.ts ?? "").localeCompare(a.message.ts ?? ""),
  );
  for (const [index, root] of roots.entries()) {
    const rootTs = root.message.ts;
    if (!rootTs || threadRoots >= params.maxThreadRoots) {
      for (const pendingRoot of roots.slice(index)) {
        if (pendingRoot.source === "history" && pendingRoot.message.ts) {
          nextPendingThreadRoots.push({ ts: pendingRoot.message.ts });
        }
      }
      if (nextPendingThreadRoots.length > 0) {
        backlogLatestTs = messages[0]?.ts ? decrementSlackTs(messages[0].ts) : params.latest;
        exhausted = false;
      }
      break;
    }
    threadRoots += 1;
    if (
      !(await fetchThreadReplies({
        ts: rootTs,
        source: root.source === "known" ? "known" : undefined,
      }))
    ) {
      backlogLatestTs = params.latest;
      break;
    }
  }
  return {
    messages: messages.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? "")),
    exhausted,
    threadRootsUsed: threadRoots,
    ...(!exhausted
      ? { backlogLatestTs: backlogLatestTs ?? decrementSlackTs(oldestHistoryMessageTs ?? "") }
      : {}),
    ...(nextPendingThreadRoots.length > 0 ? { pendingThreadRoots: nextPendingThreadRoots } : {}),
    ...(expandedKnownThreadRoots.size > 0
      ? { expandedKnownThreadRoots: Array.from(expandedKnownThreadRoots).sort() }
      : {}),
  };
}

export function startSlackHistoryReconciliation(params: {
  ctx: SlackMonitorContext;
  accountId: string;
  config?: SlackReconciliationConfig;
  accountAllowBots?: SlackAccountConfig["allowBots"];
  handleSlackMessage: SlackMessageHandler;
  hasInboundDelivery?: typeof hasSlackInboundMessageDelivery;
  setStatus?: (next: Record<string, unknown>) => void;
  abortSignal?: AbortSignal;
}): SlackHistoryReconciliationController {
  const config = resolveSlackReconciliationConfig(params.config);
  let stopped = !config.enabled;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  const client = params.ctx.app.client as unknown as SlackConversationsClient;

  const publishStatus = (state: SlackReconciliationState) => {
    params.setStatus?.({
      reconciliationStatus: buildReconciliationStatus({
        accountId: params.accountId,
        config,
        state,
      }),
    });
  };

  const runOnce = async () => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      const state = await readSlackReconciliationState({ accountId: params.accountId });
      let channels: string[];
      try {
        channels = await resolveScanChannels(params.ctx, client);
      } catch (error) {
        const nowIso = new Date().toISOString();
        ensureSlackReconciliationChannelState(state, "__discovery").lastApiError = {
          at: nowIso,
          code: getSlackApiErrorCode(error),
        };
        await writeSlackReconciliationState({ accountId: params.accountId, state });
        publishStatus(state);
        params.ctx.runtime.log?.(
          `slack history reconciliation discovery failed for ${params.accountId}: ${getSlackApiErrorCode(error)}`,
        );
        return;
      }
      const admissionRecords = await readSlackAdmissionRecords({
        accountId: params.accountId,
        limit: 10_000,
      });
      const admissionOutcomes = new Map<string, string>();
      for (const record of admissionRecords) {
        const key = admissionKey(record.channel, record.ts);
        const existing = key ? admissionOutcomes.get(key) : undefined;
        const existingRank = ADMISSION_OUTCOME_PRECEDENCE.get(existing ?? "") ?? 0;
        const nextRank = ADMISSION_OUTCOME_PRECEDENCE.get(record.outcome) ?? 0;
        if (key && nextRank >= existingRank) {
          admissionOutcomes.set(key, record.outcome);
        }
      }
      const knownThreadRootsByChannel = new Map<string, Set<string>>();
      for (const record of admissionRecords) {
        if (record.channel && record.threadTs) {
          const roots = knownThreadRootsByChannel.get(record.channel) ?? new Set<string>();
          roots.add(record.threadTs);
          knownThreadRootsByChannel.set(record.channel, roots);
        }
      }
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      let remainingCycleMessages = config.maxMessagesPerCycle;
      let remainingCycleThreadRoots = config.maxThreadRootsPerCycle;
      for (const channel of channels) {
        if (remainingCycleMessages <= 0) {
          break;
        }
        const channelState = ensureSlackReconciliationChannelState(state, channel);
        channelState.lastScanAt = nowIso;
        const checkpointMs = parseSlackTsMs(channelState.latestProcessedTs);
        const oldestMs = checkpointMs
          ? Math.min(nowMs - config.lookbackMs, checkpointMs - config.lookbackMs)
          : nowMs - config.lookbackMs;
        const oldestBound = channelState.backlogOldestTs ?? formatSlackOldestTs(oldestMs);
        const latestBound = channelState.backlogLatestTs ?? formatSlackOldestTs(nowMs);
        const backlogHighWaterTs = channelState.backlogHighWaterTs ?? latestBound;
        try {
          const result = await collectHistoryMessages({
            client,
            channel,
            oldest: oldestBound,
            latest: latestBound,
            maxMessages: remainingCycleMessages,
            maxThreadRoots: remainingCycleThreadRoots,
            pendingThreadRoots: channelState.pendingThreadRoots,
            knownThreadRoots: Array.from(knownThreadRootsByChannel.get(channel) ?? []),
            expandedKnownThreadRoots: new Set(channelState.expandedKnownThreadRoots ?? []),
          });
          const { messages } = result;
          remainingCycleMessages = Math.max(0, remainingCycleMessages - messages.length);
          remainingCycleThreadRoots = Math.max(
            0,
            remainingCycleThreadRoots - result.threadRootsUsed,
          );
          let latestTs = channelState.latestProcessedTs;
          for (const message of messages) {
            const classification = await classifySlackHistoryMessage({
              ctx: params.ctx,
              accountId: params.accountId,
              accountAllowBots: params.accountAllowBots,
              message,
              admissionOutcomes,
            });
            let status = classification.status;
            let reason = classification.reason;
            if (status === "missing-admission" && config.autoRecover) {
              await recordSlackAdmission({
                accountId: params.accountId,
                message,
                source: "history_reconcile",
                outcome: "replay-attempted",
                reason: "history-reconcile",
              });
              try {
                await params.handleSlackMessage(message, {
                  source: "history_reconcile",
                  wasMentioned: classification.wasMentioned,
                });
                if (
                  await (params.hasInboundDelivery ?? hasSlackInboundMessageDelivery)({
                    accountId: params.accountId,
                    channelId: message.channel,
                    ts: message.ts,
                  })
                ) {
                  status = "replayed";
                  reason = "history-reconcile-dispatched";
                  await recordSlackAdmission({
                    accountId: params.accountId,
                    message,
                    source: "history_reconcile",
                    outcome: "replay-dispatched",
                    reason,
                  });
                } else {
                  status = "failed";
                  reason = "history-reconcile-no-delivery-proof";
                  await recordSlackAdmission({
                    accountId: params.accountId,
                    message,
                    source: "history_reconcile",
                    outcome: "replay-failed",
                    reason,
                  });
                }
              } catch (error) {
                status = "failed";
                reason = `history-reconcile-failed:${getSlackApiErrorCode(error)}`;
                await recordSlackAdmission({
                  accountId: params.accountId,
                  message,
                  source: "history_reconcile",
                  outcome: "replay-failed",
                  reason,
                });
              }
            }
            rememberCandidate({ state, message, status, reason, nowIso });
            incrementChannelCount(state, channel, status);
            if (message.ts && (!latestTs || message.ts > latestTs)) {
              latestTs = message.ts;
            }
          }
          if (result.exhausted) {
            channelState.latestProcessedTs =
              latestTs && latestTs > backlogHighWaterTs ? latestTs : backlogHighWaterTs;
            channelState.backlogLatestTs = undefined;
            channelState.backlogHighWaterTs = undefined;
            channelState.backlogOldestTs = undefined;
            channelState.pendingThreadRoots = undefined;
          } else {
            const oldestProcessedTs = messages[0]?.ts;
            channelState.backlogLatestTs = oldestProcessedTs
              ? (result.backlogLatestTs ?? decrementSlackTs(oldestProcessedTs))
              : latestBound;
            channelState.backlogHighWaterTs = backlogHighWaterTs;
            channelState.backlogOldestTs = oldestBound;
            channelState.pendingThreadRoots = result.pendingThreadRoots;
          }
          const knownThreadRoots = knownThreadRootsByChannel.get(channel) ?? new Set<string>();
          if (result.expandedKnownThreadRoots?.length) {
            channelState.expandedKnownThreadRoots = Array.from(
              new Set([
                ...(channelState.expandedKnownThreadRoots ?? []),
                ...result.expandedKnownThreadRoots,
              ]),
            ).sort();
          }
          if (
            result.exhausted &&
            knownThreadRoots.size > 0 &&
            Array.from(knownThreadRoots).every((root) =>
              channelState.expandedKnownThreadRoots?.includes(root),
            )
          ) {
            channelState.expandedKnownThreadRoots = undefined;
          }
          channelState.lastApiError = undefined;
        } catch (error) {
          channelState.lastApiError = {
            at: nowIso,
            code: getSlackApiErrorCode(error),
          };
          params.ctx.runtime.log?.(
            `slack history reconciliation failed for ${params.accountId}/${channel}: ${channelState.lastApiError.code}`,
          );
        }
      }
      pruneStoredCandidates(state);
      await writeSlackReconciliationState({ accountId: params.accountId, state });
      publishStatus(state);
    } finally {
      running = false;
    }
  };

  const schedule = () => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void runOnceAndReschedule();
    }, config.intervalMs);
    timer.unref?.();
  };

  const runOnceAndReschedule = async () => {
    try {
      await runOnce();
    } catch (error) {
      params.ctx.runtime.log?.(
        `slack history reconciliation cycle failed for ${params.accountId}: ${getSlackApiErrorCode(error)}`,
      );
    } finally {
      schedule();
    }
  };

  if (config.enabled) {
    void runOnceAndReschedule();
  }

  const stop = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  params.abortSignal?.addEventListener("abort", stop, { once: true });
  return { stop, runOnce };
}
