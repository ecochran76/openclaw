import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const hoisted = vi.hoisted(() => {
  const ensureAuthProfileStoreMock = vi.fn();
  const resolveAuthProfileOrderMock = vi.fn();
  return { ensureAuthProfileStoreMock, resolveAuthProfileOrderMock };
});

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: hoisted.ensureAuthProfileStoreMock,
  normalizeRequestedProfileId: (provider: string, raw?: string) => {
    const requested = raw?.trim();
    return requested?.includes(":")
      ? requested
      : requested
        ? `${provider}:${requested}`
        : undefined;
  },
  resolveAuthProfileOrder: hoisted.resolveAuthProfileOrderMock,
}));

const { buildCommandTestParams } = await import("./commands.test-harness.js");
const { handleProfileCommand, handleProfilesCommand } = await import("./commands-profiles.js");

const cfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

function buildOwnerCommandTestParams(command: string) {
  const params = buildCommandTestParams(command, cfg);
  params.command.senderIsOwner = true;
  return params;
}

describe("/profile commands", () => {
  it("does not read or list profiles for an unauthorized sender", async () => {
    const params = buildOwnerCommandTestParams("/profiles");
    params.command.isAuthorizedSender = false;

    const result = await handleProfilesCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
    expect(hoisted.ensureAuthProfileStoreMock).not.toHaveBeenCalled();
    expect(hoisted.resolveAuthProfileOrderMock).not.toHaveBeenCalled();
  });

  it.each([
    { command: "/profiles", handler: handleProfilesCommand },
    { command: "/profile", handler: handleProfileCommand },
  ])(
    "does not expose auth profiles to an authorized non-owner via $command",
    async ({ command, handler }) => {
      hoisted.ensureAuthProfileStoreMock.mockClear();
      hoisted.resolveAuthProfileOrderMock.mockClear();
      const params = buildOwnerCommandTestParams(command);
      params.command.isAuthorizedSender = true;
      params.command.senderIsOwner = false;

      const result = await handler(params, true);

      expect(result).toEqual({ shouldContinue: false });
      expect(hoisted.ensureAuthProfileStoreMock).not.toHaveBeenCalled();
      expect(hoisted.resolveAuthProfileOrderMock).not.toHaveBeenCalled();
    },
  );

  it("sets a session auth profile override", async () => {
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "openai-codex:work": { provider: "openai-codex", type: "oauth", token: "t" },
      },
    });

    const params = buildOwnerCommandTestParams("/profile openai-codex:work");
    params.provider = "openai-codex";
    params.sessionEntry = { sessionId: "s1", updatedAt: 1 };
    params.sessionStore = {};

    const result = await handleProfileCommand(params, true);
    expect(result?.reply?.text).toContain("set to openai-codex:work");
    expect(params.sessionEntry.authProfileOverride).toBe("openai-codex:work");
    expect(params.sessionEntry.authProfileOverrideSource).toBe("user");
  });

  it("does not claim a profile override was set without persisted session state", async () => {
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "openai:work": { provider: "openai", type: "oauth", token: "t" },
      },
    });
    const params = buildOwnerCommandTestParams("/profile openai:work");
    params.provider = "openai";
    params.sessionEntry = undefined;

    const result = await handleProfileCommand(params, true);

    expect(result?.reply?.text).toContain("Cannot set");
    expect(result?.reply?.text).not.toContain("override set to");
  });

  it("qualifies a bare profile label with the resolved provider", async () => {
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "openai:work": { provider: "openai", type: "oauth", token: "t" },
      },
    });

    const params = buildOwnerCommandTestParams("/profile work");
    params.provider = "codex";
    params.sessionEntry = { sessionId: "s1", updatedAt: 1 };
    params.sessionStore = {};

    const result = await handleProfileCommand(params, true);
    expect(result?.reply?.text).toContain("set to openai:work");
    expect(params.sessionEntry.authProfileOverride).toBe("openai:work");
  });

  it("preserves an explicitly qualified profile id", async () => {
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "anthropic:work": { provider: "anthropic", type: "oauth", token: "t" },
      },
    });

    const params = buildOwnerCommandTestParams("/profile anthropic:work --provider openai");
    params.provider = "openai";
    params.sessionEntry = { sessionId: "s1", updatedAt: 1 };
    params.sessionStore = {};

    const result = await handleProfileCommand(params, true);
    expect(result?.reply?.text).toContain('"anthropic:work" is for anthropic, not openai');
    expect(params.sessionEntry.authProfileOverride).toBeUndefined();
  });

  it.each([
    { command: "/profile work typo", handler: handleProfileCommand },
    { command: "/profiles typo", handler: handleProfilesCommand },
    { command: "/profile work typo --provider openai", handler: handleProfileCommand },
    { command: "/profiles typo --provider openai", handler: handleProfilesCommand },
  ])("rejects unexpected positional arguments in $command", async ({ command, handler }) => {
    hoisted.ensureAuthProfileStoreMock.mockClear();
    const params = buildOwnerCommandTestParams(command);

    const result = await handler(params, true);

    expect(result?.reply?.text).toContain("Unexpected argument");
    expect(hoisted.ensureAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("clears session auth profile override", async () => {
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({ profiles: {} });

    const params = buildOwnerCommandTestParams("/profile clear");
    params.provider = "openai-codex";
    params.sessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      authProfileOverride: "openai-codex:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    };
    params.sessionStore = {};

    const result = await handleProfileCommand(params, true);
    expect(result?.reply?.text).toContain("Cleared session profile override");
    expect(params.sessionEntry.authProfileOverride).toBeUndefined();
    expect(params.sessionEntry.authProfileOverrideSource).toBeUndefined();
    expect(params.sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
  });

  it("does not clear an override owned by a different requested provider", async () => {
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "anthropic:work": { provider: "anthropic", type: "oauth", token: "t" },
      },
    });

    const params = buildOwnerCommandTestParams("/profile clear --provider openai");
    params.sessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      authProfileOverride: "anthropic:work",
      authProfileOverrideSource: "user",
    };
    params.sessionStore = {};

    const result = await handleProfileCommand(params, true);

    expect(result?.reply?.text).toContain("not for openai");
    expect(result?.reply?.text).toContain("not cleared");
    expect(params.sessionEntry.authProfileOverride).toBe("anthropic:work");
  });

  it("does not claim a profile override was cleared without persisted session state", async () => {
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({ profiles: {} });
    const params = buildOwnerCommandTestParams("/profile clear");
    params.sessionEntry = undefined;

    const result = await handleProfileCommand(params, true);

    expect(result?.reply?.text).toContain("Cannot clear");
    expect(result?.reply?.text).not.toContain("Cleared session profile override");
  });

  it("lists profiles for provider", async () => {
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "openai-codex:work": { provider: "openai-codex", type: "oauth", token: "t" },
        "openai-codex:personal": { provider: "openai-codex", type: "oauth", token: "t2" },
      },
    });
    hoisted.resolveAuthProfileOrderMock.mockReturnValue([
      "openai-codex:work",
      "openai-codex:personal",
    ]);

    const params = buildOwnerCommandTestParams("/profiles");
    params.provider = "openai-codex";
    params.sessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      authProfileOverride: "openai-codex:personal",
    };

    const result = await handleProfilesCommand(params, true);
    expect(result?.reply?.text).toContain("Profiles (openai)");
    expect(result?.reply?.text).toContain("* openai-codex:personal");
  });

  it("lists profiles with the documented --provider suffix", async () => {
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "anthropic:work": { provider: "anthropic", type: "oauth", token: "t" },
      },
    });
    hoisted.resolveAuthProfileOrderMock.mockReturnValue(["anthropic:work"]);
    const params = buildOwnerCommandTestParams("/profiles --provider anthropic");
    params.provider = "openai";

    const result = await handleProfilesCommand(params, true);

    expect(result?.reply?.text).toContain("Profiles (anthropic)");
    expect(result?.reply?.text).toContain("- anthropic:work");
  });

  it("lists canonical OpenAI auth profiles from Codex-backed sessions", async () => {
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "openai:work": { provider: "openai", type: "oauth", token: "t" },
        "openai:personal": { provider: "openai", type: "oauth", token: "t2" },
      },
    });
    hoisted.resolveAuthProfileOrderMock.mockReturnValue(["openai:work", "openai:personal"]);

    const params = buildOwnerCommandTestParams("/profiles");
    params.provider = "codex";
    params.sessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      authProfileOverride: "openai:personal",
    };

    const result = await handleProfilesCommand(params, true);
    expect(hoisted.resolveAuthProfileOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai" }),
    );
    expect(result?.reply?.text).toContain("Profiles (openai)");
    expect(result?.reply?.text).toContain("* openai:personal");
  });
});
