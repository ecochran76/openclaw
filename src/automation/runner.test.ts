import { afterEach, describe, expect, it, vi } from "vitest";
import { getAutomationRun, resetAutomationRegistryForTests } from "./registry.js";
import {
  requestAutomationRunStop,
  resetAutomationRunnerForTests,
  startAutomationRunInBackground,
  waitForAutomationRunToSettle,
} from "./runner.js";

afterEach(() => {
  resetAutomationRunnerForTests();
  resetAutomationRegistryForTests();
});

describe("automation runner", () => {
  it("completes a run in one worker turn and delivers a turn update plus final summary", async () => {
    const deliverTurnUpdate = vi.fn();
    const deliverFinalSummary = vi.fn();
    const run = startAutomationRunInBackground({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:auto-1",
      spec: { goal: "Finish the agreed plan." },
      deps: {
        runWorkerTurn: vi.fn().mockResolvedValue({
          completed: true,
          outputText: "- updated hero copy\n- fixed CTA spacing",
          totalTokensUsedDelta: 1200,
        }),
        deliverTurnUpdate,
        deliverFinalSummary,
      },
      runId: "auto_runner_1",
      now: 1000,
    });

    await waitForAutomationRunToSettle(run.runId);

    const stopped = getAutomationRun(run.runId)!;
    expect(stopped.state).toBe("completed");
    expect(stopped.stopReason).toBe("completed");
    expect(stopped.workerTurnsUsed).toBe(1);
    expect(stopped.totalTokensUsed).toBe(1200);
    expect(deliverTurnUpdate).toHaveBeenCalledOnce();
    expect(deliverTurnUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        run: expect.objectContaining({ runId: "auto_runner_1", workerTurnsUsed: 1 }),
        updateText: expect.stringContaining("🤖 Automation turn"),
      }),
    );
    expect(deliverFinalSummary).toHaveBeenCalledOnce();
  });

  it("retries once when the first worker turn is only an interim acknowledgement", async () => {
    const runWorkerTurn = vi
      .fn()
      .mockResolvedValueOnce({ outputText: "on it" })
      .mockResolvedValueOnce({
        completed: true,
        outputText: "- completed the task",
        totalTokensUsedDelta: 800,
      });

    const run = startAutomationRunInBackground({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:auto-2",
      spec: { goal: "Finish the task." },
      deps: { runWorkerTurn },
      runId: "auto_runner_2",
      now: 1000,
    });

    await waitForAutomationRunToSettle(run.runId);

    expect(runWorkerTurn).toHaveBeenCalledTimes(2);
    expect(runWorkerTurn.mock.calls[1]?.[0]?.prompt).toContain(
      "Your previous response was only an acknowledgement",
    );
    expect(getAutomationRun(run.runId)?.stopReason).toBe("completed");
  });

  it("continues into a second worker turn when still under budget and not yet done", async () => {
    const runWorkerTurn = vi
      .fn()
      .mockResolvedValueOnce({
        outputText: "Implemented the first half.",
        progressText: "Implemented the first half.",
        totalTokensUsedDelta: 500,
      })
      .mockResolvedValueOnce({
        completed: true,
        outputText: "- implemented the second half",
        totalTokensUsedDelta: 700,
      });

    const run = startAutomationRunInBackground({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:auto-3",
      spec: { goal: "Finish the task.", stop: { maxTurns: 3 } },
      deps: { runWorkerTurn },
      runId: "auto_runner_3",
      now: 1000,
    });

    await waitForAutomationRunToSettle(run.runId);

    expect(runWorkerTurn).toHaveBeenCalledTimes(2);
    expect(getAutomationRun(run.runId)?.workerTurnsUsed).toBe(2);
    expect(getAutomationRun(run.runId)?.stopReason).toBe("completed");
  });

  it("keeps going when a completed result explicitly says work remains", async () => {
    const deliverTurnUpdate = vi.fn();
    const runWorkerTurn = vi
      .fn()
      .mockResolvedValueOnce({
        completed: true,
        outputText: [
          "RESULT: completed",
          "Implemented the doctor slice.",
          "",
          "Not started in this pass",
          "- planner summary scaffolding",
          "",
          "I left that as the next recommended implementation step.",
        ].join("\n"),
        totalTokensUsedDelta: 800,
      })
      .mockResolvedValueOnce({
        completed: true,
        outputText: "RESULT: completed\nImplemented the remaining planner slice.",
        totalTokensUsedDelta: 600,
      });

    const run = startAutomationRunInBackground({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:auto-5",
      spec: { goal: "Finish the task.", stop: { maxTurns: 3 } },
      deps: { runWorkerTurn, deliverTurnUpdate },
      runId: "auto_runner_5",
      now: 1000,
    });

    await waitForAutomationRunToSettle(run.runId);

    expect(runWorkerTurn).toHaveBeenCalledTimes(2);
    expect(getAutomationRun(run.runId)?.workerTurnsUsed).toBe(2);
    expect(getAutomationRun(run.runId)?.stopReason).toBe("completed");
    expect(deliverTurnUpdate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        updateText: expect.stringContaining("Result: progress"),
      }),
    );
  });

  it("honors a user stop request before starting the next worker turn", async () => {
    let stopIssued = false;
    const run = startAutomationRunInBackground({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:auto-4",
      spec: { goal: "Finish the task.", stop: { maxTurns: 3 } },
      deps: {
        runWorkerTurn: vi.fn().mockImplementation(async (input) => {
          if (input.turnIndex === 1 && !stopIssued) {
            stopIssued = true;
            requestAutomationRunStop("auto_runner_4");
            return { outputText: "First step done.", progressText: "First step done." };
          }
          return { completed: true, outputText: "- done" };
        }),
      },
      runId: "auto_runner_4",
      now: 1000,
    });

    await waitForAutomationRunToSettle(run.runId);

    const stopped = getAutomationRun(run.runId)!;
    expect(stopped.stopReason).toBe("stopped_by_user");
    expect(stopped.workerTurnsUsed).toBe(1);
  });
});
