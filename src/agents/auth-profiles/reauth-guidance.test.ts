import { describe, expect, it } from "vitest";
import { formatAuthRecoveryHint } from "./reauth-guidance.js";

describe("formatAuthRecoveryHint", () => {
  it("prefers thread reauth for openai-codex profiles", () => {
    expect(
      formatAuthRecoveryHint({
        provider: "openai-codex",
        authProfileId: "openai-codex:dillan",
        allowChatReauth: true,
      }),
    ).toBe(
      "Reply /reauth --device-code openai-codex:dillan in this thread to refresh it here; supported providers will post a device code or chat-safe auth flow.",
    );
  });

  it("can include a CLI fallback for openai-codex thread reauth", () => {
    expect(
      formatAuthRecoveryHint({
        provider: "openai-codex",
        authProfileId: "openai-codex:dillan",
        allowChatReauth: true,
        includeCliAlternative: true,
      }),
    ).toContain(
      "Reply /reauth --device-code openai-codex:dillan in this thread to refresh it here; supported providers will post a device code or chat-safe auth flow, or run",
    );
  });

  it("guides chat reauth when the openai-codex profile is unknown", () => {
    expect(
      formatAuthRecoveryHint({
        provider: "openai-codex",
        allowChatReauth: true,
      }),
    ).toBe(
      "Reply /reauth <profile-id> in this thread to refresh an OpenAI ChatGPT/Codex profile here.",
    );
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
