import type { AutomationWorkerTurnInput } from "./runner.js";

export type AutomationWorkerJob = ReturnType<typeof buildAutomationWorkerJob>;

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
      timeoutSeconds: 0,
    },
    delivery: { mode: "none" },
    state: {},
  };
}
