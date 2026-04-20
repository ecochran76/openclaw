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

function formatPendingReauthMessage(pending: PendingOAuthReauth): string {
  return [
    `🔐 Re-auth pending for ${pending.profileId}.`,
    "Open this URL in a local browser, sign in, then paste the full redirect URL back in this thread:",
    pending.authorizationUrl,
  ].join("\n");
}

function formatThreadReauthUnsupported(profileId: string, provider: string): string {
  return [
    `⚠️ Thread re-auth is not available for ${profileId} (${provider}).`,
    `Use ${formatCliCommand(`openclaw models auth login --provider ${provider} --profile-id ${profileId}`)} instead.`,
  ].join("\n");
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

  try {
    const creds = await capability.completePendingAuthorization({
      input: rawBody,
      pending: {
        state: pending.state,
        verifier: pending.verifier,
        redirectUri: pending.redirectUri,
      },
    });
    const profileId = await writeOAuthCredentials(pending.provider, creds, params.agentDir, {
      syncSiblingAgents: true,
      profileId: pending.profileId,
    });
    await updateConfig((cfg) =>
      applyAuthProfileConfig(cfg, {
        profileId,
        provider: pending.provider,
        mode: "oauth",
      }),
    );
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
    const hadPending = Boolean(params.sessionEntry.pendingOAuthReauth);
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

  const pending: PendingOAuthReauth = {
    kind: "oauth",
    provider,
    profileId,
    ...capability.createPendingAuthorization({ originator: "pi" }),
  };
  params.sessionEntry.pendingOAuthReauth = pending;
  await persistSessionEntry(params);
  return {
    shouldContinue: false,
    reply: { text: formatPendingReauthMessage(pending) },
  };
};
