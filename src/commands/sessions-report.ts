import { getRuntimeConfig } from "../config/config.js";
import { buildSessionArtifactReport, loadSessionStore } from "../config/sessions.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { isRich, theme } from "../../packages/terminal-core/src/theme.js";
import {
  resolveSessionStoreTargetsOrExit,
  type SessionStoreTarget,
} from "./session-store-targets.js";

export type SessionsReportOptions = {
  store?: string;
  agent?: string;
  allAgents?: boolean;
  json?: boolean;
  largest?: string | number;
};

function parseLargestLimit(value: string | number | undefined, runtime: RuntimeEnv): number | null {
  if (value === undefined || value === "") {
    return 10;
  }
  const parsed = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    runtime.error("--largest must be a positive integer");
    runtime.exit(1);
    return null;
  }
  return parsed;
}

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

function renderReport(params: {
  target: SessionStoreTarget;
  report: Awaited<ReturnType<typeof buildSessionArtifactReport>>;
  showAgentHeader: boolean;
  runtime: RuntimeEnv;
}) {
  const rich = isRich();
  if (params.showAgentHeader) {
    params.runtime.log(
      rich ? theme.heading(`Agent: ${params.target.agentId}`) : `Agent: ${params.target.agentId}`,
    );
  }
  params.runtime.log(`Session store: ${params.report.storePath}`);
  params.runtime.log(
    `Entries/files/bytes: ${params.report.entryCount} entries, ${params.report.fileCount} files, ${formatBytes(params.report.totalBytes)}`,
  );
  params.runtime.log("");
  params.runtime.log(rich ? theme.heading("Artifact categories:") : "Artifact categories:");
  for (const category of params.report.categories) {
    params.runtime.log(
      `- ${category.category}: ${category.files} files, ${formatBytes(category.bytes)}`,
    );
  }
  if (params.report.largestFiles.length === 0) {
    return;
  }
  params.runtime.log("");
  params.runtime.log(rich ? theme.heading("Largest files:") : "Largest files:");
  for (const file of params.report.largestFiles) {
    params.runtime.log(`- ${formatBytes(file.sizeBytes)} ${file.category} ${file.name}`);
  }
}

export async function sessionsReportCommand(opts: SessionsReportOptions, runtime: RuntimeEnv) {
  const largestLimit = parseLargestLimit(opts.largest, runtime);
  if (largestLimit === null) {
    return;
  }
  const cfg = getRuntimeConfig();
  const targets = resolveSessionStoreTargetsOrExit({
    cfg,
    opts: {
      store: opts.store,
      agent: opts.agent,
      allAgents: opts.allAgents,
    },
    runtime,
  });
  if (!targets) {
    return;
  }

  const reports = [];
  for (const target of targets) {
    const store = loadSessionStore(target.storePath, { skipCache: true });
    const report = await buildSessionArtifactReport({
      storePath: target.storePath,
      store,
      largestLimit,
    });
    reports.push({
      agentId: target.agentId,
      ...report,
    });
  }

  if (opts.json) {
    if (reports.length === 1) {
      writeRuntimeJson(runtime, reports[0] ?? {});
      return;
    }
    writeRuntimeJson(runtime, {
      allAgents: true,
      stores: reports,
    });
    return;
  }

  for (let i = 0; i < reports.length; i += 1) {
    const report = reports[i];
    const target = targets[i];
    if (!report || !target) {
      continue;
    }
    if (i > 0) {
      runtime.log("");
    }
    renderReport({
      target,
      report,
      showAgentHeader: reports.length > 1,
      runtime,
    });
  }
}
