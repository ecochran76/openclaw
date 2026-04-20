import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import {
  ensureAuthProfileStore,
  markAuthProfileUsed,
  setAuthProfileOrder,
} from "./auth-profiles.js";
import { resolveAuthStorePath } from "./auth-profiles/paths.js";

describe("auth profile runtime snapshot order persistence", () => {
  it("preserves per-agent auth order after usage stat writes", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-order-"));
    const mainAgentDir = path.join(stateDir, "agents", "main", "agent");
    const workerAgentDir = path.join(stateDir, "agents", "worker", "agent");
    const workerAuthPath = resolveAuthStorePath(workerAgentDir);
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;

    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await fs.mkdir(mainAgentDir, { recursive: true });
      await fs.mkdir(workerAgentDir, { recursive: true });

      await fs.writeFile(
        path.join(mainAgentDir, "auth-profiles.json"),
        `${JSON.stringify(
          {
            version: 1,
            profiles: {
              "openai-codex:dillan": {
                type: "token",
                provider: "openai-codex",
                token: "tok-dillan",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await fs.writeFile(
        workerAuthPath,
        `${JSON.stringify(
          {
            version: 1,
            profiles: {},
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: {
          agents: {
            list: [{ id: "worker" }],
          },
        },
      });
      activateSecretsRuntimeSnapshot(snapshot);

      const resolvedBefore = ensureAuthProfileStore(workerAgentDir);
      expect(resolvedBefore.profiles["openai-codex:dillan"]).toBeDefined();

      const updated = await setAuthProfileOrder({
        agentDir: workerAgentDir,
        provider: "openai-codex",
        order: ["openai-codex:dillan"],
      });
      expect(updated).not.toBeNull();

      const afterOrderWrite = ensureAuthProfileStore(workerAgentDir);
      expect(afterOrderWrite.order?.["openai-codex"]).toEqual(["openai-codex:dillan"]);

      const runtimeStore = ensureAuthProfileStore(workerAgentDir);
      await markAuthProfileUsed({
        store: runtimeStore,
        profileId: "openai-codex:dillan",
        agentDir: workerAgentDir,
      });

      const afterUsageWrite = ensureAuthProfileStore(workerAgentDir);
      expect(afterUsageWrite.order?.["openai-codex"]).toEqual(["openai-codex:dillan"]);
    } finally {
      clearSecretsRuntimeSnapshot();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
