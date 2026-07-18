// Tracks session metadata mutations made by command handlers during a turn.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { HandleCommandsParams } from "./commands-types.js";

export type CommandSessionMetadataChange = {
  sessionKey: string;
  agentId?: string;
  reason: "command-metadata";
};

// Commands and reply dispatch can be loaded in separate runtime chunks. One
// process-wide WeakMap makes a consumed change disappear for every module copy.
const commandSessionMetadataChanges = resolveGlobalSingleton(
  Symbol.for("openclaw.commandSessionMetadataChanges.store"),
  () => new WeakMap<object, CommandSessionMetadataChange[]>(),
);
const commandSessionMetadataChangesKey: unique symbol = Symbol.for(
  "openclaw.commandSessionMetadataChanges",
);

type CommandSessionMetadataTarget = {
  [commandSessionMetadataChangesKey]?: CommandSessionMetadataChange[];
};

function readSymbolChanges(target: object): CommandSessionMetadataChange[] | undefined {
  try {
    return (target as CommandSessionMetadataTarget)[commandSessionMetadataChangesKey];
  } catch {
    return undefined;
  }
}

function attachSymbolChanges(target: object, changes: CommandSessionMetadataChange[]): void {
  try {
    if (!Object.isExtensible(target)) {
      return;
    }
    Object.defineProperty(target, commandSessionMetadataChangesKey, {
      configurable: true,
      value: changes,
    });
  } catch {
    // The WeakMap remains authoritative when a proxy rejects reflection or writes.
  }
}

function deleteSymbolChanges(target: object): void {
  try {
    delete (target as CommandSessionMetadataTarget)[commandSessionMetadataChangesKey];
  } catch {
    // Consuming the authoritative WeakMap entry must not fail on frozen or proxy targets.
  }
}

function addChange(target: object, change: CommandSessionMetadataChange): void {
  const changes = [
    ...(commandSessionMetadataChanges.get(target) ?? readSymbolChanges(target) ?? []),
  ];
  if (
    !changes.some(
      (candidate) =>
        candidate.sessionKey === change.sessionKey &&
        candidate.agentId === change.agentId &&
        candidate.reason === change.reason,
    )
  ) {
    changes.push(change);
  }
  commandSessionMetadataChanges.set(target, changes);
  attachSymbolChanges(target, changes);
}

export function markCommandSessionMetadataChanged(
  params: Pick<HandleCommandsParams, "agentId" | "ctx" | "rootCtx" | "sessionKey">,
): void {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return;
  }
  const change: CommandSessionMetadataChange = {
    sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    reason: "command-metadata",
  };
  const targets = new Set<object>();
  if (params.rootCtx && typeof params.rootCtx === "object") {
    targets.add(params.rootCtx);
  }
  if (params.ctx && typeof params.ctx === "object") {
    targets.add(params.ctx);
  }
  for (const target of targets) {
    addChange(target, change);
  }
}

export function takeCommandSessionMetadataChanges(
  target: object,
): CommandSessionMetadataChange[] | undefined {
  const changes = commandSessionMetadataChanges.get(target) ?? readSymbolChanges(target);
  commandSessionMetadataChanges.delete(target);
  deleteSymbolChanges(target);
  return changes && changes.length > 0 ? changes : undefined;
}

export function takeCommandSessionMetadataChangesFromTargets(
  targets: Iterable<object>,
): CommandSessionMetadataChange[] | undefined {
  const changes: CommandSessionMetadataChange[] = [];
  const seen = new Set<string>();
  for (const target of new Set(targets)) {
    for (const change of takeCommandSessionMetadataChanges(target) ?? []) {
      const key = JSON.stringify([change.sessionKey, change.agentId ?? null, change.reason]);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      changes.push(change);
    }
  }
  return changes.length > 0 ? changes : undefined;
}
