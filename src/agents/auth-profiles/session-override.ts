/**
 * Session-level auth profile override rotation.
 * Keeps automatic profile choice stable within a session while still rotating
 * across new sessions, compactions, provider changes, and cooldowns.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readCachedUsagePolicyDecision } from "../../infra/provider-usage.cache.js";
import {
  formatUsagePolicyDecisionDetail,
  formatUsagePolicyDecisionLine,
  type UsagePolicyDecision,
} from "../../infra/provider-usage.policy.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  isConfiguredAwsSdkAuthProfileForProvider,
  isStoredCredentialCompatibleWithAuthProvider,
  resolveAuthProfileOrder,
} from "../auth-profiles/order.js";
import { ensureAuthProfileStore, hasAnyAuthProfileStoreSource } from "../auth-profiles/store.js";
import { isProfileInCooldown } from "../auth-profiles/usage.js";

const sessionAccessorLoader = createLazyImportLoader(
  () => import("../../config/sessions/session-accessor.js"),
);

// Session accessor writes are lazy-loaded so read-only auth resolution paths do
// not import persistence code unless an override must be updated.
function loadSessionAccessor() {
  return sessionAccessorLoader.load();
}

// Current session overrides are only valid when the selected provider can use
// that profile, including configured aws-sdk profiles without stored secrets.
function isProfileForProvider(params: {
  cfg: OpenClawConfig;
  providers: readonly string[];
  profileId: string;
  store: ReturnType<typeof ensureAuthProfileStore>;
}): boolean {
  const entry = params.store.profiles[params.profileId];
  if (entry) {
    if (!entry.provider) {
      return false;
    }
    return params.providers.some((provider) =>
      isStoredCredentialCompatibleWithAuthProvider({
        cfg: params.cfg,
        provider,
        credential: entry,
      }),
    );
  }
  return params.providers.some((provider) =>
    isConfiguredAwsSdkAuthProfileForProvider({
      cfg: params.cfg,
      provider,
      profileId: params.profileId,
    }),
  );
}

function uniqueProviders(provider: string, acceptedProviderIds?: readonly string[]): string[] {
  const providers = new Set<string>();
  const push = (value: string | undefined) => {
    const normalized = value?.trim();
    if (normalized) {
      providers.add(normalized);
    }
  };
  const candidates =
    acceptedProviderIds && acceptedProviderIds.length > 0 ? acceptedProviderIds : [provider];
  candidates.forEach(push);
  return [...providers];
}

export type ResolvedSessionAuthProfileSelection = {
  profileId?: string;
  source?: "auto" | "user";
  usagePolicyDecision?: UsagePolicyDecision;
  blockedReason?: {
    kind: "usage_policy_stop";
    message: string;
  };
  switchNotice?: {
    message: string;
  };
};

function resolveSelectionSource(sessionEntry?: SessionEntry): "auto" | "user" | undefined {
  if (sessionEntry?.authProfileOverrideSource === "user") {
    return "user";
  }
  if (sessionEntry?.authProfileOverrideSource === "auto") {
    return "auto";
  }
  return sessionEntry?.authProfileOverride ? "user" : "auto";
}

function buildUsagePolicyMessage(decision: UsagePolicyDecision): string {
  return formatUsagePolicyDecisionLine(decision) ?? decision.message ?? "Usage policy matched.";
}

function buildNoSwitchTargetMessage(decision: UsagePolicyDecision): string {
  const detail = formatUsagePolicyDecisionDetail(decision) ?? "switch threshold matched";
  return `Usage policy: ${detail}. No eligible auth profile is available for automatic switching.`;
}

async function readAuthProfileOrderFromDisk(params: {
  agentDir: string;
  provider: string;
}): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(params.agentDir, "auth-profiles.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      order?: Record<string, unknown>;
      profiles?: Record<string, { provider?: unknown }>;
    };
    const direct = parsed.order?.[params.provider];
    if (Array.isArray(direct)) {
      return direct.filter((item): item is string => typeof item === "string" && item.trim() !== "");
    }
    return Object.entries(parsed.profiles ?? {})
      .filter(([, profile]) => profile?.provider === params.provider)
      .map(([profileId]) => profileId);
  } catch {
    return [];
  }
}

async function resolveAuthProfileOrderWithDiskFallback(params: {
  cfg: OpenClawConfig;
  store: ReturnType<typeof ensureAuthProfileStore>;
  provider: string;
  agentDir: string;
  acceptedProviderIds?: readonly string[];
}): Promise<string[]> {
  const providers = uniqueProviders(params.provider, params.acceptedProviderIds);
  const fromStore = [
    ...new Set(
      providers.flatMap((candidateProvider) =>
        resolveAuthProfileOrder({ cfg: params.cfg, store: params.store, provider: candidateProvider }),
      ),
    ),
  ];
  if (fromStore.length > 0) {
    return fromStore;
  }
  const fromDisk = await Promise.all(
    providers.map((candidateProvider) =>
      readAuthProfileOrderFromDisk({ agentDir: params.agentDir, provider: candidateProvider }),
    ),
  );
  return [...new Set(fromDisk.flat())];
}

/** Clears an auth-profile override from a session and persists it when possible. */
export async function clearSessionAuthProfileOverride(params: {
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
}) {
  const { sessionEntry, sessionStore, sessionKey, storePath } = params;
  delete sessionEntry.authProfileOverride;
  delete sessionEntry.authProfileOverrideSource;
  delete sessionEntry.authProfileOverrideCompactionCount;
  sessionEntry.updatedAt = Date.now();
  sessionStore[sessionKey] = sessionEntry;
  if (storePath) {
    await (
      await loadSessionAccessor()
    ).patchSessionEntry(
      { storePath, sessionKey },
      () => sessionEntry,
      { fallbackEntry: sessionEntry, replaceEntry: true },
    );
  }
}

/** Resolves and optionally rotates the session auth-profile override. */
export async function resolveSessionAuthProfileOverride(params: {
  cfg: OpenClawConfig;
  provider: string;
  agentDir: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isNewSession: boolean;
  acceptedProviderIds?: string[];
}): Promise<string | undefined> {
  const {
    cfg,
    provider,
    agentDir,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    isNewSession,
  } = params;
  if (!sessionEntry || !sessionStore || !sessionKey) {
    return sessionEntry?.authProfileOverride;
  }

  const hasConfiguredAuthProfiles =
    Boolean(params.cfg.auth?.profiles && Object.keys(params.cfg.auth.profiles).length > 0) ||
    Boolean(params.cfg.auth?.order && Object.keys(params.cfg.auth.order).length > 0);
  if (
    !sessionEntry.authProfileOverride?.trim() &&
    !hasConfiguredAuthProfiles &&
    !hasAnyAuthProfileStoreSource(agentDir)
  ) {
    return undefined;
  }

  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const providers = uniqueProviders(provider, params.acceptedProviderIds);
  const order = await resolveAuthProfileOrderWithDiskFallback({
    cfg,
    store,
    provider,
    agentDir,
    acceptedProviderIds: params.acceptedProviderIds,
  });
  let current = sessionEntry.authProfileOverride?.trim();
  const source =
    sessionEntry.authProfileOverrideSource ??
    (typeof sessionEntry.authProfileOverrideCompactionCount === "number"
      ? "auto"
      : current
        ? "user"
        : undefined);

  const currentProfileId = current;
  const currentProfileExistsOnDisk =
    currentProfileId &&
    (
      await Promise.all(
        providers.map((candidateProvider) =>
          readAuthProfileOrderFromDisk({ agentDir, provider: candidateProvider }),
        ),
      )
    )
      .flat()
      .includes(currentProfileId);
  if (
    currentProfileId &&
    !store.profiles[currentProfileId] &&
    !currentProfileExistsOnDisk &&
    !providers.some((candidateProvider) =>
      isConfiguredAwsSdkAuthProfileForProvider({
        cfg,
        provider: candidateProvider,
        profileId: currentProfileId,
      }),
    )
  ) {
    await clearSessionAuthProfileOverride({ sessionEntry, sessionStore, sessionKey, storePath });
    current = undefined;
  }

  if (
    current &&
    !currentProfileExistsOnDisk &&
    !isProfileForProvider({ cfg, providers, profileId: current, store })
  ) {
    await clearSessionAuthProfileOverride({ sessionEntry, sessionStore, sessionKey, storePath });
    current = undefined;
  }

  // Explicit user picks should survive provider rotation order changes.
  if (current && order.length > 0 && !order.includes(current) && source !== "user") {
    await clearSessionAuthProfileOverride({ sessionEntry, sessionStore, sessionKey, storePath });
    current = undefined;
  }

  if (order.length === 0) {
    return undefined;
  }

  const pickFirstAvailable = () =>
    order.find((profileId) => !isProfileInCooldown(store, profileId)) ?? order[0];
  const pickNextAvailable = (active: string) => {
    const startIndex = order.indexOf(active);
    if (startIndex < 0) {
      return pickFirstAvailable();
    }
    for (let offset = 1; offset <= order.length; offset += 1) {
      const candidate = order[(startIndex + offset) % order.length];
      if (!isProfileInCooldown(store, candidate)) {
        return candidate;
      }
    }
    return order[startIndex] ?? order[0];
  };

  const compactionCount = sessionEntry.compactionCount ?? 0;
  const storedCompaction =
    typeof sessionEntry.authProfileOverrideCompactionCount === "number"
      ? sessionEntry.authProfileOverrideCompactionCount
      : compactionCount;
  const replacementForUnusableCurrent =
    current && isProfileInCooldown(store, current)
      ? order.find((profileId) => profileId !== current && !isProfileInCooldown(store, profileId))
      : undefined;
  // User-pinned profiles persist unless unusable/mismatched. Auto-selected
  // profiles rotate on new sessions or compaction boundaries.
  if (replacementForUnusableCurrent) {
    current = undefined;
  }
  // Explicit user selections must survive the first real turn in a freshly
  // created session/thread. /profile can persist the override before the
  // first non-command message arrives, and that follow-up turn may still be
  // flagged as "new session". Rotating away from a user-picked profile there
  // makes /profile appear to "stick" only until the next message.
  if (source === "user" && current) {
    return current;
  }

  let next = current;
  if (replacementForUnusableCurrent) {
    next = replacementForUnusableCurrent;
  } else if (isNewSession) {
    next = current ? pickNextAvailable(current) : pickFirstAvailable();
  } else if (current && compactionCount > storedCompaction) {
    next = pickNextAvailable(current);
  } else if (!current || isProfileInCooldown(store, current)) {
    next = pickFirstAvailable();
  }

  if (!next) {
    return current;
  }
  const shouldPersist =
    next !== sessionEntry.authProfileOverride ||
    sessionEntry.authProfileOverrideSource !== "auto" ||
    sessionEntry.authProfileOverrideCompactionCount !== compactionCount;
  if (shouldPersist) {
    sessionEntry.authProfileOverride = next;
    sessionEntry.authProfileOverrideSource = "auto";
    sessionEntry.authProfileOverrideCompactionCount = compactionCount;
    sessionEntry.updatedAt = Date.now();
    sessionStore[sessionKey] = sessionEntry;
    if (storePath) {
      await (
        await loadSessionAccessor()
      ).patchSessionEntry(
        { storePath, sessionKey },
        () => sessionEntry,
        { fallbackEntry: sessionEntry, replaceEntry: true },
      );
    }
  }

  return next;
}

export async function resolveSessionAuthProfileSelection(params: {
  cfg: OpenClawConfig;
  provider: string;
  agentDir: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isNewSession: boolean;
  acceptedProviderIds?: string[];
}): Promise<ResolvedSessionAuthProfileSelection> {
  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  const order = await resolveAuthProfileOrderWithDiskFallback({
    cfg: params.cfg,
    store,
    provider: params.provider,
    agentDir: params.agentDir,
    acceptedProviderIds: params.acceptedProviderIds,
  });
  const source = resolveSelectionSource(params.sessionEntry);
  const userSelectedProfileId =
    source === "user" ? params.sessionEntry?.authProfileOverride?.trim() : undefined;
  const profileId =
    userSelectedProfileId || (await resolveSessionAuthProfileOverride(params)) || order[0];
  if (!profileId) {
    return {};
  }

  const decision = await readCachedUsagePolicyDecision({
    config: params.cfg,
    agentDir: params.agentDir,
    provider: params.provider,
    profileId,
    selectionSource: source ?? "auto",
  });

  if (decision.action === "stop") {
    return {
      profileId,
      source,
      usagePolicyDecision: decision,
      blockedReason: {
        kind: "usage_policy_stop",
        message: buildUsagePolicyMessage(decision),
      },
    };
  }

  if (decision.action !== "switch") {
    return {
      profileId,
      source,
      usagePolicyDecision: decision.action === "warn" ? decision : undefined,
    };
  }

  const targetProfileId = (
    await Promise.all(
      order
        .filter((candidate) => candidate !== profileId)
        .map(async (candidate) => {
          const candidateDecision = await readCachedUsagePolicyDecision({
            config: params.cfg,
            agentDir: params.agentDir,
            provider: params.provider,
            profileId: candidate,
            selectionSource: "auto",
          });
          return candidateDecision.action === "allow" || candidateDecision.action === "warn"
            ? candidate
            : undefined;
        }),
    )
  ).find((candidate): candidate is string => Boolean(candidate));

  if (!targetProfileId) {
    const noSwitchDecision: UsagePolicyDecision = {
      ...decision,
      action: decision.onNoSwitchTarget === "stop" ? "stop" : "warn",
      noSwitchTarget: true,
      message: buildNoSwitchTargetMessage(decision),
    };
    if (noSwitchDecision.action === "stop") {
      return {
        profileId,
        source,
        usagePolicyDecision: noSwitchDecision,
        blockedReason: {
          kind: "usage_policy_stop",
          message: noSwitchDecision.message ?? buildNoSwitchTargetMessage(decision),
        },
      };
    }
    return {
      profileId,
      source,
      usagePolicyDecision: noSwitchDecision,
    };
  }

  const compactionCount = params.sessionEntry?.compactionCount ?? 0;
  if (params.sessionEntry && params.sessionStore && params.sessionKey) {
    params.sessionEntry.authProfileOverride = targetProfileId;
    params.sessionEntry.authProfileOverrideSource = "auto";
    params.sessionEntry.authProfileOverrideCompactionCount = compactionCount;
    params.sessionEntry.updatedAt = Date.now();
    params.sessionStore[params.sessionKey] = params.sessionEntry;
    if (params.storePath) {
      await (
        await loadSessionAccessor()
      ).patchSessionEntry(
        { storePath: params.storePath, sessionKey: params.sessionKey },
        () => params.sessionEntry,
        { fallbackEntry: params.sessionEntry, replaceEntry: true },
      );
    }
  }

  return {
    profileId: targetProfileId,
    source: "auto",
    usagePolicyDecision: decision,
    switchNotice: {
      message: `Usage policy switched auth profile from ${profileId} to ${targetProfileId}.`,
    },
  };
}
