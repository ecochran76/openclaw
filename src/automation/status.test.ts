import { describe, expect, it } from "vitest";
import { buildAutomationStatusView } from "./registry.js";
import {
  buildAutomationCompactStatusLine,
  buildAutomationFinalSummaryText,
  buildAutomationListText,
  buildAutomationStatusText,
} from "./status.js";
import type { AutomationRunRecord } from "./types.js";

const baseRun: AutomationRunRecord = {
  runId: "auto_000003",
  requesterSessionKey: "agent:dev-openclaw:main",
  childSessionKey: "agent:dev-openclaw:subagent:9f6c",
  label: "landing-page-polish",
  goal: "Finish the agreed landing page polish plan.",
  model: "codex-default",
  thinking: "medium",
  state: "running",
  stop: { maxTurns: 6, maxTokens: 80_000, maxDurationSeconds: 1_800 },
  stopReason: null,
  createdAt: 0,
  startedAt: 0,
  updatedAt: 374_000,
  workerTurnsUsed: 2,
  totalTokensUsed: 18_420,
  lastProgressText: "updated hero copy and CTA spacing; tests passing",
};

describe("automation status formatting", () => {
  it("formats /automation list output", () => {
    const text = buildAutomationListText({
      runs: [
        baseRun,
        {
          ...baseRun,
          runId: "auto_000002",
          label: "docs-audit",
          state: "completed",
          stopReason: "completed",
          workerTurnsUsed: 4,
          totalTokensUsed: 31_240,
          createdAt: -1000,
          updatedAt: 728_000,
          endedAt: 728_000,
        },
      ],
      now: 374_000,
    });

    expect(text).toContain("🤖 Automation runs");
    expect(text).toContain("1. landing-page-polish — running — 2/6 turns — 6m 14s");
    expect(text).toContain("2. docs-audit — stopped (completed) — 4/6 turns");
  });

  it("formats /automation status output", () => {
    const text = buildAutomationStatusText({ run: baseRun, now: 374_000, index: 3 });

    expect(text).toContain("🤖 Automation status");
    expect(text).toContain("Run: #3 (landing-page-polish)");
    expect(text).toContain("State: running");
    expect(text).toContain("Goal: Finish the agreed landing page polish plan.");
    expect(text).toContain("Turns: 2 / 6 worker turns");
    expect(text).toContain("Tokens: 18.4k / 80k");
    expect(text).toContain("Duration: 6m 14s / 30m 0s");
    expect(text).toContain("Last progress: updated hero copy and CTA spacing; tests passing");
    expect(text).not.toContain("Pending steer:");
    expect(text).toContain(
      "Next stop guards: max_turns, max_tokens, max_duration, approval_required",
    );
    expect(text).toContain("Session: agent:dev-openclaw:subagent:9f6c");
  });

  it("formats final summary output", () => {
    const stopped = buildAutomationStatusView({
      record: {
        ...baseRun,
        state: "completed",
        stopReason: "completed",
        workerTurnsUsed: 4,
        totalTokensUsed: 31_240,
        endedAt: 728_000,
        finalSummaryText:
          "- updated hero copy\n- fixed CTA spacing and footer alignment\n- added responsive tests",
      },
      now: 728_000,
    });

    const text = buildAutomationFinalSummaryText({ run: stopped, index: 3 });
    expect(text).toContain("🤖 Automation finished");
    expect(text).toContain("Run: #3 (landing-page-polish)");
    expect(text).toContain("Reason: completed");
    expect(text).toContain("Done:");
    expect(text).toContain("- updated hero copy");
    expect(text).toContain("Usage: 4 worker turns · 31.2k tokens · 12m 8s");
  });

  it("formats a compact /status embedding line", () => {
    const line = buildAutomationCompactStatusLine({ run: baseRun, now: 374_000, index: 3 });
    expect(line).toBe("🤖 Automation: #3 (landing-page-polish) · running · 2/6 turns · 6m 14s");
  });

  it("shows pending steer guidance in status views", () => {
    const steeredRun = {
      ...baseRun,
      pendingOperatorNote: "Focus on tests first.",
    };
    const text = buildAutomationStatusText({ run: steeredRun, now: 374_000, index: 3 });
    const line = buildAutomationCompactStatusLine({ run: steeredRun, now: 374_000, index: 3 });

    expect(text).toContain("Pending steer: Focus on tests first.");
    expect(line).toContain("steer pending");
  });
});
