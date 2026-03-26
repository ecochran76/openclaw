import { describe, expect, it } from "vitest";
import {
  getDefaultChatReauthProvider,
  listChatReauthProviders,
  supportsChatReauthProvider,
} from "./chat-reauth.js";

describe("chat reauth provider registry", () => {
  it("lists configured chat reauth providers", () => {
    expect(listChatReauthProviders()).toEqual(["openai"]);
  });

  it("reports the default chat reauth provider", () => {
    expect(getDefaultChatReauthProvider()).toBe("openai");
  });

  it("does not report a default when multiple providers are available", () => {
    expect(getDefaultChatReauthProvider(["openai", "anthropic"])).toBeUndefined();
  });

  it("normalizes legacy provider aliases before choosing a default", () => {
    expect(getDefaultChatReauthProvider(["openai-codex"])).toBe("openai");
  });

  it("recognizes providers with thread reauth support", () => {
    expect(supportsChatReauthProvider("openai")).toBe(true);
    expect(supportsChatReauthProvider("openai-codex")).toBe(true);
    expect(supportsChatReauthProvider("anthropic")).toBe(false);
    expect(supportsChatReauthProvider(undefined)).toBe(false);
  });
});
