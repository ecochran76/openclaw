import { describe, expect, it } from "vitest";
import {
  evaluateAutomationStopConditions,
  normalizeAutomationStopReason,
  resolveAutomationBudgetRemaining,
  resolveAutomationOutcomeStopReason,
} from "./stop-conditions.js";

describe("automation stop conditions", () => {
  it("stops at maxTurns", () => {
    expect(
      evaluateAutomationStopConditions({
        workerTurnsUsed: 6,
        maxTurns: 6,
        totalTokensUsed: 10,
        maxTokens: 100,
        elapsedSeconds: 10,
        maxDurationSeconds: 100,
      }),
    ).toEqual({
      shouldStop: true,
      reason: "max_turns",
      remaining: { turns: 0, tokens: 90, durationSeconds: 90 },
    });
  });

  it("stops at maxTokens", () => {
    expect(
      evaluateAutomationStopConditions({
        workerTurnsUsed: 2,
        maxTurns: 6,
        totalTokensUsed: 80_000,
        maxTokens: 80_000,
        elapsedSeconds: 10,
        maxDurationSeconds: 100,
      }),
    ).toEqual({
      shouldStop: true,
      reason: "max_tokens",
      remaining: { turns: 4, tokens: 0, durationSeconds: 90 },
    });
  });

  it("stops at maxDurationSeconds", () => {
    expect(
      evaluateAutomationStopConditions({
        workerTurnsUsed: 2,
        maxTurns: 6,
        totalTokensUsed: 10,
        maxTokens: 100,
        elapsedSeconds: 100,
        maxDurationSeconds: 100,
      }),
    ).toEqual({
      shouldStop: true,
      reason: "max_duration",
      remaining: { turns: 4, tokens: 90, durationSeconds: 0 },
    });
  });

  it("does not stop when still under budget", () => {
    expect(
      evaluateAutomationStopConditions({
        workerTurnsUsed: 2,
        maxTurns: 6,
        totalTokensUsed: 10,
        maxTokens: 100,
        elapsedSeconds: 10,
        maxDurationSeconds: 100,
      }),
    ).toEqual({
      shouldStop: false,
      remaining: { turns: 4, tokens: 90, durationSeconds: 90 },
    });
  });

  it("normalizes stop-reason aliases and outcome mapping", () => {
    expect(normalizeAutomationStopReason("approval_needed")).toBe("approval_required");
    expect(normalizeAutomationStopReason("worker_error")).toBe("error");
    expect(normalizeAutomationStopReason("approval_required")).toBe("approval_required");
    expect(
      resolveAutomationOutcomeStopReason({
        approvalRequired: true,
      }),
    ).toBe("approval_required");
    expect(resolveAutomationOutcomeStopReason({ errored: true })).toBe("error");
  });

  it("computes remaining budgets consistently", () => {
    expect(
      resolveAutomationBudgetRemaining({
        workerTurnsUsed: 9,
        maxTurns: 6,
        totalTokensUsed: 120,
        maxTokens: 100,
        elapsedSeconds: 250,
        maxDurationSeconds: 100,
      }),
    ).toEqual({
      turns: 0,
      tokens: 0,
      durationSeconds: 0,
    });
  });
});
