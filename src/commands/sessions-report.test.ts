import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
  resolveSessionStoreTargetsOrExit: vi.fn(),
  loadSessionStore: vi.fn(),
  buildSessionArtifactReport: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
  buildSessionArtifactReport: mocks.buildSessionArtifactReport,
}));

vi.mock("./session-store-targets.js", () => ({
  resolveSessionStoreTargetsOrExit: mocks.resolveSessionStoreTargetsOrExit,
}));

import { sessionsReportCommand } from "./sessions-report.js";

function makeRuntime(): { runtime: RuntimeEnv; logs: string[] } {
  const logs: string[] = [];
  return {
    runtime: {
      log: (msg: unknown) => logs.push(String(msg)),
      error: (msg: unknown) => logs.push(String(msg)),
      exit: () => {},
    },
    logs,
  };
}

describe("sessionsReportCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.resolveSessionStoreTargetsOrExit.mockReturnValue([
      { agentId: "graphiti-agent", storePath: "/state/graphiti/sessions.json" },
    ]);
    mocks.loadSessionStore.mockReturnValue({
      main: { sessionId: "main", updatedAt: 1 },
    });
    mocks.buildSessionArtifactReport.mockResolvedValue({
      storePath: "/state/graphiti/sessions.json",
      sessionsDir: "/state/graphiti",
      entryCount: 1,
      fileCount: 3,
      totalBytes: 1024,
      categories: [
        { category: "store", files: 1, bytes: 512 },
        { category: "orphan-trajectory", files: 2, bytes: 512 },
      ],
      largestFiles: [
        {
          name: "main.trajectory.jsonl",
          path: "/state/graphiti/main.trajectory.jsonl",
          sizeBytes: 512,
          mtimeMs: 1,
          category: "orphan-trajectory",
        },
      ],
    });
  });

  it("emits JSON report for one store", async () => {
    const { runtime, logs } = makeRuntime();
    await sessionsReportCommand({ agent: "graphiti-agent", json: true, largest: "5" }, runtime);

    expect(mocks.resolveSessionStoreTargetsOrExit).toHaveBeenCalledWith(
      expect.objectContaining({
        opts: expect.objectContaining({ agent: "graphiti-agent" }),
      }),
    );
    expect(mocks.buildSessionArtifactReport).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: "/state/graphiti/sessions.json",
        largestLimit: 5,
      }),
    );
    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect(payload.agentId).toBe("graphiti-agent");
    expect(payload.totalBytes).toBe(1024);
  });

  it("rejects invalid largest limit", async () => {
    const { runtime, logs } = makeRuntime();
    await sessionsReportCommand({ largest: "nope" }, runtime);

    expect(logs).toContain("--largest must be a positive integer");
    expect(mocks.resolveSessionStoreTargetsOrExit).not.toHaveBeenCalled();
  });
});
