// Legacy auth-choice tests cover deprecated choice detection and replacement messages.
import { describe, expect, it, vi } from "vitest";

const manifestAuthChoices = vi.hoisted(() => [
  {
    pluginId: "anthropic",
    providerId: "anthropic",
    methodId: "cli",
    choiceId: "anthropic-cli",
    choiceLabel: "Anthropic Claude CLI",
    deprecatedChoiceIds: ["claude-cli"],
  },
  {
    pluginId: "openai",
    providerId: "openai",
    methodId: "oauth",
    choiceId: "openai",
    choiceLabel: "ChatGPT Login",
  },
]);

vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoices: () => manifestAuthChoices,
  resolveManifestDeprecatedProviderAuthChoice: (choiceId: string) =>
    manifestAuthChoices.find((choice) => choice.deprecatedChoiceIds?.includes(choiceId) === true),
}));

import {
  resolveLegacyAuthChoiceAliasesForCli,
  formatDeprecatedAuthChoiceMigrationLog,
  formatDeprecatedNonInteractiveAuthChoiceError,
  formatDeprecatedNonInteractiveAuthChoiceHint,
  normalizeLegacyOnboardAuthChoice,
  resolveDeprecatedAuthChoiceReplacement,
} from "./auth-choice-legacy.js";

function authChoiceManifestEnv(): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: "extensions",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
    OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY: "1",
    VITEST: "1",
  } as NodeJS.ProcessEnv;
}

describe("auth choice legacy aliases", () => {
  it("normalizes deprecated choices to their current replacements", () => {
    const env = authChoiceManifestEnv();
    expect(normalizeLegacyOnboardAuthChoice("oauth", { env })).toBe("setup-token");
    expect(normalizeLegacyOnboardAuthChoice("claude-cli", { env })).toBe("anthropic-cli");
    expect(normalizeLegacyOnboardAuthChoice("codex-cli", { env })).toBe("openai");
  });

  it("maps claude-cli to the manifest-provided anthropic cli choice", () => {
    const env = authChoiceManifestEnv();
    expect(resolveDeprecatedAuthChoiceReplacement("claude-cli", { env })).toEqual({
      normalized: "anthropic-cli",
      message: 'Auth choice "claude-cli" is deprecated; using Anthropic Claude CLI setup instead.',
    });
    expect(formatDeprecatedNonInteractiveAuthChoiceError("claude-cli", { env })).toBe(
      'Auth choice "claude-cli" is deprecated.\nUse "--auth-choice anthropic-cli".',
    );
  });

  it("formats provider-aware migration logs", () => {
    const env = authChoiceManifestEnv();
    expect(formatDeprecatedAuthChoiceMigrationLog("claude-cli", { env })).toContain(
      "Anthropic Claude CLI setup",
    );
    expect(formatDeprecatedAuthChoiceMigrationLog("codex-cli", { env })).toContain(
      "OpenAI Codex OAuth",
    );
  });

  it("formats provider-aware non-interactive hints", () => {
    const env = authChoiceManifestEnv();
    expect(formatDeprecatedNonInteractiveAuthChoiceHint("claude-cli", { env })).toContain(
      "--auth-choice anthropic-cli",
    );
    expect(formatDeprecatedNonInteractiveAuthChoiceHint("codex-cli", { env })).toContain(
      "--auth-choice openai",
    );
  });

  it("sources deprecated cli aliases from built-ins and plugin manifests", () => {
    expect(resolveLegacyAuthChoiceAliasesForCli()).toEqual([
      "setup-token",
      "oauth",
      "claude-cli",
      "codex-cli",
    ]);
  });

  it("maps deprecated Codex setup choices to OpenAI OAuth", () => {
    expect(normalizeLegacyOnboardAuthChoice("codex-cli", { env: authChoiceManifestEnv() })).toBe(
      "openai",
    );
    expect(
      resolveDeprecatedAuthChoiceReplacement("codex-cli", { env: authChoiceManifestEnv() }),
    ).toMatchObject({
      normalized: "openai",
      message: 'Auth choice "codex-cli" is deprecated; using OpenAI Codex OAuth instead.',
    });
  });
});
