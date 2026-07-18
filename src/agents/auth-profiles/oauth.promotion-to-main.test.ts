import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import { readPersistedAuthProfileStoreRaw } from "./sqlite.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore } from "./types.js";

const { getOAuthApiKeyMock } = vi.hoisted(() => ({
  getOAuthApiKeyMock: vi.fn(async () => ({
    apiKey: "fresh-access-token",
    newCredentials: {
      access: "fresh-access-token",
      refresh: "fresh-refresh-token",
      expires: Date.now() + 60 * 60 * 1000,
    },
  })),
}));

vi.mock("../../llm/oauth.js", () => {
  return {
    getOAuthApiKey: getOAuthApiKeyMock,
    getOAuthProviders: () => [{ id: "anthropic" }],
  };
});

describe("resolveApiKeyForProfile promotion to canonical main agent", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);

  let tempRoot = "";
  let mainAgentDir = "";
  let workerAgentDir = "";

  beforeEach(async () => {
    getOAuthApiKeyMock.mockClear();
    clearRuntimeAuthProfileStoreSnapshots();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-promote-main-"));
    mainAgentDir = path.join(tempRoot, "agents", "main", "agent");
    workerAgentDir = path.join(tempRoot, "agents", "worker", "agent");
    await fs.mkdir(mainAgentDir, { recursive: true });
    await fs.mkdir(workerAgentDir, { recursive: true });
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
    process.env.PI_CODING_AGENT_DIR = mainAgentDir;
  });

  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    envSnapshot.restore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  function writeStore(agentDir: string, store: AuthProfileStore) {
    saveAuthProfileStore(store, agentDir);
  }

  function readStore(agentDir: string): AuthProfileStore {
    return readPersistedAuthProfileStoreRaw(agentDir) as AuthProfileStore;
  }

  it("promotes refreshed non-main OAuth credentials into canonical main", async () => {
    const profileId = "anthropic:work";

    writeStore(workerAgentDir, {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "anthropic",
          access: "stale-access-token",
          refresh: "stale-refresh-token",
          expires: Date.now() - 60_000,
        },
      },
    });

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(workerAgentDir),
      profileId,
      agentDir: workerAgentDir,
    });

    expect(result).toMatchObject({
      apiKey: "fresh-access-token",
      provider: "anthropic",
    });
    expect(getOAuthApiKeyMock).toHaveBeenCalledTimes(1);

    const updatedWorker = readStore(workerAgentDir);
    expect(updatedWorker.profiles[profileId]).toMatchObject({
      access: "fresh-access-token",
      refresh: "fresh-refresh-token",
    });

    const updatedMain = readStore(mainAgentDir);
    expect(updatedMain.profiles[profileId]).toMatchObject({
      access: "fresh-access-token",
      refresh: "fresh-refresh-token",
    });
  });
});
