import { describe, expect, it } from "vitest";
import {
  buildOpenAICodexExternalCliSyncProvider,
  CODEX_CLI_PROFILE_ID,
  isDeprecatedOpenAICodexCliProfileId,
  OPENAI_CODEX_DEFAULT_PROFILE_ID,
} from "./provider-openai-codex-cli-profile.js";

describe("provider-openai-codex-cli-profile", () => {
  it("exposes the canonical Codex CLI profile ids", () => {
    expect(CODEX_CLI_PROFILE_ID).toBe("openai:codex-cli");
    expect(OPENAI_CODEX_DEFAULT_PROFILE_ID).toBe("openai:default");
  });

  it("detects the deprecated Codex CLI profile id", () => {
    expect(isDeprecatedOpenAICodexCliProfileId("openai:codex-cli")).toBe(true);
    expect(isDeprecatedOpenAICodexCliProfileId("openai-codex:codex-cli")).toBe(false);
    expect(isDeprecatedOpenAICodexCliProfileId("openai:default")).toBe(false);
  });

  it("builds the external CLI sync descriptor", () => {
    const descriptor = buildOpenAICodexExternalCliSyncProvider(123);
    expect(descriptor.profileId).toBe("openai:default");
    expect(descriptor.profileAliases).toContain("openai-codex:default");
    expect(descriptor.provider).toBe("openai");
    expect(descriptor.aliases).toContain("openai-codex");
    expect(descriptor.readCredentials).toBeTypeOf("function");
  });
});
