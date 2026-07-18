// Per-agent SQLite storage for rebuildable provider usage policy state.
import path from "node:path";
import { normalizeAgentId } from "../routing/session-key.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { resolveUserPath } from "../utils.js";
import { sha256HexPrefix } from "./crypto-digest.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

const CACHE_SCOPE = "provider-usage";
const CACHE_KEY = "policy-state";

type AgentCacheDatabase = Pick<OpenClawAgentKyselyDatabase, "cache_entries">;

export function resolveProviderUsageCacheDatabasePath(agentDir: string): string {
  return path.resolve(resolveUserPath(agentDir), "openclaw-agent.sqlite");
}

export function resolveProviderUsageCacheOwnerId(params: {
  agentDir: string;
  agentId?: string;
}): string {
  if (params.agentId?.trim()) {
    return normalizeAgentId(params.agentId);
  }
  const resolvedAgentDir = path.dirname(resolveProviderUsageCacheDatabasePath(params.agentDir));
  if (path.basename(resolvedAgentDir) === "agent") {
    const parent = path.basename(path.dirname(resolvedAgentDir));
    if (parent) {
      return normalizeAgentId(parent);
    }
  }
  return `custom-${sha256HexPrefix(resolvedAgentDir, 12)}`;
}

export function readProviderUsageCacheJson(params: {
  agentDir: string;
  agentId: string;
}): string | null {
  const database = openOpenClawAgentDatabase({
    agentId: normalizeAgentId(params.agentId),
    path: resolveProviderUsageCacheDatabasePath(params.agentDir),
  });
  const kysely = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
  const row = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("cache_entries")
      .select("value_json")
      .where("scope", "=", CACHE_SCOPE)
      .where("key", "=", CACHE_KEY)
      .limit(1),
  ).rows[0];
  return row?.value_json ?? null;
}

export function updateProviderUsageCacheJson<T>(params: {
  agentDir: string;
  agentId: string;
  updatedAt: number;
  update: (currentJson: string | null) => { valueJson: string; result: T };
}): T {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      const kysely = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
      const current = executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("cache_entries")
          .select(["value_json", "updated_at"])
          .where("scope", "=", CACHE_SCOPE)
          .where("key", "=", CACHE_KEY)
          .limit(1),
      ).rows[0];
      const currentJson = current?.value_json ?? null;
      const nextUpdatedAt = Math.max(current?.updated_at ?? 0, params.updatedAt);
      const next = params.update(currentJson);
      executeSqliteQuerySync(
        database.db,
        kysely
          .insertInto("cache_entries")
          .values({
            scope: CACHE_SCOPE,
            key: CACHE_KEY,
            value_json: next.valueJson,
            blob: null,
            expires_at: null,
            updated_at: nextUpdatedAt,
          })
          .onConflict((conflict) =>
            conflict.columns(["scope", "key"]).doUpdateSet({
              value_json: next.valueJson,
              blob: null,
              expires_at: null,
              updated_at: nextUpdatedAt,
            }),
          ),
      );
      return next.result;
    },
    {
      agentId: normalizeAgentId(params.agentId),
      path: resolveProviderUsageCacheDatabasePath(params.agentDir),
    },
    { operationLabel: "provider-usage.policy-state.update" },
  );
}
