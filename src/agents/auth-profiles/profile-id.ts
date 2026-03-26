export function normalizeRequestedProfileId(provider: string, raw?: string): string | undefined {
  const requested = raw?.trim();
  if (!requested) {
    return undefined;
  }
  if (requested.includes(":")) {
    return requested;
  }
  return `${provider}:${requested}`;
}

export function resolveAuthProfileProviderId(profileId?: string): string | undefined {
  const trimmed = profileId?.trim();
  if (!trimmed) {
    return undefined;
  }
  const colon = trimmed.indexOf(":");
  if (colon <= 0) {
    return undefined;
  }
  return trimmed.slice(0, colon).trim() || undefined;
}
