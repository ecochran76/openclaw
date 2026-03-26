import { describe, expect, it } from "vitest";
import { formatAuthRecoveryHint } from "./reauth-guidance.js";

describe("formatAuthRecoveryHint", () => {
  it("prefers thread reauth for openai profiles", () => {
    expect(
      formatAuthRecoveryHint({
        provider: "openai",
        authProfileId: "openai:dillan",
        allowChatReauth: true,
      }),
    ).toBe("Reply /reauth openai:dillan in this thread to refresh it here.");
  });

  it("can include a CLI fallback for openai thread reauth", () => {
    expect(
      formatAuthRecoveryHint({
        provider: "openai",
        authProfileId: "openai:dillan",
        allowChatReauth: true,
        includeCliAlternative: true,
      }),
    ).toContain("Reply /reauth openai:dillan in this thread to refresh it here, or run");
  });

  it("guides chat reauth when the openai profile is unknown", () => {
    expect(
      formatAuthRecoveryHint({
        provider: "openai",
        allowChatReauth: true,
      }),
    ).toBe(
      "Reply /reauth <profile-id> in this thread to refresh an OpenAI ChatGPT/Codex profile here.",
    );
  });

  it("keeps legacy openai-codex guidance on canonical openai login", () => {
    expect(
      formatAuthRecoveryHint({
        provider: "openai-codex",
        authProfileId: "openai-codex:dillan",
        allowChatReauth: true,
        includeCliAlternative: true,
      }),
    ).toContain("openclaw models auth login --provider openai --profile-id openai-codex:dillan");
  });

  it("uses CLI reauth for non-codex provider profiles", () => {
    expect(
      formatAuthRecoveryHint({
        provider: "anthropic",
        authProfileId: "anthropic:work",
      }),
    ).toContain("openclaw models auth login --provider anthropic --profile-id anthropic:work");
  });

  it("falls back to a generic provider CLI login when only provider is known", () => {
    expect(
      formatAuthRecoveryHint({
        provider: "anthropic",
      }),
    ).toContain("openclaw models auth login --provider anthropic");
  });
});
