import { ensureAuthProfileStore } from "../../agents/auth-profiles.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { updateConfig } from "../../commands/models/shared.js";
import { updateSessionStore } from "../../config/sessions.js";
import type { PendingOAuthReauth } from "../../config/sessions/types.js";
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
  | { kind: "start"; requestedProfileId?: string }
  | { kind: "status" }
  | { kind: "cancel" };

const DEVICE_CODE_WATCH_DURATION_MS = 10 * 60_000;
const DEVICE_CODE_WATCH_DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_CODE_WATCH_MIN_INTERVAL_MS = 1_000;
const DEVICE_CODE_WATCH_MAX_INTERVAL_MS = 15_000;

const activeDeviceCodeWatchers = new Map<string, ReturnType<typeof setTimeout>>();

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
  const tokens = argText.split(/\s+/).filter(Boolean);
  if (tokens.length !== 1) {
    return { error: "Usage: /reauth [provider:profile-id|profile-id|status|cancel]" };
  }
  return { kind: "start", requestedProfileId: tokens[0] };
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

function clearPendingReauth(params: Parameters<CommandHandler>[0]): void {
  if (!params.sessionEntry) {
    return;
  }
  delete params.sessionEntry.pendingOAuthReauth;
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
    "Open this OAuth URL in any browser, sign in, then paste the full redirect URL or ?code=...&state=... response back in this thread:",
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
      syncSiblingAgents: true,
      profileId: params.profileId,
    },
  );
  await updateConfig((cfg) =>
    applyAuthProfileConfig(cfg, {
      profileId,
      provider: params.provider,
      mode: "oauth",
    }),
  );
  return profileId;
}

async function pollDeviceCodeReauth(params: {
  commandParams: Parameters<CommandHandler>[0];
  pending: PendingOAuthReauth;
  capability: NonNullable<ReturnType<typeof getChatReauthCapability>>;
}): Promise<string | null> {
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
  const profileId = await persistOAuthCredentials({
    commandParams: params.commandParams,
    provider: params.pending.provider,
    profileId: params.pending.profileId,
    creds,
  });
  stopDeviceCodeReauthWatcher(params.commandParams, params.pending);
  clearPendingReauth(params.commandParams);
  await persistSessionEntry(params.commandParams);
  return profileId;
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
      if (completedProfileId) {
        finish();
        await params.commandParams.opts?.onBlockReply?.({
          text: `🔐 Re-auth complete for ${completedProfileId}.`,
        });
        return;
      }
    } catch (error) {
      finish();
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
  const pending = params.sessionEntry?.pendingOAuthReauth;
  if (!pending) {
    return null;
  }
  const capability = getChatReauthCapability(pending.provider);
  if (!capability) {
    return null;
  }

  const rawBody = resolveMessageBody(params);
  if (!capability.looksLikeCallbackInput(rawBody)) {
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
    clearPendingReauth(params);
    await persistSessionEntry(params);
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
    clearPendingReauth(params);
    await persistSessionEntry(params);
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ Re-auth request for ${pending.profileId} is incomplete. Reply /reauth ${pending.profileId} to start a new one.`,
      },
    };
  }

  try {
    const creds = await capability.completePendingAuthorization({
      input: rawBody,
      pending: {
        state: pending.state,
        verifier: pending.verifier,
        redirectUri: pending.redirectUri,
      },
    });
    const profileId = await persistOAuthCredentials({
      commandParams: params,
      provider: pending.provider,
      profileId: pending.profileId,
      creds,
    });
    clearPendingReauth(params);
    await persistSessionEntry(params);
    return {
      shouldContinue: false,
      reply: { text: `🔐 Re-auth complete for ${profileId}.` },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      shouldContinue: false,
      reply: { text: `⚠️ Re-auth failed: ${message}` },
    };
  }
};

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
          if (completedProfileId) {
            return {
              shouldContinue: false,
              reply: { text: `🔐 Re-auth complete for ${completedProfileId}.` },
            };
          }
        } catch (error) {
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
  const existing = store?.profiles[profileId];
  const provider = resolveChatReauthProvider({
    profileId,
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
      reply: { text: formatThreadReauthUnsupported(profileId, provider) },
    };
  }
  if (existing && existing.type !== "oauth") {
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ ${profileId} uses ${existing.type}, not OAuth. Re-auth is only available for OAuth profiles.`,
      },
    };
  }

  const authorization = await capability.createPendingAuthorization({ originator: "pi" });
  const pending: PendingOAuthReauth = {
    kind: "oauth",
    provider,
    profileId,
    ...authorization,
  };
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
