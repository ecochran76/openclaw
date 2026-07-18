import crypto from "node:crypto";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import type { SessionAccessPermissionRequest } from "../tools/sessions-access.js";

export type PendingA2AApprovalState =
  | "pending"
  | "applying"
  | "approved"
  | "denied"
  | "expired"
  | "obsolete";
export type PendingA2AApprovalToolName =
  | "sessions_list"
  | "sessions_send"
  | "sessions_history"
  | "session_status";
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
  claimId?: string;
  applyingBy?: string;
  applyingAt?: number;
  commitAuthorizedAt?: number;
  commitAuthorizationExpiresAt?: number;
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
  | { status: "authorization-required"; record: PendingA2AApproval }
  | { status: "not-found" };

export type ClaimPendingA2AApprovalResult =
  | { status: "claimed"; record: PendingA2AApproval; claimId: string }
  | { status: "already-resolved"; record: PendingA2AApproval }
  | { status: "expired"; record: PendingA2AApproval }
  | { status: "not-found" };

export type AuthorizePendingA2AApprovalClaimResult =
  | {
      status: "authorized";
      record: PendingA2AApproval;
      commitAuthorization: PendingA2AApprovalCommitAuthorization;
    }
  | { status: "already-resolved"; record: PendingA2AApproval }
  | { status: "expired"; record: PendingA2AApproval }
  | { status: "not-found" };

export type FinishPendingA2AApprovalClaimResult =
  | ResolvePendingA2AApprovalResult
  | { status: "authorization-required"; record: PendingA2AApproval };

export type PendingA2AApprovalCommitAuthorization = {
  claimId: string;
  authorizedAt: number;
};

export const DEFAULT_PENDING_A2A_APPROVAL_TTL_MS = 15 * 60 * 1000;
// Duplicate Slack clicks still need a terminal answer briefly, but replay payloads are runtime
// state rather than an audit log. Prune them one hour after the original approval expires.
export const A2A_APPROVAL_RETENTION_AFTER_EXPIRY_MS = 60 * 60 * 1000;
// Config planning normally reaches its commit preflight quickly. Bound the earlier claim too,
// so a process crash before authorization cannot pin a still-valid approval until its full TTL.
export const A2A_APPROVAL_CLAIM_LEASE_MS = 5 * 60 * 1000;
// A config write normally finishes in milliseconds. This lease protects a genuinely in-flight
// write while letting another process recover an authorization abandoned by a crashed writer.
export const A2A_APPROVAL_COMMIT_AUTHORIZATION_LEASE_MS = 5 * 60 * 1000;
const A2A_APPROVAL_PRUNE_BATCH_SIZE = 100;

type A2APermissionApprovalDatabase = Pick<OpenClawStateKyselyDatabase, "a2a_permission_approvals">;
type A2APermissionApprovalRow = Selectable<OpenClawStateKyselyDatabase["a2a_permission_approvals"]>;

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
  return redactTerminalRecord({
    ...record,
    state: "expired",
    expiredAt: record.expiredAt ?? nowMs,
    resolvedAt: record.resolvedAt ?? nowMs,
  });
}

function resolveDatabaseOptions(baseDir?: string): OpenClawStateDatabaseOptions {
  return baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } } : {};
}

function getApprovalDatabase(database: OpenClawStateDatabase) {
  return getNodeSqliteKysely<A2APermissionApprovalDatabase>(database.db);
}

function decodeApprovalRow(row: A2APermissionApprovalRow): PendingA2AApproval {
  const record = JSON.parse(row.record_json) as PendingA2AApproval;
  if (
    !record ||
    typeof record !== "object" ||
    record.approvalId !== row.approval_id ||
    record.state !== row.state ||
    record.expiresAt !== row.expires_at_ms
  ) {
    throw new Error(`A2A permission approval '${row.approval_id}' has inconsistent state`);
  }
  return record;
}

function selectApprovalRow(
  database: OpenClawStateDatabase,
  approvalId: string,
): A2APermissionApprovalRow | undefined {
  const db = getApprovalDatabase(database);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("a2a_permission_approvals").selectAll().where("approval_id", "=", approvalId),
  );
}

function writeApproval(
  database: OpenClawStateDatabase,
  record: PendingA2AApproval,
  updatedAtMs: number,
): void {
  const db = getApprovalDatabase(database);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("a2a_permission_approvals")
      .values({
        approval_id: record.approvalId,
        state: record.state,
        record_json: JSON.stringify(record),
        expires_at_ms: record.expiresAt,
        updated_at_ms: updatedAtMs,
      })
      .onConflict((conflict) =>
        conflict.column("approval_id").doUpdateSet({
          state: record.state,
          record_json: JSON.stringify(record),
          expires_at_ms: record.expiresAt,
          updated_at_ms: updatedAtMs,
        }),
      ),
  );
}

function redactTerminalRecord(record: PendingA2AApproval): PendingA2AApproval {
  const redacted: PendingA2AApproval = {
    ...record,
    permissionRequest: {
      kind: "config_permission_request",
      reason: record.permissionRequest.reason,
      action: record.action,
      requesterAgentId: record.requesterAgentId,
      targetAgentId: record.targetAgentId,
      retryable: true,
      askUser: "",
      suggestedChanges: [],
    },
    originalArgs: {},
  };
  delete redacted.sessionKey;
  delete redacted.threadId;
  delete redacted.requesterMessageId;
  delete redacted.claimId;
  delete redacted.applyingBy;
  delete redacted.applyingAt;
  delete redacted.commitAuthorizedAt;
  delete redacted.commitAuthorizationExpiresAt;
  return redacted;
}

function pruneRetainedApprovals(database: OpenClawStateDatabase, nowMs: number): void {
  const cutoffMs = nowMs - A2A_APPROVAL_RETENTION_AFTER_EXPIRY_MS;
  const db = getApprovalDatabase(database);
  const approvalIds = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("a2a_permission_approvals")
      .select("approval_id")
      .where("expires_at_ms", "<=", cutoffMs)
      .orderBy("expires_at_ms", "asc")
      .orderBy("approval_id", "asc")
      .limit(A2A_APPROVAL_PRUNE_BATCH_SIZE),
  ).rows.map((row) => row.approval_id);
  if (approvalIds.length === 0) {
    return;
  }
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("a2a_permission_approvals").where("approval_id", "in", approvalIds),
  );
}

function expireApprovalIfDue(params: {
  database: OpenClawStateDatabase;
  row: A2APermissionApprovalRow;
  nowMs: number;
}): PendingA2AApproval {
  const current = decodeApprovalRow(params.row);
  if (current.state === "applying") {
    const claimExpiresAt =
      current.commitAuthorizedAt === undefined
        ? Math.min(
            current.expiresAt,
            (current.applyingAt ?? current.createdAt) + A2A_APPROVAL_CLAIM_LEASE_MS,
          )
        : Math.min(
            current.expiresAt,
            current.commitAuthorizationExpiresAt ??
              current.commitAuthorizedAt + A2A_APPROVAL_COMMIT_AUTHORIZATION_LEASE_MS,
          );
    if (claimExpiresAt > params.nowMs) {
      return current;
    }
    const recovered: PendingA2AApproval = { ...current, state: "pending" };
    delete recovered.claimId;
    delete recovered.applyingBy;
    delete recovered.applyingAt;
    delete recovered.commitAuthorizedAt;
    delete recovered.commitAuthorizationExpiresAt;
    if (recovered.expiresAt > params.nowMs) {
      writeApproval(params.database, recovered, params.nowMs);
      return recovered;
    }
    const expired = expireRecord(recovered, params.nowMs);
    writeApproval(params.database, expired, params.nowMs);
    return expired;
  }
  if (current.state !== "pending" || current.expiresAt > params.nowMs) {
    return current;
  }
  const expired = expireRecord(current, params.nowMs);
  writeApproval(params.database, expired, params.nowMs);
  return expired;
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
    return redactTerminalRecord({
      ...params.record,
      state: "approved",
      approvedBy: actorId,
      approvedAt: params.nowMs,
      resolvedAt: params.nowMs,
    });
  }
  if (params.decision === "deny") {
    return redactTerminalRecord({
      ...params.record,
      state: "denied",
      deniedBy: actorId,
      deniedAt: params.nowMs,
      resolvedAt: params.nowMs,
    });
  }
  return redactTerminalRecord({
    ...params.record,
    state: "obsolete",
    obsoleteBy: actorId,
    obsoleteAt: params.nowMs,
    obsoleteReason: normalizeTrimmedString(params.reason),
    resolvedAt: params.nowMs,
  });
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
  const nowMs = params.nowMs ?? Date.now();
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
  return runOpenClawStateWriteTransaction((database) => {
    pruneRetainedApprovals(database, nowMs);
    writeApproval(database, record, nowMs);
    return record;
  }, resolveDatabaseOptions(params.baseDir));
}

export async function getPendingA2AApproval(params: {
  approvalId: string;
  nowMs?: number;
  baseDir?: string;
}): Promise<PendingA2AApproval | null> {
  const approvalId = normalizeTrimmedString(params.approvalId);
  if (!approvalId) {
    return null;
  }
  const nowMs = params.nowMs ?? Date.now();
  return runOpenClawStateWriteTransaction((database) => {
    const row = selectApprovalRow(database, approvalId);
    return row ? expireApprovalIfDue({ database, row, nowMs }) : null;
  }, resolveDatabaseOptions(params.baseDir));
}

export async function expirePendingA2AApprovals(params?: {
  nowMs?: number;
  baseDir?: string;
}): Promise<PendingA2AApproval[]> {
  const nowMs = params?.nowMs ?? Date.now();
  return runOpenClawStateWriteTransaction((database) => {
    const db = getApprovalDatabase(database);
    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("a2a_permission_approvals")
        .selectAll()
        .where("state", "in", ["pending", "applying"])
        .where("expires_at_ms", "<=", nowMs)
        .orderBy("approval_id", "asc"),
    ).rows;
    const expired: PendingA2AApproval[] = [];
    for (const row of rows) {
      expired.push(expireApprovalIfDue({ database, row, nowMs }));
    }
    return expired;
  }, resolveDatabaseOptions(params?.baseDir));
}

export async function resolvePendingA2AApproval(
  params: ResolvePendingA2AApprovalParams,
): Promise<ResolvePendingA2AApprovalResult> {
  const approvalId = normalizeTrimmedString(params.approvalId);
  if (!approvalId) {
    return { status: "not-found" };
  }
  const nowMs = params.nowMs ?? Date.now();
  return runOpenClawStateWriteTransaction((database) => {
    const row = selectApprovalRow(database, approvalId);
    if (!row) {
      return { status: "not-found" };
    }
    const current = expireApprovalIfDue({ database, row, nowMs });
    if (current.state !== "pending") {
      return {
        status: current.state === "expired" ? "expired" : "already-resolved",
        record: current,
      };
    }
    if (params.decision === "approve") {
      // Approval authorizes a config mutation. It must pass through the claimed,
      // pre-commit-authorized path so a direct resolver cannot bypass that gate.
      return { status: "authorization-required", record: current };
    }
    const resolved = toResolvedRecord({
      record: current,
      decision: params.decision,
      actorId: params.actorId,
      reason: params.reason,
      nowMs,
    });
    writeApproval(database, resolved, nowMs);
    return { status: "resolved", record: resolved };
  }, resolveDatabaseOptions(params.baseDir));
}

export async function claimPendingA2AApproval(params: {
  approvalId: string;
  actorId?: string;
  nowMs?: number;
  baseDir?: string;
}): Promise<ClaimPendingA2AApprovalResult> {
  const approvalId = normalizeTrimmedString(params.approvalId);
  if (!approvalId) {
    return { status: "not-found" };
  }
  const nowMs = params.nowMs ?? Date.now();
  return runOpenClawStateWriteTransaction((database) => {
    const row = selectApprovalRow(database, approvalId);
    if (!row) {
      return { status: "not-found" };
    }
    const current = expireApprovalIfDue({ database, row, nowMs });
    if (current.state !== "pending") {
      return {
        status: current.state === "expired" ? "expired" : "already-resolved",
        record: current,
      };
    }
    const claimId = crypto.randomUUID();
    const claimed: PendingA2AApproval = {
      ...current,
      state: "applying",
      claimId,
      applyingBy: normalizeTrimmedString(params.actorId),
      applyingAt: nowMs,
    };
    writeApproval(database, claimed, nowMs);
    return { status: "claimed", record: claimed, claimId };
  }, resolveDatabaseOptions(params.baseDir));
}

export async function authorizePendingA2AApprovalClaim(params: {
  approvalId: string;
  claimId: string;
  nowMs?: number;
  baseDir?: string;
}): Promise<AuthorizePendingA2AApprovalClaimResult> {
  const approvalId = normalizeTrimmedString(params.approvalId);
  if (!approvalId) {
    return { status: "not-found" };
  }
  const nowMs = params.nowMs ?? Date.now();
  return runOpenClawStateWriteTransaction((database) => {
    const row = selectApprovalRow(database, approvalId);
    if (!row) {
      return { status: "not-found" };
    }
    const current = expireApprovalIfDue({ database, row, nowMs });
    if (current.state !== "applying" || current.claimId !== params.claimId) {
      return {
        status: current.state === "expired" ? "expired" : "already-resolved",
        record: current,
      };
    }
    const authorized: PendingA2AApproval = {
      ...current,
      commitAuthorizedAt: nowMs,
      // Commit authorization cannot outlive the user-facing approval that granted it.
      // Re-authorizing the same claim may refresh a short lease, but never extends the approval TTL.
      commitAuthorizationExpiresAt: Math.min(
        current.expiresAt,
        nowMs + A2A_APPROVAL_COMMIT_AUTHORIZATION_LEASE_MS,
      ),
    };
    writeApproval(database, authorized, nowMs);
    return {
      status: "authorized",
      record: authorized,
      commitAuthorization: {
        claimId: params.claimId,
        authorizedAt: nowMs,
      },
    };
  }, resolveDatabaseOptions(params.baseDir));
}

export async function finishPendingA2AApprovalClaim(params: {
  approvalId: string;
  claimId: string;
  decision: "approve" | "obsolete";
  commitAuthorization?: PendingA2AApprovalCommitAuthorization;
  actorId?: string;
  reason?: string;
  nowMs?: number;
  baseDir?: string;
}): Promise<FinishPendingA2AApprovalClaimResult> {
  const approvalId = normalizeTrimmedString(params.approvalId);
  if (!approvalId) {
    return { status: "not-found" };
  }
  const nowMs = params.nowMs ?? Date.now();
  return runOpenClawStateWriteTransaction((database) => {
    const row = selectApprovalRow(database, approvalId);
    if (!row) {
      return { status: "not-found" };
    }
    const claimed = decodeApprovalRow(row);
    // Once the config write commits, terminalization is bookkeeping for that exact privileged
    // commit. Preserve its authorization receipt across the async boundary so wall-clock expiry
    // cannot leave a committed config mutation recorded as failed.
    const hasCommittedAuthorization =
      params.decision === "approve" &&
      claimed.state === "applying" &&
      claimed.claimId === params.claimId &&
      params.commitAuthorization?.claimId === params.claimId &&
      params.commitAuthorization.authorizedAt === claimed.commitAuthorizedAt &&
      claimed.commitAuthorizationExpiresAt !== undefined &&
      params.commitAuthorization.authorizedAt < claimed.commitAuthorizationExpiresAt;
    const current = hasCommittedAuthorization
      ? claimed
      : expireApprovalIfDue({ database, row, nowMs });
    if (current.state === "expired") {
      return { status: "expired", record: current };
    }
    if (
      params.decision === "approve" &&
      !hasCommittedAuthorization &&
      claimed.state === "applying" &&
      claimed.claimId === params.claimId
    ) {
      // Approval is the privileged post-write commit. Only the exact claim that passed the
      // bounded pre-commit authorization gate and retained its receipt may become approved.
      return { status: "authorization-required", record: current };
    }
    if (current.state !== "applying" || current.claimId !== params.claimId) {
      return {
        status: "already-resolved",
        record: current,
      };
    }
    const resolved = toResolvedRecord({
      record: current,
      decision: params.decision,
      actorId: params.actorId,
      reason: params.reason,
      nowMs,
    });
    delete resolved.claimId;
    delete resolved.applyingBy;
    delete resolved.applyingAt;
    writeApproval(database, resolved, nowMs);
    return { status: "resolved", record: resolved };
  }, resolveDatabaseOptions(params.baseDir));
}

export async function releasePendingA2AApprovalClaim(params: {
  approvalId: string;
  claimId: string;
  baseDir?: string;
}): Promise<void> {
  const approvalId = normalizeTrimmedString(params.approvalId);
  if (!approvalId) {
    return;
  }
  const nowMs = Date.now();
  return await runOpenClawStateWriteTransaction((database) => {
    const row = selectApprovalRow(database, approvalId);
    if (!row) {
      return;
    }
    const current = decodeApprovalRow(row);
    if (current?.state !== "applying" || current.claimId !== params.claimId) {
      return;
    }
    const pending: PendingA2AApproval = { ...current, state: "pending" };
    delete pending.claimId;
    delete pending.applyingBy;
    delete pending.applyingAt;
    delete pending.commitAuthorizedAt;
    delete pending.commitAuthorizationExpiresAt;
    writeApproval(
      database,
      pending.expiresAt <= nowMs ? expireRecord(pending, nowMs) : pending,
      nowMs,
    );
  }, resolveDatabaseOptions(params.baseDir));
}
