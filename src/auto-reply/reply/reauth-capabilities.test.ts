import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  looksLikeCallbackInputMock: vi.fn(),
  createManualAuthorizationMock: vi.fn(),
  completeManualAuthorizationMock: vi.fn(),
}));

vi.mock("../../plugins/provider-openai-chatgpt-oauth.js", () => ({
  looksLikeOpenAICodexCallbackInput: hoisted.looksLikeCallbackInputMock,
  createOpenAICodexManualAuthorization: hoisted.createManualAuthorizationMock,
  completeOpenAICodexManualAuthorization: hoisted.completeManualAuthorizationMock,
}));

const { getChatReauthCapability } = await import("./reauth-capabilities.js");

describe("getChatReauthCapability", () => {
  it("returns null for unsupported providers", () => {
    expect(getChatReauthCapability("anthropic")).toBeNull();
  });

  it("adapts the openai-codex chat reauth flow", async () => {
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

    const capability = getChatReauthCapability("openai-codex");
    expect(capability).not.toBeNull();
    expect(capability?.looksLikeCallbackInput("http://localhost:1455/auth/callback?code=x")).toBe(
      true,
    );
    expect(capability?.createPendingAuthorization({ originator: "pi" })).toMatchObject({
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
