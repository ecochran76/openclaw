import type { OpenClawConfig } from "../config/config.js";
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

const automationRuns = new Map<AutomationRunId, AutomationRunRecord>();
let automationRunSequence = 0;

const TERMINAL_STATES = new Set<AutomationRunState>(["stopped", "completed", "blocked", "failed"]);

export function resetAutomationRegistryForTests(): void {
  automationRuns.clear();
  automationRunSequence = 0;
}

export function isAutomationRunTerminalState(state: AutomationRunState): boolean {
  return TERMINAL_STATES.has(state);
}

function nextAutomationRunId(): AutomationRunId {
  automationRunSequence += 1;
  return `auto_${String(automationRunSequence).padStart(6, "0")}`;
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
  automationRuns.set(record.runId, record);
  return cloneRecord(record);
}

export function getAutomationRun(runId: AutomationRunId): AutomationRunRecord | undefined {
  const record = automationRuns.get(runId);
  return record ? cloneRecord(record) : undefined;
}

export function listAutomationRunsForRequester(
  requesterSessionKey: string,
  options?: { includeEnded?: boolean },
): AutomationRunRecord[] {
  const includeEnded = options?.includeEnded ?? true;
  const records = [...automationRuns.values()].filter(
    (record) =>
      record.requesterSessionKey === requesterSessionKey &&
      (includeEnded || !isAutomationRunTerminalState(record.state)),
  );
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
  const current = automationRuns.get(runId);
  if (!current) {
    return undefined;
  }
  const next: AutomationRunRecord = {
    ...current,
    ...patch,
    stop: patch.stop ? resolveAutomationStopSpec(patch.stop, options?.config) : current.stop,
    stopReason:
      patch.stopReason !== undefined
        ? (normalizeAutomationStopReason(patch.stopReason) ?? null)
        : current.stopReason,
    updatedAt: options?.now ?? patch.updatedAt ?? Date.now(),
  };
  automationRuns.set(runId, next);
  return cloneRecord(next);
}

export function startAutomationRun(
  runId: AutomationRunId,
  options?: { now?: number },
): AutomationRunRecord | undefined {
  const current = automationRuns.get(runId);
  if (!current) {
    return undefined;
  }
  if (current.startedAt) {
    return cloneRecord(current);
  }
  return updateAutomationRun(
    runId,
    {
      state: "running",
      startedAt: options?.now ?? Date.now(),
    },
    options,
  );
}

export function markAutomationRunStopping(
  runId: AutomationRunId,
  options?: { now?: number },
): AutomationRunRecord | undefined {
  const current = automationRuns.get(runId);
  if (!current || isAutomationRunTerminalState(current.state)) {
    return current ? cloneRecord(current) : undefined;
  }
  return updateAutomationRun(runId, { state: "stopping" }, options);
}

export function setAutomationRunPendingOperatorNote(
  runId: AutomationRunId,
  note: string,
  options?: { now?: number },
): AutomationRunRecord | undefined {
  const current = automationRuns.get(runId);
  if (!current || isAutomationRunTerminalState(current.state)) {
    return current ? cloneRecord(current) : undefined;
  }
  const trimmed = note.trim();
  if (!trimmed) {
    return cloneRecord(current);
  }
  return updateAutomationRun(runId, { pendingOperatorNote: trimmed }, options);
}

export function stopAutomationRun(params: {
  runId: AutomationRunId;
  reason: AutomationStopReason;
  now?: number;
  finalSummaryText?: string;
}): AutomationRunRecord | undefined {
  const current = automationRuns.get(params.runId);
  if (!current) {
    return undefined;
  }
  if (current.endedAt || isAutomationRunTerminalState(current.state)) {
    return cloneRecord(current);
  }
  const now = params.now ?? Date.now();
  const state = resolveStoppedState(params.reason);
  const next: AutomationRunRecord = {
    ...current,
    state,
    stopReason: params.reason,
    endedAt: now,
    updatedAt: now,
    finalSummaryText: params.finalSummaryText ?? current.finalSummaryText,
  };
  automationRuns.set(params.runId, next);
  return cloneRecord(next);
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
  if (selector.startsWith("#")) {
    const index = Number.parseInt(selector.slice(1), 10);
    if (!Number.isFinite(index) || index < 1) {
      return undefined;
    }
    return records[index - 1];
  }
  return records.find((record) => record.runId === selector);
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
