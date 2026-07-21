import { afterEach, describe, expect, it, vi } from "vitest";
import { getAutomationRun, resetAutomationRegistryForTests } from "./registry.js";
import {
  requestAutomationRunStop,
  resetAutomationRunnerForTests,
  startAutomationRunInBackground,
  waitForAutomationRunToSettle,
} from "./runner.js";
import { mapRunResultToWorkerTurnResult } from "./worker-result.js";

afterEach(() => {
  resetAutomationRunnerForTests();
  resetAutomationRegistryForTests();
});

function startRun(params: Parameters<typeof startAutomationRunInBackground>[0]) {
  const result = startAutomationRunInBackground(params);
  if (result.status !== "started") {
    throw new Error(`expected automation run to start, got ${result.status}`);
  }
  return result.run;
}

describe("automation runner", () => {
  it("enforces maxConcurrent across distinct active executions", async () => {
    let resolveFirst!: (value: { completed: true; outputText: string }) => void;
    const firstWorker = new Promise<{ completed: true; outputText: string }>((resolve) => {
      resolveFirst = resolve;
    });
    const first = startRun({
      requesterSessionKey: "agent:main:one",
      childSessionKey: "agent:main:subagent:auto-capacity-one",
      spec: { goal: "First task." },
      config: { agents: { defaults: { automation: { maxConcurrent: 1 } } } },
      deps: { runWorkerTurn: vi.fn(() => firstWorker) },
      runId: "auto_runner_capacity_one",
    });

    const second = startAutomationRunInBackground({
      requesterSessionKey: "agent:main:two",
      childSessionKey: "agent:main:subagent:auto-capacity-two",
      spec: { goal: "Second task." },
      config: { agents: { defaults: { automation: { maxConcurrent: 1 } } } },
      deps: { runWorkerTurn: vi.fn() },
      runId: "auto_runner_capacity_two",
    });

    expect(second).toEqual({
      status: "capacity",
      activeCount: 1,
      maxConcurrent: 1,
      activeRunIds: [first.runId],
    });
    expect(getAutomationRun("auto_runner_capacity_two")).toBeUndefined();

    resolveFirst({ completed: true, outputText: "Done." });
    await waitForAutomationRunToSettle(first.runId);
  });

  it("completes a run in one worker turn and delivers a turn update plus final summary", async () => {
    const deliverTurnUpdate = vi.fn();
    const deliverFinalSummary = vi.fn();
    const run = startRun({
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
      .mockResolvedValueOnce(
        mapRunResultToWorkerTurnResult({
          outputText: "on it",
          usage: { total_tokens: 200 },
        }),
      )
      .mockResolvedValueOnce(
        mapRunResultToWorkerTurnResult({
          outputText: "RESULT: completed\n- completed the task",
          usage: { total_tokens: 800 },
        }),
      );

    const run = startRun({
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
    expect(runWorkerTurn.mock.calls[1]?.[0]?.turnIndex).toBe(2);
    expect(getAutomationRun(run.runId)).toMatchObject({
      stopReason: "completed",
      workerTurnsUsed: 2,
      totalTokensUsed: 1000,
    });
  });

  it("does not retry an interim acknowledgement beyond the worker-turn cap", async () => {
    const runWorkerTurn = vi.fn().mockResolvedValue({ outputText: "on it" });
    const run = startRun({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:auto-cap",
      spec: { goal: "Finish the task.", stop: { maxTurns: 1 } },
      deps: { runWorkerTurn },
      runId: "auto_runner_cap",
      now: 1000,
    });

    await waitForAutomationRunToSettle(run.runId);

    expect(runWorkerTurn).toHaveBeenCalledOnce();
    expect(getAutomationRun(run.runId)).toMatchObject({
      stopReason: "max_turns",
      workerTurnsUsed: 1,
    });
  });

  it("stops at max duration while a worker call is still pending", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      let workerSignal: AbortSignal | undefined;
      let resolveWorker!: (value: { outputText: string }) => void;
      const deliverFinalSummary = vi.fn();
      const run = startRun({
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:main:subagent:auto-timeout",
        spec: { goal: "Finish the task.", stop: { maxDurationSeconds: 1 } },
        config: { agents: { defaults: { automation: { maxConcurrent: 1 } } } },
        deps: {
          runWorkerTurn: vi.fn((input) => {
            workerSignal = input.abortSignal;
            return new Promise<{ outputText: string }>((resolve) => {
              resolveWorker = resolve;
            });
          }),
          deliverFinalSummary,
          schedule: (task) => task(),
        },
        runId: "auto_runner_timeout",
      });

      await vi.advanceTimersByTimeAsync(1000);

      expect(getAutomationRun(run.runId)).toMatchObject({
        state: "stopped",
        stopReason: "max_duration",
        workerTurnsUsed: 1,
      });
      expect(workerSignal?.aborted).toBe(true);
      expect(workerSignal?.reason).toMatchObject({ name: "AutomationDurationExceededError" });
      expect(deliverFinalSummary).not.toHaveBeenCalled();
      expect(
        startAutomationRunInBackground({
          requesterSessionKey: "agent:main:main",
          childSessionKey: "agent:main:subagent:auto-timeout-replacement",
          spec: { goal: "Replacement task." },
          config: { agents: { defaults: { automation: { maxConcurrent: 1 } } } },
          deps: { runWorkerTurn: vi.fn() },
          runId: "auto_runner_timeout_replacement",
        }),
      ).toMatchObject({ status: "capacity", activeRunIds: [run.runId] });

      resolveWorker({ outputText: "Ignored after the deadline." });
      await waitForAutomationRunToSettle(run.runId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("permits the next turn before a one-second duration is fully elapsed", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const runWorkerTurn = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<{
              outputText: string;
              progressText: string;
              totalTokensUsedDelta: number;
            }>((resolve) => {
              setTimeout(
                () =>
                  resolve({
                    outputText: "First step complete.",
                    progressText: "First step complete.",
                    totalTokensUsedDelta: 0,
                  }),
                600,
              );
            }),
        )
        .mockImplementationOnce(
          (input) =>
            new Promise<{ outputText: string }>((resolve) => {
              input.abortSignal.addEventListener(
                "abort",
                () => resolve({ outputText: "Stopped at the deadline." }),
                { once: true },
              );
            }),
        );
      const run = startRun({
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:main:subagent:auto-subsecond-progress",
        spec: { goal: "Finish the task.", stop: { maxDurationSeconds: 1 } },
        deps: { runWorkerTurn, schedule: (task) => task() },
        runId: "auto_runner_subsecond_progress",
      });

      await vi.advanceTimersByTimeAsync(600);

      expect(runWorkerTurn).toHaveBeenCalledTimes(2);
      expect(runWorkerTurn.mock.calls[1]?.[0]?.remaining.durationSeconds).toBe(1);
      expect(getAutomationRun(run.runId)?.state).toBe("running");

      await vi.advanceTimersByTimeAsync(399);
      expect(getAutomationRun(run.runId)?.state).toBe("running");

      await vi.advanceTimersByTimeAsync(1);
      await waitForAutomationRunToSettle(run.runId);

      expect(getAutomationRun(run.runId)).toMatchObject({
        state: "stopped",
        stopReason: "max_duration",
        workerTurnsUsed: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a run when final delivery does not settle within its bound", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const deliverFinalSummary = vi.fn(() => {
        expect(getAutomationRun("auto_runner_delivery_timeout")?.state).toBe("running");
        return new Promise<void>(() => {});
      });
      const run = startRun({
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:main:subagent:auto-delivery-timeout",
        spec: { goal: "Finish the task." },
        config: { agents: { defaults: { automation: { announceTimeoutMs: 30_000 } } } },
        deps: {
          runWorkerTurn: vi.fn().mockResolvedValue({
            completed: true,
            outputText: "Done.",
          }),
          deliverFinalSummary,
          schedule: (task) => task(),
        },
        runId: "auto_runner_delivery_timeout",
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await waitForAutomationRunToSettle(run.runId);

      expect(deliverFinalSummary).toHaveBeenCalledOnce();
      expect(getAutomationRun(run.runId)).toMatchObject({
        state: "failed",
        stopReason: "error",
        finalSummaryText: expect.stringContaining("final summary delivery timed out"),
      });
      expect(getAutomationRun(run.runId)?.finalSummaryText).toContain("Done.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails within the remaining run duration when turn update delivery hangs", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const deliverTurnUpdate = vi.fn(() => new Promise<void>(() => {}));
      const run = startRun({
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:main:subagent:auto-update-timeout",
        spec: { goal: "Finish the task.", stop: { maxDurationSeconds: 1 } },
        deps: {
          runWorkerTurn: vi.fn().mockResolvedValue({
            completed: true,
            outputText: "Task complete.",
          }),
          deliverTurnUpdate,
          schedule: (task) => task(),
        },
        runId: "auto_runner_update_timeout",
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await waitForAutomationRunToSettle(run.runId);

      expect(deliverTurnUpdate).toHaveBeenCalledOnce();
      expect(getAutomationRun(run.runId)).toMatchObject({
        state: "failed",
        stopReason: "error",
        workerTurnsUsed: 1,
        finalSummaryText: expect.stringContaining("turn update delivery timed out"),
      });
      expect(getAutomationRun(run.runId)?.finalSummaryText).toContain("Task complete.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops promptly when requested while turn update delivery is pending", async () => {
    let markDeliveryStarted!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const deliverTurnUpdate = vi.fn(() => {
      markDeliveryStarted();
      return new Promise<void>(() => {});
    });
    const deliverFinalSummary = vi.fn();
    const run = startRun({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:auto-stop-update-delivery",
      spec: { goal: "Finish the task." },
      deps: {
        runWorkerTurn: vi.fn().mockResolvedValue({
          progressText: "First step complete.",
          outputText: "First step complete.",
        }),
        deliverTurnUpdate,
        deliverFinalSummary,
        schedule: (task) => task(),
      },
      runId: "auto_runner_stop_update_delivery",
    });

    await deliveryStarted;
    requestAutomationRunStop(run.runId);
    await waitForAutomationRunToSettle(run.runId);

    expect(getAutomationRun(run.runId)).toMatchObject({
      state: "stopped",
      stopReason: "stopped_by_user",
      workerTurnsUsed: 1,
    });
    expect(deliverTurnUpdate).toHaveBeenCalledOnce();
    expect(deliverFinalSummary).not.toHaveBeenCalled();
  });

  it("caps final delivery by the remaining run duration", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const deliverFinalSummary = vi.fn(() => new Promise<void>(() => {}));
      const run = startRun({
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:main:subagent:auto-final-deadline",
        spec: { goal: "Finish the task.", stop: { maxDurationSeconds: 1 } },
        config: { agents: { defaults: { automation: { announceTimeoutMs: 30_000 } } } },
        deps: {
          runWorkerTurn: vi.fn(
            () =>
              new Promise<{ completed: true; outputText: string }>((resolve) => {
                setTimeout(() => resolve({ completed: true, outputText: "Done." }), 900);
              }),
          ),
          deliverFinalSummary,
          schedule: (task) => task(),
        },
        runId: "auto_runner_final_deadline",
      });

      await vi.advanceTimersByTimeAsync(900);
      expect(deliverFinalSummary).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(100);
      await waitForAutomationRunToSettle(run.runId);

      expect(getAutomationRun(run.runId)).toMatchObject({
        state: "failed",
        stopReason: "error",
        finalSummaryText: expect.stringContaining("final summary delivery timed out"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops promptly when requested while final summary delivery is pending", async () => {
    let markDeliveryStarted!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const deliverFinalSummary = vi.fn(() => {
      markDeliveryStarted();
      return new Promise<void>(() => {});
    });
    const run = startRun({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:auto-stop-final-delivery",
      spec: { goal: "Finish the task." },
      deps: {
        runWorkerTurn: vi.fn().mockResolvedValue({ completed: true, outputText: "Done." }),
        deliverFinalSummary,
        schedule: (task) => task(),
      },
      runId: "auto_runner_stop_final_delivery",
    });

    await deliveryStarted;
    requestAutomationRunStop(run.runId);
    await waitForAutomationRunToSettle(run.runId);

    expect(getAutomationRun(run.runId)).toMatchObject({
      state: "stopped",
      stopReason: "stopped_by_user",
      workerTurnsUsed: 1,
    });
    expect(deliverFinalSummary).toHaveBeenCalledOnce();
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

    const run = startRun({
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

  it("continues after a progress turn that reports explicit zero usage", async () => {
    const deliverTurnUpdate = vi.fn();
    const runWorkerTurn = vi
      .fn()
      .mockResolvedValueOnce(
        mapRunResultToWorkerTurnResult({
          outputText: "RESULT: progress\nPrepared the next step.",
          usage: { total_tokens: 0 },
        }),
      )
      .mockResolvedValueOnce(
        mapRunResultToWorkerTurnResult({
          outputText: "RESULT: completed\nFinished the next step.",
          usage: { total_tokens: 250 },
        }),
      );

    const run = startRun({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:auto-zero-usage",
      spec: { goal: "Finish the task.", stop: { maxTurns: 3, maxTokens: 2_000 } },
      deps: { runWorkerTurn, deliverTurnUpdate },
      runId: "auto_runner_zero_usage",
      now: 1000,
    });

    await waitForAutomationRunToSettle(run.runId);

    expect(runWorkerTurn).toHaveBeenCalledTimes(2);
    expect(runWorkerTurn.mock.calls[1]?.[0]?.remaining.tokens).toBe(2_000);
    expect(deliverTurnUpdate).toHaveBeenCalledTimes(2);
    expect(getAutomationRun(run.runId)).toMatchObject({
      stopReason: "completed",
      workerTurnsUsed: 2,
      totalTokensUsed: 250,
    });
  });

  it.each([
    ["missing", undefined],
    ["non-finite", Number.NaN],
    ["negative", -1],
  ])("reserves the remaining token budget when worker usage is %s", async (_label, delta) => {
    const runWorkerTurn = vi.fn().mockResolvedValue({
      outputText: "Implemented the first half.",
      progressText: "Implemented the first half.",
      ...(delta === undefined ? {} : { totalTokensUsedDelta: delta }),
    });

    const run = startRun({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:auto-missing-usage",
      spec: { goal: "Finish the task.", stop: { maxTurns: 3, maxTokens: 2_000 } },
      deps: { runWorkerTurn },
      runId: "auto_runner_missing_usage",
      now: 1000,
    });

    await waitForAutomationRunToSettle(run.runId);

    expect(runWorkerTurn).toHaveBeenCalledTimes(1);
    expect(getAutomationRun(run.runId)).toMatchObject({
      stopReason: "max_tokens",
      workerTurnsUsed: 1,
      totalTokensUsed: 2_000,
    });
  });

  it("stops without starting a worker when its prompt consumes the remaining token budget", async () => {
    const runWorkerTurn = vi.fn();
    const run = startRun({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:auto-prompt-budget",
      spec: { goal: "Finish the task.", stop: { maxTurns: 3, maxTokens: 1 } },
      deps: { runWorkerTurn },
      runId: "auto_runner_prompt_budget",
      now: 1_000,
    });

    await waitForAutomationRunToSettle(run.runId);

    expect(runWorkerTurn).not.toHaveBeenCalled();
    expect(getAutomationRun(run.runId)).toMatchObject({
      stopReason: "max_tokens",
      workerTurnsUsed: 0,
      totalTokensUsed: 0,
    });
  });

  it("keeps structured completion authoritative over free-form remaining-work prose", async () => {
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

    const run = startRun({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:auto-5",
      spec: { goal: "Finish the task.", stop: { maxTurns: 3 } },
      deps: { runWorkerTurn, deliverTurnUpdate },
      runId: "auto_runner_5",
      now: 1000,
    });

    await waitForAutomationRunToSettle(run.runId);

    expect(runWorkerTurn).toHaveBeenCalledOnce();
    expect(getAutomationRun(run.runId)?.workerTurnsUsed).toBe(1);
    expect(getAutomationRun(run.runId)?.stopReason).toBe("completed");
    expect(deliverTurnUpdate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        updateText: expect.stringContaining("Result: completed"),
      }),
    );
  });

  it("honors a user stop request before starting the next worker turn", async () => {
    let stopIssued = false;
    const run = startRun({
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

  it("retains concurrency for an aborted worker until its promise settles", async () => {
    let workerSignal: AbortSignal | undefined;
    let resolveWorker!: (value: { outputText: string }) => void;
    const run = startRun({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:auto-stop-in-flight",
      spec: { goal: "Finish the task." },
      config: { agents: { defaults: { automation: { maxConcurrent: 1 } } } },
      deps: {
        runWorkerTurn: vi.fn((input) => {
          workerSignal = input.abortSignal;
          return new Promise<{ outputText: string }>((resolve) => {
            resolveWorker = resolve;
          });
        }),
        schedule: (task) => task(),
      },
      runId: "auto_runner_stop_in_flight",
    });

    expect(workerSignal?.aborted).toBe(false);
    requestAutomationRunStop(run.runId);
    expect(workerSignal?.aborted).toBe(true);
    const replacement = startAutomationRunInBackground({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:auto-after-stop",
      spec: { goal: "Replacement task." },
      config: { agents: { defaults: { automation: { maxConcurrent: 1 } } } },
      deps: { runWorkerTurn: vi.fn().mockResolvedValue({ completed: true, outputText: "Done." }) },
      runId: "auto_runner_after_stop",
    });
    expect(replacement).toEqual({
      status: "capacity",
      activeCount: 1,
      maxConcurrent: 1,
      activeRunIds: [run.runId],
    });
    await vi.waitFor(() => {
      expect(getAutomationRun(run.runId)).toMatchObject({
        state: "stopped",
        stopReason: "stopped_by_user",
        workerTurnsUsed: 1,
      });
    });

    resolveWorker({ outputText: "Ignored after cancellation." });
    await waitForAutomationRunToSettle(run.runId);
    const admittedReplacement = startAutomationRunInBackground({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:auto-after-stop",
      spec: { goal: "Replacement task." },
      config: { agents: { defaults: { automation: { maxConcurrent: 1 } } } },
      deps: { runWorkerTurn: vi.fn().mockResolvedValue({ completed: true, outputText: "Done." }) },
      runId: "auto_runner_after_stop",
    });
    expect(admittedReplacement.status).toBe("started");
    await waitForAutomationRunToSettle("auto_runner_after_stop");
  });
});
