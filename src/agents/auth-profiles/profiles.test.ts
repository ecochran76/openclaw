import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveOAuthDir } from "../../config/paths.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { resolveAuthStatePath, resolveAuthStorePath } from "./paths.js";
import {
  clearLastGoodProfileWithLock,
  promoteAuthProfileInOrder,
  syncAuthProfile,
  upsertAuthProfileWithLock,
} from "./profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  findPersistedAuthProfileCredential,
  loadAuthProfileStoreForRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore } from "./types.js";

function readPersistedTree(rootDir: string): string {
  const chunks: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (entry.isFile()) {
        chunks.push(fs.readFileSync(entryPath, "utf8"));
      }
    }
  };
  visit(rootDir);
  return chunks.join("\n");
}

function resolvePersistedOAuthSecretPath(refId: string): string {
  return path.join(resolveOAuthDir(), "auth-profiles", `${refId}.json`);
}

function resolveAuthStoreLockPath(authPath: string): string {
  return `${path.join(fs.realpathSync(path.dirname(authPath)), path.basename(authPath))}.lock`;
}

type ExpectedOAuthCredentialFields = {
  provider: string;
  access?: string;
  refresh?: string;
  idToken?: string;
  expires?: number;
  email?: string;
  accountId?: string;
  chatgptPlanType?: string;
};

function expectOAuthCredentialFields(
  value: unknown,
  expected: ExpectedOAuthCredentialFields,
): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("Expected OAuth credential object");
  }
  const credential = value as Record<string, unknown>;
  expect(credential.type).toBe("oauth");
  expect(credential.provider).toBe(expected.provider);
  for (const field of [
    "access",
    "refresh",
    "idToken",
    "expires",
    "email",
    "accountId",
    "chatgptPlanType",
  ] as const) {
    if (field in expected) {
      expect(credential[field]).toBe(expected[field]);
    }
  }
  return credential;
}

describe("promoteAuthProfileInOrder", () => {
  it("keeps inline openai-codex oauth secrets when using the locked upsert path", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-upsert-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousOAuthDir = process.env.OPENCLAW_OAUTH_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    delete process.env.OPENCLAW_OAUTH_DIR;
    try {
      fs.mkdirSync(agentDir, { recursive: true });

      await upsertAuthProfileWithLock({
        profileId: "openai:manual",
        credential: {
          type: "token",
          provider: "openai",
          token: "  bearer\r\n-token\u2502  ",
        },
        agentDir,
      });
      await upsertAuthProfileWithLock({
        profileId: "anthropic:key",
        credential: {
          type: "api_key",
          provider: "anthropic",
          key: "  sk-\r\nant\u2502  ",
        },
        agentDir,
      });

      const profiles = loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles;
      expect(profiles["openai:manual"]).toMatchObject({
        type: "token",
        provider: "openai",
        token: "bearer-token",
      });
      expect(profiles["anthropic:key"]).toMatchObject({
        type: "api_key",
        provider: "anthropic",
        key: "sk-ant",
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousOAuthDir === undefined) {
        delete process.env.OPENCLAW_OAUTH_DIR;
      } else {
        process.env.OPENCLAW_OAUTH_DIR = previousOAuthDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("persists openai-codex oauth credentials inline", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-metadata-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      const expires = Date.now() + 60 * 60 * 1000;
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "local-access-token",
              refresh: "local-refresh-token",
              idToken: "local-id-token",
              expires,
              email: "dev@example.test",
              accountId: "acct-local",
              chatgptPlanType: "plus",
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      const persisted = JSON.parse(fs.readFileSync(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<string, Record<string, unknown>>;
      };
      const credential = persisted.profiles[profileId];

      expectOAuthCredentialFields(credential, {
        provider: "openai-codex",
        access: "local-access-token",
        refresh: "local-refresh-token",
        idToken: "local-id-token",
        expires,
        email: "dev@example.test",
        accountId: "acct-local",
        chatgptPlanType: "plus",
      });
      expect(credential).not.toHaveProperty("oauthRef");
      expect(fs.existsSync(path.join(resolveOAuthDir(), "auth-profiles"))).toBe(false);

      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        {
          provider: "openai-codex",
          access: "local-access-token",
          refresh: "local-refresh-token",
          idToken: "local-id-token",
        },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves access-only openai-codex oauth credentials inline", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-access-only-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      const expires = Date.now() + 60 * 60 * 1000;
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "access-only-token",
              expires,
            } as AuthProfileStore["profiles"][string],
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      const persisted = JSON.parse(fs.readFileSync(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<string, Record<string, unknown>>;
      };
      const credential = persisted.profiles[profileId];
      expectOAuthCredentialFields(credential, {
        provider: "openai-codex",
        access: "access-only-token",
        expires,
      });
      expect(credential).not.toHaveProperty("oauthRef");

      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        {
          provider: "openai-codex",
          access: "access-only-token",
        },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps copied openai-codex oauth profiles inline", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-copy-ref-"));
    const mainAgentDir = path.join(stateDir, "agents", "main", "agent");
    const copiedAgentDir = path.join(stateDir, "agents", "copied", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(mainAgentDir, { recursive: true });
      fs.mkdirSync(copiedAgentDir, { recursive: true });
      const originalProfileId = "openai-codex:default";
      const copiedProfileId = "openai-codex:copied";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [originalProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "copy-access-token",
              refresh: "copy-refresh-token",
              expires: Date.now() + 60 * 60 * 1000,
              copyToAgents: true,
            },
          },
        },
        mainAgentDir,
        { filterExternalAuthProfiles: false },
      );

      const originalCredential =
        loadAuthProfileStoreWithoutExternalProfiles(mainAgentDir).profiles[originalProfileId];
      expect(originalCredential?.type).toBe("oauth");
      if (!originalCredential || originalCredential.type !== "oauth") {
        throw new Error("expected original oauth credential");
      }
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [copiedProfileId]: originalCredential,
          },
        },
        copiedAgentDir,
        { filterExternalAuthProfiles: false },
      );

      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {},
        },
        mainAgentDir,
        { filterExternalAuthProfiles: false },
      );

      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(copiedAgentDir).profiles[copiedProfileId],
        {
          provider: "openai-codex",
          access: "copy-access-token",
          refresh: "copy-refresh-token",
        },
      );
      const copiedRaw = fs.readFileSync(resolveAuthStorePath(copiedAgentDir), "utf8");
      expect(copiedRaw).toContain("copy-access-token");
      expect(copiedRaw).toContain("copy-refresh-token");
      expect(copiedRaw).not.toContain("oauthRef");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not rewrite inline openai-codex oauth secrets from read-only lookup paths", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-readonly-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousReadOnly = process.env.OPENCLAW_AUTH_STORE_READONLY;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      const expires = Date.now() + 60 * 60 * 1000;
      fs.writeFileSync(
        resolveAuthStorePath(agentDir),
        `${JSON.stringify(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "openai-codex",
                access: "readonly-access-token",
                refresh: "readonly-refresh-token",
                expires,
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      const before = fs.readFileSync(resolveAuthStorePath(agentDir), "utf8");

      expectOAuthCredentialFields(findPersistedAuthProfileCredential({ agentDir, profileId }), {
        provider: "openai-codex",
        access: "readonly-access-token",
        refresh: "readonly-refresh-token",
      });
      expect(fs.readFileSync(resolveAuthStorePath(agentDir), "utf8")).toBe(before);

      process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreForRuntime(agentDir, { externalCli: { mode: "none" } }).profiles[
          profileId
        ],
        {
          provider: "openai-codex",
          access: "readonly-access-token",
          refresh: "readonly-refresh-token",
        },
      );
      expect(fs.readFileSync(resolveAuthStorePath(agentDir), "utf8")).toBe(before);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousReadOnly === undefined) {
        delete process.env.OPENCLAW_AUTH_STORE_READONLY;
      } else {
        process.env.OPENCLAW_AUTH_STORE_READONLY = previousReadOnly;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not repair legacy openai-codex oauth sidecars from read-only lookup paths", () => {
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-auth-profile-readonly-sidecar-"),
    );
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousSecretKey = process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
    const previousReadOnly = process.env.OPENCLAW_AUTH_STORE_READONLY;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY = "readonly-sidecar-secret-key";
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      const legacyRef = {
        source: "openclaw-credentials" as const,
        provider: "openai-codex" as const,
        id: "0123456789abcdef0123456789abcdef",
      };
      const expires = Date.now() + 60 * 60 * 1000;
      const legacyAuthStore = `${JSON.stringify(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              expires,
              oauthRef: legacyRef,
            },
          },
        },
        null,
        2,
      )}\n`;
      fs.writeFileSync(resolveAuthStorePath(agentDir), legacyAuthStore);
      const secretPath = resolvePersistedOAuthSecretPath(legacyRef.id);
      const legacySidecar = `${JSON.stringify(
        {
          version: 1,
          profileId,
          provider: "openai-codex",
          access: "legacy-sidecar-access",
          refresh: "legacy-sidecar-refresh",
        },
        null,
        2,
      )}\n`;
      fs.mkdirSync(path.dirname(secretPath), { recursive: true });
      fs.writeFileSync(secretPath, legacySidecar, "utf8");

      process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreForRuntime(agentDir, {
          readOnly: true,
          externalCli: { mode: "none" },
        }).profiles[profileId],
        {
          provider: "openai-codex",
          access: "legacy-sidecar-access",
          refresh: "legacy-sidecar-refresh",
        },
      );
      expect(fs.readFileSync(resolveAuthStorePath(agentDir), "utf8")).toBe(legacyAuthStore);
      expect(fs.readFileSync(secretPath, "utf8")).toBe(legacySidecar);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousSecretKey === undefined) {
        delete process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY;
      } else {
        process.env.OPENCLAW_AUTH_PROFILE_SECRET_KEY = previousSecretKey;
      }
      if (previousReadOnly === undefined) {
        delete process.env.OPENCLAW_AUTH_STORE_READONLY;
      } else {
        process.env.OPENCLAW_AUTH_STORE_READONLY = previousReadOnly;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rewrites existing inline openai-codex oauth secrets during runtime load", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-rewrite-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      const expires = Date.now() + 60 * 60 * 1000;
      fs.writeFileSync(
        resolveAuthStorePath(agentDir),
        `${JSON.stringify(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "openai-codex",
                access: "existing-access-token",
                refresh: "existing-refresh-token",
                idToken: "existing-id-token",
                expires,
                accountId: "acct-existing",
              },
            },
            order: {
              "openai-codex": [profileId],
            },
          },
          null,
          2,
        )}\n`,
      );

      expectOAuthCredentialFields(
        loadAuthProfileStoreForRuntime(agentDir, { externalCli: { mode: "none" } }).profiles[
          profileId
        ],
        {
          provider: "openai-codex",
          access: "existing-access-token",
          refresh: "existing-refresh-token",
          idToken: "existing-id-token",
        },
      );

      const persisted = JSON.parse(fs.readFileSync(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<string, Record<string, unknown>>;
        order?: Record<string, string[]>;
      };
      const credential = persisted.profiles[profileId];
      expectOAuthCredentialFields(credential, {
        provider: "openai-codex",
        access: "existing-access-token",
        refresh: "existing-refresh-token",
        idToken: "existing-id-token",
        expires,
        accountId: "acct-existing",
      });
      expect(persisted.order?.["openai-codex"]).toEqual([profileId]);
      expect(credential).not.toHaveProperty("oauthRef");
      const persistedStateTree = readPersistedTree(stateDir);
      expect(persistedStateTree).toContain("existing-access-token");
      expect(persistedStateTree).toContain("existing-refresh-token");
      expect(persistedStateTree).toContain("existing-id-token");

      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        {
          provider: "openai-codex",
          access: "existing-access-token",
          refresh: "existing-refresh-token",
          idToken: "existing-id-token",
        },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not rewrite inline openai-codex oauth secrets while the auth store lock is held", () => {
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-auth-profile-locked-rewrite-"),
    );
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    let lockFd: number | undefined;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      const authPath = resolveAuthStorePath(agentDir);
      const expires = Date.now() + 60 * 60 * 1000;
      fs.writeFileSync(
        authPath,
        `${JSON.stringify(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "openai-codex",
                access: "locked-access-token",
                refresh: "locked-refresh-token",
                expires,
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      const before = fs.readFileSync(authPath, "utf8");
      const lockPath = resolveAuthStoreLockPath(authPath);
      lockFd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(
        lockFd,
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );

      expectOAuthCredentialFields(
        loadAuthProfileStoreForRuntime(agentDir, { externalCli: { mode: "none" } }).profiles[
          profileId
        ],
        {
          provider: "openai-codex",
          access: "locked-access-token",
          refresh: "locked-refresh-token",
        },
      );

      expect(fs.readFileSync(authPath, "utf8")).toBe(before);
    } finally {
      if (lockFd !== undefined) {
        fs.closeSync(lockFd);
        fs.rmSync(resolveAuthStoreLockPath(resolveAuthStorePath(agentDir)), { force: true });
      }
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reclaims a dead auth-store lock without rewriting inline openai-codex oauth secrets", () => {
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-auth-profile-dead-rewrite-lock-"),
    );
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai-codex:default";
      const authPath = resolveAuthStorePath(agentDir);
      const expires = Date.now() + 60 * 60 * 1000;
      fs.writeFileSync(
        authPath,
        `${JSON.stringify(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "openai-codex",
                access: "dead-lock-access-token",
                refresh: "dead-lock-refresh-token",
                expires,
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      const lockPath = resolveAuthStoreLockPath(authPath);
      fs.writeFileSync(
        lockPath,
        `${JSON.stringify({ pid: 2 ** 30, createdAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );

      expectOAuthCredentialFields(
        loadAuthProfileStoreForRuntime(agentDir, { externalCli: { mode: "none" } }).profiles[
          profileId
        ],
        {
          provider: "openai-codex",
          access: "dead-lock-access-token",
          refresh: "dead-lock-refresh-token",
        },
      );

      const persisted = JSON.parse(fs.readFileSync(authPath, "utf8")) as {
        profiles: Record<string, Record<string, unknown>>;
      };
      const credential = persisted.profiles[profileId];
      expect(credential).toBeDefined();
      expectOAuthCredentialFields(credential, {
        provider: "openai-codex",
        access: "dead-lock-access-token",
        refresh: "dead-lock-refresh-token",
        expires,
      });
      expect(credential).not.toHaveProperty("oauthRef");
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("moves a relogin profile to the front of an existing per-agent provider order", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-order-promote-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const newProfileId = "openai-codex:bunsthedev@gmail.com";
      const staleProfileId = "openai-codex:val@viewdue.ai";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [newProfileId]: {
              type: "api_key",
              provider: "openai-codex",
              key: "new-key",
            },
            [staleProfileId]: {
              type: "api_key",
              provider: "openai-codex",
              key: "stale-key",
            },
          },
          order: {
            "openai-codex": [staleProfileId],
          },
        },
        agentDir,
      );

      const updated = await promoteAuthProfileInOrder({
        agentDir,
        provider: "openai-codex",
        profileId: newProfileId,
      });

      expect(updated?.order?.["openai-codex"]).toEqual([newProfileId, staleProfileId]);
      expect(loadAuthProfileStoreForRuntime(agentDir).order?.["openai-codex"]).toEqual([
        newProfileId,
        staleProfileId,
      ]);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("clears matching lastGood after a stale refresh_token_reused profile", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-clear-lastgood-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const staleProfileId = "openai-codex:default";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [staleProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "stale-access-token",
              refresh: "stale-refresh-token",
              expires: Date.now() - 60_000,
            },
          },
          lastGood: { "openai-codex": staleProfileId },
        },
        agentDir,
      );

      await clearLastGoodProfileWithLock({
        agentDir,
        provider: "openai-codex",
        profileId: staleProfileId,
      });

      expect(loadAuthProfileStoreForRuntime(agentDir).lastGood).toBeUndefined();
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not clear lastGood when the failed profile is not the stored profile", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-clear-lastgood-keep-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const goodProfileId = "openai-codex:user@example.test";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [goodProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "good-access-token",
              refresh: "good-refresh-token",
              expires: Date.now() + 60_000,
            },
          },
          lastGood: { "openai-codex": goodProfileId },
        },
        agentDir,
      );

      await clearLastGoodProfileWithLock({
        agentDir,
        provider: "openai-codex",
        profileId: "openai-codex:default",
      });

      expect(loadAuthProfileStoreForRuntime(agentDir).lastGood?.["openai-codex"]).toBe(
        goodProfileId,
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("syncAuthProfile", () => {
  function writeStore(agentDir: string, store: AuthProfileStore) {
    fs.writeFileSync(path.join(agentDir, "auth-profiles.json"), JSON.stringify(store));
  }

  function readStore(agentDir: string): AuthProfileStore {
    return JSON.parse(fs.readFileSync(path.join(agentDir, "auth-profiles.json"), "utf8"));
  }

  async function readState(
    agentDir: string,
  ): Promise<Pick<AuthProfileStore, "order" | "lastGood" | "usageStats">> {
    return JSON.parse(await fs.promises.readFile(resolveAuthStatePath(agentDir), "utf8"));
  }

  it("syncs one profile without clobbering unrelated target metadata", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profile-sync-"));
    const mainAgentDir = path.join(tempRoot, "agents", "main", "agent");
    const kidAgentDir = path.join(tempRoot, "agents", "kid", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      fs.mkdirSync(mainAgentDir, { recursive: true });
      fs.mkdirSync(kidAgentDir, { recursive: true });
      process.env.OPENCLAW_STATE_DIR = tempRoot;
      process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
      process.env.PI_CODING_AGENT_DIR = mainAgentDir;

      writeStore(mainAgentDir, {
        version: 1,
        profiles: {
          "openai-codex:work": {
            type: "oauth",
            provider: "openai-codex",
            access: "fresh-access",
            refresh: "fresh-refresh",
            expires: Date.now() + 60_000,
          },
        },
        lastGood: { "openai-codex": "openai-codex:work" },
      });

      writeStore(kidAgentDir, {
        version: 1,
        profiles: {
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "anthropic-key",
          },
        },
        order: { anthropic: ["anthropic:default"] },
        lastGood: { anthropic: "anthropic:default" },
        usageStats: {
          "anthropic:default": { lastUsed: 1234 },
        },
      });

      const result = await syncAuthProfile({
        profileId: "openai-codex:work",
        sourceAgentDir: mainAgentDir,
        targetAgentDirs: [kidAgentDir, mainAgentDir],
      });

      expect(result.updatedAgentDirs).toEqual([path.resolve(kidAgentDir)]);
      expect(result.skippedAgentDirs).toEqual([path.resolve(mainAgentDir)]);

      const updatedKid = loadAuthProfileStoreForRuntime(kidAgentDir);
      expect(updatedKid.profiles["openai-codex:work"]).toMatchObject({
        type: "oauth",
        provider: "openai-codex",
        access: "fresh-access",
        refresh: "fresh-refresh",
      });
      expect(updatedKid.profiles["anthropic:default"]).toMatchObject({
        type: "api_key",
        provider: "anthropic",
        key: "anthropic-key",
      });
      expect(updatedKid.order).toEqual({ anthropic: ["anthropic:default"] });
      expect(updatedKid.lastGood).toMatchObject({ anthropic: "anthropic:default" });
      expect(updatedKid.usageStats).toMatchObject({
        "anthropic:default": { lastUsed: 1234 },
      });
      const updatedKidSecrets = readStore(kidAgentDir);
      expect(updatedKidSecrets.profiles["openai-codex:work"]).toMatchObject({
        type: "oauth",
        provider: "openai-codex",
      });
      expect(updatedKidSecrets.profiles["anthropic:default"]).toMatchObject({
        type: "api_key",
        provider: "anthropic",
        key: "anthropic-key",
      });
      const updatedKidState = await readState(kidAgentDir);
      expect(updatedKidState.order).toEqual({ anthropic: ["anthropic:default"] });
      expect(updatedKidState.lastGood).toEqual({ anthropic: "anthropic:default" });
      expect(updatedKidState.usageStats).toEqual({
        "anthropic:default": { lastUsed: 1234 },
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousAgentDir === undefined) {
        delete process.env.OPENCLAW_AGENT_DIR;
      } else {
        process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
      }
      if (previousPiAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
