const CHAT_REAUTH_PROVIDERS = ["openai"] as const;

function normalizeChatReauthProvider(provider: string): string {
  const trimmed = provider.trim();
  return trimmed === "openai-codex" ? "openai" : trimmed;
}

export function listChatReauthProviders(): string[] {
  return [...CHAT_REAUTH_PROVIDERS];
}

export function getDefaultChatReauthProvider(
  providerIds: readonly string[] = CHAT_REAUTH_PROVIDERS,
): string | undefined {
  const normalized = Array.from(
    new Set(
      providerIds
        .map((id) => normalizeChatReauthProvider(id))
        .filter((id) => id.length > 0),
    ),
  );
  return normalized.length === 1 ? normalized[0] : undefined;
}

export function supportsChatReauthProvider(provider?: string): boolean {
  const normalized = provider ? normalizeChatReauthProvider(provider) : undefined;
  return Boolean(normalized) && listChatReauthProviders().includes(normalized);
}
