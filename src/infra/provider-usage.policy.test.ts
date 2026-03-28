import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  canonicalizeUsageWindowLabel,
  evaluateUsagePolicyDecision,
  formatUsagePolicyDecisionDetail,
  formatUsagePolicyDecisionLine,
  isUsagePolicySurfaceEnabled,
  resolveUsagePolicyRefreshMinutes,
  resolveUsagePolicyRules,
  resolveUsagePolicyStaleAfterMinutes,
  type CachedProfileUsageState,
} from "./provider-usage.policy.js";

function makeConfig(
  usagePolicy: NonNullable<OpenClawConfig["auth"]>["usagePolicy"],
): OpenClawConfig {
  return {
    auth: {
      usagePolicy,
    },
  };
}

function makeUsage(overrides: Partial<CachedProfileUsageState> = {}): CachedProfileUsageState {
  return {
    provider: "openai-codex",
    profileId: "openai-codex:pcg",
    updatedAt: Date.UTC(2026, 2, 27, 12, 0, 0),
    windows: [
      { label: "5h", usedPercent: 70, resetAt: Date.UTC(2026, 2, 27, 14, 0, 0) },
      { label: "Week", usedPercent: 50, resetAt: Date.UTC(2026, 2, 30, 12, 0, 0) },
    ],
    ...overrides,
  };
}

const freshNow = Date.UTC(2026, 2, 27, 12, 5, 0);

describe("provider-usage.policy", () => {
  it("canonicalizes common usage window aliases", () => {
    expect(canonicalizeUsageWindowLabel(" Week ")).toBe("1w");
    expect(canonicalizeUsageWindowLabel("daily")).toBe("1d");
    expect(canonicalizeUsageWindowLabel("5h")).toBe("5h");
  });

  it("resolves profile rules ahead of provider and default rules", () => {
    const resolved = resolveUsagePolicyRules({
      config: makeConfig({
        enabled: true,
        defaults: {
          warn: [{ window: "5h", remainingPercentLte: 20 }],
        },
        providers: {
          "openai-codex": {
            warn: [{ window: "5h", remainingPercentLte: 15 }],
          },
        },
        profiles: {
          "openai-codex:pcg": {
            stop: [{ window: "5h", remainingPercentLte: 10 }],
          },
        },
      }),
      provider: "OPENAI-CODEX",
      profileId: "openai-codex:pcg",
    });

    expect(resolved.scope).toBe("profile");
    expect(resolved.rules?.stop).toEqual([{ window: "5h", remainingPercentLte: 10 }]);
  });

  it("uses default refresh and stale-after values when config is absent or invalid", () => {
    expect(resolveUsagePolicyRefreshMinutes()).toBe(15);
    expect(resolveUsagePolicyStaleAfterMinutes()).toBe(20);
    expect(
      resolveUsagePolicyRefreshMinutes(
        makeConfig({
          enabled: true,
          refreshMinutes: -1,
        }),
      ),
    ).toBe(15);
    expect(
      resolveUsagePolicyStaleAfterMinutes(
        makeConfig({
          enabled: true,
          staleAfterMinutes: 0,
        }),
      ),
    ).toBe(20);
  });

  it("returns unsupported when usage policy is disabled", () => {
    const decision = evaluateUsagePolicyDecision({
      config: makeConfig({
        enabled: false,
      }),
      provider: "openai-codex",
      profileId: "openai-codex:pcg",
      usage: makeUsage(),
    });

    expect(decision.action).toBe("allow");
    expect(decision.reason).toBe("unsupported");
    expect(decision.scope).toBe("none");
  });

  it("returns no-data when no cached usage snapshot is available", () => {
    const decision = evaluateUsagePolicyDecision({
      config: makeConfig({
        enabled: true,
        defaults: {
          warn: [{ window: "5h", remainingPercentLte: 20 }],
        },
      }),
      provider: "openai-codex",
      profileId: "openai-codex:pcg",
    });

    expect(decision.action).toBe("allow");
    expect(decision.reason).toBe("no-data");
    expect(decision.scope).toBe("default");
  });

  it("treats stale cached usage according to staleBehavior", () => {
    const now = Date.UTC(2026, 2, 27, 13, 0, 0);
    const decision = evaluateUsagePolicyDecision({
      config: makeConfig({
        enabled: true,
        staleAfterMinutes: 20,
        staleBehavior: "warn",
        defaults: {
          warn: [{ window: "5h", remainingPercentLte: 20 }],
        },
      }),
      provider: "openai-codex",
      profileId: "openai-codex:pcg",
      usage: makeUsage({
        updatedAt: now - 21 * 60_000,
      }),
      now,
    });

    expect(decision.action).toBe("warn");
    expect(decision.reason).toBe("stale");
    expect(decision.message).toContain("stale");
  });

  it("lets stop thresholds outrank switch and warn thresholds", () => {
    const decision = evaluateUsagePolicyDecision({
      config: makeConfig({
        enabled: true,
        defaults: {
          warn: [{ window: "5h", remainingPercentLte: 20 }],
          switch: [{ window: "5h", remainingPercentLte: 15 }],
          stop: [{ window: "5h", remainingPercentLte: 10 }],
        },
      }),
      provider: "openai-codex",
      profileId: "openai-codex:pcg",
      usage: makeUsage({
        windows: [{ label: "5h", usedPercent: 92 }],
      }),
      now: freshNow,
    });

    expect(decision.action).toBe("stop");
    expect(decision.reason).toBe("threshold");
    expect(decision.matched).toMatchObject({
      kind: "stop",
      window: "5h",
      threshold: 10,
      remainingPercent: 8,
    });
  });

  it("suppresses switch for manual profile selections by default", () => {
    const decision = evaluateUsagePolicyDecision({
      config: makeConfig({
        enabled: true,
        defaults: {
          warn: [{ window: "5h", remainingPercentLte: 30 }],
          switch: [{ window: "5h", remainingPercentLte: 20 }],
        },
      }),
      provider: "openai-codex",
      profileId: "openai-codex:pcg",
      selectionSource: "user",
      usage: makeUsage({
        windows: [{ label: "5h", usedPercent: 85 }],
      }),
      now: freshNow,
    });

    expect(decision.action).toBe("warn");
    expect(decision.matched).toMatchObject({
      kind: "warn",
      threshold: 30,
      remainingPercent: 15,
    });
  });

  it("suppresses default-scope stop for manual profile selections by default", () => {
    const decision = evaluateUsagePolicyDecision({
      config: makeConfig({
        enabled: true,
        defaults: {
          stop: [{ window: "5h", remainingPercentLte: 20 }],
          warn: [{ window: "5h", remainingPercentLte: 30 }],
        },
      }),
      provider: "openai-codex",
      profileId: "openai-codex:pcg",
      selectionSource: "user",
      usage: makeUsage({
        windows: [{ label: "5h", usedPercent: 85 }],
      }),
      now: freshNow,
    });

    expect(decision.action).toBe("warn");
    expect(decision.matched).toMatchObject({
      kind: "warn",
      threshold: 30,
      remainingPercent: 15,
    });
  });

  it("still honors profile-scoped stop for manual profile selections", () => {
    const decision = evaluateUsagePolicyDecision({
      config: makeConfig({
        enabled: true,
        profiles: {
          "openai-codex:pcg": {
            stop: [{ window: "5h", remainingPercentLte: 20 }],
          },
        },
      }),
      provider: "openai-codex",
      profileId: "openai-codex:pcg",
      selectionSource: "user",
      usage: makeUsage({
        windows: [{ label: "5h", usedPercent: 85 }],
      }),
      now: freshNow,
    });

    expect(decision.action).toBe("stop");
    expect(decision.matched).toMatchObject({
      kind: "stop",
      threshold: 20,
      remainingPercent: 15,
    });
  });

  it("matches 1w rules against week-labeled windows", () => {
    const decision = evaluateUsagePolicyDecision({
      config: makeConfig({
        enabled: true,
        defaults: {
          warn: [{ window: "1w", remainingPercentLte: 60 }],
        },
      }),
      provider: "openai-codex",
      profileId: "openai-codex:pcg",
      usage: makeUsage({
        windows: [{ label: "Week", usedPercent: 50 }],
      }),
      now: freshNow,
    });

    expect(decision.action).toBe("warn");
    expect(decision.matched).toMatchObject({
      kind: "warn",
      window: "Week",
      threshold: 60,
      remainingPercent: 50,
    });
  });

  it("uses status/sessionStatus surfaces by default and keeps preflight opt-in", () => {
    const config = makeConfig({
      enabled: true,
      defaults: {
        warn: [{ window: "5h", remainingPercentLte: 20 }],
      },
    });
    expect(
      isUsagePolicySurfaceEnabled({
        config,
        provider: "openai-codex",
        profileId: "openai-codex:pcg",
        surface: "status",
      }),
    ).toBe(true);
    expect(
      isUsagePolicySurfaceEnabled({
        config,
        provider: "openai-codex",
        profileId: "openai-codex:pcg",
        surface: "sessionStatus",
      }),
    ).toBe(true);
    expect(
      isUsagePolicySurfaceEnabled({
        config,
        provider: "openai-codex",
        profileId: "openai-codex:pcg",
        surface: "preflightNotice",
      }),
    ).toBe(false);
  });

  it("formats threshold and stale decisions for status surfaces", () => {
    const thresholdDecision = evaluateUsagePolicyDecision({
      config: makeConfig({
        enabled: true,
        defaults: {
          switch: [{ window: "5h", remainingPercentLte: 20 }],
        },
      }),
      provider: "openai-codex",
      profileId: "openai-codex:pcg",
      usage: makeUsage({
        windows: [{ label: "5h", usedPercent: 85 }],
      }),
      now: freshNow,
    });
    expect(formatUsagePolicyDecisionDetail(thresholdDecision)).toBe(
      "switch threshold matched (5h 15% left)",
    );
    expect(formatUsagePolicyDecisionLine(thresholdDecision)).toBe(
      "⚠️ Usage policy: switch threshold matched (5h 15% left)",
    );

    const staleDecision = evaluateUsagePolicyDecision({
      config: makeConfig({
        enabled: true,
        staleAfterMinutes: 20,
        staleBehavior: "allow",
        defaults: {
          warn: [{ window: "5h", remainingPercentLte: 20 }],
        },
      }),
      provider: "openai-codex",
      profileId: "openai-codex:pcg",
      usage: makeUsage(),
      now: Date.UTC(2026, 2, 27, 12, 30, 1),
    });
    expect(formatUsagePolicyDecisionDetail(staleDecision)).toBe("usage data is stale (> 20m)");
    expect(formatUsagePolicyDecisionLine(staleDecision)).toBe(
      "⚠️ Usage policy: usage data is stale (> 20m)",
    );

    expect(
      formatUsagePolicyDecisionLine({
        ...thresholdDecision,
        action: "warn",
        noSwitchTarget: true,
      }),
    ).toBe(
      "⚠️ Usage policy: warning threshold matched (5h 15% left) No eligible auth profile is available for automatic switching.",
    );
  });
});
