import { describe, expect, it } from "vitest";
import { formatAuthRecoveryHint } from "./reauth-guidance.js";

describe("formatAuthRecoveryHint", () => {
  it("routes legacy openai-codex profiles through the canonical openai login", () => {
    expect(
      formatAuthRecoveryHint({
        provider: "openai-codex",
        authProfileId: "openai-codex:dillan",
      }),
    ).toContain("openclaw models auth login --provider openai --profile-id openai-codex:dillan");
  });

  it("uses provider CLI reauth when a profile is known", () => {
    expect(
      formatAuthRecoveryHint({
        provider: "anthropic",
        authProfileId: "anthropic:work",
      }),
    ).toContain("openclaw models auth login --provider anthropic --profile-id anthropic:work");
  });

  it("uses provider CLI reauth when only the provider is known", () => {
    expect(formatAuthRecoveryHint({ provider: "anthropic" })).toContain(
      "openclaw models auth login --provider anthropic",
    );
  });

  it("falls back to generic guidance without a provider", () => {
    expect(formatAuthRecoveryHint({})).toBe("Re-authenticate and try again.");
  });
});
