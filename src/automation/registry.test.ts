import { afterEach, describe, expect, it } from "vitest";
import {
  buildAutomationStatusView,
  createAutomationRunRecord,
  getAutomationRun,
  listAutomationRunsForRequester,
  resetAutomationRegistryForTests,
  resolveAutomationRunSelector,
  startAutomationRun,
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
});
