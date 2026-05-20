import type { SlackMessageSummary } from "../actions.js";
import type { SlackAdmissionRecord } from "./admission-ledger.js";

export type SlackWatchdogVerdict =
  | "admitted"
  | "explicitly-ignored"
  | "not-relevant"
  | "missing-admission";

export type SlackWatchdogScanMessage = SlackMessageSummary & {
  channel?: string;
  client_msg_id?: string;
  bot_id?: string;
  subtype?: string;
};

export type SlackWatchdogScanRecord = {
  accountId: string;
  channel: string;
  ts?: string;
  threadTs?: string;
  clientMsgId?: string;
  verdict: SlackWatchdogVerdict;
  reason: string;
  ledgerRecord?: Pick<
    SlackAdmissionRecord,
    "recordedAt" | "outcome" | "reason" | "routeAgentId" | "sessionKey"
  >;
};

export type SlackWatchdogScanReport = {
  accountId: string;
  channel: string;
  scanned: number;
  counts: Record<SlackWatchdogVerdict, number>;
  records: SlackWatchdogScanRecord[];
};

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isBotMessage(message: SlackWatchdogScanMessage): boolean {
  return Boolean(normalizeOptionalString(message.bot_id)) || message.subtype === "bot_message";
}

function messageContainsBotMention(
  message: SlackWatchdogScanMessage,
  botUserIds: readonly string[],
): boolean {
  const text = message.text ?? "";
  return botUserIds.some((botUserId) => text.includes(`<@${botUserId}>`));
}

function isAllowedSender(
  message: SlackWatchdogScanMessage,
  allowedUserIds: readonly string[] | undefined,
): boolean {
  if (!allowedUserIds) {
    return true;
  }
  const user = normalizeOptionalString(message.user);
  return Boolean(user && allowedUserIds.includes(user));
}

function messageKey(message: SlackWatchdogScanMessage, channel: string): string {
  const ts = normalizeOptionalString(message.ts) ?? "";
  const clientMsgId = normalizeOptionalString(message.client_msg_id) ?? "";
  return `${channel}\0${ts}\0${clientMsgId}`;
}

function ledgerKey(record: SlackAdmissionRecord): string {
  const channel = normalizeOptionalString(record.channel) ?? "";
  const ts = normalizeOptionalString(record.ts) ?? "";
  const clientMsgId = normalizeOptionalString(record.clientMsgId) ?? "";
  return `${channel}\0${ts}\0${clientMsgId}`;
}

function buildLedgerIndex(records: readonly SlackAdmissionRecord[]) {
  const index = new Map<string, SlackAdmissionRecord>();
  for (const record of records) {
    if (!record.channel || !record.ts) {
      continue;
    }
    index.set(ledgerKey(record), record);
    index.set(`${record.channel}\0${record.ts}\0`, record);
  }
  return index;
}

function summarizeLedgerRecord(
  record: SlackAdmissionRecord,
): SlackWatchdogScanRecord["ledgerRecord"] {
  return {
    recordedAt: record.recordedAt,
    outcome: record.outcome,
    ...(record.reason ? { reason: record.reason } : {}),
    ...(record.routeAgentId ? { routeAgentId: record.routeAgentId } : {}),
    ...(record.sessionKey ? { sessionKey: record.sessionKey } : {}),
  };
}

export function scanSlackAdmissionGaps(params: {
  accountId: string;
  channel: string;
  messages: readonly SlackWatchdogScanMessage[];
  ledgerRecords: readonly SlackAdmissionRecord[];
  botUserIds?: readonly string[];
  directMessage?: boolean;
  activeThreadTs?: readonly string[];
  channelRequiresMention?: boolean;
  allowedUserIds?: readonly string[];
}): SlackWatchdogScanReport {
  const botUserIds = params.botUserIds ?? [];
  const activeThreadTs = new Set(params.activeThreadTs ?? []);
  const ledger = buildLedgerIndex(
    params.ledgerRecords.filter((record) => record.accountId === params.accountId),
  );
  const records: SlackWatchdogScanRecord[] = [];
  const counts: Record<SlackWatchdogVerdict, number> = {
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
