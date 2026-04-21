import type { AutomationRunRecord, AutomationStopReason } from "./types.js";
import type { AutomationWorkerTurnResultShape } from "./worker-result.js";

function normalizeText(value?: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function summarizeAutomationTurnProgress(
  result: AutomationWorkerTurnResultShape,
): string | undefined {
  const text = normalizeText(result.progressText) ?? normalizeText(result.outputText);
  if (!text) {
    return undefined;
  }
  return text.length <= 280 ? text : `${text.slice(0, 277)}...`;
}

export function looksAutomationWorkerSelfReportedIncomplete(text?: string | null): boolean {
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

export function resolveAutomationFinalSummaryCandidate(params: {
  record: AutomationRunRecord;
  result?: AutomationWorkerTurnResultShape;
}): string | undefined {
  return (
    normalizeText(params.result?.finalSummaryText) ??
    normalizeText(params.result?.outputText) ??
    normalizeText(params.result?.progressText) ??
    normalizeText(params.record.finalSummaryText) ??
    normalizeText(params.record.lastProgressText)
  );
}

export function resolveAutomationTurnUpdateText(params: {
  record: AutomationRunRecord;
  result?: AutomationWorkerTurnResultShape;
}): string | undefined {
  return (
    normalizeText(params.result?.outputText) ??
    normalizeText(params.result?.progressText) ??
    normalizeText(params.result?.finalSummaryText) ??
    normalizeText(params.record.lastProgressText) ??
    normalizeText(params.record.finalSummaryText)
  );
}

export function resolveAutomationTurnOutcome(params: {
  explicitStopReason?: AutomationStopReason;
  finalSummaryCandidate?: string;
}): {
  outcome: AutomationStopReason | "progress";
  selfReportedIncomplete: boolean;
} {
  const selfReportedIncomplete =
    params.explicitStopReason === "completed" &&
    looksAutomationWorkerSelfReportedIncomplete(params.finalSummaryCandidate);
  return {
    outcome: selfReportedIncomplete ? "progress" : (params.explicitStopReason ?? "progress"),
    selfReportedIncomplete,
  };
}
