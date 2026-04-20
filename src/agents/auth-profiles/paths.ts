/**
 * Public path barrel for auth-profile stores.
 * Import through this file so JSON, SQLite, display, and lock paths stay on the
 * shared resolver contract.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { saveJsonFile } from "../../infra/json-file.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import { resolveDefaultAgentDir } from "../agent-scope-config.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { AUTH_PROFILE_FILENAME } from "./path-constants.js";
import type { AuthProfileSecretsStore } from "./types.js";
export {
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

export function ensureAuthStoreFile(pathname: string) {
  if (fs.existsSync(pathname)) {
    return;
  }
  const payload: AuthProfileSecretsStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  saveJsonFile(pathname, payload);
}
