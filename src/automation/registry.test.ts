import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  buildAutomationStatusView,
  clearAutomationRunPendingOperatorNote,
  createAutomationRunRecord,
  getAutomationRun,
  listAutomationRunsForRequester,
  reconcileAutomationRunsForGatewayStartup,
  recordAutomationRunWorkerTurn,
  resetAutomationRegistryProcessStateForTests,
  resetAutomationRegistryForTests,
  resolveAutomationRunSelector,
  startAutomationRun,
  setAutomationRunPendingOperatorNote,
  stopAutomationRun,
  updateAutomationRun,
} from "./registry.js";

afterEach(() => {
  resetAutomationRegistryForTests();
});

describe("automation registry", () => {
  it("creates a run record with normalized stop defaults", () => {
    const record = createAutomationRunRecord({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:auto-1",
      spec: { goal: "Finish the agreed plan." },
      now: 1_000,
      runId: "auto_test_1",
    });

    expect(record.runId).toBe("auto_test_1");
    expect(record.state).toBe("queued");
    expect(record.stop).toEqual({
      maxTurns: 6,
      maxTokens: 80_000,
      maxDurationSeconds: 1_800,
    });
  });

  it("lists runs for a requester and resolves exact ids or #index selectors", () => {
    createAutomationRunRecord({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "child-1",
      spec: { goal: "Older run", label: "docs-audit" },
      now: 1_000,
      runId: "auto_old",
    });
    createAutomationRunRecord({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "child-2",
      spec: { goal: "Newer run", label: "landing-page-polish" },
      now: 2_000,
      runId: "auto_new",
    });

    const runs = listAutomationRunsForRequester("agent:main:main");
    expect(runs.map((record) => record.runId)).toEqual(["auto_new", "auto_old"]);
    expect(
      resolveAutomationRunSelector({ requesterSessionKey: "agent:main:main", selector: "auto_old" })
        ?.runId,
    ).toBe("auto_old");
    expect(
      resolveAutomationRunSelector({ requesterSessionKey: "agent:main:main", selector: "#1" })
        ?.runId,
    ).toBe("auto_new");
    expect(
      resolveAutomationRunSelector({ requesterSessionKey: "agent:main:main", selector: "#2" })
        ?.runId,
    ).toBe("auto_old");
    for (const selector of ["#1junk", "#1.5", "#-1", "#"]) {
      expect(
        resolveAutomationRunSelector({ requesterSessionKey: "agent:main:main", selector }),
      ).toBe(undefined);
    }
  });

  it("updates counters and derives a normalized status view", () => {
    const record = createAutomationRunRecord({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "child-1",
      spec: {
        goal: "Run work",
        stop: { maxTurns: 8, maxTokens: 100_000, maxDurationSeconds: 600 },
      },
      now: 1_000,
      runId: "auto_status",
    });
    startAutomationRun(record.runId, { now: 2_000 });
    updateAutomationRun(
      record.runId,
      {
        workerTurnsUsed: 2,
        totalTokensUsed: 18_420,
        lastProgressText: "updated hero copy and CTA spacing; tests passing",
      },
      { now: 374_000 },
    );

    const view = buildAutomationStatusView({
      record: getAutomationRun(record.runId)!,
      now: 376_000,
    });
    expect(view.workerTurnsUsed).toBe(2);
    expect(view.totalTokensUsed).toBe(18_420);
    expect(view.elapsedSeconds).toBe(374);
    expect(view.lastProgressText).toContain("updated hero copy");
  });

  it("clears only the pending operator note captured by the completed turn", () => {
    const record = createAutomationRunRecord({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "child-1",
      spec: { goal: "Accept steering safely" },
      now: 1_000,
      runId: "auto_steer_cas",
    });
    startAutomationRun(record.runId, { now: 2_000 });
    setAutomationRunPendingOperatorNote(record.runId, "first note", { now: 3_000 });
    setAutomationRunPendingOperatorNote(record.runId, "newer note", { now: 4_000 });

    const preserved = clearAutomationRunPendingOperatorNote(record.runId, "first note", {
      now: 5_000,
    });
    expect(preserved?.pendingOperatorNote).toBe("newer note");

    const cleared = clearAutomationRunPendingOperatorNote(record.runId, "newer note", {
      now: 6_000,
    });
    expect(cleared?.pendingOperatorNote).toBeUndefined();
  });

  it("keeps stop transitions idempotent", () => {
    const record = createAutomationRunRecord({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "child-1",
      spec: { goal: "Stop safely" },
      now: 1_000,
      runId: "auto_stop",
    });
    startAutomationRun(record.runId, { now: 2_000 });
    const first = stopAutomationRun({
      runId: record.runId,
      reason: "completed",
      now: 10_000,
      finalSummaryText: "updated hero copy",
    });
    const second = stopAutomationRun({
      runId: record.runId,
      reason: "stopped_by_user",
      now: 12_000,
      finalSummaryText: "should not replace summary",
    });

    expect(first?.state).toBe("completed");
    expect(second).toEqual(first);
    expect(second?.stopReason).toBe("completed");
    expect(second?.finalSummaryText).toBe("updated hero copy");
    expect(second?.endedAt).toBe(10_000);
  });

  it("never overwrites a concurrent stopping transition with worker progress", () => {
    const record = createAutomationRunRecord({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "child-stop-race",
      spec: { goal: "Stop safely" },
      now: 1_000,
      runId: "auto_stop_race",
    });
    startAutomationRun(record.runId, { now: 2_000 });
    updateAutomationRun(record.runId, { state: "stopping" }, { now: 3_000 });

    const updated = recordAutomationRunWorkerTurn({
      runId: record.runId,
      workerCalls: 1,
      totalTokensUsedDelta: 100,
      lastProgressText: "Late worker result.",
      now: 4_000,
    });

    expect(updated).toMatchObject({
      state: "stopping",
      workerTurnsUsed: 1,
      totalTokensUsed: 100,
      lastProgressText: "Late worker result.",
      updatedAt: 4_000,
    });
  });

  it("does not fail another process's active runs on first registry access", () => {
    const active = createAutomationRunRecord({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "child-active",
      spec: { goal: "Continue until done" },
      now: 1_000,
      runId: "auto_restart_active",
    });
    startAutomationRun(active.runId, { now: 2_000 });
    const completed = createAutomationRunRecord({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "child-completed",
      spec: { goal: "Already done" },
      now: 3_000,
      runId: "auto_restart_completed",
    });
    stopAutomationRun({
      runId: completed.runId,
      reason: "completed",
      now: 4_000,
      finalSummaryText: "Done before restart.",
    });

    closeOpenClawStateDatabaseForTest();
    resetAutomationRegistryProcessStateForTests();

    expect(getAutomationRun(active.runId)).toMatchObject({
      state: "running",
    });
    expect(getAutomationRun(active.runId)?.endedAt).toBeUndefined();
    expect(getAutomationRun(completed.runId)).toMatchObject({
      state: "completed",
      stopReason: "completed",
      endedAt: 4_000,
      finalSummaryText: "Done before restart.",
    });
  });

  it("fails orphaned runs only when the gateway lifecycle owner reconciles startup", () => {
    for (const [runId, state] of [
      ["auto_restart_queued", "queued"],
      ["auto_restart_running", "running"],
      ["auto_restart_stopping", "stopping"],
    ] as const) {
      const record = createAutomationRunRecord({
        requesterSessionKey: "agent:main:main",
        childSessionKey: `child-${state}`,
        spec: { goal: `${state} work` },
        now: 1_000,
        runId,
      });
      if (state !== "queued") {
        startAutomationRun(record.runId, { now: 2_000 });
      }
      if (state === "stopping") {
        updateAutomationRun(record.runId, { state: "stopping" }, { now: 3_000 });
      }
    }
    const completed = createAutomationRunRecord({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "child-completed",
      spec: { goal: "Already done" },
      now: 1_000,
      runId: "auto_restart_completed",
    });
    stopAutomationRun({ runId: completed.runId, reason: "completed", now: 4_000 });

    const reconciled = reconcileAutomationRunsForGatewayStartup({
      now: 10_000,
      isRunOwnedByThisProcess: (runId) => runId === "auto_restart_running",
    });

    expect(reconciled.map((record) => record.runId).sort()).toEqual([
      "auto_restart_queued",
      "auto_restart_stopping",
    ]);
    for (const runId of ["auto_restart_queued", "auto_restart_stopping"] as const) {
      expect(getAutomationRun(runId)).toMatchObject({
        state: "failed",
        stopReason: "error",
        updatedAt: 10_000,
        endedAt: 10_000,
        finalSummaryText: "Automation interrupted by a gateway restart before completion.",
      });
    }
    expect(getAutomationRun("auto_restart_running")).toMatchObject({ state: "running" });
    expect(getAutomationRun(completed.runId)).toMatchObject({
      state: "completed",
      stopReason: "completed",
      endedAt: 4_000,
    });
  });

  it("bounds list history and retains only the latest terminal records", () => {
    for (let index = 0; index < 105; index += 1) {
      const runId = `auto_history_${String(index).padStart(3, "0")}`;
      createAutomationRunRecord({
        requesterSessionKey: "agent:main:history",
        childSessionKey: `child-${index}`,
        spec: { goal: `History ${index}` },
        now: index,
        runId,
      });
      stopAutomationRun({ runId, reason: "completed", now: index + 1 });
    }

    const listed = listAutomationRunsForRequester("agent:main:history");
    expect(listed).toHaveLength(20);
    expect(listed[0]?.runId).toBe("auto_history_104");
    expect(getAutomationRun("auto_history_000")).toBeUndefined();
    expect(
      resolveAutomationRunSelector({
        requesterSessionKey: "agent:main:history",
        selector: "auto_history_099",
      })?.runId,
    ).toBe("auto_history_099");
  });
});
