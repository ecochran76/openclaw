import { describe, expect, it } from "vitest";
import { getDefaultChatReauthProvider, supportsChatReauthProvider } from "./chat-reauth.js";

describe("chat reauth provider registry", () => {
  it("reports the default chat reauth provider", () => {
    expect(getDefaultChatReauthProvider()).toBe("openai");
  });

  it("recognizes providers with thread reauth support", () => {
    expect(supportsChatReauthProvider("openai")).toBe(true);
    expect(supportsChatReauthProvider("openai-codex")).toBe(true);
    expect(supportsChatReauthProvider("anthropic")).toBe(false);
    expect(supportsChatReauthProvider(undefined)).toBe(false);
  });
});
