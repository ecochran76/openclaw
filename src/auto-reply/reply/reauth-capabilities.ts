import { getDefaultChatReauthProvider as getRegisteredDefaultChatReauthProvider } from "../../agents/auth-profiles/chat-reauth.js";
import {
  normalizeRequestedProfileId,
  resolveAuthProfileProviderId,
} from "../../agents/auth-profiles/profile-id.js";
import type { ChatReauthCapability } from "../../plugins/provider-auth-types.js";
import { openAICodexChatReauthCapability } from "../../plugins/provider-openai-chatgpt-oauth.js";
import { xaiChatReauthCapability } from "../../plugins/provider-xai-oauth.js";

const CHAT_REAUTH_CAPABILITIES: readonly ChatReauthCapability[] = [
  openAICodexChatReauthCapability,
  xaiChatReauthCapability,
];

export function getDefaultChatReauthProvider(): string | undefined {
  return getRegisteredDefaultChatReauthProvider();
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
  const modelRefProvider = resolveProviderFromModelRef(requested);
  if (modelRefProvider) {
    return normalizeRequestedProfileId(modelRefProvider, "default");
  }
  const defaultProvider =
    resolveAuthProfileProviderId(params.sessionAuthProfileOverride) ||
    getDefaultChatReauthProvider();
  return defaultProvider ? normalizeRequestedProfileId(defaultProvider, requested) : undefined;
}

function resolveProviderFromModelRef(value: string): string | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  const provider = value.slice(0, slash).trim();
  const model = value.slice(slash + 1).trim();
  if (!provider || !model) {
    return undefined;
  }
  return provider;
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
  const normalized = provider.trim();
  if (normalized === "openai" || normalized === "openai-codex") {
    return openAICodexChatReauthCapability;
  }
  return CHAT_REAUTH_CAPABILITIES.find((capability) => capability.provider === normalized) ?? null;
}
