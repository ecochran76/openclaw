import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const hoisted = vi.hoisted(() => {
  const ensureAuthProfileStoreMock = vi.fn();
  const writeOAuthCredentialsMock = vi.fn();
  const updateConfigMock = vi.fn();
  const createManualAuthorizationMock = vi.fn();
  const completeManualAuthorizationMock = vi.fn();
  const looksLikeCallbackInputMock = vi.fn();
  return {
    ensureAuthProfileStoreMock,
    writeOAuthCredentialsMock,
    updateConfigMock,
    createManualAuthorizationMock,
    completeManualAuthorizationMock,
    looksLikeCallbackInputMock,
  };
});

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: hoisted.ensureAuthProfileStoreMock,
}));

vi.mock("../../plugins/provider-auth-helpers.js", () => ({
  applyAuthProfileConfig: vi.fn((cfg: OpenClawConfig) => cfg),
  writeOAuthCredentials: hoisted.writeOAuthCredentialsMock,
}));

vi.mock("../../commands/models/shared.js", () => ({
  updateConfig: hoisted.updateConfigMock,
}));

vi.mock("../../commands/openai-codex-oauth.js", () => ({
  createOpenAICodexManualAuthorization: hoisted.createManualAuthorizationMock,
  completeOpenAICodexManualAuthorization: hoisted.completeManualAuthorizationMock,
  looksLikeOpenAICodexCallbackInput: hoisted.looksLikeCallbackInputMock,
}));

const { buildCommandTestParams } = await import("./commands.test-harness.js");
const { handlePendingReauthInput, handleReauthCommand } = await import("./commands-reauth.js");

const cfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

describe("/reauth commands", () => {
  it("starts a pending OpenAI Codex reauth flow", async () => {
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "openai:dillan": { provider: "openai", type: "oauth", access: "a" },
      },
    });
    hoisted.createManualAuthorizationMock.mockReturnValue({
      state: "state-1",
      verifier: "verifier-1",
      authorizationUrl: "https://auth.example.test/start",
      redirectUri: "http://localhost:1455/auth/callback",
      createdAt: 1,
      expiresAt: 2,
    });

    const params = buildCommandTestParams("/reauth dillan", cfg);
    params.agentDir = "/tmp/agent";
    params.sessionEntry = { sessionId: "s1", updatedAt: 1 };
    params.sessionStore = {};

    const result = await handleReauthCommand(params, true);

    expect(result?.reply?.text).toContain("Re-auth pending for openai:dillan");
    expect(result?.reply?.text).toContain("https://auth.example.test/start");
    expect(params.sessionEntry.pendingOAuthReauth?.profileId).toBe("openai:dillan");
  });

  it("completes a pasted callback flow", async () => {
    hoisted.looksLikeCallbackInputMock.mockReturnValue(true);
    hoisted.completeManualAuthorizationMock.mockResolvedValue({
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
      accountId: "acct_123",
    });
    hoisted.writeOAuthCredentialsMock.mockResolvedValue("openai:dillan");
    hoisted.updateConfigMock.mockResolvedValue(cfg);

    const params = buildCommandTestParams(
      "http://localhost:1455/auth/callback?code=test&state=state-1",
      cfg,
    );
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      pendingOAuthReauth: {
        kind: "openai",
        provider: "openai",
        profileId: "openai:dillan",
        state: "state-1",
        verifier: "verifier-1",
        authorizationUrl: "https://auth.example.test/start",
        redirectUri: "http://localhost:1455/auth/callback",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    };
    params.sessionStore = {};

    const result = await handlePendingReauthInput(params, true);

    expect(result?.reply?.text).toBe("🔐 Re-auth complete for openai:dillan.");
    expect(hoisted.writeOAuthCredentialsMock).toHaveBeenCalledWith(
      "openai",
      expect.objectContaining({ access: "access-token" }),
      "/tmp/agent",
      expect.objectContaining({ profileId: "openai:dillan", syncSiblingAgents: true }),
    );
    expect(params.sessionEntry.pendingOAuthReauth).toBeUndefined();
  });
});
