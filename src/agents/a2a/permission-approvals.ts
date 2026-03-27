import crypto from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "../../infra/json-files.js";
import type { SessionAccessPermissionRequest } from "../tools/sessions-access.js";

export type PendingA2AApprovalState = "pending" | "approved" | "denied" | "expired" | "obsolete";
export type PendingA2AApprovalToolName = "sessions_send" | "sessions_history" | "session_status";
export type PendingA2AApprovalDecision = "approve" | "deny" | "obsolete";

export type PendingA2AApproval = {
  approvalId: string;
  state: PendingA2AApprovalState;
  createdAt: number;
  expiresAt: number;
  sessionKey?: string;
  threadId?: string;
  requesterAgentId: string;
  targetAgentId: string;
  action: SessionAccessPermissionRequest["action"];
  permissionRequest: SessionAccessPermissionRequest;
  originalToolName: PendingA2AApprovalToolName;
  originalArgs: Record<string, unknown>;
  requesterMessageId?: string;
  approvedBy?: string;
  approvedAt?: number;
  deniedBy?: string;
  deniedAt?: number;
  expiredAt?: number;
  obsoleteBy?: string;
  obsoleteAt?: number;
  obsoleteReason?: string;
  resolvedAt?: number;
};

export type PendingA2AApprovalReference = {
  approvalId: string;
  state: PendingA2AApprovalState;
  expiresAt: number;
};

export type CreatePendingA2AApprovalParams = {
  permissionRequest: SessionAccessPermissionRequest;
  originalToolName: PendingA2AApprovalToolName;
  originalArgs: Record<string, unknown>;
  sessionKey?: string;
  threadId?: string;
  requesterMessageId?: string;
  approvalId?: string;
  ttlMs?: number;
  nowMs?: number;
  baseDir?: string;
};

export type ResolvePendingA2AApprovalParams = {
  approvalId: string;
  decision: PendingA2AApprovalDecision;
  actorId?: string;
  reason?: string;
  nowMs?: number;
  baseDir?: string;
};

export type ResolvePendingA2AApprovalResult =
  | { status: "resolved"; record: PendingA2AApproval }
  | { status: "already-resolved"; record: PendingA2AApproval }
  | { status: "expired"; record: PendingA2AApproval }
  | { status: "not-found" };

type PendingA2AApprovalStore = {
  version: 1;
  approvals: Record<string, PendingA2AApproval>;
};

export const DEFAULT_PENDING_A2A_APPROVAL_TTL_MS = 15 * 60 * 1000;

const PENDING_A2A_APPROVALS_FILE = path.join("a2a", "pending-approvals.json");
const withStoreLock = createAsyncLock();

function createEmptyStore(): PendingA2AApprovalStore {
  return {
    version: 1,
    approvals: {},
  };
}

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeThreadId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return normalizeTrimmedString(value);
}

function expireRecord(record: PendingA2AApproval, nowMs: number): PendingA2AApproval {
  return {
    ...record,
    state: "expired",
    expiredAt: record.expiredAt ?? nowMs,
    resolvedAt: record.resolvedAt ?? nowMs,
  };
}

function normalizeStore(
  raw: unknown,
  nowMs: number,
): {
  store: PendingA2AApprovalStore;
  changed: boolean;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { store: createEmptyStore(), changed: raw != null };
  }
  const typed = raw as {
    version?: unknown;
    approvals?: unknown;
  };
  const store: PendingA2AApprovalStore = {
    version: 1,
    approvals:
      typed.version === 1 &&
      typed.approvals &&
      typeof typed.approvals === "object" &&
      !Array.isArray(typed.approvals)
        ? { ...(typed.approvals as Record<string, PendingA2AApproval>) }
        : {},
  };
  let changed =
    typed.version !== 1 ||
    !typed.approvals ||
    typeof typed.approvals !== "object" ||
    Array.isArray(typed.approvals);

  for (const [approvalId, rawRecord] of Object.entries(store.approvals)) {
    if (!rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord)) {
      delete store.approvals[approvalId];
      changed = true;
      continue;
    }
    const record = rawRecord;
    const normalizedApprovalId = normalizeTrimmedString(record.approvalId) ?? approvalId;
    if (normalizedApprovalId !== approvalId) {
      delete store.approvals[approvalId];
      store.approvals[normalizedApprovalId] = {
        ...record,
        approvalId: normalizedApprovalId,
      };
      changed = true;
      continue;
    }
    if (record.state === "pending" && record.expiresAt <= nowMs) {
      store.approvals[approvalId] = expireRecord(record, nowMs);
      changed = true;
    }
  }

  return { store, changed };
}

async function loadStore(params?: {
  baseDir?: string;
  nowMs?: number;
  expirePending?: boolean;
}): Promise<{ storePath: string; store: PendingA2AApprovalStore }> {
  const storePath = resolvePendingA2AApprovalStorePath(params?.baseDir);
  const nowMs = params?.nowMs ?? Date.now();
  const raw = await readJsonFile<unknown>(storePath);
  const { store, changed } = normalizeStore(
    raw,
    params?.expirePending === false ? Number.NEGATIVE_INFINITY : nowMs,
  );
  if (changed) {
    await writeJsonAtomic(storePath, store, { trailingNewline: true });
  }
  return { storePath, store };
}

async function saveStore(storePath: string, store: PendingA2AApprovalStore): Promise<void> {
  await writeJsonAtomic(storePath, store, { trailingNewline: true });
}

function toResolvedRecord(params: {
  record: PendingA2AApproval;
  decision: PendingA2AApprovalDecision;
  actorId?: string;
  reason?: string;
  nowMs: number;
}): PendingA2AApproval {
  const actorId = normalizeTrimmedString(params.actorId);
  if (params.decision === "approve") {
    return {
      ...params.record,
      state: "approved",
      approvedBy: actorId,
      approvedAt: params.nowMs,
      resolvedAt: params.nowMs,
    };
  }
  if (params.decision === "deny") {
    return {
      ...params.record,
      state: "denied",
      deniedBy: actorId,
      deniedAt: params.nowMs,
      resolvedAt: params.nowMs,
    };
  }
  return {
    ...params.record,
    state: "obsolete",
    obsoleteBy: actorId,
    obsoleteAt: params.nowMs,
    obsoleteReason: normalizeTrimmedString(params.reason),
    resolvedAt: params.nowMs,
  };
}

export function resolvePendingA2AApprovalStorePath(baseDir?: string): string {
  return path.join(baseDir ?? resolveStateDir(), PENDING_A2A_APPROVALS_FILE);
}

export function toPendingA2AApprovalReference(
  record: PendingA2AApproval,
): PendingA2AApprovalReference {
  return {
    approvalId: record.approvalId,
    state: record.state,
    expiresAt: record.expiresAt,
  };
}

export async function createPendingA2AApproval(
  params: CreatePendingA2AApprovalParams,
): Promise<PendingA2AApproval> {
  return await withStoreLock(async () => {
    const nowMs = params.nowMs ?? Date.now();
    const { storePath, store } = await loadStore({
      baseDir: params.baseDir,
      nowMs,
    });
    const approvalId = normalizeTrimmedString(params.approvalId) ?? crypto.randomUUID();
    const ttlMs = Math.max(1_000, Math.floor(params.ttlMs ?? DEFAULT_PENDING_A2A_APPROVAL_TTL_MS));
    const permissionRequest = params.permissionRequest;
    const record: PendingA2AApproval = {
      approvalId,
      state: "pending",
      createdAt: nowMs,
      expiresAt: nowMs + ttlMs,
      sessionKey: normalizeTrimmedString(params.sessionKey),
      threadId: normalizeThreadId(params.threadId),
      requesterAgentId: permissionRequest.requesterAgentId,
      targetAgentId: permissionRequest.targetAgentId,
      action: permissionRequest.action,
      permissionRequest,
      originalToolName: params.originalToolName,
      originalArgs: { ...params.originalArgs },
      requesterMessageId: normalizeTrimmedString(params.requesterMessageId),
    };
    store.approvals[approvalId] = record;
    await saveStore(storePath, store);
    return record;
  });
}

export async function getPendingA2AApproval(params: {
  approvalId: string;
  nowMs?: number;
  baseDir?: string;
}): Promise<PendingA2AApproval | null> {
  return await withStoreLock(async () => {
    const approvalId = normalizeTrimmedString(params.approvalId);
    if (!approvalId) {
      return null;
    }
    const { store } = await loadStore({
      baseDir: params.baseDir,
      nowMs: params.nowMs,
    });
    return store.approvals[approvalId] ?? null;
  });
}

export async function expirePendingA2AApprovals(params?: {
  nowMs?: number;
  baseDir?: string;
}): Promise<PendingA2AApproval[]> {
  return await withStoreLock(async () => {
    const nowMs = params?.nowMs ?? Date.now();
    const { storePath, store } = await loadStore({
      baseDir: params?.baseDir,
      nowMs,
      expirePending: false,
    });
    const expired: PendingA2AApproval[] = [];
    let changed = false;
    for (const [approvalId, record] of Object.entries(store.approvals)) {
      if (record.state !== "pending" || record.expiresAt > nowMs) {
        continue;
      }
      const next = expireRecord(record, nowMs);
      store.approvals[approvalId] = next;
      expired.push(next);
      changed = true;
    }
    if (changed) {
      await saveStore(storePath, store);
    }
    return expired;
  });
}

export async function resolvePendingA2AApproval(
  params: ResolvePendingA2AApprovalParams,
): Promise<ResolvePendingA2AApprovalResult> {
  return await withStoreLock(async () => {
    const approvalId = normalizeTrimmedString(params.approvalId);
    if (!approvalId) {
      return { status: "not-found" };
    }
    const nowMs = params.nowMs ?? Date.now();
    const { storePath, store } = await loadStore({
      baseDir: params.baseDir,
      nowMs,
    });
    const current = store.approvals[approvalId];
    if (!current) {
      return { status: "not-found" };
    }
    if (current.state !== "pending") {
      return {
        status: current.state === "expired" ? "expired" : "already-resolved",
        record: current,
      };
    }
    if (current.expiresAt <= nowMs) {
      const expired = expireRecord(current, nowMs);
      store.approvals[approvalId] = expired;
      await saveStore(storePath, store);
      return { status: "expired", record: expired };
    }
    const resolved = toResolvedRecord({
      record: current,
      decision: params.decision,
      actorId: params.actorId,
      reason: params.reason,
      nowMs,
    });
    store.approvals[approvalId] = resolved;
    await saveStore(storePath, store);
    return { status: "resolved", record: resolved };
  });
}
