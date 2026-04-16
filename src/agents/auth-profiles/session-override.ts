/**
 * Session-level auth profile override rotation.
 * Keeps automatic profile choice stable within a session while still rotating
 * across new sessions, compactions, provider changes, and cooldowns.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type UsagePolicyDecision } from "../../infra/provider-usage.policy.js";
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
const usagePolicyRuntimeLoader = createLazyImportLoader(
  () => import("../../infra/provider-usage.selection.runtime.js"),
);

// Session accessor writes are lazy-loaded so read-only auth resolution paths do
// not import persistence code unless an override must be updated.
function loadSessionAccessor() {
  return sessionAccessorLoader.load();
}

// Current session overrides are only valid when the selected provider can use
// that profile, including configured aws-sdk profiles without stored secrets.
function loadUsagePolicyRuntime() {
  return usagePolicyRuntimeLoader.load();
}

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

export type SessionAuthProfileBlockedReason = {
  kind: "usage_policy_stop";
  message: string;
  decision: UsagePolicyDecision;
};

export type SessionAuthProfileSwitchNotice = {
  fromProfileId: string;
  toProfileId: string;
  message: string;
  decision: UsagePolicyDecision;
};

export type ResolvedSessionAuthProfileSelection = {
  profileId?: string;
  source?: SessionEntry["authProfileOverrideSource"];
  usagePolicyDecision?: UsagePolicyDecision;
  blockedReason?: SessionAuthProfileBlockedReason;
  switchNotice?: SessionAuthProfileSwitchNotice;
};

export type SessionAuthProfileRunDecision =
  | {
      blocked: true;
      profileId?: ResolvedSessionAuthProfileSelection["profileId"];
      source?: ResolvedSessionAuthProfileSelection["source"];
      error: string;
      notice?: string;
      usagePolicyDecision?: UsagePolicyDecision;
    }
  | {
      blocked: false;
      profileId?: ResolvedSessionAuthProfileSelection["profileId"];
      source?: ResolvedSessionAuthProfileSelection["source"];
      notice?: string;
      usagePolicyDecision?: UsagePolicyDecision;
    };

export function resolveSessionAuthProfileRunDecision(
  selection: ResolvedSessionAuthProfileSelection,
): SessionAuthProfileRunDecision {
  if (selection.blockedReason) {
    return {
      blocked: true,
      profileId: selection.profileId,
      source: selection.source,
      error: selection.blockedReason.message,
      notice: selection.blockedReason.message,
      usagePolicyDecision: selection.usagePolicyDecision,
    };
  }
  return {
    blocked: false,
    profileId: selection.profileId,
    source: selection.source,
    notice: selection.switchNotice?.message,
    usagePolicyDecision: selection.usagePolicyDecision,
  };
}

async function formatUsagePolicyDecisionDetailLazy(decision: UsagePolicyDecision) {
  return (await loadUsagePolicyRuntime()).formatUsagePolicyDecisionDetail(decision);
}

async function buildUsagePolicyStopMessage(decision: UsagePolicyDecision): Promise<string> {
  const profileLabel = decision.profileId?.trim() || "the active profile";
  const detail = await formatUsagePolicyDecisionDetailLazy(decision);
  const extraMessage = decision.message?.trim();
  if (detail && extraMessage && /no eligible auth profile is available/i.test(extraMessage)) {
    return `⚠️ Turn blocked by usage policy for ${profileLabel}: ${detail}. ${extraMessage} Use /profile to switch or adjust auth.usagePolicy.`;
  }
  if (detail) {
    return `⚠️ Turn blocked by usage policy for ${profileLabel}: ${detail}. Use /profile to switch or adjust auth.usagePolicy.`;
  }
  if (extraMessage) {
    return `⚠️ Turn blocked by usage policy for ${profileLabel}: ${extraMessage} Use /profile to switch or adjust auth.usagePolicy.`;
  }
  return `⚠️ Turn blocked by usage policy for ${profileLabel}. Use /profile to switch or adjust auth.usagePolicy.`;
}

async function buildUsagePolicySwitchMessage(params: {
  fromProfileId: string;
  toProfileId: string;
  decision: UsagePolicyDecision;
}): Promise<string> {
  const detail = await formatUsagePolicyDecisionDetailLazy(params.decision);
  const reason = detail ? ` (${detail})` : "";
  return `ℹ️ Usage policy switched auth profile from ${params.fromProfileId} to ${params.toProfileId}${reason}.`;
}

async function persistSelectedSessionAuthProfile(params: {
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  profileId: string;
  source: "auto" | "user";
  compactionCount: number;
}): Promise<void> {
  const shouldPersist =
    params.profileId !== params.sessionEntry.authProfileOverride ||
    params.sessionEntry.authProfileOverrideSource !== params.source ||
    (params.source === "user"
      ? typeof params.sessionEntry.authProfileOverrideCompactionCount === "number"
      : params.sessionEntry.authProfileOverrideCompactionCount !== params.compactionCount);
  if (!shouldPersist) {
    return;
  }
  params.sessionEntry.authProfileOverride = params.profileId;
  params.sessionEntry.authProfileOverrideSource = params.source;
  if (params.source === "user") {
    delete params.sessionEntry.authProfileOverrideCompactionCount;
  } else {
    params.sessionEntry.authProfileOverrideCompactionCount = params.compactionCount;
  }
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
  return (await resolveSessionAuthProfileSelection(params)).profileId;
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
    const current = sessionEntry?.authProfileOverride?.trim() || undefined;
    return {
      profileId: current,
      source: sessionEntry?.authProfileOverrideSource,
      usagePolicyDecision:
        current && sessionEntry
          ? await (
              await loadUsagePolicyRuntime()
            ).readCachedUsagePolicyDecision({
              config: cfg,
              agentDir,
              provider,
              profileId: current,
              selectionSource: sessionEntry.authProfileOverrideSource ?? "none",
              now: Date.now(),
            })
          : undefined,
    };
  }

  const providers = uniqueProviders(provider, params.acceptedProviderIds);
  const hasConfiguredAuthProfiles =
    Boolean(cfg.auth?.profiles && Object.keys(cfg.auth.profiles).length > 0) ||
    Boolean(cfg.auth?.order && Object.keys(cfg.auth.order).length > 0);
  const diskOrder = (
    await Promise.all(
      providers.map((candidateProvider) =>
        readAuthProfileOrderFromDisk({ agentDir, provider: candidateProvider }),
      ),
    )
  ).flat();
  if (
    !sessionEntry.authProfileOverride?.trim() &&
    !hasConfiguredAuthProfiles &&
    !hasAnyAuthProfileStoreSource(agentDir) &&
    diskOrder.length === 0
  ) {
    return {
      profileId: undefined,
      source: sessionEntry.authProfileOverrideSource,
    };
  }

  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
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

  if (current && order.length > 0 && !order.includes(current) && source !== "user") {
    await clearSessionAuthProfileOverride({ sessionEntry, sessionStore, sessionKey, storePath });
    current = undefined;
  }

  if (order.length === 0) {
    return {
      profileId: undefined,
      source: sessionEntry.authProfileOverrideSource,
    };
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
  let next = current;
  if (replacementForUnusableCurrent) {
    next = replacementForUnusableCurrent;
  } else if (source === "user" && current) {
    next = current;
  } else if (isNewSession) {
    next = current ? pickNextAvailable(current) : pickFirstAvailable();
  } else if (current && compactionCount > storedCompaction) {
    next = pickNextAvailable(current);
  } else if (!current || isProfileInCooldown(store, current)) {
    next = pickFirstAvailable();
  }

  if (!next) {
    return {
      profileId: current,
      source: sessionEntry.authProfileOverrideSource,
    };
  }

  const preservingUserSelection = source === "user" && current === next;
  const desiredSource = preservingUserSelection ? "user" : "auto";
  await persistSelectedSessionAuthProfile({
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    profileId: next,
    source: desiredSource,
    compactionCount,
  });

  const usagePolicyRuntime = await loadUsagePolicyRuntime();
  const usagePolicyDecision = await usagePolicyRuntime.readCachedUsagePolicyDecision({
    config: cfg,
    agentDir,
    provider,
    profileId: next,
    selectionSource: sessionEntry.authProfileOverrideSource ?? "none",
    now: Date.now(),
  });
  if (usagePolicyDecision.action === "stop") {
    return {
      profileId: next,
      source: sessionEntry.authProfileOverrideSource,
      usagePolicyDecision,
      blockedReason: {
        kind: "usage_policy_stop",
        message: await buildUsagePolicyStopMessage(usagePolicyDecision),
        decision: usagePolicyDecision,
      },
    };
  }
  if (usagePolicyDecision.action === "switch") {
    const startIndex = order.indexOf(next);
    let warnedCandidate: { profileId: string; decision: UsagePolicyDecision } | undefined;
    if (startIndex >= 0) {
      for (let offset = 1; offset < order.length; offset += 1) {
        const candidate = order[(startIndex + offset) % order.length];
        if (!candidate || isProfileInCooldown(store, candidate)) {
          continue;
        }
        const candidateDecision = await usagePolicyRuntime.readCachedUsagePolicyDecision({
          config: cfg,
          agentDir,
          provider,
          profileId: candidate,
          selectionSource: "auto",
          now: Date.now(),
        });
        if (candidateDecision.action === "stop" || candidateDecision.action === "switch") {
          continue;
        }
        if (candidateDecision.action === "allow") {
          await persistSelectedSessionAuthProfile({
            sessionEntry,
            sessionStore,
            sessionKey,
            storePath,
            profileId: candidate,
            source: "auto",
            compactionCount,
          });
          return {
            profileId: candidate,
            source: "auto",
            usagePolicyDecision: candidateDecision,
            switchNotice: {
              fromProfileId: next,
              toProfileId: candidate,
              message: await buildUsagePolicySwitchMessage({
                fromProfileId: next,
                toProfileId: candidate,
                decision: usagePolicyDecision,
              }),
              decision: usagePolicyDecision,
            },
          };
        }
        if (!warnedCandidate && candidateDecision.action === "warn") {
          warnedCandidate = { profileId: candidate, decision: candidateDecision };
        }
      }
    }
    if (warnedCandidate) {
      await persistSelectedSessionAuthProfile({
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
        profileId: warnedCandidate.profileId,
        source: "auto",
        compactionCount,
      });
      return {
        profileId: warnedCandidate.profileId,
        source: "auto",
        usagePolicyDecision: warnedCandidate.decision,
        switchNotice: {
          fromProfileId: next,
          toProfileId: warnedCandidate.profileId,
          message: await buildUsagePolicySwitchMessage({
            fromProfileId: next,
            toProfileId: warnedCandidate.profileId,
            decision: usagePolicyDecision,
          }),
          decision: usagePolicyDecision,
        },
      };
    }
    if (usagePolicyDecision.onNoSwitchTarget === "stop") {
      const blockedDecision = {
        ...usagePolicyDecision,
        action: "stop",
        message: usagePolicyDecision.message?.trim()
          ? `${usagePolicyDecision.message.trim()} No eligible auth profile is available for automatic switching.`
          : "No eligible auth profile is available for automatic switching.",
      } satisfies UsagePolicyDecision;
      return {
        profileId: next,
        source: sessionEntry.authProfileOverrideSource,
        usagePolicyDecision: blockedDecision,
        blockedReason: {
          kind: "usage_policy_stop",
          message: await buildUsagePolicyStopMessage(blockedDecision),
          decision: blockedDecision,
        },
      };
    }
    if (usagePolicyDecision.onNoSwitchTarget === "allow") {
      return {
        profileId: next,
        source: sessionEntry.authProfileOverrideSource,
        usagePolicyDecision: {
          ...usagePolicyDecision,
          action: "allow",
        } satisfies UsagePolicyDecision,
      };
    }
    return {
      profileId: next,
      source: sessionEntry.authProfileOverrideSource,
      usagePolicyDecision: {
        ...usagePolicyDecision,
        action: "warn",
        noSwitchTarget: true,
        message: usagePolicyDecision.message?.trim()
          ? `${usagePolicyDecision.message.trim()} No eligible auth profile is available for automatic switching.`
          : "No eligible auth profile is available for automatic switching.",
      } satisfies UsagePolicyDecision,
    };
  }
  return {
    profileId: next,
    source: sessionEntry.authProfileOverrideSource,
    usagePolicyDecision,
  };
}
