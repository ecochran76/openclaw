import { describe, expect, it } from "vitest";
import { mapRunResultToWorkerTurnResult } from "./worker-result.js";

describe("automation worker result mapping", () => {
  it("trusts an explicit worker control line when the isolated run status is error", () => {
    const mapped = mapRunResultToWorkerTurnResult({
      status: "error",
      outputText: "RESULT: completed\nImplemented the planner slice.",
      usage: { total_tokens: 75_700 },
    });

    expect(mapped).toMatchObject({
      completed: true,
      finalSummaryText: "Implemented the planner slice.",
      totalTokensUsedDelta: 75_700,
    });
    expect(mapped.errored).toBeUndefined();
  });

  it("maps progress, blocked, approval, and error control lines", () => {
    expect(mapRunResultToWorkerTurnResult({ outputText: "RESULT: progress\nHalf done." })).toEqual({
      outputText: "Half done.",
      progressText: "Half done.",
      totalTokensUsedDelta: undefined,
    });
    expect(mapRunResultToWorkerTurnResult({ outputText: "RESULT: blocked\nNeed access." })).toEqual(
      {
        outputText: "Need access.",
        totalTokensUsedDelta: undefined,
        blocked: true,
      },
    );
    expect(
      mapRunResultToWorkerTurnResult({ outputText: "RESULT: approval_required\nNeed approval." }),
    ).toEqual({
      outputText: "Need approval.",
      totalTokensUsedDelta: undefined,
      approvalRequired: true,
    });
    expect(mapRunResultToWorkerTurnResult({ outputText: "RESULT: error\nBoom." })).toEqual({
      outputText: "Boom.",
      totalTokensUsedDelta: undefined,
      errored: true,
    });
  });

  it("falls back to summary text and summed usage", () => {
    expect(
      mapRunResultToWorkerTurnResult({
        summary: "Done from summary.",
        usage: { input_tokens: 100, output_tokens: 23 },
      }),
    ).toEqual({
      outputText: "Done from summary.",
      finalSummaryText: "Done from summary.",
      totalTokensUsedDelta: 123,
      completed: true,
    });
  });
});
