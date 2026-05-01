import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
} from "../../trajectory/paths.js";
import { buildSessionArtifactReport } from "./artifact-report.js";
import { formatSessionArchiveTimestamp } from "./artifacts.js";
import type { SessionEntry } from "./types.js";

describe("buildSessionArtifactReport", () => {
  it("classifies referenced, orphan, and archived session artifacts", async () => {
    await withTempDir({ prefix: "openclaw-session-artifact-report-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionId = "active-session";
      const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
      const runtimePath = resolveTrajectoryFilePath({
        env: {},
        sessionFile: transcriptPath,
        sessionId,
      });
      const pointerPath = resolveTrajectoryPointerFilePath(transcriptPath);
      const orphanTranscript = path.join(dir, "orphan-session.jsonl");
      const orphanTrajectory = path.join(dir, "orphan-session.trajectory.jsonl");
      const orphanTempStore = path.join(
        dir,
        "sessions.json.1a6ce169-4960-491f-b0e2-164233f680cb.tmp",
      );
      const archivePath = path.join(
        dir,
        `old-session.jsonl.deleted.${formatSessionArchiveTimestamp(Date.now() - 1000)}`,
      );
      const store: Record<string, SessionEntry> = {
        "agent:main:main": {
          sessionId,
          updatedAt: Date.now(),
        },
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
      await fs.writeFile(transcriptPath, "transcript", "utf8");
      await fs.writeFile(runtimePath, "runtime", "utf8");
      await fs.writeFile(pointerPath, "pointer", "utf8");
      await fs.writeFile(orphanTranscript, "orphan transcript", "utf8");
      await fs.writeFile(orphanTrajectory, "orphan trajectory", "utf8");
      await fs.writeFile(orphanTempStore, "temp store", "utf8");
      await fs.writeFile(archivePath, "archive", "utf8");

      const report = await buildSessionArtifactReport({
        storePath,
        store,
        largestLimit: 20,
      });

      const byCategory = Object.fromEntries(
        report.categories.map((category) => [category.category, category]),
      );
      expect(byCategory["store"]?.files).toBe(1);
      expect(byCategory["referenced-transcript"]?.files).toBe(1);
      expect(byCategory["referenced-trajectory"]?.files).toBe(2);
      expect(byCategory["orphan-transcript"]?.files).toBe(1);
      expect(byCategory["orphan-trajectory"]?.files).toBe(1);
      expect(byCategory["orphan-temp-store"]?.files).toBe(1);
      expect(byCategory["archive"]?.files).toBe(1);
      expect(report.largestFiles.length).toBeGreaterThan(0);
    });
  });
});
