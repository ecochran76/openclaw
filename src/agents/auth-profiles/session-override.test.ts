/**
 * Session auth-profile override rotation tests.
 * Exercises provider compatibility, cooldown handling, and persisted override
 * updates without loading the real auth store implementation.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  resolveSessionAuthProfileRunDecision,
  resolveSessionAuthProfileOverride,
  resolveSessionAuthProfileSelection,
} from "./session-override.js";
import type { AuthProfileStore } from "./types.js";

const authStoreMocks = vi.hoisted(() => {
  const normalizeProvider = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const state: { hasSource: boolean; store: AuthProfileStore } = {
    hasSource: false,
    store: { version: 1, profiles: {} },
  };
  return {
    state,
    ensureAuthProfileStore: vi.fn(() => state.store),
    hasAnyAuthProfileStoreSource: vi.fn(() => state.hasSource),
    isProfileInCooldown: vi.fn((_store: AuthProfileStore, _profileId: string) => false),
    reset() {
      state.hasSource = false;
      state.store = { version: 1, profiles: {} };
    },
    resolveAuthProfileOrder: vi.fn(
      ({
        cfg,
        store,
        provider,
      }: {
        cfg?: OpenClawConfig;
        store: AuthProfileStore;
        provider: string;
      }) => {
        const providerKey = normalizeProvider(provider);
        const ordered = Object.entries(store.order ?? {}).find(
          ([key]) => normalizeProvider(key) === providerKey,
        )?.[1];
        if (ordered) {
          return ordered;
        }
        const configured = Object.entries(cfg?.auth?.profiles ?? {})
          .filter(([profileId, profile]) => {
            if (normalizeProvider(profile.provider) !== providerKey) {
              return false;
            }
            const stored = store.profiles[profileId];
            return !stored || normalizeProvider(stored.provider) === providerKey;
          })
          .map(([profileId]) => profileId);
        if (configured.length > 0) {
          return configured;
        }
        return Object.entries(store.profiles)
          .filter(([, profile]) => normalizeProvider(profile.provider) === providerKey)
          .map(([profileId]) => profileId);
      },
    ),
  };
});

vi.mock("./store.js", () => ({
  ensureAuthProfileStore: authStoreMocks.ensureAuthProfileStore,
  hasAnyAuthProfileStoreSource: authStoreMocks.hasAnyAuthProfileStoreSource,
}));

vi.mock("./order.js", () => ({
  isStoredCredentialCompatibleWithAuthProvider: ({
    cfg: _cfg,
    provider,
    credential,
  }: {
    cfg?: OpenClawConfig;
    provider: string;
    credential: { type: string; provider: string };
  }) => {
    const normalizeProvider = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const providerKey = normalizeProvider(provider);
    const credentialProviderKey = normalizeProvider(credential.provider);
    return (
      credentialProviderKey === providerKey ||
      (providerKey === "openaicodex" &&
        credentialProviderKey === "openai" &&
        credential.type === "api_key")
    );
  },
  isConfiguredAwsSdkAuthProfileForProvider: ({
    cfg,
    provider,
    profileId,
  }: {
    cfg?: OpenClawConfig;
    provider: string;
    profileId: string;
  }) => {
    const normalizeProvider = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const profile = cfg?.auth?.profiles?.[profileId];
    return (
      profile?.mode === "aws-sdk" &&
      normalizeProvider(profile.provider) === normalizeProvider(provider)
    );
  },
  resolveAuthProfileOrder: authStoreMocks.resolveAuthProfileOrder,
}));

vi.mock("./usage.js", () => ({
  isProfileInCooldown: authStoreMocks.isProfileInCooldown,
}));

async function withAuthState<T>(run: (state: OpenClawTestState) => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "openclaw-auth-",
    },
    run,
  );
}

async function withAuthStateDir<T>(run: (params: { stateDir: string }) => Promise<T>): Promise<T> {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-"));
  const stateDir = path.join(tempRoot, "state");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  try {
    await fs.mkdir(stateDir, { recursive: true });
    return await run({ stateDir });
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function createAuthStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "zai:work": { type: "api_key", provider: "zai", key: "sk-test" },
    },
    order: {
      zai: ["zai:work"],
    },
  };
}

function createAuthStoreWithProfiles(params: {
  profiles: Record<string, { type: "api_key"; provider: string; key: string }>;
  order?: Record<string, string[]>;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: params.profiles,
    ...(params.order ? { order: params.order } : {}),
  };
}

const TEST_PRIMARY_PROFILE_ID = "openai:primary@example.test";
const TEST_SECONDARY_PROFILE_ID = "openai:secondary@example.test";

function writeMockedAuthStore(_agentDir: string, store: AuthProfileStore) {
  authStoreMocks.state.hasSource = true;
  authStoreMocks.state.store = store;
}

async function writeUsageCache(params: {
  agentDir: string;
  entries: Array<{
    profileId: string;
    provider: string;
    usedPercent: number;
  }>;
}) {
  const cachePath = path.join(params.agentDir, "provider-usage-cache.json");
  const payload = {
    version: 1,
    profiles: Object.fromEntries(
      params.entries.map((entry) => [
        `${entry.provider}::${entry.profileId}`,
        {
          provider: entry.provider,
          profileId: entry.profileId,
          updatedAt: Date.now(),
          windows: [{ label: "5h", usedPercent: entry.usedPercent }],
        },
      ]),
    ),
  };
  await fs.writeFile(cachePath, JSON.stringify(payload), "utf-8");
}

describe("resolveSessionAuthProfileOverride", () => {
  afterEach(() => {
    authStoreMocks.reset();
    vi.clearAllMocks();
  });

  it("maps blocked selections into a shared runner-facing decision", () => {
    const result = resolveSessionAuthProfileRunDecision({
      profileId: "openai-codex:default",
      source: "auto",
      blockedReason: {
        kind: "usage_policy_stop",
        message: "blocked by usage policy",
        decision: {
          action: "stop",
          reason: "threshold",
          scope: "default",
          provider: "openai-codex",
          profileId: "openai-codex:default",
          selectionSource: "auto",
        },
      },
    });

    expect(result).toEqual({
      blocked: true,
      profileId: "openai-codex:default",
      source: "auto",
      error: "blocked by usage policy",
      notice: "blocked by usage policy",
      usagePolicyDecision: undefined,
    });
  });

  it("returns early when no auth sources exist", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "openrouter",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBeUndefined();
      expect(authStoreMocks.ensureAuthProfileStore).not.toHaveBeenCalled();
      try {
        await fs.access(`${agentDir}/auth-profiles.json`);
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
        return;
      }
      throw new Error("Expected auth-profiles.json to be absent");
    });
  });

  it("keeps user override when provider alias differs", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = true;
      authStoreMocks.state.store = createAuthStore();

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "zai:work",
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "z.ai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("zai:work");
      expect(sessionEntry.authProfileOverride).toBe("zai:work");
    });
  });

  it("keeps config-only aws-sdk user overrides", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = false;
      authStoreMocks.state.store = { version: 1, profiles: {} };

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "amazon-bedrock:default",
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {
          models: {
            providers: {
              "amazon-bedrock": {
                auth: "aws-sdk",
                baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
                api: "bedrock-converse-stream",
                models: [],
              },
            },
          },
          auth: {
            profiles: {
              "amazon-bedrock:default": {
                provider: "amazon-bedrock",
                mode: "aws-sdk",
              },
            },
          },
        } as OpenClawConfig,
        provider: "amazon-bedrock",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("amazon-bedrock:default");
      expect(sessionEntry.authProfileOverride).toBe("amazon-bedrock:default");
    });
  });

  it("clears aws-sdk config override when stored profile drifted to another provider", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = true;
      authStoreMocks.state.store = createAuthStoreWithProfiles({
        profiles: {
          "amazon-bedrock:default": {
            type: "api_key",
            provider: "openrouter",
            key: "sk-drifted",
          },
        },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "amazon-bedrock:default",
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {
          models: {
            providers: {
              "amazon-bedrock": {
                auth: "aws-sdk",
                baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
                api: "bedrock-converse-stream",
                models: [],
              },
            },
          },
          auth: {
            profiles: {
              "amazon-bedrock:default": {
                provider: "amazon-bedrock",
                mode: "aws-sdk",
              },
            },
          },
        } as OpenClawConfig,
        provider: "amazon-bedrock",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBeUndefined();
      expect(sessionEntry.authProfileOverride).toBeUndefined();
      expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    });
  });

  it("keeps explicit user override when stored order prefers another profile", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = true;
      authStoreMocks.state.store = createAuthStoreWithProfiles({
        profiles: {
          [TEST_PRIMARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai",
            key: "sk-josh",
          },
          [TEST_SECONDARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai",
            key: "sk-claude",
          },
        },
        order: {
          openai: [TEST_PRIMARY_PROFILE_ID],
        },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: TEST_SECONDARY_PROFILE_ID,
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "openai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverride).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideSource).toBe("user");
    });
  });

  it("keeps session override when CLI provider aliases the stored profile provider", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = true;
      authStoreMocks.state.store = createAuthStoreWithProfiles({
        profiles: {
          [TEST_PRIMARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai",
            key: "sk-codex",
          },
        },
        order: {
          "codex-cli": [TEST_PRIMARY_PROFILE_ID],
        },
      });
      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: TEST_PRIMARY_PROFILE_ID,
        authProfileOverrideSource: "auto",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "codex-cli",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe(TEST_PRIMARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverride).toBe(TEST_PRIMARY_PROFILE_ID);
    });
  });

  it("keeps a session override from an accepted runtime auth provider", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = true;
      authStoreMocks.state.store = createAuthStoreWithProfiles({
        profiles: {
          [TEST_PRIMARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai",
            key: "sk-codex",
          },
        },
        order: {
          openai: [TEST_PRIMARY_PROFILE_ID],
        },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: TEST_PRIMARY_PROFILE_ID,
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "openai",
        acceptedProviderIds: ["openai"],
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe(TEST_PRIMARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverride).toBe(TEST_PRIMARY_PROFILE_ID);
    });
  });

  it("keeps user-pinned normal OpenAI API-key profiles for Codex sessions", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = true;
      authStoreMocks.state.store = createAuthStoreWithProfiles({
        profiles: {
          "openai:api-key-backup": {
            type: "api_key",
            provider: "openai",
            key: "sk-openai",
          },
          [TEST_PRIMARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai",
            key: "sk-codex",
          },
        },
        order: {
          openai: [TEST_PRIMARY_PROFILE_ID],
        },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "openai:api-key-backup",
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "openai",
        acceptedProviderIds: ["openai"],
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("openai:api-key-backup");
      expect(sessionEntry.authProfileOverride).toBe("openai:api-key-backup");
      expect(sessionEntry.authProfileOverrideSource).toBe("user");
    });
  });

  it("re-resolves a stale user session override when the selected profile becomes unusable", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = true;
      authStoreMocks.state.store = createAuthStoreWithProfiles({
        profiles: {
          [TEST_PRIMARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai",
            key: "sk-stale",
          },
          [TEST_SECONDARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai",
            key: "sk-healthy",
          },
        },
        order: {
          openai: [TEST_SECONDARY_PROFILE_ID, TEST_PRIMARY_PROFILE_ID],
        },
      });
      authStoreMocks.isProfileInCooldown.mockImplementation(
        (_store: AuthProfileStore, profileId: string) => profileId === TEST_PRIMARY_PROFILE_ID,
      );

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: TEST_PRIMARY_PROFILE_ID,
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "openai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverride).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
    });
  });

  it("keeps user override on the first run of a new session", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      await writeMockedAuthStore(agentDir, {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "access-default",
            refresh: "refresh-default",
            expires: Date.now() + 60_000,
          },
          "openai-codex:dillan": {
            type: "oauth",
            provider: "openai-codex",
            access: "access-dillan",
            refresh: "refresh-dillan",
            expires: Date.now() + 60_000,
          },
        },
        order: {
          "openai-codex": ["openai-codex:default", "openai-codex:dillan"],
        },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "openai-codex:dillan",
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:slack:thread:1": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "openai-codex",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:slack:thread:1",
        storePath: undefined,
        isNewSession: true,
      });

      expect(resolved).toBe("openai-codex:dillan");
      expect(sessionEntry.authProfileOverride).toBe("openai-codex:dillan");
      expect(sessionEntry.authProfileOverrideSource).toBe("user");
    });
  });

  it("blocks auto-selected profiles when cached usage matches a stop threshold", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      const provider = "openai-codex";
      await writeMockedAuthStore(agentDir, {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider,
            access: "access-default",
            refresh: "refresh-default",
            expires: Date.now() + 60_000,
          },
        },
        order: {
          [provider]: [profileId],
        },
      });
      await writeUsageCache({
        agentDir,
        entries: [{ profileId, provider, usedPercent: 85 }],
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
      };
      const sessionStore = { "agent:main:slack:thread:1": sessionEntry };

      const resolved = await resolveSessionAuthProfileSelection({
        cfg: {
          auth: {
            usagePolicy: {
              enabled: true,
              defaults: {
                stop: [{ window: "5h", remainingPercentLte: 20 }],
              },
            },
          },
        } as OpenClawConfig,
        provider,
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:slack:thread:1",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved.profileId).toBe(profileId);
      expect(resolved.blockedReason?.kind).toBe("usage_policy_stop");
      expect(resolved.blockedReason?.message).toContain("stop threshold matched");
    });
  });

  it("keeps default-scope stop rules from overriding a manual profile selection", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      const provider = "openai-codex";
      await writeMockedAuthStore(agentDir, {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider,
            access: "access-default",
            refresh: "refresh-default",
            expires: Date.now() + 60_000,
          },
        },
        order: {
          [provider]: [profileId],
        },
      });
      await writeUsageCache({
        agentDir,
        entries: [{ profileId, provider, usedPercent: 85 }],
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: profileId,
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:slack:thread:1": sessionEntry };

      const resolved = await resolveSessionAuthProfileSelection({
        cfg: {
          auth: {
            usagePolicy: {
              enabled: true,
              defaults: {
                stop: [{ window: "5h", remainingPercentLte: 20 }],
              },
            },
          },
        } as OpenClawConfig,
        provider,
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:slack:thread:1",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved.profileId).toBe(profileId);
      expect(resolved.blockedReason).toBeUndefined();
      expect(
        await resolveSessionAuthProfileOverride({
          cfg: {
            auth: {
              usagePolicy: {
                enabled: true,
                defaults: {
                  stop: [{ window: "5h", remainingPercentLte: 20 }],
                },
              },
            },
          } as OpenClawConfig,
          provider,
          agentDir,
          sessionEntry,
          sessionStore,
          sessionKey: "agent:main:slack:thread:1",
          storePath: undefined,
          isNewSession: false,
        }),
      ).toBe(profileId);
    });
  });

  it("auto-switches to the next cached-healthy profile when a switch threshold matches", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const provider = "openai-codex";
      const primaryProfileId = "openai-codex:default";
      const backupProfileId = "openai-codex:backup";
      await writeMockedAuthStore(agentDir, {
        version: 1,
        profiles: {
          [primaryProfileId]: {
            type: "oauth",
            provider,
            access: "access-default",
            refresh: "refresh-default",
            expires: Date.now() + 60_000,
          },
          [backupProfileId]: {
            type: "oauth",
            provider,
            access: "access-backup",
            refresh: "refresh-backup",
            expires: Date.now() + 60_000,
          },
        },
        order: {
          [provider]: [primaryProfileId, backupProfileId],
        },
      });
      await writeUsageCache({
        agentDir,
        entries: [
          { profileId: primaryProfileId, provider, usedPercent: 85 },
          { profileId: backupProfileId, provider, usedPercent: 10 },
        ],
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
      };
      const sessionStore = { "agent:main:slack:thread:1": sessionEntry };

      const resolved = await resolveSessionAuthProfileSelection({
        cfg: {
          auth: {
            usagePolicy: {
              enabled: true,
              defaults: {
                switch: [{ window: "5h", remainingPercentLte: 20 }],
              },
            },
          },
        } as OpenClawConfig,
        provider,
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:slack:thread:1",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved.profileId).toBe(backupProfileId);
      expect(resolved.switchNotice?.message).toContain(
        `from ${primaryProfileId} to ${backupProfileId}`,
      );
      expect(sessionEntry.authProfileOverride).toBe(backupProfileId);
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
    });
  });

  it("can stop when a switch threshold matches and no eligible target exists", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const provider = "openai-codex";
      const primaryProfileId = "openai-codex:default";
      const blockedProfileId = "openai-codex:blocked";
      await writeMockedAuthStore(agentDir, {
        version: 1,
        profiles: {
          [primaryProfileId]: {
            type: "oauth",
            provider,
            access: "access-default",
            refresh: "refresh-default",
            expires: Date.now() + 60_000,
          },
          [blockedProfileId]: {
            type: "oauth",
            provider,
            access: "access-blocked",
            refresh: "refresh-blocked",
            expires: Date.now() + 60_000,
          },
        },
        order: {
          [provider]: [primaryProfileId, blockedProfileId],
        },
      });
      await writeUsageCache({
        agentDir,
        entries: [
          { profileId: primaryProfileId, provider, usedPercent: 85 },
          { profileId: blockedProfileId, provider, usedPercent: 95 },
        ],
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
      };
      const sessionStore = { "agent:main:slack:thread:1": sessionEntry };

      const resolved = await resolveSessionAuthProfileSelection({
        cfg: {
          auth: {
            usagePolicy: {
              enabled: true,
              defaults: {
                switch: [{ window: "5h", remainingPercentLte: 20 }],
                stop: [{ window: "5h", remainingPercentLte: 10 }],
                onNoSwitchTarget: "stop",
              },
            },
          },
        } as OpenClawConfig,
        provider,
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:slack:thread:1",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved.profileId).toBe(primaryProfileId);
      expect(resolved.blockedReason?.kind).toBe("usage_policy_stop");
      expect(resolved.blockedReason?.message).toContain("No eligible auth profile is available");
    });
  });

  it("can warn when a switch threshold matches and no eligible target exists", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const provider = "openai-codex";
      const primaryProfileId = "openai-codex:default";
      const blockedProfileId = "openai-codex:blocked";
      await writeMockedAuthStore(agentDir, {
        version: 1,
        profiles: {
          [primaryProfileId]: {
            type: "oauth",
            provider,
            access: "access-default",
            refresh: "refresh-default",
            expires: Date.now() + 60_000,
          },
          [blockedProfileId]: {
            type: "oauth",
            provider,
            access: "access-blocked",
            refresh: "refresh-blocked",
            expires: Date.now() + 60_000,
          },
        },
        order: {
          [provider]: [primaryProfileId, blockedProfileId],
        },
      });
      await writeUsageCache({
        agentDir,
        entries: [
          { profileId: primaryProfileId, provider, usedPercent: 85 },
          { profileId: blockedProfileId, provider, usedPercent: 95 },
        ],
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
      };
      const sessionStore = { "agent:main:slack:thread:1": sessionEntry };

      const resolved = await resolveSessionAuthProfileSelection({
        cfg: {
          auth: {
            usagePolicy: {
              enabled: true,
              defaults: {
                switch: [{ window: "5h", remainingPercentLte: 20 }],
                stop: [{ window: "5h", remainingPercentLte: 10 }],
                onNoSwitchTarget: "warn",
              },
            },
          },
        } as OpenClawConfig,
        provider,
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:slack:thread:1",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved.profileId).toBe(primaryProfileId);
      expect(resolved.blockedReason).toBeUndefined();
      expect(resolved.usagePolicyDecision?.action).toBe("warn");
      expect(resolved.usagePolicyDecision?.noSwitchTarget).toBe(true);
      expect(resolved.usagePolicyDecision?.message).toContain(
        "No eligible auth profile is available for automatic switching.",
      );
    });
  });
});
