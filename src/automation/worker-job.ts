import type { AgentStreamParams } from "../agents/command/shared-types.js";
import { estimateTokensFromChars } from "../utils/cjk-chars.js";
import type { AutomationWorkerTurnInput } from "./runner.js";

export type AutomationWorkerJob = ReturnType<typeof buildAutomationWorkerJob>;
export type AutomationWorkerExecution = ReturnType<typeof buildAutomationWorkerExecution>;

export class AutomationWorkerPromptBudgetExceededError extends Error {
  constructor() {
    super("automation worker prompt exhausts the remaining total-token budget");
    this.name = "AutomationWorkerPromptBudgetExceededError";
  }
}

export function buildAutomationWorkerControlPrompt(prompt: string): string {
  return [
    prompt.trim(),
    "",
    "Return format requirements:",
    "- First line must be exactly one of: RESULT: completed, RESULT: progress, RESULT: blocked, RESULT: approval_required, RESULT: error",
    "- After the first line, include only the substantive result text.",
    "- Use RESULT: progress only when there is meaningful progress and another worker turn is still needed.",
  ].join("\n");
}

export function estimateAutomationWorkerPromptTokens(prompt: string): number {
  return estimateTokensFromChars(buildAutomationWorkerControlPrompt(prompt).length);
}

export function buildAutomationWorkerJob(input: AutomationWorkerTurnInput, now = Date.now()) {
  return {
    id: `automation-${input.runId}-${input.turnIndex}`,
    sessionKey: input.childSessionKey,
    name: input.label?.trim() || `Automation ${input.runId}`,
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "at", at: new Date(now).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: buildAutomationWorkerControlPrompt(input.prompt),
      model: input.model,
      thinking: input.thinking,
      // Carry the remaining automation deadline into the actual agent turn so
      // the runner's timeout does not leave an unbounded worker running behind it.
      timeoutSeconds: Math.max(1, Math.ceil(input.remaining.durationSeconds)),
    },
    delivery: { mode: "none" },
    state: {},
  };
}

export function buildAutomationWorkerExecution(
  input: AutomationWorkerTurnInput,
  now = Date.now(),
): { job: AutomationWorkerJob; streamParams: AgentStreamParams } {
  const remainingTokens = Math.max(0, Math.trunc(input.remaining.tokens));
  if (estimateAutomationWorkerPromptTokens(input.prompt) >= remainingTokens) {
    throw new AutomationWorkerPromptBudgetExceededError();
  }
  return {
    job: buildAutomationWorkerJob(input, now),
    streamParams: {
      // The embedded runner computes the complete rendered input (system prompt,
      // history, request, and tools) before dispatch and clamps output to this total.
      maxTokens: remainingTokens,
      maxTotalTokens: remainingTokens,
    },
  };
}
