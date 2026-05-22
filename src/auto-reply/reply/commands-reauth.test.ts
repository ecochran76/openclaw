import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ReplyPayload } from "../reply-payload.js";

const hoisted = vi.hoisted(() => {
  const ensureAuthProfileStoreMock = vi.fn();
  const clearAuthProfileCooldownMock = vi.fn();
  const promoteAuthProfileInOrderMock = vi.fn();
  const writeOAuthCredentialsMock = vi.fn();
  const updateConfigMock = vi.fn();
  const getChatReauthCapabilityMock = vi.fn();
  const runAuthProbesMock = vi.fn();
  return {
    ensureAuthProfileStoreMock,
    clearAuthProfileCooldownMock,
    promoteAuthProfileInOrderMock,
    writeOAuthCredentialsMock,
    updateConfigMock,
    getChatReauthCapabilityMock,
    runAuthProbesMock,
  };
});

vi.mock("../../agents/auth-profiles.js", () => ({
  clearAuthProfileCooldown: hoisted.clearAuthProfileCooldownMock,
  ensureAuthProfileStore: hoisted.ensureAuthProfileStoreMock,
  promoteAuthProfileInOrder: hoisted.promoteAuthProfileInOrderMock,
}));

vi.mock("../../plugins/provider-auth-helpers.js", () => ({
  applyAuthProfileConfig: vi.fn((cfg: OpenClawConfig) => cfg),
  writeOAuthCredentials: hoisted.writeOAuthCredentialsMock,
}));

vi.mock("../../commands/models/shared.js", () => ({
  updateConfig: hoisted.updateConfigMock,
}));

vi.mock("../../commands/models/list.probe.js", () => ({
  runAuthProbes: hoisted.runAuthProbesMock,
}));

vi.mock("./reauth-capabilities.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reauth-capabilities.js")>();
  return {
    ...actual,
    getChatReauthCapability: hoisted.getChatReauthCapabilityMock,
  };
});

const { buildCommandTestParams } = await import("./commands.test-harness.js");
const { applyPostReauthProviderConfig, handlePendingReauthInput, handleReauthCommand } =
  await import("./commands-reauth.js");

const cfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

describe("/reauth commands", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    hoisted.ensureAuthProfileStoreMock.mockReset();
    hoisted.clearAuthProfileCooldownMock.mockReset();
    hoisted.promoteAuthProfileInOrderMock.mockReset();
    hoisted.writeOAuthCredentialsMock.mockReset();
    hoisted.updateConfigMock.mockReset();
    hoisted.getChatReauthCapabilityMock.mockReset();
    hoisted.runAuthProbesMock.mockReset();
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
        "openai-codex:dillan": { provider: "openai-codex", type: "oauth", access: "a" },
      },
    });
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai-codex",
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

    expect(result?.reply?.text).toContain("Re-auth pending for openai-codex:dillan");
    expect(result?.reply?.text).toContain("https://auth.example.test/device");
    expect(result?.reply?.text).toContain("Code: CODE-123");
    expect(createPendingAuthorization).toHaveBeenCalledWith({
      originator: "pi",
      preferredFlow: undefined,
    });
    expect(params.sessionEntry.pendingOAuthReauth?.profileId).toBe("openai-codex:dillan");
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
        "openai-codex:work": { provider: "openai-codex", type: "oauth", access: "a" },
      },
    });
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai-codex",
      looksLikeCallbackInput: vi.fn(() => false),
      createPendingAuthorization,
      completePendingAuthorization: vi.fn(),
      pollPendingAuthorization: vi.fn(),
    });

    const params = buildCommandTestParams("/reauth --oauth openai-codex:work", cfg);
    params.agentDir = "/tmp/agent";
    params.sessionEntry = { sessionId: "s1", updatedAt: 1 };
    params.sessionStore = {};

    const result = await handleReauthCommand(params, true);

    expect(createPendingAuthorization).toHaveBeenCalledWith({
      originator: "pi",
      preferredFlow: "callback",
    });
    expect(result?.reply?.text).toContain("Re-auth pending for openai-codex:work");
    expect(result?.reply?.text).toContain("Open this OAuth URL");
    expect(result?.reply?.text).toContain("/reauth callback");
    expect(result?.reply?.text).toContain("https://auth.example.test/oauth");
    expect(params.sessionEntry.pendingOAuthReauth?.profileId).toBe("openai-codex:work");
    expect(params.sessionEntry.pendingOAuthReauth?.flow).toBe("callback");
  });

  it("watches a pending device-code flow and confirms completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T12:00:00Z"));
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "openai-codex:dillan": { provider: "openai-codex", type: "oauth", access: "a" },
      },
    });
    const pollPendingAuthorization = vi.fn(async () => ({
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
      accountId: "acct_123",
    }));
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai-codex",
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
    hoisted.writeOAuthCredentialsMock.mockResolvedValue("openai-codex:dillan");
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
      text: "🔐 Re-auth credentials updated for openai-codex:dillan. Live probe was not run for this conversation context.",
    });
    expect(params.sessionEntry.pendingOAuthReauth).toBeUndefined();
  });

  it("finishes a pending device-code flow on status after user approval", async () => {
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai-codex",
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
    hoisted.writeOAuthCredentialsMock.mockResolvedValue("openai-codex:dillan");
    hoisted.updateConfigMock.mockResolvedValue(cfg);

    const params = buildCommandTestParams("/reauth status", cfg);
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      pendingOAuthReauth: {
        kind: "oauth",
        provider: "openai-codex",
        profileId: "openai-codex:dillan",
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

    expect(result?.reply?.text).toBe(
      "🔐 Re-auth credentials updated for openai-codex:dillan. Live probe was not run for this conversation context.",
    );
    expect(hoisted.writeOAuthCredentialsMock).toHaveBeenCalledWith(
      "openai-codex",
      expect.objectContaining({ access: "access-token" }),
      "/tmp/agent",
      expect.objectContaining({ profileId: "openai-codex:dillan", syncSiblingAgents: false }),
    );
    expect(hoisted.clearAuthProfileCooldownMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "openai-codex:dillan",
        agentDir: "/tmp/agent",
      }),
    );
    expect(hoisted.promoteAuthProfileInOrderMock).toHaveBeenCalledWith({
      agentDir: "/tmp/agent",
      provider: "openai-codex",
      profileId: "openai-codex:dillan",
    });
    expect(params.sessionEntry.pendingOAuthReauth).toBeUndefined();
  });

  it("does not re-poll a completed device-code flow into OAuth fallback", async () => {
    const createPendingAuthorization = vi.fn(async () => ({
      flow: "callback",
      state: "state-1",
      verifier: "verifier-1",
      authorizationUrl: "https://auth.example.test/oauth",
      redirectUri: "http://localhost:1455/auth/callback",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }));
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "openai-codex:soylei": {
          provider: "openai-codex",
          type: "oauth",
          oauthRef: "ref:soylei",
          expires: Date.now() + 60_000,
        },
      },
    });
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai-codex",
      looksLikeCallbackInput: vi.fn(() => false),
      createPendingAuthorization,
      completePendingAuthorization: vi.fn(),
      pollPendingAuthorization: vi.fn(async () => {
        throw new Error(
          'OpenAI device token exchange failed: HTTP 400 { "error": { "code": "token_exchange_user_error", "type": "invalid_request_error" } }',
        );
      }),
    });

    const params = buildCommandTestParams("/reauth status", cfg);
    params.provider = "openai-codex";
    params.model = "gpt-5.5";
    params.agentDir = "/tmp/agent";
    params.agentId = "main";
    params.sessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      pendingOAuthReauth: {
        kind: "oauth",
        provider: "openai-codex",
        profileId: "openai-codex:soylei",
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
    hoisted.runAuthProbesMock.mockResolvedValue({
      results: [
        {
          provider: "openai-codex",
          model: "openai-codex/gpt-5.5",
          profileId: "openai-codex:soylei",
          status: "auth",
          error: "401 status code",
        },
      ],
    });

    const result = await handleReauthCommand(params, true);

    expect(createPendingAuthorization).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain(
      "Stored re-auth credentials are present for openai-codex:soylei",
    );
    expect(result?.reply?.text).toContain("live model probe did not pass");
    expect(result?.reply?.text).toContain("/reauth --oauth openai-codex:soylei");
    expect(result?.reply?.text).not.toContain("Stored credentials are usable");
    expect(params.sessionEntry.pendingOAuthReauth).toBeDefined();
  });

  it("falls back to callback OAuth when device-code status hits token exchange user error", async () => {
    const createPendingAuthorization = vi.fn(async () => ({
      flow: "callback",
      state: "state-1",
      verifier: "verifier-1",
      authorizationUrl: "https://auth.example.test/oauth",
      redirectUri: "http://localhost:1455/auth/callback",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }));
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai-codex",
      looksLikeCallbackInput: vi.fn(() => false),
      createPendingAuthorization,
      completePendingAuthorization: vi.fn(),
      pollPendingAuthorization: vi.fn(async () => {
        throw new Error(
          'OpenAI device token exchange failed: HTTP 400 { "error": { "code": "token_exchange_user_error", "type": "invalid_request_error" } }',
        );
      }),
    });

    const params = buildCommandTestParams("/reauth status", cfg);
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      pendingOAuthReauth: {
        kind: "oauth",
        provider: "openai-codex",
        profileId: "openai-codex:soylei",
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

    expect(createPendingAuthorization).toHaveBeenCalledWith({
      originator: "pi",
      preferredFlow: "callback",
    });
    expect(result?.reply?.text).toContain("Device-code re-auth failed");
    expect(result?.reply?.text).toContain("falling back to browser OAuth");
    expect(result?.reply?.text).toContain("https://auth.example.test/oauth");
    expect(params.sessionEntry.pendingOAuthReauth?.flow).toBe("callback");
    expect(params.sessionEntry.pendingOAuthReauth?.profileId).toBe("openai-codex:soylei");
  });

  it("does not issue a callback fallback URL when the fallback cannot be persisted", async () => {
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai-codex",
      looksLikeCallbackInput: vi.fn(() => false),
      createPendingAuthorization: vi.fn(async () => ({
        flow: "callback",
        state: "state-1",
        verifier: "verifier-1",
        authorizationUrl: "https://auth.example.test/oauth",
        redirectUri: "http://localhost:1455/auth/callback",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      })),
      completePendingAuthorization: vi.fn(),
      pollPendingAuthorization: vi.fn(async () => {
        throw new Error(
          'OpenAI device token exchange failed: HTTP 400 { "error": { "code": "token_exchange_user_error", "type": "invalid_request_error" } }',
        );
      }),
    });

    const params = buildCommandTestParams("/reauth status", cfg);
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      pendingOAuthReauth: {
        kind: "oauth",
        provider: "openai-codex",
        profileId: "openai-codex:soylei",
        flow: "device_code",
        deviceAuthId: "device-1",
        userCode: "CODE-123",
        verificationUrl: "https://auth.example.test/device",
        intervalMs: 5_000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    };

    const result = await handleReauthCommand(params, true);

    expect(result?.reply?.text).toContain("Could not persist browser OAuth fallback");
    expect(result?.reply?.text).toContain("/reauth --oauth openai-codex:soylei");
    expect(result?.reply?.text).not.toContain("https://auth.example.test/oauth");
    expect(params.sessionEntry.pendingOAuthReauth?.flow).toBe("device_code");
  });

  it("falls back to callback OAuth when the device-code watcher hits token exchange user error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T12:00:00Z"));
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "openai-codex:soylei": { provider: "openai-codex", type: "oauth", access: "a" },
      },
    });
    const createPendingAuthorization = vi
      .fn()
      .mockResolvedValueOnce({
        flow: "device_code",
        deviceAuthId: "device-1",
        userCode: "CODE-123",
        verificationUrl: "https://auth.example.test/device",
        intervalMs: 5_000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 15 * 60_000,
      })
      .mockResolvedValueOnce({
        flow: "callback",
        state: "state-1",
        verifier: "verifier-1",
        authorizationUrl: "https://auth.example.test/oauth",
        redirectUri: "http://localhost:1455/auth/callback",
        createdAt: Date.now(),
        expiresAt: Date.now() + 15 * 60_000,
      });
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai-codex",
      looksLikeCallbackInput: vi.fn(() => false),
      createPendingAuthorization,
      completePendingAuthorization: vi.fn(),
      pollPendingAuthorization: vi.fn(async () => {
        throw new Error(
          'OpenAI device token exchange failed: HTTP 400 { "error": { "code": "token_exchange_user_error", "type": "invalid_request_error" } }',
        );
      }),
    });
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => undefined);

    const params = buildCommandTestParams("/reauth openai-codex:soylei", cfg);
    params.agentDir = "/tmp/agent";
    params.sessionEntry = { sessionId: "s1", updatedAt: 1 };
    params.sessionStore = {};
    params.opts = { onBlockReply };

    await handleReauthCommand(params, true);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(onBlockReply).toHaveBeenCalledWith({
      text: expect.stringContaining("falling back to browser OAuth"),
    });
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toContain("https://auth.example.test/oauth");
    expect(params.sessionEntry.pendingOAuthReauth?.flow).toBe("callback");
  });

  it("completes a pasted callback flow", async () => {
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai-codex",
      looksLikeCallbackInput: vi.fn(() => true),
      createPendingAuthorization: vi.fn(),
      completePendingAuthorization: vi.fn(async () => ({
        access: "access-token",
        refresh: "refresh-token",
        expires: 123,
        accountId: "acct_123",
      })),
    });
    hoisted.writeOAuthCredentialsMock.mockResolvedValue("openai-codex:dillan");
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
        provider: "openai-codex",
        profileId: "openai-codex:dillan",
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

    expect(result?.reply?.text).toBe(
      "🔐 Re-auth credentials updated for openai-codex:dillan. Live probe was not run for this conversation context.",
    );
    expect(hoisted.writeOAuthCredentialsMock).toHaveBeenCalledWith(
      "openai-codex",
      expect.objectContaining({ access: "access-token" }),
      "/tmp/agent",
      expect.objectContaining({ profileId: "openai-codex:dillan", syncSiblingAgents: false }),
    );
    expect(params.sessionEntry.pendingOAuthReauth).toBeUndefined();
  });

  it("reports callback credential update when the live post-reauth probe fails", async () => {
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai-codex",
      looksLikeCallbackInput: vi.fn(() => true),
      createPendingAuthorization: vi.fn(),
      completePendingAuthorization: vi.fn(async () => ({
        access: "access-token",
        refresh: "refresh-token",
        expires: 123,
        accountId: "acct_123",
      })),
    });
    hoisted.writeOAuthCredentialsMock.mockResolvedValue("openai-codex:work");
    hoisted.updateConfigMock.mockResolvedValue(cfg);
    hoisted.runAuthProbesMock.mockResolvedValue({
      results: [
        {
          provider: "openai-codex",
          model: "openai-codex/gpt-5.5",
          profileId: "openai-codex:work",
          label: "openai-codex:work",
          source: "profile",
          mode: "oauth",
          status: "auth",
          error: "401 status code",
        },
      ],
    });

    const params = buildCommandTestParams(
      "/reauth callback http://localhost:1455/auth/callback?code=test&state=state-1",
      cfg,
    );
    params.agentId = "graphiti-agent";
    params.agentDir = "/tmp/agent";
    params.provider = "openai-codex";
    params.model = "gpt-5.5";
    params.sessionEntry = {
      sessionId: "message-session",
      updatedAt: 1,
      pendingOAuthReauth: {
        kind: "oauth",
        provider: "openai-codex",
        profileId: "openai-codex:work",
        flow: "callback",
        state: "state-1",
        verifier: "verifier-1",
        authorizationUrl: "https://auth.example.test/start",
        redirectUri: "http://localhost:1455/auth/callback",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    };
    params.sessionStore = {
      "agent:main:slack:message": params.sessionEntry,
    };

    const result = await handleReauthCommand(params, true);

    expect(hoisted.runAuthProbesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "graphiti-agent",
        agentDir: "/tmp/agent",
        providers: ["openai-codex"],
        modelCandidates: ["openai-codex/gpt-5.5"],
        options: expect.objectContaining({
          provider: "openai-codex",
          profileIds: ["openai-codex:work"],
        }),
      }),
    );
    expect(hoisted.promoteAuthProfileInOrderMock).toHaveBeenCalledWith({
      agentDir: "/tmp/agent",
      provider: "openai-codex",
      profileId: "openai-codex:work",
    });
    expect(hoisted.promoteAuthProfileInOrderMock.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.runAuthProbesMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(result?.reply?.text).toContain("Re-auth credentials were updated for openai-codex:work");
    expect(result?.reply?.text).toContain("status auth");
    expect(result?.reply?.text).toContain("401 status code");
    expect(params.sessionEntry.pendingOAuthReauth).toBeUndefined();
  });

  it("completes a pasted callback flow from another session key by state", async () => {
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai-codex",
      looksLikeCallbackInput: vi.fn(() => true),
      createPendingAuthorization: vi.fn(),
      completePendingAuthorization: vi.fn(async () => ({
        access: "access-token",
        refresh: "refresh-token",
        expires: 123,
        accountId: "acct_123",
      })),
    });
    hoisted.writeOAuthCredentialsMock.mockResolvedValue("openai-codex:work");
    hoisted.updateConfigMock.mockResolvedValue(cfg);

    const pendingSessionEntry = {
      sessionId: "slash-command-session",
      updatedAt: 1,
      pendingOAuthReauth: {
        kind: "oauth" as const,
        provider: "openai-codex",
        profileId: "openai-codex:work",
        flow: "callback" as const,
        state: "state-1",
        verifier: "verifier-1",
        authorizationUrl: "https://auth.example.test/start",
        redirectUri: "http://localhost:1455/auth/callback",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    };
    const sessionStore = {
      "agent:main:slack:slash": pendingSessionEntry,
    };
    const params = buildCommandTestParams(
      "http://localhost:1455/auth/callback?code=test&state=state-1",
      cfg,
    );
    params.agentDir = "/tmp/agent";
    params.sessionKey = "agent:main:slack:message";
    params.sessionEntry = { sessionId: "message-session", updatedAt: 1 };
    params.sessionStore = sessionStore;

    const result = await handlePendingReauthInput(params, true);

    expect(result?.reply?.text).toBe(
      "🔐 Re-auth credentials updated for openai-codex:work. Live probe was not run for this conversation context.",
    );
    expect(hoisted.writeOAuthCredentialsMock).toHaveBeenCalledWith(
      "openai-codex",
      expect.objectContaining({ access: "access-token" }),
      "/tmp/agent",
      expect.objectContaining({ profileId: "openai-codex:work", syncSiblingAgents: false }),
    );
    expect(pendingSessionEntry.pendingOAuthReauth).toBeUndefined();
    expect(params.sessionEntry.pendingOAuthReauth).toBeUndefined();
  });

  it("completes a callback via explicit reauth command", async () => {
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai-codex",
      looksLikeCallbackInput: vi.fn(() => true),
      createPendingAuthorization: vi.fn(),
      completePendingAuthorization: vi.fn(async () => ({
        access: "access-token",
        refresh: "refresh-token",
        expires: 123,
        accountId: "acct_123",
      })),
    });
    hoisted.writeOAuthCredentialsMock.mockResolvedValue("openai-codex:work");
    hoisted.updateConfigMock.mockResolvedValue(cfg);

    const pendingSessionEntry = {
      sessionId: "slash-command-session",
      updatedAt: 1,
      pendingOAuthReauth: {
        kind: "oauth" as const,
        provider: "openai-codex",
        profileId: "openai-codex:work",
        flow: "callback" as const,
        state: "state-1",
        verifier: "verifier-1",
        authorizationUrl: "https://auth.example.test/start",
        redirectUri: "http://localhost:1455/auth/callback",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    };
    const sessionStore = {
      "agent:main:slack:slash": pendingSessionEntry,
    };
    const params = buildCommandTestParams(
      "/reauth callback http://localhost:1455/auth/callback?code=test&state=state-1",
      cfg,
    );
    params.agentDir = "/tmp/agent";
    params.sessionKey = "agent:main:slack:message";
    params.sessionEntry = { sessionId: "message-session", updatedAt: 1 };
    params.sessionStore = sessionStore;

    const result = await handleReauthCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe(
      "🔐 Re-auth credentials updated for openai-codex:work. Live probe was not run for this conversation context.",
    );
    expect(hoisted.writeOAuthCredentialsMock).toHaveBeenCalledWith(
      "openai-codex",
      expect.objectContaining({ access: "access-token" }),
      "/tmp/agent",
      expect.objectContaining({ profileId: "openai-codex:work", syncSiblingAgents: false }),
    );
    expect(pendingSessionEntry.pendingOAuthReauth).toBeUndefined();
  });

  it("does not exchange a stale explicit callback against the current pending verifier", async () => {
    const completePendingAuthorization = vi.fn();
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai-codex",
      looksLikeCallbackInput: vi.fn(() => true),
      createPendingAuthorization: vi.fn(),
      completePendingAuthorization,
    });

    const params = buildCommandTestParams(
      "/reauth callback http://localhost:1455/auth/callback?code=test&state=old-state",
      cfg,
    );
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "message-session",
      updatedAt: 1,
      pendingOAuthReauth: {
        kind: "oauth",
        provider: "openai-codex",
        profileId: "openai-codex:work",
        flow: "callback",
        state: "new-state",
        verifier: "new-verifier",
        authorizationUrl: "https://auth.example.test/start",
        redirectUri: "http://localhost:1455/auth/callback",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    };
    params.sessionStore = {
      "agent:main:slack:message": params.sessionEntry,
    };

    const result = await handleReauthCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("No matching pending re-auth flow");
    expect(completePendingAuthorization).not.toHaveBeenCalled();
    expect(params.sessionEntry.pendingOAuthReauth?.state).toBe("new-state");
  });

  it("matches Slack-escaped callback state in explicit reauth command", async () => {
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai-codex",
      looksLikeCallbackInput: vi.fn(() => true),
      createPendingAuthorization: vi.fn(),
      completePendingAuthorization: vi.fn(async () => ({
        access: "access-token",
        refresh: "refresh-token",
        expires: 123,
        accountId: "acct_123",
      })),
    });
    hoisted.writeOAuthCredentialsMock.mockResolvedValue("openai-codex:work");
    hoisted.updateConfigMock.mockResolvedValue(cfg);

    const params = buildCommandTestParams(
      "/reauth callback <http://localhost:1455/auth/callback?code=test&amp;scope=openid+profile+email+offline_access&amp;state=state-1|http://localhost:1455/auth/callback?code=test&amp;state=state-1>",
      cfg,
    );
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "message-session",
      updatedAt: 1,
      pendingOAuthReauth: {
        kind: "oauth",
        provider: "openai-codex",
        profileId: "openai-codex:work",
        flow: "callback",
        state: "state-1",
        verifier: "verifier-1",
        authorizationUrl: "https://auth.example.test/start",
        redirectUri: "http://localhost:1455/auth/callback",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    };
    params.sessionStore = {
      "agent:main:slack:message": params.sessionEntry,
    };

    const result = await handleReauthCommand(params, true);

    expect(result?.reply?.text).toBe(
      "🔐 Re-auth credentials updated for openai-codex:work. Live probe was not run for this conversation context.",
    );
    expect(params.sessionEntry.pendingOAuthReauth).toBeUndefined();
  });

  it("matches double-escaped Slack callback state in explicit reauth command", async () => {
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai-codex",
      looksLikeCallbackInput: vi.fn(() => true),
      createPendingAuthorization: vi.fn(),
      completePendingAuthorization: vi.fn(async () => ({
        access: "access-token",
        refresh: "refresh-token",
        expires: 123,
        accountId: "acct_123",
      })),
    });
    hoisted.writeOAuthCredentialsMock.mockResolvedValue("openai-codex:work");
    hoisted.updateConfigMock.mockResolvedValue(cfg);

    const params = buildCommandTestParams(
      "/reauth callback <http://localhost:1455/auth/callback?code=test&amp;amp;scope=openid+profile+email+offline_access&amp;amp;state=state-1|http://localhost:1455/auth/callback?code=test&amp;amp;state=state-1>",
      cfg,
    );
    params.agentDir = "/tmp/agent";
    params.sessionEntry = {
      sessionId: "message-session",
      updatedAt: 1,
      pendingOAuthReauth: {
        kind: "oauth",
        provider: "openai-codex",
        profileId: "openai-codex:work",
        flow: "callback",
        state: "state-1",
        verifier: "verifier-1",
        authorizationUrl: "https://auth.example.test/start",
        redirectUri: "http://localhost:1455/auth/callback",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    };
    params.sessionStore = {
      "agent:main:slack:message": params.sessionEntry,
    };

    const result = await handleReauthCommand(params, true);

    expect(result?.reply?.text).toBe(
      "🔐 Re-auth credentials updated for openai-codex:work. Live probe was not run for this conversation context.",
    );
    expect(params.sessionEntry.pendingOAuthReauth).toBeUndefined();
  });

  it("does not route an unmatched explicit callback to the agent", async () => {
    hoisted.getChatReauthCapabilityMock.mockReturnValue({
      provider: "openai-codex",
      looksLikeCallbackInput: vi.fn(() => true),
      createPendingAuthorization: vi.fn(),
      completePendingAuthorization: vi.fn(),
    });

    const params = buildCommandTestParams(
      "/reauth callback http://localhost:1455/auth/callback?code=test&state=missing",
      cfg,
    );
    params.agentDir = "/tmp/agent";
    params.sessionEntry = { sessionId: "message-session", updatedAt: 1 };
    params.sessionStore = {};

    const result = await handleReauthCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("No matching pending re-auth flow");
  });

  it("does not route an unmatched bare callback to the agent", async () => {
    const params = buildCommandTestParams(
      "http://localhost:1455/auth/callback?code=test&state=missing",
      cfg,
    );
    params.agentDir = "/tmp/agent";
    params.sessionEntry = { sessionId: "message-session", updatedAt: 1 };
    params.sessionStore = {};

    const result = await handlePendingReauthInput(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("No matching pending re-auth flow");
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

  it("routes provider/model reauth requests to that provider's default profile", async () => {
    const createPendingAuthorization = vi.fn(() => ({
      flow: "device_code",
      deviceAuthId: "device-xai",
      userCode: "GROK-123",
      verificationUrl: "https://auth.x.ai/device",
      intervalMs: 5_000,
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    }));
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "xai:default": { provider: "xai", type: "oauth", access: "a" },
      },
    });
    hoisted.getChatReauthCapabilityMock.mockImplementation((provider: string) =>
      provider === "xai"
        ? {
            provider: "xai",
            looksLikeCallbackInput: vi.fn(() => false),
            createPendingAuthorization,
            completePendingAuthorization: vi.fn(),
            pollPendingAuthorization: vi.fn(),
          }
        : null,
    );

    const params = buildCommandTestParams("/reauth xai/grok-4.3", cfg);
    params.agentDir = "/tmp/agent";
    params.sessionEntry = { sessionId: "s1", updatedAt: 1 };
    params.sessionStore = {};

    const result = await handleReauthCommand(params, true);

    expect(result?.reply?.text).toContain("Re-auth pending for xai:default");
    expect(result?.reply?.text).toContain("https://auth.x.ai/device");
    expect(result?.reply?.text).toContain("Code: GROK-123");
    expect(hoisted.getChatReauthCapabilityMock).toHaveBeenCalledWith("xai");
    expect(createPendingAuthorization).toHaveBeenCalledWith({
      originator: "pi",
      preferredFlow: undefined,
    });
    expect(params.sessionEntry.pendingOAuthReauth).toMatchObject({
      provider: "xai",
      profileId: "xai:default",
      flow: "device_code",
    });
  });

  it("makes xAI models visible after Slack reauth setup", () => {
    const updated = applyPostReauthProviderConfig(
      {
        agents: {
          defaults: {
            model: { primary: "openai-codex/gpt-5.5" },
            models: {
              "openai-codex/gpt-5.5": {},
            },
          },
        },
      },
      "xai",
    );

    expect(updated.agents?.defaults?.models).toEqual({
      "openai-codex/gpt-5.5": {},
      "xai/grok-4.3": { alias: "Grok" },
    });
  });

  it("does not change model visibility for non-xAI reauth", () => {
    const original = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.5": {},
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(applyPostReauthProviderConfig(original, "openai-codex")).toBe(original);
  });
});
