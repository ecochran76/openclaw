import {
  clearAuthProfileCooldown,
  ensureAuthProfileStore,
  promoteAuthProfileInOrder,
} from "../../agents/auth-profiles.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { updateConfig } from "../../commands/models/shared.js";
import { updateSessionStore } from "../../config/sessions.js";
import type { PendingOAuthReauth, SessionEntry } from "../../config/sessions/types.js";
import { logVerbose } from "../../globals.js";
import {
  applyAuthProfileConfig,
  writeOAuthCredentials,
} from "../../plugins/provider-auth-helpers.js";
import type { CommandHandler } from "./commands-types.js";
import {
  getChatReauthCapability,
  resolveChatReauthProvider,
  resolveRequestedChatReauthProfileId,
} from "./reauth-capabilities.js";

type ParsedReauthCommand =
  | {
      kind: "start";
      requestedProfileId?: string;
      preferredFlow?: "device_code" | "callback";
    }
  | { kind: "status" }
  | { kind: "cancel" }
  | { kind: "callback"; callbackInput: string };

const DEVICE_CODE_WATCH_DURATION_MS = 10 * 60_000;
const DEVICE_CODE_WATCH_DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_CODE_WATCH_MIN_INTERVAL_MS = 1_000;
const DEVICE_CODE_WATCH_MAX_INTERVAL_MS = 15_000;
const POST_REAUTH_PROBE_TIMEOUT_MS = 45_000;
const POST_REAUTH_PROBE_MAX_TOKENS = 16;

type ListProbeRuntime = typeof import("../../commands/models/list.probe.js");

let listProbeRuntimePromise: Promise<ListProbeRuntime> | undefined;

function loadListProbeRuntime(): Promise<ListProbeRuntime> {
  listProbeRuntimePromise ??= import("../../commands/models/list.probe.js");
  return listProbeRuntimePromise;
}

const activeDeviceCodeWatchers = new Map<string, ReturnType<typeof setTimeout>>();

type PendingReauthMatch = {
  pending: PendingOAuthReauth;
  sessionEntry: SessionEntry;
  sessionKey: string;
};

type PostReauthProbeResult = {
  ok: boolean;
  profileId: string;
  model?: string;
  status?: string;
  error?: string;
};

function resolveMessageBody(params: Parameters<CommandHandler>[0]): string {
  return (
    params.ctx.BodyForCommands ??
    params.ctx.CommandBody ??
    params.ctx.RawBody ??
    params.ctx.Body ??
    ""
  ).trim();
}

function parseReauthCommand(raw: string): ParsedReauthCommand | { error: string } {
  const argText = raw.replace(/^\/reauth\b/i, "").trim();
  if (!argText) {
    return { kind: "start" };
  }
  if (argText === "status") {
    return { kind: "status" };
  }
  if (argText === "cancel") {
    return { kind: "cancel" };
  }
  if (/^(?:callback|complete)$/i.test(argText)) {
    return { error: "Usage: /reauth callback <redirect-url>" };
  }
  const callbackMatch = argText.match(/^(?:callback|complete)\s+([\s\S]+)$/i);
  if (callbackMatch?.[1]?.trim()) {
    return { kind: "callback", callbackInput: callbackMatch[1].trim() };
  }
  const tokens = argText.split(/\s+/).filter(Boolean);
  let preferredFlow: "device_code" | "callback" | undefined;
  const profileTokens: string[] = [];
  for (const token of tokens) {
    if (token === "--oauth" || token === "--callback" || token === "--browser") {
      preferredFlow = "callback";
      continue;
    }
    if (token === "--device-code" || token === "--device") {
      preferredFlow = "device_code";
      continue;
    }
    profileTokens.push(token);
  }
  if (profileTokens.length > 1) {
    return {
      error:
        "Usage: /reauth [--oauth|--device-code] [provider:profile-id|profile-id|status|cancel] or /reauth callback <redirect-url>",
    };
  }
  if (profileTokens[0] === "status") {
    return { kind: "status" };
  }
  if (profileTokens[0] === "cancel") {
    return { kind: "cancel" };
  }
  return { kind: "start", requestedProfileId: profileTokens[0], preferredFlow };
}

function extractOAuthCallbackState(input: string): string | undefined {
  const trimmed = decodeChatEscapes(input.trim());
  if (!trimmed) {
    return undefined;
  }
  const candidates = [trimmed];
  const slackLink = trimmed.match(/<([^>|]+)(?:\|[^>]+)?>/);
  if (slackLink?.[1]) {
    candidates.unshift(trimCallbackCandidate(slackLink[1]));
  }
  const urlMatch = trimmed.match(/https?:\/\/[^\s<>]+/i);
  if (urlMatch?.[0]) {
    candidates.push(trimCallbackCandidate(urlMatch[0]));
  }
  const queryIndex = trimmed.indexOf("?code=");
  if (queryIndex >= 0) {
    candidates.push(trimCallbackCandidate(trimmed.slice(queryIndex)));
  }

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      const state = url.searchParams.get("state")?.trim();
      if (state) {
        return state;
      }
    } catch {
      // Try query-string parsing below.
    }
    const params = new URLSearchParams(
      candidate.startsWith("?") ? candidate.slice(1) : candidate.replace(/^[^?]*\?/, ""),
    );
    const state = params.get("state")?.trim();
    if (state) {
      return state;
    }
  }
  return undefined;
}

function decodeChatEscapes(input: string): string {
  let decoded = input;
  for (let i = 0; i < 3; i += 1) {
    const next = decoded.replace(/&amp;/g, "&");
    if (next === decoded) {
      break;
    }
    decoded = next;
  }
  return decoded;
}

function trimCallbackCandidate(input: string): string {
  return (
    decodeChatEscapes(input.trim())
      .replace(/[>)\]}.,]+$/, "")
      .split("|")[0]
      ?.trim() ?? ""
  );
}

function findPendingReauthMatch(
  params: Parameters<CommandHandler>[0],
  input: string,
): PendingReauthMatch | null {
  const state = extractOAuthCallbackState(input);
  const currentPending = params.sessionEntry?.pendingOAuthReauth;
  if (currentPending && params.sessionEntry) {
    if (
      state &&
      currentPending.flow !== "device_code" &&
      currentPending.state &&
      currentPending.state !== state
    ) {
      // The current Slack session may have a newer pending OAuth flow than the
      // pasted callback. Do not exchange a stale callback against the wrong
      // verifier; keep searching by state for the matching pending flow.
    } else {
      return {
        pending: currentPending,
        sessionEntry: params.sessionEntry,
        sessionKey: params.sessionKey,
      };
    }
  }
  if (!state || !params.sessionStore) {
    return null;
  }
  for (const [sessionKey, sessionEntry] of Object.entries(params.sessionStore)) {
    const pending = sessionEntry.pendingOAuthReauth;
    if (pending?.flow !== "device_code" && pending?.state === state) {
      return { pending, sessionEntry, sessionKey };
    }
  }
  return null;
}

async function persistSessionEntry(params: Parameters<CommandHandler>[0]): Promise<boolean> {
  if (!params.sessionEntry || !params.sessionStore || !params.sessionKey) {
    return false;
  }
  params.sessionEntry.updatedAt = Date.now();
  params.sessionStore[params.sessionKey] = params.sessionEntry;
  if (params.storePath) {
    await updateSessionStore(params.storePath, (store) => {
      store[params.sessionKey] = params.sessionEntry!;
    });
  }
  return true;
}

async function persistMatchedSessionEntry(
  params: Parameters<CommandHandler>[0],
  match: PendingReauthMatch,
): Promise<boolean> {
  match.sessionEntry.updatedAt = Date.now();
  if (params.sessionStore) {
    params.sessionStore[match.sessionKey] = match.sessionEntry;
  }
  if (params.storePath) {
    await updateSessionStore(params.storePath, (store) => {
      store[match.sessionKey] = match.sessionEntry;
    });
  }
  return true;
}

function clearPendingReauth(params: Parameters<CommandHandler>[0]): void {
  if (!params.sessionEntry) {
    return;
  }
  delete params.sessionEntry.pendingOAuthReauth;
}

function clearMatchedPendingReauth(match: PendingReauthMatch): void {
  delete match.sessionEntry.pendingOAuthReauth;
}

function resolveDeviceCodeWatchIntervalMs(pending: PendingOAuthReauth): number {
  const intervalMs = pending.intervalMs;
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return DEVICE_CODE_WATCH_DEFAULT_INTERVAL_MS;
  }
  return Math.min(
    DEVICE_CODE_WATCH_MAX_INTERVAL_MS,
    Math.max(DEVICE_CODE_WATCH_MIN_INTERVAL_MS, Math.trunc(intervalMs)),
  );
}

function resolveDeviceCodeWatcherKey(
  params: Parameters<CommandHandler>[0],
  pending: PendingOAuthReauth,
): string {
  return [
    params.storePath ?? "memory",
    params.sessionKey,
    pending.provider,
    pending.profileId,
    pending.deviceAuthId ?? pending.userCode ?? String(pending.createdAt),
  ].join("\u0000");
}

function formatPendingReauthMessage(pending: PendingOAuthReauth): string {
  if (pending.flow === "device_code") {
    const verificationUrl = pending.verificationUrl ?? pending.authorizationUrl;
    return [
      `🔐 Re-auth pending for ${pending.profileId}.`,
      "Open this URL in a browser and enter the code below:",
      verificationUrl,
      `Code: ${pending.userCode ?? "[missing]"}`,
      "I will watch for completion for up to 10 minutes and confirm here. You can also reply /reauth status to check immediately.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    `🔐 Re-auth pending for ${pending.profileId}.`,
    "Open this OAuth URL in any browser, sign in, then reply with /reauth callback followed by the full redirect URL or ?code=...&state=... response:",
    pending.authorizationUrl ?? "[authorization URL unavailable]",
  ].join("\n");
}

function stopDeviceCodeReauthWatcher(
  params: Parameters<CommandHandler>[0],
  pending: PendingOAuthReauth,
): void {
  const key = resolveDeviceCodeWatcherKey(params, pending);
  const timer = activeDeviceCodeWatchers.get(key);
  if (timer) {
    clearTimeout(timer);
  }
  activeDeviceCodeWatchers.delete(key);
}

function formatThreadReauthUnsupported(profileId: string, provider: string): string {
  return [
    `⚠️ Thread re-auth is not available for ${profileId} (${provider}).`,
    `Use ${formatCliCommand(`openclaw models auth login --provider ${provider} --profile-id ${profileId}`)} instead.`,
  ].join("\n");
}

function shouldSyncOAuthCredentialsToSiblingAgents(provider: string): boolean {
  // OpenAI Codex refresh tokens rotate on use. Copying one fresh token into
  // sibling agents lets concurrent refreshes invalidate each other.
  return normalizeProviderId(provider) !== "openai-codex";
}

async function persistOAuthCredentials(params: {
  commandParams: Parameters<CommandHandler>[0];
  provider: string;
  profileId: string;
  creds: Parameters<typeof writeOAuthCredentials>[1];
}): Promise<string> {
  const profileId = await writeOAuthCredentials(
    params.provider,
    params.creds,
    params.commandParams.agentDir,
    {
      syncSiblingAgents: shouldSyncOAuthCredentialsToSiblingAgents(params.provider),
      profileId: params.profileId,
    },
  );
  await clearAuthProfileCooldown({
    store: ensureAuthProfileStore(params.commandParams.agentDir),
    profileId,
    agentDir: params.commandParams.agentDir,
  });
  const updatedConfig = await updateConfig((cfg) =>
    applyAuthProfileConfig(cfg, {
      profileId,
      provider: params.provider,
      mode: "oauth",
    }),
  );
  params.commandParams.cfg = updatedConfig;
  await promoteAuthProfileInOrder({
    agentDir: params.commandParams.agentDir,
    provider: params.provider,
    profileId,
  });
  return profileId;
}

function resolvePostReauthModelCandidate(params: {
  commandParams: Parameters<CommandHandler>[0];
  provider: string;
}): string | null {
  const provider = normalizeProviderId(params.provider);
  const activeProvider = normalizeProviderId(params.commandParams.provider);
  const model = params.commandParams.model?.trim();
  if (!model || activeProvider !== provider) {
    return null;
  }
  return `${activeProvider}/${model}`;
}

function formatPostReauthProbeFailure(probe: PostReauthProbeResult): string {
  const detail = [
    probe.model ? `model ${probe.model}` : undefined,
    probe.status ? `status ${probe.status}` : undefined,
    probe.error,
  ]
    .filter(Boolean)
    .join("; ");
  return [
    `⚠️ Re-auth credentials were updated for ${probe.profileId}, but the live model probe did not pass.`,
    detail ? `Probe: ${detail}` : undefined,
    "The profile is not verified usable yet.",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatPostReauthProbeSuccess(probe: PostReauthProbeResult): string {
  if (probe.status === "already_ok") {
    return `🔐 Re-auth already complete for ${probe.profileId}. Stored credentials are usable; cleared the stale pending login-code request.`;
  }
  if (probe.status === "ok") {
    return `🔐 Re-auth complete for ${probe.profileId}. Live probe passed.`;
  }
  return `🔐 Re-auth credentials updated for ${probe.profileId}. Live probe was not run for this conversation context.`;
}

function isRecoverableDeviceCodeTokenExchangeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("OpenAI device token exchange failed") &&
    (message.includes("token_exchange_user_error") ||
      message.includes("invalid_request_error") ||
      message.includes("Invalid request"))
  );
}

function hasUsableStoredOAuthCredentials(params: {
  commandParams: Parameters<CommandHandler>[0];
  pending: PendingOAuthReauth;
}): boolean {
  const { commandParams, pending } = params;
  if (pending.flow !== "device_code" || !commandParams.agentDir) {
    return false;
  }
  try {
    const store = ensureAuthProfileStore(commandParams.agentDir);
    const profile = store.profiles[pending.profileId];
    if (!profile || profile.type !== "oauth") {
      return false;
    }
    if (normalizeProviderId(profile.provider) !== normalizeProviderId(pending.provider)) {
      return false;
    }
    return (
      typeof profile.expires === "number" &&
      Number.isFinite(profile.expires) &&
      profile.expires > Date.now()
    );
  } catch {
    return false;
  }
}

async function completeDeviceCodeReauthFromStoredCredentials(params: {
  commandParams: Parameters<CommandHandler>[0];
  pending: PendingOAuthReauth;
}): Promise<PostReauthProbeResult | null> {
  if (!hasUsableStoredOAuthCredentials(params)) {
    return null;
  }
  stopDeviceCodeReauthWatcher(params.commandParams, params.pending);
  clearPendingReauth(params.commandParams);
  await persistSessionEntry(params.commandParams);
  return {
    ok: true,
    profileId: params.pending.profileId,
    status: "already_ok",
  };
}

async function replaceDeviceCodePendingWithCallback(params: {
  commandParams: Parameters<CommandHandler>[0];
  pending: PendingOAuthReauth;
  capability: NonNullable<ReturnType<typeof getChatReauthCapability>>;
}): Promise<PendingOAuthReauth | null> {
  if (params.pending.flow !== "device_code") {
    return null;
  }
  const authorization = await params.capability.createPendingAuthorization({
    originator: "pi",
    preferredFlow: "callback",
  });
  if (authorization.flow !== "callback") {
    return null;
  }
  const fallback: PendingOAuthReauth = {
    kind: "oauth",
    provider: params.pending.provider,
    profileId: params.pending.profileId,
    ...authorization,
  };
  stopDeviceCodeReauthWatcher(params.commandParams, params.pending);
  params.commandParams.sessionEntry!.pendingOAuthReauth = fallback;
  const persisted = await persistSessionEntry(params.commandParams);
  if (!persisted) {
    params.commandParams.sessionEntry!.pendingOAuthReauth = params.pending;
    throw new Error(
      `Could not persist browser OAuth fallback for ${params.pending.profileId}. Reply /reauth --oauth ${params.pending.profileId} to start a new browser OAuth flow.`,
    );
  }
  return fallback;
}

async function probeReauthenticatedProfile(params: {
  commandParams: Parameters<CommandHandler>[0];
  provider: string;
  profileId: string;
}): Promise<PostReauthProbeResult> {
  const modelCandidate = resolvePostReauthModelCandidate({
    commandParams: params.commandParams,
    provider: params.provider,
  });
  if (!modelCandidate) {
    return {
      ok: true,
      profileId: params.profileId,
      status: "skipped",
      error: "Active conversation model does not use this provider.",
    };
  }
  const agentId = params.commandParams.agentId;
  const agentDir = params.commandParams.agentDir;
  if (!agentId || !agentDir) {
    return {
      ok: true,
      profileId: params.profileId,
      model: modelCandidate,
      status: "skipped",
      error: "Agent id or agent directory was unavailable.",
    };
  }
  const { runAuthProbes } = await loadListProbeRuntime();
  const summary = await runAuthProbes({
    cfg: params.commandParams.cfg,
    agentId,
    agentDir,
    workspaceDir: params.commandParams.workspaceDir,
    providers: [params.provider],
    modelCandidates: [modelCandidate],
    options: {
      provider: params.provider,
      profileIds: [params.profileId],
      timeoutMs: POST_REAUTH_PROBE_TIMEOUT_MS,
      concurrency: 1,
      maxTokens: POST_REAUTH_PROBE_MAX_TOKENS,
    },
  });
  const result = summary.results.find((entry) => entry.profileId === params.profileId);
  if (result?.status === "ok") {
    return {
      ok: true,
      profileId: params.profileId,
      model: result.model ?? modelCandidate,
      status: result.status,
    };
  }
  return {
    ok: false,
    profileId: params.profileId,
    model: result?.model ?? modelCandidate,
    status: result?.status,
    error: result?.error ?? "No matching live probe result was returned.",
  };
}

async function persistAndProbeOAuthCredentials(params: {
  commandParams: Parameters<CommandHandler>[0];
  provider: string;
  profileId: string;
  creds: Parameters<typeof writeOAuthCredentials>[1];
}): Promise<PostReauthProbeResult> {
  const profileId = await persistOAuthCredentials(params);
  return await probeReauthenticatedProfile({
    commandParams: params.commandParams,
    provider: params.provider,
    profileId,
  });
}

async function pollDeviceCodeReauth(params: {
  commandParams: Parameters<CommandHandler>[0];
  pending: PendingOAuthReauth;
  capability: NonNullable<ReturnType<typeof getChatReauthCapability>>;
}): Promise<PostReauthProbeResult | null> {
  if (params.pending.flow !== "device_code" || !params.capability.pollPendingAuthorization) {
    return null;
  }
  const creds = await params.capability.pollPendingAuthorization({
    pending: {
      deviceAuthId: params.pending.deviceAuthId,
      userCode: params.pending.userCode,
      intervalMs: params.pending.intervalMs,
      expiresAt: params.pending.expiresAt,
    },
  });
  if (!creds) {
    return null;
  }
  const probe = await persistAndProbeOAuthCredentials({
    commandParams: params.commandParams,
    provider: params.pending.provider,
    profileId: params.pending.profileId,
    creds,
  });
  stopDeviceCodeReauthWatcher(params.commandParams, params.pending);
  clearPendingReauth(params.commandParams);
  await persistSessionEntry(params.commandParams);
  return probe;
}

function startDeviceCodeReauthWatcher(params: {
  commandParams: Parameters<CommandHandler>[0];
  pending: PendingOAuthReauth;
  capability: NonNullable<ReturnType<typeof getChatReauthCapability>>;
}): boolean {
  if (
    params.pending.flow !== "device_code" ||
    !params.capability.pollPendingAuthorization ||
    !params.commandParams.opts?.onBlockReply
  ) {
    return false;
  }
  const key = resolveDeviceCodeWatcherKey(params.commandParams, params.pending);
  if (activeDeviceCodeWatchers.has(key)) {
    return true;
  }
  const deadlineMs = Math.min(params.pending.expiresAt, Date.now() + DEVICE_CODE_WATCH_DURATION_MS);
  const scheduleNext = (delayMs: number) => {
    const timer = setTimeout(() => {
      void pollOnce();
    }, delayMs);
    timer.unref?.();
    activeDeviceCodeWatchers.set(key, timer);
  };
  const finish = () => {
    const timer = activeDeviceCodeWatchers.get(key);
    if (timer) {
      clearTimeout(timer);
    }
    activeDeviceCodeWatchers.delete(key);
  };
  const pollOnce = async () => {
    const currentPending = params.commandParams.sessionEntry?.pendingOAuthReauth;
    if (
      !currentPending ||
      currentPending.provider !== params.pending.provider ||
      currentPending.profileId !== params.pending.profileId ||
      currentPending.deviceAuthId !== params.pending.deviceAuthId
    ) {
      finish();
      return;
    }
    const now = Date.now();
    if (now >= deadlineMs) {
      finish();
      const expired = now >= params.pending.expiresAt;
      if (expired) {
        clearPendingReauth(params.commandParams);
        await persistSessionEntry(params.commandParams);
      }
      await params.commandParams.opts?.onBlockReply?.({
        text: expired
          ? `⚠️ Re-auth request for ${params.pending.profileId} expired. Reply /reauth ${params.pending.profileId} to start a new one.`
          : `🔐 Re-auth for ${params.pending.profileId} is still pending after 10 minutes. Reply /reauth status to check once or /reauth cancel to stop it.`,
      });
      return;
    }
    try {
      const completedProfileId = await pollDeviceCodeReauth({
        commandParams: params.commandParams,
        pending: params.pending,
        capability: params.capability,
      });
      if (completedProfileId?.ok) {
        finish();
        await params.commandParams.opts?.onBlockReply?.({
          text: formatPostReauthProbeSuccess(completedProfileId),
        });
        return;
      }
      if (completedProfileId) {
        finish();
        await params.commandParams.opts?.onBlockReply?.({
          text: formatPostReauthProbeFailure(completedProfileId),
        });
        return;
      }
    } catch (error) {
      finish();
      if (isRecoverableDeviceCodeTokenExchangeError(error)) {
        const alreadyCompleted = await completeDeviceCodeReauthFromStoredCredentials({
          commandParams: params.commandParams,
          pending: params.pending,
        });
        if (alreadyCompleted) {
          await params.commandParams.opts?.onBlockReply?.({
            text: formatPostReauthProbeSuccess(alreadyCompleted),
          });
          return;
        }
        try {
          const fallback = await replaceDeviceCodePendingWithCallback({
            commandParams: params.commandParams,
            pending: params.pending,
            capability: params.capability,
          });
          if (fallback) {
            await params.commandParams.opts?.onBlockReply?.({
              text: [
                `⚠️ Device-code re-auth failed for ${params.pending.profileId}; falling back to browser OAuth.`,
                formatPendingReauthMessage(fallback),
              ].join("\n\n"),
            });
            return;
          }
        } catch {
          // Report the original device-code failure below.
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      await params.commandParams.opts?.onBlockReply?.({
        text: `⚠️ Re-auth failed for ${params.pending.profileId}: ${message}`,
      });
      return;
    }
    const nextDelayMs = Math.min(
      resolveDeviceCodeWatchIntervalMs(params.pending),
      deadlineMs - now,
    );
    scheduleNext(nextDelayMs);
  };
  scheduleNext(resolveDeviceCodeWatchIntervalMs(params.pending));
  return true;
}

export const handlePendingReauthInput: CommandHandler = async (params) => {
  const rawBody = resolveMessageBody(params);
  return await completePendingReauthCallback(params, rawBody, { requireCallbackLikeInput: true });
};

async function completePendingReauthCallback(
  params: Parameters<CommandHandler>[0],
  input: string,
  options?: { requireCallbackLikeInput?: boolean },
): Promise<Awaited<ReturnType<CommandHandler>>> {
  const match = findPendingReauthMatch(params, input);
  if (!match) {
    return null;
  }
  const pending = match.pending;
  const capability = getChatReauthCapability(pending.provider);
  if (!capability) {
    return null;
  }

  if (options?.requireCallbackLikeInput !== false && !capability.looksLikeCallbackInput(input)) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring OAuth callback from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Re-auth can only be completed by an authorized sender." },
    };
  }

  if (Date.now() > pending.expiresAt) {
    clearMatchedPendingReauth(match);
    await persistMatchedSessionEntry(params, match);
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ Re-auth request for ${pending.profileId} expired. Reply /reauth ${pending.profileId} to start a new one.`,
      },
    };
  }

  if (pending.flow === "device_code") {
    return null;
  }

  if (!pending.state || !pending.verifier) {
    clearMatchedPendingReauth(match);
    await persistMatchedSessionEntry(params, match);
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ Re-auth request for ${pending.profileId} is incomplete. Reply /reauth ${pending.profileId} to start a new one.`,
      },
    };
  }

  try {
    const creds = await capability.completePendingAuthorization({
      input,
      pending: {
        state: pending.state,
        verifier: pending.verifier,
        redirectUri: pending.redirectUri,
      },
    });
    const probe = await persistAndProbeOAuthCredentials({
      commandParams: params,
      provider: pending.provider,
      profileId: pending.profileId,
      creds,
    });
    clearMatchedPendingReauth(match);
    await persistMatchedSessionEntry(params, match);
    return {
      shouldContinue: false,
      reply: {
        text: probe.ok ? formatPostReauthProbeSuccess(probe) : formatPostReauthProbeFailure(probe),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      shouldContinue: false,
      reply: { text: `⚠️ Re-auth failed: ${message}` },
    };
  }
}

export const handleReauthCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (normalized !== "/reauth" && !normalized.startsWith("/reauth ")) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /reauth from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  if (!params.sessionEntry) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Session state is unavailable for /reauth in this conversation." },
    };
  }

  const parsed = parseReauthCommand(normalized);
  if ("error" in parsed) {
    return { shouldContinue: false, reply: { text: `⚠️ ${parsed.error}` } };
  }

  if (parsed.kind === "callback") {
    const result = await completePendingReauthCallback(params, parsed.callbackInput, {
      requireCallbackLikeInput: true,
    });
    return (
      result ?? {
        shouldContinue: false,
        reply: {
          text: "⚠️ No matching pending re-auth flow was found for that callback. Reply /reauth status or start a new flow with /reauth --oauth <profile-id>.",
        },
      }
    );
  }

  if (parsed.kind === "status") {
    const pending = params.sessionEntry.pendingOAuthReauth;
    if (pending) {
      const capability = getChatReauthCapability(pending.provider);
      if (capability?.pollPendingAuthorization && Date.now() <= pending.expiresAt) {
        try {
          const completedProfileId = await pollDeviceCodeReauth({
            commandParams: params,
            pending,
            capability,
          });
          if (completedProfileId?.ok) {
            return {
              shouldContinue: false,
              reply: { text: formatPostReauthProbeSuccess(completedProfileId) },
            };
          }
          if (completedProfileId) {
            return {
              shouldContinue: false,
              reply: { text: formatPostReauthProbeFailure(completedProfileId) },
            };
          }
        } catch (error) {
          if (isRecoverableDeviceCodeTokenExchangeError(error)) {
            const alreadyCompleted = await completeDeviceCodeReauthFromStoredCredentials({
              commandParams: params,
              pending,
            });
            if (alreadyCompleted) {
              return {
                shouldContinue: false,
                reply: { text: formatPostReauthProbeSuccess(alreadyCompleted) },
              };
            }
            try {
              const fallback = await replaceDeviceCodePendingWithCallback({
                commandParams: params,
                pending,
                capability,
              });
              if (fallback) {
                return {
                  shouldContinue: false,
                  reply: {
                    text: [
                      `⚠️ Device-code re-auth failed for ${pending.profileId}; falling back to browser OAuth.`,
                      formatPendingReauthMessage(fallback),
                    ].join("\n\n"),
                  },
                };
              }
            } catch (fallbackError) {
              const message =
                fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
              return {
                shouldContinue: false,
                reply: { text: `⚠️ ${message}` },
              };
            }
          }
          const message = error instanceof Error ? error.message : String(error);
          return {
            shouldContinue: false,
            reply: { text: `⚠️ Re-auth failed: ${message}` },
          };
        }
      }
    }
    return {
      shouldContinue: false,
      reply: {
        text: pending
          ? formatPendingReauthMessage(pending)
          : "🔐 No re-auth flow is pending in this session.",
      },
    };
  }

  if (parsed.kind === "cancel") {
    const pending = params.sessionEntry.pendingOAuthReauth;
    const hadPending = Boolean(pending);
    if (pending) {
      stopDeviceCodeReauthWatcher(params, pending);
    }
    clearPendingReauth(params);
    await persistSessionEntry(params);
    return {
      shouldContinue: false,
      reply: {
        text: hadPending
          ? "🔐 Cancelled the pending re-auth flow."
          : "🔐 No re-auth flow was pending.",
      },
    };
  }

  const profileId = resolveRequestedChatReauthProfileId({
    requestedProfileId: parsed.requestedProfileId,
    sessionAuthProfileOverride: params.sessionEntry.authProfileOverride,
  });
  if (!profileId) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Usage: /reauth <profile-id>" },
    };
  }

  const store = params.agentDir
    ? ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false })
    : null;
  const resolvedProfileId =
    parsed.requestedProfileId && !parsed.requestedProfileId.includes(":") && store
      ? (Object.entries(store.profiles).find(
          ([candidateProfileId, credential]) =>
            candidateProfileId.endsWith(`:${parsed.requestedProfileId}`) &&
            credential.type === "oauth" &&
            Boolean(getChatReauthCapability(credential.provider)),
        )?.[0] ?? profileId)
      : profileId;
  const existing = store?.profiles[resolvedProfileId];
  const provider = resolveChatReauthProvider({
    profileId: resolvedProfileId,
    storedProvider: existing?.provider,
    sessionAuthProfileOverride: params.sessionEntry.authProfileOverride,
  });
  if (!provider) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Usage: /reauth <provider:profile-id>" },
    };
  }
  const capability = getChatReauthCapability(provider);

  if (!capability) {
    return {
      shouldContinue: false,
      reply: { text: formatThreadReauthUnsupported(resolvedProfileId, provider) },
    };
  }
  if (existing && existing.type !== "oauth") {
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ ${resolvedProfileId} uses ${existing.type}, not OAuth. Re-auth is only available for OAuth profiles.`,
      },
    };
  }

  const authorization = await capability.createPendingAuthorization({
    originator: "pi",
    preferredFlow: parsed.preferredFlow,
  });
  const pending: PendingOAuthReauth = {
    kind: "oauth",
    provider,
    profileId: resolvedProfileId,
    ...authorization,
  };
  const previousPending = params.sessionEntry.pendingOAuthReauth;
  if (previousPending) {
    stopDeviceCodeReauthWatcher(params, previousPending);
  }
  params.sessionEntry.pendingOAuthReauth = pending;
  await persistSessionEntry(params);
  startDeviceCodeReauthWatcher({
    commandParams: params,
    pending,
    capability,
  });
  return {
    shouldContinue: false,
    reply: { text: formatPendingReauthMessage(pending) },
  };
};
