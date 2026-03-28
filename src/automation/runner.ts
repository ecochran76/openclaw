import type { OpenClawConfig } from "../config/config.js";
import { isLikelyInterimCronMessage } from "../cron/isolated-agent/subagent-followup-hints.js";
import { resolveAutomationRunSpec } from "./config.js";
import {
  buildAutomationContinuationPrompt,
  buildAutomationInitialPrompt,
  buildAutomationInterimAckFollowupPrompt,
} from "./prompts.js";
import {
  createAutomationRunRecord,
  getAutomationRun,
  isAutomationRunTerminalState,
  markAutomationRunStopping,
  startAutomationRun,
  stopAutomationRun,
  updateAutomationRun,
} from "./registry.js";
import { buildAutomationFinalSummaryText } from "./status.js";
import {
  evaluateAutomationStopConditions,
  resolveAutomationBudgetRemaining,
  resolveAutomationOutcomeStopReason,
} from "./stop-conditions.js";
import type {
  AutomationRunId,
  AutomationRunRecord,
  AutomationRunSpec,
  AutomationStopSpec,
} from "./types.js";

export type AutomationWorkerTurnInput = {
  runId: AutomationRunId;
  requesterSessionKey: string;
  childSessionKey: string;
  goal: string;
  label?: string;
  model?: string;
  thinking?: string;
  stop: Required<AutomationStopSpec>;
  turnIndex: number;
  isContinuation: boolean;
  prompt: string;
  remaining: ReturnType<typeof resolveAutomationBudgetRemaining>;
};

export type AutomationWorkerTurnResult = {
  outputText?: string;
  progressText?: string;
  finalSummaryText?: string;
  totalTokensUsedDelta?: number;
  completed?: boolean;
  blocked?: boolean;
  approvalRequired?: boolean;
  errored?: boolean;
};

export type AutomationFinalSummaryDelivery = {
  run: AutomationRunRecord;
  summaryText: string;
};

export type AutomationRunnerDeps = {
  runWorkerTurn: (input: AutomationWorkerTurnInput) => Promise<AutomationWorkerTurnResult>;
  deliverFinalSummary?: (params: AutomationFinalSummaryDelivery) => Promise<void> | void;
  schedule?: (task: () => void) => void;
  now?: () => number;
};

type ActiveAutomationExecution = {
  promise: Promise<void>;
  deliveryMode: "announce";
};

const activeExecutions = new Map<AutomationRunId, ActiveAutomationExecution>();

function defaultSchedule(task: () => void): void {
  queueMicrotask(task);
}

function resolveNow(deps: AutomationRunnerDeps, explicitNow?: number): number {
  return explicitNow ?? deps.now?.() ?? Date.now();
}

function normalizeTokenDelta(value?: number): number {
  const normalized = typeof value === "number" ? Math.trunc(value) : Number.NaN;
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 0;
}

function normalizeText(value?: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function summarizeProgress(result: AutomationWorkerTurnResult): string | undefined {
  const text = normalizeText(result.progressText) ?? normalizeText(result.outputText);
  if (!text) {
    return undefined;
  }
  return text.length <= 280 ? text : `${text.slice(0, 277)}...`;
}

function looksSelfReportedIncomplete(text?: string | null): boolean {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }

  return [
    /not started in this pass/i,
    /what remains\s*[:\n]/i,
    /remaining work\s*[:\n]/i,
    /still to do\s*[:\n]/i,
    /next recommended implementation step/i,
    /\bi left .+ as the next\b/i,
  ].some((pattern) => pattern.test(normalized));
}

function resolveFinalSummaryCandidate(
  record: AutomationRunRecord,
  result?: AutomationWorkerTurnResult,
): string | undefined {
  return (
    normalizeText(result?.finalSummaryText) ??
    normalizeText(result?.outputText) ??
    normalizeText(result?.progressText) ??
    normalizeText(record.finalSummaryText) ??
    normalizeText(record.lastProgressText)
  );
}

function shouldRetryInterimAck(result: AutomationWorkerTurnResult): boolean {
  if (result.completed || result.blocked || result.approvalRequired || result.errored) {
    return false;
  }
  if (normalizeText(result.progressText)) {
    return false;
  }
  const outputText = normalizeText(result.outputText);
  return Boolean(outputText && isLikelyInterimCronMessage(outputText));
}

async function runWorkerTurnWithOptionalRetry(params: {
  record: AutomationRunRecord;
  deps: AutomationRunnerDeps;
}): Promise<AutomationWorkerTurnResult> {
  const remaining = resolveAutomationBudgetRemaining({
    workerTurnsUsed: params.record.workerTurnsUsed,
    maxTurns: params.record.stop.maxTurns,
    totalTokensUsed: params.record.totalTokensUsed,
    maxTokens: params.record.stop.maxTokens,
    elapsedSeconds: Math.max(
      0,
      Math.round(
        (resolveNow(params.deps) - (params.record.startedAt ?? params.record.createdAt)) / 1000,
      ),
    ),
    maxDurationSeconds: params.record.stop.maxDurationSeconds,
  });
  const turnIndex = params.record.workerTurnsUsed + 1;
  const isContinuation = params.record.workerTurnsUsed > 0;
  const prompt = isContinuation
    ? buildAutomationContinuationPrompt({
        goal: params.record.goal,
        completedSoFar: params.record.finalSummaryText ?? params.record.lastProgressText,
        latestResult: params.record.lastProgressText,
        remaining,
        steeringNote: params.record.pendingOperatorNote,
      })
    : buildAutomationInitialPrompt({
        goal: params.record.goal,
        stop: params.record.stop,
        steeringNote: params.record.pendingOperatorNote,
      });

  const baseInput: AutomationWorkerTurnInput = {
    runId: params.record.runId,
    requesterSessionKey: params.record.requesterSessionKey,
    childSessionKey: params.record.childSessionKey,
    goal: params.record.goal,
    label: params.record.label,
    model: params.record.model,
    thinking: params.record.thinking,
    stop: params.record.stop,
    turnIndex,
    isContinuation,
    prompt,
    remaining,
  };

  const firstResult = await params.deps.runWorkerTurn(baseInput);
  if (!shouldRetryInterimAck(firstResult)) {
    return firstResult;
  }

  return params.deps.runWorkerTurn({
    ...baseInput,
    isContinuation: true,
    prompt: buildAutomationInterimAckFollowupPrompt(),
  });
}

async function finalizeAutomationRun(params: {
  runId: AutomationRunId;
  reason: Parameters<typeof stopAutomationRun>[0]["reason"];
  deps: AutomationRunnerDeps;
  summaryText?: string;
}): Promise<AutomationRunRecord | undefined> {
  const stopped = stopAutomationRun({
    runId: params.runId,
    reason: params.reason,
    now: resolveNow(params.deps),
    finalSummaryText: normalizeText(params.summaryText),
  });
  if (!stopped) {
    return undefined;
  }

  const active = activeExecutions.get(params.runId);
  if (active?.deliveryMode === "announce" && params.deps.deliverFinalSummary) {
    await params.deps.deliverFinalSummary({
      run: stopped,
      summaryText: buildAutomationFinalSummaryText({ run: stopped }),
    });
  }
  return stopped;
}

async function runAutomationLoop(params: {
  runId: AutomationRunId;
  config?: OpenClawConfig;
  deps: AutomationRunnerDeps;
}): Promise<void> {
  while (true) {
    const current = getAutomationRun(params.runId);
    if (!current || isAutomationRunTerminalState(current.state)) {
      return;
    }
    if (current.state === "stopping") {
      await finalizeAutomationRun({
        runId: params.runId,
        reason: "stopped_by_user",
        deps: params.deps,
        summaryText: current.finalSummaryText ?? current.lastProgressText,
      });
      return;
    }

    const preTurnSnapshot = {
      workerTurnsUsed: current.workerTurnsUsed,
      maxTurns: current.stop.maxTurns,
      totalTokensUsed: current.totalTokensUsed,
      maxTokens: current.stop.maxTokens,
      elapsedSeconds: Math.max(
        0,
        Math.round((resolveNow(params.deps) - (current.startedAt ?? current.createdAt)) / 1000),
      ),
      maxDurationSeconds: current.stop.maxDurationSeconds,
    };
    const preTurnGuard = evaluateAutomationStopConditions(preTurnSnapshot);
    if (preTurnGuard.shouldStop) {
      await finalizeAutomationRun({
        runId: params.runId,
        reason: preTurnGuard.reason,
        deps: params.deps,
        summaryText: current.finalSummaryText ?? current.lastProgressText,
      });
      return;
    }

    const runningRecord =
      startAutomationRun(params.runId, { now: resolveNow(params.deps) }) ?? current;

    let turnResult: AutomationWorkerTurnResult;
    try {
      turnResult = await runWorkerTurnWithOptionalRetry({
        record: runningRecord,
        deps: params.deps,
      });
    } catch (error) {
      turnResult = {
        errored: true,
        outputText: error instanceof Error ? error.message : String(error),
      };
    }

    const latest = getAutomationRun(params.runId);
    if (!latest || isAutomationRunTerminalState(latest.state)) {
      return;
    }

    const updated = updateAutomationRun(
      params.runId,
      {
        state: latest.state === "stopping" ? "stopping" : "running",
        workerTurnsUsed: latest.workerTurnsUsed + 1,
        totalTokensUsed:
          latest.totalTokensUsed + normalizeTokenDelta(turnResult.totalTokensUsedDelta),
        lastProgressText: summarizeProgress(turnResult) ?? latest.lastProgressText,
        pendingOperatorNote: undefined,
      },
      { config: params.config, now: resolveNow(params.deps) },
    );
    if (!updated) {
      return;
    }

    if (updated.state === "stopping") {
      await finalizeAutomationRun({
        runId: params.runId,
        reason: "stopped_by_user",
        deps: params.deps,
        summaryText: resolveFinalSummaryCandidate(updated, turnResult),
      });
      return;
    }

    const explicitStopReason = resolveAutomationOutcomeStopReason({
      completed: turnResult.completed,
      blocked: turnResult.blocked,
      approvalRequired: turnResult.approvalRequired,
      errored: turnResult.errored,
    });
    if (
      explicitStopReason === "completed" &&
      looksSelfReportedIncomplete(resolveFinalSummaryCandidate(updated, turnResult))
    ) {
      // Keep going when the worker's own summary admits there is still in-scope work left.
    } else if (explicitStopReason) {
      await finalizeAutomationRun({
        runId: params.runId,
        reason: explicitStopReason,
        deps: params.deps,
        summaryText: resolveFinalSummaryCandidate(updated, turnResult),
      });
      return;
    }

    const postTurnSnapshot = {
      workerTurnsUsed: updated.workerTurnsUsed,
      maxTurns: updated.stop.maxTurns,
      totalTokensUsed: updated.totalTokensUsed,
      maxTokens: updated.stop.maxTokens,
      elapsedSeconds: Math.max(
        0,
        Math.round((resolveNow(params.deps) - (updated.startedAt ?? updated.createdAt)) / 1000),
      ),
      maxDurationSeconds: updated.stop.maxDurationSeconds,
    };
    const postTurnGuard = evaluateAutomationStopConditions(postTurnSnapshot);
    if (postTurnGuard.shouldStop) {
      await finalizeAutomationRun({
        runId: params.runId,
        reason: postTurnGuard.reason,
        deps: params.deps,
        summaryText: resolveFinalSummaryCandidate(updated, turnResult),
      });
      return;
    }
  }
}

export function startAutomationRunInBackground(params: {
  requesterSessionKey: string;
  childSessionKey: string;
  spec: AutomationRunSpec;
  config?: OpenClawConfig;
  deps: AutomationRunnerDeps;
  now?: number;
  runId?: AutomationRunId;
}): AutomationRunRecord {
  const spec = resolveAutomationRunSpec({ spec: params.spec, config: params.config });
  const record = createAutomationRunRecord({
    requesterSessionKey: params.requesterSessionKey,
    childSessionKey: params.childSessionKey,
    spec,
    config: params.config,
    now: params.now,
    runId: params.runId,
  });
  const runnerDeps =
    params.now !== undefined && !params.deps.now
      ? { ...params.deps, now: () => params.now as number }
      : params.deps;
  kickAutomationRun({ runId: record.runId, deps: runnerDeps, config: params.config });
  return record;
}

export function kickAutomationRun(params: {
  runId: AutomationRunId;
  config?: OpenClawConfig;
  deps: AutomationRunnerDeps;
}): boolean {
  if (activeExecutions.has(params.runId)) {
    return false;
  }
  const schedule = params.deps.schedule ?? defaultSchedule;
  const promise = new Promise<void>((resolve) => {
    schedule(() => {
      void runAutomationLoop(params)
        .catch(async (error) => {
          const record = getAutomationRun(params.runId);
          if (record && !isAutomationRunTerminalState(record.state)) {
            await finalizeAutomationRun({
              runId: params.runId,
              reason: "error",
              deps: params.deps,
              summaryText: error instanceof Error ? error.message : String(error),
            });
          }
        })
        .finally(() => {
          activeExecutions.delete(params.runId);
          resolve();
        });
    });
  });
  activeExecutions.set(params.runId, {
    promise,
    deliveryMode: "announce",
  });
  return true;
}

export function requestAutomationRunStop(
  runId: AutomationRunId,
  options?: { now?: number },
): AutomationRunRecord | undefined {
  return markAutomationRunStopping(runId, options);
}

export function isAutomationRunActive(runId: AutomationRunId): boolean {
  return activeExecutions.has(runId);
}

export async function waitForAutomationRunToSettle(runId: AutomationRunId): Promise<void> {
  await activeExecutions.get(runId)?.promise;
}

export function resetAutomationRunnerForTests(): void {
  activeExecutions.clear();
}
