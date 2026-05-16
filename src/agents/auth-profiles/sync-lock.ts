import fs from "node:fs";
import { isPidAlive } from "../../shared/pid-alive.js";
import { AUTH_STORE_LOCK_OPTIONS } from "./constants.js";

type SyncLockSnapshot = {
  raw: string;
  stat: fs.Stats;
  payload: Record<string, unknown> | null;
};

function readSyncLockSnapshot(lockPath: string): SyncLockSnapshot | null {
  try {
    const stat = fs.lstatSync(lockPath);
    const raw = fs.readFileSync(lockPath, "utf8");
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      payload =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {
      payload = null;
    }
    return { raw, stat, payload };
  } catch {
    return null;
  }
}

function syncLockSnapshotMatches(lockPath: string, snapshot: SyncLockSnapshot): boolean {
  try {
    const stat = fs.lstatSync(lockPath);
    return (
      stat.dev === snapshot.stat.dev &&
      stat.ino === snapshot.stat.ino &&
      fs.readFileSync(lockPath, "utf8") === snapshot.raw
    );
  } catch {
    return false;
  }
}

function isAuthStoreLockStale(snapshot: SyncLockSnapshot, nowMs = Date.now()): boolean {
  const pid = snapshot.payload?.pid;
  if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
    return !isPidAlive(pid);
  }
  const createdAt = snapshot.payload?.createdAt;
  if (typeof createdAt !== "string") {
    return nowMs - snapshot.stat.mtimeMs > AUTH_STORE_LOCK_OPTIONS.stale;
  }
  const createdAtMs = Date.parse(createdAt);
  return !Number.isFinite(createdAtMs) || nowMs - createdAtMs > AUTH_STORE_LOCK_OPTIONS.stale;
}

export function removeStaleAuthStoreSyncLock(lockPath: string): boolean {
  const snapshot = readSyncLockSnapshot(lockPath);
  if (!snapshot || !isAuthStoreLockStale(snapshot)) {
    return false;
  }
  if (!syncLockSnapshotMatches(lockPath, snapshot)) {
    return false;
  }
  try {
    fs.rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function releaseOwnedAuthStoreSyncLock(
  lockPath: string,
  snapshot: SyncLockSnapshot | null,
): void {
  if (!snapshot || !syncLockSnapshotMatches(lockPath, snapshot)) {
    return;
  }
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    // Best effort only.
  }
}

export function readOwnedAuthStoreSyncLock(lockPath: string): SyncLockSnapshot | null {
  return readSyncLockSnapshot(lockPath);
}
