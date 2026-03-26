import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadJsonFile } from "../infra/json-file.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";

const log = createSubsystemLogger("agents/auth-profiles");

const OPENAI_CODEX_CLI_AUTH_FILENAME = "auth.json";
type ExecSyncFn = typeof execSync;

export type OpenAICodexCliCredential = {
  type: "oauth";
  provider: "openai-codex";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
};

function resolveOpenAICodexHomePath() {
  const configured = process.env.CODEX_HOME;
  const home = configured ? resolveUserPath(configured) : resolveUserPath("~/.codex");
  try {
    return fs.realpathSync.native(home);
  } catch {
    return home;
  }
}

export function resolveOpenAICodexCliAuthPath() {
  return path.join(resolveOpenAICodexHomePath(), OPENAI_CODEX_CLI_AUTH_FILENAME);
}

function computeOpenAICodexKeychainAccount(codexHome: string) {
  const hash = createHash("sha256").update(codexHome).digest("hex");
  return `cli|${hash.slice(0, 16)}`;
}

function decodeJwtExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const payloadRaw = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadRaw) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

function readOpenAICodexKeychainCredentials(options?: {
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
}): OpenAICodexCliCredential | null {
  const platform = options?.platform ?? process.platform;
  if (platform !== "darwin") {
    return null;
  }
  const execSyncImpl = options?.execSync ?? execSync;

  const codexHome = resolveOpenAICodexHomePath();
  const account = computeOpenAICodexKeychainAccount(codexHome);

  try {
    const secret = execSyncImpl(
      `security find-generic-password -s "Codex Auth" -a "${account}" -w`,
      {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();

    const parsed = JSON.parse(secret) as Record<string, unknown>;
    const tokens = parsed.tokens as Record<string, unknown> | undefined;
    const accessToken = tokens?.access_token;
    const refreshToken = tokens?.refresh_token;
    if (typeof accessToken !== "string" || !accessToken) {
      return null;
    }
    if (typeof refreshToken !== "string" || !refreshToken) {
      return null;
    }

    const lastRefreshRaw = parsed.last_refresh;
    const lastRefresh =
      typeof lastRefreshRaw === "string" || typeof lastRefreshRaw === "number"
        ? new Date(lastRefreshRaw).getTime()
        : Date.now();
    const fallbackExpiry = Number.isFinite(lastRefresh)
      ? lastRefresh + 60 * 60 * 1000
      : Date.now() + 60 * 60 * 1000;
    const expires = decodeJwtExpiryMs(accessToken) ?? fallbackExpiry;
    const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : undefined;

    log.info("read codex credentials from keychain", {
      source: "keychain",
      expires: new Date(expires).toISOString(),
    });

    return {
      type: "oauth",
      provider: "openai-codex",
      access: accessToken,
      refresh: refreshToken,
      expires,
      accountId,
    };
  } catch {
    return null;
  }
}

export function readOpenAICodexCliCredentials(options?: {
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
}): OpenAICodexCliCredential | null {
  const keychain = readOpenAICodexKeychainCredentials({
    platform: options?.platform,
    execSync: options?.execSync,
  });
  if (keychain) {
    return keychain;
  }

  const authPath = resolveOpenAICodexCliAuthPath();
  const raw = loadJsonFile(authPath);
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const data = raw as Record<string, unknown>;
  const tokens = data.tokens as Record<string, unknown> | undefined;
  if (!tokens || typeof tokens !== "object") {
    return null;
  }

  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;

  if (typeof accessToken !== "string" || !accessToken) {
    return null;
  }
  if (typeof refreshToken !== "string" || !refreshToken) {
    return null;
  }

  let fallbackExpiry: number;
  try {
    const stat = fs.statSync(authPath);
    fallbackExpiry = stat.mtimeMs + 60 * 60 * 1000;
  } catch {
    fallbackExpiry = Date.now() + 60 * 60 * 1000;
  }
  const expires = decodeJwtExpiryMs(accessToken) ?? fallbackExpiry;

  return {
    type: "oauth",
    provider: "openai-codex",
    access: accessToken,
    refresh: refreshToken,
    expires,
    accountId: typeof tokens.account_id === "string" ? tokens.account_id : undefined,
  };
}
