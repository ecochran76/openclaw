export const OPENAI_CODEX_AUTH_CHOICE = "openai";
export const OPENAI_CODEX_LEGACY_AUTH_CHOICE = "codex-cli";

export function isDeprecatedOpenAICodexAuthChoice(
  authChoice: string | undefined,
): authChoice is "codex-cli" {
  return authChoice === OPENAI_CODEX_LEGACY_AUTH_CHOICE;
}

export function normalizeOpenAICodexAuthChoice(
  authChoice: string | undefined,
): string | undefined {
  if (isDeprecatedOpenAICodexAuthChoice(authChoice)) {
    return OPENAI_CODEX_AUTH_CHOICE;
  }
  return authChoice;
}

export function resolveOpenAICodexPreferredProviderForAuthChoice(
  authChoice: string | undefined,
): string | undefined {
  if (!authChoice) {
    return undefined;
  }
  const normalized = normalizeOpenAICodexAuthChoice(authChoice);
  return normalized === OPENAI_CODEX_AUTH_CHOICE ? OPENAI_CODEX_AUTH_CHOICE : undefined;
}
