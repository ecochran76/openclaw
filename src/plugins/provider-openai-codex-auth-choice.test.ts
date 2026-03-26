import { describe, expect, it } from "vitest";
import {
  isDeprecatedOpenAICodexAuthChoice,
  normalizeOpenAICodexAuthChoice,
  OPENAI_CODEX_AUTH_CHOICE,
  OPENAI_CODEX_LEGACY_AUTH_CHOICE,
  resolveOpenAICodexPreferredProviderForAuthChoice,
} from "./provider-openai-codex-auth-choice.js";

describe("provider-openai-codex-auth-choice", () => {
  it("detects the deprecated codex-cli auth choice", () => {
    expect(isDeprecatedOpenAICodexAuthChoice(OPENAI_CODEX_LEGACY_AUTH_CHOICE)).toBe(true);
    expect(isDeprecatedOpenAICodexAuthChoice(OPENAI_CODEX_AUTH_CHOICE)).toBe(false);
  });

  it("normalizes the legacy auth choice to the provider-owned choice", () => {
    expect(normalizeOpenAICodexAuthChoice(OPENAI_CODEX_LEGACY_AUTH_CHOICE)).toBe(
      OPENAI_CODEX_AUTH_CHOICE,
    );
    expect(normalizeOpenAICodexAuthChoice(OPENAI_CODEX_AUTH_CHOICE)).toBe(
      OPENAI_CODEX_AUTH_CHOICE,
    );
    expect(normalizeOpenAICodexAuthChoice("openai-api-key")).toBe("openai-api-key");
  });

  it("resolves the preferred provider for both legacy and normalized choices", () => {
    expect(resolveOpenAICodexPreferredProviderForAuthChoice(OPENAI_CODEX_LEGACY_AUTH_CHOICE)).toBe(
      OPENAI_CODEX_AUTH_CHOICE,
    );
    expect(resolveOpenAICodexPreferredProviderForAuthChoice(OPENAI_CODEX_AUTH_CHOICE)).toBe(
      OPENAI_CODEX_AUTH_CHOICE,
    );
    expect(resolveOpenAICodexPreferredProviderForAuthChoice("anthropic")).toBeUndefined();
  });
});
