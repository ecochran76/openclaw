import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const hoisted = vi.hoisted(() => {
  const ensureAuthProfileStoreMock = vi.fn();
  const writeOAuthCredentialsMock = vi.fn();
  const updateConfigMock = vi.fn();
  const getChatReauthCapabilityMock = vi.fn();
  return {
    ensureAuthProfileStoreMock,
    writeOAuthCredentialsMock,
    updateConfigMock,
    getChatReauthCapabilityMock,
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

vi.mock("./reauth-capabilities.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reauth-capabilities.js")>();
  return {
    ...actual,
    getChatReauthCapability: hoisted.getChatReauthCapabilityMock,
  };
});

const { buildCommandTestParams } = await import("./commands.test-harness.js");
const { handlePendingReauthInput, handleReauthCommand } = await import("./commands-reauth.js");

const cfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

describe("/reauth commands", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    hoisted.ensureAuthProfileStoreMock.mockReset();
    hoisted.writeOAuthCredentialsMock.mockReset();
    hoisted.updateConfigMock.mockReset();
    hoisted.getChatReauthCapabilityMock.mockReset();
  });

  it("starts a pending OpenAI Codex reauth flow", async () => {
    const createPendingAuthorization = vi.fn(() => ({
      flow: "device_code",
      deviceAuthId: "device-1",
      userCode: "CODE-123",
      verificationUrl: "https://auth.example.test/device",
      intervalMs: 5_000,
      createdAt: 1,
      expiresAt: 2,
    }));
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "openai:dillan": { provider: "openai", type: "oauth", access: "a" },
      },
    });
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai",
      looksLikeCallbackInput: vi.fn(() => false),
      createPendingAuthorization,
      completePendingAuthorization: vi.fn(),
      pollPendingAuthorization: vi.fn(),
    });

    const params = buildCommandTestParams("/reauth dillan", cfg);
    params.agentDir = "/tmp/agent";
    params.sessionEntry = { sessionId: "s1", updatedAt: 1 };
    params.sessionStore = {};

    const result = await handleReauthCommand(params, true);

    expect(result?.reply?.text).toContain("Re-auth pending for openai:dillan");
    expect(result?.reply?.text).toContain("https://auth.example.test/device");
    expect(result?.reply?.text).toContain("Code: CODE-123");
    expect(createPendingAuthorization).toHaveBeenCalledWith({
      originator: "pi",
      preferredFlow: undefined,
    });
    expect(params.sessionEntry.pendingOAuthReauth?.profileId).toBe("openai:dillan");
    expect(params.sessionEntry.pendingOAuthReauth?.flow).toBe("device_code");
  });

  it("can force an OAuth callback reauth flow", async () => {
    const createPendingAuthorization = vi.fn(() => ({
      flow: "callback",
      state: "state-1",
      verifier: "verifier-1",
      authorizationUrl: "https://auth.example.test/oauth",
      redirectUri: "http://localhost:1455/auth/callback",
      createdAt: 1,
      expiresAt: 2,
    }));
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "openai:work": { provider: "openai", type: "oauth", access: "a" },
      },
    });
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai",
      looksLikeCallbackInput: vi.fn(() => false),
      createPendingAuthorization,
      completePendingAuthorization: vi.fn(),
      pollPendingAuthorization: vi.fn(),
    });

    const params = buildCommandTestParams("/reauth --oauth openai:work", cfg);
    params.agentDir = "/tmp/agent";
    params.sessionEntry = { sessionId: "s1", updatedAt: 1 };
    params.sessionStore = {};

    const result = await handleReauthCommand(params, true);

    expect(createPendingAuthorization).toHaveBeenCalledWith({
      originator: "pi",
      preferredFlow: "callback",
    });
    expect(result?.reply?.text).toContain("Re-auth pending for openai:work");
    expect(result?.reply?.text).toContain("Open this OAuth URL");
    expect(result?.reply?.text).toContain("https://auth.example.test/oauth");
    expect(params.sessionEntry.pendingOAuthReauth?.profileId).toBe("openai:work");
    expect(params.sessionEntry.pendingOAuthReauth?.flow).toBe("callback");
  });

  it("watches a pending device-code flow and confirms completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T12:00:00Z"));
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "openai:dillan": { provider: "openai", type: "oauth", access: "a" },
      },
    });
    const pollPendingAuthorization = vi.fn(async () => ({
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
      accountId: "acct_123",
    }));
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai",
      looksLikeCallbackInput: vi.fn(() => false),
      createPendingAuthorization: vi.fn(() => ({
        flow: "device_code",
        deviceAuthId: "device-1",
        userCode: "CODE-123",
        verificationUrl: "https://auth.example.test/device",
        intervalMs: 5_000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 15 * 60_000,
      })),
      completePendingAuthorization: vi.fn(),
      pollPendingAuthorization,
    });
    hoisted.writeOAuthCredentialsMock.mockResolvedValue("openai:dillan");
    hoisted.updateConfigMock.mockResolvedValue(cfg);
    const onBlockReply = vi.fn(async () => undefined);

    const params = buildCommandTestParams("/reauth dillan", cfg);
    params.agentDir = "/tmp/agent";
    params.sessionEntry = { sessionId: "s1", updatedAt: 1 };
    params.sessionStore = {};
    params.opts = { onBlockReply };

    const result = await handleReauthCommand(params, true);

    expect(result?.reply?.text).toContain("I will watch for completion for up to 10 minutes");
    expect(onBlockReply).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(pollPendingAuthorization).toHaveBeenCalledOnce();
    expect(onBlockReply).toHaveBeenCalledWith({
      text: "🔐 Re-auth complete for openai:dillan.",
    });
    expect(params.sessionEntry.pendingOAuthReauth).toBeUndefined();
  });

  it("finishes a pending device-code flow on status after user approval", async () => {
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai",
      looksLikeCallbackInput: vi.fn(() => false),
      createPendingAuthorization: vi.fn(),
      completePendingAuthorization: vi.fn(),
      pollPendingAuthorization: vi.fn(async () => ({
        access: "access-token",
        refresh: "refresh-token",
        expires: 123,
        accountId: "acct_123",
      })),
    });
    hoisted.writeOAuthCredentialsMock.mockResolvedValue("openai:dillan");
    hoisted.updateConfigMock.mockResolvedValue(cfg);

    const params = buildCommandTestParams("/reauth status", cfg);
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      pendingOAuthReauth: {
        kind: "oauth",
        provider: "openai",
        profileId: "openai:dillan",
        flow: "device_code",
        deviceAuthId: "device-1",
        userCode: "CODE-123",
        verificationUrl: "https://auth.example.test/device",
        intervalMs: 5_000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    };
    params.sessionStore = {};

    const result = await handleReauthCommand(params, true);

    expect(result?.reply?.text).toBe("🔐 Re-auth complete for openai:dillan.");
    expect(hoisted.writeOAuthCredentialsMock).toHaveBeenCalledWith(
      "openai",
      expect.objectContaining({ access: "access-token" }),
      "/tmp/agent",
      expect.objectContaining({ profileId: "openai:dillan", syncSiblingAgents: true }),
    );
    expect(params.sessionEntry.pendingOAuthReauth).toBeUndefined();
  });

  it("completes a pasted callback flow", async () => {
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai",
      looksLikeCallbackInput: vi.fn(() => true),
      createPendingAuthorization: vi.fn(),
      completePendingAuthorization: vi.fn(async () => ({
        access: "access-token",
        refresh: "refresh-token",
        expires: 123,
        accountId: "acct_123",
      })),
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
        kind: "oauth",
        provider: "openai",
        profileId: "openai:dillan",
        flow: "callback",
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

  it("falls back to CLI guidance for providers without chat reauth support", async () => {
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "anthropic:work": { provider: "anthropic", type: "oauth", access: "a" },
      },
    });
    hoisted.getChatReauthCapabilityMock.mockReturnValue(null);

    const params = buildCommandTestParams("/reauth anthropic:work", cfg);
    params.agentDir = "/tmp/agent";
    params.sessionEntry = { sessionId: "s1", updatedAt: 1 };
    params.sessionStore = {};

    const result = await handleReauthCommand(params, true);

    expect(result?.reply?.text).toContain("Thread re-auth is not available for anthropic:work");
    expect(result?.reply?.text).toContain(
      "openclaw models auth login --provider anthropic --profile-id anthropic:work",
    );
  });

  it("uses the auth-profile override provider for bare reauth labels", async () => {
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "anthropic:work": { provider: "anthropic", type: "oauth", access: "a" },
      },
    });
    hoisted.getChatReauthCapabilityMock.mockReturnValue(null);

    const params = buildCommandTestParams("/reauth work", cfg);
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      authProfileOverride: "anthropic:personal",
    };
    params.sessionStore = {};

    const result = await handleReauthCommand(params, true);

    expect(result?.reply?.text).toContain("Thread re-auth is not available for anthropic:work");
    expect(result?.reply?.text).toContain(
      "openclaw models auth login --provider anthropic --profile-id anthropic:work",
    );
  });
});
