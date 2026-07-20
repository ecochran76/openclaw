import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
}));

vi.mock("../../agents/auth-profiles/store.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  hasAnyAuthProfileStoreSource: vi.fn(() => true),
  updateAuthProfileStoreWithLock: vi.fn(),
}));

vi.mock("../../agents/auth-profiles/order.js", () => ({
  resolveAuthProfileOrder: mocks.resolveAuthProfileOrder,
}));

vi.mock("../../agents/provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: (provider: string) => provider,
}));

const { buildCommandTestParams } = await import("./commands.test-harness.js");
const { handleProfileCommand, handleProfilesCommand } = await import("./commands-profiles.js");

const cfg = { session: { mainKey: "main", scope: "per-sender" } } satisfies OpenClawConfig;

function buildParams(command: string) {
  const params = buildCommandTestParams(command, cfg);
  params.command.senderIsOwner = true;
  params.command.isAuthorizedSender = true;
  params.provider = "codex";
  params.agentDir = "/tmp/openclaw-profile-command";
  params.sessionEntry = { sessionId: "s1", updatedAt: 1 };
  params.sessionStore = { [params.sessionKey]: params.sessionEntry };
  return params;
}

describe("profile commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers both native and text command surfaces", async () => {
    const { buildBuiltinChatCommands } = await import("../commands-registry.shared.js");
    const commands = buildBuiltinChatCommands();
    expect(commands.find((entry) => entry.key === "profile")).toMatchObject({
      nativeName: "profile",
      textAliases: ["/profile"],
      scope: "both",
    });
    expect(commands.find((entry) => entry.key === "profiles")).toMatchObject({
      nativeName: "profiles",
      textAliases: ["/profiles"],
      scope: "both",
    });
  });

  it("sets a uniquely matching bare profile id through the canonical session seam", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
    mocks.resolveAuthProfileOrder.mockReturnValue(["openai:work", "openai:personal"]);
    const params = buildParams("/profile work");

    const result = await handleProfileCommand(params, true);

    expect(result?.reply?.text).toContain("set to openai:work (openai)");
    expect(params.sessionEntry?.authProfileOverride).toBe("openai:work");
    expect(params.sessionEntry?.authProfileOverrideSource).toBe("user");
    expect(params.sessionEntry?.authProfileOverrideCompactionCount).toBeUndefined();
  });

  it("requires qualification when a bare label is ambiguous", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
    mocks.resolveAuthProfileOrder.mockReturnValue(["openai:team:work", "openai:work"]);
    const params = buildParams("/profile work");

    const result = await handleProfileCommand(params, true);

    expect(result?.reply?.text).toContain("ambiguous");
    expect(params.sessionEntry?.authProfileOverride).toBeUndefined();
  });

  it("clears only when the optional provider owns the active profile", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
    mocks.resolveAuthProfileOrder.mockReturnValue(["anthropic:work"]);
    const params = buildParams("/profile clear --provider anthropic");
    params.sessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      authProfileOverride: "anthropic:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    };
    params.sessionStore![params.sessionKey] = params.sessionEntry;

    const result = await handleProfileCommand(params, true);

    expect(result?.reply?.text).toContain("Cleared session profile override");
    expect(params.sessionEntry?.authProfileOverride).toBeUndefined();
    expect(params.sessionEntry?.authProfileOverrideSource).toBeUndefined();
    expect(params.sessionEntry?.authProfileOverrideCompactionCount).toBeUndefined();
  });

  it("clears a stale qualified override that is no longer in provider order", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
    mocks.resolveAuthProfileOrder.mockReturnValue([]);
    const params = buildParams("/profile clear --provider anthropic");
    params.sessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      authProfileOverride: "anthropic:removed",
      authProfileOverrideSource: "user",
    };
    params.sessionStore![params.sessionKey] = params.sessionEntry;

    const result = await handleProfileCommand(params, true);

    expect(result?.reply?.text).toContain("Cleared session profile override");
    expect(params.sessionEntry?.authProfileOverride).toBeUndefined();
  });

  it("lists ordered profiles and marks the active one", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
    mocks.resolveAuthProfileOrder.mockReturnValue(["openai:work", "openai:personal"]);
    const params = buildParams("/profiles");
    params.sessionEntry!.authProfileOverride = "openai:personal";

    const result = await handleProfilesCommand(params, true);

    expect(result?.reply?.text).toContain("Profiles (openai)");
    expect(result?.reply?.text).toContain("* openai:personal");
  });

  it.each(["/profile", "/profiles"])("rejects authorized non-owners for %s", async (command) => {
    const params = buildParams(command);
    params.command.senderIsOwner = false;
    const handler = command === "/profile" ? handleProfileCommand : handleProfilesCommand;

    expect(await handler(params, true)).toEqual({ shouldContinue: false });
    expect(mocks.ensureAuthProfileStore).not.toHaveBeenCalled();
  });
});
