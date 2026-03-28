import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitForAutomationRunToSettle } from "../../automation/runner.js";
import { createAutomationTool, resetAutomationToolStateForTests } from "./automation-tool.js";

function getDetails(result: { details?: unknown }): Record<string, unknown> {
  return (result.details as Record<string, unknown> | undefined) ?? {};
}

function getStringDetail(details: Record<string, unknown>, key: string): string {
  const value = details[key] as string | undefined;
  return value ?? "";
}

describe("automation tool", () => {
  beforeEach(() => {
    resetAutomationToolStateForTests();
  });

  it("describes itself as the tool for /automation-style bounded runs", () => {
    const tool = createAutomationTool({ agentSessionKey: "agent:main:main" });

    expect(tool.description).toContain("Use this for /automation-style requests");
    expect(tool.description).toContain("Do not emulate /automation with sessions_spawn or ACP");
  });

  it("starts a run and reports status/list output", async () => {
    const executeWorkerTurn = vi.fn().mockResolvedValue({
      outputText: "RESULT: completed\nDraft delivered.",
      completed: true,
      totalTokensUsedDelta: 321,
    });
    const deliverFinalSummary = vi.fn().mockResolvedValue(undefined);
    const tool = createAutomationTool(
      { agentSessionKey: "agent:main:main" },
      { executeWorkerTurn, deliverFinalSummary },
    );

    const runResult = await tool.execute("call-run", {
      action: "run",
      goal: "Prepare the draft",
      label: "Draft run",
    });
    const runDetails = getDetails(runResult);
    const runId = getStringDetail(runDetails, "runId");
    expect(runDetails).toMatchObject({
      status: "accepted",
      runId,
      childSessionKey: expect.stringContaining("agent:main:subagent:auto-"),
    });

    await waitForAutomationRunToSettle(runId);

    const statusResult = await tool.execute("call-status", { action: "status", runId });
    const statusDetails = getDetails(statusResult);
    expect(statusDetails).toMatchObject({ status: "ok", runId });
    expect(getStringDetail(statusDetails, "text")).toContain("Reason: completed");

    const listResult = await tool.execute("call-list", { action: "list" });
    const listDetails = getDetails(listResult);
    expect(listDetails).toMatchObject({ status: "ok" });
    expect(getStringDetail(listDetails, "text")).toContain("Draft run");

    expect(executeWorkerTurn).toHaveBeenCalledTimes(1);
    expect(deliverFinalSummary).toHaveBeenCalledTimes(1);
    expect(deliverFinalSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        summaryText: expect.stringContaining("Automation finished"),
      }),
    );
  });

  it("enforces the configured concurrency cap", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executeWorkerTurn = vi.fn().mockImplementation(async () => {
      await pending;
      return { outputText: "RESULT: completed\nDone.", completed: true };
    });

    const tool = createAutomationTool(
      {
        agentSessionKey: "agent:main:main",
        config: { agents: { defaults: { automation: { maxConcurrent: 1 } } } } as never,
      },
      { executeWorkerTurn },
    );

    const first = await tool.execute("call-run-1", { action: "run", goal: "Task one" });
    const firstRunId = getStringDetail(getDetails(first), "runId");
    const second = await tool.execute("call-run-2", { action: "run", goal: "Task two" });

    expect(getDetails(second)).toMatchObject({
      status: "error",
      error: expect.stringContaining("concurrency limit reached"),
    });

    release?.();
    await waitForAutomationRunToSettle(firstRunId);
  });

  it("stores a pending steer note on an active run", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executeWorkerTurn = vi.fn().mockImplementation(async () => {
      await pending;
      return {
        outputText: "RESULT: progress\nPartial work saved.",
        progressText: "Partial work saved.",
      };
    });

    const tool = createAutomationTool(
      { agentSessionKey: "agent:main:main" },
      { executeWorkerTurn },
    );
    const runResult = await tool.execute("call-run", { action: "run", goal: "Long task" });
    const runId = getStringDetail(getDetails(runResult), "runId");

    const steerResult = await tool.execute("call-steer", {
      action: "steer",
      runId,
      message: "Focus on tests first.",
    });
    expect(getStringDetail(getDetails(steerResult), "text")).toContain(
      "Pending steer: Focus on tests first.",
    );

    release?.();
    await waitForAutomationRunToSettle(runId);
  });

  it("marks a run for stop and reports the stopped status after the active turn settles", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executeWorkerTurn = vi.fn().mockImplementation(async () => {
      await pending;
      return {
        outputText: "RESULT: progress\nPartial work saved.",
        progressText: "Partial work saved.",
      };
    });

    const tool = createAutomationTool(
      { agentSessionKey: "agent:main:main" },
      { executeWorkerTurn },
    );
    const runResult = await tool.execute("call-run", { action: "run", goal: "Long task" });
    const runId = getStringDetail(getDetails(runResult), "runId");

    const stopResult = await tool.execute("call-stop", { action: "stop", runId });
    expect(getDetails(stopResult)).toMatchObject({ status: "ok", runId });

    release?.();
    await waitForAutomationRunToSettle(runId);

    const statusResult = await tool.execute("call-status", { action: "status", runId });
    expect(getStringDetail(getDetails(statusResult), "text")).toContain("Reason: stopped by user");
  });
});
