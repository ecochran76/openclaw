import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
}));

vi.mock("../config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

import {
  resolveMaintenanceConfigForAgent,
  resolveMaintenanceConfigForStorePath,
} from "./store-maintenance-runtime.js";

describe("session maintenance runtime config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges per-agent session maintenance over global defaults", () => {
    mocks.getRuntimeConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "warn",
          pruneAfter: "30d",
          artifactArchiveRetention: "14d",
          maxEntries: 500,
          maxDiskBytes: "500mb",
        },
      },
      agents: {
        list: [
          {
            id: "graphiti-agent",
            sessionMaintenance: {
              mode: "enforce",
              pruneAfter: "7d",
              maxEntries: 75,
              highWaterBytes: "35mb",
            },
          },
        ],
      },
    });

    const maintenance = resolveMaintenanceConfigForAgent("graphiti-agent");

    expect(maintenance.mode).toBe("enforce");
    expect(maintenance.pruneAfterMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(maintenance.artifactArchiveRetentionMs).toBe(14 * 24 * 60 * 60 * 1000);
    expect(maintenance.maxEntries).toBe(75);
    expect(maintenance.maxDiskBytes).toBe(500 * 1024 * 1024);
    expect(maintenance.highWaterBytes).toBe(35 * 1024 * 1024);
  });

  it("infers the agent id from standard agent session store paths", () => {
    mocks.getRuntimeConfig.mockReturnValue({
      agents: {
        list: [
          {
            id: "odollo-soylei",
            sessionMaintenance: {
              maxEntries: 25,
            },
          },
        ],
      },
    });

    const maintenance = resolveMaintenanceConfigForStorePath(
      "/state/agents/odollo-soylei/sessions/sessions.json",
    );

    expect(maintenance.maxEntries).toBe(25);
  });
});
