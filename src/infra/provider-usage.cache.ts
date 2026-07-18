import { resolveRegisteredAgentIdForDir } from "../agents/agent-dir-registry.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  readProviderUsageCacheJson,
  resolveProviderUsageCacheDatabasePath,
  resolveProviderUsageCacheOwnerId,
  updateProviderUsageCacheJson,
} from "./provider-usage-cache.sqlite.js";
import { loadProviderUsageSummary, type UsageSummaryOptions } from "./provider-usage.load.js";
import {
  canonicalizeUsageWindowLabel,
  evaluateUsagePolicyDecision,
  type CachedProfileUsageState,
  type UsagePolicyDecision,
  type UsagePolicyProfileSelectionSource,
  type UsagePolicySurface,
} from "./provider-usage.policy.js";
import type { ProviderUsageSnapshot, UsageSummary, UsageWindow } from "./provider-usage.types.js";

type ProviderUsageCacheFile = {
  alertClaims: Record<string, number>;
  version: 1;
  profiles: Record<string, CachedProfileUsageState>;
};

const PROVIDER_USAGE_CACHE_VERSION = 1 as const;
const MAX_PROVIDER_USAGE_ALERT_CLAIMS = 1024;
const MAX_RUNTIME_USAGE_CACHE_SNAPSHOTS = 32;
const runtimeUsageCacheSnapshots = new Map<string, ProviderUsageCacheFile>();

function cloneUsageCacheFile(file: ProviderUsageCacheFile): ProviderUsageCacheFile {
  return structuredClone(file);
}

function normalizeUsageWindow(raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.label !== "string" || !record.label.trim()) {
    return null;
  }
  if (typeof record.usedPercent !== "number" || !Number.isFinite(record.usedPercent)) {
    return null;
  }
  return {
    label: record.label,
    usedPercent: record.usedPercent,
    resetAt:
      typeof record.resetAt === "number" && Number.isFinite(record.resetAt)
        ? record.resetAt
        : undefined,
  };
}

function normalizeCachedProfileUsageState(raw: unknown): CachedProfileUsageState | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.provider !== "string" || !record.provider.trim()) {
    return null;
  }
  if (typeof record.profileId !== "string" || !record.profileId.trim()) {
    return null;
  }
  if (typeof record.updatedAt !== "number" || !Number.isFinite(record.updatedAt)) {
    return null;
  }
  const windows = Array.isArray(record.windows)
    ? record.windows
        .map((window) => normalizeUsageWindow(window))
        .filter((window): window is UsageWindow => window !== null)
    : [];
  return {
    provider: record.provider,
    profileId: record.profileId,
    updatedAt: record.updatedAt,
    windows,
    plan: typeof record.plan === "string" ? record.plan : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
  };
}

function coerceProviderUsageCacheFile(raw: unknown): ProviderUsageCacheFile {
  if (!raw || typeof raw !== "object") {
    return {
      alertClaims: {},
      version: PROVIDER_USAGE_CACHE_VERSION,
      profiles: {},
    };
  }
  const record = raw as Record<string, unknown>;
  const profiles = Object.fromEntries(
    Object.entries(
      record.profiles && typeof record.profiles === "object"
        ? (record.profiles as Record<string, unknown>)
        : {},
    )
      .map(([key, value]) => {
        const normalized = normalizeCachedProfileUsageState(value);
        return normalized ? ([key, normalized] as const) : null;
      })
      .filter(
        (entry): entry is readonly [string, CachedProfileUsageState] =>
          entry !== null && typeof entry[0] === "string",
      ),
  );
  return {
    alertClaims:
      record.alertClaims && typeof record.alertClaims === "object"
        ? Object.fromEntries(
            Object.entries(record.alertClaims as Record<string, unknown>).filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === "number" && Number.isFinite(entry[1]),
            ),
          )
        : {},
    version: PROVIDER_USAGE_CACHE_VERSION,
    profiles,
  };
}

function resolveCacheEntryKey(params: { provider: string; profileId: string }): string {
  const normalizedProvider = normalizeProviderId(params.provider) || params.provider.trim();
  return `${normalizedProvider}::${params.profileId.trim()}`;
}

function resolveUsagePolicyClaimKey(params: {
  provider: string;
  profileId: string;
  alertKey: string;
}): string {
  return JSON.stringify([resolveCacheEntryKey(params), params.alertKey]);
}

export function pruneProviderUsageAlertClaims(params: {
  claims: Record<string, number>;
  maxEntries: number;
  protectedKey: string;
}): Record<string, number> {
  const maxEntries = Math.max(1, Math.trunc(params.maxEntries));
  const entries = Object.entries(params.claims);
  const removeCount = entries.length - maxEntries;
  if (removeCount <= 0) {
    return params.claims;
  }
  const oldest = entries.toSorted(([leftKey, leftAt], [rightKey, rightAt]) => {
    if (leftKey === rightKey) {
      return 0;
    }
    // The just-claimed key must survive this prune even when its decision
    // timestamp predates every claim already occupying the bounded cache.
    if (leftKey === params.protectedKey) {
      return 1;
    }
    if (rightKey === params.protectedKey) {
      return -1;
    }
    if (leftAt !== rightAt) {
      return leftAt - rightAt;
    }
    return leftKey.localeCompare(rightKey);
  });
  const removed = new Set(oldest.slice(0, removeCount).map(([key]) => key));
  return Object.fromEntries(
    entries
      .filter(([key]) => !removed.has(key))
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function buildCachedProfileUsageState(params: {
  profileId: string;
  updatedAt: number;
  snapshot: ProviderUsageSnapshot;
  existing?: CachedProfileUsageState;
}): CachedProfileUsageState {
  if (params.snapshot.error && params.existing) {
    // A transient refresh failure must not turn a usable cached sample into
    // no-data; policy evaluation treats any snapshot error as unavailable.
    return params.existing;
  }
  return {
    provider: params.snapshot.provider,
    profileId: params.profileId,
    updatedAt: params.updatedAt,
    windows: params.snapshot.windows.map((window) => ({
      label: window.label,
      usedPercent: window.usedPercent,
      resetAt: window.resetAt,
    })),
    plan: params.snapshot.plan,
    error: params.snapshot.error,
  };
}

function resolveUsagePolicyAlertKey(params: {
  surface: UsagePolicySurface;
  decision: UsagePolicyDecision;
}): string | null {
  if (
    typeof params.decision.updatedAt !== "number" ||
    !Number.isFinite(params.decision.updatedAt)
  ) {
    return null;
  }
  const matchedWindow = params.decision.matched?.window
    ? canonicalizeUsageWindowLabel(params.decision.matched.window)
    : "";
  const matchedThreshold =
    typeof params.decision.matched?.threshold === "number"
      ? String(params.decision.matched.threshold)
      : "";
  const staleAfter =
    typeof params.decision.staleAfterMinutes === "number"
      ? String(params.decision.staleAfterMinutes)
      : "";
  return [
    params.surface,
    params.decision.action,
    params.decision.reason,
    params.decision.scope,
    matchedWindow,
    matchedThreshold,
    staleAfter,
    params.decision.noSwitchTarget === true ? "no-switch-target" : "",
  ].join("|");
}

function buildUsageSummaryFromCachedStates(params: {
  states: CachedProfileUsageState[];
  providers?: string[];
}): UsageSummary {
  const states = params.providers?.length
    ? params.providers
        .map((provider) => {
          const normalizedProvider = normalizeProviderId(provider);
          return (
            params.states.find(
              (state) => normalizeProviderId(state.provider) === normalizedProvider,
            ) ?? null
          );
        })
        .filter((state): state is CachedProfileUsageState => state !== null)
    : params.states;
  return {
    updatedAt: states.reduce((max, state) => Math.max(max, state.updatedAt), 0),
    providers: states.map((state) => {
      const snapshot: ProviderUsageSnapshot = {
        provider: state.provider as ProviderUsageSnapshot["provider"],
        displayName: state.provider,
        windows: state.windows.map((window) => ({
          label: window.label,
          usedPercent: window.usedPercent,
          resetAt: window.resetAt,
        })),
      };
      if (state.plan) {
        snapshot.plan = state.plan;
      }
      if (state.error) {
        snapshot.error = state.error;
      }
      return snapshot;
    }),
  };
}

function parseProviderUsageCacheJson(raw: string | null): ProviderUsageCacheFile {
  if (!raw) {
    return coerceProviderUsageCacheFile(undefined);
  }
  try {
    return coerceProviderUsageCacheFile(JSON.parse(raw) as unknown);
  } catch {
    return coerceProviderUsageCacheFile(undefined);
  }
}

function resolveCacheIdentity(
  agentDir: string,
  agentId?: string,
): {
  pathname: string;
  agentId: string;
} {
  const registeredAgentId = agentId ?? resolveRegisteredAgentIdForDir(agentDir);
  return {
    pathname: resolveProviderUsageCacheDatabasePath(agentDir),
    agentId: resolveProviderUsageCacheOwnerId({ agentDir, agentId: registeredAgentId }),
  };
}

function publishRuntimeUsageCacheSnapshot(pathname: string, cache: ProviderUsageCacheFile): void {
  runtimeUsageCacheSnapshots.delete(pathname);
  runtimeUsageCacheSnapshots.set(pathname, cloneUsageCacheFile(cache));
  while (runtimeUsageCacheSnapshots.size > MAX_RUNTIME_USAGE_CACHE_SNAPSHOTS) {
    const oldestPathname = runtimeUsageCacheSnapshots.keys().next().value;
    if (typeof oldestPathname !== "string") {
      break;
    }
    runtimeUsageCacheSnapshots.delete(oldestPathname);
  }
}

async function loadProviderUsageCacheFileFresh(params: {
  agentDir: string;
  agentId: string;
}): Promise<ProviderUsageCacheFile> {
  const pathname = resolveProviderUsageCacheDatabasePath(params.agentDir);
  const parsed = parseProviderUsageCacheJson(readProviderUsageCacheJson(params));
  publishRuntimeUsageCacheSnapshot(pathname, parsed);
  return parsed;
}

export function clearRuntimeProviderUsageCacheSnapshots(): void {
  runtimeUsageCacheSnapshots.clear();
}

export function getCachedProfileUsageState(params: {
  agentDir: string;
  agentId?: string;
  provider: string;
  profileId: string;
}): CachedProfileUsageState | undefined {
  const pathname = resolveProviderUsageCacheDatabasePath(params.agentDir);
  const cache = runtimeUsageCacheSnapshots.get(pathname);
  if (!cache) {
    return undefined;
  }
  const entry = cache.profiles[resolveCacheEntryKey(params)];
  return entry ? structuredClone(entry) : undefined;
}

export async function readCachedProfileUsageState(params: {
  agentDir: string;
  agentId?: string;
  provider: string;
  profileId: string;
}): Promise<CachedProfileUsageState | undefined> {
  const identity = resolveCacheIdentity(params.agentDir, params.agentId);
  const cache = await loadProviderUsageCacheFileFresh({
    agentDir: params.agentDir,
    agentId: identity.agentId,
  });
  const entry = cache.profiles[resolveCacheEntryKey(params)];
  return entry ? structuredClone(entry) : undefined;
}

export async function readCachedProviderUsageSummary(params: {
  agentDir: string;
  agentId?: string;
  profileId: string;
  providers?: string[];
}): Promise<UsageSummary> {
  const identity = resolveCacheIdentity(params.agentDir, params.agentId);
  const cache = await loadProviderUsageCacheFileFresh({
    agentDir: params.agentDir,
    agentId: identity.agentId,
  });
  const states = Object.values(cache.profiles).filter(
    (state) => state.profileId === params.profileId,
  );
  return buildUsageSummaryFromCachedStates({
    states,
    providers: params.providers,
  });
}

export function getCachedUsagePolicyDecision(params: {
  config?: OpenClawConfig;
  agentDir: string;
  agentId?: string;
  provider: string;
  profileId: string;
  selectionSource?: UsagePolicyProfileSelectionSource;
  now?: number;
}): UsagePolicyDecision {
  return evaluateUsagePolicyDecision({
    config: params.config,
    provider: params.provider,
    profileId: params.profileId,
    usage: getCachedProfileUsageState({
      agentDir: params.agentDir,
      agentId: params.agentId,
      provider: params.provider,
      profileId: params.profileId,
    }),
    selectionSource: params.selectionSource,
    now: params.now,
  });
}

export async function readCachedUsagePolicyDecision(params: {
  config?: OpenClawConfig;
  agentDir: string;
  agentId?: string;
  provider: string;
  profileId: string;
  selectionSource?: UsagePolicyProfileSelectionSource;
  now?: number;
}): Promise<UsagePolicyDecision> {
  return evaluateUsagePolicyDecision({
    config: params.config,
    provider: params.provider,
    profileId: params.profileId,
    usage: await readCachedProfileUsageState({
      agentDir: params.agentDir,
      agentId: params.agentId,
      provider: params.provider,
      profileId: params.profileId,
    }),
    selectionSource: params.selectionSource,
    now: params.now,
  });
}

export async function writeCachedProviderUsageSummary(params: {
  agentDir: string;
  agentId?: string;
  profileId: string;
  summary: UsageSummary;
}): Promise<void> {
  if (!params.profileId.trim()) {
    return;
  }
  const identity = resolveCacheIdentity(params.agentDir, params.agentId);
  const updatedCache = updateProviderUsageCacheJson({
    agentDir: params.agentDir,
    agentId: identity.agentId,
    updatedAt: params.summary.updatedAt,
    update: (currentJson) => {
      const cache = parseProviderUsageCacheJson(currentJson);
      for (const snapshot of params.summary.providers) {
        const cacheEntryKey = resolveCacheEntryKey({
          provider: snapshot.provider,
          profileId: params.profileId,
        });
        const existing = cache.profiles[cacheEntryKey];
        if (existing && existing.updatedAt > params.summary.updatedAt) {
          continue;
        }
        cache.profiles[cacheEntryKey] = buildCachedProfileUsageState({
          profileId: params.profileId,
          updatedAt: params.summary.updatedAt,
          snapshot,
          existing,
        });
      }
      return { valueJson: JSON.stringify(cache), result: cache };
    },
  });
  publishRuntimeUsageCacheSnapshot(identity.pathname, updatedCache);
}

export async function claimCachedUsagePolicyAlert(params: {
  agentDir: string;
  agentId?: string;
  provider: string;
  profileId: string;
  surface: UsagePolicySurface;
  decision: UsagePolicyDecision;
}): Promise<boolean> {
  const alertKey = resolveUsagePolicyAlertKey({
    surface: params.surface,
    decision: params.decision,
  });
  if (!alertKey) {
    return true;
  }
  const alertUpdatedAt = params.decision.updatedAt;
  if (typeof alertUpdatedAt !== "number") {
    return true;
  }
  const identity = resolveCacheIdentity(params.agentDir, params.agentId);
  const claimKey = resolveUsagePolicyClaimKey({
    provider: params.provider,
    profileId: params.profileId,
    alertKey,
  });
  const outcome = updateProviderUsageCacheJson<{
    cache?: ProviderUsageCacheFile;
    claimed: boolean;
  }>({
    agentDir: params.agentDir,
    agentId: identity.agentId,
    updatedAt: alertUpdatedAt,
    update: (currentJson) => {
      const cache = parseProviderUsageCacheJson(currentJson);
      if ((cache.alertClaims[claimKey] ?? 0) >= alertUpdatedAt) {
        return { valueJson: JSON.stringify(cache), result: { claimed: false } };
      }
      cache.alertClaims[claimKey] = alertUpdatedAt;
      cache.alertClaims = pruneProviderUsageAlertClaims({
        claims: cache.alertClaims,
        maxEntries: MAX_PROVIDER_USAGE_ALERT_CLAIMS,
        protectedKey: claimKey,
      });
      return { valueJson: JSON.stringify(cache), result: { cache, claimed: true } };
    },
  });
  if (outcome.cache) {
    publishRuntimeUsageCacheSnapshot(identity.pathname, outcome.cache);
  }
  return outcome.claimed;
}

export function mergeProviderUsageFallbackSnapshots(params: {
  live: UsageSummary;
  cached: UsageSummary;
}): UsageSummary {
  const cachedByProvider = new Map(
    params.cached.providers
      .filter((snapshot) => !snapshot.error)
      .map((snapshot) => [normalizeProviderId(snapshot.provider), snapshot] as const),
  );
  let replacementCount = 0;
  const providers = params.live.providers.map((snapshot) => {
    if (!snapshot.error) {
      return snapshot;
    }
    const cached = cachedByProvider.get(normalizeProviderId(snapshot.provider));
    if (!cached) {
      return snapshot;
    }
    replacementCount += 1;
    return cached;
  });
  if (replacementCount === 0) {
    return params.live;
  }
  return {
    updatedAt:
      replacementCount === params.live.providers.length
        ? params.cached.updatedAt
        : params.live.updatedAt,
    providers,
  };
}

export async function loadProviderUsageSummaryWithCache(
  params: UsageSummaryOptions & {
    cacheAgentDir?: string;
    cacheAgentId?: string;
    cacheProfileId?: string;
    fallbackToCache?: boolean;
  },
): Promise<UsageSummary> {
  try {
    const summary = await loadProviderUsageSummary(params);
    if (params.cacheAgentDir && params.cacheProfileId) {
      await writeCachedProviderUsageSummary({
        agentDir: params.cacheAgentDir,
        agentId: params.cacheAgentId,
        profileId: params.cacheProfileId,
        summary,
      });
    }
    if (
      params.fallbackToCache &&
      params.cacheAgentDir &&
      params.cacheProfileId &&
      summary.providers.some((snapshot) => Boolean(snapshot.error))
    ) {
      const cached = await readCachedProviderUsageSummary({
        agentDir: params.cacheAgentDir,
        agentId: params.cacheAgentId,
        profileId: params.cacheProfileId,
        providers: params.providers,
      });
      return mergeProviderUsageFallbackSnapshots({ live: summary, cached });
    }
    return summary;
  } catch (error) {
    if (!params.fallbackToCache || !params.cacheAgentDir || !params.cacheProfileId) {
      throw error;
    }
    const cached = await readCachedProviderUsageSummary({
      agentDir: params.cacheAgentDir,
      agentId: params.cacheAgentId,
      profileId: params.cacheProfileId,
      providers: params.providers,
    });
    if (cached.providers.length > 0) {
      return cached;
    }
    throw error;
  }
}
