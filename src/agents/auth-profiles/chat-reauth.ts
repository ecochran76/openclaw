const DEFAULT_CHAT_REAUTH_PROVIDER = "openai";

export function getDefaultChatReauthProvider(): string | undefined {
  return DEFAULT_CHAT_REAUTH_PROVIDER;
}

export function supportsChatReauthProvider(provider?: string): boolean {
  const normalized = provider?.trim();
  return normalized === DEFAULT_CHAT_REAUTH_PROVIDER || normalized === "openai-codex";
}
