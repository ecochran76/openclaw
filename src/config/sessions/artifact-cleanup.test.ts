import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  archiveSessionArtifacts,
  listSessionArtifactArchives,
  loadSessionArtifactArchive,
  pruneSessionArtifactArchives,
} from "./artifact-cleanup.js";
import type { SessionEntry } from "./types.js";

describe("archiveSessionArtifacts", () => {
  it("previews orphan artifact archiving without moving files", async () => {
    await withTempDir({ prefix: "openclaw-session-artifact-cleanup-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const tempStore = path.join(dir, "sessions.json.1a6ce169-4960-491f-b0e2-164233f680cb.tmp");
      const orphanTrajectory = path.join(dir, "orphan.trajectory.jsonl");
      const store: Record<string, SessionEntry> = {};
      await fs.writeFile(storePath, "{}\n", "utf8");
      await fs.writeFile(tempStore, "temp", "utf8");
      await fs.writeFile(orphanTrajectory, "trajectory", "utf8");

      const manifest = await archiveSessionArtifacts({
        storePath,
        store,
        dryRun: true,
        categories: ["orphan-temp-store"],
      });

      expect(manifest.dryRun).toBe(true);
      expect(manifest.files.map((file) => file.category)).toEqual(["orphan-temp-store"]);
      await expect(fs.stat(tempStore)).resolves.toBeTruthy();
      await expect(fs.stat(orphanTrajectory)).resolves.toBeTruthy();
    });
  });

  it("moves selected orphan artifacts into a manifest-backed archive", async () => {
    await withTempDir({ prefix: "openclaw-session-artifact-cleanup-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const tempStore = path.join(dir, "sessions.json.1a6ce169-4960-491f-b0e2-164233f680cb.tmp");
      const orphanTrajectory = path.join(dir, "orphan.trajectory.jsonl");
      const store: Record<string, SessionEntry> = {};
      await fs.writeFile(storePath, "{}\n", "utf8");
      await fs.writeFile(tempStore, "temp", "utf8");
      await fs.writeFile(orphanTrajectory, "trajectory", "utf8");

      const manifest = await archiveSessionArtifacts({
        storePath,
        store,
        dryRun: false,
        categories: ["orphan-temp-store", "orphan-trajectory"],
        nowMs: Date.parse("2026-04-30T12:00:00.000Z"),
      });

      expect(manifest.archivedFiles).toBe(2);
      expect(manifest.archivedBytes).toBeGreaterThan(0);
      expect(manifest.archiveDir).toBeTruthy();
      await expect(fs.stat(tempStore)).rejects.toThrow();
      await expect(fs.stat(orphanTrajectory)).rejects.toThrow();
      const manifestPath = path.join(manifest.archiveDir ?? "", "manifest.json");
      const saved = JSON.parse(await fs.readFile(manifestPath, "utf8")) as typeof manifest;
      expect(saved.files.every((file) => file.status === "archived")).toBe(true);
      for (const file of saved.files) {
        expect(file.archivedPath).toBeTruthy();
        await expect(fs.stat(file.archivedPath ?? "")).resolves.toBeTruthy();
      }
    });
  });

  it("lists, loads, dry-runs, and prunes archive manifests", async () => {
    await withTempDir({ prefix: "openclaw-session-artifact-cleanup-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const tempStore = path.join(dir, "sessions.json.1a6ce169-4960-491f-b0e2-164233f680cb.tmp");
      const store: Record<string, SessionEntry> = {};
      await fs.writeFile(storePath, "{}\n", "utf8");
      await fs.writeFile(tempStore, "temp", "utf8");

      const manifest = await archiveSessionArtifacts({
        storePath,
        store,
        dryRun: false,
        categories: ["orphan-temp-store"],
        nowMs: Date.parse("2026-04-30T12:00:00.000Z"),
      });
      const runId = path.basename(manifest.archiveDir ?? "");

      const summaries = await listSessionArtifactArchives({ storePath });
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.runId).toBe(runId);
      expect(summaries[0]?.archivedFiles).toBe(1);

      const loaded = await loadSessionArtifactArchive({ storePath, runId });
      expect(loaded?.archivedFiles).toBe(1);

      const dryRun = await pruneSessionArtifactArchives({
        storePath,
        runId,
        dryRun: true,
      });
      expect(dryRun.removedRuns).toBe(1);
      await expect(fs.stat(manifest.archiveDir ?? "")).resolves.toBeTruthy();

      const pruned = await pruneSessionArtifactArchives({
        storePath,
        runId,
        dryRun: false,
      });
      expect(pruned.removedRuns).toBe(1);
      await expect(fs.stat(manifest.archiveDir ?? "")).rejects.toThrow();
    });
  });
});
