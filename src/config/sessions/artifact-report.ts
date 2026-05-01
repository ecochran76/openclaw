import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
} from "../../trajectory/paths.js";
import {
  isCompactionCheckpointTranscriptFileName,
  isPrimarySessionTranscriptFileName,
  isSessionArchiveArtifactName,
  isTrajectoryPointerArtifactName,
  isTrajectoryRuntimeArtifactName,
} from "./artifacts.js";
import { resolveSessionFilePath } from "./paths.js";
import type { SessionEntry } from "./types.js";

export type SessionArtifactCategory =
  | "store"
  | "referenced-transcript"
  | "referenced-trajectory"
  | "referenced-checkpoint"
  | "orphan-transcript"
  | "orphan-trajectory"
  | "orphan-checkpoint"
  | "orphan-temp-store"
  | "archive"
  | "other";

export type SessionArtifactReportFile = {
  name: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  category: SessionArtifactCategory;
};

export type SessionArtifactReportCategory = {
  category: SessionArtifactCategory;
  files: number;
  bytes: number;
};

export type SessionArtifactReport = {
  storePath: string;
  sessionsDir: string;
  entryCount: number;
  fileCount: number;
  totalBytes: number;
  categories: SessionArtifactReportCategory[];
  largestFiles: SessionArtifactReportFile[];
};

type FileStat = {
  name: string;
  path: string;
  canonicalPath: string;
  sizeBytes: number;
  mtimeMs: number;
};

function canonicalizePathForComparison(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fsSync.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function resolveSessionTranscriptPathForEntry(params: {
  sessionsDir: string;
  entry: SessionEntry;
}): string | null {
  if (!params.entry.sessionId) {
    return null;
  }
  try {
    const resolved = resolveSessionFilePath(params.entry.sessionId, params.entry, {
      sessionsDir: params.sessionsDir,
    });
    const resolvedSessionsDir = canonicalizePathForComparison(params.sessionsDir);
    const resolvedPath = canonicalizePathForComparison(resolved);
    const relative = path.relative(resolvedSessionsDir, resolvedPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }
    return resolvedPath;
  } catch {
    return null;
  }
}

function collectReferencedPaths(params: {
  sessionsDir: string;
  storePath: string;
  store: Record<string, SessionEntry>;
}): Map<string, SessionArtifactCategory> {
  const referenced = new Map<string, SessionArtifactCategory>();
  referenced.set(canonicalizePathForComparison(params.storePath), "store");
  const resolvedSessionsDir = canonicalizePathForComparison(params.sessionsDir);

  for (const entry of Object.values(params.store)) {
    const transcriptPath = resolveSessionTranscriptPathForEntry({
      sessionsDir: params.sessionsDir,
      entry,
    });
    if (transcriptPath) {
      referenced.set(transcriptPath, "referenced-transcript");
      if (entry.sessionId) {
        referenced.set(
          canonicalizePathForComparison(resolveTrajectoryPointerFilePath(transcriptPath)),
          "referenced-trajectory",
        );
        referenced.set(
          canonicalizePathForComparison(
            resolveTrajectoryFilePath({
              env: {},
              sessionFile: transcriptPath,
              sessionId: entry.sessionId,
            }),
          ),
          "referenced-trajectory",
        );
      }
    }

    for (const checkpoint of entry.compactionCheckpoints ?? []) {
      const checkpointFile = checkpoint.preCompaction.sessionFile?.trim();
      if (!checkpointFile) {
        continue;
      }
      const resolvedCheckpointPath = canonicalizePathForComparison(checkpointFile);
      const relative = path.relative(resolvedSessionsDir, resolvedCheckpointPath);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        referenced.set(resolvedCheckpointPath, "referenced-checkpoint");
      }
    }
  }

  return referenced;
}

async function readSessionsDirFiles(sessionsDir: string): Promise<FileStat[]> {
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const files: FileStat[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const filePath = path.join(sessionsDir, entry.name);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
      continue;
    }
    files.push({
      name: entry.name,
      path: filePath,
      canonicalPath: canonicalizePathForComparison(filePath),
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }
  return files;
}

function classifyUnreferencedFile(name: string): SessionArtifactCategory {
  if (name === "sessions.json") {
    return "store";
  }
  if (/^sessions\.json\.[0-9a-f-]+\.tmp$/i.test(name)) {
    return "orphan-temp-store";
  }
  if (isSessionArchiveArtifactName(name)) {
    return "archive";
  }
  if (isCompactionCheckpointTranscriptFileName(name)) {
    return "orphan-checkpoint";
  }
  if (isTrajectoryRuntimeArtifactName(name) || isTrajectoryPointerArtifactName(name)) {
    return "orphan-trajectory";
  }
  if (isPrimarySessionTranscriptFileName(name)) {
    return "orphan-transcript";
  }
  return "other";
}

export async function buildSessionArtifactReport(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  largestLimit?: number;
}): Promise<SessionArtifactReport> {
  const storePath = path.resolve(params.storePath);
  const sessionsDir = path.dirname(storePath);
  const files = await readSessionsDirFiles(sessionsDir);
  const referenced = collectReferencedPaths({
    sessionsDir,
    storePath,
    store: params.store,
  });
  const reportFiles = files.map((file): SessionArtifactReportFile => {
    const category = referenced.get(file.canonicalPath) ?? classifyUnreferencedFile(file.name);
    return {
      name: file.name,
      path: file.path,
      sizeBytes: file.sizeBytes,
      mtimeMs: file.mtimeMs,
      category,
    };
  });

  const categoriesByName = new Map<SessionArtifactCategory, SessionArtifactReportCategory>();
  for (const file of reportFiles) {
    const current =
      categoriesByName.get(file.category) ??
      ({
        category: file.category,
        files: 0,
        bytes: 0,
      } satisfies SessionArtifactReportCategory);
    current.files += 1;
    current.bytes += file.sizeBytes;
    categoriesByName.set(file.category, current);
  }

  return {
    storePath,
    sessionsDir,
    entryCount: Object.keys(params.store).length,
    fileCount: reportFiles.length,
    totalBytes: reportFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
    categories: [...categoriesByName.values()].toSorted((a, b) => b.bytes - a.bytes),
    largestFiles: reportFiles
      .toSorted((a, b) => b.sizeBytes - a.sizeBytes)
      .slice(0, params.largestLimit ?? 10),
  };
}
