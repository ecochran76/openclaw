import {
  CODEX_CLI_PROFILE_ID,
  OPENAI_CODEX_DEFAULT_PROFILE_ID,
} from "../agents/auth-profiles/constants.js";
import { readCodexCliCredentialsCached } from "../agents/cli-credentials.js";
import type { OAuthCredential } from "../agents/auth-profiles/types.js";

export { CODEX_CLI_PROFILE_ID, OPENAI_CODEX_DEFAULT_PROFILE_ID };
export const OPENAI_CODEX_PROVIDER_ID = "openai";
export const OPENAI_CODEX_PROVIDER_LABEL = "OpenAI Codex";

export function isDeprecatedOpenAICodexCliProfileId(profileId?: string): boolean {
  return profileId?.trim() === CODEX_CLI_PROFILE_ID;
}

export function buildOpenAICodexExternalCliSyncProvider(ttlMs: number): {
  profileId: string;
  profileAliases: readonly string[];
  provider: "openai";
  aliases: readonly string[];
  readCredentials: (options?: { allowKeychainPrompt?: boolean }) => OAuthCredential | null;
} {
  return {
    profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
    profileAliases: ["openai-codex:default"],
    provider: OPENAI_CODEX_PROVIDER_ID,
    aliases: ["openai", "codex", "codex-cli", "codex-app-server", "openai-codex"],
    readCredentials: (options) =>
      readCodexCliCredentialsCached({
        ttlMs,
        allowKeychainPrompt: options?.allowKeychainPrompt,
      }),
  };
}
