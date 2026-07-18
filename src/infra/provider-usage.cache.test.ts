import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  inspectOpenClawAgentDatabaseOwner,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  resolveProviderUsageCacheDatabasePath,
  resolveProviderUsageCacheOwnerId,
  updateProviderUsageCacheJson,
} from "./provider-usage-cache.sqlite.js";
import {
  claimCachedUsagePolicyAlert,
  clearRuntimeProviderUsageCacheSnapshots,
  getCachedProfileUsageState,
  loadProviderUsageSummaryWithCache,
  mergeProviderUsageFallbackSnapshots,
  pruneProviderUsageAlertClaims,
  readCachedProfileUsageState,
  readCachedProviderUsageSummary,
  writeCachedProviderUsageSummary,
} from "./provider-usage.cache.js";

type AgentCacheDatabase = Pick<OpenClawAgentKyselyDatabase, "cache_entries">;

describe("provider-usage.cache", () => {
  beforeEach(() => {
    clearRuntimeProviderUsageCacheSnapshots();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
  });

  it("prunes alert claims by timestamp and lexical key while protecting the winner", () => {
    expect(
      pruneProviderUsageAlertClaims({
        claims: {
          bravo: 100,
          newest: 100,
          alpha: 100,
          oldest: 50,
        },
        maxEntries: 2,
        protectedKey: "newest",
      }),
    ).toEqual({ bravo: 100, newest: 100 });
  });

  it("retains a protected stale decision when the claim cache is at capacity", () => {
    const protectedKey = "stale-decision";
    const claims = Object.fromEntries(
      Array.from({ length: 1024 }, (_, index) => [`claim-${index}`, 100 + index]),
    );

    const pruned = pruneProviderUsageAlertClaims({
      claims: { ...claims, [protectedKey]: 1 },
      maxEntries: 1024,
      protectedKey,
    });

    expect(Object.keys(pruned)).toHaveLength(1024);
    expect(pruned[protectedKey]).toBe(1);
    expect(pruned["claim-0"]).toBeUndefined();
  });

  it("canonicalizes agent paths and assigns stable non-main owners", async () => {
    await withTempDir({ prefix: "openclaw-usage-cache-home-" }, async (homeDir) => {
      vi.stubEnv("HOME", homeDir);
      const tildeAgentDir = "~/.openclaw/agents/ops/agent";
      const expectedAgentDir = path.join(homeDir, ".openclaw", "agents", "ops", "agent");
      expect(resolveProviderUsageCacheDatabasePath(tildeAgentDir)).toBe(
        path.join(expectedAgentDir, "openclaw-agent.sqlite"),
      );

      await writeCachedProviderUsageSummary({
        agentDir: tildeAgentDir,
        agentId: "ops",
        profileId: "openai:ops",
        summary: {
          updatedAt: 100,
          providers: [{ provider: "openai", displayName: "Codex", windows: [] }],
        },
      });
      expect(
        inspectOpenClawAgentDatabaseOwner(resolveProviderUsageCacheDatabasePath(tildeAgentDir)),
      ).toEqual({ status: "owned", agentId: "ops" });
    });

    await withTempDir({ prefix: "openclaw-usage-cache-custom-" }, async (agentDir) => {
      const ownerId = resolveProviderUsageCacheOwnerId({ agentDir });
      expect(ownerId).toMatch(/^custom-[a-f0-9]{12}$/);
      await writeCachedProviderUsageSummary({
        agentDir,
        profileId: "openai:custom",
        summary: {
          updatedAt: 100,
          providers: [{ provider: "openai", displayName: "Codex", windows: [] }],
        },
      });
      expect(
        inspectOpenClawAgentDatabaseOwner(resolveProviderUsageCacheDatabasePath(agentDir)),
      ).toEqual({ status: "owned", agentId: ownerId });
    });
  });

  it("writes and reads cached usage snapshots per provider/profile", async () => {
    await withTempDir({ prefix: "openclaw-usage-cache-" }, async (agentDir) => {
      await writeCachedProviderUsageSummary({
        agentDir,
        profileId: "openai:pcg",
        summary: {
          updatedAt: Date.UTC(2026, 2, 27, 12, 0, 0),
          providers: [
            {
              provider: "openai",
              displayName: "Codex",
              windows: [{ label: "5h", usedPercent: 72 }],
              plan: "Plus",
            },
          ],
        },
      });

      await expect(fs.stat(path.join(agentDir, "openclaw-agent.sqlite"))).resolves.toBeDefined();
      await expect(fs.stat(path.join(agentDir, "provider-usage-cache.json"))).rejects.toMatchObject(
        {
          code: "ENOENT",
        },
      );

      const cached = await readCachedProfileUsageState({
        agentDir,
        provider: "openai",
        profileId: "openai:pcg",
      });
      expect(cached).toMatchObject({
        provider: "openai",
        profileId: "openai:pcg",
        plan: "Plus",
        windows: [{ label: "5h", usedPercent: 72 }],
      });

      expect(
        getCachedProfileUsageState({
          agentDir,
          provider: "openai",
          profileId: "openai:pcg",
        }),
      ).toMatchObject({
        provider: "openai",
        profileId: "openai:pcg",
      });

      const summary = await readCachedProviderUsageSummary({
        agentDir,
        profileId: "openai:pcg",
        providers: ["openai"],
      });
      expect(summary.providers).toHaveLength(1);
      expect(summary.providers[0]?.windows[0]?.label).toBe("5h");
    });
  });

  it("falls back to cached provider usage when refresh throws", async () => {
    await withTempDir({ prefix: "openclaw-usage-cache-" }, async (agentDir) => {
      const successFetch = createProviderUsageFetch(async (url) => {
        if (url.includes("chatgpt.com/backend-api/wham/usage")) {
          return makeResponse(200, {
            rate_limit: {
              primary_window: {
                used_percent: 18,
                limit_window_seconds: 10800,
              },
            },
            plan_type: "Plus",
          });
        }
        return makeResponse(404, "not found");
      });

      const warm = await loadProviderUsageSummaryWithCache({
        config: {},
        agentDir,
        cacheAgentDir: agentDir,
        cacheProfileId: "openai:pcg",
        profileId: "openai:pcg",
        providers: ["openai"],
        auth: [{ provider: "openai", token: "codex-token", accountId: "acc-1" }],
        fetch: successFetch,
        now: Date.UTC(2026, 2, 27, 12, 0, 0),
      });
      expect(warm.providers[0]?.windows[0]?.usedPercent).toBe(18);

      vi.stubGlobal("fetch", undefined);
      let fallback;
      try {
        fallback = await loadProviderUsageSummaryWithCache({
          config: {},
          agentDir,
          cacheAgentDir: agentDir,
          cacheProfileId: "openai:pcg",
          profileId: "openai:pcg",
          providers: ["openai"],
          auth: [{ provider: "openai", token: "codex-token", accountId: "acc-1" }],
          now: Date.UTC(2026, 2, 27, 12, 30, 0),
          fallbackToCache: true,
        });
      } finally {
        vi.unstubAllGlobals();
      }

      expect(fallback.providers).toHaveLength(1);
      expect(fallback.providers[0]?.provider).toBe("openai");
      expect(fallback.providers[0]?.windows[0]?.usedPercent).toBe(18);
    });
  });

  it("falls back to cached provider usage when refresh returns an error snapshot", async () => {
    await withTempDir({ prefix: "openclaw-usage-cache-" }, async (agentDir) => {
      const profileId = "openai:pcg";
      const successfulAt = Date.UTC(2026, 2, 27, 12, 0, 0);
      await writeCachedProviderUsageSummary({
        agentDir,
        profileId,
        summary: {
          updatedAt: successfulAt,
          providers: [
            {
              provider: "openai",
              displayName: "Codex",
              windows: [{ label: "5h", usedPercent: 18 }],
              plan: "Plus",
            },
          ],
        },
      });

      const fallback = await loadProviderUsageSummaryWithCache({
        config: {},
        agentDir,
        cacheAgentDir: agentDir,
        cacheProfileId: profileId,
        profileId,
        providers: ["openai"],
        auth: [{ provider: "openai", token: "expired-token", accountId: "acc-1" }],
        fetch: createProviderUsageFetch(async () => makeResponse(401, "token expired")),
        now: successfulAt + 30 * 60_000,
        fallbackToCache: true,
      });

      expect(fallback.updatedAt).toBe(successfulAt);
      expect(fallback.providers).toMatchObject([
        {
          provider: "openai",
          windows: [{ label: "5h", usedPercent: 18 }],
          plan: "Plus",
        },
      ]);
      expect(fallback.providers[0]?.error).toBeUndefined();
    });
  });

  it("merges cached fallback only for failed live providers", () => {
    const merged = mergeProviderUsageFallbackSnapshots({
      live: {
        updatedAt: 200,
        providers: [
          { provider: "openai", displayName: "OpenAI", windows: [], error: "HTTP 401" },
          {
            provider: "anthropic",
            displayName: "Anthropic",
            windows: [{ label: "month", usedPercent: 22 }],
          },
          { provider: "google", displayName: "Google", windows: [], error: "Timeout" },
        ],
      },
      cached: {
        updatedAt: 100,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            windows: [{ label: "5h", usedPercent: 18 }],
          },
          {
            provider: "anthropic",
            displayName: "Anthropic",
            windows: [{ label: "month", usedPercent: 70 }],
          },
        ],
      },
    });

    expect(merged).toEqual({
      updatedAt: 200,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "5h", usedPercent: 18 }],
        },
        {
          provider: "anthropic",
          displayName: "Anthropic",
          windows: [{ label: "month", usedPercent: 22 }],
        },
        { provider: "google", displayName: "Google", windows: [], error: "Timeout" },
      ],
    });
  });

  it("preserves the last successful snapshot when a refresh returns an error snapshot", async () => {
    await withTempDir({ prefix: "openclaw-usage-cache-" }, async (agentDir) => {
      const profileId = "openai:pcg";
      const successfulAt = Date.UTC(2026, 2, 27, 12, 0, 0);
      await writeCachedProviderUsageSummary({
        agentDir,
        profileId,
        summary: {
          updatedAt: successfulAt,
          providers: [
            {
              provider: "openai",
              displayName: "Codex",
              windows: [{ label: "5h", usedPercent: 18 }],
              plan: "Plus",
            },
          ],
        },
      });

      await writeCachedProviderUsageSummary({
        agentDir,
        profileId,
        summary: {
          updatedAt: successfulAt + 30 * 60_000,
          providers: [
            {
              provider: "openai",
              displayName: "Codex",
              windows: [],
              error: "usage endpoint unavailable",
            },
          ],
        },
      });

      const cached = await readCachedProfileUsageState({
        agentDir,
        provider: "openai",
        profileId,
      });
      expect(cached).toMatchObject({
        updatedAt: successfulAt,
        windows: [{ label: "5h", usedPercent: 18 }],
        plan: "Plus",
      });
      expect(cached?.error).toBeUndefined();
    });
  });

  it("refreshes async reads from SQLite after the runtime mirror is warm", async () => {
    await withTempDir({ prefix: "openclaw-usage-cache-" }, async (agentDir) => {
      const profileId = "openai:pcg";
      const ownerId = resolveProviderUsageCacheOwnerId({ agentDir });
      await writeCachedProviderUsageSummary({
        agentDir,
        agentId: ownerId,
        profileId,
        summary: {
          updatedAt: 100,
          providers: [
            {
              provider: "openai",
              displayName: "Codex",
              windows: [{ label: "5h", usedPercent: 18 }],
            },
          ],
        },
      });
      await expect(
        readCachedProfileUsageState({ agentDir, agentId: ownerId, provider: "openai", profileId }),
      ).resolves.toMatchObject({ windows: [{ usedPercent: 18 }] });

      updateProviderUsageCacheJson({
        agentDir,
        agentId: ownerId,
        updatedAt: 200,
        update: () => ({
          valueJson: JSON.stringify({
            version: 1,
            profiles: {
              [`openai::${profileId}`]: {
                provider: "openai",
                profileId,
                updatedAt: 200,
                windows: [{ label: "5h", usedPercent: 77 }],
              },
            },
          }),
          result: undefined,
        }),
      });

      expect(getCachedProfileUsageState({ agentDir, provider: "openai", profileId })).toMatchObject(
        {
          windows: [{ usedPercent: 18 }],
        },
      );
      await expect(
        readCachedProfileUsageState({ agentDir, agentId: ownerId, provider: "openai", profileId }),
      ).resolves.toMatchObject({ windows: [{ usedPercent: 77 }] });
    });
  });

  it("does not let an older provider sample replace a newer one", async () => {
    await withTempDir({ prefix: "openclaw-usage-cache-" }, async (agentDir) => {
      const profileId = "openai:pcg";
      const ownerId = resolveProviderUsageCacheOwnerId({ agentDir });
      await writeCachedProviderUsageSummary({
        agentDir,
        profileId,
        summary: {
          updatedAt: 200,
          providers: [
            {
              provider: "openai",
              displayName: "Codex",
              windows: [{ label: "5h", usedPercent: 80 }],
            },
          ],
        },
      });
      await writeCachedProviderUsageSummary({
        agentDir,
        profileId,
        summary: {
          updatedAt: 100,
          providers: [
            {
              provider: "openai",
              displayName: "Codex",
              windows: [{ label: "5h", usedPercent: 20 }],
            },
          ],
        },
      });

      await expect(
        readCachedProfileUsageState({ agentDir, provider: "openai", profileId }),
      ).resolves.toMatchObject({ updatedAt: 200, windows: [{ usedPercent: 80 }] });

      const database = openOpenClawAgentDatabase({
        agentId: ownerId,
        path: resolveProviderUsageCacheDatabasePath(agentDir),
      });
      const kysely = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
      const row = executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("cache_entries")
          .select("updated_at")
          .where("scope", "=", "provider-usage")
          .where("key", "=", "policy-state")
          .limit(1),
      ).rows[0];
      expect(row?.updated_at).toBe(200);
    });
  });

  it("persists one cached preflight alert claim across a database reopen", async () => {
    await withTempDir({ prefix: "openclaw-usage-cache-" }, async (agentDir) => {
      const profileId = "openai:pcg";
      const updatedAt = Date.UTC(2026, 2, 27, 12, 0, 0);
      const decision = {
        action: "warn",
        reason: "threshold",
        scope: "default",
        provider: "openai",
        profileId,
        selectionSource: "auto",
        matched: {
          kind: "warn",
          window: "5h",
          threshold: 20,
          remainingPercent: 15,
          usedPercent: 85,
        },
        updatedAt,
      } as const;

      await writeCachedProviderUsageSummary({
        agentDir,
        profileId,
        summary: {
          updatedAt,
          providers: [
            {
              provider: "openai",
              displayName: "Codex",
              windows: [{ label: "5h", usedPercent: 85 }],
              plan: "Plus",
            },
          ],
        },
      });

      clearRuntimeProviderUsageCacheSnapshots();
      const firstClaim = await claimCachedUsagePolicyAlert({
        agentDir,
        provider: "openai",
        profileId,
        surface: "preflightNotice",
        decision,
      });
      closeOpenClawAgentDatabasesForTest();
      clearRuntimeProviderUsageCacheSnapshots();
      const secondClaim = await claimCachedUsagePolicyAlert({
        agentDir,
        provider: "openai",
        profileId,
        surface: "preflightNotice",
        decision,
      });
      expect(firstClaim).toBe(true);
      expect(secondClaim).toBe(false);

      await writeCachedProviderUsageSummary({
        agentDir,
        profileId,
        summary: {
          updatedAt: updatedAt + 60_000,
          providers: [
            {
              provider: "openai",
              displayName: "Codex",
              windows: [{ label: "5h", usedPercent: 86 }],
              plan: "Plus",
            },
          ],
        },
      });

      await expect(
        claimCachedUsagePolicyAlert({
          agentDir,
          provider: "openai",
          profileId,
          surface: "preflightNotice",
          decision: {
            ...decision,
            updatedAt: updatedAt + 60_000,
            matched: {
              ...decision.matched,
              remainingPercent: 14,
              usedPercent: 86,
            },
          },
        }),
      ).resolves.toBe(true);

      clearRuntimeProviderUsageCacheSnapshots();
      await expect(
        claimCachedUsagePolicyAlert({
          agentDir,
          provider: "openai",
          profileId,
          surface: "preflightNotice",
          decision: {
            ...decision,
            updatedAt: updatedAt + 60_000,
            matched: {
              ...decision.matched,
              remainingPercent: 14,
              usedPercent: 86,
            },
          },
        }),
      ).resolves.toBe(false);
    });
  });

  it("persists an alert claim without fabricating a provider usage summary", async () => {
    await withTempDir({ prefix: "openclaw-usage-cache-" }, async (agentDir) => {
      const profileId = "openai:missing";
      const updatedAt = Date.UTC(2026, 2, 27, 12, 0, 0);
      const decision = {
        action: "warn",
        reason: "threshold",
        scope: "default",
        provider: "openai",
        profileId,
        selectionSource: "auto",
        matched: {
          kind: "warn",
          window: "5h",
          threshold: 20,
          remainingPercent: 15,
          usedPercent: 85,
        },
        updatedAt,
      } as const;

      await expect(
        claimCachedUsagePolicyAlert({
          agentDir,
          provider: "openai",
          profileId,
          surface: "preflightNotice",
          decision,
        }),
      ).resolves.toBe(true);

      closeOpenClawAgentDatabasesForTest();
      clearRuntimeProviderUsageCacheSnapshots();
      await expect(
        claimCachedUsagePolicyAlert({
          agentDir,
          provider: "openai",
          profileId,
          surface: "preflightNotice",
          decision,
        }),
      ).resolves.toBe(false);
      await expect(
        readCachedProviderUsageSummary({ agentDir, profileId, providers: ["openai"] }),
      ).resolves.toMatchObject({ providers: [] });
    });
  });
});
