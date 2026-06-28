import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import {
  clearRuntimeProviderUsageCacheSnapshots,
  getCachedProfileUsageState,
  loadProviderUsageSummaryWithCache,
  markCachedUsagePolicyAlertSent,
  readCachedProfileUsageState,
  readCachedProviderUsageSummary,
  resolveProviderUsageCachePath,
  shouldSendCachedUsagePolicyAlert,
  writeCachedProviderUsageSummary,
} from "./provider-usage.cache.js";

describe("provider-usage.cache", () => {
  beforeEach(() => {
    clearRuntimeProviderUsageCacheSnapshots();
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

      expect(resolveProviderUsageCachePath(agentDir)).toContain("provider-usage-cache.json");

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

  it("dedupes cached preflight alerts until the usage snapshot refreshes", async () => {
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

      await expect(
        shouldSendCachedUsagePolicyAlert({
          agentDir,
          provider: "openai",
          profileId,
          surface: "preflightNotice",
          decision,
        }),
      ).resolves.toBe(true);

      await markCachedUsagePolicyAlertSent({
        agentDir,
        provider: "openai",
        profileId,
        surface: "preflightNotice",
        decision,
      });

      await expect(
        shouldSendCachedUsagePolicyAlert({
          agentDir,
          provider: "openai",
          profileId,
          surface: "preflightNotice",
          decision,
        }),
      ).resolves.toBe(false);

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

      const refreshed = await readCachedProfileUsageState({
        agentDir,
        provider: "openai",
        profileId,
      });
      expect(refreshed?.lastAlertAt).toBeTruthy();

      await expect(
        shouldSendCachedUsagePolicyAlert({
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
    });
  });
});
