/**
 * Public path barrel for auth-profile stores.
 * Import through this file so JSON, SQLite, display, and lock paths stay on the
 * shared resolver contract.
 */
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import { resolveDefaultAgentDir } from "../agent-scope-config.js";
import { AUTH_PROFILE_FILENAME } from "./path-constants.js";
export {
  resolveAuthStoreLockTargetPath,
  resolveAuthStatePath,
  resolveAuthStatePathForDisplay,
  resolveAuthStorePath,
  resolveAuthStorePathForDisplay,
  resolveLegacyAuthStorePath,
  resolveOAuthRefreshLockPath,
} from "./path-resolve.js";

export function resolveCanonicalAgentDir(agentId: string = DEFAULT_AGENT_ID): string {
  return path.join(resolveStateDir(), "agents", normalizeAgentId(agentId), "agent");
}

export function resolveMainAgentDir(): string {
  const override =
    process.env.OPENCLAW_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();
  return override ? resolveUserPath(override) : resolveDefaultAgentDir({});
}

export function resolveMainAuthStorePath(): string {
  return path.join(resolveMainAgentDir(), AUTH_PROFILE_FILENAME);
}
