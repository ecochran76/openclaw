import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveAuthProfileOrder } from "../../agents/auth-profiles/order.js";
import {
  clearSessionAuthProfileOverride,
  setSessionAuthProfileOverride,
} from "../../agents/auth-profiles/session-override.js";
import { ensureAuthProfileStore } from "../../agents/auth-profiles/store.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { rejectNonOwnerCommand, rejectUnauthorizedCommand } from "./command-gates.js";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";

type ParsedProfileCommand =
  | { kind: "status" }
  | { kind: "clear"; provider?: string }
  | { kind: "set"; profileId: string; provider?: string };

function commandReply(text: string): CommandHandlerResult {
  return { shouldContinue: false, reply: { text } };
}

function parseProviderFlag(tokens: string[]): { provider?: string; error?: string } {
  if (tokens.length === 0) {
    return {};
  }
  if (tokens[0] !== "--provider") {
    return { error: `Unexpected argument "${tokens[0]}". Expected --provider <provider>.` };
  }
  const provider = tokens[1]?.trim();
  if (!provider || provider.startsWith("--")) {
    return { error: "Missing value for --provider." };
  }
  if (tokens.length > 2) {
    return { error: "Unexpected extra arguments after --provider <provider>." };
  }
  return { provider };
}

function parseProfileCommand(raw: string): ParsedProfileCommand | { error: string } {
  const argText = raw.replace(/^\/profile\b/iu, "").trim();
  if (!argText) {
    return { kind: "status" };
  }
  const tokens = argText.split(/\s+/u).filter(Boolean);
  if (tokens[0]?.toLowerCase() === "clear") {
    const parsed = parseProviderFlag(tokens.slice(1));
    return parsed.error ? { error: parsed.error } : { kind: "clear", provider: parsed.provider };
  }
  const profileId = tokens[0]?.trim();
  if (!profileId) {
    return { error: "Usage: /profile <id> [--provider <provider>]" };
  }
  const parsed = parseProviderFlag(tokens.slice(1));
  return parsed.error
    ? { error: parsed.error }
    : { kind: "set", profileId, provider: parsed.provider };
}

function parseProfilesCommand(raw: string): { provider?: string } | { error: string } {
  const tokens = raw
    .replace(/^\/profiles\b/iu, "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const parsed = parseProviderFlag(tokens);
  return parsed.error ? { error: parsed.error } : { provider: parsed.provider };
}

function resolveCommandProvider(input: string | undefined, params: HandleCommandsParams): string {
  const normalized = normalizeProviderId(input ?? params.provider);
  // These retired provider names remain valid only as operator input aliases.
  const canonical = ["codex", "openai-codex", "openaicodex"].includes(normalized)
    ? "openai"
    : normalized;
  return resolveProviderIdForAuth(canonical, {
    config: params.cfg,
    workspaceDir: params.workspaceDir,
  });
}

function resolveRequestedProfileId(params: { requested: string; profileIds: string[] }): {
  profileId?: string;
  ambiguous?: string[];
} {
  if (params.profileIds.includes(params.requested)) {
    return { profileId: params.requested };
  }
  if (params.requested.includes(":")) {
    return {};
  }
  const matches = params.profileIds.filter((profileId) => {
    const separator = profileId.lastIndexOf(":");
    return separator >= 0 && profileId.slice(separator + 1) === params.requested;
  });
  if (matches.length === 1) {
    return { profileId: matches[0] };
  }
  return matches.length > 1 ? { ambiguous: matches } : {};
}

function resolveProfileProvider(params: {
  commandParams: HandleCommandsParams;
  profileId: string;
  store: ReturnType<typeof ensureAuthProfileStore>;
}): string | undefined {
  const configuredProvider =
    params.store.profiles[params.profileId]?.provider ??
    params.commandParams.cfg.auth?.profiles?.[params.profileId]?.provider;
  const qualifiedProvider = params.profileId.split(":", 1)[0]?.trim();
  const provider = configuredProvider ?? qualifiedProvider;
  return provider ? resolveCommandProvider(provider, params.commandParams) : undefined;
}

function requirePersistedSession(params: HandleCommandsParams): CommandHandlerResult | null {
  if (params.sessionEntry && params.sessionStore && params.sessionKey) {
    return null;
  }
  return commandReply("⚠️ Profile selection is unavailable before this session is persisted.");
}

function syncPersistedSessionEntry(params: HandleCommandsParams): void {
  const persisted = params.sessionStore?.[params.sessionKey];
  if (persisted) {
    params.sessionEntry = persisted;
  }
  markCommandSessionMetadataChanged(params);
}

function rejectProfileCommand(params: HandleCommandsParams, label: string) {
  return rejectUnauthorizedCommand(params, label) ?? rejectNonOwnerCommand(params, label);
}

export const handleProfilesCommand: CommandHandler = async (params, allowTextCommands) => {
  const raw = params.command.commandBodyNormalized;
  if (!allowTextCommands || (raw !== "/profiles" && !raw.startsWith("/profiles "))) {
    return null;
  }
  const rejected = rejectProfileCommand(params, "/profiles");
  if (rejected) {
    return rejected;
  }
  const parsed = parseProfilesCommand(raw);
  if ("error" in parsed) {
    return commandReply(`⚠️ ${parsed.error}`);
  }
  const provider = resolveCommandProvider(parsed.provider, params);
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
    config: params.cfg,
    readOnly: true,
  });
  const profileIds = resolveAuthProfileOrder({ cfg: params.cfg, store, provider });
  const active = params.sessionEntry?.authProfileOverride?.trim();
  const lines = profileIds.map((profileId) => `${profileId === active ? "*" : "-"} ${profileId}`);
  return commandReply(
    profileIds.length === 0
      ? `👤 Profiles (${provider}): none\nLogin: openclaw models auth login --provider ${provider}`
      : [
          `👤 Profiles (${provider})`,
          ...lines,
          active && profileIds.includes(active) ? `Active: ${active}` : "Active: inherited/default",
        ].join("\n"),
  );
};

export const handleProfileCommand: CommandHandler = async (params, allowTextCommands) => {
  const raw = params.command.commandBodyNormalized;
  if (!allowTextCommands || (raw !== "/profile" && !raw.startsWith("/profile "))) {
    return null;
  }
  const rejected = rejectProfileCommand(params, "/profile");
  if (rejected) {
    return rejected;
  }
  const parsed = parseProfileCommand(raw);
  if ("error" in parsed) {
    return commandReply(`⚠️ ${parsed.error}`);
  }
  if (parsed.kind === "status") {
    const current = params.sessionEntry?.authProfileOverride?.trim();
    return commandReply(
      current
        ? `👤 Session profile override: ${current}`
        : "👤 Session profile override: none (using defaults)",
    );
  }
  const unavailable = requirePersistedSession(params);
  if (unavailable) {
    return unavailable;
  }
  const provider = resolveCommandProvider(parsed.provider, params);
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
    config: params.cfg,
    readOnly: true,
  });
  const profileIds = resolveAuthProfileOrder({ cfg: params.cfg, store, provider });

  if (parsed.kind === "clear") {
    const current = params.sessionEntry?.authProfileOverride?.trim();
    const activeProvider = current
      ? resolveProfileProvider({ commandParams: params, profileId: current, store })
      : undefined;
    if (parsed.provider && current && activeProvider !== provider) {
      return commandReply(
        `⚠️ Session profile override "${current}" is not for ${provider}; it was not cleared.`,
      );
    }
    await clearSessionAuthProfileOverride({
      sessionEntry: params.sessionEntry!,
      sessionStore: params.sessionStore!,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
    syncPersistedSessionEntry(params);
    return commandReply("👤 Cleared session profile override; using defaults.");
  }

  const resolved = resolveRequestedProfileId({ requested: parsed.profileId, profileIds });
  if (resolved.ambiguous) {
    return commandReply(
      `⚠️ Profile label "${parsed.profileId}" is ambiguous: ${resolved.ambiguous.join(", ")}. Use a qualified profile id.`,
    );
  }
  if (!resolved.profileId) {
    return commandReply(`⚠️ Auth profile "${parsed.profileId}" was not found for ${provider}.`);
  }
  await setSessionAuthProfileOverride({
    sessionEntry: params.sessionEntry!,
    sessionStore: params.sessionStore!,
    sessionKey: params.sessionKey,
    profileId: resolved.profileId,
    storePath: params.storePath,
  });
  syncPersistedSessionEntry(params);
  return commandReply(`👤 Session profile override set to ${resolved.profileId} (${provider}).`);
};
