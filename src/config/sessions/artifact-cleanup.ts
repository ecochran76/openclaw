import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildSessionArtifactReport,
  type SessionArtifactCategory,
  type SessionArtifactReportFile,
} from "./artifact-report.js";
import type { SessionEntry } from "./types.js";

export const SESSION_ARTIFACT_ARCHIVE_DIR_NAME = ".artifact-cleanup-archive";

export type SessionArtifactArchiveCategory = Extract<
  SessionArtifactCategory,
  "orphan-temp-store" | "orphan-trajectory" | "archive"
>;

export const DEFAULT_SESSION_ARTIFACT_ARCHIVE_CATEGORIES: SessionArtifactArchiveCategory[] = [
  "orphan-temp-store",
  "orphan-trajectory",
  "archive",
];

export type SessionArtifactArchiveManifestEntry = {
  name: string;
  sourcePath: string;
  archivedPath?: string;
  sizeBytes: number;
  mtimeMs: number;
  category: SessionArtifactArchiveCategory;
  status: "planned" | "archived" | "missing" | "failed";
  error?: string;
};

export type SessionArtifactArchiveManifest = {
  version: 1;
  createdAt: string;
  dryRun: boolean;
  storePath: string;
  sessionsDir: string;
  archiveDir?: string;
  categories: SessionArtifactArchiveCategory[];
  files: SessionArtifactArchiveManifestEntry[];
  totalBytes: number;
  archivedFiles: number;
  archivedBytes: number;
};

export type SessionArtifactArchiveSummary = {
  runId: string;
  archiveDir: string;
  manifestPath: string;
  createdAt: string | null;
  dryRun: boolean | null;
  archivedFiles: number;
  archivedBytes: number;
  totalBytes: number;
  categories: SessionArtifactArchiveCategory[];
};

export type SessionArtifactArchivePruneResult = {
  dryRun: boolean;
  archiveRoot: string;
  removedRuns: number;
  removedBytes: number;
  runs: Array<SessionArtifactArchiveSummary & { removed: boolean }>;
};

function formatArchiveRunId(nowMs = Date.now()): string {
  return `${new Date(nowMs).toISOString().replaceAll(":", "-")}-${crypto.randomUUID()}`;
}

function isArchiveCategory(
  category: SessionArtifactCategory,
): category is SessionArtifactArchiveCategory {
  return DEFAULT_SESSION_ARTIFACT_ARCHIVE_CATEGORIES.includes(
    category as SessionArtifactArchiveCategory,
  );
}

function normalizeArchiveCategories(
  categories?: readonly SessionArtifactArchiveCategory[],
): SessionArtifactArchiveCategory[] {
  const requested = categories?.length ? categories : DEFAULT_SESSION_ARTIFACT_ARCHIVE_CATEGORIES;
  return [...new Set(requested.filter(isArchiveCategory))];
}

function isPathInsideDir(params: { filePath: string; dir: string }): boolean {
  const relative = path.relative(path.resolve(params.dir), path.resolve(params.filePath));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function buildArchiveDestination(params: {
  filesDir: string;
  index: number;
  file: SessionArtifactReportFile;
}): string {
  const safeName = params.file.name.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(params.filesDir, `${String(params.index + 1).padStart(5, "0")}-${safeName}`);
}

function buildPlannedEntries(params: {
  files: SessionArtifactReportFile[];
  categories: ReadonlySet<SessionArtifactArchiveCategory>;
  sessionsDir: string;
  maxArtifacts?: number;
}): SessionArtifactArchiveManifestEntry[] {
  const candidates = params.files
    .filter(
      (file): file is SessionArtifactReportFile & { category: SessionArtifactArchiveCategory } =>
        params.categories.has(file.category as SessionArtifactArchiveCategory) &&
        isPathInsideDir({ filePath: file.path, dir: params.sessionsDir }),
    )
    .toSorted((a, b) => a.mtimeMs - b.mtimeMs || b.sizeBytes - a.sizeBytes);
  const limited =
    params.maxArtifacts != null && params.maxArtifacts >= 0
      ? candidates.slice(0, params.maxArtifacts)
      : candidates;
  return limited.map((file) => ({
    name: file.name,
    sourcePath: file.path,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    category: file.category,
    status: "planned",
  }));
}

async function writeManifest(params: {
  manifestPath: string;
  manifest: SessionArtifactArchiveManifest;
}): Promise<void> {
  await fs.writeFile(params.manifestPath, `${JSON.stringify(params.manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function archiveSessionArtifacts(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  dryRun: boolean;
  categories?: readonly SessionArtifactArchiveCategory[];
  maxArtifacts?: number;
  nowMs?: number;
}): Promise<SessionArtifactArchiveManifest> {
  const categories = normalizeArchiveCategories(params.categories);
  const categorySet = new Set(categories);
  const report = await buildSessionArtifactReport({
    storePath: params.storePath,
    store: params.store,
    largestLimit: Number.MAX_SAFE_INTEGER,
  });
  const files = buildPlannedEntries({
    files: report.largestFiles,
    categories: categorySet,
    sessionsDir: report.sessionsDir,
    maxArtifacts: params.maxArtifacts,
  });
  const archiveDir = params.dryRun
    ? undefined
    : path.join(
        report.sessionsDir,
        SESSION_ARTIFACT_ARCHIVE_DIR_NAME,
        formatArchiveRunId(params.nowMs),
      );
  const manifest: SessionArtifactArchiveManifest = {
    version: 1,
    createdAt: new Date(params.nowMs ?? Date.now()).toISOString(),
    dryRun: params.dryRun,
    storePath: report.storePath,
    sessionsDir: report.sessionsDir,
    archiveDir,
    categories,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    archivedFiles: 0,
    archivedBytes: 0,
  };

  if (params.dryRun || files.length === 0 || !archiveDir) {
    return manifest;
  }

  const filesDir = path.join(archiveDir, "files");
  await fs.mkdir(filesDir, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(archiveDir, "manifest.json");
  await writeManifest({ manifestPath, manifest });

  for (const [index, file] of manifest.files.entries()) {
    const destination = buildArchiveDestination({
      filesDir,
      index,
      file: {
        name: file.name,
        path: file.sourcePath,
        sizeBytes: file.sizeBytes,
        mtimeMs: file.mtimeMs,
        category: file.category,
      },
    });
    try {
      await fs.rename(file.sourcePath, destination);
      file.archivedPath = destination;
      file.status = "archived";
      manifest.archivedFiles += 1;
      manifest.archivedBytes += file.sizeBytes;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      file.status = code === "ENOENT" ? "missing" : "failed";
      file.error = error instanceof Error ? error.message : String(error);
    }
  }

  await writeManifest({ manifestPath, manifest });
  return manifest;
}

function resolveArchiveRoot(storePath: string): string {
  return path.join(path.dirname(path.resolve(storePath)), SESSION_ARTIFACT_ARCHIVE_DIR_NAME);
}

function isInsideArchiveRoot(params: { archiveRoot: string; candidate: string }): boolean {
  const relative = path.relative(path.resolve(params.archiveRoot), path.resolve(params.candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function dirSizeBytes(dir: string): Promise<number> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSizeBytes(fullPath);
      continue;
    }
    if (entry.isFile()) {
      total += (await fs.stat(fullPath).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

function summarizeManifest(params: {
  runId: string;
  archiveDir: string;
  manifestPath: string;
  manifest: Partial<SessionArtifactArchiveManifest> | null;
  fallbackBytes: number;
}): SessionArtifactArchiveSummary {
  const manifest = params.manifest;
  return {
    runId: params.runId,
    archiveDir: params.archiveDir,
    manifestPath: params.manifestPath,
    createdAt: typeof manifest?.createdAt === "string" ? manifest.createdAt : null,
    dryRun: typeof manifest?.dryRun === "boolean" ? manifest.dryRun : null,
    archivedFiles: Number.isFinite(manifest?.archivedFiles) ? Number(manifest?.archivedFiles) : 0,
    archivedBytes: Number.isFinite(manifest?.archivedBytes)
      ? Number(manifest?.archivedBytes)
      : params.fallbackBytes,
    totalBytes: Number.isFinite(manifest?.totalBytes)
      ? Number(manifest?.totalBytes)
      : params.fallbackBytes,
    categories: Array.isArray(manifest?.categories)
      ? manifest.categories.filter(isArchiveCategory)
      : [],
  };
}

async function readArchiveSummary(params: {
  archiveRoot: string;
  runId: string;
}): Promise<SessionArtifactArchiveSummary | null> {
  const archiveDir = path.join(params.archiveRoot, params.runId);
  if (!isInsideArchiveRoot({ archiveRoot: params.archiveRoot, candidate: archiveDir })) {
    return null;
  }
  const stat = await fs.stat(archiveDir).catch(() => null);
  if (!stat?.isDirectory()) {
    return null;
  }
  const manifestPath = path.join(archiveDir, "manifest.json");
  const manifestRaw = await fs.readFile(manifestPath, "utf8").catch(() => null);
  const manifest = manifestRaw
    ? (() => {
        try {
          return JSON.parse(manifestRaw) as Partial<SessionArtifactArchiveManifest>;
        } catch {
          return null;
        }
      })()
    : null;
  return summarizeManifest({
    runId: params.runId,
    archiveDir,
    manifestPath,
    manifest,
    fallbackBytes: await dirSizeBytes(archiveDir),
  });
}

export async function listSessionArtifactArchives(params: {
  storePath: string;
}): Promise<SessionArtifactArchiveSummary[]> {
  const archiveRoot = resolveArchiveRoot(params.storePath);
  const entries = await fs.readdir(archiveRoot, { withFileTypes: true }).catch(() => []);
  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readArchiveSummary({ archiveRoot, runId: entry.name })),
  );
  return summaries
    .filter((summary): summary is SessionArtifactArchiveSummary => summary !== null)
    .toSorted((a, b) => (b.createdAt ?? b.runId).localeCompare(a.createdAt ?? a.runId));
}

export async function loadSessionArtifactArchive(params: {
  storePath: string;
  runId: string;
}): Promise<SessionArtifactArchiveManifest | null> {
  const archiveRoot = resolveArchiveRoot(params.storePath);
  const archiveDir = path.join(archiveRoot, params.runId);
  if (!isInsideArchiveRoot({ archiveRoot, candidate: archiveDir })) {
    return null;
  }
  const manifestPath = path.join(archiveDir, "manifest.json");
  const raw = await fs.readFile(manifestPath, "utf8").catch(() => null);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as SessionArtifactArchiveManifest;
  } catch {
    return null;
  }
}

export async function pruneSessionArtifactArchives(params: {
  storePath: string;
  dryRun: boolean;
  runId?: string;
  olderThanMs?: number;
  nowMs?: number;
}): Promise<SessionArtifactArchivePruneResult> {
  const archiveRoot = resolveArchiveRoot(params.storePath);
  const summaries = await listSessionArtifactArchives({ storePath: params.storePath });
  const nowMs = params.nowMs ?? Date.now();
  const selected = summaries.filter((summary) => {
    if (params.runId && summary.runId !== params.runId) {
      return false;
    }
    if (params.olderThanMs == null) {
      return params.runId ? summary.runId === params.runId : false;
    }
    const createdMs = summary.createdAt ? Date.parse(summary.createdAt) : Number.NaN;
    return Number.isFinite(createdMs) && nowMs - createdMs > params.olderThanMs;
  });
  const runs: SessionArtifactArchivePruneResult["runs"] = [];
  let removedRuns = 0;
  let removedBytes = 0;
  for (const summary of selected) {
    const removable = isInsideArchiveRoot({
      archiveRoot,
      candidate: summary.archiveDir,
    });
    if (!removable) {
      runs.push({ ...summary, removed: false });
      continue;
    }
    if (!params.dryRun) {
      await fs.rm(summary.archiveDir, { recursive: true, force: true });
    }
    removedRuns += 1;
    removedBytes += summary.archivedBytes;
    runs.push({ ...summary, removed: true });
  }
  return {
    dryRun: params.dryRun,
    archiveRoot,
    removedRuns,
    removedBytes,
    runs,
  };
}
