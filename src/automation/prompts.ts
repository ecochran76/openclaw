import type { AutomationBudgetRemaining } from "./stop-conditions.js";
import type { AutomationStopSpec } from "./types.js";

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

function formatOptionalBlock(label: string, value?: string | null): string[] {
  const normalized = value?.trim();
  return normalized ? [`${label}: ${normalized}`] : [];
}

export function buildAutomationClassificationGuidanceText(): string {
  return [
    "Do not send an interim acknowledgement.",
    "Either:",
    "- complete the task,",
    "- stop with an explicit blocker,",
    "- stop because approval is needed, or",
    "- do exactly the next best step.",
    "Use RESULT: completed only when the original goal is fully satisfied.",
    "If you finished one slice but there is still obvious in-scope work left and budget remains, use RESULT: progress instead.",
    "Do not return RESULT: completed just because you reached a coherent stopping point for this turn.",
  ].join("\n");
}

export function buildAutomationInitialPrompt(params: {
  goal: string;
  stop: Required<AutomationStopSpec>;
  steeringNote?: string | null;
}): string {
  const lines = [
    "Automation run.",
    `Goal: ${params.goal.trim()}`,
    `Bounds: maxTurns=${params.stop.maxTurns}, maxTokens=${params.stop.maxTokens}, maxDurationSeconds=${params.stop.maxDurationSeconds}`,
    "Rules:",
    "- Work toward the goal directly.",
    "- Do not send an interim acknowledgement.",
    "- If you finish, return the final result clearly.",
    "- If you are blocked, say exactly what is blocking you.",
    "- If you need human approval for a consequential action, stop and say so.",
    "- If there is still obvious in-scope work left for another turn, return RESULT: progress instead of RESULT: completed.",
  ];
  if (params.steeringNote?.trim()) {
    lines.push(`Operator note: ${params.steeringNote.trim()}`);
  }
  return lines.join("\n");
}

export function buildAutomationContinuationPrompt(params: {
  goal: string;
  completedSoFar?: string | null;
  latestResult?: string | null;
  remaining: AutomationBudgetRemaining;
  steeringNote?: string | null;
}): string {
  const lines = [
    "Continue the same automation run.",
    `Original goal: ${params.goal.trim()}`,
    ...formatOptionalBlock("Completed so far", params.completedSoFar),
    ...formatOptionalBlock("Latest result", params.latestResult),
    `Remaining budgets: turns=${params.remaining.turns}, tokens=${params.remaining.tokens}, duration=${formatDuration(params.remaining.durationSeconds)}`,
  ];
  if (params.steeringNote?.trim()) {
    lines.push(`Operator note: ${params.steeringNote.trim()}`);
  }
  lines.push(buildAutomationClassificationGuidanceText());
  return lines.join("\n");
}

export function buildAutomationInterimAckFollowupPrompt(): string {
  return [
    "Your previous response was only an acknowledgement and did not complete this automation run.",
    "Complete the original goal now.",
    "Do not send a status update like 'on it'.",
    "Return either the substantive next result, a clear blocker, or a clear statement that approval is required.",
  ].join(" ");
}

export function buildAutomationSummarySynthesisPrompt(params: {
  goal: string;
  latestResult?: string | null;
  transcriptExcerpt: string;
}): string {
  const lines = [
    "Summarize this automation run for final delivery.",
    `Original goal: ${params.goal.trim()}`,
    ...formatOptionalBlock("Latest result", params.latestResult),
    "Write a concise bullet list of completed work. Do not invent work that is not present.",
    "Evidence:",
    params.transcriptExcerpt.trim(),
  ];
  return lines.join("\n");
}
