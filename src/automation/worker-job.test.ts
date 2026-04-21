import { describe, expect, it } from "vitest";
import { buildAutomationWorkerControlPrompt, buildAutomationWorkerJob } from "./worker-job.js";

describe("automation worker job", () => {
  it("wraps worker prompts with the automation control-line contract", () => {
    const prompt = buildAutomationWorkerControlPrompt("Finish the slice.");

    expect(prompt).toContain("Finish the slice.");
    expect(prompt).toContain("RESULT: completed");
    expect(prompt).toContain("RESULT: progress");
    expect(prompt).toContain("RESULT: approval_required");
    expect(prompt).toContain("First line must be exactly one of");
  });

  it("builds isolated cron-compatible worker jobs", () => {
    const job = buildAutomationWorkerJob(
      {
        runId: "auto_000123",
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:main:subagent:auto-test",
        goal: "Finish the slice.",
        label: "  Roadmap slice  ",
        model: "gpt-5.4",
        thinking: "medium",
        stop: { maxTurns: 5, maxTokens: 40_000, maxDurationSeconds: 1_200 },
        turnIndex: 2,
        isContinuation: true,
        prompt: "Continue.",
        remaining: { turns: 3, tokens: 30_000, durationSeconds: 600 },
      },
      1_000,
    );

    expect(job).toMatchObject({
      id: "automation-auto_000123-2",
      sessionKey: "agent:main:subagent:auto-test",
      name: "Roadmap slice",
      enabled: true,
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
      schedule: { kind: "at", at: "1970-01-01T00:00:01.000Z" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        model: "gpt-5.4",
        thinking: "medium",
        timeoutSeconds: 0,
      },
      delivery: { mode: "none" },
      state: {},
    });
    expect(job.payload.message).toContain("Continue.");
    expect(job.payload.message).toContain("Return format requirements:");
  });
});
