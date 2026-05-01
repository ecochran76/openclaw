// Session cleanup service for store entries and transcript/artifact files.
// Supports dry-run/apply modes, stale pruning, missing transcript fixes, DM-scope retirement, and disk budgets.

import fs from "node:fs";
import path from "node:path";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { parseByteSize } from "../../cli/parse-bytes.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { getLogger } from "../../logging/logger.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  archiveSessionArtifacts,
  type SessionArtifactArchiveCategory,
  type SessionArtifactArchiveManifest,
} from "./artifact-cleanup.js";
import {
  enforceSessionDiskBudget,
  pruneUnreferencedSessionArtifacts,
  resolveSessionArtifactCanonicalPathsForEntry,
  type SessionUnreferencedArtifactSweepResult,
} from "./disk-budget.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveStorePath,
} from "./paths.js";
import {
  purgeDeletedAgentSessionEntries,
} from "./session-accessor.js";
import { cloneSessionStoreRecord } from "./store-cache.js";
import { collectSessionMaintenancePreserveKeys } from "./store-maintenance-preserve.js";
import {
  resolveMaintenanceConfig,
  resolveMaintenanceConfigForAgent,
} from "./store-maintenance-runtime.js";
import {
  capEntryCount,
  pruneStaleModelRunEntries,
  pruneStaleEntries,
  shouldRunModelRunPrune,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import {
  archiveRemovedSessionTranscripts,
  loadSessionStore,
  type SessionMaintenanceApplyReport,
  updateSessionStore,
} from "./store.js";
import {
  resolveSessionStoreTargets,
  type SessionStoreTarget,
  type SessionStoreSelectionOptions,
} from "./targets.js";
import type { SessionEntry } from "./types.js";

export type SessionsCleanupOptions = SessionStoreSelectionOptions & {
  dryRun?: boolean;
  enforce?: boolean;
  activeKey?: string;
  json?: boolean;
  fixMissing?: boolean;
  fixDmScope?: boolean;
  maxEntries?: string | number;
  pruneAfter?: string;
  maxDiskBytes?: string;
  highWaterBytes?: string;
  archiveArtifacts?: boolean;
  artifactCategories?: string;
  maxArtifacts?: string | number;
};

export type SessionCleanupAction =
  | "keep"
  | "prune-missing"
  | "prune-model-run"
  | "prune-stale"
  | "cap-overflow"
  | "evict-budget"
  | "retire-dm-scope";

export type SessionCleanupSummary = {
  agentId: string;
  storePath: string;
  mode: ResolvedSessionMaintenanceConfig["mode"];
  dryRun: boolean;
  beforeCount: number;
  afterCount: number;
  missing: number;
  dmScopeRetired: number;
  modelRunPruned: number;
  pruned: number;
  capped: number;
  unreferencedArtifacts: SessionUnreferencedArtifactSweepResult;
  diskBudget: Awaited<ReturnType<typeof enforceSessionDiskBudget>>;
  artifactArchivePrune: SessionMaintenanceApplyReport["artifactArchivePrune"] | null;
  artifactArchive?: SessionArtifactArchiveManifest;
  wouldMutate: boolean;
  applied?: true;
  appliedCount?: number;
};

const ARTIFACT_ARCHIVE_CATEGORIES = new Set<SessionArtifactArchiveCategory>([
  "orphan-temp-store",
  "orphan-trajectory",
  "archive",
]);
const DEFAULT_ARTIFACT_ARCHIVE_MAX_ARTIFACTS = 100;

export type SessionsCleanupResult =
  | SessionCleanupSummary
  | {
      allAgents: true;
      mode: ResolvedSessionMaintenanceConfig["mode"];
      dryRun: boolean;
      stores: SessionCleanupSummary[];
    };

export type SessionsCleanupRunResult = {
  mode: ResolvedSessionMaintenanceConfig["mode"];
  previewResults: Array<{
    summary: SessionCleanupSummary;
    beforeStore: Record<string, SessionEntry>;
    missingKeys: Set<string>;
    modelRunPrunedKeys: Set<string>;
    staleKeys: Set<string>;
    cappedKeys: Set<string>;
    budgetEvictedKeys: Set<string>;
    dmScopeRetiredKeys: Set<string>;
  }>;
  appliedSummaries: SessionCleanupSummary[];
};

const EMPTY_TRANSCRIPT_MAX_BYTES = 4096;

function isTranscriptMessageRole(role: unknown): boolean {
  return (
    role === "user" ||
    role === "assistant" ||
    role === "tool" ||
    role === "toolResult" ||
    role === "system"
  );
}

function isTranscriptMessageRecord(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { message?: unknown; role?: unknown; type?: unknown };
  if (record.type === "message") {
    return true;
  }
  if (
    record.type === undefined &&
    record.message &&
    typeof record.message === "object" &&
    isTranscriptMessageRole((record.message as { role?: unknown }).role)
  ) {
    return true;
  }
  return record.type === undefined && isTranscriptMessageRole(record.role);
}

function transcriptHasNoMessageRecords(transcriptPath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size > EMPTY_TRANSCRIPT_MAX_BYTES) {
    // Only inspect small transcript files; larger files are assumed to contain real history.
    return false;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return false;
  }

  const lines = raw.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return true;
  }
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line) as unknown;
    } catch {
      return false;
    }
    if (isTranscriptMessageRecord(entry)) {
      return false;
    }
  }
  return true;
}

/** Resolves the action label for one session key from cleanup key sets. */
export function resolveSessionCleanupAction(params: {
  key: string;
  missingKeys: Set<string>;
  modelRunPrunedKeys: Set<string>;
  staleKeys: Set<string>;
  cappedKeys: Set<string>;
  budgetEvictedKeys: Set<string>;
  dmScopeRetiredKeys: Set<string>;
}): SessionCleanupAction {
  if (params.dmScopeRetiredKeys.has(params.key)) {
    return "retire-dm-scope";
  }
  if (params.missingKeys.has(params.key)) {
    return "prune-missing";
  }
  if (params.modelRunPrunedKeys.has(params.key)) {
    return "prune-model-run";
  }
  if (params.staleKeys.has(params.key)) {
    return "prune-stale";
  }
  if (params.cappedKeys.has(params.key)) {
    return "cap-overflow";
  }
  if (params.budgetEvictedKeys.has(params.key)) {
    return "evict-budget";
  }
  return "keep";
}

function isMainScopeStaleDirectSessionKey(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  key: string;
  activeKey?: string;
}): boolean {
  if ((params.cfg.session?.dmScope ?? "main") !== "main") {
    return false;
  }
  if (params.activeKey && params.key === params.activeKey) {
    return false;
  }
  const parsed = parseAgentSessionKey(params.key);
  if (!parsed || normalizeAgentId(parsed.agentId) !== normalizeAgentId(params.targetAgentId)) {
    return false;
  }
  const parts = parsed.rest.split(":");
  // A nested agent wrapper is opaque plugin identity, never a stale DM route.
  if (parts[0] === "agent") {
    return false;
  }
  return (
    (parts.length === 2 && parts[0] === "direct" && Boolean(parts[1])) ||
    (parts.length === 3 && Boolean(parts[0]) && parts[1] === "direct" && Boolean(parts[2])) ||
    (parts.length === 4 &&
      Boolean(parts[0]) &&
      Boolean(parts[1]) &&
      parts[2] === "direct" &&
      Boolean(parts[3]))
  );
}

function retireMainScopeDirectSessionEntries(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  targetAgentId: string;
  activeKey?: string;
  onRetired?: (key: string, entry: SessionEntry) => void;
}): number {
  let retired = 0;
  for (const [key, entry] of Object.entries(params.store)) {
    if (
      isMainScopeStaleDirectSessionKey({
        cfg: params.cfg,
        targetAgentId: params.targetAgentId,
        key,
        activeKey: params.activeKey,
      })
    ) {
      params.onRetired?.(key, entry);
      delete params.store[key];
      retired += 1;
    }
  }
  return retired;
}

function rememberRemovedSessionFile(
  removedSessionFiles: Map<string, string | undefined>,
  entry: SessionEntry,
): void {
  if (!removedSessionFiles.has(entry.sessionId) || entry.sessionFile) {
    removedSessionFiles.set(entry.sessionId, entry.sessionFile);
  }
}

export function serializeSessionCleanupResult(params: {
  mode: ResolvedSessionMaintenanceConfig["mode"];
  dryRun: boolean;
  summaries: SessionCleanupSummary[];
}): SessionsCleanupResult {
  if (params.summaries.length === 1) {
    return params.summaries[0] ?? ({} as SessionCleanupSummary);
  }
  return {
    allAgents: true,
    mode: params.mode,
    dryRun: params.dryRun,
    stores: params.summaries,
  };
}

function pruneMissingTranscriptEntries(params: {
  store: Record<string, SessionEntry>;
  storePath: string;
  onPruned?: (key: string, entry: SessionEntry) => void;
}): number {
  const sessionPathOpts = resolveSessionFilePathOptions({
    storePath: params.storePath,
  });
  let removed = 0;
  for (const [key, entry] of Object.entries(params.store)) {
    if (!entry?.sessionId) {
      if (parseAgentSessionKey(key)) {
        // Agent-scoped keys without session ids are valid routing entries; keep them.
        continue;
      }
      delete params.store[key];
      removed += 1;
      params.onPruned?.(key, entry);
      continue;
    }
    let transcriptPath: string | undefined;
    try {
      transcriptPath = resolveSessionFilePath(entry.sessionId, entry, sessionPathOpts);
    } catch {
      // Malformed legacy rows cannot resolve a transcript path; --fix-missing prunes them.
    }
    if (
      !transcriptPath ||
      !fs.existsSync(transcriptPath) ||
      transcriptHasNoMessageRecords(transcriptPath)
    ) {
      delete params.store[key];
      removed += 1;
      params.onPruned?.(key, entry);
    }
  }
  return removed;
}

function addEntryArtifactPathsToSet(params: {
  paths: Set<string>;
  store: Record<string, SessionEntry>;
  storePath: string;
  keys: ReadonlySet<string>;
}): void {
  const sessionsDir = path.dirname(params.storePath);
  for (const key of params.keys) {
    const entry = params.store[key];
    if (!entry) {
      continue;
    }
    for (const artifactPath of resolveSessionArtifactCanonicalPathsForEntry({
      sessionsDir,
      entry,
    })) {
      params.paths.add(artifactPath);
    }
  }
}

function parsePositiveIntegerOption(params: {
  name: string;
  value?: string | number;
}): number | undefined {
  if (params.value === undefined || params.value === "") {
    return undefined;
  }
  const parsed = typeof params.value === "number" ? params.value : Number(params.value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${params.name} must be a positive integer`);
  }
  return parsed;
}

function parseDurationOption(params: { name: string; value?: string }): number | undefined {
  const raw = params.value?.trim();
  if (!raw) {
    return undefined;
  }
  try {
    return parseDurationMs(raw, { defaultUnit: "d" });
  } catch {
    throw new Error(`${params.name} must be a duration such as 7d, 12h, or 30m`);
  }
}

function parseByteOption(params: { name: string; value?: string }): number | undefined {
  const raw = params.value?.trim();
  if (!raw) {
    return undefined;
  }
  try {
    return parseByteSize(raw, { defaultUnit: "b" });
  } catch {
    throw new Error(`${params.name} must be a byte size such as 50mb, 1gb, or 50000000`);
  }
}

function parseArtifactCategoriesOption(
  value?: string,
): SessionArtifactArchiveCategory[] | undefined {
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }
  const categories: SessionArtifactArchiveCategory[] = [];
  for (const part of raw.split(",")) {
    const category = part.trim();
    if (!category) {
      continue;
    }
    if (!ARTIFACT_ARCHIVE_CATEGORIES.has(category as SessionArtifactArchiveCategory)) {
      throw new Error(
        `--artifact-categories must only include: ${[...ARTIFACT_ARCHIVE_CATEGORIES].join(", ")}`,
      );
    }
    categories.push(category as SessionArtifactArchiveCategory);
  }
  return [...new Set(categories)];
}

function resolveMaintenanceOverrideFromOptions(
  opts: SessionsCleanupOptions,
): Partial<ResolvedSessionMaintenanceConfig> {
  const override: Partial<ResolvedSessionMaintenanceConfig> = {};
  const maxEntries = parsePositiveIntegerOption({
    name: "--max-entries",
    value: opts.maxEntries,
  });
  const pruneAfterMs = parseDurationOption({
    name: "--prune-after",
    value: opts.pruneAfter,
  });
  const maxDiskBytes = parseByteOption({
    name: "--max-disk-bytes",
    value: opts.maxDiskBytes,
  });
  const highWaterBytes = parseByteOption({
    name: "--high-water-bytes",
    value: opts.highWaterBytes,
  });
  if (maxEntries !== undefined) {
    override.maxEntries = maxEntries;
  }
  if (pruneAfterMs !== undefined) {
    override.pruneAfterMs = pruneAfterMs;
  }
  if (maxDiskBytes !== undefined) {
    override.maxDiskBytes = maxDiskBytes;
  }
  if (highWaterBytes !== undefined) {
    override.highWaterBytes = highWaterBytes;
  }
  return override;
}

async function previewStoreCleanup(params: {
  cfg: OpenClawConfig;
  target: SessionStoreTarget;
  maintenance: ResolvedSessionMaintenanceConfig;
  mode: ResolvedSessionMaintenanceConfig["mode"];
  dryRun: boolean;
  activeKey?: string;
  fixMissing?: boolean;
  fixDmScope?: boolean;
  archiveArtifacts?: boolean;
  artifactCategories?: SessionArtifactArchiveCategory[];
  maxArtifacts?: number;
}) {
  const beforeStore = loadSessionStore(params.target.storePath, { skipCache: true });
  // Preview always mutates a clone so dry-run output can report exact counts without touching disk.
  const previewStore = cloneSessionStoreRecord(beforeStore);
  const staleKeys = new Set<string>();
  const cappedKeys = new Set<string>();
  const missingKeys = new Set<string>();
  const modelRunPrunedKeys = new Set<string>();
  const dmScopeRetiredKeys = new Set<string>();
  const missing =
    params.fixMissing === true
      ? pruneMissingTranscriptEntries({
          store: previewStore,
          storePath: params.target.storePath,
          onPruned: (key) => {
            missingKeys.add(key);
          },
        })
      : 0;
  const dmScopeRetired =
    params.fixDmScope === true
      ? retireMainScopeDirectSessionEntries({
          cfg: params.cfg,
          store: previewStore,
          targetAgentId: params.target.agentId,
          activeKey: params.activeKey,
          onRetired: (key) => {
            dmScopeRetiredKeys.add(key);
          },
        })
      : 0;
  const preserveSessionKeys = collectSessionMaintenancePreserveKeys([params.activeKey]);
  const modelRunPruned = shouldRunModelRunPrune({
    maintenance: params.maintenance,
    entryCount: Object.keys(previewStore).length,
    // `sessions cleanup` applies the cap immediately (apply path forces maintenance and the
    // preview caps unconditionally below), so mirror that here: prune stale probes before the
    // forced cap can evict real sessions in their place.
    force: true,
  })
    ? pruneStaleModelRunEntries(previewStore, params.maintenance.modelRunPruneAfterMs, {
        log: false,
        preserveKeys: preserveSessionKeys,
        onPruned: ({ key }) => {
          modelRunPrunedKeys.add(key);
        },
      })
    : 0;
  const pruned = pruneStaleEntries(previewStore, params.maintenance.pruneAfterMs, {
    log: false,
    preserveKeys: preserveSessionKeys,
    onPruned: ({ key }) => {
      staleKeys.add(key);
    },
  });
  const capped = capEntryCount(previewStore, params.maintenance.maxEntries, {
    log: false,
    preserveKeys: preserveSessionKeys,
    onCapped: ({ key }) => {
      cappedKeys.add(key);
    },
  });
  const entryCleanupArtifactPaths = new Set<string>();
  addEntryArtifactPathsToSet({
    paths: entryCleanupArtifactPaths,
    store: beforeStore,
    storePath: params.target.storePath,
    keys: modelRunPrunedKeys,
  });
  addEntryArtifactPathsToSet({
    paths: entryCleanupArtifactPaths,
    store: beforeStore,
    storePath: params.target.storePath,
    keys: staleKeys,
  });
  addEntryArtifactPathsToSet({
    paths: entryCleanupArtifactPaths,
    store: beforeStore,
    storePath: params.target.storePath,
    keys: cappedKeys,
  });
  addEntryArtifactPathsToSet({
    paths: entryCleanupArtifactPaths,
    store: beforeStore,
    storePath: params.target.storePath,
    keys: dmScopeRetiredKeys,
  });
  const beforeBudgetStore = cloneSessionStoreRecord(previewStore);
  const budgetRemovedFilePaths = new Set<string>();
  const diskBudget = await enforceSessionDiskBudget({
    store: previewStore,
    storePath: params.target.storePath,
    activeSessionKey: params.activeKey,
    preserveKeys: preserveSessionKeys,
    maintenance: params.maintenance,
    warnOnly: false,
    dryRun: true,
    onRemoveFile: (canonicalPath) => {
      budgetRemovedFilePaths.add(canonicalPath);
    },
  });
  const unreferencedArtifacts = params.archiveArtifacts
    ? {
        scannedFiles: 0,
        removedFiles: 0,
        freedBytes: 0,
        olderThanMs: params.maintenance.pruneAfterMs,
      }
    : await pruneUnreferencedSessionArtifacts({
        store: previewStore,
        storePath: params.target.storePath,
        olderThanMs: params.maintenance.pruneAfterMs,
        dryRun: true,
        excludeCanonicalPaths: new Set([...budgetRemovedFilePaths, ...entryCleanupArtifactPaths]),
      });
  const artifactArchive = params.archiveArtifacts
    ? await archiveSessionArtifacts({
        storePath: params.target.storePath,
        store: previewStore,
        dryRun: true,
        categories: params.artifactCategories,
        maxArtifacts: params.maxArtifacts,
      })
    : undefined;
  const budgetEvictedKeys = new Set<string>();
  for (const key of Object.keys(beforeBudgetStore)) {
    if (!Object.hasOwn(previewStore, key)) {
      budgetEvictedKeys.add(key);
    }
  }
  const beforeCount = Object.keys(beforeStore).length;
  const afterPreviewCount = Object.keys(previewStore).length;
  const wouldMutate =
    missing > 0 ||
    dmScopeRetired > 0 ||
    modelRunPruned > 0 ||
    pruned > 0 ||
    capped > 0 ||
    unreferencedArtifacts.removedFiles > 0 ||
    (diskBudget?.removedEntries ?? 0) > 0 ||
    (diskBudget?.removedFiles ?? 0) > 0 ||
    (artifactArchive?.files.length ?? 0) > 0;

  const summary: SessionCleanupSummary = {
    agentId: params.target.agentId,
    storePath: params.target.storePath,
    mode: params.mode,
    dryRun: params.dryRun,
    beforeCount,
    afterCount: afterPreviewCount,
    missing,
    dmScopeRetired,
    modelRunPruned,
    pruned,
    capped,
    unreferencedArtifacts,
    diskBudget,
    artifactArchivePrune: null,
    artifactArchive,
    wouldMutate,
  };

  return {
    summary,
    beforeStore,
    missingKeys,
    modelRunPrunedKeys,
    staleKeys,
    cappedKeys,
    budgetEvictedKeys,
    dmScopeRetiredKeys,
  };
}

/** Runs session cleanup preview/apply for the selected store targets. */
export async function runSessionsCleanup(params: {
  cfg: OpenClawConfig;
  opts: SessionsCleanupOptions;
  targets?: SessionStoreTarget[];
}): Promise<SessionsCleanupRunResult> {
  const { cfg, opts } = params;
  const baseMaintenance = resolveMaintenanceConfig();
  const mode = opts.enforce ? "enforce" : baseMaintenance.mode;
  const maintenanceOverride = resolveMaintenanceOverrideFromOptions(opts);
  const artifactCategories = parseArtifactCategoriesOption(opts.artifactCategories);
  const maxArtifacts = opts.archiveArtifacts
    ? (parsePositiveIntegerOption({
        name: "--max-artifacts",
        value: opts.maxArtifacts ?? DEFAULT_ARTIFACT_ARCHIVE_MAX_ARTIFACTS,
      }) ?? DEFAULT_ARTIFACT_ARCHIVE_MAX_ARTIFACTS)
    : undefined;
  const targets =
    params.targets ??
    resolveSessionStoreTargets(cfg, {
      store: opts.store,
      agent: opts.agent,
      allAgents: opts.allAgents,
    });

  const previewResults: SessionsCleanupRunResult["previewResults"] = [];
  for (const target of targets) {
    const maintenance = {
      ...resolveMaintenanceConfigForAgent(target.agentId),
      ...maintenanceOverride,
    };
    const result = await previewStoreCleanup({
      cfg,
      target,
      maintenance,
      mode,
      dryRun: Boolean(opts.dryRun),
      activeKey: opts.activeKey,
      fixMissing: Boolean(opts.fixMissing),
      fixDmScope: Boolean(opts.fixDmScope),
      archiveArtifacts: Boolean(opts.archiveArtifacts),
      artifactCategories,
      maxArtifacts,
    });
    previewResults.push(result);
  }

  const appliedSummaries: SessionCleanupSummary[] = [];
  if (!opts.dryRun) {
    for (const target of targets) {
      const appliedReportRef: { current: SessionMaintenanceApplyReport | null } = {
        current: null,
      };
      const dmScopeRemovedSessionFiles = new Map<string, string | undefined>();
      let missingApplied = 0;
      let dmScopeRetiredApplied = 0;
      const maintenance = {
        ...resolveMaintenanceConfigForAgent(target.agentId),
        ...maintenanceOverride,
      };
      await updateSessionStore(
        target.storePath,
        async (store) => {
          let removed = 0;
          if (opts.fixMissing) {
            missingApplied = pruneMissingTranscriptEntries({
              store,
              storePath: target.storePath,
            });
            removed += missingApplied;
          }
          if (opts.fixDmScope) {
            dmScopeRetiredApplied = retireMainScopeDirectSessionEntries({
              cfg,
              store,
              targetAgentId: target.agentId,
              activeKey: opts.activeKey,
              onRetired: (_key, entry) => {
                rememberRemovedSessionFile(dmScopeRemovedSessionFiles, entry);
              },
            });
            removed += dmScopeRetiredApplied;
          }
          return removed;
        },
        {
          activeSessionKey: opts.activeKey,
          maintenanceOverride: {
            ...maintenanceOverride,
            mode,
          },
          onMaintenanceApplied: (report) => {
            appliedReportRef.current = report;
          },
        },
      );
      if (dmScopeRemovedSessionFiles.size > 0) {
        const storeAfterDmScopeRetire = loadSessionStore(target.storePath, { skipCache: true });
        await archiveRemovedSessionTranscripts({
          removedSessionFiles: dmScopeRemovedSessionFiles,
          referencedSessionIds: new Set(
            Object.values(storeAfterDmScopeRetire)
              .map((entry) => entry?.sessionId)
              .filter((id): id is string => Boolean(id)),
          ),
          storePath: target.storePath,
          reason: "deleted",
          restrictToStoreDir: true,
        });
      }
      const afterStore = loadSessionStore(target.storePath, { skipCache: true });
      const artifactArchive = opts.archiveArtifacts
        ? await archiveSessionArtifacts({
            storePath: target.storePath,
            store: afterStore,
            dryRun: false,
            categories: artifactCategories,
            maxArtifacts,
          })
        : undefined;
      const unreferencedArtifacts =
        mode === "warn" || opts.archiveArtifacts
          ? {
              scannedFiles: 0,
              removedFiles: 0,
              freedBytes: 0,
              olderThanMs: maintenance.pruneAfterMs,
            }
          : await pruneUnreferencedSessionArtifacts({
              store: afterStore,
              storePath: target.storePath,
              olderThanMs: maintenance.pruneAfterMs,
              dryRun: false,
            });
      const preview = previewResults.find(
        (result) => result.summary.storePath === target.storePath,
      );
      const appliedReport = appliedReportRef.current;
      const summary: SessionCleanupSummary =
        appliedReport === null
          ? {
              ...(preview?.summary ?? {
                agentId: target.agentId,
                storePath: target.storePath,
                mode,
                dryRun: false,
                beforeCount: 0,
                afterCount: 0,
                missing: 0,
                dmScopeRetired: 0,
                modelRunPruned: 0,
                pruned: 0,
                capped: 0,
                unreferencedArtifacts,
                diskBudget: null,
                artifactArchivePrune: null,
                artifactArchive,
                wouldMutate: false,
              }),
              dryRun: false,
              unreferencedArtifacts,
              wouldMutate:
                (preview?.summary.wouldMutate ?? false) ||
                unreferencedArtifacts.removedFiles > 0 ||
                (artifactArchive?.archivedFiles ?? 0) > 0,
              applied: true,
              appliedCount: Object.keys(afterStore).length,
              artifactArchive,
            }
          : {
              agentId: target.agentId,
              storePath: target.storePath,
              mode: appliedReport.mode,
              dryRun: false,
              beforeCount: appliedReport.beforeCount,
              afterCount: appliedReport.afterCount,
              missing: missingApplied,
              dmScopeRetired: dmScopeRetiredApplied,
              modelRunPruned: appliedReport.modelRunPruned,
              pruned: appliedReport.pruned,
              capped: appliedReport.capped,
              unreferencedArtifacts,
              diskBudget: appliedReport.diskBudget,
              artifactArchivePrune: appliedReport.artifactArchivePrune,
              artifactArchive,
              wouldMutate:
                missingApplied > 0 ||
                dmScopeRetiredApplied > 0 ||
                appliedReport.modelRunPruned > 0 ||
                appliedReport.pruned > 0 ||
                appliedReport.capped > 0 ||
                unreferencedArtifacts.removedFiles > 0 ||
                (appliedReport.diskBudget?.removedEntries ?? 0) > 0 ||
                (appliedReport.diskBudget?.removedFiles ?? 0) > 0 ||
                (artifactArchive?.archivedFiles ?? 0) > 0,
              applied: true,
              appliedCount: appliedReport.afterCount,
            };
      appliedSummaries.push(summary);
    }
  }

  return { mode, previewResults, appliedSummaries };
}

/** Purge session store entries for a deleted agent (#65524). Best-effort. */
export async function purgeAgentSessionStoreEntries(
  cfg: OpenClawConfig,
  agentId: string,
): Promise<void> {
  try {
    const normalizedAgentId = normalizeAgentId(agentId);
    const storeConfig = cfg.session?.store;
    const storeAgentId =
      typeof storeConfig === "string" && storeConfig.includes("{agentId}")
        ? normalizedAgentId
        : normalizeAgentId(resolveDefaultAgentId(cfg));
    const storePath = resolveStorePath(cfg.session?.store, { agentId: normalizedAgentId });
    await purgeDeletedAgentSessionEntries({
      cfg,
      agentId: normalizedAgentId,
      storeAgentId,
      storePath,
    });
  } catch (err) {
    getLogger().debug("session store purge skipped during agent delete", err);
  }
}
