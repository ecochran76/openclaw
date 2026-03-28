import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import type {
  UsagePolicyConfig,
  UsagePolicyRules,
  UsageThresholdRule,
} from "../config/types.auth.js";
import type { UsageWindow } from "./provider-usage.types.js";

const DEFAULT_REFRESH_MINUTES = 15;
const DEFAULT_STALE_AFTER_MINUTES = 20;
const DEFAULT_STALE_BEHAVIOR = "allow" as const;
const DEFAULT_NO_SWITCH_TARGET = "warn" as const;

export type UsagePolicyProfileSelectionSource = "auto" | "user" | "none";
export type UsagePolicyDecisionAction = "allow" | "warn" | "switch" | "stop";
export type UsagePolicyDecisionReason = "threshold" | "stale" | "no-data" | "unsupported";
export type UsagePolicyRuleKind = "warn" | "stop" | "switch";
export type UsagePolicyRuleScope = "default" | "provider" | "profile" | "none";
export type UsagePolicySurface = "status" | "sessionStatus" | "preflightNotice";

export type CachedProfileUsageState = {
  provider: string;
  profileId: string;
  updatedAt: number;
  windows: UsageWindow[];
  plan?: string;
  error?: string;
  lastAlertAt?: Record<string, number>;
};

export type ResolvedUsagePolicyRules = {
  policy?: UsagePolicyConfig;
  scope: UsagePolicyRuleScope;
  rules?: UsagePolicyRules;
};

export type UsagePolicyRuleMatch = {
  kind: UsagePolicyRuleKind;
  window: string;
  threshold: number;
  remainingPercent: number;
  usedPercent: number;
  resetAt?: number;
};

export type UsagePolicyDecision = {
  action: UsagePolicyDecisionAction;
  reason: UsagePolicyDecisionReason;
  scope: UsagePolicyRuleScope;
  provider: string;
  profileId?: string;
  selectionSource: UsagePolicyProfileSelectionSource;
  matched?: UsagePolicyRuleMatch;
  message?: string;
  updatedAt?: number;
  staleAfterMinutes?: number;
  onNoSwitchTarget?: "allow" | "warn" | "stop";
  noSwitchTarget?: boolean;
};

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function resolveNormalizedProviderValue<T>(
  record: Record<string, T> | undefined,
  provider: string,
): T | undefined {
  const normalized = normalizeProviderId(provider);
  if (!normalized) {
    return undefined;
  }
  for (const [candidate, value] of Object.entries(record ?? {})) {
    if (normalizeProviderId(candidate) === normalized) {
      return value;
    }
  }
  return undefined;
}

export function canonicalizeUsageWindowLabel(label: string): string {
  const normalized = label.trim().toLowerCase().replace(/\s+/g, "");
  if (!normalized) {
    return "";
  }
  if (normalized === "week" || normalized === "weekly") {
    return "1w";
  }
  if (normalized === "day" || normalized === "daily") {
    return "1d";
  }
  if (normalized === "hour" || normalized === "hourly") {
    return "1h";
  }
  if (/^\d+[hdw]$/.test(normalized)) {
    return normalized;
  }
  return normalized;
}

function describeThresholdMessage(params: {
  action: UsagePolicyDecisionAction;
  profileId?: string;
  match: UsagePolicyRuleMatch;
}): string {
  const subject = params.profileId ? `Profile ${params.profileId}` : "Active profile";
  const remaining = `${params.match.remainingPercent}% left`;
  switch (params.action) {
    case "stop":
      return `${subject} reached the configured stop threshold for ${params.match.window} (${remaining}).`;
    case "switch":
      return `${subject} reached the configured switch threshold for ${params.match.window} (${remaining}).`;
    case "warn":
      return `${subject} is nearing its ${params.match.window} usage limit (${remaining}).`;
    default:
      return `${subject} usage is within configured thresholds.`;
  }
}

function describeStaleMessage(params: {
  action: UsagePolicyDecisionAction;
  profileId?: string;
  staleAfterMinutes: number;
}): string {
  const subject = params.profileId ? `Profile ${params.profileId}` : "Active profile";
  return `${subject} usage data is stale (older than ${params.staleAfterMinutes}m).`;
}

function pickBetterMatch(
  current: UsagePolicyRuleMatch | undefined,
  candidate: UsagePolicyRuleMatch,
): UsagePolicyRuleMatch {
  if (!current) {
    return candidate;
  }
  if (candidate.remainingPercent !== current.remainingPercent) {
    return candidate.remainingPercent < current.remainingPercent ? candidate : current;
  }
  if (candidate.threshold !== current.threshold) {
    return candidate.threshold < current.threshold ? candidate : current;
  }
  const currentReset = current.resetAt ?? Number.MAX_SAFE_INTEGER;
  const candidateReset = candidate.resetAt ?? Number.MAX_SAFE_INTEGER;
  if (candidateReset !== currentReset) {
    return candidateReset < currentReset ? candidate : current;
  }
  return candidate.window.localeCompare(current.window) < 0 ? candidate : current;
}

function findRuleMatch(params: {
  kind: UsagePolicyRuleKind;
  rules: UsageThresholdRule[] | undefined;
  windows: UsageWindow[];
}): UsagePolicyRuleMatch | undefined {
  let match: UsagePolicyRuleMatch | undefined;
  for (const rule of params.rules ?? []) {
    const ruleWindow = canonicalizeUsageWindowLabel(rule.window);
    if (!ruleWindow) {
      continue;
    }
    for (const window of params.windows) {
      if (canonicalizeUsageWindowLabel(window.label) !== ruleWindow) {
        continue;
      }
      const usedPercent = clampPercent(window.usedPercent);
      const remainingPercent = clampPercent(100 - usedPercent);
      if (remainingPercent > clampPercent(rule.remainingPercentLte)) {
        continue;
      }
      match = pickBetterMatch(match, {
        kind: params.kind,
        window: window.label,
        threshold: clampPercent(rule.remainingPercentLte),
        remainingPercent,
        usedPercent,
        resetAt: window.resetAt,
      });
    }
  }
  return match;
}

export function resolveUsagePolicyRules(params: {
  config?: OpenClawConfig;
  provider: string;
  profileId?: string;
}): ResolvedUsagePolicyRules {
  const policy = params.config?.auth?.usagePolicy;
  if (!policy || policy.enabled !== true) {
    return {
      policy,
      scope: "none",
    };
  }
  if (params.profileId) {
    const profileRules = policy.profiles?.[params.profileId];
    if (profileRules) {
      return { policy, scope: "profile", rules: profileRules };
    }
  }
  const providerRules = resolveNormalizedProviderValue(policy.providers, params.provider);
  if (providerRules) {
    return { policy, scope: "provider", rules: providerRules };
  }
  if (policy.defaults) {
    return { policy, scope: "default", rules: policy.defaults };
  }
  return { policy, scope: "none" };
}

export function resolveUsagePolicyRefreshMinutes(config?: OpenClawConfig): number {
  const minutes = config?.auth?.usagePolicy?.refreshMinutes;
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
    ? minutes
    : DEFAULT_REFRESH_MINUTES;
}

export function resolveUsagePolicyStaleAfterMinutes(config?: OpenClawConfig): number {
  const minutes = config?.auth?.usagePolicy?.staleAfterMinutes;
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
    ? minutes
    : DEFAULT_STALE_AFTER_MINUTES;
}

function resolveUsagePolicyStaleBehavior(config?: OpenClawConfig): "allow" | "warn" | "stop" {
  return config?.auth?.usagePolicy?.staleBehavior ?? DEFAULT_STALE_BEHAVIOR;
}

function resolveNoSwitchTargetBehavior(
  rules: UsagePolicyRules | undefined,
): "allow" | "warn" | "stop" {
  return rules?.onNoSwitchTarget ?? DEFAULT_NO_SWITCH_TARGET;
}

export function isUsagePolicySurfaceEnabled(params: {
  config?: OpenClawConfig;
  provider: string;
  profileId?: string;
  surface: UsagePolicySurface;
}): boolean {
  const resolved = resolveUsagePolicyRules({
    config: params.config,
    provider: params.provider,
    profileId: params.profileId,
  });
  if (!resolved.rules || resolved.scope === "none") {
    return false;
  }
  const surfaces = resolved.rules.surfaces;
  switch (params.surface) {
    case "preflightNotice":
      return surfaces?.preflightNotice === true;
    case "sessionStatus":
      return surfaces?.sessionStatus ?? true;
    case "status":
      return surfaces?.status ?? true;
    default:
      return false;
  }
}

export function formatUsagePolicyDecisionDetail(decision: UsagePolicyDecision): string | null {
  if (decision.reason === "stale") {
    const ageLabel =
      typeof decision.staleAfterMinutes === "number" ? ` (> ${decision.staleAfterMinutes}m)` : "";
    return `usage data is stale${ageLabel}`;
  }
  if (!decision.matched) {
    return null;
  }
  const thresholdLabel = `${decision.matched.window} ${decision.matched.remainingPercent}% left`;
  switch (decision.action) {
    case "warn":
      return `warning threshold matched (${thresholdLabel})`;
    case "switch":
      return `switch threshold matched (${thresholdLabel})`;
    case "stop":
      return `stop threshold matched (${thresholdLabel})`;
    default:
      return null;
  }
}

export function formatUsagePolicyDecisionLine(decision: UsagePolicyDecision): string | null {
  const detail = formatUsagePolicyDecisionDetail(decision);
  if (!detail) {
    return null;
  }
  const suffix = decision.noSwitchTarget
    ? " No eligible auth profile is available for automatic switching."
    : "";
  return `⚠️ Usage policy: ${detail}${suffix}`;
}

export function evaluateUsagePolicyDecision(params: {
  config?: OpenClawConfig;
  provider: string;
  profileId?: string;
  usage?: CachedProfileUsageState;
  now?: number;
  selectionSource?: UsagePolicyProfileSelectionSource;
}): UsagePolicyDecision {
  const selectionSource = params.selectionSource ?? "none";
  const resolved = resolveUsagePolicyRules({
    config: params.config,
    provider: params.provider,
    profileId: params.profileId,
  });
  const provider = normalizeProviderId(params.provider) || params.provider.trim();
  if (!resolved.rules || resolved.scope === "none") {
    return {
      action: "allow",
      reason: "unsupported",
      scope: "none",
      provider,
      profileId: params.profileId,
      selectionSource,
    };
  }

  const usage = params.usage;
  if (
    !usage ||
    normalizeProviderId(usage.provider) !== provider ||
    (params.profileId && usage.profileId !== params.profileId) ||
    usage.windows.length === 0 ||
    usage.error
  ) {
    return {
      action: "allow",
      reason: "no-data",
      scope: resolved.scope,
      provider,
      profileId: params.profileId,
      selectionSource,
      onNoSwitchTarget: resolveNoSwitchTargetBehavior(resolved.rules),
    };
  }

  const staleAfterMinutes = resolveUsagePolicyStaleAfterMinutes(params.config);
  const now = params.now ?? Date.now();
  if (usage.updatedAt + staleAfterMinutes * 60_000 < now) {
    const action = resolveUsagePolicyStaleBehavior(params.config);
    return {
      action,
      reason: "stale",
      scope: resolved.scope,
      provider,
      profileId: params.profileId,
      selectionSource,
      updatedAt: usage.updatedAt,
      staleAfterMinutes,
      onNoSwitchTarget: resolveNoSwitchTargetBehavior(resolved.rules),
      ...(action === "allow"
        ? {}
        : {
            message: describeStaleMessage({
              action,
              profileId: params.profileId,
              staleAfterMinutes,
            }),
          }),
    };
  }

  const respectUserOverride =
    selectionSource === "user" ? resolved.rules.respectUserOverride !== false : false;
  const stopMatch =
    // Manual /profile selections stay sticky by default. Only a profile-scoped
    // rule is explicit enough to stop a user-picked profile preflight.
    respectUserOverride && resolved.scope !== "profile"
      ? undefined
      : findRuleMatch({
          kind: "stop",
          rules: resolved.rules.stop,
          windows: usage.windows,
        });
  if (stopMatch) {
    return {
      action: "stop",
      reason: "threshold",
      scope: resolved.scope,
      provider,
      profileId: params.profileId,
      selectionSource,
      matched: stopMatch,
      message: describeThresholdMessage({
        action: "stop",
        profileId: params.profileId,
        match: stopMatch,
      }),
      updatedAt: usage.updatedAt,
      staleAfterMinutes,
      onNoSwitchTarget: resolveNoSwitchTargetBehavior(resolved.rules),
    };
  }

  const switchMatch = respectUserOverride
    ? undefined
    : findRuleMatch({
        kind: "switch",
        rules: resolved.rules.switch,
        windows: usage.windows,
      });
  if (switchMatch) {
    return {
      action: "switch",
      reason: "threshold",
      scope: resolved.scope,
      provider,
      profileId: params.profileId,
      selectionSource,
      matched: switchMatch,
      message: describeThresholdMessage({
        action: "switch",
        profileId: params.profileId,
        match: switchMatch,
      }),
      updatedAt: usage.updatedAt,
      staleAfterMinutes,
      onNoSwitchTarget: resolveNoSwitchTargetBehavior(resolved.rules),
    };
  }

  const warnMatch = findRuleMatch({
    kind: "warn",
    rules: resolved.rules.warn,
    windows: usage.windows,
  });
  if (warnMatch) {
    return {
      action: "warn",
      reason: "threshold",
      scope: resolved.scope,
      provider,
      profileId: params.profileId,
      selectionSource,
      matched: warnMatch,
      message: describeThresholdMessage({
        action: "warn",
        profileId: params.profileId,
        match: warnMatch,
      }),
      updatedAt: usage.updatedAt,
      staleAfterMinutes,
      onNoSwitchTarget: resolveNoSwitchTargetBehavior(resolved.rules),
    };
  }

  return {
    action: "allow",
    reason: "threshold",
    scope: resolved.scope,
    provider,
    profileId: params.profileId,
    selectionSource,
    updatedAt: usage.updatedAt,
    staleAfterMinutes,
    onNoSwitchTarget: resolveNoSwitchTargetBehavior(resolved.rules),
  };
}
