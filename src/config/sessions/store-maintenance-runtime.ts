// Runtime maintenance config reads current config and falls back for narrow helpers/tests.
import { normalizeAgentId } from "../../routing/session-key.js";
import { getRuntimeConfig } from "../config.js";
import type { SessionMaintenanceConfig } from "../types.base.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveAgentIdFromSessionStorePath } from "./paths.js";
import {
  resolveMaintenanceConfigFromInput,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";

function resolveAgentSessionMaintenance(
  cfg: OpenClawConfig,
  agentId?: string,
): SessionMaintenanceConfig | undefined {
  const normalizedAgentId = agentId ? normalizeAgentId(agentId) : undefined;
  if (!normalizedAgentId) {
    return undefined;
  }
  const entry = cfg.agents?.list?.find((agent) => normalizeAgentId(agent.id) === normalizedAgentId);
  return entry?.sessionMaintenance;
}

export function resolveMaintenanceConfig(): ResolvedSessionMaintenanceConfig {
  let maintenance: SessionMaintenanceConfig | undefined;
  try {
    maintenance = getRuntimeConfig().session?.maintenance;
  } catch {
    // Config may not be available in narrow test/runtime helpers.
  }
  return resolveMaintenanceConfigFromInput(maintenance);
}

export function resolveMaintenanceConfigForAgent(
  agentId?: string,
): ResolvedSessionMaintenanceConfig {
  try {
    const cfg = getRuntimeConfig();
    return resolveMaintenanceConfigFromInput({
      ...cfg.session?.maintenance,
      ...resolveAgentSessionMaintenance(cfg, agentId),
    });
  } catch {
    // Config may not be available in narrow test/runtime helpers.
    return resolveMaintenanceConfigFromInput();
  }
}

export function resolveMaintenanceConfigForStorePath(
  storePath: string,
): ResolvedSessionMaintenanceConfig {
  return resolveMaintenanceConfigForAgent(resolveAgentIdFromSessionStorePath(storePath));
}
