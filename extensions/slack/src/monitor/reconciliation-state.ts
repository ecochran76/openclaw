import crypto from "node:crypto";
import path from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

export type SlackReconciliationCandidateStatus =
  | "already-recorded"
  | "already-delivered"
  | "dropped"
  | "missing-admission"
  | "replayed"
  | "failed";

export type SlackReconciliationCandidateRecord = {
  channel: string;
  ts: string;
  threadTs?: string;
  user?: string;
  clientMsgId?: string;
  textHash?: string;
  textLength?: number;
  status: SlackReconciliationCandidateStatus;
  reason: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastAttemptAt?: string;
};

export type SlackReconciliationChannelState = {
  latestProcessedTs?: string;
  backlogLatestTs?: string;
  backlogHighWaterTs?: string;
  backlogOldestTs?: string;
  expandedKnownThreadRoots?: string[];
  pendingThreadRoots?: Array<{
    ts: string;
    cursor?: string;
    source?: "known";
  }>;
  lastScanAt?: string;
  lastApiError?: {
    at: string;
    code: string;
  };
  counts: {
    scanned: number;
    skipped: number;
    missing: number;
    dropped: number;
    replayed: number;
    failed: number;
  };
};

export type SlackReconciliationState = {
  version: 1;
  accountId: string;
  updatedAt?: string;
  channels: Record<string, SlackReconciliationChannelState>;
  candidates: Record<string, SlackReconciliationCandidateRecord>;
};

export function hashSlackReconciliationText(text: string | undefined): {
  textHash?: string;
  textLength?: number;
} {
  if (!text) {
    return {};
  }
  return {
    textHash: crypto.createHash("sha256").update(text).digest("hex"),
    textLength: text.length,
  };
}

function sanitizePathSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_") || "default";
}

export function resolveSlackReconciliationStatePath(params: {
  accountId: string;
  stateDir?: string;
}): string {
  return path.join(
    params.stateDir ?? resolveStateDir(),
    "slack",
    "reconciliation",
    `${sanitizePathSegment(params.accountId)}.json`,
  );
}

function createEmptySlackReconciliationState(accountId: string): SlackReconciliationState {
  return {
    version: 1,
    accountId,
    channels: {},
    candidates: {},
  };
}

function normalizeChannelState(value: unknown): SlackReconciliationChannelState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const counts = record.counts;
  const countRecord =
    counts && typeof counts === "object" && !Array.isArray(counts)
      ? (counts as Record<string, unknown>)
      : {};
  const readCount = (key: string) =>
    typeof countRecord[key] === "number" && Number.isFinite(countRecord[key])
      ? Math.max(0, Math.trunc(countRecord[key] as number))
      : 0;
  const out: SlackReconciliationChannelState = {
    counts: {
      scanned: readCount("scanned"),
      skipped: readCount("skipped"),
      missing: readCount("missing"),
      dropped: readCount("dropped"),
      replayed: readCount("replayed"),
      failed: readCount("failed"),
    },
  };
  if (typeof record.latestProcessedTs === "string" && record.latestProcessedTs.trim()) {
    out.latestProcessedTs = record.latestProcessedTs.trim();
  }
  if (typeof record.backlogLatestTs === "string" && record.backlogLatestTs.trim()) {
    out.backlogLatestTs = record.backlogLatestTs.trim();
  }
  if (typeof record.backlogHighWaterTs === "string" && record.backlogHighWaterTs.trim()) {
    out.backlogHighWaterTs = record.backlogHighWaterTs.trim();
  }
  if (typeof record.backlogOldestTs === "string" && record.backlogOldestTs.trim()) {
    out.backlogOldestTs = record.backlogOldestTs.trim();
  }
  if (Array.isArray(record.pendingThreadRoots)) {
    const pendingThreadRoots = record.pendingThreadRoots
      .map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return undefined;
        }
        const root = entry as Record<string, unknown>;
        if (typeof root.ts !== "string" || !root.ts.trim()) {
          return undefined;
        }
        return {
          ts: root.ts.trim(),
          ...(typeof root.cursor === "string" && root.cursor.trim()
            ? { cursor: root.cursor.trim() }
            : {}),
          ...(root.source === "known" ? { source: "known" as const } : {}),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    if (pendingThreadRoots.length > 0) {
      out.pendingThreadRoots = pendingThreadRoots;
    }
  }
  if (Array.isArray(record.expandedKnownThreadRoots)) {
    const expandedKnownThreadRoots = Array.from(
      new Set(
        record.expandedKnownThreadRoots.filter(
          (entry): entry is string => typeof entry === "string" && Boolean(entry.trim()),
        ),
      ),
    ).sort();
    if (expandedKnownThreadRoots.length > 0) {
      out.expandedKnownThreadRoots = expandedKnownThreadRoots;
    }
  }
  if (typeof record.lastScanAt === "string" && record.lastScanAt.trim()) {
    out.lastScanAt = record.lastScanAt.trim();
  }
  const lastApiError = record.lastApiError;
  if (lastApiError && typeof lastApiError === "object" && !Array.isArray(lastApiError)) {
    const errorRecord = lastApiError as Record<string, unknown>;
    if (typeof errorRecord.at === "string" && typeof errorRecord.code === "string") {
      out.lastApiError = { at: errorRecord.at, code: errorRecord.code };
    }
  }
  return out;
}

function normalizeCandidateRecord(value: unknown): SlackReconciliationCandidateRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.channel !== "string" ||
    typeof record.ts !== "string" ||
    typeof record.status !== "string" ||
    typeof record.reason !== "string" ||
    typeof record.firstSeenAt !== "string" ||
    typeof record.lastSeenAt !== "string"
  ) {
    return undefined;
  }
  if (
    ![
      "already-recorded",
      "already-delivered",
      "dropped",
      "missing-admission",
      "replayed",
      "failed",
    ].includes(record.status)
  ) {
    return undefined;
  }
  return {
    channel: record.channel,
    ts: record.ts,
    status: record.status as SlackReconciliationCandidateStatus,
    reason: record.reason,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
    ...(typeof record.threadTs === "string" && record.threadTs.trim()
      ? { threadTs: record.threadTs.trim() }
      : {}),
    ...(typeof record.user === "string" && record.user.trim() ? { user: record.user.trim() } : {}),
    ...(typeof record.clientMsgId === "string" && record.clientMsgId.trim()
      ? { clientMsgId: record.clientMsgId.trim() }
      : {}),
    ...(typeof record.textHash === "string" && record.textHash.trim()
      ? { textHash: record.textHash.trim() }
      : {}),
    ...(typeof record.textLength === "number" && Number.isFinite(record.textLength)
      ? { textLength: Math.max(0, Math.trunc(record.textLength)) }
      : {}),
    ...(typeof record.lastAttemptAt === "string" && record.lastAttemptAt.trim()
      ? { lastAttemptAt: record.lastAttemptAt.trim() }
      : {}),
  };
}

export async function readSlackReconciliationState(params: {
  accountId: string;
  stateDir?: string;
}): Promise<SlackReconciliationState> {
  const filePath = resolveSlackReconciliationStatePath(params);
  const { value } = await readJsonFileWithFallback<Partial<SlackReconciliationState>>(filePath, {});
  if (value.version !== 1 || value.accountId !== params.accountId) {
    return createEmptySlackReconciliationState(params.accountId);
  }
  const state = createEmptySlackReconciliationState(params.accountId);
  if (typeof value.updatedAt === "string") {
    state.updatedAt = value.updatedAt;
  }
  if (value.channels && typeof value.channels === "object" && !Array.isArray(value.channels)) {
    for (const [channel, raw] of Object.entries(value.channels)) {
      const normalized = normalizeChannelState(raw);
      if (normalized) {
        state.channels[channel] = normalized;
      }
    }
  }
  if (
    value.candidates &&
    typeof value.candidates === "object" &&
    !Array.isArray(value.candidates)
  ) {
    for (const [key, raw] of Object.entries(value.candidates)) {
      const normalized = normalizeCandidateRecord(raw);
      if (normalized) {
        state.candidates[key] = normalized;
      }
    }
  }
  return state;
}

export async function writeSlackReconciliationState(params: {
  accountId: string;
  state: SlackReconciliationState;
  stateDir?: string;
}): Promise<void> {
  const filePath = resolveSlackReconciliationStatePath(params);
  await writeJsonFileAtomically(filePath, {
    ...params.state,
    version: 1,
    accountId: params.accountId,
    updatedAt: new Date().toISOString(),
  });
}

export function slackReconciliationCandidateKey(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}

export function ensureSlackReconciliationChannelState(
  state: SlackReconciliationState,
  channel: string,
): SlackReconciliationChannelState {
  state.channels[channel] ??= {
    counts: {
      scanned: 0,
      skipped: 0,
      missing: 0,
      dropped: 0,
      replayed: 0,
      failed: 0,
    },
  };
  return state.channels[channel];
}
