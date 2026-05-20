import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SlackMessageEvent } from "../types.js";

export type SlackAdmissionOutcome = "accepted" | "dropped";

export type SlackAdmissionRecord = {
  version: 1;
  recordedAt: string;
  accountId: string;
  channel?: string;
  ts?: string;
  threadTs?: string;
  clientMsgId?: string;
  source?: "message" | "app_mention";
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

export function resolveSlackAdmissionLedgerPath(params: {
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

function shouldSkipImplicitTestWrite(env: NodeJS.ProcessEnv | undefined): boolean {
  const effectiveEnv = env ?? process.env;
  return (
    !env &&
    Boolean(effectiveEnv.VITEST) &&
    !effectiveEnv.OPENCLAW_STATE_DIR &&
    effectiveEnv.OPENCLAW_SLACK_ADMISSION_LEDGER_TEST_WRITE !== "1"
  );
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
  source?: "message" | "app_mention";
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
  env?: NodeJS.ProcessEnv;
  logger?: SlackAdmissionLogger;
}): Promise<boolean> {
  const ledgerPath = resolveSlackAdmissionLedgerPath({
    accountId: params.accountId,
    env: params.env,
  });
  try {
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
    await fs.appendFile(ledgerPath, `${JSON.stringify(params.record)}\n`, "utf8");
    return true;
  } catch (error) {
    params.logger?.warn?.(
      {
        accountId: params.accountId,
        path: ledgerPath,
        error: error instanceof Error ? error.message : String(error),
      },
      "failed writing slack admission ledger",
    );
    return false;
  }
}

export async function readSlackAdmissionRecords(params: {
  accountId: string;
  env?: NodeJS.ProcessEnv;
  logger?: SlackAdmissionLogger;
  limit?: number;
}): Promise<SlackAdmissionRecord[]> {
  const ledgerPath = resolveSlackAdmissionLedgerPath({
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
    params.logger?.warn?.(
      {
        accountId: params.accountId,
        path: ledgerPath,
        error: error instanceof Error ? error.message : String(error),
      },
      "failed reading slack admission ledger",
    );
    return [];
  }

  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const selected =
    params.limit && Number.isFinite(params.limit) && params.limit > 0
      ? lines.slice(-Math.trunc(params.limit))
      : lines;
  const records: SlackAdmissionRecord[] = [];
  for (const line of selected) {
    try {
      const parsed = JSON.parse(line) as Partial<SlackAdmissionRecord>;
      if (parsed.version === 1 && parsed.accountId === params.accountId) {
        records.push(parsed as SlackAdmissionRecord);
      }
    } catch {
      params.logger?.warn?.(
        { accountId: params.accountId, path: ledgerPath },
        "ignored malformed slack admission ledger row",
      );
    }
  }
  return records;
}

export function recordSlackAdmission(params: {
  accountId: string;
  message: SlackMessageEvent;
  source?: "message" | "app_mention";
  outcome: SlackAdmissionOutcome;
  reason?: string;
  routeAgentId?: string;
  sessionKey?: string;
  env?: NodeJS.ProcessEnv;
  logger?: SlackAdmissionLogger;
}): Promise<boolean> {
  if (shouldSkipImplicitTestWrite(params.env)) {
    return Promise.resolve(true);
  }
  const record = buildSlackAdmissionRecord(params);
  return appendSlackAdmissionRecord({
    accountId: params.accountId,
    record,
    env: params.env,
    logger: params.logger,
  });
}
