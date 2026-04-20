import path from "node:path";
import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "./json-files.js";
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
  version: 1;
  profiles: Record<string, CachedProfileUsageState>;
};

const PROVIDER_USAGE_CACHE_VERSION = 1 as const;
const usageCacheLock = createAsyncLock();
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
    lastAlertAt:
      record.lastAlertAt && typeof record.lastAlertAt === "object"
        ? Object.fromEntries(
            Object.entries(record.lastAlertAt as Record<string, unknown>).filter(
              (entry): entry is [string, number] =>
                typeof entry[0] === "string" &&
                typeof entry[1] === "number" &&
                Number.isFinite(entry[1]),
            ),
          )
        : undefined,
  };
}

function coerceProviderUsageCacheFile(raw: unknown): ProviderUsageCacheFile {
  if (!raw || typeof raw !== "object") {
    return {
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
    version: PROVIDER_USAGE_CACHE_VERSION,
    profiles,
  };
}

function resolveCacheEntryKey(params: { provider: string; profileId: string }): string {
  const normalizedProvider = normalizeProviderId(params.provider) || params.provider.trim();
  return `${normalizedProvider}::${params.profileId.trim()}`;
}

function buildCachedProfileUsageState(params: {
  profileId: string;
  updatedAt: number;
  snapshot: ProviderUsageSnapshot;
  existing?: CachedProfileUsageState;
}): CachedProfileUsageState {
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
    lastAlertAt: params.existing?.lastAlertAt,
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

async function loadProviderUsageCacheFile(pathname: string): Promise<ProviderUsageCacheFile> {
  const cached = runtimeUsageCacheSnapshots.get(pathname);
  if (cached) {
    return cloneUsageCacheFile(cached);
  }
  const parsed = coerceProviderUsageCacheFile(await readJsonFile<unknown>(pathname));
  runtimeUsageCacheSnapshots.set(pathname, cloneUsageCacheFile(parsed));
  return parsed;
}

async function loadProviderUsageCacheFileFresh(pathname: string): Promise<ProviderUsageCacheFile> {
  const parsed = coerceProviderUsageCacheFile(await readJsonFile<unknown>(pathname));
  runtimeUsageCacheSnapshots.set(pathname, cloneUsageCacheFile(parsed));
  return parsed;
}

export function resolveProviderUsageCachePath(agentDir: string): string {
  return path.join(agentDir, "provider-usage-cache.json");
}

export function clearRuntimeProviderUsageCacheSnapshots(): void {
  runtimeUsageCacheSnapshots.clear();
}

export function getCachedProfileUsageState(params: {
  agentDir: string;
  provider: string;
  profileId: string;
}): CachedProfileUsageState | undefined {
  const pathname = resolveProviderUsageCachePath(params.agentDir);
  const cache = runtimeUsageCacheSnapshots.get(pathname);
  if (!cache) {
    return undefined;
  }
  const entry = cache.profiles[resolveCacheEntryKey(params)];
  return entry ? structuredClone(entry) : undefined;
}

export async function readCachedProfileUsageState(params: {
  agentDir: string;
  provider: string;
  profileId: string;
}): Promise<CachedProfileUsageState | undefined> {
  const pathname = resolveProviderUsageCachePath(params.agentDir);
  const cache = await loadProviderUsageCacheFile(pathname);
  const entry = cache.profiles[resolveCacheEntryKey(params)];
  return entry ? structuredClone(entry) : undefined;
}

export async function readCachedProviderUsageSummary(params: {
  agentDir: string;
  profileId: string;
  providers?: string[];
}): Promise<UsageSummary> {
  const pathname = resolveProviderUsageCachePath(params.agentDir);
  const cache = await loadProviderUsageCacheFile(pathname);
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
      provider: params.provider,
      profileId: params.profileId,
    }),
    selectionSource: params.selectionSource,
    now: params.now,
  });
}

export async function writeCachedProviderUsageSummary(params: {
  agentDir: string;
  profileId: string;
  summary: UsageSummary;
}): Promise<void> {
  if (!params.profileId.trim()) {
    return;
  }
  const pathname = resolveProviderUsageCachePath(params.agentDir);
  await usageCacheLock(async () => {
    const cache = await loadProviderUsageCacheFileFresh(pathname);
    for (const snapshot of params.summary.providers) {
      const cacheEntryKey = resolveCacheEntryKey({
        provider: snapshot.provider,
        profileId: params.profileId,
      });
      cache.profiles[cacheEntryKey] = buildCachedProfileUsageState({
        profileId: params.profileId,
        updatedAt: params.summary.updatedAt,
        snapshot,
        existing: cache.profiles[cacheEntryKey],
      });
    }
    runtimeUsageCacheSnapshots.set(pathname, cloneUsageCacheFile(cache));
    await writeJsonAtomic(pathname, cache, { mode: 0o600, trailingNewline: true });
  });
}

export async function shouldSendCachedUsagePolicyAlert(params: {
  agentDir: string;
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
  const cached = await readCachedProfileUsageState({
    agentDir: params.agentDir,
    provider: params.provider,
    profileId: params.profileId,
  });
  if (!cached) {
    return true;
  }
  const lastAlertAt = cached.lastAlertAt?.[alertKey] ?? 0;
  return lastAlertAt < params.decision.updatedAt!;
}

export async function markCachedUsagePolicyAlertSent(params: {
  agentDir: string;
  provider: string;
  profileId: string;
  surface: UsagePolicySurface;
  decision: UsagePolicyDecision;
}): Promise<void> {
  const alertKey = resolveUsagePolicyAlertKey({
    surface: params.surface,
    decision: params.decision,
  });
  const alertUpdatedAt = params.decision.updatedAt;
  if (!alertKey || typeof alertUpdatedAt !== "number") {
    return;
  }
  const pathname = resolveProviderUsageCachePath(params.agentDir);
  await usageCacheLock(async () => {
    const cache = await loadProviderUsageCacheFileFresh(pathname);
    const entry = cache.profiles[resolveCacheEntryKey(params)];
    if (!entry) {
      return;
    }
    const nextLastAlertAt: Record<string, number> = {
      ...entry.lastAlertAt,
    };
    nextLastAlertAt[alertKey] = alertUpdatedAt;
    entry.lastAlertAt = nextLastAlertAt;
    runtimeUsageCacheSnapshots.set(pathname, cloneUsageCacheFile(cache));
    await writeJsonAtomic(pathname, cache, { mode: 0o600, trailingNewline: true });
  });
}

export async function loadProviderUsageSummaryWithCache(
  params: UsageSummaryOptions & {
    cacheAgentDir?: string;
    cacheProfileId?: string;
    fallbackToCache?: boolean;
  },
): Promise<UsageSummary> {
  try {
    const summary = await loadProviderUsageSummary(params);
    if (params.cacheAgentDir && params.cacheProfileId) {
      await writeCachedProviderUsageSummary({
        agentDir: params.cacheAgentDir,
        profileId: params.cacheProfileId,
        summary,
      });
    }
    return summary;
  } catch (error) {
    if (!params.fallbackToCache || !params.cacheAgentDir || !params.cacheProfileId) {
      throw error;
    }
    const cached = await readCachedProviderUsageSummary({
      agentDir: params.cacheAgentDir,
      profileId: params.cacheProfileId,
      providers: params.providers,
    });
    if (cached.providers.length > 0) {
      return cached;
    }
    throw error;
  }
}
