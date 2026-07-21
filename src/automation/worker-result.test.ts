import { describe, expect, it } from "vitest";
import { mapRunResultToWorkerTurnResult } from "./worker-result.js";

describe("automation worker result mapping", () => {
  it("keeps isolated run error status authoritative over model control text", () => {
    const mapped = mapRunResultToWorkerTurnResult({
      status: "error",
      error: "Provider request timed out.",
      outputText: "RESULT: completed\nImplemented the planner slice.",
      usage: { total_tokens: 75_700 },
    });

    expect(mapped).toMatchObject({
      errored: true,
      outputText: "Provider request timed out.",
      totalTokensUsedDelta: 75_700,
    });
    expect(mapped.completed).toBeUndefined();
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

  it("keeps output without a control line unclassified", () => {
    expect(
      mapRunResultToWorkerTurnResult({
        summary: "Made progress from summary.",
        usage: { input_tokens: 100, output_tokens: 23 },
      }),
    ).toEqual({
      outputText: "Made progress from summary.",
      totalTokensUsedDelta: 123,
    });
  });

  it("completes successful output only with an explicit completion control line", () => {
    expect(
      mapRunResultToWorkerTurnResult({
        outputText: "RESULT: completed\nDone.",
        usage: { total_tokens: 123 },
      }),
    ).toEqual({
      outputText: "Done.",
      finalSummaryText: "Done.",
      totalTokensUsedDelta: 123,
      completed: true,
    });
  });

  it("preserves explicit zero usage while rejecting invalid token counts", () => {
    expect(
      mapRunResultToWorkerTurnResult({
        outputText: "RESULT: progress\nNo billable usage yet.",
        usage: { total_tokens: 0 },
      }),
    ).toMatchObject({ totalTokensUsedDelta: 0 });
    expect(
      mapRunResultToWorkerTurnResult({
        outputText: "RESULT: progress\nNo billable usage yet.",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    ).toMatchObject({ totalTokensUsedDelta: 0 });
    expect(
      mapRunResultToWorkerTurnResult({ outputText: "Done.", usage: { total_tokens: -1 } })
        .totalTokensUsedDelta,
    ).toBeUndefined();
    expect(
      mapRunResultToWorkerTurnResult({ outputText: "Done.", usage: { total_tokens: Number.NaN } })
        .totalTokensUsedDelta,
    ).toBeUndefined();
  });

  it("does not expose a result-only control line as user output", () => {
    expect(mapRunResultToWorkerTurnResult({ outputText: "RESULT: completed" })).toEqual({
      outputText: undefined,
      finalSummaryText: undefined,
      totalTokensUsedDelta: undefined,
      completed: true,
    });
    expect(
      mapRunResultToWorkerTurnResult({ status: "error", outputText: "RESULT: error" }),
    ).toEqual({
      outputText: undefined,
      totalTokensUsedDelta: undefined,
      errored: true,
    });
  });

  it("requires a newline or end-of-string after the exact control token", () => {
    expect(mapRunResultToWorkerTurnResult({ outputText: "RESULT: completedly done" })).toEqual({
      outputText: "RESULT: completedly done",
      totalTokensUsedDelta: undefined,
    });
    expect(
      mapRunResultToWorkerTurnResult({ outputText: "RESULT: progress report follows" }),
    ).toEqual({
      outputText: "RESULT: progress report follows",
      totalTokensUsedDelta: undefined,
    });
  });
});
