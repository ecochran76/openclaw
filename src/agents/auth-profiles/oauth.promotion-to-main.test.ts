import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import { clearRuntimeAuthProfileStoreSnapshots, ensureAuthProfileStore } from "./store.js";
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

vi.mock("@earendil-works/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai/oauth")>(
    "@earendil-works/pi-ai/oauth",
  );
  return {
    ...actual,
    getOAuthApiKey: getOAuthApiKeyMock,
    getOAuthProviders: () => [
      { id: "anthropic", envApiKey: "ANTHROPIC_API_KEY", oauthTokenEnv: "ANTHROPIC_OAUTH_TOKEN" },
    ],
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

  async function writeStore(agentDir: string, store: AuthProfileStore) {
    await fs.writeFile(path.join(agentDir, "auth-profiles.json"), JSON.stringify(store));
  }

  async function readStore(agentDir: string): Promise<AuthProfileStore> {
    return JSON.parse(await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"));
  }

  it("promotes refreshed non-main OAuth credentials into canonical main", async () => {
    const profileId = "anthropic:work";

    await writeStore(workerAgentDir, {
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

    const updatedWorker = await readStore(workerAgentDir);
    expect(updatedWorker.profiles[profileId]).toMatchObject({
      access: "fresh-access-token",
      refresh: "fresh-refresh-token",
    });

    const updatedMain = await readStore(mainAgentDir);
    expect(updatedMain.profiles[profileId]).toMatchObject({
      access: "fresh-access-token",
      refresh: "fresh-refresh-token",
    });
  });
});
