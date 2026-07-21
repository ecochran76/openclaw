import { randomUUID } from "node:crypto";
import type { Insertable, Selectable, Updateable } from "kysely";
import type { OpenClawConfig } from "../config/config.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveAutomationRunSpec, resolveAutomationStopSpec } from "./config.js";
import { normalizeAutomationStopReason } from "./stop-conditions.js";
import type {
  AutomationRunId,
  AutomationRunRecord,
  AutomationRunSpec,
  AutomationRunState,
  AutomationStatusView,
  AutomationStopReason,
} from "./types.js";

type AutomationRunsTable = OpenClawStateKyselyDatabase["automation_runs"];
type AutomationRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "automation_runs">;
type AutomationRunRow = Selectable<AutomationRunsTable>;
type AutomationRunInsert = Insertable<AutomationRunsTable>;
type AutomationRunUpdate = Updateable<AutomationRunsTable>;

const initializedDatabasePaths = new Set<string>();

const TERMINAL_STATES = new Set<AutomationRunState>(["stopped", "completed", "blocked", "failed"]);
const GATEWAY_RESTART_SUMMARY = "Automation interrupted by a gateway restart before completion.";
const AUTOMATION_LIST_HISTORY_LIMIT = 20;
const AUTOMATION_TERMINAL_RETENTION_LIMIT = 100;

export function resetAutomationRegistryForTests(): void {
  const database = openOpenClawStateDatabase();
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getAutomationRegistryKysely(db);
    executeSqliteQuerySync(db, stateDb.deleteFrom("automation_runs"));
  });
  initializedDatabasePaths.add(database.path);
}

export function isAutomationRunTerminalState(state: AutomationRunState): boolean {
  return TERMINAL_STATES.has(state);
}

function nextAutomationRunId(): AutomationRunId {
  return `auto_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function getAutomationRegistryKysely(db: ReturnType<typeof openOpenClawStateDatabase>["db"]) {
  return getNodeSqliteKysely<AutomationRegistryDatabase>(db);
}

function pruneTerminalAutomationRunHistory(params: {
  db: ReturnType<typeof openOpenClawStateDatabase>["db"];
  requesterSessionKey: string;
}): void {
  const stateDb = getAutomationRegistryKysely(params.db);
  const staleIds = executeSqliteQuerySync(
    params.db,
    stateDb
      .selectFrom("automation_runs")
      .select("run_id")
      .where("requester_session_key", "=", params.requesterSessionKey)
      .where("state", "in", [...TERMINAL_STATES])
      .orderBy("created_at", "desc")
      .orderBy("run_id", "desc")
      .limit(2_147_483_647)
      .offset(AUTOMATION_TERMINAL_RETENTION_LIMIT),
  ).rows.map((row) => row.run_id);
  if (staleIds.length > 0) {
    executeSqliteQuerySync(
      params.db,
      stateDb.deleteFrom("automation_runs").where("run_id", "in", staleIds),
    );
  }
}

function rowToAutomationRunRecord(row: AutomationRunRow): AutomationRunRecord {
  return {
    runId: row.run_id,
    requesterSessionKey: row.requester_session_key,
    childSessionKey: row.child_session_key,
    ...(row.label !== null ? { label: row.label } : {}),
    goal: row.goal,
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.thinking !== null ? { thinking: row.thinking } : {}),
    state: row.state as AutomationRunState,
    stop: {
      maxTurns: row.max_turns,
      maxTokens: row.max_tokens,
      maxDurationSeconds: row.max_duration_seconds,
    },
    stopReason: (row.stop_reason as AutomationStopReason | null) ?? null,
    createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    updatedAt: row.updated_at,
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
    workerTurnsUsed: row.worker_turns_used,
    totalTokensUsed: row.total_tokens_used,
    ...(row.last_progress_text !== null ? { lastProgressText: row.last_progress_text } : {}),
    ...(row.pending_operator_note !== null
      ? { pendingOperatorNote: row.pending_operator_note }
      : {}),
    ...(row.final_summary_text !== null ? { finalSummaryText: row.final_summary_text } : {}),
  };
}

function automationRunRecordToInsert(record: AutomationRunRecord): AutomationRunInsert {
  return {
    run_id: record.runId,
    requester_session_key: record.requesterSessionKey,
    child_session_key: record.childSessionKey,
    label: record.label ?? null,
    goal: record.goal,
    model: record.model ?? null,
    thinking: record.thinking ?? null,
    state: record.state,
    max_turns: record.stop.maxTurns,
    max_tokens: record.stop.maxTokens,
    max_duration_seconds: record.stop.maxDurationSeconds,
    stop_reason: record.stopReason ?? null,
    created_at: record.createdAt,
    started_at: record.startedAt ?? null,
    updated_at: record.updatedAt,
    ended_at: record.endedAt ?? null,
    worker_turns_used: record.workerTurnsUsed,
    total_tokens_used: record.totalTokensUsed,
    last_progress_text: record.lastProgressText ?? null,
    pending_operator_note: record.pendingOperatorNote ?? null,
    final_summary_text: record.finalSummaryText ?? null,
  };
}

function automationRunRecordToUpdate(record: AutomationRunRecord): AutomationRunUpdate {
  const { run_id: _runId, ...update } = automationRunRecordToInsert(record);
  return update;
}

function ensureAutomationRegistryInitialized(): ReturnType<typeof openOpenClawStateDatabase> {
  const database = openOpenClawStateDatabase();
  if (initializedDatabasePaths.has(database.path)) {
    return database;
  }
  // Registry readers can run in CLI and worker processes while a gateway owns
  // active runs. Process-local first access is not proof that their owner died.
  // Recovery must be initiated by the gateway lifecycle owner after it binds.
  initializedDatabasePaths.add(database.path);
  return database;
}

export function reconcileAutomationRunsForGatewayStartup(options?: {
  now?: number;
  isRunOwnedByThisProcess?: (runId: AutomationRunId) => boolean;
}): AutomationRunRecord[] {
  const now = options?.now ?? Date.now();
  ensureAutomationRegistryInitialized();
  return runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getAutomationRegistryKysely(db);
    const rows = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("automation_runs")
        .selectAll()
        .where("state", "not in", [...TERMINAL_STATES]),
    ).rows;
    const reconciled = rows
      .map(rowToAutomationRunRecord)
      .filter((record) => !options?.isRunOwnedByThisProcess?.(record.runId))
      .map(
        (record): AutomationRunRecord => ({
          ...record,
          state: "failed",
          stopReason: "error",
          updatedAt: now,
          endedAt: now,
          finalSummaryText: record.finalSummaryText ?? GATEWAY_RESTART_SUMMARY,
        }),
      );
    for (const record of reconciled) {
      executeSqliteQuerySync(
        db,
        stateDb
          .updateTable("automation_runs")
          .set(automationRunRecordToUpdate(record))
          .where("run_id", "=", record.runId),
      );
    }
    for (const requesterSessionKey of new Set(
      reconciled.map((record) => record.requesterSessionKey),
    )) {
      pruneTerminalAutomationRunHistory({ db, requesterSessionKey });
    }
    return reconciled.map(cloneRecord);
  });
}

function readAutomationRun(runId: AutomationRunId): AutomationRunRecord | undefined {
  const database = ensureAutomationRegistryInitialized();
  const stateDb = getAutomationRegistryKysely(database.db);
  const row = executeSqliteQuerySync(
    database.db,
    stateDb.selectFrom("automation_runs").selectAll().where("run_id", "=", runId).limit(1),
  ).rows[0];
  return row ? rowToAutomationRunRecord(row) : undefined;
}

function sortRuns(records: AutomationRunRecord[]): AutomationRunRecord[] {
  return records.toSorted((left, right) => {
    const leftActive = isAutomationRunTerminalState(left.state) ? 0 : 1;
    const rightActive = isAutomationRunTerminalState(right.state) ? 0 : 1;
    if (leftActive !== rightActive) {
      return rightActive - leftActive;
    }
    if (left.createdAt !== right.createdAt) {
      return right.createdAt - left.createdAt;
    }
    return right.runId.localeCompare(left.runId);
  });
}

function cloneRecord(record: AutomationRunRecord): AutomationRunRecord {
  return { ...record, stop: { ...record.stop } };
}

export function createAutomationRunRecord(params: {
  requesterSessionKey: string;
  childSessionKey: string;
  spec: AutomationRunSpec;
  config?: OpenClawConfig;
  now?: number;
  runId?: AutomationRunId;
}): AutomationRunRecord {
  const now = params.now ?? Date.now();
  const spec = resolveAutomationRunSpec({ spec: params.spec, config: params.config });
  const record: AutomationRunRecord = {
    runId: params.runId ?? nextAutomationRunId(),
    requesterSessionKey: params.requesterSessionKey,
    childSessionKey: params.childSessionKey,
    label: spec.label,
    goal: spec.goal,
    model: spec.model,
    thinking: spec.thinking,
    state: "queued",
    stop: spec.stop,
    stopReason: null,
    createdAt: now,
    updatedAt: now,
    workerTurnsUsed: 0,
    totalTokensUsed: 0,
  };
  ensureAutomationRegistryInitialized();
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getAutomationRegistryKysely(db);
    executeSqliteQuerySync(
      db,
      stateDb.insertInto("automation_runs").values(automationRunRecordToInsert(record)),
    );
    pruneTerminalAutomationRunHistory({ db, requesterSessionKey: record.requesterSessionKey });
  });
  return cloneRecord(record);
}

export function getAutomationRun(runId: AutomationRunId): AutomationRunRecord | undefined {
  const record = readAutomationRun(runId);
  return record ? cloneRecord(record) : undefined;
}

export function listAutomationRunsForRequester(
  requesterSessionKey: string,
  options?: { includeEnded?: boolean },
): AutomationRunRecord[] {
  const includeEnded = options?.includeEnded ?? true;
  const database = ensureAutomationRegistryInitialized();
  const stateDb = getAutomationRegistryKysely(database.db);
  const baseQuery = stateDb
    .selectFrom("automation_runs")
    .selectAll()
    .where("requester_session_key", "=", requesterSessionKey);
  const activeRows = executeSqliteQuerySync(
    database.db,
    baseQuery.where("state", "not in", [...TERMINAL_STATES]),
  ).rows;
  const terminalRows = includeEnded
    ? executeSqliteQuerySync(
        database.db,
        stateDb
          .selectFrom("automation_runs")
          .selectAll()
          .where("requester_session_key", "=", requesterSessionKey)
          .where("state", "in", [...TERMINAL_STATES])
          .orderBy("created_at", "desc")
          .orderBy("run_id", "desc")
          .limit(AUTOMATION_LIST_HISTORY_LIMIT),
      ).rows
    : [];
  const records = [...activeRows, ...terminalRows].map(rowToAutomationRunRecord);
  return sortRuns(records).map(cloneRecord);
}

export function getLatestAutomationRunForRequester(
  requesterSessionKey: string,
): AutomationRunRecord | undefined {
  return listAutomationRunsForRequester(requesterSessionKey, { includeEnded: false })[0];
}

export function updateAutomationRun(
  runId: AutomationRunId,
  patch: Partial<AutomationRunRecord>,
  options?: { config?: OpenClawConfig; now?: number },
): AutomationRunRecord | undefined {
  return mutateAutomationRun(runId, (current) => ({
    ...current,
    ...patch,
    runId,
    stop: patch.stop ? resolveAutomationStopSpec(patch.stop, options?.config) : current.stop,
    stopReason:
      patch.stopReason !== undefined
        ? (normalizeAutomationStopReason(patch.stopReason) ?? null)
        : current.stopReason,
    updatedAt: options?.now ?? patch.updatedAt ?? Date.now(),
  }));
}

export function recordAutomationRunWorkerTurn(params: {
  runId: AutomationRunId;
  workerCalls: number;
  totalTokensUsedDelta: number;
  lastProgressText?: string;
  config?: OpenClawConfig;
  now?: number;
}): AutomationRunRecord | undefined {
  return mutateAutomationRun(params.runId, (current) =>
    isAutomationRunTerminalState(current.state)
      ? undefined
      : {
          ...current,
          state: current.state === "stopping" ? "stopping" : "running",
          workerTurnsUsed: current.workerTurnsUsed + params.workerCalls,
          totalTokensUsed: current.totalTokensUsed + params.totalTokensUsedDelta,
          lastProgressText: params.lastProgressText ?? current.lastProgressText,
          stop: resolveAutomationStopSpec(current.stop, params.config),
          updatedAt: params.now ?? Date.now(),
        },
  );
}

function mutateAutomationRun(
  runId: AutomationRunId,
  mutate: (current: AutomationRunRecord) => AutomationRunRecord | undefined,
): AutomationRunRecord | undefined {
  ensureAutomationRegistryInitialized();
  return runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getAutomationRegistryKysely(db);
    const row = executeSqliteQuerySync(
      db,
      stateDb.selectFrom("automation_runs").selectAll().where("run_id", "=", runId).limit(1),
    ).rows[0];
    if (!row) {
      return undefined;
    }
    const current = rowToAutomationRunRecord(row);
    const next = mutate(current);
    if (!next) {
      return cloneRecord(current);
    }
    executeSqliteQuerySync(
      db,
      stateDb
        .updateTable("automation_runs")
        .set(automationRunRecordToUpdate(next))
        .where("run_id", "=", runId),
    );
    pruneTerminalAutomationRunHistory({
      db,
      requesterSessionKey: current.requesterSessionKey,
    });
    return cloneRecord(next);
  });
}

export function startAutomationRun(
  runId: AutomationRunId,
  options?: { now?: number },
): AutomationRunRecord | undefined {
  return mutateAutomationRun(runId, (current) =>
    current.startedAt || isAutomationRunTerminalState(current.state)
      ? undefined
      : {
          ...current,
          runId,
          updatedAt: options?.now ?? Date.now(),
          state: "running",
          startedAt: options?.now ?? Date.now(),
        },
  );
}

export function markAutomationRunStopping(
  runId: AutomationRunId,
  options?: { now?: number },
): AutomationRunRecord | undefined {
  return mutateAutomationRun(runId, (current) =>
    isAutomationRunTerminalState(current.state)
      ? undefined
      : { ...current, state: "stopping", updatedAt: options?.now ?? Date.now() },
  );
}

export function setAutomationRunPendingOperatorNote(
  runId: AutomationRunId,
  note: string,
  options?: { now?: number },
): AutomationRunRecord | undefined {
  const trimmed = note.trim();
  return mutateAutomationRun(runId, (current) =>
    !trimmed || isAutomationRunTerminalState(current.state)
      ? undefined
      : {
          ...current,
          pendingOperatorNote: trimmed,
          updatedAt: options?.now ?? Date.now(),
        },
  );
}

export function clearAutomationRunPendingOperatorNote(
  runId: AutomationRunId,
  expectedNote: string,
  options?: { now?: number },
): AutomationRunRecord | undefined {
  const expected = expectedNote.trim();
  return mutateAutomationRun(runId, (current) =>
    !expected || current.pendingOperatorNote !== expected
      ? undefined
      : {
          ...current,
          pendingOperatorNote: undefined,
          updatedAt: options?.now ?? Date.now(),
        },
  );
}

export function stopAutomationRun(params: {
  runId: AutomationRunId;
  reason: AutomationStopReason;
  now?: number;
  finalSummaryText?: string;
}): AutomationRunRecord | undefined {
  ensureAutomationRegistryInitialized();
  return runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getAutomationRegistryKysely(db);
    const row = executeSqliteQuerySync(
      db,
      stateDb.selectFrom("automation_runs").selectAll().where("run_id", "=", params.runId).limit(1),
    ).rows[0];
    if (!row) {
      return undefined;
    }
    const current = rowToAutomationRunRecord(row);
    if (current.endedAt || isAutomationRunTerminalState(current.state)) {
      return cloneRecord(current);
    }
    const now = params.now ?? Date.now();
    const next: AutomationRunRecord = {
      ...current,
      state: resolveStoppedState(params.reason),
      stopReason: params.reason,
      endedAt: now,
      updatedAt: now,
      finalSummaryText: params.finalSummaryText ?? current.finalSummaryText,
    };
    executeSqliteQuerySync(
      db,
      stateDb
        .updateTable("automation_runs")
        .set(automationRunRecordToUpdate(next))
        .where("run_id", "=", params.runId),
    );
    pruneTerminalAutomationRunHistory({
      db,
      requesterSessionKey: current.requesterSessionKey,
    });
    return cloneRecord(next);
  });
}

/** Clears only process-local startup state so tests can model a gateway restart. */
export function resetAutomationRegistryProcessStateForTests(): void {
  initializedDatabasePaths.clear();
}

function resolveStoppedState(reason: AutomationStopReason): AutomationRunState {
  switch (reason) {
    case "completed":
      return "completed";
    case "blocked":
    case "approval_required":
      return "blocked";
    case "error":
      return "failed";
    default:
      return "stopped";
  }
}

export function resolveAutomationRunSelector(params: {
  requesterSessionKey: string;
  selector?: string | null;
}): AutomationRunRecord | undefined {
  const records = listAutomationRunsForRequester(params.requesterSessionKey);
  const selector = params.selector?.trim();
  if (!selector) {
    return records[0];
  }
  if (/^#\d+$/.test(selector)) {
    const index = Number.parseInt(selector.slice(1), 10);
    if (!Number.isFinite(index) || index < 1) {
      return undefined;
    }
    return records[index - 1];
  }
  if (selector.startsWith("#")) {
    return undefined;
  }
  const exact = readAutomationRun(selector);
  return exact?.requesterSessionKey === params.requesterSessionKey ? exact : undefined;
}

export function buildAutomationStatusView(params: {
  record: AutomationRunRecord;
  now?: number;
}): AutomationStatusView {
  const now = params.now ?? Date.now();
  const startedAt = params.record.startedAt ?? params.record.createdAt;
  const endedAt = params.record.endedAt ?? now;
  const elapsedSeconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  return {
    runId: params.record.runId,
    label: params.record.label,
    state: params.record.state,
    stopReason: params.record.stopReason,
    childSessionKey: params.record.childSessionKey,
    workerTurnsUsed: params.record.workerTurnsUsed,
    maxTurns: params.record.stop.maxTurns,
    totalTokensUsed: params.record.totalTokensUsed,
    maxTokens: params.record.stop.maxTokens,
    elapsedSeconds,
    maxDurationSeconds: params.record.stop.maxDurationSeconds,
    lastProgressText: params.record.lastProgressText,
    pendingOperatorNote: params.record.pendingOperatorNote,
    finalSummaryText: params.record.finalSummaryText,
  };
}
