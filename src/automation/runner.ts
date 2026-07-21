import type { OpenClawConfig } from "../config/config.js";
import { isLikelyInterimCronMessage } from "../cron/isolated-agent/subagent-followup-hints.js";
import { resolveAutomationConfig, resolveAutomationRunSpec } from "./config.js";
import {
  resolveAutomationFinalSummaryCandidate,
  resolveAutomationTurnOutcome,
  resolveAutomationTurnUpdateText,
  summarizeAutomationTurnProgress,
} from "./progress-reporting.js";
import {
  buildAutomationContinuationPrompt,
  buildAutomationInitialPrompt,
  buildAutomationInterimAckFollowupPrompt,
} from "./prompts.js";
import {
  clearAutomationRunPendingOperatorNote,
  createAutomationRunRecord,
  getAutomationRun,
  isAutomationRunTerminalState,
  markAutomationRunStopping,
  recordAutomationRunWorkerTurn,
  startAutomationRun,
  stopAutomationRun,
} from "./registry.js";
import { buildAutomationFinalSummaryText, buildAutomationTurnUpdateText } from "./status.js";
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
import { waitWithTimeout } from "./wait-with-timeout.js";
import {
  AutomationWorkerPromptBudgetExceededError,
  estimateAutomationWorkerPromptTokens,
} from "./worker-job.js";
import type { AutomationWorkerTurnResultShape } from "./worker-result.js";

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
  abortSignal: AbortSignal;
};

export type AutomationWorkerTurnResult = AutomationWorkerTurnResultShape;

export type AutomationFinalSummaryDelivery = {
  run: AutomationRunRecord;
  summaryText: string;
};

export type AutomationTurnUpdateDelivery = {
  run: AutomationRunRecord;
  updateText: string;
};

export type AutomationRunnerDeps = {
  runWorkerTurn: (input: AutomationWorkerTurnInput) => Promise<AutomationWorkerTurnResult>;
  deliverTurnUpdate?: (params: AutomationTurnUpdateDelivery) => Promise<void> | void;
  deliverFinalSummary?: (params: AutomationFinalSummaryDelivery) => Promise<void> | void;
  schedule?: (task: () => void) => void;
  now?: () => number;
};

export type AutomationRunStartResult =
  | { status: "started"; run: AutomationRunRecord }
  | {
      status: "capacity";
      activeCount: number;
      maxConcurrent: number;
      activeRunIds: AutomationRunId[];
    };

export type AutomationRunKickResult =
  | { status: "started" }
  | { status: "already_active" }
  | {
      status: "capacity";
      activeCount: number;
      maxConcurrent: number;
      activeRunIds: AutomationRunId[];
    };

type ActiveAutomationExecution = {
  promise: Promise<void>;
  deliveryMode: "announce";
  abortController: AbortController;
};

const activeExecutions = new Map<AutomationRunId, ActiveAutomationExecution>();
const pendingWorkerSettlements = new WeakMap<AbortController, Promise<void>>();

function listCapacityExecutions(): Array<[AutomationRunId, ActiveAutomationExecution]> {
  return [...activeExecutions];
}
class AutomationDurationExceededError extends Error {
  constructor() {
    super("automation max duration reached while waiting for a worker turn");
    this.name = "AutomationDurationExceededError";
  }
}

class AutomationStoppedByUserError extends Error {
  constructor() {
    super("automation stopped by user while waiting for a worker turn");
    this.name = "AutomationStoppedByUserError";
  }
}

type AutomationWorkerExecution = {
  result?: AutomationWorkerTurnResult;
  workerCalls: number;
  totalTokensUsedDelta: number;
  timedOut: boolean;
  stoppedByUser: boolean;
  tokenBudgetExhausted: boolean;
};

function defaultSchedule(task: () => void): void {
  queueMicrotask(task);
}

function resolveNow(deps: AutomationRunnerDeps, explicitNow?: number): number {
  return explicitNow ?? deps.now?.() ?? Date.now();
}

function resolveTokenDelta(value: number | undefined, reservedTokens: number): number {
  const normalized = typeof value === "number" ? Math.trunc(value) : Number.NaN;
  // Reserve the allowance when usage is absent or invalid so a later turn cannot overspend it.
  return Number.isFinite(normalized) && normalized >= 0
    ? normalized
    : Math.max(0, Math.trunc(reservedTokens));
}

function normalizeText(value?: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function appendDeliveryError(summaryText: string | undefined, message: string): string {
  const summary = normalizeText(summaryText);
  return summary ? `${summary}\n\nDelivery error: ${message}` : `Delivery error: ${message}`;
}

function isAutomationStoppedByUser(runId: AutomationRunId, error?: unknown): boolean {
  return (
    error instanceof AutomationStoppedByUserError || getAutomationRun(runId)?.state === "stopping"
  );
}

function resolveWorkerAwaitTimeoutMs(record: AutomationRunRecord, deps: AutomationRunnerDeps) {
  const startedAt = record.startedAt ?? record.createdAt;
  const elapsedMs = Math.max(0, resolveNow(deps) - startedAt);
  return Math.max(0, record.stop.maxDurationSeconds * 1000 - elapsedMs);
}

function resolveElapsedSeconds(record: AutomationRunRecord, deps: AutomationRunnerDeps): number {
  const startedAt = record.startedAt ?? record.createdAt;
  return Math.max(0, Math.floor((resolveNow(deps) - startedAt) / 1000));
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
  abortController: AbortController;
}): Promise<AutomationWorkerExecution> {
  const abortSignal = params.abortController.signal;
  const remaining = resolveAutomationBudgetRemaining({
    workerTurnsUsed: params.record.workerTurnsUsed,
    maxTurns: params.record.stop.maxTurns,
    totalTokensUsed: params.record.totalTokensUsed,
    maxTokens: params.record.stop.maxTokens,
    elapsedSeconds: resolveElapsedSeconds(params.record, params.deps),
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
    abortSignal,
  };

  let workerCalls = 0;
  let totalTokensUsedDelta = 0;
  const runWorkerCall = async (input: AutomationWorkerTurnInput) => {
    if (abortSignal.aborted) {
      throw new AutomationStoppedByUserError();
    }
    if (estimateAutomationWorkerPromptTokens(input.prompt) >= Math.trunc(input.remaining.tokens)) {
      throw new AutomationWorkerPromptBudgetExceededError();
    }
    workerCalls += 1;
    try {
      const work = params.deps.runWorkerTurn(input);
      pendingWorkerSettlements.set(
        params.abortController,
        work.then(
          () => undefined,
          () => undefined,
        ),
      );
      const result = await waitWithTimeout({
        work,
        timeoutMs: resolveWorkerAwaitTimeoutMs(params.record, params.deps),
        createError: () => new AutomationDurationExceededError(),
        abortSignal,
        createAbortError: () => new AutomationStoppedByUserError(),
      });
      totalTokensUsedDelta += resolveTokenDelta(
        result.totalTokensUsedDelta,
        input.remaining.tokens,
      );
      pendingWorkerSettlements.delete(params.abortController);
      return result;
    } catch (error) {
      if (
        error instanceof AutomationDurationExceededError ||
        error instanceof AutomationStoppedByUserError ||
        error instanceof AutomationWorkerPromptBudgetExceededError
      ) {
        throw error;
      }
      pendingWorkerSettlements.delete(params.abortController);
      return {
        errored: true,
        outputText: error instanceof Error ? error.message : String(error),
      } satisfies AutomationWorkerTurnResult;
    }
  };

  try {
    const firstResult = await runWorkerCall(baseInput);
    const retryGuard = evaluateAutomationStopConditions({
      workerTurnsUsed: params.record.workerTurnsUsed + workerCalls,
      maxTurns: params.record.stop.maxTurns,
      totalTokensUsed: params.record.totalTokensUsed + totalTokensUsedDelta,
      maxTokens: params.record.stop.maxTokens,
      elapsedSeconds: resolveElapsedSeconds(params.record, params.deps),
      maxDurationSeconds: params.record.stop.maxDurationSeconds,
    });
    if (!shouldRetryInterimAck(firstResult) || retryGuard.shouldStop) {
      return {
        result: firstResult,
        workerCalls,
        totalTokensUsedDelta,
        timedOut: false,
        stoppedByUser: false,
        tokenBudgetExhausted: false,
      };
    }

    const retryResult = await runWorkerCall({
      ...baseInput,
      turnIndex: baseInput.turnIndex + 1,
      isContinuation: true,
      prompt: buildAutomationInterimAckFollowupPrompt(),
      remaining: retryGuard.remaining,
    });
    return {
      result: retryResult,
      workerCalls,
      totalTokensUsedDelta,
      timedOut: false,
      stoppedByUser: false,
      tokenBudgetExhausted: false,
    };
  } catch (error) {
    if (error instanceof AutomationWorkerPromptBudgetExceededError) {
      return {
        workerCalls,
        totalTokensUsedDelta,
        timedOut: false,
        stoppedByUser: false,
        tokenBudgetExhausted: true,
      };
    }
    if (error instanceof AutomationStoppedByUserError) {
      return {
        workerCalls,
        totalTokensUsedDelta,
        timedOut: false,
        stoppedByUser: true,
        tokenBudgetExhausted: false,
      };
    }
    if (!(error instanceof AutomationDurationExceededError)) {
      throw error;
    }
    // The duration race only stops this loop's await. Abort the execution-owned
    // signal too so the detached worker cannot keep consuming capacity or mutate late.
    params.abortController.abort(error);
    return {
      workerCalls,
      totalTokensUsedDelta,
      timedOut: true,
      stoppedByUser: false,
      tokenBudgetExhausted: false,
    };
  }
}

async function finalizeAutomationRun(params: {
  runId: AutomationRunId;
  reason: Parameters<typeof stopAutomationRun>[0]["reason"];
  deps: AutomationRunnerDeps;
  config?: OpenClawConfig;
  summaryText?: string;
}): Promise<AutomationRunRecord | undefined> {
  const current = getAutomationRun(params.runId);
  if (!current || isAutomationRunTerminalState(current.state)) {
    return current;
  }

  const finalSummaryText = normalizeText(params.summaryText);
  const active = activeExecutions.get(params.runId);
  const stoppedByUser = isAutomationStoppedByUser(params.runId);
  const reason = stoppedByUser ? "stopped_by_user" : params.reason;
  const deliveryRun = {
    ...current,
    stopReason: reason,
    finalSummaryText,
  };
  // A max-duration result has no delivery budget left, and its execution signal
  // is already aborted. Preserve that terminal reason instead of racing delivery.
  if (
    reason !== "max_duration" &&
    !stoppedByUser &&
    active?.deliveryMode === "announce" &&
    params.deps.deliverFinalSummary
  ) {
    try {
      await waitWithTimeout({
        work: Promise.resolve(
          params.deps.deliverFinalSummary({
            run: deliveryRun,
            summaryText: buildAutomationFinalSummaryText({ run: deliveryRun }),
          }),
        ),
        timeoutMs: Math.min(
          resolveWorkerAwaitTimeoutMs(current, params.deps),
          resolveAutomationConfig(params.config).announceTimeoutMs,
        ),
        createError: () => new Error("automation final summary delivery timed out"),
        abortSignal: active.abortController.signal,
        createAbortError: () => new AutomationStoppedByUserError(),
      });
    } catch (error) {
      if (isAutomationStoppedByUser(params.runId, error)) {
        return stopAutomationRun({
          runId: params.runId,
          reason: "stopped_by_user",
          now: resolveNow(params.deps),
          finalSummaryText,
        });
      }
      return stopAutomationRun({
        runId: params.runId,
        reason: "error",
        now: resolveNow(params.deps),
        finalSummaryText: appendDeliveryError(
          finalSummaryText,
          `Final summary delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      });
    }
  }

  const stopped = stopAutomationRun({
    runId: params.runId,
    reason: isAutomationStoppedByUser(params.runId) ? "stopped_by_user" : reason,
    now: resolveNow(params.deps),
    finalSummaryText,
  });
  if (!stopped) {
    return undefined;
  }
  return stopped;
}

async function runAutomationLoop(params: {
  runId: AutomationRunId;
  config?: OpenClawConfig;
  deps: AutomationRunnerDeps;
  abortController: AbortController;
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
        config: params.config,
        summaryText: current.finalSummaryText ?? current.lastProgressText,
      });
      return;
    }

    const preTurnSnapshot = {
      workerTurnsUsed: current.workerTurnsUsed,
      maxTurns: current.stop.maxTurns,
      totalTokensUsed: current.totalTokensUsed,
      maxTokens: current.stop.maxTokens,
      elapsedSeconds: resolveElapsedSeconds(current, params.deps),
      maxDurationSeconds: current.stop.maxDurationSeconds,
    };
    const preTurnGuard = evaluateAutomationStopConditions(preTurnSnapshot);
    if (preTurnGuard.shouldStop) {
      await finalizeAutomationRun({
        runId: params.runId,
        reason: preTurnGuard.reason,
        deps: params.deps,
        config: params.config,
        summaryText: current.finalSummaryText ?? current.lastProgressText,
      });
      return;
    }

    const runningRecord =
      startAutomationRun(params.runId, { now: resolveNow(params.deps) }) ?? current;
    const consumedOperatorNote = runningRecord.pendingOperatorNote;

    const execution = await runWorkerTurnWithOptionalRetry({
      record: runningRecord,
      deps: params.deps,
      abortController: params.abortController,
    });

    let updated = recordAutomationRunWorkerTurn({
      runId: params.runId,
      workerCalls: execution.workerCalls,
      totalTokensUsedDelta: execution.totalTokensUsedDelta,
      lastProgressText: execution.result
        ? summarizeAutomationTurnProgress(execution.result)
        : undefined,
      config: params.config,
      now: resolveNow(params.deps),
    });
    if (!updated || isAutomationRunTerminalState(updated.state)) {
      return;
    }
    if (consumedOperatorNote) {
      updated =
        clearAutomationRunPendingOperatorNote(params.runId, consumedOperatorNote, {
          now: resolveNow(params.deps),
        }) ?? updated;
    }

    if (updated.state === "stopping") {
      await finalizeAutomationRun({
        runId: params.runId,
        reason: "stopped_by_user",
        deps: params.deps,
        config: params.config,
        summaryText: execution.result
          ? resolveAutomationFinalSummaryCandidate({
              record: updated,
              result: execution.result,
            })
          : (updated.finalSummaryText ?? updated.lastProgressText),
      });
      return;
    }

    if (execution.stoppedByUser) {
      await finalizeAutomationRun({
        runId: params.runId,
        reason: "stopped_by_user",
        deps: params.deps,
        config: params.config,
        summaryText: updated.finalSummaryText ?? updated.lastProgressText,
      });
      return;
    }

    if (execution.timedOut) {
      await finalizeAutomationRun({
        runId: params.runId,
        reason: "max_duration",
        deps: params.deps,
        config: params.config,
        summaryText: updated.finalSummaryText ?? updated.lastProgressText,
      });
      return;
    }

    if (execution.tokenBudgetExhausted) {
      await finalizeAutomationRun({
        runId: params.runId,
        reason: "max_tokens",
        deps: params.deps,
        config: params.config,
        summaryText: updated.finalSummaryText ?? updated.lastProgressText,
      });
      return;
    }

    const turnResult = execution.result;
    if (!turnResult) {
      return;
    }

    const explicitStopReason = resolveAutomationOutcomeStopReason({
      completed: turnResult.completed,
      blocked: turnResult.blocked,
      approvalRequired: turnResult.approvalRequired,
      errored: turnResult.errored,
    });
    const finalSummaryCandidate = resolveAutomationFinalSummaryCandidate({
      record: updated,
      result: turnResult,
    });
    const turnOutcome = resolveAutomationTurnOutcome({
      explicitStopReason,
    });
    const turnUpdateText = resolveAutomationTurnUpdateText({ record: updated, result: turnResult });
    const active = activeExecutions.get(params.runId);
    if (active?.deliveryMode === "announce" && params.deps.deliverTurnUpdate && turnUpdateText) {
      try {
        await waitWithTimeout({
          work: Promise.resolve(
            params.deps.deliverTurnUpdate({
              run: updated,
              updateText: buildAutomationTurnUpdateText({
                run: updated,
                outcome: turnOutcome,
                resultText: turnUpdateText,
              }),
            }),
          ),
          timeoutMs: Math.min(
            resolveWorkerAwaitTimeoutMs(updated, params.deps),
            resolveAutomationConfig(params.config).announceTimeoutMs,
          ),
          createError: () => new Error("automation turn update delivery timed out"),
          abortSignal: active.abortController.signal,
          createAbortError: () => new AutomationStoppedByUserError(),
        });
      } catch (error: unknown) {
        if (isAutomationStoppedByUser(params.runId, error)) {
          await finalizeAutomationRun({
            runId: params.runId,
            reason: "stopped_by_user",
            deps: params.deps,
            config: params.config,
            summaryText: finalSummaryCandidate,
          });
          return;
        }
        await finalizeAutomationRun({
          runId: params.runId,
          reason: "error",
          deps: params.deps,
          config: params.config,
          summaryText: appendDeliveryError(
            finalSummaryCandidate,
            `Turn update delivery failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        });
        return;
      }
    }

    if (explicitStopReason) {
      await finalizeAutomationRun({
        runId: params.runId,
        reason: explicitStopReason,
        deps: params.deps,
        config: params.config,
        summaryText: finalSummaryCandidate,
      });
      return;
    }

    const postTurnSnapshot = {
      workerTurnsUsed: updated.workerTurnsUsed,
      maxTurns: updated.stop.maxTurns,
      totalTokensUsed: updated.totalTokensUsed,
      maxTokens: updated.stop.maxTokens,
      elapsedSeconds: resolveElapsedSeconds(updated, params.deps),
      maxDurationSeconds: updated.stop.maxDurationSeconds,
    };
    const postTurnGuard = evaluateAutomationStopConditions(postTurnSnapshot);
    if (postTurnGuard.shouldStop) {
      await finalizeAutomationRun({
        runId: params.runId,
        reason: postTurnGuard.reason,
        deps: params.deps,
        config: params.config,
        summaryText: finalSummaryCandidate,
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
}): AutomationRunStartResult {
  const maxConcurrent = resolveAutomationConfig(params.config).maxConcurrent;
  const capacityExecutions = listCapacityExecutions();
  if (capacityExecutions.length >= maxConcurrent) {
    return {
      status: "capacity",
      activeCount: capacityExecutions.length,
      maxConcurrent,
      activeRunIds: capacityExecutions.map(([runId]) => runId),
    };
  }
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
  const kickResult = kickAutomationRun({
    runId: record.runId,
    deps: runnerDeps,
    config: params.config,
  });
  if (kickResult.status !== "started") {
    throw new Error(`automation run ${record.runId} was not admitted after capacity reservation`);
  }
  return { status: "started", run: record };
}

export function kickAutomationRun(params: {
  runId: AutomationRunId;
  config?: OpenClawConfig;
  deps: AutomationRunnerDeps;
}): AutomationRunKickResult {
  if (activeExecutions.has(params.runId)) {
    return { status: "already_active" };
  }
  const maxConcurrent = resolveAutomationConfig(params.config).maxConcurrent;
  const capacityExecutions = listCapacityExecutions();
  if (capacityExecutions.length >= maxConcurrent) {
    return {
      status: "capacity",
      activeCount: capacityExecutions.length,
      maxConcurrent,
      activeRunIds: capacityExecutions.map(([runId]) => runId),
    };
  }
  const schedule = params.deps.schedule ?? defaultSchedule;
  const abortController = new AbortController();
  const promise = new Promise<void>((resolve) => {
    schedule(() => {
      void runAutomationLoop({ ...params, abortController })
        .catch(async (error: unknown) => {
          const record = getAutomationRun(params.runId);
          if (record && !isAutomationRunTerminalState(record.state)) {
            await finalizeAutomationRun({
              runId: params.runId,
              reason: "error",
              deps: params.deps,
              config: params.config,
              summaryText: error instanceof Error ? error.message : String(error),
            });
          }
        })
        .finally(async () => {
          const workerSettlement = pendingWorkerSettlements.get(abortController);
          if (workerSettlement) {
            // Cancellation does not prove that a provider stopped. Fail closed
            // until actual settlement; a gateway owner can restart explicitly,
            // and startup reconciliation terminalizes the orphaned registry row.
            await workerSettlement;
            pendingWorkerSettlements.delete(abortController);
          }
          activeExecutions.delete(params.runId);
          resolve();
        });
    });
  });
  activeExecutions.set(params.runId, {
    promise,
    deliveryMode: "announce",
    abortController,
  });
  return { status: "started" };
}

export function requestAutomationRunStop(
  runId: AutomationRunId,
  options?: { now?: number },
): AutomationRunRecord | undefined {
  const record = markAutomationRunStopping(runId, options);
  if (record?.state === "stopping") {
    const active = activeExecutions.get(runId);
    if (active) {
      active.abortController.abort(new AutomationStoppedByUserError());
    }
  }
  return record;
}

export function isAutomationRunActive(runId: AutomationRunId): boolean {
  return activeExecutions.has(runId);
}

export async function waitForAutomationRunToSettle(runId: AutomationRunId): Promise<void> {
  await activeExecutions.get(runId)?.promise;
}

export function resetAutomationRunnerForTests(): void {
  for (const active of activeExecutions.values()) {
    active.abortController.abort(new AutomationStoppedByUserError());
  }
  activeExecutions.clear();
}
