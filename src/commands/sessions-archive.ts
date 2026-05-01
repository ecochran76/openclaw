import { parseDurationMs } from "../cli/parse-duration.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  listSessionArtifactArchives,
  loadSessionArtifactArchive,
  pruneSessionArtifactArchives,
  type SessionArtifactArchivePruneResult,
  type SessionArtifactArchiveSummary,
} from "../config/sessions.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { isRich, theme } from "../../packages/terminal-core/src/theme.js";
import {
  resolveSessionStoreTargetsOrExit,
  type SessionStoreTarget,
} from "./session-store-targets.js";

export type SessionsArchiveListOptions = {
  store?: string;
  agent?: string;
  allAgents?: boolean;
  json?: boolean;
};

export type SessionsArchiveShowOptions = SessionsArchiveListOptions & {
  run?: string;
};

export type SessionsArchivePruneOptions = SessionsArchiveListOptions & {
  run?: string;
  olderThan?: string;
  dryRun?: boolean;
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function resolveTargets(
  opts: Pick<SessionsArchiveListOptions, "store" | "agent" | "allAgents">,
  runtime: RuntimeEnv,
): SessionStoreTarget[] | null {
  return resolveSessionStoreTargetsOrExit({
    cfg: getRuntimeConfig(),
    opts,
    runtime,
  });
}

function renderList(params: {
  target: SessionStoreTarget;
  summaries: SessionArtifactArchiveSummary[];
  showAgentHeader: boolean;
  runtime: RuntimeEnv;
}) {
  const rich = isRich();
  if (params.showAgentHeader) {
    params.runtime.log(
      rich ? theme.heading(`Agent: ${params.target.agentId}`) : `Agent: ${params.target.agentId}`,
    );
  }
  if (params.summaries.length === 0) {
    params.runtime.log("No artifact archives found.");
    return;
  }
  for (const summary of params.summaries) {
    params.runtime.log(
      `${summary.runId} ${summary.createdAt ?? "unknown"} ${summary.archivedFiles} files ${formatBytes(summary.archivedBytes)}`,
    );
  }
}

function parseOlderThan(value: string | undefined, runtime: RuntimeEnv): number | null | undefined {
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }
  try {
    return parseDurationMs(raw, { defaultUnit: "d" });
  } catch {
    runtime.error("--older-than must be a duration such as 7d, 12h, or 30m");
    runtime.exit(1);
    return null;
  }
}

export async function sessionsArchiveListCommand(
  opts: SessionsArchiveListOptions,
  runtime: RuntimeEnv,
) {
  const targets = resolveTargets(opts, runtime);
  if (!targets) {
    return;
  }
  const stores = [];
  for (const target of targets) {
    stores.push({
      agentId: target.agentId,
      storePath: target.storePath,
      archives: await listSessionArtifactArchives({ storePath: target.storePath }),
    });
  }
  if (opts.json) {
    if (stores.length === 1) {
      writeRuntimeJson(runtime, stores[0] ?? {});
      return;
    }
    writeRuntimeJson(runtime, { allAgents: true, stores });
    return;
  }
  for (let i = 0; i < stores.length; i += 1) {
    const store = stores[i];
    const target = targets[i];
    if (!store || !target) {
      continue;
    }
    if (i > 0) {
      runtime.log("");
    }
    renderList({
      target,
      summaries: store.archives,
      showAgentHeader: stores.length > 1,
      runtime,
    });
  }
}

export async function sessionsArchiveShowCommand(
  opts: SessionsArchiveShowOptions,
  runtime: RuntimeEnv,
) {
  const runId = opts.run?.trim();
  if (!runId) {
    runtime.error("--run is required");
    runtime.exit(1);
    return;
  }
  const targets = resolveTargets(opts, runtime);
  if (!targets) {
    return;
  }
  const results = [];
  for (const target of targets) {
    results.push({
      agentId: target.agentId,
      storePath: target.storePath,
      manifest: await loadSessionArtifactArchive({
        storePath: target.storePath,
        runId,
      }),
    });
  }
  if (opts.json) {
    if (results.length === 1) {
      writeRuntimeJson(runtime, results[0] ?? {});
      return;
    }
    writeRuntimeJson(runtime, { allAgents: true, stores: results });
    return;
  }
  for (const result of results) {
    if (!result.manifest) {
      runtime.log(`${result.agentId}: archive not found`);
      continue;
    }
    runtime.log(`Run: ${runId}`);
    runtime.log(`Created: ${result.manifest.createdAt}`);
    runtime.log(
      `Archived: ${result.manifest.archivedFiles} files, ${formatBytes(result.manifest.archivedBytes)}`,
    );
    runtime.log(`Categories: ${result.manifest.categories.join(", ")}`);
  }
}

function renderPruneResult(result: SessionArtifactArchivePruneResult, runtime: RuntimeEnv) {
  const verb = result.dryRun ? "Would remove" : "Removed";
  runtime.log(`${verb}: ${result.removedRuns} runs, ${formatBytes(result.removedBytes)}`);
  for (const run of result.runs) {
    runtime.log(`- ${run.runId}: ${formatBytes(run.archivedBytes)}`);
  }
}

export async function sessionsArchivePruneCommand(
  opts: SessionsArchivePruneOptions,
  runtime: RuntimeEnv,
) {
  const runId = opts.run?.trim();
  const olderThanMs = parseOlderThan(opts.olderThan, runtime);
  if (olderThanMs === null) {
    return;
  }
  if (!runId && olderThanMs == null) {
    runtime.error("archive prune requires --run or --older-than");
    runtime.exit(1);
    return;
  }
  const targets = resolveTargets(opts, runtime);
  if (!targets) {
    return;
  }
  const stores = [];
  for (const target of targets) {
    stores.push({
      agentId: target.agentId,
      storePath: target.storePath,
      result: await pruneSessionArtifactArchives({
        storePath: target.storePath,
        dryRun: opts.dryRun !== false,
        runId,
        olderThanMs,
      }),
    });
  }
  if (opts.json) {
    if (stores.length === 1) {
      writeRuntimeJson(runtime, stores[0] ?? {});
      return;
    }
    writeRuntimeJson(runtime, { allAgents: true, stores });
    return;
  }
  for (let i = 0; i < stores.length; i += 1) {
    const store = stores[i];
    if (!store) {
      continue;
    }
    if (i > 0) {
      runtime.log("");
    }
    if (stores.length > 1) {
      runtime.log(`Agent: ${store.agentId}`);
    }
    renderPruneResult(store.result, runtime);
  }
}
