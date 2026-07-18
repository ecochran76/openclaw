import path from "node:path";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
  resolveAgentModelFallbacksOverride,
} from "../agents/agent-scope.js";
import { resolveAuthProfileDisplayLabel } from "../agents/auth-profiles/display.js";
import { resolveAuthProfileOrder } from "../agents/auth-profiles/order.js";
import { resolveMainAgentDir } from "../agents/auth-profiles/paths.js";
import { loadPersistedAuthProfileState } from "../agents/auth-profiles/state.js";
import {
  ensureAuthProfileStore,
  loadAuthProfileStoreWithoutExternalProfiles,
} from "../agents/auth-profiles/store.js";
import type { AuthProfileFailureReason, ProfileUsageStats } from "../agents/auth-profiles/types.js";
import { resolveContextTokensForModel, waitForContextWindowCacheLoad } from "../agents/context.js";
import { resolveFastModeState } from "../agents/fast-mode.js";
import { resolveModelAuthLabel } from "../agents/model-auth-label.js";
import {
  areRuntimeModelRefsEquivalent,
  shouldPreferActiveRuntimeAliasAuthLabel,
} from "../agents/model-runtime-aliases.js";
import {
  findNormalizedProviderValue,
  resolveDefaultModelForAgent,
} from "../agents/model-selection.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../agents/openai-routing.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import { resolveSessionRuntimeOverrideForProvider } from "../agents/session-runtime-compat.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../agents/tools/sessions-helpers.js";
import { normalizeGroupActivation } from "../auto-reply/group-activation.js";
import { resolveSelectedAndActiveModel } from "../auto-reply/model-runtime.js";
import { resolveSupportedThinkingLevel, type ThinkLevel } from "../auto-reply/thinking.js";
import { getLatestAutomationRunForRequester } from "../automation/registry.js";
import { buildAutomationCompactStatusLine } from "../automation/status.js";
import { toAgentModelListLike } from "../config/model-input.js";
import type { SessionEntry } from "../config/sessions.js";
import { hasSessionAutoModelFallbackProvenance } from "../config/sessions/model-override-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.js";
import {
  formatUsageWindowSummary,
  loadProviderUsageSummary,
  resolveUsageProviderId,
} from "../infra/provider-usage.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveNormalizedAccountEntry } from "../routing/account-lookup.js";
import { createLazyPromise, createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  listTasksForAgentIdForStatus,
  listTasksForSessionKeyForStatus,
} from "../tasks/task-status-access.js";
import {
  buildTaskStatusSnapshot,
  formatTaskStatusDetail,
  formatTaskStatusTitle,
} from "../tasks/task-status.js";
// Status text helpers render runtime status summaries for CLI output.
import { resolveUsageCredentialType } from "./codex-synthetic-usage.js";
import {
  buildCodexSyntheticUsageAuth,
  shouldUseCodexSyntheticUsageForRuntime,
} from "./codex-synthetic-usage.js";
import { resolveActiveFallbackState } from "./fallback-notice-state.js";
import { formatCompactPluginHealthLine } from "./status-plugin-health.js";
import { appendSessionCostLine, buildStatusUptimeLine } from "./status-runtime-lines.js";
import type { BuildStatusTextParams } from "./status-text.types.js";

// Status text assembly gathers runtime/model/session/task facts, then delegates
// final formatting to status-message.runtime through lazy imports.
const USAGE_OAUTH_ONLY_PROVIDERS = new Set([
  "anthropic",
  "github-copilot",
  "google-gemini-cli",
  "openai",
]);
const CODEX_APP_SERVER_HOME_DIRNAME = "codex-home";

function formatStatusAuthFailureNote(stats: ProfileUsageStats | undefined): string | undefined {
  if (!stats) {
    return undefined;
  }
  const reason: AuthProfileFailureReason | undefined =
    stats.disabledReason === "auth" || stats.disabledReason === "auth_permanent"
      ? stats.disabledReason
      : (stats.failureCounts?.auth_permanent ?? 0) > 0
        ? "auth_permanent"
        : (stats.failureCounts?.auth ?? 0) > 0
          ? "auth"
          : undefined;
  if (!reason) {
    return undefined;
  }
  const label = reason.replaceAll("_", " ");
  const now = Date.now();
  if (typeof stats.disabledUntil === "number" && stats.disabledUntil > now) {
    const remaining = formatDurationCompact(stats.disabledUntil - now) ?? "0s";
    return `auth disabled: ${label} for ${remaining}`;
  }
  if (typeof stats.lastFailureAt === "number" && stats.lastFailureAt > 0) {
    const age = formatDurationCompact(Math.max(0, now - stats.lastFailureAt)) ?? "0s";
    return `last auth failure: ${label} ${age} ago`;
  }
  return `last auth failure: ${label}`;
}

function resolveStatusAuthStore(params: { agentDir?: string; includeExternalProfiles?: boolean }) {
  return params.includeExternalProfiles === false
    ? loadAuthProfileStoreWithoutExternalProfiles(params.agentDir)
    : ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
}

function resolveSelectedStatusAuthProfileId(params: {
  provider?: string;
  acceptedProviderIds?: readonly string[];
  cfg?: OpenClawConfig;
  sessionEntry?: Partial<Pick<SessionEntry, "authProfileOverride">>;
  agentDir?: string;
  includeExternalProfiles?: boolean;
}): string | undefined {
  const provider = params.provider?.trim();
  if (!provider) {
    return undefined;
  }
  const store = resolveStatusAuthStore(params);
  const profileOverride = params.sessionEntry?.authProfileOverride?.trim();
  const providers = params.acceptedProviderIds?.length ? params.acceptedProviderIds : [provider];
  const order = [
    ...new Set(
      providers.flatMap((candidateProvider) =>
        resolveAuthProfileOrder({
          cfg: params.cfg,
          store,
          provider: candidateProvider,
          preferredProfile: profileOverride,
        }),
      ),
    ),
  ];
  const candidates = [...new Set([profileOverride, ...order].filter(Boolean))] as string[];
  const rawProviders = new Set(providers.map((value) => value.trim()));
  const authProviders = new Set(
    providers.map((value) => resolveProviderIdForAuth(value, { config: params.cfg })),
  );
  return candidates.find((profileId) => {
    const profile = store.profiles[profileId];
    return (
      profile &&
      (rawProviders.has(profile.provider) ||
        authProviders.has(resolveProviderIdForAuth(profile.provider, { config: params.cfg })))
    );
  });
}

export function resolveStatusModelAuthLabel(params: {
  provider?: string;
  acceptedProviderIds?: readonly string[];
  cfg?: OpenClawConfig;
  sessionEntry?: Partial<Pick<SessionEntry, "authProfileOverride">>;
  agentDir?: string;
  workspaceDir?: string;
  codexCliCredentialsHome?: string;
  includeExternalProfiles?: boolean;
}): string | undefined {
  const base = resolveModelAuthLabel(params);
  const provider = params.provider?.trim();
  if (!provider || !params.agentDir) {
    return base;
  }
  const store = resolveStatusAuthStore(params);
  const profileId = resolveSelectedStatusAuthProfileId(params);
  const profile = profileId ? store.profiles[profileId] : undefined;
  if (!profileId || !profile) {
    return base;
  }
  const profileLabel = resolveAuthProfileDisplayLabel({ cfg: params.cfg, store, profileId });
  const displaySuffix = profileLabel ? ` (${profileLabel})` : "";
  const authLabel =
    profile.type === "oauth"
      ? `oauth${displaySuffix}`
      : profile.type === "token"
        ? `token${displaySuffix}`
        : `api-key${displaySuffix}`;
  if (authLabel !== base) {
    return base;
  }
  const failureNote = formatStatusAuthFailureNote(store.usageStats?.[profileId]);
  const mainAgentDir = resolveMainAgentDir();
  if (params.agentDir === mainAgentDir) {
    return [authLabel, failureNote].filter(Boolean).join(" · ");
  }
  const providerKeys = [provider, ...(params.acceptedProviderIds ?? [])];
  const authKeys = providerKeys.map((value) =>
    resolveProviderIdForAuth(value, { config: params.cfg }),
  );
  const currentState = loadPersistedAuthProfileState(params.agentDir);
  const mainState = loadPersistedAuthProfileState(mainAgentDir);
  const currentOrder = providerKeys
    .map((key) => findNormalizedProviderValue(currentState.order, key)?.[0])
    .find(Boolean);
  const mainOrder = providerKeys
    .map(
      (key) =>
        findNormalizedProviderValue(mainState.order, key)?.[0] ??
        findNormalizedProviderValue(params.cfg?.auth?.order, key)?.[0],
    )
    .find(Boolean);
  const currentLastGood = authKeys
    .map((key) => findNormalizedProviderValue(currentState.lastGood, key))
    .find(Boolean);
  const mainLastGood = authKeys
    .map((key) => findNormalizedProviderValue(mainState.lastGood, key))
    .find(Boolean);
  const driftNote =
    currentOrder && mainLastGood && currentOrder !== mainLastGood
      ? `agent order prefers ${currentOrder}; main last-good ${mainLastGood}`
      : currentOrder && mainOrder && currentOrder !== mainOrder
        ? `agent order prefers ${currentOrder}; main order prefers ${mainOrder}`
        : currentLastGood && mainLastGood && currentLastGood !== mainLastGood
          ? `agent last-good ${currentLastGood}; main last-good ${mainLastGood}`
          : undefined;
  return [authLabel, failureNote, driftNote].filter(Boolean).join(" · ");
}

function resolveStatusChannelFeatureLine(params: {
  cfg: OpenClawConfig;
  statusChannel: string;
  statusAccountId?: string;
  sessionEntry?: SessionEntry;
}): string | undefined {
  const channel = normalizeOptionalLowercaseString(params.statusChannel);
  if (channel !== "telegram") {
    return undefined;
  }
  const telegramConfig = params.cfg.channels?.telegram;
  const accountId = normalizeAccountId(
    params.statusAccountId ??
      params.sessionEntry?.lastAccountId ??
      params.sessionEntry?.origin?.accountId ??
      telegramConfig?.defaultAccount,
  );
  const accountConfig = resolveNormalizedAccountEntry(
    telegramConfig?.accounts,
    accountId,
    normalizeAccountId,
  );
  const richMessagesSetting = accountConfig?.richMessages ?? telegramConfig?.richMessages;
  if (richMessagesSetting === true) {
    return "Telegram rich messages: on · Bot API 10.1 sendRichMessage enabled";
  }
  return accountConfig?.richMessages === false
    ? "Telegram rich messages: off · enable richMessages for this Telegram account"
    : "Telegram rich messages: off · set channels.telegram.richMessages=true for tables/details/rich media";
}

const loadStatusMessageRuntime = createLazyPromise(
  () =>
    import("./status-message.runtime.js").then((module) => module.loadStatusMessageRuntimeModule()),
  { cacheRejections: true },
);
const loadAgentHarnessSelectionRuntime = createLazyRuntimeModule(
  () => import("../agents/harness/selection.js"),
);
const loadStatusSubagentsRuntime = createLazyRuntimeModule(
  () => import("./status-subagents.runtime.js"),
);

const loadStatusQueueRuntime = createLazyRuntimeModule(() => import("./status-queue.runtime.js"));

const loadStatusPluginHealthRuntime = createLazyRuntimeModule(
  () => import("./status-plugin-health.runtime.js"),
);

// Context lookup stays synchronous/non-refreshing so status output does not
// trigger provider/catalog IO while rendering a command response.
function resolveStatusRuntimeContextTokens(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): number | undefined {
  return resolveContextTokensForModel({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    allowAsyncLoad: false,
  });
}

function shouldLoadUsageSummary(params: {
  provider?: string;
  selectedModelAuth?: string;
  credentialType?: string;
}): boolean {
  if (!params.provider) {
    return false;
  }
  if (!USAGE_OAUTH_ONLY_PROVIDERS.has(params.provider)) {
    return true;
  }
  // OAuth/token usage endpoints are meaningful only for providers authenticated
  // through those modes; skip API-key sessions to avoid slow unavailable calls.
  const auth = normalizeOptionalLowercaseString(params.selectedModelAuth);
  return Boolean(
    params.credentialType === "oauth" ||
    params.credentialType === "token" ||
    auth?.startsWith("oauth") ||
    auth?.startsWith("token"),
  );
}

function resolveCodexSyntheticUsageAuthProfileId(params: {
  profileId: string | undefined;
  cfg: OpenClawConfig;
  agentDir?: string;
}): string | undefined {
  const normalizedProfileId = params.profileId?.trim();
  if (!normalizedProfileId) {
    return undefined;
  }
  try {
    const store = ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
      config: params.cfg,
      readOnly: true,
      syncExternalCli: false,
    });
    const credential = store.profiles[normalizedProfileId];
    if (!credential) {
      return undefined;
    }
    const credentialProvider = normalizeOptionalLowercaseString(credential.provider);
    const resolvedProvider = resolveProviderIdForAuth(credential.provider, { config: params.cfg });
    return resolvedProvider === "openai" ||
      credentialProvider === "openai-codex" ||
      credentialProvider === "codex-cli"
      ? normalizedProfileId
      : undefined;
  } catch {
    return undefined;
  }
}

function formatSessionTaskLine(sessionKey: string): string | undefined {
  const snapshot = buildTaskStatusSnapshot(listTasksForSessionKeyForStatus(sessionKey));
  const task = snapshot.focus;
  if (!task) {
    return undefined;
  }
  const headline =
    snapshot.activeCount > 0
      ? `${snapshot.activeCount} active · ${snapshot.totalCount} total`
      : snapshot.recentFailureCount > 0
        ? `${snapshot.recentFailureCount} recent failure${snapshot.recentFailureCount === 1 ? "" : "s"}`
        : "recently finished";
  const title = formatTaskStatusTitle(task);
  const detail = formatTaskStatusDetail(task);
  const parts = [headline, task.runtime, title, detail].filter(Boolean);
  return parts.length ? `📌 Tasks: ${parts.join(" · ")}` : undefined;
}

async function resolveStatusHarnessId(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  agentId: string;
  sessionKey: string;
  sessionEntry?: SessionEntry;
}): Promise<string | undefined> {
  try {
    const { selectAgentHarness } = await loadAgentHarnessSelectionRuntime();
    const agentHarnessRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
      provider: params.provider,
      entry: params.sessionEntry,
      cfg: params.cfg,
    });
    const selected = selectAgentHarness({
      provider: params.provider,
      modelId: params.model,
      config: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      agentHarnessRuntimeOverride,
    });
    const id = normalizeOptionalLowercaseString(selected.id);
    return id || undefined;
  } catch {
    // Harness selection is nice-to-have for display. Status should still render
    // if dynamic harness modules are unavailable.
    return undefined;
  }
}

function resolveStatusRuntimeProvider(params: {
  provider: string;
  effectiveHarness?: string;
}): string {
  const harness = normalizeOptionalLowercaseString(params.effectiveHarness);
  const provider = normalizeOptionalLowercaseString(params.provider);
  if (harness === "codex" && (provider === "openai" || provider === "codex")) {
    return "openai";
  }
  if (harness === "claude-cli" && provider === "anthropic") {
    return "claude-cli";
  }
  return params.provider;
}

function resolveStatusCodexCliCredentialsHome(params: {
  agentDir: string;
  effectiveHarness?: string;
}): string | undefined {
  return normalizeOptionalLowercaseString(params.effectiveHarness) === "codex"
    ? path.join(params.agentDir, CODEX_APP_SERVER_HOME_DIRNAME)
    : undefined;
}

function formatAgentTaskCountsLine(agentId: string): string | undefined {
  const snapshot = buildTaskStatusSnapshot(listTasksForAgentIdForStatus(agentId));
  if (snapshot.totalCount === 0) {
    return undefined;
  }
  return `📌 Tasks: ${snapshot.activeCount} active · ${snapshot.totalCount} total · agent-local`;
}

async function resolveRuntimePluginHealthLine(): Promise<string | undefined> {
  try {
    const { collectRuntimePluginHealthSnapshot } = await loadStatusPluginHealthRuntime();
    return formatCompactPluginHealthLine(collectRuntimePluginHealthSnapshot());
  } catch {
    return "⚠️ Plugins: health unavailable";
  }
}

// Public status text builder for CLI/chat status commands. It resolves dynamic
// runtime details just-in-time and returns the formatted multiline status body.
export async function buildStatusText(params: BuildStatusTextParams): Promise<string> {
  const {
    cfg,
    sessionEntry,
    sessionKey,
    parentSessionKey,
    sessionScope,
    storePath,
    statusChannel,
    provider,
    model,
    contextTokens,
    resolvedThinkLevel,
    resolvedFastMode,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    resolveDefaultThinkingLevel,
    isGroup,
    defaultGroupActivation,
  } = params;
  const statusAgentId = sessionKey
    ? resolveSessionAgentId({ sessionKey, config: cfg })
    : resolveDefaultAgentId(cfg);
  const statusAgentDir = resolveAgentDir(cfg, statusAgentId);
  const statusWorkspaceDir =
    params.workspaceDir ??
    sessionEntry?.spawnedWorkspaceDir ??
    resolveAgentWorkspaceDir(cfg, statusAgentId);
  const selectedProvider = sessionEntry?.providerOverride?.trim() ?? provider;
  const selectedModel = sessionEntry?.modelOverride?.trim() ?? model;
  const parseSelectedProvider = Boolean(
    sessionEntry?.modelOverride?.trim() && !sessionEntry?.providerOverride?.trim(),
  );
  const modelRefs = resolveSelectedAndActiveModel({
    selectedProvider,
    selectedModel,
    sessionEntry,
    parseSelectedProvider,
  });
  const selectedLookupProvider = modelRefs.selected.provider || selectedProvider || provider;
  const selectedLookupModel = modelRefs.selected.model || selectedModel || model;
  const effectiveHarness =
    params.resolvedHarness ??
    (await resolveStatusHarnessId({
      cfg,
      provider: selectedLookupProvider,
      model: selectedLookupModel,
      agentId: statusAgentId,
      sessionKey,
      sessionEntry,
    }));
  const codexCliCredentialsHome = resolveStatusCodexCliCredentialsHome({
    agentDir: statusAgentDir,
    effectiveHarness,
  });
  const selectedStatusProvider = resolveStatusRuntimeProvider({
    provider: selectedLookupProvider,
    effectiveHarness,
  });
  const selectedAuthProviders = listOpenAIAuthProfileProvidersForAgentRuntime({
    provider: selectedLookupProvider,
    harnessRuntime: effectiveHarness,
    config: cfg,
  });
  const activeProvider = modelRefs.active.provider || provider;
  const activeStatusProvider = resolveStatusRuntimeProvider({
    provider: activeProvider,
    effectiveHarness,
  });
  const activeAuthProviders = listOpenAIAuthProfileProvidersForAgentRuntime({
    provider: activeProvider,
    harnessRuntime: effectiveHarness,
    config: cfg,
  });
  let selectedModelAuth = Object.hasOwn(params, "modelAuthOverride")
    ? params.modelAuthOverride
    : resolveStatusModelAuthLabel({
        provider: selectedStatusProvider,
        acceptedProviderIds: selectedAuthProviders,
        cfg,
        sessionEntry,
        agentDir: statusAgentDir,
        workspaceDir: statusWorkspaceDir,
        codexCliCredentialsHome,
        includeExternalProfiles: false,
      });
  const activeModelAuth = Object.hasOwn(params, "activeModelAuthOverride")
    ? params.activeModelAuthOverride
    : modelRefs.activeDiffers
      ? resolveStatusModelAuthLabel({
          provider: activeStatusProvider,
          acceptedProviderIds: activeAuthProviders,
          cfg,
          sessionEntry,
          agentDir: statusAgentDir,
          workspaceDir: statusWorkspaceDir,
          codexCliCredentialsHome,
          includeExternalProfiles: false,
        })
      : selectedModelAuth;
  const runtimeAliasModelEquivalent = areRuntimeModelRefsEquivalent(
    modelRefs.selected.label,
    modelRefs.active.label,
    { config: cfg },
  );
  const fallbackState = resolveActiveFallbackState({
    selectedModelRef: modelRefs.selected.label || "unknown",
    activeModelRef: modelRefs.active.label || "unknown",
    config: cfg,
    state: sessionEntry,
  });
  if (
    shouldPreferActiveRuntimeAliasAuthLabel({
      runtimeAliasModelEquivalent,
      selectedAuthLabel: selectedModelAuth,
      activeAuthLabel: activeModelAuth,
    })
  ) {
    // Runtime aliases can make selected/active model refs equivalent while auth
    // labels differ; prefer the active auth label so status matches execution.
    selectedModelAuth = activeModelAuth;
  }
  const activeRuntimeIsAuthoritative =
    !modelRefs.activeDiffers ||
    fallbackState.active ||
    hasSessionAutoModelFallbackProvenance(sessionEntry) ||
    runtimeAliasModelEquivalent;
  const usageAuthLabel = activeRuntimeIsAuthoritative ? activeModelAuth : selectedModelAuth;
  const usageStatusProvider = activeRuntimeIsAuthoritative
    ? activeStatusProvider
    : selectedStatusProvider;
  const usageProvider = activeRuntimeIsAuthoritative ? activeProvider : selectedLookupProvider;
  const selectedUsageCredentialType = resolveUsageCredentialType(usageAuthLabel);
  const useCodexSyntheticUsage =
    selectedUsageCredentialType !== "api_key" &&
    shouldUseCodexSyntheticUsageForRuntime({
      provider: usageStatusProvider,
      effectiveHarness,
    });
  const codexUsageAuthProfileId = useCodexSyntheticUsage
    ? resolveCodexSyntheticUsageAuthProfileId({
        profileId: sessionEntry?.authProfileOverride,
        cfg,
        agentDir: statusAgentDir,
      })
    : undefined;
  const usageCredentialType = useCodexSyntheticUsage ? "token" : selectedUsageCredentialType;
  const currentUsageProvider =
    resolveUsageProviderId(usageStatusProvider, { credentialType: usageCredentialType }) ??
    resolveUsageProviderId(usageProvider, { credentialType: usageCredentialType });
  let usageLine: string | null = null;
  if (
    currentUsageProvider &&
    shouldLoadUsageSummary({
      provider: currentUsageProvider,
      selectedModelAuth: usageAuthLabel,
      credentialType: usageCredentialType,
    })
  ) {
    try {
      // Usage summary is optional operator context. Bound it tightly so a slow
      // provider usage probe cannot delay the status command.
      const usageSummaryTimeoutMs = useCodexSyntheticUsage ? 8000 : 3500;
      let usageTimeout: NodeJS.Timeout | undefined;
      const usageSummary = await Promise.race([
        loadProviderUsageSummary({
          timeoutMs: usageSummaryTimeoutMs,
          providers: [currentUsageProvider],
          agentDir: statusAgentDir,
          workspaceDir: statusWorkspaceDir,
          config: cfg,
          auth: useCodexSyntheticUsage
            ? [buildCodexSyntheticUsageAuth({ authProfileId: codexUsageAuthProfileId })]
            : undefined,
        }),
        new Promise<never>((_, reject) => {
          usageTimeout = setTimeout(
            () => reject(new Error("usage summary timeout")),
            usageSummaryTimeoutMs,
          );
        }),
      ]).finally(() => {
        if (usageTimeout) {
          clearTimeout(usageTimeout);
        }
      });
      const usageEntry = usageSummary.providers[0];
      if (
        usageEntry &&
        !usageEntry.error &&
        (usageEntry.windows.length > 0 ||
          Boolean(usageEntry.billing?.length) ||
          Boolean(usageEntry.summary?.trim()))
      ) {
        const summaryLine = formatUsageWindowSummary(usageEntry, {
          now: Date.now(),
          maxWindows: 2,
          includeResets: true,
        });
        if (summaryLine) {
          usageLine = `📊 Usage: ${summaryLine}`;
        }
      }
    } catch {
      usageLine = null;
    }
  }
  usageLine = await appendSessionCostLine(usageLine, cfg, statusAgentId, sessionEntry, storePath);
  const { getFollowupQueueDepth, resolveQueueSettings } = await loadStatusQueueRuntime();
  const queueSettings = resolveQueueSettings({
    cfg,
    channel: statusChannel,
    sessionEntry,
  });
  const queueKey = sessionKey ?? sessionEntry?.sessionId;
  const queueDepth = queueKey ? getFollowupQueueDepth(queueKey) : 0;
  const queueOverrides = Boolean(
    sessionEntry?.queueDebounceMs ?? sessionEntry?.queueCap ?? sessionEntry?.queueDrop,
  );

  let subagentsLine: string | undefined;
  let taskLine: string | undefined;
  let automationLine: string | undefined;
  if (sessionKey) {
    const { mainKey, alias } = resolveMainSessionAlias(cfg);
    const requesterKey = resolveInternalSessionKey({ key: sessionKey, alias, mainKey });
    // Task/subagent status should follow the internal session key alias used by
    // runtime registries, not necessarily the external key passed to the command.
    taskLine = params.skipDefaultTaskLookup
      ? params.taskLineOverride
      : (params.taskLineOverride ?? formatSessionTaskLine(requesterKey));
    if (!taskLine && !params.skipDefaultTaskLookup) {
      taskLine = formatAgentTaskCountsLine(statusAgentId);
    }
    const automationRun = getLatestAutomationRunForRequester(requesterKey);
    if (automationRun) {
      automationLine = buildAutomationCompactStatusLine({ run: automationRun });
    }
    const { buildSubagentsStatusLine, countPendingDescendantRuns, listControlledSubagentRuns } =
      await loadStatusSubagentsRuntime();
    const runs = listControlledSubagentRuns(requesterKey);
    const verboseEnabled = resolvedVerboseLevel && resolvedVerboseLevel !== "off";
    subagentsLine = buildSubagentsStatusLine({
      runs,
      verboseEnabled,
      pendingDescendantsForRun: (entry) => countPendingDescendantRuns(entry.childSessionKey),
    });
  }
  const groupActivation = isGroup
    ? (normalizeGroupActivation(sessionEntry?.groupActivation) ?? defaultGroupActivation())
    : undefined;
  const agentDefaults = cfg.agents?.defaults ?? {};
  const agentConfig = resolveAgentConfig(cfg, statusAgentId);
  const effectiveFastMode =
    resolvedFastMode ??
    resolveFastModeState({
      cfg,
      provider,
      model,
      agentId: statusAgentId,
      sessionEntry,
    }).mode;
  const agentFallbacksOverride = resolveAgentModelFallbacksOverride(cfg, statusAgentId);
  const configuredDefaultRef = resolveDefaultModelForAgent({
    cfg,
    agentId: statusAgentId,
    allowPluginNormalization: false,
  });
  const configuredDefaultModelLabel = `${configuredDefaultRef.provider}/${configuredDefaultRef.model}`;
  const pluginHealthLine = Object.hasOwn(params, "pluginHealthLineOverride")
    ? params.pluginHealthLineOverride
    : await resolveRuntimePluginHealthLine();
  const channelFeatureLine = resolveStatusChannelFeatureLine({
    cfg,
    statusChannel,
    statusAccountId: params.statusAccountId,
    sessionEntry,
  });
  const { buildStatusMessage } = await loadStatusMessageRuntime();
  await waitForContextWindowCacheLoad();
  const explicitThinkingDefault =
    (agentConfig?.thinkingDefault as ThinkLevel | undefined) ??
    (agentDefaults.thinkingDefault as ThinkLevel | undefined);
  const configuredContextTokens =
    typeof agentConfig?.contextTokens === "number" && agentConfig.contextTokens > 0
      ? agentConfig.contextTokens
      : typeof agentDefaults.contextTokens === "number" && agentDefaults.contextTokens > 0
        ? agentDefaults.contextTokens
        : undefined;
  const runtimeContextTokens = resolveStatusRuntimeContextTokens({
    cfg,
    provider: activeStatusProvider,
    model: modelRefs.active.model || model,
  });
  const selectedContextTokens = resolveStatusRuntimeContextTokens({
    cfg,
    provider: selectedStatusProvider,
    model: modelRefs.selected.model || selectedLookupModel,
  });
  const statusAgentContextTokens =
    typeof contextTokens === "number" &&
    contextTokens > 0 &&
    (activeRuntimeIsAuthoritative ||
      contextTokens === configuredContextTokens ||
      contextTokens === selectedContextTokens)
      ? contextTokens
      : undefined;
  const statusRuntimeContextTokens = activeRuntimeIsAuthoritative
    ? (runtimeContextTokens ??
      (fallbackState.active && typeof contextTokens === "number" && contextTokens > 0
        ? contextTokens
        : undefined))
    : undefined;
  const requestedThinkLevel =
    resolvedThinkLevel ??
    explicitThinkingDefault ??
    (await resolveDefaultThinkingLevel()) ??
    (sessionEntry?.thinkingLevel as ThinkLevel | undefined) ??
    "off";
  const effectiveThinkLevel = resolveSupportedThinkingLevel({
    provider: selectedLookupProvider,
    model: selectedLookupModel,
    level: requestedThinkLevel,
    agentRuntime: effectiveHarness,
  });
  return buildStatusMessage({
    config: cfg,
    agent: {
      ...agentDefaults,
      model: {
        ...toAgentModelListLike(agentDefaults.model),
        primary: params.primaryModelLabelOverride ?? `${provider}/${model}`,
        ...(agentFallbacksOverride === undefined ? {} : { fallbacks: agentFallbacksOverride }),
      },
      ...(statusAgentContextTokens !== undefined
        ? { contextTokens: statusAgentContextTokens }
        : {}),
      thinkingDefault: explicitThinkingDefault,
      verboseDefault: agentDefaults.verboseDefault,
      reasoningDefault: agentConfig?.reasoningDefault ?? agentDefaults.reasoningDefault,
      elevatedDefault: agentDefaults.elevatedDefault,
    },
    agentId: statusAgentId,
    configuredDefaultModelLabel,
    explicitConfiguredContextTokens: configuredContextTokens,
    runtimeContextTokens: statusRuntimeContextTokens,
    sessionEntry,
    sessionKey,
    parentSessionKey,
    sessionScope,
    sessionStorePath: storePath,
    groupActivation,
    resolvedThink: effectiveThinkLevel,
    resolvedFast: effectiveFastMode,
    resolvedHarness: effectiveHarness,
    resolvedVerbose: resolvedVerboseLevel,
    resolvedReasoning: resolvedReasoningLevel,
    resolvedElevated: resolvedElevatedLevel,
    modelAuth: selectedModelAuth,
    activeModelAuth,
    uptimeLine: buildStatusUptimeLine(),
    usageLine: usageLine ?? undefined,
    queue: {
      mode: queueSettings.mode,
      depth: queueDepth,
      debounceMs: queueSettings.debounceMs,
      cap: queueSettings.cap,
      dropPolicy: queueSettings.dropPolicy,
      showDetails: queueOverrides,
    },
    subagentsLine,
    taskLine,
    automationLine,
    pluginHealthLine,
    channelFeatureLine,
    mediaDecisions: params.mediaDecisions,
    includeTranscriptUsage: params.includeTranscriptUsage ?? true,
  });
}
