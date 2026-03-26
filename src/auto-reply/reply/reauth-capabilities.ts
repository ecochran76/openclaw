import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import {
  normalizeRequestedProfileId,
  resolveAuthProfileProviderId,
} from "../../agents/auth-profiles/profile-id.js";
import type { PendingOAuthReauth } from "../../config/sessions/types.js";
import {
  completeOpenAICodexManualAuthorization,
  createOpenAICodexManualAuthorization,
  looksLikeOpenAICodexCallbackInput,
} from "../../plugins/provider-openai-chatgpt-oauth.js";

const DEFAULT_CHAT_REAUTH_PROVIDER = "openai";

export type ChatReauthCapability = {
  provider: string;
  looksLikeCallbackInput: (input: string) => boolean;
  createPendingAuthorization: (params?: {
    originator?: string;
  }) => Omit<PendingOAuthReauth, "kind" | "provider" | "profileId">;
  completePendingAuthorization: (params: {
    input: string;
    pending: Pick<PendingOAuthReauth, "state" | "verifier" | "redirectUri">;
  }) => Promise<OAuthCredentials>;
};

export function getDefaultChatReauthProvider(): string | undefined {
  return DEFAULT_CHAT_REAUTH_PROVIDER;
}

export function resolveRequestedChatReauthProfileId(params: {
  requestedProfileId?: string;
  sessionAuthProfileOverride?: string;
}): string | undefined {
  const requested = params.requestedProfileId?.trim();
  if (!requested) {
    return params.sessionAuthProfileOverride?.trim() || undefined;
  }
  if (requested.includes(":")) {
    return requested;
  }
  const defaultProvider =
    resolveAuthProfileProviderId(params.sessionAuthProfileOverride) ||
    getDefaultChatReauthProvider();
  return defaultProvider ? normalizeRequestedProfileId(defaultProvider, requested) : undefined;
}

export function resolveChatReauthProvider(params: {
  profileId?: string;
  storedProvider?: string;
  sessionAuthProfileOverride?: string;
}): string | undefined {
  return (
    resolveAuthProfileProviderId(params.profileId) ||
    params.storedProvider?.trim() ||
    resolveAuthProfileProviderId(params.sessionAuthProfileOverride) ||
    getDefaultChatReauthProvider()
  );
}

export function getChatReauthCapability(provider: string): ChatReauthCapability | null {
  switch (provider) {
    case "openai":
    case "openai-codex":
      return {
        provider: "openai",
        looksLikeCallbackInput: looksLikeOpenAICodexCallbackInput,
        createPendingAuthorization: (params) =>
          createOpenAICodexManualAuthorization({ originator: params?.originator }),
        completePendingAuthorization: async ({ input, pending }) =>
          await completeOpenAICodexManualAuthorization({
            input,
            state: pending.state,
            verifier: pending.verifier,
            redirectUri: pending.redirectUri,
          }),
      };
    default:
      return null;
  }
}
