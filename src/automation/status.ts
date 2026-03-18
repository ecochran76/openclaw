import { buildAutomationStatusView } from "./registry.js";
import { normalizeAutomationStopReason } from "./stop-conditions.js";
import type { AutomationRunRecord, AutomationStatusView } from "./types.js";

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

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
  }
  return `${value}`;
}

export function formatAutomationStopReason(reason?: string | null): string {
  switch (normalizeAutomationStopReason(reason)) {
    case "approval_required":
      return "approval required";
    case "max_turns":
      return "max turns";
    case "max_tokens":
      return "max tokens";
    case "max_duration":
      return "max duration";
    case "stopped_by_user":
      return "stopped by user";
    case "error":
      return "error";
    case "completed":
      return "completed";
    case "blocked":
      return "blocked";
    default:
      return "running";
  }
}

function resolveRunLabel(view: AutomationStatusView, index?: number): string {
  const label = view.label ?? view.runId;
  return index ? `#${index} (${label})` : label;
}

function resolveListStatus(view: AutomationStatusView): string {
  if (view.state === "running" || view.state === "queued" || view.state === "stopping") {
    return view.state;
  }
  return `stopped (${formatAutomationStopReason(view.stopReason)})`;
}

export function buildAutomationListText(params: {
  runs: AutomationRunRecord[];
  now?: number;
}): string {
  const now = params.now ?? Date.now();
  const lines = ["🤖 Automation runs"];
  if (params.runs.length === 0) {
    lines.push("(none)");
    return lines.join("\n");
  }
  params.runs.forEach((record, index) => {
    const view = buildAutomationStatusView({ record, now });
    const label = view.label ?? view.runId;
    lines.push(
      `${index + 1}. ${label} — ${resolveListStatus(view)} — ${view.workerTurnsUsed}/${view.maxTurns} turns — ${formatDuration(view.elapsedSeconds)}`,
    );
  });
  return lines.join("\n");
}

export function buildAutomationStatusText(params: {
  run: AutomationRunRecord | AutomationStatusView;
  now?: number;
  index?: number;
  goal?: string;
}): string {
  const view =
    "goal" in params.run
      ? buildAutomationStatusView({ record: params.run, now: params.now })
      : params.run;
  const goal = "goal" in params.run ? params.run.goal : params.goal;
  const lines = [
    "🤖 Automation status",
    `Run: ${resolveRunLabel(view, params.index)}`,
    `State: ${view.state}`,
  ];
  if (view.stopReason) {
    lines.push(`Reason: ${formatAutomationStopReason(view.stopReason)}`);
  }
  if (goal) {
    lines.push(`Goal: ${goal}`);
  }
  lines.push(`Turns: ${view.workerTurnsUsed} / ${view.maxTurns} worker turns`);
  lines.push(`Tokens: ${formatTokens(view.totalTokensUsed)} / ${formatTokens(view.maxTokens)}`);
  lines.push(
    `Duration: ${formatDuration(view.elapsedSeconds)} / ${formatDuration(view.maxDurationSeconds)}`,
  );
  if (view.lastProgressText) {
    lines.push(`Last progress: ${view.lastProgressText}`);
  }
  lines.push("Next stop guards: max_turns, max_tokens, max_duration, approval_required");
  if (view.childSessionKey) {
    lines.push(`Session: ${view.childSessionKey}`);
  }
  return lines.join("\n");
}

export function buildAutomationFinalSummaryText(params: {
  run: AutomationRunRecord | AutomationStatusView;
  now?: number;
  index?: number;
}): string {
  const view =
    "goal" in params.run
      ? buildAutomationStatusView({ record: params.run, now: params.now })
      : params.run;
  const headline =
    view.stopReason === "stopped_by_user" ? "🤖 Automation stopped" : "🤖 Automation finished";
  const lines = [headline, `Run: ${resolveRunLabel(view, params.index)}`];
  if (view.stopReason) {
    lines.push(`Reason: ${formatAutomationStopReason(view.stopReason)}`);
  }
  if (view.finalSummaryText) {
    lines.push("Done:");
    lines.push(view.finalSummaryText);
  }
  lines.push(
    `Usage: ${view.workerTurnsUsed} worker turns · ${formatTokens(view.totalTokensUsed)} tokens · ${formatDuration(view.elapsedSeconds)}`,
  );
  return lines.join("\n");
}

export function buildAutomationCompactStatusLine(params: {
  run: AutomationRunRecord | AutomationStatusView;
  now?: number;
  index?: number;
}): string {
  const view =
    "goal" in params.run
      ? buildAutomationStatusView({ record: params.run, now: params.now })
      : params.run;
  return `🤖 Automation: ${resolveRunLabel(view, params.index)} · ${resolveListStatus(view)} · ${view.workerTurnsUsed}/${view.maxTurns} turns · ${formatDuration(view.elapsedSeconds)}`;
}
