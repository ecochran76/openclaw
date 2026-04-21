const CONTROL_RESULTS = ["completed", "progress", "blocked", "approval_required", "error"] as const;

type ControlResult = (typeof CONTROL_RESULTS)[number];

export type AutomationWorkerRunResult = {
  status?: string;
  outputText?: string;
  summary?: string;
  usage?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
};

export type AutomationWorkerTurnResultShape = {
  outputText?: string;
  progressText?: string;
  finalSummaryText?: string;
  totalTokensUsedDelta?: number;
  completed?: boolean;
  blocked?: boolean;
  approvalRequired?: boolean;
  errored?: boolean;
};

function parseWorkerControlResult(text?: string): {
  control?: ControlResult;
  body?: string;
} {
  const normalized = text?.trim();
  if (!normalized) {
    return {};
  }
  const match = normalized.match(
    /^RESULT:\s*(completed|progress|blocked|approval_required|error)\s*\n?/i,
  );
  if (!match) {
    return { body: normalized };
  }
  const control = match[1]?.toLowerCase() as ControlResult;
  const body = normalized.slice(match[0].length).trim();
  return { control, body: body || undefined };
}

export function mapRunResultToWorkerTurnResult(
  result: AutomationWorkerRunResult,
): AutomationWorkerTurnResultShape {
  const rawText = result.outputText?.trim() || result.summary?.trim() || undefined;
  const parsed = parseWorkerControlResult(rawText);
  const outputText = parsed.body ?? rawText;
  const totalTokensCandidate =
    result.usage?.total_tokens ??
    (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0);
  const totalTokensUsedDelta = totalTokensCandidate > 0 ? totalTokensCandidate : undefined;

  if (result.status === "error") {
    // Isolated runs can surface recovered tool warnings as an overall "error"
    // while still returning a structured worker result body. For automation,
    // trust an explicit control line when the worker produced substantive text.
    if (parsed.control && outputText) {
      switch (parsed.control) {
        case "progress":
          return { outputText, progressText: outputText, totalTokensUsedDelta };
        case "blocked":
          return { outputText, totalTokensUsedDelta, blocked: true };
        case "approval_required":
          return { outputText, totalTokensUsedDelta, approvalRequired: true };
        case "error":
          return { outputText, totalTokensUsedDelta, errored: true };
        case "completed":
        default:
          return {
            outputText,
            finalSummaryText: outputText,
            totalTokensUsedDelta,
            completed: true,
          };
      }
    }
    return {
      outputText,
      totalTokensUsedDelta,
      errored: true,
    };
  }

  switch (parsed.control) {
    case "progress":
      return { outputText, progressText: outputText, totalTokensUsedDelta };
    case "blocked":
      return { outputText, totalTokensUsedDelta, blocked: true };
    case "approval_required":
      return { outputText, totalTokensUsedDelta, approvalRequired: true };
    case "error":
      return { outputText, totalTokensUsedDelta, errored: true };
    case "completed":
    default:
      return { outputText, finalSummaryText: outputText, totalTokensUsedDelta, completed: true };
  }
}
