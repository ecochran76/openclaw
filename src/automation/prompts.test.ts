import { describe, expect, it } from "vitest";
import {
  buildAutomationContinuationPrompt,
  buildAutomationInitialPrompt,
  buildAutomationInterimAckFollowupPrompt,
} from "./prompts.js";

describe("automation prompts", () => {
  it("initial prompt includes goal and deterministic rules", () => {
    const prompt = buildAutomationInitialPrompt({
      goal: "Finish the agreed landing page polish plan.",
      stop: { maxTurns: 6, maxTokens: 80_000, maxDurationSeconds: 1_800 },
    });

    expect(prompt).toContain("Automation run.");
    expect(prompt).toContain("Goal: Finish the agreed landing page polish plan.");
    expect(prompt).toContain("Bounds: maxTurns=6, maxTokens=80000, maxDurationSeconds=1800");
    expect(prompt).toContain("Do not send an interim acknowledgement.");
    expect(prompt).toContain(
      "If you need human approval for a consequential action, stop and say so.",
    );
  });

  it("continuation prompt includes remaining budgets and steering note", () => {
    const prompt = buildAutomationContinuationPrompt({
      goal: "Finish the agreed landing page polish plan.",
      completedSoFar: "updated hero copy",
      latestResult: "tests are passing",
      remaining: { turns: 4, tokens: 61_580, durationSeconds: 1_426 },
      steeringNote: "Keep the CTA copy conservative.",
    });

    expect(prompt).toContain("Continue the same automation run.");
    expect(prompt).toContain("Original goal: Finish the agreed landing page polish plan.");
    expect(prompt).toContain("Completed so far: updated hero copy");
    expect(prompt).toContain("Latest result: tests are passing");
    expect(prompt).toContain("Remaining budgets: turns=4, tokens=61580, duration=23m 46s");
    expect(prompt).toContain("Operator note: Keep the CTA copy conservative.");
    expect(prompt).toContain("stop because approval is needed");
  });

  it("interim-ack follow-up prompt is distinct and focused", () => {
    const prompt = buildAutomationInterimAckFollowupPrompt();
    expect(prompt).toContain("only an acknowledgement");
    expect(prompt).toContain("Do not send a status update like 'on it'.");
    expect(prompt).toContain("a clear blocker");
    expect(prompt).toContain("approval is required");
  });
});
