import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  looksLikeCallbackInputMock: vi.fn(),
  createManualAuthorizationMock: vi.fn(),
  completeManualAuthorizationMock: vi.fn(),
}));

vi.mock("../../plugins/provider-openai-chatgpt-oauth.js", () => ({
  openAICodexChatReauthCapability: {
    provider: "openai",
    looksLikeCallbackInput: hoisted.looksLikeCallbackInputMock,
    createPendingAuthorization: hoisted.createManualAuthorizationMock,
    completePendingAuthorization: hoisted.completeManualAuthorizationMock,
  },
}));

const {
  getChatReauthCapability,
  getDefaultChatReauthProvider,
  resolveChatReauthProvider,
  resolveRequestedChatReauthProfileId,
} = await import("./reauth-capabilities.js");

describe("getChatReauthCapability", () => {
  it("returns null for unsupported providers", () => {
    expect(getChatReauthCapability("anthropic")).toBeNull();
  });

  it("adapts the openai chat reauth flow", async () => {
    hoisted.looksLikeCallbackInputMock.mockReturnValue(true);
    hoisted.createManualAuthorizationMock.mockReturnValue({
      state: "state-1",
      verifier: "verifier-1",
      authorizationUrl: "https://auth.example.test/start",
      redirectUri: "http://localhost:1455/auth/callback",
      createdAt: 1,
      expiresAt: 2,
    });
    hoisted.completeManualAuthorizationMock.mockResolvedValue({
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
      accountId: "acct_123",
    });

    const capability = getChatReauthCapability("openai");
    expect(capability).not.toBeNull();
    expect(capability?.looksLikeCallbackInput("http://localhost:1455/auth/callback?code=x")).toBe(
      true,
    );
    expect(await capability?.createPendingAuthorization({ originator: "pi" })).toMatchObject({
      state: "state-1",
      verifier: "verifier-1",
    });
    await expect(
      capability?.completePendingAuthorization({
        input: "http://localhost:1455/auth/callback?code=test&state=state-1",
        pending: {
          state: "state-1",
          verifier: "verifier-1",
          redirectUri: "http://localhost:1455/auth/callback",
        },
      }),
    ).resolves.toMatchObject({ access: "access-token" });
  });

  it("uses openai as the canonical chat reauth provider", () => {
    expect(getChatReauthCapability("openai")?.provider).toBe("openai");
    expect(getChatReauthCapability("openai-codex")?.provider).toBe("openai");
  });
});

describe("chat reauth provider resolution", () => {
  it("reports the default chat reauth provider", () => {
    expect(getDefaultChatReauthProvider()).toBe("openai");
  });

  it("prefixes bare profile labels with the auth-profile override provider", () => {
    expect(
      resolveRequestedChatReauthProfileId({
        requestedProfileId: "work",
        sessionAuthProfileOverride: "anthropic:personal",
      }),
    ).toBe("anthropic:work");
  });

  it("falls back to the default chat reauth provider for bare labels", () => {
    expect(
      resolveRequestedChatReauthProfileId({
        requestedProfileId: "dillan",
      }),
    ).toBe("openai:dillan");
  });

  it("derives the provider from the normalized profile id first", () => {
    expect(
      resolveChatReauthProvider({
        profileId: "anthropic:work",
        storedProvider: "openai",
      }),
    ).toBe("anthropic");
  });

  it("accepts legacy openai-codex providers as chat reauth aliases", () => {
    expect(getChatReauthCapability("openai-codex")?.provider).toBe("openai");
  });
});
