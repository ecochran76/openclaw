import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveOAuthDir, resolveOAuthPath, resolveStateDir } from "../../config/paths.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import { AUTH_STORE_VERSION, log } from "./constants.js";
import {
  isLegacyOAuthRef,
  loadLegacyOAuthSidecarMaterial,
  type LegacyOAuthSecretMaterial,
} from "./legacy-oauth-sidecar.js";
import {
  hasOAuthIdentity,
  hasUsableOAuthCredential,
  isSafeToAdoptMainStoreOAuthIdentity,
  normalizeAuthEmailToken,
  normalizeAuthIdentityToken,
} from "./oauth-shared.js";
import { resolveAuthStorePath, resolveLegacyAuthStorePath } from "./paths.js";
import {
  coerceAuthProfileState,
  loadPersistedAuthProfileState,
  mergeAuthProfileState,
} from "./state.js";
import {
  readOwnedAuthStoreSyncLock,
  releaseOwnedAuthStoreSyncLock,
  removeStaleAuthStoreSyncLock,
} from "./sync-lock.js";
import type {
  AuthProfileCredential,
  AuthProfileFailureReason,
  AuthProfileState,
  AuthProfileSecretsStore,
  AuthProfileStore,
  OAuthCredential,
  OAuthCredentialRef,
  OAuthCredentials,
  ProfileUsageStats,
} from "./types.js";

export type LegacyAuthStore = Record<string, AuthProfileCredential>;

type LoadPersistedAuthProfileStoreOptions = {
  allowKeychainPrompt?: boolean;
  repairOAuthSecretPayloads?: boolean;
  resolveLegacyOAuthSidecars?: boolean;
  rewriteInlineOAuthSecrets?: boolean;
};

type MergeAuthProfileStoresOptions = {
  preserveBaseRuntimeExternalProfiles?: boolean;
};

type CredentialRejectReason = "non_object" | "invalid_type" | "missing_provider";
type RejectedCredentialEntry = { key: string; reason: CredentialRejectReason };

const AUTH_PROFILE_TYPES = new Set<AuthProfileCredential["type"]>(["api_key", "oauth", "token"]);
const LEGACY_OAUTH_REF_PROVIDER = "openai-codex";
const OAUTH_PROFILE_SECRET_REF_SOURCE = "openclaw-credentials" as const;
const OAUTH_PROFILE_SECRET_DIRNAME = "auth-profiles";
const OAUTH_PROFILE_SECRET_VERSION = 1;
const OAUTH_PROFILE_SECRET_ALGORITHM = "aes-256-gcm" as const;
const OAUTH_PROFILE_SECRET_KEY_ENV = "OPENCLAW_AUTH_PROFILE_SECRET_KEY";
const OAUTH_PROFILE_SECRET_KEYCHAIN_SERVICE = "OpenClaw Auth Profile Secrets";
const OAUTH_PROFILE_SECRET_KEYCHAIN_ACCOUNT = "oauth-profile-master-key";
const OAUTH_PROFILE_SECRET_KEY_FILE_NAME = "auth-profile-secret-key";
const runtimeLegacyOAuthSidecarCredentials = new WeakSet<OAuthCredential>();
const runtimeLegacyOAuthSidecarMaterialFingerprints = new Map<string, string>();

type OAuthProfileSecretMaterial = {
  access?: string;
  refresh?: string;
  idToken?: string;
};

type OAuthProfileEncryptedSecretPayload = {
  algorithm: typeof OAUTH_PROFILE_SECRET_ALGORITHM;
  iv: string;
  tag: string;
  ciphertext: string;
};

type OAuthProfileSecretPayload = OAuthProfileSecretMaterial & {
  version: typeof OAUTH_PROFILE_SECRET_VERSION;
  profileId: string;
  provider: string;
  encrypted?: OAuthProfileEncryptedSecretPayload;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalCredentialString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? value : undefined;
}

function hasInlineOAuthTokenMaterial(credential: OAuthCredential): boolean {
  return [credential.access, credential.refresh, credential.idToken].some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

function buildRuntimeLegacyOAuthSidecarFingerprintKey(params: {
  storeKey?: string;
  profileId: string;
}): string {
  return `${params.storeKey ?? ""}\0${params.profileId}`;
}

function buildLegacyOAuthSecretMaterialFingerprint(
  material: Pick<OAuthCredential, "access" | "refresh" | "idToken">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([material.access ?? null, material.refresh ?? null, material.idToken ?? null]),
    )
    .digest("hex");
}

function shouldPersistOAuthWithoutInlineSecrets(
  credential: AuthProfileCredential,
): credential is OAuthCredential {
  // Legacy oauthRef sidecars are read-only migration inputs. New saves keep
  // OAuth material inline so doctor --fix does not immediately recreate refs.
  void credential;
  return false;
}

function resolveOAuthProfileSecretId(params: { agentDir?: string; profileId: string }): string {
  return createHash("sha256")
    .update(`${resolveAuthStorePath(params.agentDir)}\0${params.profileId}`)
    .digest("hex")
    .slice(0, 32);
}

function resolveOAuthProfileSecretPath(ref: OAuthCredentialRef): string {
  return path.join(resolveOAuthDir(), OAUTH_PROFILE_SECRET_DIRNAME, `${ref.id}.json`);
}

function isOAuthProfileSecretRef(value: unknown): value is OAuthCredentialRef {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<OAuthCredentialRef>;
  return (
    record.source === OAUTH_PROFILE_SECRET_REF_SOURCE &&
    record.provider === "openai-codex" &&
    typeof record.id === "string" &&
    /^[a-f0-9]{32}$/.test(record.id)
  );
}

function resolveOAuthProfileSecretRef(params: {
  agentDir?: string;
  profileId: string;
}): OAuthCredentialRef {
  return {
    source: OAUTH_PROFILE_SECRET_REF_SOURCE,
    provider: "openai-codex",
    id: resolveOAuthProfileSecretId(params),
  };
}

function normalizeOAuthProfileSecretMaterial(
  credential: Partial<Pick<OAuthCredential, "access" | "refresh" | "idToken">>,
): OAuthProfileSecretMaterial | null {
  const material: OAuthProfileSecretMaterial = {
    ...(typeof credential.access === "string" && credential.access.trim()
      ? { access: credential.access }
      : {}),
    ...(typeof credential.refresh === "string" && credential.refresh.trim()
      ? { refresh: credential.refresh }
      : {}),
    ...(typeof credential.idToken === "string" && credential.idToken.trim()
      ? { idToken: credential.idToken }
      : {}),
  };
  return Object.keys(material).length > 0 ? material : null;
}

function buildOAuthProfileSecretAad(params: {
  ref: OAuthCredentialRef;
  profileId: string;
  provider: string;
}): Buffer {
  return Buffer.from(`${params.ref.id}\0${params.profileId}\0${params.provider}`, "utf8");
}

function readMacOAuthProfileSecretKey(): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  try {
    return execFileSync(
      "security",
      [
        "find-generic-password",
        "-s",
        OAUTH_PROFILE_SECRET_KEYCHAIN_SERVICE,
        "-a",
        OAUTH_PROFILE_SECRET_KEYCHAIN_ACCOUNT,
        "-w",
      ],
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  } catch {
    return undefined;
  }
}

function createMacOAuthProfileSecretKey(): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  const generated = randomBytes(32).toString("base64url");
  try {
    execFileSync(
      "security",
      [
        "add-generic-password",
        "-U",
        "-s",
        OAUTH_PROFILE_SECRET_KEYCHAIN_SERVICE,
        "-a",
        OAUTH_PROFILE_SECRET_KEYCHAIN_ACCOUNT,
        "-w",
        generated,
      ],
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );
    return generated;
  } catch (err) {
    log.warn("failed to create oauth profile secret keychain entry", { err });
    return undefined;
  }
}

function isPathInsideOrEqual(parentDir: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  return Array.from(new Set(paths.filter((entry): entry is string => Boolean(entry))));
}

function resolveFallbackOAuthProfileSecretKeyFileCandidates(): string[] {
  if (process.platform === "win32") {
    const home = process.env.USERPROFILE?.trim() || os.homedir();
    const root =
      process.env.APPDATA?.trim() || (home ? path.join(home, "AppData", "Roaming") : undefined);
    return uniquePaths([
      root ? path.join(root, "OpenClaw", OAUTH_PROFILE_SECRET_KEY_FILE_NAME) : undefined,
      home
        ? path.join(home, ".openclaw-auth-profile-secrets", OAUTH_PROFILE_SECRET_KEY_FILE_NAME)
        : undefined,
    ]);
  }
  if (process.platform === "darwin") {
    const home = process.env.HOME?.trim() || os.homedir();
    return uniquePaths([
      home
        ? path.join(
            home,
            "Library",
            "Application Support",
            "OpenClaw",
            OAUTH_PROFILE_SECRET_KEY_FILE_NAME,
          )
        : undefined,
      home
        ? path.join(home, ".openclaw-auth-profile-secrets", OAUTH_PROFILE_SECRET_KEY_FILE_NAME)
        : undefined,
    ]);
  }
  const home = process.env.HOME?.trim() || os.homedir();
  const root =
    process.env.XDG_CONFIG_HOME?.trim() || (home ? path.join(home, ".config") : undefined);
  return uniquePaths([
    root ? path.join(root, "openclaw", OAUTH_PROFILE_SECRET_KEY_FILE_NAME) : undefined,
    home
      ? path.join(home, ".openclaw-auth-profile-secrets", OAUTH_PROFILE_SECRET_KEY_FILE_NAME)
      : undefined,
  ]);
}

function resolveFallbackOAuthProfileSecretKeyFilePath(): string | undefined {
  const stateDir = resolveStateDir();
  return resolveFallbackOAuthProfileSecretKeyFileCandidates().find(
    (candidate) => !isPathInsideOrEqual(stateDir, candidate),
  );
}

function readFallbackOAuthProfileSecretKeyFileAtPath(keyPath: string): string | undefined {
  try {
    const value = fs.readFileSync(keyPath, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function readFallbackOAuthProfileSecretKeyFile(): string | undefined {
  const keyPath = resolveFallbackOAuthProfileSecretKeyFilePath();
  return keyPath ? readFallbackOAuthProfileSecretKeyFileAtPath(keyPath) : undefined;
}

function createFallbackOAuthProfileSecretKeyFile(): string | undefined {
  const keyPath = resolveFallbackOAuthProfileSecretKeyFilePath();
  if (!keyPath) {
    return undefined;
  }
  const generated = randomBytes(32).toString("base64url");
  let fd: number | undefined;
  try {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    fd = fs.openSync(keyPath, "wx", 0o600);
    fs.writeFileSync(fd, `${generated}\n`, "utf8");
    try {
      fs.chmodSync(keyPath, 0o600);
    } catch {
      // Best effort only.
    }
    return generated;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      return readFallbackOAuthProfileSecretKeyFileAtPath(keyPath);
    }
    log.warn("failed to create oauth profile secret key file", { err });
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best effort only.
      }
    }
  }
}

function shouldUseMacKeychainForOAuthProfileSecrets(): boolean {
  return process.platform === "darwin" && process.env.VITEST !== "true";
}

function resolveOAuthProfileSecretKeySeed(options?: { create?: boolean }): string | undefined {
  const externalKey = process.env[OAUTH_PROFILE_SECRET_KEY_ENV]?.trim();
  if (externalKey) {
    return externalKey;
  }
  if (process.env.NODE_ENV === "test" && process.env.VITEST === "true") {
    return "openclaw-test-oauth-profile-secret-key";
  }
  if (shouldUseMacKeychainForOAuthProfileSecrets()) {
    const keychainKey =
      readMacOAuthProfileSecretKey() ??
      (options?.create === true ? createMacOAuthProfileSecretKey() : undefined);
    if (keychainKey) {
      return keychainKey;
    }
  }
  return (
    readFallbackOAuthProfileSecretKeyFile() ??
    (options?.create === true ? createFallbackOAuthProfileSecretKeyFile() : undefined)
  );
}

function buildOAuthProfileSecretKey(options?: { create?: boolean }): Buffer | null {
  const externalKey = resolveOAuthProfileSecretKeySeed(options);
  return externalKey
    ? createHash("sha256").update(`openclaw:auth-profile-oauth:${externalKey}`).digest()
    : null;
}

function encryptOAuthProfileSecretMaterial(params: {
  ref: OAuthCredentialRef;
  profileId: string;
  provider: string;
  material: OAuthProfileSecretMaterial;
}): OAuthProfileEncryptedSecretPayload {
  const key = buildOAuthProfileSecretKey({ create: true });
  if (!key) {
    throw new Error("OAuth profile secret key source is required to persist OAuth profile secrets");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(OAUTH_PROFILE_SECRET_ALGORITHM, key, iv);
  cipher.setAAD(buildOAuthProfileSecretAad(params));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(params.material), "utf8"),
    cipher.final(),
  ]);
  return {
    algorithm: OAUTH_PROFILE_SECRET_ALGORITHM,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptOAuthProfileSecretMaterial(params: {
  ref: OAuthCredentialRef;
  profileId: string;
  provider: string;
  encrypted: OAuthProfileEncryptedSecretPayload;
}): OAuthProfileSecretMaterial | null {
  const key = buildOAuthProfileSecretKey();
  if (!key) {
    return null;
  }
  try {
    const decipher = createDecipheriv(
      OAUTH_PROFILE_SECRET_ALGORITHM,
      key,
      Buffer.from(params.encrypted.iv, "base64url"),
    );
    decipher.setAAD(buildOAuthProfileSecretAad(params));
    decipher.setAuthTag(Buffer.from(params.encrypted.tag, "base64url"));
    const raw = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(params.encrypted.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8"),
    ) as unknown;
    return normalizeOAuthProfileSecretMaterial(raw as OAuthProfileSecretMaterial);
  } catch {
    return null;
  }
}

function writeOAuthProfileSecretMaterial(params: {
  ref: OAuthCredentialRef;
  profileId: string;
  provider: string;
  material: OAuthProfileSecretMaterial;
}): void {
  const secretPath = resolveOAuthProfileSecretPath(params.ref);
  fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  saveJsonFile(secretPath, {
    version: OAUTH_PROFILE_SECRET_VERSION,
    profileId: params.profileId,
    provider: params.provider,
    encrypted: encryptOAuthProfileSecretMaterial(params),
  } satisfies OAuthProfileSecretPayload);
  try {
    fs.chmodSync(secretPath, 0o600);
  } catch {
    // Best effort only.
  }
}

function persistOAuthProfileSecrets(params: {
  agentDir?: string;
  profileId: string;
  credential: OAuthCredential;
}): OAuthCredentialRef | undefined {
  const expectedRef = resolveOAuthProfileSecretRef(params);
  const existingRef = isOAuthProfileSecretRef(params.credential.oauthRef)
    ? params.credential.oauthRef
    : undefined;
  const targetRef = existingRef?.id === expectedRef.id ? existingRef : expectedRef;
  if (!hasInlineOAuthTokenMaterial(params.credential)) {
    return existingRef?.id === expectedRef.id ? existingRef : undefined;
  }
  const material = normalizeOAuthProfileSecretMaterial(params.credential);
  if (!material) {
    return existingRef?.id === expectedRef.id ? existingRef : undefined;
  }
  writeOAuthProfileSecretMaterial({
    ref: targetRef,
    profileId: params.profileId,
    provider: params.credential.provider,
    material,
  });
  return targetRef;
}

function omitInlineOAuthSecrets(params: {
  agentDir?: string;
  profileId: string;
  credential: OAuthCredential;
}): AuthProfileCredential {
  const oauthRef = persistOAuthProfileSecrets(params);
  if (!oauthRef) {
    return params.credential;
  }
  const sanitized = { ...params.credential } as Record<string, unknown>;
  delete sanitized.access;
  delete sanitized.refresh;
  delete sanitized.idToken;
  sanitized.oauthRef = oauthRef;
  return sanitized as AuthProfileCredential;
}

function hasInlinePersistableOAuthSecrets(credential: AuthProfileCredential): boolean {
  return (
    shouldPersistOAuthWithoutInlineSecrets(credential) && hasInlineOAuthTokenMaterial(credential)
  );
}

function normalizeOptionalCredentialBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeExpiryField(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeCredentialMetadata(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const metadata: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      metadata[key] = entry;
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function normalizeSecretBackedField(params: {
  entry: Record<string, unknown>;
  valueField: "key" | "token";
  refField: "keyRef" | "tokenRef";
}): void {
  const value = params.entry[params.valueField];
  if (value == null || typeof value === "string") {
    return;
  }
  const ref = coerceSecretRef(value);
  if (ref && !coerceSecretRef(params.entry[params.refField])) {
    params.entry[params.refField] = ref;
  }
  delete params.entry[params.valueField];
}

function normalizeCommonCredentialFields(entry: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    provider: typeof entry.provider === "string" ? normalizeProviderId(entry.provider) : "",
  };
  const copyToAgents = normalizeOptionalCredentialBoolean(entry.copyToAgents);
  if (copyToAgents !== undefined) {
    normalized.copyToAgents = copyToAgents;
  }
  const email = normalizeOptionalCredentialString(entry.email);
  if (email !== undefined) {
    normalized.email = email;
  }
  const displayName = normalizeOptionalCredentialString(entry.displayName);
  if (displayName !== undefined) {
    normalized.displayName = displayName;
  }
  return normalized;
}

function normalizeRawCredentialEntry(raw: Record<string, unknown>): Partial<AuthProfileCredential> {
  const entry = { ...raw } as Record<string, unknown>;
  if (!("type" in entry) && typeof entry["mode"] === "string") {
    entry["type"] = entry["mode"];
  }
  if (entry.type === "apiKey") {
    entry.type = "api_key";
  }
  if (!("key" in entry) && typeof entry["apiKey"] === "string") {
    entry["key"] = entry["apiKey"];
  }
  normalizeSecretBackedField({ entry, valueField: "key", refField: "keyRef" });
  normalizeSecretBackedField({ entry, valueField: "token", refField: "tokenRef" });
  if (entry.type === "api_key") {
    const normalized: Record<string, unknown> = {
      type: "api_key",
      ...normalizeCommonCredentialFields(entry),
    };
    const key = normalizeOptionalCredentialString(entry.key);
    const keyRef = coerceSecretRef(entry.keyRef);
    const metadata = normalizeCredentialMetadata(entry.metadata);
    if (key !== undefined) {
      normalized.key = key;
    }
    if (keyRef) {
      normalized.keyRef = keyRef;
    }
    if (metadata) {
      normalized.metadata = metadata;
    }
    return normalized as Partial<AuthProfileCredential>;
  }
  if (entry.type === "token") {
    const normalized: Record<string, unknown> = {
      type: "token",
      ...normalizeCommonCredentialFields(entry),
    };
    const token = normalizeOptionalCredentialString(entry.token);
    const tokenRef = coerceSecretRef(entry.tokenRef);
    const expires = normalizeExpiryField(entry.expires);
    if (token !== undefined) {
      normalized.token = token;
    }
    if (tokenRef) {
      normalized.tokenRef = tokenRef;
    }
    if (expires !== undefined) {
      normalized.expires = expires;
    }
    return normalized as Partial<AuthProfileCredential>;
  }
  if (entry.type === "oauth") {
    const normalized: Record<string, unknown> = {
      type: "oauth",
      ...normalizeCommonCredentialFields(entry),
    };
    for (const field of [
      "access",
      "refresh",
      "idToken",
      "clientId",
      "enterpriseUrl",
      "projectId",
      "accountId",
      "chatgptPlanType",
    ] as const) {
      const value = normalizeOptionalCredentialString(entry[field]);
      if (value !== undefined) {
        normalized[field] = value;
      }
    }
    const expires = normalizeExpiryField(entry.expires);
    if (expires !== undefined) {
      normalized.expires = expires;
    }
    return normalized;
  }
  return entry as Partial<AuthProfileCredential>;
}

function parseCredentialEntry(
  raw: unknown,
  fallbackProvider?: string,
): { ok: true; credential: AuthProfileCredential } | { ok: false; reason: CredentialRejectReason } {
  if (!isRecord(raw)) {
    return { ok: false, reason: "non_object" };
  }
  const typed = normalizeRawCredentialEntry(raw);
  if (!AUTH_PROFILE_TYPES.has(typed.type as AuthProfileCredential["type"])) {
    return { ok: false, reason: "invalid_type" };
  }
  const provider = typed.provider ?? fallbackProvider;
  const normalizedProvider = typeof provider === "string" ? normalizeProviderId(provider) : "";
  if (!normalizedProvider) {
    return { ok: false, reason: "missing_provider" };
  }
  return {
    ok: true,
    credential: {
      ...typed,
      provider: normalizedProvider,
    } as AuthProfileCredential,
  };
}

function warnRejectedCredentialEntries(source: string, rejected: RejectedCredentialEntry[]): void {
  if (rejected.length === 0) {
    return;
  }
  const reasons = rejected.reduce<Partial<Record<CredentialRejectReason, number>>>(
    (acc, current) => {
      acc[current.reason] = (acc[current.reason] ?? 0) + 1;
      return acc;
    },
    {},
  );
  log.warn("ignored invalid auth profile entries during store load", {
    source,
    dropped: rejected.length,
    reasons,
    keys: rejected.slice(0, 10).map((entry) => entry.key),
  });
}

function resolveLegacyOAuthSidecarCredential(params: {
  profileId: string;
  raw: unknown;
  credential: AuthProfileCredential;
  storeKey?: string;
  options?: LoadPersistedAuthProfileStoreOptions;
}): AuthProfileCredential {
  if (
    params.credential.type !== "oauth" ||
    normalizeProviderId(params.credential.provider) !== LEGACY_OAUTH_REF_PROVIDER ||
    hasInlineOAuthTokenMaterial(params.credential) ||
    !isRecord(params.raw) ||
    !isLegacyOAuthRef(params.raw.oauthRef)
  ) {
    return params.credential;
  }
  // Read-only compatibility for #79006 sidecar OAuth profiles. Do not add
  // new writers or OS-level Keychain creation here; doctor remains the path
  // that migrates users back to canonical inline OAuth credentials.
  const material = loadLegacyOAuthSidecarMaterial({
    ref: params.raw.oauthRef,
    profileId: params.profileId,
    provider: params.credential.provider,
    allowKeychainPrompt: params.options?.allowKeychainPrompt,
  });
  if (!material) {
    return params.credential;
  }
  const credential = {
    ...params.credential,
    ...(material.access ? { access: material.access } : {}),
    ...(material.refresh ? { refresh: material.refresh } : {}),
    ...(material.idToken ? { idToken: material.idToken } : {}),
  };
  runtimeLegacyOAuthSidecarCredentials.add(credential);
  runtimeLegacyOAuthSidecarMaterialFingerprints.set(
    buildRuntimeLegacyOAuthSidecarFingerprintKey({
      storeKey: params.storeKey,
      profileId: params.profileId,
    }),
    buildLegacyOAuthSecretMaterialFingerprint(credential),
  );
  return credential;
}

export function isRuntimeLegacyOAuthSidecarCredential(
  credential: AuthProfileCredential | undefined,
): boolean {
  return credential?.type === "oauth" && runtimeLegacyOAuthSidecarCredentials.has(credential);
}

export function matchesRuntimeLegacyOAuthSidecarMaterial(params: {
  authPath?: string;
  profileId: string;
  credential: AuthProfileCredential | undefined;
}): boolean {
  if (params.credential?.type !== "oauth") {
    return false;
  }
  if (runtimeLegacyOAuthSidecarCredentials.has(params.credential)) {
    return true;
  }
  const fingerprint = runtimeLegacyOAuthSidecarMaterialFingerprints.get(
    buildRuntimeLegacyOAuthSidecarFingerprintKey({
      storeKey: params.authPath,
      profileId: params.profileId,
    }),
  );
  return (
    fingerprint !== undefined &&
    fingerprint === buildLegacyOAuthSecretMaterialFingerprint(params.credential)
  );
}

function coerceLegacyAuthStore(raw: unknown): LegacyAuthStore | null {
  if (!isRecord(raw)) {
    return null;
  }
  const record = raw;
  if ("profiles" in record) {
    return null;
  }
  const entries: LegacyAuthStore = {};
  const rejected: RejectedCredentialEntry[] = [];
  for (const [key, value] of Object.entries(record)) {
    const parsed = parseCredentialEntry(value, key);
    if (!parsed.ok) {
      rejected.push({ key, reason: parsed.reason });
      continue;
    }
    entries[key] = parsed.credential;
  }
  warnRejectedCredentialEntries("auth.json", rejected);
  return Object.keys(entries).length > 0 ? entries : null;
}

export function coercePersistedAuthProfileStore(
  raw: unknown,
  options?: LoadPersistedAuthProfileStoreOptions,
  storeKey?: string,
): AuthProfileStore | null {
  if (!isRecord(raw)) {
    return null;
  }
  const record = raw;
  if (!isRecord(record.profiles)) {
    return null;
  }
  const profiles = record.profiles;
  const normalized: Record<string, AuthProfileCredential> = {};
  const rejected: RejectedCredentialEntry[] = [];
  for (const [key, value] of Object.entries(profiles)) {
    const parsed = parseCredentialEntry(value);
    if (!parsed.ok) {
      rejected.push({ key, reason: parsed.reason });
      continue;
    }
    normalized[key] =
      options?.resolveLegacyOAuthSidecars === true
        ? resolveLegacyOAuthSidecarCredential({
            profileId: key,
            raw: value,
            credential: parsed.credential,
            storeKey,
            options,
          })
        : parsed.credential;
  }
  warnRejectedCredentialEntries("auth-profiles.json", rejected);
  const version = Number(record.version ?? AUTH_STORE_VERSION);
  return {
    version: Number.isFinite(version) && version > 0 ? version : AUTH_STORE_VERSION,
    profiles: normalized,
    ...coerceAuthProfileState(record),
  };
}

function mergeRecord<T>(
  base?: Record<string, T>,
  override?: Record<string, T>,
): Record<string, T> | undefined {
  if (!base && !override) {
    return undefined;
  }
  if (!base) {
    return { ...override };
  }
  if (!override) {
    return { ...base };
  }
  return { ...base, ...override };
}

function dedupeMergedProfileOrder(profileIds: string[]): string[] {
  return Array.from(new Set(profileIds));
}

function normalizeRuntimeProfileIds(raw: readonly string[] | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = dedupeMergedProfileOrder(
    raw.flatMap((entry) => {
      const profileId = normalizeOptionalCredentialString(entry);
      return profileId ? [profileId] : [];
    }),
  );
  return normalized.length > 0 ? normalized : [];
}

function normalizeAuthStoreStateForMerge(store: AuthProfileStore): AuthProfileState {
  return coerceAuthProfileState(store);
}

function resolveCredentialProviderKey(
  profileId: string,
  credential?: AuthProfileCredential,
): string {
  const provider = credential?.provider;
  const providerKey = typeof provider === "string" ? normalizeProviderId(provider) : "";
  if (providerKey) {
    return providerKey;
  }
  const separatorIndex = profileId.indexOf(":");
  return separatorIndex > 0 ? normalizeProviderId(profileId.slice(0, separatorIndex)) : "";
}

function groupProfileIdsByProvider(
  profiles: Record<string, AuthProfileCredential>,
): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const [profileId, credential] of Object.entries(profiles)) {
    const providerKey = resolveCredentialProviderKey(profileId, credential);
    if (!providerKey) {
      continue;
    }
    grouped[providerKey] ??= [];
    grouped[providerKey].push(profileId);
  }
  return grouped;
}

function normalizeProviderStateKeys<T>(
  state: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (!state) {
    return undefined;
  }
  const normalized: Record<string, T> = {};
  for (const [provider, value] of Object.entries(state)) {
    const providerKey = normalizeProviderId(provider);
    if (!providerKey) {
      continue;
    }
    normalized[providerKey] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function buildMergedProfileOrder(params: {
  base: AuthProfileStore;
  override: AuthProfileStore;
  profiles: Record<string, AuthProfileCredential>;
  removedProfileIds: ReadonlySet<string>;
  synthesizeProfileOrder: boolean;
}): AuthProfileState["order"] {
  const baseState = normalizeAuthStoreStateForMerge(params.base);
  const overrideState = normalizeAuthStoreStateForMerge(params.override);
  const baseProfileIdsByProvider = groupProfileIdsByProvider(params.base.profiles);
  const overrideProfileIdsByProvider = groupProfileIdsByProvider(params.override.profiles);
  const providerKeys = new Set<string>([
    ...Object.keys(baseState.order ?? {}),
    ...Object.keys(overrideState.order ?? {}),
    ...(params.synthesizeProfileOrder ? Object.keys(baseProfileIdsByProvider) : []),
    ...(params.synthesizeProfileOrder ? Object.keys(overrideProfileIdsByProvider) : []),
  ]);
  const order: Record<string, string[]> = {};
  for (const providerKey of providerKeys) {
    const explicitOverride = overrideState.order?.[providerKey];
    const merged = explicitOverride
      ? explicitOverride
      : params.synthesizeProfileOrder
        ? [
            ...(overrideProfileIdsByProvider[providerKey] ?? []),
            ...(baseState.order?.[providerKey] ?? baseProfileIdsByProvider[providerKey] ?? []),
          ]
        : (baseState.order?.[providerKey] ?? []);
    const normalized = dedupeMergedProfileOrder(
      merged.filter((profileId) => !params.removedProfileIds.has(profileId)),
    );
    if (normalized.length > 0) {
      order[providerKey] = normalized;
    }
  }
  return Object.keys(order).length > 0 ? order : undefined;
}

function pruneRemovedLastGood(
  lastGood: AuthProfileState["lastGood"],
  removedProfileIds: ReadonlySet<string>,
): AuthProfileState["lastGood"] {
  if (!lastGood) {
    return undefined;
  }
  const normalized = Object.fromEntries(
    Object.entries(lastGood).filter(([, profileId]) => !removedProfileIds.has(profileId)),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function buildMergedRuntimePersistedProfileIds(params: {
  base: AuthProfileStore;
  override: AuthProfileStore;
  removedProfileIds: ReadonlySet<string>;
}): string[] | undefined {
  const overrideIds = normalizeRuntimeProfileIds(params.override.runtimePersistedProfileIds) ?? [];
  const baseIds = normalizeRuntimeProfileIds(params.base.runtimePersistedProfileIds) ?? [];
  const overrideProfileIds = new Set(Object.keys(params.override.profiles));
  const merged = dedupeMergedProfileOrder([
    ...overrideIds.filter((profileId) => !params.removedProfileIds.has(profileId)),
    ...baseIds.filter(
      (profileId) => !overrideProfileIds.has(profileId) && !params.removedProfileIds.has(profileId),
    ),
  ]);
  return merged.length > 0 ? merged : undefined;
}

function buildMergedRuntimeExternalProfileIds(params: {
  base: AuthProfileStore;
  override: AuthProfileStore;
  preserveBaseRuntimeExternalProfiles: boolean;
}): { ids?: string[]; authoritative?: true; removedProfileIds: Set<string> } {
  const baseIds = normalizeRuntimeProfileIds(params.base.runtimeExternalProfileIds) ?? [];
  const overrideIds = normalizeRuntimeProfileIds(params.override.runtimeExternalProfileIds);
  if (
    params.preserveBaseRuntimeExternalProfiles &&
    params.base.runtimeExternalProfileIdsAuthoritative === true
  ) {
    return {
      ids: baseIds,
      authoritative: true,
      removedProfileIds: new Set(),
    };
  }
  if (params.override.runtimeExternalProfileIdsAuthoritative === true) {
    const ids = overrideIds ?? [];
    const overrideProfileIds = new Set(Object.keys(params.override.profiles));
    const kept = new Set(ids);
    const removedProfileIds = new Set(
      baseIds.filter((profileId) => !kept.has(profileId) && !overrideProfileIds.has(profileId)),
    );
    return { ids, authoritative: true, removedProfileIds };
  }
  const merged =
    overrideIds !== undefined ? dedupeMergedProfileOrder([...baseIds, ...overrideIds]) : baseIds;
  return {
    ids: merged.length > 0 ? merged : undefined,
    authoritative: params.base.runtimeExternalProfileIdsAuthoritative === true ? true : undefined,
    removedProfileIds: new Set(),
  };
}

function hasComparableOAuthIdentityConflict(
  existing: OAuthCredential,
  candidate: OAuthCredential,
): boolean {
  const existingAccountId = normalizeAuthIdentityToken(existing.accountId);
  const candidateAccountId = normalizeAuthIdentityToken(candidate.accountId);
  if (
    existingAccountId !== undefined &&
    candidateAccountId !== undefined &&
    existingAccountId !== candidateAccountId
  ) {
    return true;
  }

  const existingEmail = normalizeAuthEmailToken(existing.email);
  const candidateEmail = normalizeAuthEmailToken(candidate.email);
  return (
    existingEmail !== undefined && candidateEmail !== undefined && existingEmail !== candidateEmail
  );
}

function isLegacyDefaultOAuthProfile(profileId: string, credential: OAuthCredential): boolean {
  return profileId === `${normalizeProviderId(credential.provider)}:default`;
}

function isNewerUsableOAuthCredential(
  existing: OAuthCredential,
  candidate: OAuthCredential,
): boolean {
  if (!hasUsableOAuthCredential(candidate)) {
    return false;
  }
  if (!hasUsableOAuthCredential(existing)) {
    return true;
  }
  return (
    Number.isFinite(candidate.expires) &&
    (!Number.isFinite(existing.expires) || candidate.expires > existing.expires)
  );
}

const AUTH_INVALIDATION_REASONS = new Set<AuthProfileFailureReason>([
  "auth",
  "auth_permanent",
  "session_expired",
]);

function hasAuthInvalidationSignal(stats: ProfileUsageStats | undefined): boolean {
  if (!stats) {
    return false;
  }
  if (
    (stats.cooldownReason && AUTH_INVALIDATION_REASONS.has(stats.cooldownReason)) ||
    (stats.disabledReason && AUTH_INVALIDATION_REASONS.has(stats.disabledReason))
  ) {
    return true;
  }
  return Object.entries(stats.failureCounts ?? {}).some(
    ([reason, count]) =>
      AUTH_INVALIDATION_REASONS.has(reason as AuthProfileFailureReason) &&
      typeof count === "number" &&
      count > 0,
  );
}

function isProfileReferencedByAuthState(store: AuthProfileStore, profileId: string): boolean {
  if (Object.values(store.order ?? {}).some((profileIds) => profileIds.includes(profileId))) {
    return true;
  }
  return Object.values(store.lastGood ?? {}).some((value) => value === profileId);
}

function resolveProviderAuthStateValue<T>(
  values: Record<string, T> | undefined,
  providerKey: string,
): T | undefined {
  if (!values) {
    return undefined;
  }
  for (const [key, value] of Object.entries(values)) {
    if (normalizeProviderId(key) === providerKey) {
      return value;
    }
  }
  return undefined;
}

function findMainStoreOAuthReplacementForInvalidatedProfile(params: {
  base: AuthProfileStore;
  override: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
}): string | undefined {
  const providerKey = normalizeProviderId(params.credential.provider);
  if (
    providerKey !== "openai-codex" ||
    !isProfileReferencedByAuthState(params.override, params.profileId) ||
    !hasAuthInvalidationSignal(params.override.usageStats?.[params.profileId])
  ) {
    return undefined;
  }

  const candidates = Object.entries(params.base.profiles)
    .flatMap(([profileId, credential]): Array<[string, OAuthCredential]> => {
      if (
        profileId === params.profileId ||
        credential.type !== "oauth" ||
        normalizeProviderId(credential.provider) !== providerKey ||
        !hasUsableOAuthCredential(credential)
      ) {
        return [];
      }
      return [[profileId, credential]];
    })
    .toSorted(([leftId, leftCredential], [rightId, rightCredential]) => {
      const leftExpires = Number.isFinite(leftCredential.expires) ? leftCredential.expires : 0;
      const rightExpires = Number.isFinite(rightCredential.expires) ? rightCredential.expires : 0;
      if (rightExpires !== leftExpires) {
        return rightExpires - leftExpires;
      }
      return leftId.localeCompare(rightId);
    });
  if (candidates.length === 0) {
    return undefined;
  }

  const candidateIds = new Set(candidates.map(([profileId]) => profileId));
  const orderedProfileId = resolveProviderAuthStateValue(params.base.order, providerKey)?.find(
    (profileId) => candidateIds.has(profileId),
  );
  if (orderedProfileId) {
    return orderedProfileId;
  }

  const lastGoodProfileId = resolveProviderAuthStateValue(params.base.lastGood, providerKey);
  if (lastGoodProfileId && candidateIds.has(lastGoodProfileId)) {
    return lastGoodProfileId;
  }

  return candidates.length === 1 ? candidates[0]?.[0] : undefined;
}

function findMainStoreOAuthReplacement(params: {
  base: AuthProfileStore;
  legacyProfileId: string;
  legacyCredential: OAuthCredential;
}): string | undefined {
  const providerKey = normalizeProviderId(params.legacyCredential.provider);
  const candidates = Object.entries(params.base.profiles)
    .flatMap(([profileId, credential]): Array<[string, OAuthCredential]> => {
      if (
        profileId === params.legacyProfileId ||
        credential.type !== "oauth" ||
        normalizeProviderId(credential.provider) !== providerKey
      ) {
        return [];
      }
      return [[profileId, credential]];
    })
    .filter(([, credential]) => isNewerUsableOAuthCredential(params.legacyCredential, credential))
    .toSorted(([leftId, leftCredential], [rightId, rightCredential]) => {
      const leftExpires = Number.isFinite(leftCredential.expires) ? leftCredential.expires : 0;
      const rightExpires = Number.isFinite(rightCredential.expires) ? rightCredential.expires : 0;
      if (rightExpires !== leftExpires) {
        return rightExpires - leftExpires;
      }
      return leftId.localeCompare(rightId);
    });

  const exactIdentityCandidates = candidates.filter(([, credential]) =>
    isSafeToAdoptMainStoreOAuthIdentity(params.legacyCredential, credential),
  );
  if (exactIdentityCandidates.length > 0) {
    if (!hasOAuthIdentity(params.legacyCredential) && exactIdentityCandidates.length > 1) {
      return undefined;
    }
    return exactIdentityCandidates[0]?.[0];
  }

  if (hasUsableOAuthCredential(params.legacyCredential)) {
    return undefined;
  }
  const fallbackCandidates = candidates.filter(
    ([, credential]) => !hasComparableOAuthIdentityConflict(params.legacyCredential, credential),
  );
  if (fallbackCandidates.length !== 1) {
    return undefined;
  }
  return fallbackCandidates[0]?.[0];
}

function replaceMergedProfileReferences(params: {
  store: AuthProfileStore;
  base: AuthProfileStore;
  replacements: Map<string, string>;
}): AuthProfileStore {
  const { store, base, replacements } = params;
  if (replacements.size === 0) {
    return store;
  }

  const profiles = { ...store.profiles };
  for (const [legacyProfileId, replacementProfileId] of replacements) {
    const baseCredential = base.profiles[legacyProfileId];
    if (baseCredential) {
      profiles[legacyProfileId] = baseCredential;
    } else {
      delete profiles[legacyProfileId];
    }
    const replacementBaseCredential = base.profiles[replacementProfileId];
    const replacementCredential = profiles[replacementProfileId];
    if (
      replacementBaseCredential &&
      (!replacementCredential ||
        (replacementCredential.type === "oauth" &&
          replacementBaseCredential.type === "oauth" &&
          isNewerUsableOAuthCredential(replacementCredential, replacementBaseCredential)))
    ) {
      profiles[replacementProfileId] = replacementBaseCredential;
    }
  }

  const order = store.order
    ? Object.fromEntries(
        Object.entries(store.order).map(([provider, profileIds]) => [
          provider,
          dedupeMergedProfileOrder(
            profileIds.map((profileId) => replacements.get(profileId) ?? profileId),
          ),
        ]),
      )
    : undefined;

  const lastGood = store.lastGood
    ? Object.fromEntries(
        Object.entries(store.lastGood).map(([provider, profileId]) => [
          provider,
          replacements.get(profileId) ?? profileId,
        ]),
      )
    : undefined;

  const usageStats = store.usageStats ? { ...store.usageStats } : undefined;
  if (usageStats) {
    for (const legacyProfileId of replacements.keys()) {
      const baseStats = base.usageStats?.[legacyProfileId];
      if (baseStats) {
        usageStats[legacyProfileId] = baseStats;
      } else {
        delete usageStats[legacyProfileId];
      }
    }
  }

  return {
    ...store,
    profiles,
    ...(order && Object.keys(order).length > 0 ? { order } : { order: undefined }),
    ...(lastGood && Object.keys(lastGood).length > 0 ? { lastGood } : { lastGood: undefined }),
    ...(usageStats && Object.keys(usageStats).length > 0
      ? { usageStats }
      : { usageStats: undefined }),
  };
}

function reconcileMainStoreOAuthProfileDrift(params: {
  base: AuthProfileStore;
  override: AuthProfileStore;
  merged: AuthProfileStore;
}): AuthProfileStore {
  const replacements = new Map<string, string>();
  for (const [profileId, credential] of Object.entries(params.override.profiles)) {
    if (credential.type !== "oauth") {
      continue;
    }
    const replacementProfileId = isLegacyDefaultOAuthProfile(profileId, credential)
      ? findMainStoreOAuthReplacement({
          base: params.base,
          legacyProfileId: profileId,
          legacyCredential: credential,
        })
      : findMainStoreOAuthReplacementForInvalidatedProfile({
          base: params.base,
          override: params.override,
          profileId,
          credential,
        });
    if (replacementProfileId) {
      replacements.set(profileId, replacementProfileId);
    }
  }
  return replaceMergedProfileReferences({
    store: params.merged,
    base: params.base,
    replacements,
  });
}

export function mergeAuthProfileStores(
  base: AuthProfileStore,
  override: AuthProfileStore,
  options?: MergeAuthProfileStoresOptions,
): AuthProfileStore {
  const hasRuntimeExternalOverride =
    override.runtimeExternalProfileIds !== undefined ||
    override.runtimeExternalProfileIdsAuthoritative === true;
  const hasRuntimePersistedOverride = override.runtimePersistedProfileIds !== undefined;
  if (
    Object.keys(override.profiles).length === 0 &&
    !override.order &&
    !override.lastGood &&
    !override.usageStats &&
    !hasRuntimeExternalOverride &&
    !hasRuntimePersistedOverride
  ) {
    return base;
  }
  const runtimeExternal = buildMergedRuntimeExternalProfileIds({
    base,
    override,
    preserveBaseRuntimeExternalProfiles: options?.preserveBaseRuntimeExternalProfiles === true,
  });
  const removedProfileIds = runtimeExternal.removedProfileIds;
  const profiles: Record<string, AuthProfileCredential> = {};
  for (const [profileId, credential] of Object.entries(override.profiles)) {
    profiles[profileId] = credential;
  }
  for (const [profileId, credential] of Object.entries(base.profiles)) {
    if (profileId in profiles || removedProfileIds.has(profileId)) {
      continue;
    }
    profiles[profileId] = credential;
  }

  const baseState = normalizeAuthStoreStateForMerge(base);
  const overrideState = normalizeAuthStoreStateForMerge(override);
  const lastGood = pruneRemovedLastGood(
    mergeRecord(
      normalizeProviderStateKeys(baseState.lastGood),
      normalizeProviderStateKeys(overrideState.lastGood),
    ),
    removedProfileIds,
  );
  const usageStats = mergeRecord(baseState.usageStats, overrideState.usageStats);
  for (const profileId of removedProfileIds) {
    delete usageStats?.[profileId];
  }
  const merged: AuthProfileStore = {
    version: Math.max(base.version, override.version ?? base.version),
    profiles,
    order: buildMergedProfileOrder({
      base,
      override,
      profiles,
      removedProfileIds,
      synthesizeProfileOrder: options?.preserveBaseRuntimeExternalProfiles === true,
    }),
    lastGood,
    usageStats: usageStats && Object.keys(usageStats).length > 0 ? usageStats : undefined,
    runtimePersistedProfileIds: buildMergedRuntimePersistedProfileIds({
      base,
      override,
      removedProfileIds,
    }),
    runtimeExternalProfileIds: runtimeExternal.ids,
    runtimeExternalProfileIdsAuthoritative: runtimeExternal.authoritative,
  };
  return reconcileMainStoreOAuthProfileDrift({ base, override, merged });
}

export function buildPersistedAuthProfileSecretsStore(
  store: AuthProfileStore,
  shouldPersistProfile?: (params: {
    profileId: string;
    credential: AuthProfileCredential;
  }) => boolean,
  options?: {
    agentDir?: string;
    existingRaw?: unknown;
    redactOAuthSecrets?: boolean;
    runtimeLegacyOAuthSidecarProfileIds?: ReadonlySet<string>;
  },
): AuthProfileSecretsStore {
  const profiles = Object.fromEntries(
    Object.entries(store.profiles).flatMap(([profileId, credential]) => {
      if (shouldPersistProfile && !shouldPersistProfile({ profileId, credential })) {
        return [];
      }
      if (credential.type === "api_key" && credential.keyRef && credential.key !== undefined) {
        const sanitized = { ...credential } as Record<string, unknown>;
        delete sanitized.key;
        return [[profileId, sanitized]];
      }
      if (credential.type === "token" && credential.tokenRef && credential.token !== undefined) {
        const sanitized = { ...credential } as Record<string, unknown>;
        delete sanitized.token;
        return [[profileId, sanitized]];
      }
      if (
        options?.redactOAuthSecrets === true &&
        shouldPersistOAuthWithoutInlineSecrets(credential)
      ) {
        return [
          [
            profileId,
            omitInlineOAuthSecrets({
              agentDir: options?.agentDir,
              profileId,
              credential,
            }),
          ],
        ];
      }
      return [[profileId, credential]];
    }),
  ) as AuthProfileSecretsStore["profiles"];

  const payload: AuthProfileSecretsStore = {
    version: AUTH_STORE_VERSION,
    profiles,
  };
  return preserveLegacyOAuthRefsForDoctorMigration(payload, options);
}

function preserveLegacyOAuthRefsForDoctorMigration(
  payload: AuthProfileSecretsStore,
  options:
    | {
        existingRaw?: unknown;
        runtimeLegacyOAuthSidecarProfileIds?: ReadonlySet<string>;
      }
    | undefined,
): AuthProfileSecretsStore {
  const existingRaw = options?.existingRaw;
  if (!isRecord(existingRaw) || !isRecord(existingRaw.profiles)) {
    return payload;
  }
  let profiles: AuthProfileSecretsStore["profiles"] | undefined;
  for (const [profileId, rawProfile] of Object.entries(existingRaw.profiles)) {
    if (!isRecord(rawProfile) || !isLegacyOAuthRef(rawProfile.oauthRef)) {
      continue;
    }
    const credential = payload.profiles[profileId];
    if (
      credential?.type !== "oauth" ||
      normalizeProviderId(credential.provider) !== LEGACY_OAUTH_REF_PROVIDER
    ) {
      continue;
    }
    if (hasInlineOAuthTokenMaterial(credential)) {
      const isRuntimeSidecarMaterial =
        options?.runtimeLegacyOAuthSidecarProfileIds?.has(profileId) === true;
      // Untracked inline material may be a real token refresh. Only reread the
      // sidecar then, and never use Keychain from this save-path check.
      if (
        !isRuntimeSidecarMaterial &&
        !isUnchangedLegacyOAuthSidecarMaterial({ profileId, rawProfile, credential })
      ) {
        continue;
      }
    }
    // Removal-only retention for #79006: ordinary runtime saves must not turn
    // rehydrated sidecar tokens into inline credentials. Doctor remains the
    // explicit migration path that creates backups and removes sidecars.
    profiles ??= { ...payload.profiles };
    const sanitized = { ...credential } as Record<string, unknown>;
    delete sanitized.access;
    delete sanitized.refresh;
    delete sanitized.idToken;
    profiles[profileId] = {
      ...sanitized,
      oauthRef: rawProfile.oauthRef,
    } as unknown as AuthProfileCredential;
  }
  return profiles ? { ...payload, profiles } : payload;
}

function isUnchangedLegacyOAuthSidecarMaterial(params: {
  profileId: string;
  rawProfile: Record<string, unknown>;
  credential: OAuthCredential;
}): boolean {
  if (!isLegacyOAuthRef(params.rawProfile.oauthRef)) {
    return false;
  }
  const material = loadLegacyOAuthSidecarMaterial({
    ref: params.rawProfile.oauthRef,
    profileId: params.profileId,
    provider: params.credential.provider,
    allowKeychainPrompt: false,
  });
  if (!material) {
    return false;
  }
  return isSameLegacyOAuthSecretMaterial(params.credential, material);
}

function isSameLegacyOAuthSecretMaterial(
  credential: OAuthCredential,
  material: LegacyOAuthSecretMaterial,
): boolean {
  return (["access", "refresh", "idToken"] as const).every(
    (field) => (credential[field] ?? undefined) === (material[field] ?? undefined),
  );
}

export function applyLegacyAuthStore(store: AuthProfileStore, legacy: LegacyAuthStore): void {
  for (const [provider, cred] of Object.entries(legacy)) {
    const profileId = `${provider}:default`;
    const credentialProvider = cred.provider ?? provider;
    if (cred.type === "api_key") {
      store.profiles[profileId] = {
        type: "api_key",
        provider: credentialProvider,
        key: cred.key,
        ...(cred.email ? { email: cred.email } : {}),
      };
      continue;
    }
    if (cred.type === "token") {
      store.profiles[profileId] = {
        type: "token",
        provider: credentialProvider,
        token: cred.token,
        ...(typeof cred.expires === "number" ? { expires: cred.expires } : {}),
        ...(cred.email ? { email: cred.email } : {}),
      };
      continue;
    }
    store.profiles[profileId] = {
      type: "oauth",
      provider: credentialProvider,
      access: cred.access,
      refresh: cred.refresh,
      expires: cred.expires,
      ...(cred.enterpriseUrl ? { enterpriseUrl: cred.enterpriseUrl } : {}),
      ...(cred.projectId ? { projectId: cred.projectId } : {}),
      ...(cred.accountId ? { accountId: cred.accountId } : {}),
      ...(cred.email ? { email: cred.email } : {}),
    };
  }
}

export function mergeOAuthFileIntoStore(store: AuthProfileStore): boolean {
  const oauthPath = resolveOAuthPath();
  const oauthRaw = loadJsonFile(oauthPath);
  if (!oauthRaw || typeof oauthRaw !== "object") {
    return false;
  }
  const oauthEntries = oauthRaw as Record<string, OAuthCredentials>;
  let mutated = false;
  for (const [provider, creds] of Object.entries(oauthEntries)) {
    if (!creds || typeof creds !== "object") {
      continue;
    }
    const profileId = `${provider}:default`;
    if (store.profiles[profileId]) {
      continue;
    }
    store.profiles[profileId] = {
      type: "oauth",
      provider,
      ...creds,
    };
    mutated = true;
  }
  return mutated;
}

function coerceOAuthProfileEncryptedSecretPayload(
  raw: unknown,
): OAuthProfileEncryptedSecretPayload | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Partial<OAuthProfileEncryptedSecretPayload>;
  return record.algorithm === OAUTH_PROFILE_SECRET_ALGORITHM &&
    typeof record.iv === "string" &&
    typeof record.tag === "string" &&
    typeof record.ciphertext === "string"
    ? {
        algorithm: record.algorithm,
        iv: record.iv,
        tag: record.tag,
        ciphertext: record.ciphertext,
      }
    : null;
}

function hasEncryptedOAuthProfileSecretPayload(raw: unknown): boolean {
  return (
    !!raw &&
    typeof raw === "object" &&
    coerceOAuthProfileEncryptedSecretPayload(
      (raw as Partial<OAuthProfileSecretPayload>).encrypted,
    ) !== null
  );
}

function coerceOAuthProfileSecretPayload(params: {
  raw: unknown;
  ref: OAuthCredentialRef;
  profileId: string;
  provider: string;
}): OAuthProfileSecretMaterial | null {
  const { raw, ref, profileId, provider } = params;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Partial<OAuthProfileSecretPayload>;
  if (
    record.version !== OAUTH_PROFILE_SECRET_VERSION ||
    record.profileId !== profileId ||
    record.provider !== provider
  ) {
    return null;
  }
  const encrypted = coerceOAuthProfileEncryptedSecretPayload(record.encrypted);
  if (encrypted) {
    return decryptOAuthProfileSecretMaterial({
      ref,
      profileId,
      provider,
      encrypted,
    });
  }
  return normalizeOAuthProfileSecretMaterial(record);
}

function resolvePersistedOAuthSecrets(
  credential: OAuthCredential,
  profileId: string,
  options?: { repairOAuthSecretPayloads?: boolean },
): OAuthCredential {
  if (!isOAuthProfileSecretRef(credential.oauthRef)) {
    return credential;
  }
  const secretPath = resolveOAuthProfileSecretPath(credential.oauthRef);
  const raw = loadJsonFile(secretPath);
  const secret = coerceOAuthProfileSecretPayload({
    raw,
    ref: credential.oauthRef,
    profileId,
    provider: credential.provider,
  });
  if (!secret) {
    return credential;
  }
  if (options?.repairOAuthSecretPayloads === true && !hasEncryptedOAuthProfileSecretPayload(raw)) {
    writeOAuthProfileSecretMaterial({
      ref: credential.oauthRef,
      profileId,
      provider: credential.provider,
      material: secret,
    });
  }
  return {
    ...credential,
    ...(secret.access ? { access: secret.access } : {}),
    ...(secret.refresh ? { refresh: secret.refresh } : {}),
    ...(secret.idToken ? { idToken: secret.idToken } : {}),
  } as OAuthCredential;
}

function resolvePersistedOAuthProfileSecrets(
  store: AuthProfileStore,
  options?: { repairOAuthSecretPayloads?: boolean },
): AuthProfileStore {
  const profiles = Object.fromEntries(
    Object.entries(store.profiles).map(([profileId, credential]) => [
      profileId,
      credential.type === "oauth"
        ? resolvePersistedOAuthSecrets(credential, profileId, options)
        : credential,
    ]),
  ) as AuthProfileStore["profiles"];
  return {
    ...store,
    profiles,
  };
}

function collectPersistedOAuthProfileSecretIds(
  store: AuthProfileStore | AuthProfileSecretsStore,
): Set<string> {
  const ids = new Set<string>();
  for (const credential of Object.values(store.profiles)) {
    if (credential.type === "oauth" && isOAuthProfileSecretRef(credential.oauthRef)) {
      ids.add(credential.oauthRef.id);
    }
  }
  return ids;
}

export function removeDetachedOAuthProfileSecrets(params: {
  previousRaw: unknown;
  nextStore: AuthProfileSecretsStore;
}): void {
  const previousStore = coercePersistedAuthProfileStore(params.previousRaw);
  if (!previousStore) {
    return;
  }
  const previousIds = collectPersistedOAuthProfileSecretIds(previousStore);
  if (previousIds.size === 0) {
    return;
  }
  const nextIds = collectPersistedOAuthProfileSecretIds(params.nextStore);
  for (const id of previousIds) {
    if (nextIds.has(id)) {
      continue;
    }
    fs.rmSync(
      resolveOAuthProfileSecretPath({
        source: OAUTH_PROFILE_SECRET_REF_SOURCE,
        provider: "openai-codex",
        id,
      }),
      { force: true },
    );
  }
}

function buildPersistedAuthProfileFilePayload(params: {
  store: AuthProfileStore;
  raw: unknown;
  agentDir?: string;
}): AuthProfileSecretsStore & Partial<AuthProfileStore> {
  const payload = buildPersistedAuthProfileSecretsStore(params.store, undefined, {
    agentDir: params.agentDir,
    redactOAuthSecrets: true,
  }) as AuthProfileSecretsStore & Partial<AuthProfileStore>;
  const state = coerceAuthProfileState(params.raw);
  return {
    ...payload,
    ...(state.order ? { order: state.order } : {}),
    ...(state.lastGood ? { lastGood: state.lastGood } : {}),
    ...(state.usageStats ? { usageStats: state.usageStats } : {}),
  };
}

function resolveAuthStoreLockPathSync(authPath: string): string {
  const resolved = path.resolve(authPath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  try {
    return `${path.join(fs.realpathSync(dir), path.basename(resolved))}.lock`;
  } catch {
    return `${resolved}.lock`;
  }
}

function withAuthStoreRewriteLockSync(authPath: string, fn: () => void): boolean {
  const lockPath = resolveAuthStoreLockPathSync(authPath);
  let fd: number | undefined;
  let ownedSnapshot: ReturnType<typeof readOwnedAuthStoreSyncLock> = null;
  try {
    fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(
      fd,
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    ownedSnapshot = readOwnedAuthStoreSyncLock(lockPath);
    fn();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      if (removeStaleAuthStoreSyncLock(lockPath)) {
        return withAuthStoreRewriteLockSync(authPath, fn);
      }
      return false;
    }
    throw err;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best effort only.
      }
      releaseOwnedAuthStoreSyncLock(lockPath, ownedSnapshot);
    }
  }
}

function rewritePersistedInlineOAuthSecrets(params: { authPath: string; agentDir?: string }): void {
  withAuthStoreRewriteLockSync(params.authPath, () => {
    const raw = loadJsonFile(params.authPath);
    const store = coercePersistedAuthProfileStore(raw);
    if (!store) {
      return;
    }
    const merged = {
      ...store,
      ...mergeAuthProfileState(
        coerceAuthProfileState(raw),
        loadPersistedAuthProfileState(params.agentDir),
      ),
    };
    if (!Object.values(merged.profiles).some(hasInlinePersistableOAuthSecrets)) {
      return;
    }
    saveJsonFile(
      params.authPath,
      buildPersistedAuthProfileFilePayload({ store: merged, raw, agentDir: params.agentDir }),
    );
  });
}

export function loadPersistedAuthProfileStore(
  agentDir?: string,
  options?: LoadPersistedAuthProfileStoreOptions,
): AuthProfileStore | null {
  const authPath = resolveAuthStorePath(agentDir);
  const raw = loadJsonFile(authPath);
  const store = coercePersistedAuthProfileStore(raw, options, authPath);
  if (!store) {
    return null;
  }
  const merged = {
    ...store,
    ...mergeAuthProfileState(coerceAuthProfileState(raw), loadPersistedAuthProfileState(agentDir)),
  };
  if (options?.rewriteInlineOAuthSecrets === true) {
    rewritePersistedInlineOAuthSecrets({ authPath, agentDir });
  }
  return resolvePersistedOAuthProfileSecrets(merged, {
    repairOAuthSecretPayloads: options?.repairOAuthSecretPayloads,
  });
}

export function loadLegacyAuthProfileStore(agentDir?: string): LegacyAuthStore | null {
  return coerceLegacyAuthStore(loadJsonFile(resolveLegacyAuthStorePath(agentDir)));
}
