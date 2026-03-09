import { describe, expect, it } from "vitest";
import {
  buildAuthOrderWithPrimary,
  buildAuthProfileOptions,
  resolveConfiguredCronModelSuggestions,
  resolveEffectiveModelFallbacks,
  resolveModelProvider,
  resolvePrimaryAuthProfileId,
  sortLocaleStrings,
} from "./agents-utils.ts";

describe("resolveEffectiveModelFallbacks", () => {
  it("inherits defaults when no entry fallbacks are configured", () => {
    const entryModel = undefined;
    const defaultModel = {
      primary: "openai/gpt-5-nano",
      fallbacks: ["google/gemini-2.0-flash"],
    };

    expect(resolveEffectiveModelFallbacks(entryModel, defaultModel)).toEqual([
      "google/gemini-2.0-flash",
    ]);
  });

  it("prefers entry fallbacks over defaults", () => {
    const entryModel = {
      primary: "openai/gpt-5-mini",
      fallbacks: ["openai/gpt-5-nano"],
    };
    const defaultModel = {
      primary: "openai/gpt-5",
      fallbacks: ["google/gemini-2.0-flash"],
    };

    expect(resolveEffectiveModelFallbacks(entryModel, defaultModel)).toEqual(["openai/gpt-5-nano"]);
  });

  it("keeps explicit empty entry fallback lists", () => {
    const entryModel = {
      primary: "openai/gpt-5-mini",
      fallbacks: [],
    };
    const defaultModel = {
      primary: "openai/gpt-5",
      fallbacks: ["google/gemini-2.0-flash"],
    };

    expect(resolveEffectiveModelFallbacks(entryModel, defaultModel)).toEqual([]);
  });
});

describe("resolveConfiguredCronModelSuggestions", () => {
  it("collects defaults primary/fallbacks, alias map keys, and per-agent model entries", () => {
    const result = resolveConfiguredCronModelSuggestions({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.2",
            fallbacks: ["google/gemini-2.5-pro", "openai/gpt-5.2-mini"],
          },
          models: {
            "anthropic/claude-sonnet-4-5": { alias: "smart" },
            "openai/gpt-5.2": { alias: "main" },
          },
        },
        list: {
          writer: {
            model: { primary: "xai/grok-4", fallbacks: ["openai/gpt-5.2-mini"] },
          },
          planner: {
            model: "google/gemini-2.5-flash",
          },
        },
      },
    });

    expect(result).toEqual([
      "anthropic/claude-sonnet-4-5",
      "google/gemini-2.5-flash",
      "google/gemini-2.5-pro",
      "openai/gpt-5.2",
      "openai/gpt-5.2-mini",
      "xai/grok-4",
    ]);
  });

  it("returns empty array for invalid or missing config shape", () => {
    expect(resolveConfiguredCronModelSuggestions(null)).toEqual([]);
    expect(resolveConfiguredCronModelSuggestions({})).toEqual([]);
    expect(resolveConfiguredCronModelSuggestions({ agents: { defaults: { model: "" } } })).toEqual(
      [],
    );
  });
});

describe("auth profile helpers", () => {
  const config = {
    auth: {
      profiles: {
        "openai-codex:default": {
          provider: "openai-codex",
          mode: "oauth",
          email: "owner@example.com",
        },
        "openai-codex:work": {
          provider: "openai-codex",
          mode: "oauth",
          email: "work@example.com",
        },
        "anthropic:default": {
          provider: "anthropic",
          mode: "api_key",
        },
      },
      order: {
        "openai-codex": ["openai-codex:default", "openai-codex:work"],
      },
    },
  };

  it("resolves provider from provider/model selections", () => {
    expect(resolveModelProvider("openai-codex/gpt-5.4")).toBe("openai-codex");
    expect(resolveModelProvider("gpt-5.4")).toBeNull();
  });

  it("builds provider-scoped auth profile options", () => {
    expect(buildAuthProfileOptions(config, "openai-codex").map((entry) => entry.id)).toEqual([
      "openai-codex:default",
      "openai-codex:work",
    ]);
    expect(buildAuthProfileOptions(config, "anthropic").map((entry) => entry.id)).toEqual([
      "anthropic:default",
    ]);
  });

  it("reads first configured provider order entry as primary profile", () => {
    expect(resolvePrimaryAuthProfileId(config, "openai-codex")).toBe("openai-codex:default");
  });

  it("moves chosen profile to the front while preserving remaining provider entries", () => {
    expect(
      buildAuthOrderWithPrimary({
        configForm: config,
        provider: "openai-codex",
        primaryProfileId: "openai-codex:work",
      }),
    ).toEqual(["openai-codex:work", "openai-codex:default"]);
  });
});

describe("sortLocaleStrings", () => {
  it("sorts values using localeCompare without relying on Array.prototype.toSorted", () => {
    expect(sortLocaleStrings(["z", "b", "a"])).toEqual(["a", "b", "z"]);
  });

  it("accepts any iterable input, including sets", () => {
    expect(sortLocaleStrings(new Set(["beta", "alpha"]))).toEqual(["alpha", "beta"]);
  });
});
