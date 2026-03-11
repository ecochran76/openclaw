import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";

const { listAgentIdsMock, resolveAgentDirMock } = vi.hoisted(() => ({
  listAgentIdsMock: vi.fn(),
  resolveAgentDirMock: vi.fn(),
}));

const { syncAuthProfileMock } = vi.hoisted(() => ({
  syncAuthProfileMock: vi.fn(),
}));

const { loadModelsConfigMock } = vi.hoisted(() => ({
  loadModelsConfigMock: vi.fn(),
}));

const { resolveKnownAgentIdMock } = vi.hoisted(() => ({
  resolveKnownAgentIdMock: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: listAgentIdsMock,
  resolveAgentDir: resolveAgentDirMock,
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  syncAuthProfile: syncAuthProfileMock,
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: loadModelsConfigMock,
}));

vi.mock("./shared.js", () => ({
  resolveKnownAgentId: resolveKnownAgentIdMock,
}));

import { modelsAuthSyncCommand } from "./auth-sync.js";

describe("modelsAuthSyncCommand", () => {
  let runtime: RuntimeEnv;

  beforeEach(() => {
    listAgentIdsMock.mockReset();
    resolveAgentDirMock.mockReset();
    syncAuthProfileMock.mockReset();
    loadModelsConfigMock.mockReset();
    resolveKnownAgentIdMock.mockReset();

    runtime = {
      log: vi.fn(),
    } as unknown as RuntimeEnv;

    loadModelsConfigMock.mockResolvedValue({});
    listAgentIdsMock.mockReturnValue(["main", "dev-openclaw", "gpod"]);
    resolveKnownAgentIdMock.mockReturnValue(undefined);
    resolveAgentDirMock.mockImplementation((_cfg: unknown, agentId: string) => {
      return `/tmp/openclaw/agents/${agentId}`;
    });
    syncAuthProfileMock.mockResolvedValue({
      profileId: "openai-codex:work",
      credential: {
        type: "oauth",
        provider: "openai-codex",
        access: "fresh-access",
        refresh: "fresh-refresh",
        expires: Date.now() + 60_000,
      },
      updatedAgentDirs: ["/tmp/openclaw/agents/dev-openclaw", "/tmp/openclaw/agents/gpod"],
      skippedAgentDirs: [],
    });
  });

  it("syncs a profile from main to all other agents by default", async () => {
    await modelsAuthSyncCommand({ profileId: "openai-codex:work" }, runtime);

    expect(syncAuthProfileMock).toHaveBeenCalledWith({
      profileId: "openai-codex:work",
      sourceAgentDir: "/tmp/openclaw/agents/main",
      targetAgentDirs: ["/tmp/openclaw/agents/dev-openclaw", "/tmp/openclaw/agents/gpod"],
    });
    expect(runtime.log).toHaveBeenCalledWith("Profile: openai-codex:work");
    expect(runtime.log).toHaveBeenCalledWith("Updated: 2");
  });
});
