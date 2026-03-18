export type AutomationRunId = string;

/** Human-facing target bounds for a bounded automation run. */
export type AutomationStopSpec = {
  maxTurns?: number;
  maxTokens?: number;
  maxDurationSeconds?: number;
};

/** User/tool-provided run request shape. */
export type AutomationRunSpec = {
  label?: string;
  goal: string;
  model?: string;
  thinking?: string;
  stop?: AutomationStopSpec;
  delivery?: {
    mode?: "announce";
  };
};

/** Stable stop reasons owned by the automation runtime. */
export type AutomationStopReason =
  | "completed"
  | "blocked"
  | "approval_required"
  | "max_turns"
  | "max_tokens"
  | "max_duration"
  | "stopped_by_user"
  | "error";

/** Internal lifecycle state for persisted run records. */
export type AutomationRunState =
  | "queued"
  | "running"
  | "stopping"
  | "stopped"
  | "completed"
  | "blocked"
  | "failed";

/** Internal persisted record shape for registry ownership. */
export type AutomationRunRecord = {
  runId: AutomationRunId;
  requesterSessionKey: string;
  childSessionKey: string;
  label?: string;
  goal: string;
  model?: string;
  thinking?: string;
  state: AutomationRunState;
  stop: Required<AutomationStopSpec>;
  stopReason?: AutomationStopReason | null;
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  endedAt?: number;
  workerTurnsUsed: number;
  totalTokensUsed: number;
  lastProgressText?: string;
  pendingOperatorNote?: string;
  finalSummaryText?: string;
};

/** Public status surface returned by tool/command handlers. */
export type AutomationStatusView = {
  runId: AutomationRunId;
  label?: string;
  state: AutomationRunState;
  stopReason?: AutomationStopReason | null;
  childSessionKey?: string;
  workerTurnsUsed: number;
  maxTurns: number;
  totalTokensUsed: number;
  maxTokens: number;
  elapsedSeconds: number;
  maxDurationSeconds: number;
  lastProgressText?: string;
  finalSummaryText?: string;
};
