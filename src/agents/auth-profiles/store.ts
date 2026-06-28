import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withFileLock } from "../../infra/file-lock.js";
import { cloneAuthProfileStore } from "./clone.js";
import { AUTH_STORE_LOCK_OPTIONS, AUTH_STORE_VERSION, log } from "./constants.js";
import {
  overlayExternalAuthProfiles,
  shouldPersistExternalAuthProfile,
  syncPersistedExternalCliAuthProfiles,
} from "./external-auth.js";
import type { ExternalCliAuthDiscovery } from "./external-cli-discovery.js";
import { isSafeToAdoptMainStoreOAuthIdentity } from "./oauth-shared.js";
import {
  resolveAuthStoreLockTargetPath,
  resolveAuthStorePath,
  resolveLegacyAuthStorePath,
  resolveMainAgentDir,
  resolveMainAuthStorePath,
} from "./paths.js";
import {
  applyLegacyAuthStore,
  buildPersistedAuthProfileSecretsStore,
  loadLegacyAuthProfileStore,
  loadPersistedAuthProfileStore,
  mergeAuthProfileStores,
  mergeOAuthFileIntoStore,
} from "./persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots as clearRuntimeAuthProfileStoreSnapshotsImpl,
  getRuntimeAuthProfileStoreSnapshot,
  hasRuntimeAuthProfileStoreSnapshot,
  replaceRuntimeAuthProfileStoreSnapshots as replaceRuntimeAuthProfileStoreSnapshotsImpl,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath, writePersistedAuthProfileStoreRaw } from "./sqlite.js";
import { savePersistedAuthProfileState } from "./state.js";
import {
  clearLoadedAuthStoreCache,
  readCachedAuthProfileStore,
  writeCachedAuthProfileStore,
} from "./store-cache.js";
import {
  readOwnedAuthStoreSyncLock,
  releaseOwnedAuthStoreSyncLock,
  removeStaleAuthStoreSyncLock,
} from "./sync-lock.js";
import type { AuthProfileStore } from "./types.js";

type LoadAuthProfileStoreOptions = {
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
  externalCli?: ExternalCliAuthDiscovery;
  readOnly?: boolean;
  syncExternalCli?: boolean;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
};

type SaveAuthProfileStoreOptions = {
  filterExternalAuthProfiles?: boolean;
  syncExternalCli?: boolean;
  preserveOrderProfileIds?: readonly string[];
  preserveStateProfileIds?: readonly string[];
};

type ResolvedExternalCliOverlayOptions = {
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
};

type ExternalCliSyncResult = {
  store: AuthProfileStore;
  cacheable: boolean;
};

function resolvePersistedLoadOptions(
  options: Pick<LoadAuthProfileStoreOptions, "allowKeychainPrompt"> | undefined,
): { allowKeychainPrompt?: boolean } {
  return {
    ...(options?.allowKeychainPrompt !== undefined
      ? { allowKeychainPrompt: options.allowKeychainPrompt }
      : {}),
  };
}

function isInheritedMainOAuthCredential(params: {
  agentDir?: string;
  profileId: string;
  credential: AuthProfileStore["profiles"][string];
}): boolean {
  if (!params.agentDir || params.credential.type !== "oauth") {
    return false;
  }
  const authPath = resolveAuthStorePath(params.agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (authPath === mainAuthPath) {
    return false;
  }

  const localStore = loadPersistedAuthProfileStore(params.agentDir);
  if (localStore?.profiles[params.profileId]) {
    return false;
  }

  const mainCredential = loadPersistedAuthProfileStore()?.profiles[params.profileId];
  return (
    mainCredential?.type === "oauth" &&
    (isDeepStrictEqual(mainCredential, params.credential) ||
      shouldUseMainOwnerForLocalOAuthCredential({
        local: params.credential,
        main: mainCredential,
      }))
  );
}

function shouldUseMainOwnerForLocalOAuthCredential(params: {
  local: AuthProfileStore["profiles"][string];
  main: AuthProfileStore["profiles"][string] | undefined;
}): boolean {
  if (params.local.type !== "oauth" || params.main?.type !== "oauth") {
    return false;
  }
  if (!isSafeToAdoptMainStoreOAuthIdentity(params.local, params.main)) {
    return false;
  }
  if (isDeepStrictEqual(params.local, params.main)) {
    return true;
  }
  return (
    Number.isFinite(params.main.expires) &&
    (!Number.isFinite(params.local.expires) || params.main.expires >= params.local.expires)
  );
}

function resolveRuntimeAuthProfileStore(
  agentDir?: string,
  options?: Pick<LoadAuthProfileStoreOptions, "allowKeychainPrompt">,
): AuthProfileStore | null {
  const mainKey = resolveAuthStorePath(undefined);
  const requestedKey = resolveAuthStorePath(agentDir);
  const mainStore = getRuntimeAuthProfileStoreSnapshot(undefined);
  const requestedStore = getRuntimeAuthProfileStoreSnapshot(agentDir);

  if (!agentDir || requestedKey === mainKey) {
    if (!mainStore) {
      return null;
    }
    return mainStore;
  }

  if (mainStore && requestedStore) {
    return mergeAuthProfileStores(mainStore, requestedStore);
  }
  if (requestedStore) {
    const persistedMainStore = loadAuthProfileStoreForAgentFile(undefined, {
      readOnly: true,
      syncExternalCli: false,
      ...resolvePersistedLoadOptions(options),
    });
    return mergeAuthProfileStores(persistedMainStore, requestedStore);
  }
  if (mainStore) {
    return mainStore;
  }

  return null;
}

function readAuthStoreMtimeMs(pathname: string): number | null {
  const sqlitePaths = [pathname, `${pathname}-wal`, `${pathname}-shm`, `${pathname}-journal`];
  let mtimeMs: number | null = null;
  for (const sqlitePath of sqlitePaths) {
    try {
      const candidate = fs.statSync(sqlitePath).mtimeMs;
      mtimeMs = mtimeMs === null ? candidate : Math.max(mtimeMs, candidate);
    } catch {
      // SQLite may update WAL/SHM/journal sidecars without touching the main DB
      // file before checkpoint; absent sidecars are normal outside active writes.
    }
  }
  return mtimeMs;
}

function acquireAuthStoreLockSync(lockTargetPath: string): (() => void) | null {
  const lockPath = `${lockTargetPath}.lock`;
  fs.mkdirSync(path.dirname(lockTargetPath), { recursive: true });

  try {
    const fd = fs.openSync(lockPath, "wx");
    const raw = `${JSON.stringify(
      { pid: process.pid, createdAt: new Date().toISOString() },
      null,
      2,
    )}\n`;
    try {
      fs.writeFileSync(fd, raw, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    const snapshot = readOwnedAuthStoreSyncLock(lockPath);
    return () => {
      releaseOwnedAuthStoreSyncLock(lockPath, snapshot);
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      if (removeStaleAuthStoreSyncLock(lockPath)) {
        return acquireAuthStoreLockSync(lockTargetPath);
      }
      return null;
    }
    throw err;
  }
}

function resolveExternalCliOverlayOptions(
  options: LoadAuthProfileStoreOptions | undefined,
): ResolvedExternalCliOverlayOptions {
  const discovery = options?.externalCli;
  if (!discovery) {
    return {
      ...(options?.allowKeychainPrompt !== undefined
        ? { allowKeychainPrompt: options.allowKeychainPrompt }
        : {}),
      ...(options?.config ? { config: options.config } : {}),
      ...(options?.externalCliProviderIds
        ? { externalCliProviderIds: options.externalCliProviderIds }
        : {}),
      ...(options?.externalCliProfileIds
        ? { externalCliProfileIds: options.externalCliProfileIds }
        : {}),
    };
  }
  if (discovery.mode === "none") {
    const config = discovery.config ?? options?.config;
    return {
      allowKeychainPrompt: false,
      ...(config ? { config } : {}),
      externalCliProviderIds: [],
      externalCliProfileIds: [],
    };
  }
  if (discovery.mode === "existing") {
    const allowKeychainPrompt = discovery.allowKeychainPrompt ?? options?.allowKeychainPrompt;
    const config = discovery.config ?? options?.config;
    return {
      ...(allowKeychainPrompt !== undefined ? { allowKeychainPrompt } : {}),
      ...(config ? { config } : {}),
    };
  }
  const allowKeychainPrompt = discovery.allowKeychainPrompt ?? options?.allowKeychainPrompt;
  const config = discovery.config ?? options?.config;
  return {
    ...(allowKeychainPrompt !== undefined ? { allowKeychainPrompt } : {}),
    ...(config ? { config } : {}),
    ...(discovery.providerIds ? { externalCliProviderIds: discovery.providerIds } : {}),
    ...(discovery.profileIds ? { externalCliProfileIds: discovery.profileIds } : {}),
  };
}

function markRuntimePersistedProfiles(store: AuthProfileStore): AuthProfileStore {
  const profileIds = Object.keys(store.profiles).toSorted();
  return profileIds.length > 0 ? { ...store, runtimePersistedProfileIds: profileIds } : store;
}

function maybeSyncPersistedExternalCliAuthProfiles(params: {
  store: AuthProfileStore;
  agentDir?: string;
  options?: LoadAuthProfileStoreOptions;
}): ExternalCliSyncResult {
  if (
    params.options?.readOnly === true ||
    params.options?.syncExternalCli === false ||
    process.env.OPENCLAW_AUTH_STORE_READONLY === "1"
  ) {
    return { store: params.store, cacheable: true };
  }
  const synced = syncPersistedExternalCliAuthProfiles(params.store, {
    agentDir: params.agentDir,
    ...resolveExternalCliOverlayOptions(params.options),
  });
  if (synced === params.store) {
    return { store: params.store, cacheable: true };
  }
  const changedProfiles = Object.entries(synced.profiles).filter(([profileId, credential]) => {
    const previous = params.store.profiles[profileId];
    return !isDeepStrictEqual(previous, credential);
  });
  if (changedProfiles.length === 0) {
    return { store: synced, cacheable: true };
  }

  const lockTargetPath = resolveAuthStoreLockTargetPath(params.agentDir);
  const release = acquireAuthStoreLockSync(lockTargetPath);
  if (!release) {
    log.warn("skipped persisted external cli auth sync because auth store is locked", {
      lockTargetPath,
    });
    return { store: params.store, cacheable: false };
  }
  try {
    const latestStore = loadPersistedAuthProfileStore(
      params.agentDir,
      resolvePersistedLoadOptions(params.options),
    ) ?? {
      version: AUTH_STORE_VERSION,
      profiles: {},
    };
    let changed = false;
    for (const [profileId, credential] of changedProfiles) {
      const previous = params.store.profiles[profileId];
      const latest = latestStore.profiles[profileId];
      if (!isDeepStrictEqual(latest, previous)) {
        log.debug("skipped persisted external cli auth sync for concurrently changed profile", {
          profileId,
        });
        continue;
      }
      latestStore.profiles[profileId] = credential;
      changed = true;
    }
    if (changed) {
      saveAuthProfileStore(latestStore, params.agentDir, {
        filterExternalAuthProfiles: false,
      });
      return { store: latestStore, cacheable: true };
    }
    return { store: latestStore, cacheable: true };
  } finally {
    release();
  }
}

function shouldKeepProfileInLocalStore(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: AuthProfileStore["profiles"][string];
  agentDir?: string;
  options?: SaveAuthProfileStoreOptions;
}): boolean {
  if (params.credential.type !== "oauth") {
    return true;
  }
  if (params.options?.filterExternalAuthProfiles === false) {
    return true;
  }
  if (
    isInheritedMainOAuthCredential({
      agentDir: params.agentDir,
      profileId: params.profileId,
      credential: params.credential,
    })
  ) {
    return false;
  }
  return shouldPersistExternalAuthProfile({
    store: params.store,
    profileId: params.profileId,
    credential: params.credential,
    agentDir: params.agentDir,
  });
}

function buildLocalAuthProfileStoreForSave(params: {
  store: AuthProfileStore;
  agentDir?: string;
  options?: SaveAuthProfileStoreOptions;
}): AuthProfileStore {
  const localStore = cloneAuthProfileStore(params.store);
  localStore.profiles = Object.fromEntries(
    Object.entries(localStore.profiles).filter(([profileId, credential]) =>
      shouldKeepProfileInLocalStore({
        store: params.store,
        profileId,
        credential,
        agentDir: params.agentDir,
        options: params.options,
      }),
    ),
  );
  // Runtime scheduling state can intentionally reference inherited main-agent
  // profiles; only the secret-bearing profile map is reduced to local entries.
  return localStore;
}

export async function updateAuthProfileStoreWithLock(params: {
  agentDir?: string;
  saveOptions?: SaveAuthProfileStoreOptions;
  updater: (store: AuthProfileStore) => boolean;
}): Promise<AuthProfileStore | null> {
  const lockTargetPath = resolveAuthStoreLockTargetPath(params.agentDir);

  try {
    return await withFileLock(lockTargetPath, AUTH_STORE_LOCK_OPTIONS, async () => {
      // Locked writers must reload from disk, not from any runtime snapshot.
      // Otherwise a live gateway can overwrite fresher CLI/config-auth writes
      // with stale in-memory auth state during usage/cooldown updates.
      const store = loadAuthProfileStoreForAgentFile(params.agentDir, { syncExternalCli: false });
      const shouldSave = params.updater(store);
      if (shouldSave) {
        saveAuthProfileStore(store, params.agentDir);
      }
      return store;
    });
  } catch {
    return null;
  }
}

export async function updateAuthProfileStoreFileWithLock(params: {
  agentDir?: string;
  saveOptions?: SaveAuthProfileStoreOptions;
  updater: (store: AuthProfileStore) => boolean;
}): Promise<AuthProfileStore | null> {
  const lockTargetPath = resolveAuthStoreLockTargetPath(params.agentDir);

  try {
    return await withFileLock(lockTargetPath, AUTH_STORE_LOCK_OPTIONS, async () => {
      const store = loadAuthProfileStoreForAgentFile(params.agentDir, {
        readOnly: true,
        allowKeychainPrompt: false,
      });
      const shouldSave = params.updater(store);
      if (shouldSave) {
        saveAuthProfileStore(store, params.agentDir, params.saveOptions);
      }
      return store;
    });
  } catch {
    return null;
  }
}

export function loadAuthProfileStore(): AuthProfileStore {
  const asStore = loadPersistedAuthProfileStore();
  if (asStore) {
    return overlayExternalAuthProfiles(asStore);
  }
  const legacy = loadLegacyAuthProfileStore();
  if (legacy) {
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {},
    };
    applyLegacyAuthStore(store, legacy);
    return overlayExternalAuthProfiles(store);
  }

  const store: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
  return overlayExternalAuthProfiles(store);
}

export function loadAuthProfileStoreForAgentFile(
  agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  const readOnly = options?.readOnly === true;
  const cachePath = resolveAuthProfileDatabasePath(agentDir);
  const authMtimeMs = readAuthStoreMtimeMs(cachePath);
  const stateMtimeMs = authMtimeMs;
  if (!readOnly) {
    const cached = readCachedAuthProfileStore({
      authPath: cachePath,
      authMtimeMs,
      stateMtimeMs,
    });
    if (cached) {
      return cached;
    }
  }
  const asStore = loadPersistedAuthProfileStore(agentDir, {
    ...resolvePersistedLoadOptions(options),
  });
  if (asStore) {
    const synced = maybeSyncPersistedExternalCliAuthProfiles({
      store: markRuntimePersistedProfiles(asStore),
      agentDir,
      options,
    });
    if (!readOnly && synced.cacheable) {
      writeCachedAuthProfileStore({
        authPath: cachePath,
        authMtimeMs: readAuthStoreMtimeMs(cachePath),
        stateMtimeMs: readAuthStoreMtimeMs(cachePath),
        store: synced.store,
      });
    }
    return synced.store;
  }

  const legacy = loadLegacyAuthProfileStore(agentDir);
  const store: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  if (legacy) {
    applyLegacyAuthStore(store, legacy);
  }

  const mergedOAuth = mergeOAuthFileIntoStore(store);
  const forceReadOnly = process.env.OPENCLAW_AUTH_STORE_READONLY === "1";
  const shouldWrite = !readOnly && !forceReadOnly && (legacy !== null || mergedOAuth);
  if (shouldWrite) {
    saveAuthProfileStore(store, agentDir);
  }

  // PR #368: legacy auth.json could get re-migrated from other agent dirs,
  // overwriting fresh OAuth creds with stale tokens (fixes #363). Delete only
  // after we've successfully written the canonical SQLite profile store.
  if (shouldWrite && legacy !== null) {
    const legacyPath = resolveLegacyAuthStorePath(agentDir);
    try {
      fs.unlinkSync(legacyPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log.warn("failed to delete legacy auth.json after migration", {
          err,
          legacyPath,
        });
      }
    }
  }

  const synced = maybeSyncPersistedExternalCliAuthProfiles({
    store: markRuntimePersistedProfiles(store),
    agentDir,
    options,
  });

  if (!readOnly && synced.cacheable) {
    writeCachedAuthProfileStore({
      authPath: cachePath,
      authMtimeMs: readAuthStoreMtimeMs(cachePath),
      stateMtimeMs: readAuthStoreMtimeMs(cachePath),
      store: synced.store,
    });
  }
  return synced.store;
}

export function loadAuthProfileStoreForRuntime(
  agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  const store = loadAuthProfileStoreForAgentFile(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveMainAuthStorePath();
  const externalCli = resolveExternalCliOverlayOptions(options);
  if (!agentDir || authPath === mainAuthPath) {
    return overlayExternalAuthProfiles(store, {
      agentDir,
      ...externalCli,
    });
  }

  const mainStore = loadAuthProfileStoreForAgentFile(resolveMainAgentDir(), options);
  return overlayExternalAuthProfiles(mergeAuthProfileStores(mainStore, store), {
    agentDir,
    ...externalCli,
  });
}

export function loadAuthProfileStoreForSecretsRuntime(
  agentDir?: string,
  options?: Pick<LoadAuthProfileStoreOptions, "externalCli">,
): AuthProfileStore {
  // Secrets runtime snapshots should store the raw per-agent auth file content.
  // Merging main+agent happens in resolveRuntimeAuthProfileStore(), and storing
  // pre-merged snapshots can cause stale main data to override fresher updates.
  const store = loadAuthProfileStoreForAgentFile(agentDir, {
    readOnly: true,
    allowKeychainPrompt: false,
  });
  return overlayExternalAuthProfiles(store, {
    agentDir,
    ...resolveExternalCliOverlayOptions(options),
  });
}

export function loadAuthProfileStoreWithoutExternalProfiles(
  agentDir?: string,
  loadOptions?: Pick<LoadAuthProfileStoreOptions, "allowKeychainPrompt">,
): AuthProfileStore {
  const options: LoadAuthProfileStoreOptions = {
    readOnly: true,
    allowKeychainPrompt: loadOptions?.allowKeychainPrompt ?? false,
  };
  const store = loadAuthProfileStoreForAgentFile(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveMainAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgentFile(resolveMainAgentDir(), options);
  return mergeAuthProfileStores(mainStore, store);
}

function hydrateResolvedSecretsFromRuntime(params: {
  target: AuthProfileStore;
  runtime: AuthProfileStore;
}): void {
  for (const [profileId, runtimeCred] of Object.entries(params.runtime.profiles)) {
    const targetCred = params.target.profiles[profileId];
    if (!targetCred) {
      continue;
    }

    if (targetCred.type === "api_key" && runtimeCred.type === "api_key") {
      if (
        targetCred.keyRef &&
        typeof runtimeCred.key === "string" &&
        runtimeCred.key.trim().length > 0
      ) {
        params.target.profiles[profileId] = { ...targetCred, key: runtimeCred.key };
      }
      continue;
    }

    if (targetCred.type === "token" && runtimeCred.type === "token") {
      if (
        targetCred.tokenRef &&
        typeof runtimeCred.token === "string" &&
        runtimeCred.token.trim().length > 0
      ) {
        params.target.profiles[profileId] = { ...targetCred, token: runtimeCred.token };
      }
    }
  }
}

export function ensureAuthProfileStore(
  agentDir?: string,
  options?: Pick<
    LoadAuthProfileStoreOptions,
    | "allowKeychainPrompt"
    | "config"
    | "externalCli"
    | "externalCliProviderIds"
    | "externalCliProfileIds"
    | "readOnly"
    | "syncExternalCli"
  >,
): AuthProfileStore {
  const externalCli = resolveExternalCliOverlayOptions(options);
  return overlayExternalAuthProfiles(
    ensureAuthProfileStoreWithoutExternalProfiles(agentDir, options),
    {
      agentDir,
      ...externalCli,
    },
  );
}

export function ensureAuthProfileStoreWithoutExternalProfiles(
  agentDir?: string,
  options?: Pick<
    LoadAuthProfileStoreOptions,
    "allowKeychainPrompt" | "readOnly" | "syncExternalCli"
  >,
): AuthProfileStore {
  const effectiveOptions: LoadAuthProfileStoreOptions = { ...options };
  const runtimeStore = resolveRuntimeAuthProfileStore(agentDir, effectiveOptions);
  if (runtimeStore) {
    // Runtime snapshots hold resolved secret values but can become stale when
    // another process mutates the SQLite profile store. Re-read disk and let disk
    // metadata (order/usageStats/new profiles) win, then hydrate resolved
    // secrets from the runtime snapshot.
    const diskStore = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
    const merged = mergeAuthProfileStores(runtimeStore, diskStore);
    hydrateResolvedSecretsFromRuntime({ target: merged, runtime: runtimeStore });
    return merged;
  }
  const store = loadAuthProfileStoreForAgentFile(agentDir, effectiveOptions);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgentFile(resolveMainAgentDir(), effectiveOptions);
  return mergeAuthProfileStores(mainStore, store);
}

export function findPersistedAuthProfileCredential(params: {
  agentDir?: string;
  profileId: string;
}): AuthProfileStore["profiles"][string] | undefined {
  const requestedStore = loadPersistedAuthProfileStore(params.agentDir);
  const requestedProfile = requestedStore?.profiles[params.profileId];
  if (requestedProfile || !params.agentDir) {
    return requestedProfile;
  }

  const requestedPath = resolveAuthStorePath(params.agentDir);
  const mainPath = resolveAuthStorePath();
  if (requestedPath === mainPath) {
    return requestedProfile;
  }

  return loadPersistedAuthProfileStore()?.profiles[params.profileId];
}

export function resolvePersistedAuthProfileOwnerAgentDir(params: {
  agentDir?: string;
  profileId: string;
}): string | undefined {
  if (!params.agentDir) {
    return undefined;
  }
  const requestedStore = loadPersistedAuthProfileStore(params.agentDir);
  const requestedPath = resolveAuthStorePath(params.agentDir);
  const mainPath = resolveAuthStorePath();
  if (requestedPath === mainPath) {
    return undefined;
  }

  const mainStore = loadPersistedAuthProfileStore();
  const requestedProfile = requestedStore?.profiles[params.profileId];
  if (requestedProfile) {
    return shouldUseMainOwnerForLocalOAuthCredential({
      local: requestedProfile,
      main: mainStore?.profiles[params.profileId],
    })
      ? undefined
      : params.agentDir;
  }

  return mainStore?.profiles[params.profileId] ? undefined : params.agentDir;
}

export function ensureAuthProfileStoreForLocalUpdate(agentDir?: string): AuthProfileStore {
  const options: LoadAuthProfileStoreOptions = { syncExternalCli: false };
  const store = loadAuthProfileStoreForAgentFile(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveMainAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgentFile(resolveMainAgentDir(), {
    readOnly: true,
    syncExternalCli: false,
  });
  return mergeAuthProfileStores(mainStore, store);
}

export { hasAnyAuthProfileStoreSource } from "./source-check.js";

export function replaceRuntimeAuthProfileStoreSnapshots(
  entries: Array<{ agentDir?: string; store: AuthProfileStore }>,
): void {
  replaceRuntimeAuthProfileStoreSnapshotsImpl(entries);
}

export function clearRuntimeAuthProfileStoreSnapshots(): void {
  clearRuntimeAuthProfileStoreSnapshotsImpl();
  clearLoadedAuthStoreCache();
}

export function saveAuthProfileStore(
  store: AuthProfileStore,
  agentDir?: string,
  options?: SaveAuthProfileStoreOptions,
): void {
  const cachePath = resolveAuthProfileDatabasePath(agentDir);
  const localStore = buildLocalAuthProfileStoreForSave({ store, agentDir, options });
  const payload = buildPersistedAuthProfileSecretsStore(localStore);
  writePersistedAuthProfileStoreRaw(payload, agentDir);
  savePersistedAuthProfileState(localStore, agentDir);
  const cachedStore: AuthProfileStore = {
    ...localStore,
    profiles: payload.profiles,
  };
  writeCachedAuthProfileStore({
    authPath: cachePath,
    authMtimeMs: readAuthStoreMtimeMs(cachePath),
    stateMtimeMs: readAuthStoreMtimeMs(cachePath),
    store: cachedStore,
  });
  if (hasRuntimeAuthProfileStoreSnapshot(agentDir)) {
    setRuntimeAuthProfileStoreSnapshot(cachedStore, agentDir);
  }
}
