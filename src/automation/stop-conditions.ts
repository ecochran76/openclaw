import type { AutomationStopReason } from "./types.js";

export type AutomationBudgetSnapshot = {
  workerTurnsUsed: number;
  maxTurns: number;
  totalTokensUsed: number;
  maxTokens: number;
  elapsedSeconds: number;
  maxDurationSeconds: number;
};

export type AutomationBudgetRemaining = {
  turns: number;
  tokens: number;
  durationSeconds: number;
};

export const LEGACY_AUTOMATION_STOP_REASON_ALIASES = {
  approval_needed: "approval_required",
  worker_error: "error",
} as const;

const CANONICAL_AUTOMATION_STOP_REASONS = new Set<AutomationStopReason>([
  "completed",
  "blocked",
  "approval_required",
  "max_turns",
  "max_tokens",
  "max_duration",
  "stopped_by_user",
  "error",
]);

export function normalizeAutomationStopReason(
  value?: string | null,
): AutomationStopReason | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized in LEGACY_AUTOMATION_STOP_REASON_ALIASES) {
    return LEGACY_AUTOMATION_STOP_REASON_ALIASES[
      normalized as keyof typeof LEGACY_AUTOMATION_STOP_REASON_ALIASES
    ];
  }
  return CANONICAL_AUTOMATION_STOP_REASONS.has(normalized as AutomationStopReason)
    ? (normalized as AutomationStopReason)
    : undefined;
}

export function resolveAutomationOutcomeStopReason(params: {
  completed?: boolean;
  blocked?: boolean;
  approvalRequired?: boolean;
  errored?: boolean;
}): AutomationStopReason | undefined {
  if (params.errored) {
    return "error";
  }
  if (params.approvalRequired) {
    return "approval_required";
  }
  if (params.blocked) {
    return "blocked";
  }
  if (params.completed) {
    return "completed";
  }
  return undefined;
}

export function evaluateAutomationStopConditions(snapshot: AutomationBudgetSnapshot):
  | { shouldStop: false; remaining: AutomationBudgetRemaining }
  | {
      shouldStop: true;
      reason: Extract<AutomationStopReason, "max_turns" | "max_tokens" | "max_duration">;
      remaining: AutomationBudgetRemaining;
    } {
  const remaining = resolveAutomationBudgetRemaining(snapshot);
  if (remaining.turns <= 0) {
    return { shouldStop: true, reason: "max_turns", remaining };
  }
  if (remaining.tokens <= 0) {
    return { shouldStop: true, reason: "max_tokens", remaining };
  }
  if (remaining.durationSeconds <= 0) {
    return { shouldStop: true, reason: "max_duration", remaining };
  }
  return { shouldStop: false, remaining };
}

export function resolveAutomationBudgetRemaining(
  snapshot: AutomationBudgetSnapshot,
): AutomationBudgetRemaining {
  return {
    turns: Math.max(0, snapshot.maxTurns - snapshot.workerTurnsUsed),
    tokens: Math.max(0, snapshot.maxTokens - snapshot.totalTokensUsed),
    durationSeconds: Math.max(0, snapshot.maxDurationSeconds - snapshot.elapsedSeconds),
  };
}
