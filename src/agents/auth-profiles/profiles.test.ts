import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { syncAuthProfile } from "./profiles.js";
import type { AuthProfileStore } from "./types.js";

describe("syncAuthProfile", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);

  let tempRoot = "";
  let mainAgentDir = "";
  let kidAgentDir = "";

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-profile-sync-"));
    mainAgentDir = path.join(tempRoot, "agents", "main", "agent");
    kidAgentDir = path.join(tempRoot, "agents", "kid", "agent");
    await fs.mkdir(mainAgentDir, { recursive: true });
    await fs.mkdir(kidAgentDir, { recursive: true });
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
    process.env.PI_CODING_AGENT_DIR = mainAgentDir;
  });

  afterEach(async () => {
    envSnapshot.restore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function writeStore(agentDir: string, store: AuthProfileStore) {
    await fs.writeFile(path.join(agentDir, "auth-profiles.json"), JSON.stringify(store));
  }

  async function readStore(agentDir: string): Promise<AuthProfileStore> {
    return JSON.parse(await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"));
  }

  it("syncs one profile without clobbering unrelated target metadata", async () => {
    await writeStore(mainAgentDir, {
      version: 1,
      profiles: {
        "openai-codex:work": {
          type: "oauth",
          provider: "openai-codex",
          access: "fresh-access",
          refresh: "fresh-refresh",
          expires: Date.now() + 60_000,
        },
      },
      lastGood: { "openai-codex": "openai-codex:work" },
    });

    await writeStore(kidAgentDir, {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: "anthropic-key",
        },
      },
      order: { anthropic: ["anthropic:default"] },
      lastGood: { anthropic: "anthropic:default" },
      usageStats: {
        "anthropic:default": { lastUsed: 1234 },
      },
    });

    const result = await syncAuthProfile({
      profileId: "openai-codex:work",
      sourceAgentDir: mainAgentDir,
      targetAgentDirs: [kidAgentDir, mainAgentDir],
    });

    expect(result.updatedAgentDirs).toEqual([path.resolve(kidAgentDir)]);
    expect(result.skippedAgentDirs).toEqual([path.resolve(mainAgentDir)]);

    const updatedKid = await readStore(kidAgentDir);
    expect(updatedKid.profiles["openai-codex:work"]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "fresh-access",
      refresh: "fresh-refresh",
    });
    expect(updatedKid.profiles["anthropic:default"]).toMatchObject({
      type: "api_key",
      provider: "anthropic",
      key: "anthropic-key",
    });
    expect(updatedKid.order).toEqual({ anthropic: ["anthropic:default"] });
    expect(updatedKid.lastGood).toEqual({ anthropic: "anthropic:default" });
    expect(updatedKid.usageStats).toEqual({
      "anthropic:default": { lastUsed: 1234 },
    });
  });
});
