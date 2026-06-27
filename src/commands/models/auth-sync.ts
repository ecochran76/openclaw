import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { listAgentIds, resolveAgentDir } from "../../agents/agent-scope.js";
import { syncAuthProfile } from "../../agents/auth-profiles.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import type { RuntimeEnv } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";
import { loadModelsConfig } from "./load-config.js";
import { resolveKnownAgentId } from "./shared.js";

function parseTargetAgentIds(params: {
  raw?: string;
  knownAgentIds: string[];
  sourceAgentId: string;
}): string[] {
  const raw = params.raw?.trim();
  if (!raw || raw.toLowerCase() === "all") {
    return params.knownAgentIds.filter((agentId) => agentId !== params.sourceAgentId);
  }

  const requested = normalizeStringEntries(raw.split(",")).map((agentId) =>
    normalizeAgentId(agentId),
  );
  const deduped = [...new Set(requested)];
  const unknown = deduped.filter((agentId) => !params.knownAgentIds.includes(agentId));
  if (unknown.length > 0) {
    throw new Error(`Unknown agent id(s): ${unknown.join(", ")}.`);
  }
  return deduped.filter((agentId) => agentId !== params.sourceAgentId);
}

export async function modelsAuthSyncCommand(
  opts: {
    profileId?: string;
    fromAgent?: string;
    toAgents?: string;
    json?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const profileId = opts.profileId?.trim();
  if (!profileId) {
    throw new Error("Missing --profile-id.");
  }

  const cfg = await loadModelsConfig({ commandName: "models auth sync", runtime });
  const knownAgentIds = listAgentIds(cfg);
  const sourceAgentId =
    resolveKnownAgentId({ cfg, rawAgentId: opts.fromAgent }) ?? normalizeAgentId(DEFAULT_AGENT_ID);
  const targetAgentIds = parseTargetAgentIds({
    raw: opts.toAgents,
    knownAgentIds,
    sourceAgentId,
  });
  if (targetAgentIds.length === 0) {
    throw new Error("No target agents selected after excluding the source agent.");
  }

  const sourceAgentDir = resolveAgentDir(cfg, sourceAgentId);
  const targetAgentDirs = targetAgentIds.map((agentId) => resolveAgentDir(cfg, agentId));
  const result = await syncAuthProfile({
    profileId,
    sourceAgentDir,
    targetAgentDirs,
  });

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          profileId,
          sourceAgentId,
          sourceAgentDir,
          targetAgentIds,
          updatedAgentDirs: result.updatedAgentDirs,
          skippedAgentDirs: result.skippedAgentDirs,
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(`Profile: ${profileId}`);
  runtime.log(`Source: ${sourceAgentId} (${shortenHomePath(sourceAgentDir)})`);
  runtime.log(
    `Targets: ${targetAgentIds.map((agentId) => `${agentId} (${shortenHomePath(resolveAgentDir(cfg, agentId))})`).join(", ")}`,
  );
  runtime.log(`Updated: ${result.updatedAgentDirs.length}`);
  if (result.skippedAgentDirs.length > 0) {
    runtime.log(
      `Skipped: ${result.skippedAgentDirs.map((agentDir) => shortenHomePath(agentDir)).join(", ")}`,
    );
  }
}
