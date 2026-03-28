import { describe, expect, it } from "vitest";
import { resolveCronAuthProfileSelectionResult } from "./auth-profile-selection.js";

describe("resolveCronAuthProfileSelectionResult", () => {
  it("returns a blocked cron result for usage-policy stop decisions", () => {
    const result = resolveCronAuthProfileSelectionResult({
      profileId: "openai-codex:default",
      source: "auto",
      blockedReason: {
        kind: "usage_policy_stop",
        message:
          "⚠️ Turn blocked by usage policy for openai-codex:default: stop threshold matched (5h 15% left). Use /profile to switch or adjust auth.usagePolicy.",
        decision: {
          action: "stop",
          reason: "threshold",
          scope: "default",
          provider: "openai-codex",
          profileId: "openai-codex:default",
          selectionSource: "auto",
          matched: {
            kind: "stop",
            window: "5h",
            threshold: 20,
            remainingPercent: 15,
            usedPercent: 85,
          },
        },
      },
    });

    expect(result).toEqual({
      blocked: true,
      error:
        "⚠️ Turn blocked by usage policy for openai-codex:default: stop threshold matched (5h 15% left). Use /profile to switch or adjust auth.usagePolicy.",
      logMessage:
        "⚠️ Turn blocked by usage policy for openai-codex:default: stop threshold matched (5h 15% left). Use /profile to switch or adjust auth.usagePolicy.",
    });
  });

  it("returns the switched profile id and warning message for usage-policy auto-switches", () => {
    const result = resolveCronAuthProfileSelectionResult({
      profileId: "openai-codex:backup",
      source: "auto",
      switchNotice: {
        fromProfileId: "openai-codex:default",
        toProfileId: "openai-codex:backup",
        message:
          "ℹ️ Usage policy switched auth profile from openai-codex:default to openai-codex:backup (switch threshold matched (5h 15% left)).",
        decision: {
          action: "switch",
          reason: "threshold",
          scope: "default",
          provider: "openai-codex",
          profileId: "openai-codex:default",
          selectionSource: "auto",
          matched: {
            kind: "switch",
            window: "5h",
            threshold: 20,
            remainingPercent: 15,
            usedPercent: 85,
          },
        },
      },
      usagePolicyDecision: {
        action: "allow",
        reason: "threshold",
        scope: "default",
        provider: "openai-codex",
        profileId: "openai-codex:backup",
        selectionSource: "auto",
      },
    });

    expect(result).toEqual({
      blocked: false,
      authProfileId: "openai-codex:backup",
      authProfileIdSource: "auto",
      logMessage:
        "ℹ️ Usage policy switched auth profile from openai-codex:default to openai-codex:backup (switch threshold matched (5h 15% left)).",
    });
  });
});
