import crypto from "node:crypto";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { getOptionalSlackRuntime } from "../runtime.js";
import type { SlackMessageEvent } from "../types.js";

export const SLACK_ADMISSION_LEDGER_NAMESPACE = "admission-ledger";
export const SLACK_ADMISSION_LEDGER_MAX_ENTRIES = 20_000;

type OpenSlackKeyedStore = <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>;

export type SlackAdmissionOutcome =
  | "accepted"
  | "dropped"
  | "replay-attempted"
  | "replay-dispatched"
  | "replay-failed";

export type SlackAdmissionRecord = {
  version: 1;
  recordedAt: string;
  accountId: string;
  channel?: string;
  ts?: string;
  threadTs?: string;
  clientMsgId?: string;
  source?: "message" | "app_mention" | "history_reconcile";
  outcome: SlackAdmissionOutcome;
  reason?: string;
  routeAgentId?: string;
  sessionKey?: string;
  user?: string;
  botId?: string;
  subtype?: string;
  textHash?: string;
  textLength?: number;
};

export type SlackAdmissionLogger = {
  warn?: (obj: Record<string, unknown>, msg: string) => void;
};

export function openSlackAdmissionLedgerStore(
  openKeyedStore: OpenSlackKeyedStore = (options) => {
    const runtime = getOptionalSlackRuntime();
    if (!runtime) {
      throw new Error("Slack runtime not initialized");
    }
    return runtime.state.openKeyedStore(options);
  },
): PluginStateKeyedStore<SlackAdmissionRecord> {
  return openKeyedStore<SlackAdmissionRecord>({
    namespace: SLACK_ADMISSION_LEDGER_NAMESPACE,
    maxEntries: SLACK_ADMISSION_LEDGER_MAX_ENTRIES,
    overflowPolicy: "evict-oldest",
  });
}

export function slackAdmissionRecordKey(record: SlackAdmissionRecord): string {
  const digest = crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex");
  return `${record.accountId}:${digest}`;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeSlackAdmissionRecord(value: unknown): SlackAdmissionRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const recordedAt = typeof record.recordedAt === "string" ? record.recordedAt.trim() : "";
  const accountId = typeof record.accountId === "string" ? record.accountId.trim() : "";
  if (
    record.version !== 1 ||
    !recordedAt ||
    !Number.isFinite(Date.parse(recordedAt)) ||
    !accountId ||
    !["accepted", "dropped", "replay-attempted", "replay-dispatched", "replay-failed"].includes(
      record.outcome as SlackAdmissionOutcome,
    )
  ) {
    return undefined;
  }
  const outcome = record.outcome as SlackAdmissionOutcome;
  const source = ["message", "app_mention", "history_reconcile"].includes(String(record.source))
    ? (record.source as SlackAdmissionRecord["source"])
    : undefined;
  const textLength =
    typeof record.textLength === "number" &&
    Number.isInteger(record.textLength) &&
    record.textLength >= 0
      ? record.textLength
      : undefined;
  return {
    version: 1,
    recordedAt,
    accountId,
    outcome,
    ...(normalizeOptionalString(record.channel)
      ? { channel: normalizeOptionalString(record.channel) }
      : {}),
    ...(normalizeOptionalString(record.ts) ? { ts: normalizeOptionalString(record.ts) } : {}),
    ...(normalizeOptionalString(record.threadTs)
      ? { threadTs: normalizeOptionalString(record.threadTs) }
      : {}),
    ...(normalizeOptionalString(record.clientMsgId)
      ? { clientMsgId: normalizeOptionalString(record.clientMsgId) }
      : {}),
    ...(source ? { source } : {}),
    ...(normalizeOptionalString(record.reason)
      ? { reason: normalizeOptionalString(record.reason) }
      : {}),
    ...(normalizeOptionalString(record.routeAgentId)
      ? { routeAgentId: normalizeOptionalString(record.routeAgentId) }
      : {}),
    ...(normalizeOptionalString(record.sessionKey)
      ? { sessionKey: normalizeOptionalString(record.sessionKey) }
      : {}),
    ...(normalizeOptionalString(record.user) ? { user: normalizeOptionalString(record.user) } : {}),
    ...(normalizeOptionalString(record.botId)
      ? { botId: normalizeOptionalString(record.botId) }
      : {}),
    ...(normalizeOptionalString(record.subtype)
      ? { subtype: normalizeOptionalString(record.subtype) }
      : {}),
    ...(normalizeOptionalString(record.textHash)
      ? { textHash: normalizeOptionalString(record.textHash) }
      : {}),
    ...(textLength !== undefined ? { textLength } : {}),
  };
}

function hashText(text: string | undefined): { textHash?: string; textLength?: number } {
  if (!text) {
    return {};
  }
  return {
    textHash: crypto.createHash("sha256").update(text).digest("hex"),
    textLength: text.length,
  };
}

export function buildSlackAdmissionRecord(params: {
  accountId: string;
  message: SlackMessageEvent;
  source?: "message" | "app_mention" | "history_reconcile";
  outcome: SlackAdmissionOutcome;
  reason?: string;
  routeAgentId?: string;
  sessionKey?: string;
  now?: Date;
}): SlackAdmissionRecord {
  const messageWithClientId = params.message as SlackMessageEvent & { client_msg_id?: string };
  const textFacts = hashText(params.message.text);
  return {
    version: 1,
    recordedAt: (params.now ?? new Date()).toISOString(),
    accountId: params.accountId,
    channel: normalizeOptionalString(params.message.channel),
    ts: normalizeOptionalString(params.message.ts),
    threadTs: normalizeOptionalString(params.message.thread_ts),
    clientMsgId: normalizeOptionalString(messageWithClientId.client_msg_id),
    source: params.source,
    outcome: params.outcome,
    reason: normalizeOptionalString(params.reason),
    routeAgentId: normalizeOptionalString(params.routeAgentId),
    sessionKey: normalizeOptionalString(params.sessionKey),
    user: normalizeOptionalString(params.message.user),
    botId: normalizeOptionalString(params.message.bot_id),
    subtype: normalizeOptionalString(params.message.subtype),
    ...textFacts,
  };
}

export async function appendSlackAdmissionRecord(params: {
  accountId: string;
  record: SlackAdmissionRecord;
  logger?: SlackAdmissionLogger;
  openKeyedStore?: OpenSlackKeyedStore;
}): Promise<boolean> {
  try {
    const store = openSlackAdmissionLedgerStore(params.openKeyedStore);
    // Admission records are assembled from optional Slack fields. Normalize through
    // JSON so absent values stay absent and satisfy the plugin-state JSON contract.
    const storedRecord = JSON.parse(JSON.stringify(params.record)) as SlackAdmissionRecord;
    await store.register(slackAdmissionRecordKey(storedRecord), storedRecord);
    return true;
  } catch (error) {
    params.logger?.warn?.(
      {
        accountId: params.accountId,
        error: error instanceof Error ? error.message : String(error),
      },
      "failed writing slack admission state",
    );
    return false;
  }
}

export async function readSlackAdmissionRecords(params: {
  accountId: string;
  logger?: SlackAdmissionLogger;
  limit?: number;
  openKeyedStore?: OpenSlackKeyedStore;
}): Promise<SlackAdmissionRecord[]> {
  try {
    const entries = await openSlackAdmissionLedgerStore(params.openKeyedStore).entries();
    const records = entries
      .map((entry) => entry.value)
      .map(normalizeSlackAdmissionRecord)
      .filter((record): record is SlackAdmissionRecord => record?.accountId === params.accountId)
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
    return params.limit && Number.isFinite(params.limit) && params.limit > 0
      ? records.slice(-Math.trunc(params.limit))
      : records;
  } catch (error) {
    params.logger?.warn?.(
      {
        accountId: params.accountId,
        error: error instanceof Error ? error.message : String(error),
      },
      "failed reading slack admission state",
    );
    // An empty ledger means no message has been admitted. Preserve read failures
    // so reconciliation cannot mistake an unavailable store for replay eligibility.
    throw error;
  }
}

export function recordSlackAdmission(params: {
  accountId: string;
  message: SlackMessageEvent;
  source?: "message" | "app_mention" | "history_reconcile";
  outcome: SlackAdmissionOutcome;
  reason?: string;
  routeAgentId?: string;
  sessionKey?: string;
  logger?: SlackAdmissionLogger;
  openKeyedStore?: OpenSlackKeyedStore;
}): Promise<boolean> {
  const record = buildSlackAdmissionRecord(params);
  return appendSlackAdmissionRecord({
    accountId: params.accountId,
    record,
    logger: params.logger,
    openKeyedStore: params.openKeyedStore,
  });
}
