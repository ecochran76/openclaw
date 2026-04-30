import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeOpenAICodexManualAuthorization,
  createOpenAICodexManualAuthorization,
  looksLikeOpenAICodexCallbackInput,
  openAICodexChatReauthCapability,
} from "./provider-openai-chatgpt-oauth.js";

describe("provider-openai-chatgpt chat reauth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects callback-like input", () => {
    expect(looksLikeOpenAICodexCallbackInput("")).toBe(false);
    expect(
      looksLikeOpenAICodexCallbackInput(
        "http://localhost:1455/auth/callback?code=test&state=state-1",
      ),
    ).toBe(true);
    expect(looksLikeOpenAICodexCallbackInput("?code=test&state=state-1")).toBe(true);
  });

  it("creates a manual authorization URL with the expected redirect target", () => {
    const auth = createOpenAICodexManualAuthorization({
      originator: "pi",
      now: 100,
      ttlMs: 1_000,
    });

    expect(auth.redirectUri).toBe("http://localhost:1455/auth/callback");
    expect(auth.createdAt).toBe(100);
    expect(auth.expiresAt).toBe(1_100);
    expect(auth.authorizationUrl).toContain(
      "redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
    );
    expect(auth.authorizationUrl).toContain("originator=pi");
  });

  it("exposes the provider-owned chat reauth capability", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          device_auth_id: "device-1",
          user_code: "CODE-123",
          interval: 5,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const auth = await openAICodexChatReauthCapability.createPendingAuthorization();

    expect(openAICodexChatReauthCapability.provider).toBe("openai");
    expect(openAICodexChatReauthCapability.looksLikeCallbackInput("?code=test&state=state-1")).toBe(
      true,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(auth.flow).toBe("device_code");
    expect(auth.verificationUrl).toBe("https://auth.openai.com/codex/device");
    expect(auth.userCode).toBe("CODE-123");
  });

  it("falls back to manual OAuth when device code sign-in is unavailable", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "device_code_disabled",
          error_description: "Device code sign-in is disabled for this account.",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const auth = await openAICodexChatReauthCapability.createPendingAuthorization({
      originator: "pi",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(auth.flow).toBe("callback");
    expect(auth.redirectUri).toBe("http://localhost:1455/auth/callback");
    expect(auth.authorizationUrl).toContain(
      "redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
    );
    expect(auth.authorizationUrl).toContain("originator=pi");
  });

  it("can force manual OAuth without requesting a device code", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("unexpected", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const auth = await openAICodexChatReauthCapability.createPendingAuthorization({
      originator: "pi",
      preferredFlow: "callback",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(auth.flow).toBe("callback");
    expect(auth.redirectUri).toBe("http://localhost:1455/auth/callback");
    expect(auth.authorizationUrl).toContain(
      "redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
    );
    expect(auth.authorizationUrl).toContain("originator=pi");
  });

  it("exchanges a callback URL for OAuth credentials", async () => {
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct_123",
        },
      }),
    ).toString("base64url");
    const accessToken = `header.${payload}.signature`;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: accessToken,
          refresh_token: "refresh-token",
          expires_in: 60,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await completeOpenAICodexManualAuthorization({
      input: "http://localhost:1455/auth/callback?code=test-code&state=state-1",
      state: "state-1",
      verifier: "verifier-1",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      access: accessToken,
      refresh: "refresh-token",
      accountId: "acct_123",
    });
  });

  it("exchanges a Slack-wrapped callback URL for OAuth credentials", async () => {
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct_123",
        },
      }),
    ).toString("base64url");
    const accessToken = `header.${payload}.signature`;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: accessToken,
          refresh_token: "refresh-token",
          expires_in: 60,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await completeOpenAICodexManualAuthorization({
      input:
        "<http://localhost:1455/auth/callback?code=test-code&state=state-1|http://localhost:1455/auth/callback?code=test-code&state=state-1>",
      state: "state-1",
      verifier: "verifier-1",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      access: accessToken,
      refresh: "refresh-token",
      accountId: "acct_123",
    });
  });
});
