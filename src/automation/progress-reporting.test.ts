import { describe, expect, it } from "vitest";
import {
  resolveAutomationFinalSummaryCandidate,
  resolveAutomationTurnOutcome,
  resolveAutomationTurnUpdateText,
  summarizeAutomationTurnProgress,
} from "./progress-reporting.js";
import type { AutomationRunRecord } from "./types.js";

const baseRun: AutomationRunRecord = {
  runId: "auto_000010",
  requesterSessionKey: "agent:dev-openclaw:main",
  childSessionKey: "agent:dev-openclaw:subagent:auto-test",
  goal: "Finish the roadmap slice.",
  state: "running",
  stop: { maxTurns: 5, maxTokens: 40_000, maxDurationSeconds: 1_200 },
  stopReason: null,
  createdAt: 0,
  startedAt: 0,
  updatedAt: 0,
  workerTurnsUsed: 1,
  totalTokensUsed: 10_000,
  lastProgressText: "previous progress",
  finalSummaryText: "previous final summary",
};

describe("automation progress reporting", () => {
  it("summarizes turn progress from progress text first", () => {
    expect(
      summarizeAutomationTurnProgress({
        outputText: "output",
        progressText: " progress ",
      }),
    ).toBe("progress");
  });

  it("truncates long progress summaries", () => {
    const summary = summarizeAutomationTurnProgress({ outputText: "x".repeat(400) });

    expect(summary).toHaveLength(280);
    expect(summary?.endsWith("...")).toBe(true);
  });

  it("resolves final summary and turn update candidates in delivery order", () => {
    expect(
      resolveAutomationFinalSummaryCandidate({
        record: baseRun,
        result: { finalSummaryText: " final ", outputText: " output " },
      }),
    ).toBe("final");
    expect(
      resolveAutomationTurnUpdateText({
        record: baseRun,
        result: { finalSummaryText: " final ", outputText: " output " },
      }),
    ).toBe("output");
  });

  it("treats self-reported unfinished completed turns as progress", () => {
    expect(
      resolveAutomationTurnOutcome({
        explicitStopReason: "completed",
        finalSummaryCandidate: "Not started in this pass: planner summary scaffolding.",
      }),
    ).toEqual({
      outcome: "progress",
      selfReportedIncomplete: true,
    });
  });

  it("keeps explicit terminal outcomes when the summary is complete", () => {
    expect(
      resolveAutomationTurnOutcome({
        explicitStopReason: "completed",
        finalSummaryCandidate: "Implemented and tested the slice.",
      }),
    ).toEqual({
      outcome: "completed",
      selfReportedIncomplete: false,
    });
  });
});
