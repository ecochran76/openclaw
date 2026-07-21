const CONTROL_RESULTS = ["completed", "progress", "blocked", "approval_required", "error"] as const;

type ControlResult = (typeof CONTROL_RESULTS)[number];

export type AutomationWorkerRunResult = {
  status?: string;
  error?: string;
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
    /^RESULT:[ \t]*(completed|progress|blocked|approval_required|error)[ \t]*(?:\r?\n|$)/i,
  );
  if (!match) {
    return { body: normalized };
  }
  const control = match[1]?.toLowerCase() as ControlResult;
  const body = normalized.slice(match[0].length).trim();
  return { control, body: body || undefined };
}

function normalizeUsageTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function resolveTotalTokensUsedDelta(
  usage: AutomationWorkerRunResult["usage"],
): number | undefined {
  if (!usage) {
    return undefined;
  }
  if (usage.total_tokens !== undefined) {
    return normalizeUsageTokenCount(usage.total_tokens);
  }
  if (usage.input_tokens === undefined && usage.output_tokens === undefined) {
    return undefined;
  }
  const inputTokens = normalizeUsageTokenCount(usage.input_tokens);
  const outputTokens = normalizeUsageTokenCount(usage.output_tokens);
  if (
    (usage.input_tokens !== undefined && inputTokens === undefined) ||
    (usage.output_tokens !== undefined && outputTokens === undefined)
  ) {
    return undefined;
  }
  return (inputTokens ?? 0) + (outputTokens ?? 0);
}

export function mapRunResultToWorkerTurnResult(
  result: AutomationWorkerRunResult,
): AutomationWorkerTurnResultShape {
  const rawText = result.outputText?.trim() || result.summary?.trim() || undefined;
  const parsed = parseWorkerControlResult(rawText);
  // The control line is protocol metadata, never user-visible result text.
  const outputText = parsed.control ? parsed.body : rawText;
  const totalTokensUsedDelta = resolveTotalTokensUsedDelta(result.usage);

  if (result.status === "error") {
    return {
      outputText: result.error?.trim() || outputText,
      totalTokensUsedDelta,
      errored: true,
    };
  }

  switch (parsed.control) {
    case "completed":
      return { outputText, finalSummaryText: outputText, totalTokensUsedDelta, completed: true };
    case "progress":
      return { outputText, progressText: outputText, totalTokensUsedDelta };
    case "blocked":
      return { outputText, totalTokensUsedDelta, blocked: true };
    case "approval_required":
      return { outputText, totalTokensUsedDelta, approvalRequired: true };
    case "error":
      return { outputText, totalTokensUsedDelta, errored: true };
    default:
      // Missing control metadata is not proof that the requested work is done.
      // Keep the result unclassified so the runner can retry interim acknowledgements
      // or continue within the remaining automation budget.
      return { outputText, totalTokensUsedDelta };
  }
}
