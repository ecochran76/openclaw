import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { AutomationRunSpec, AutomationStopSpec } from "./types.js";

export const DEFAULT_AUTOMATION_MAX_CONCURRENT = 1;
export const DEFAULT_AUTOMATION_MAX_TURNS = 6;
export const DEFAULT_AUTOMATION_MAX_TOKENS = 80_000;
export const DEFAULT_AUTOMATION_MAX_DURATION_SECONDS = 1_800;
export const DEFAULT_AUTOMATION_ANNOUNCE_TIMEOUT_MS = 90_000;

export type ResolvedAutomationConfig = {
  maxConcurrent: number;
  defaultMaxTurns: number;
  defaultMaxTokens: number;
  defaultMaxDurationSeconds: number;
  model?: string;
  thinking?: string;
  announceTimeoutMs: number;
};

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  const normalized = typeof value === "number" ? Math.trunc(value) : Number.NaN;
  return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
}

function normalizeOptionalText(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function resolveAutomationConfig(config?: OpenClawConfig): ResolvedAutomationConfig {
  const defaults = config?.agents?.defaults?.automation;
  return {
    maxConcurrent: normalizePositiveInteger(
      defaults?.maxConcurrent,
      DEFAULT_AUTOMATION_MAX_CONCURRENT,
    ),
    defaultMaxTurns: normalizePositiveInteger(
      defaults?.defaultMaxTurns,
      DEFAULT_AUTOMATION_MAX_TURNS,
    ),
    defaultMaxTokens: normalizePositiveInteger(
      defaults?.defaultMaxTokens,
      DEFAULT_AUTOMATION_MAX_TOKENS,
    ),
    defaultMaxDurationSeconds: normalizePositiveInteger(
      defaults?.defaultMaxDurationSeconds,
      DEFAULT_AUTOMATION_MAX_DURATION_SECONDS,
    ),
    model: resolveAgentModelPrimaryValue(defaults?.model),
    thinking: normalizeOptionalText(defaults?.thinking),
    announceTimeoutMs: normalizePositiveInteger(
      defaults?.announceTimeoutMs,
      DEFAULT_AUTOMATION_ANNOUNCE_TIMEOUT_MS,
    ),
  };
}

export function resolveAutomationStopSpec(
  stop?: AutomationStopSpec,
  config?: OpenClawConfig,
): Required<AutomationStopSpec> {
  const defaults = resolveAutomationConfig(config);
  return {
    maxTurns: normalizePositiveInteger(stop?.maxTurns, defaults.defaultMaxTurns),
    maxTokens: normalizePositiveInteger(stop?.maxTokens, defaults.defaultMaxTokens),
    maxDurationSeconds: normalizePositiveInteger(
      stop?.maxDurationSeconds,
      defaults.defaultMaxDurationSeconds,
    ),
  };
}

export function resolveAutomationRunSpec(params: {
  spec: AutomationRunSpec;
  config?: OpenClawConfig;
}): AutomationRunSpec & { stop: Required<AutomationStopSpec> } {
  const defaults = resolveAutomationConfig(params.config);
  return {
    ...params.spec,
    label: normalizeOptionalText(params.spec.label),
    goal: params.spec.goal,
    model: normalizeOptionalText(params.spec.model) ?? defaults.model,
    thinking: normalizeOptionalText(params.spec.thinking) ?? defaults.thinking,
    stop: resolveAutomationStopSpec(params.spec.stop, params.config),
    delivery: {
      mode: params.spec.delivery?.mode ?? "announce",
    },
  };
}
