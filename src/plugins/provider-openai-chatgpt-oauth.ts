// Bridges OpenAI ChatGPT OAuth credentials into provider plugin auth.
import { createHash, randomBytes } from "node:crypto";
import type { OAuthCredentials } from "../llm/oauth.js";
import { resolveOpenAICodexAccountId } from "../llm/utils/oauth/openai-chatgpt-jwt.js";
import { loadActivatedBundledPluginPublicSurfaceModuleSync } from "../plugin-sdk/facade-runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { resolveProviderRuntimePlugin } from "./provider-hook-runtime.js";
import { createVpsAwareOAuthHandlers } from "./provider-oauth-flow.js";
import type { ChatReauthCapability } from "./provider-auth-types.js";
import type { ProviderAuthContext } from "./types.js";

const OPENAI_CODEX_PROVIDER_ID = "openai";
const OPENAI_CODEX_OAUTH_METHOD_ID = "oauth";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_DEVICE_USER_CODE_URL =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
const OPENAI_CODEX_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const OPENAI_CODEX_DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";
const OPENAI_CODEX_DEVICE_CALLBACK_URL = "https://auth.openai.com/deviceauth/callback";
const OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS = 15 * 60_000;
const OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
export const OPENAI_CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const OPENAI_CODEX_SCOPE = "openid profile email offline_access";

type OpenAICodexOAuthBridgeContext = ProviderAuthContext & {
  signal?: AbortSignal;
  onManualCodeInput?: () => Promise<string>;
};
type OpenAICodexDeviceFailureCode = "device_code_unavailable";

export type OpenAICodexManualAuthorization = {
  state: string;
  verifier: string;
  authorizationUrl: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
};

type OpenAICodexDeviceAuthorization = {
  flow: "device_code";
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  createdAt: number;
  expiresAt: number;
};

type OpenAICodexOAuthLoginParams = {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  signal?: AbortSignal;
  onManualCodeInput?: () => Promise<string>;
  localBrowserMessage?: string;
};

type OpenAICodexOAuthFacade = {
  loginOpenAICodexOAuth: (
    params: OpenAICodexOAuthLoginParams & Pick<ProviderAuthContext, "oauth">,
  ) => Promise<OAuthCredentials | null>;
};

function loadOpenAICodexOAuthFacade(): OpenAICodexOAuthFacade {
  return loadActivatedBundledPluginPublicSurfaceModuleSync<OpenAICodexOAuthFacade>({
    dirName: "openai",
    artifactBasename: "api.js",
  });
}

function isOAuthCredential(value: unknown): value is OAuthCredentials {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.type === "oauth" &&
    record.provider === OPENAI_CODEX_PROVIDER_ID &&
    typeof record.access === "string" &&
    typeof record.refresh === "string" &&
    typeof record.expires === "number"
  );
}

function createOpenAICodexDeviceError(
  code: OpenAICodexDeviceFailureCode,
  message: string,
): Error & { code: OpenAICodexDeviceFailureCode } {
  const error = new Error(message);
  return Object.assign(error, { code });
}

function isOpenAICodexDeviceUnavailableError(
  error: unknown,
): error is Error & { code: OpenAICodexDeviceFailureCode } {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === "device_code_unavailable"
  );
}

function parseManualAuthorizationInput(
  input: string,
  expectedState: string,
): { code: string; state: string } {
  const trimmed = normalizeManualAuthorizationInput(input);
  if (!trimmed) {
    throw new Error("Missing OAuth redirect URL.");
  }

  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code")?.trim();
    const state = url.searchParams.get("state")?.trim();
    if (!code) {
      throw new Error("Missing authorization code in redirect URL.");
    }
    if (!state || state !== expectedState) {
      throw new Error("Invalid OAuth state.");
    }
    return { code, state };
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
  }

  const params = new URLSearchParams(
    trimmed.startsWith("?") ? trimmed.slice(1) : trimmed.replace(/^[^?]*\?/, ""),
  );
  const code = params.get("code")?.trim();
  const state = params.get("state")?.trim();
  if (!code) {
    throw new Error("Missing authorization code in redirect URL.");
  }
  if (!state || state !== expectedState) {
    throw new Error("Invalid OAuth state.");
  }
  return { code, state };
}

function decodeChatEscapes(input: string): string {
  let decoded = input;
  for (let i = 0; i < 3; i += 1) {
    const next = decoded.replace(/&amp;/g, "&");
    if (next === decoded) {
      break;
    }
    decoded = next;
  }
  return decoded;
}

function trimCallbackCandidate(input: string): string {
  return (
    decodeChatEscapes(input.trim())
      .replace(/[>)\]}.,]+$/, "")
      .split("|")[0]
      ?.trim() ?? ""
  );
}

function normalizeManualAuthorizationInput(input: string): string {
  const trimmed = decodeChatEscapes(input.trim());
  if (!trimmed) {
    return "";
  }
  const slackLink = trimmed.match(/<([^>|]+)(?:\|[^>]+)?>/);
  if (slackLink?.[1]) {
    return trimCallbackCandidate(slackLink[1]);
  }
  const urlMatch = trimmed.match(/https?:\/\/[^\s<>]+/i);
  if (urlMatch?.[0]) {
    return trimCallbackCandidate(urlMatch[0]);
  }
  const queryIndex = trimmed.indexOf("?code=");
  if (queryIndex >= 0) {
    return trimCallbackCandidate(trimmed.slice(queryIndex));
  }
  return trimmed;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveSecondsAsMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value * 1000);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const seconds = Number.parseInt(value.trim(), 10);
    return seconds > 0 ? seconds * 1000 : undefined;
  }
  return undefined;
}

function resolveOpenAICodexHeaders(contentType: string): Record<string, string> {
  const version = process.env.OPENCLAW_VERSION?.trim();
  return {
    "Content-Type": contentType,
    originator: "openclaw",
    ...(version ? { version } : {}),
    "User-Agent": version ? `openclaw/${version}` : "openclaw",
  };
}

function formatOpenAIDeviceCodeHttpError(params: {
  prefix: string;
  status: number;
  bodyText: string;
}): string {
  const body = parseJsonObject(params.bodyText);
  const error = readNonEmptyString(body?.error);
  const description = readNonEmptyString(body?.error_description);
  if (error && description) {
    return `${params.prefix}: ${error} (${description})`;
  }
  if (error) {
    return `${params.prefix}: ${error}`;
  }
  const bodyText = params.bodyText.replace(/\s+/g, " ").trim();
  return bodyText
    ? `${params.prefix}: HTTP ${params.status} ${bodyText.slice(0, 240)}`
    : `${params.prefix}: HTTP ${params.status}`;
}

export function looksLikeOpenAICodexCallbackInput(input: string): boolean {
  const trimmed = normalizeManualAuthorizationInput(input);
  if (!trimmed) {
    return false;
  }
  return (
    /\/auth\/callback\?/i.test(trimmed) ||
    (trimmed.includes("code=") && trimmed.includes("state=")) ||
    trimmed.startsWith("?code=")
  );
}

export function createOpenAICodexManualAuthorization(params?: {
  originator?: string;
  now?: number;
  ttlMs?: number;
}): OpenAICodexManualAuthorization {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  const now = params?.now ?? Date.now();
  const url = new URL(OPENAI_CODEX_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OPENAI_CODEX_CLIENT_ID);
  url.searchParams.set("redirect_uri", OPENAI_CODEX_REDIRECT_URI);
  url.searchParams.set("scope", OPENAI_CODEX_SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", params?.originator?.trim() || "pi");
  return {
    state,
    verifier,
    authorizationUrl: url.toString(),
    redirectUri: OPENAI_CODEX_REDIRECT_URI,
    createdAt: now,
    expiresAt: now + (params?.ttlMs ?? 15 * 60 * 1000),
  };
}

async function createOpenAICodexDeviceAuthorization(params?: {
  now?: number;
}): Promise<OpenAICodexDeviceAuthorization> {
  const response = await fetch(OPENAI_CODEX_DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: resolveOpenAICodexHeaders("application/json"),
    body: JSON.stringify({
      client_id: OPENAI_CODEX_CLIENT_ID,
    }),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    const message = formatOpenAIDeviceCodeHttpError({
      prefix: "OpenAI device code request failed",
      status: response.status,
      bodyText,
    });
    if (response.status === 400 || response.status === 403 || response.status === 404) {
      throw createOpenAICodexDeviceError("device_code_unavailable", message);
    }
    throw new Error(message);
  }
  const body = parseJsonObject(bodyText);
  const deviceAuthId = readNonEmptyString(body?.device_auth_id);
  const userCode = readNonEmptyString(body?.user_code) ?? readNonEmptyString(body?.usercode);
  if (!deviceAuthId || !userCode) {
    throw new Error("OpenAI device code response was missing the device code or user code.");
  }
  const now = params?.now ?? Date.now();
  return {
    flow: "device_code",
    deviceAuthId,
    userCode,
    verificationUrl: OPENAI_CODEX_DEVICE_VERIFICATION_URL,
    intervalMs:
      readPositiveSecondsAsMs(body?.interval) ?? OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS,
    createdAt: now,
    expiresAt: now + OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS,
  };
}

async function pollOpenAICodexDeviceAuthorization(params: {
  deviceAuthId?: string;
  userCode?: string;
  expiresAt?: number;
}): Promise<{ authorizationCode: string; codeVerifier: string } | null> {
  if (!params.deviceAuthId || !params.userCode) {
    throw new Error("OpenAI device code pending state is incomplete.");
  }
  if (params.expiresAt && Date.now() > params.expiresAt) {
    throw new Error("OpenAI device code expired.");
  }
  const response = await fetch(OPENAI_CODEX_DEVICE_TOKEN_URL, {
    method: "POST",
    headers: resolveOpenAICodexHeaders("application/json"),
    body: JSON.stringify({
      device_auth_id: params.deviceAuthId,
      user_code: params.userCode,
    }),
  });
  const bodyText = await response.text();
  if (response.status === 403 || response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      formatOpenAIDeviceCodeHttpError({
        prefix: "OpenAI device authorization failed",
        status: response.status,
        bodyText,
      }),
    );
  }
  const body = parseJsonObject(bodyText);
  const authorizationCode = readNonEmptyString(body?.authorization_code);
  const codeVerifier = readNonEmptyString(body?.code_verifier);
  if (!authorizationCode || !codeVerifier) {
    throw new Error("OpenAI device authorization response was missing the exchange code.");
  }
  return { authorizationCode, codeVerifier };
}

async function exchangeOpenAICodexDeviceAuthorization(params: {
  authorizationCode: string;
  codeVerifier: string;
}): Promise<OAuthCredentials> {
  const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
    method: "POST",
    headers: resolveOpenAICodexHeaders("application/x-www-form-urlencoded"),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.authorizationCode,
      redirect_uri: OPENAI_CODEX_DEVICE_CALLBACK_URL,
      client_id: OPENAI_CODEX_CLIENT_ID,
      code_verifier: params.codeVerifier,
    }),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      formatOpenAIDeviceCodeHttpError({
        prefix: "OpenAI device token exchange failed",
        status: response.status,
        bodyText,
      }),
    );
  }
  const json = parseJsonObject(bodyText);
  const access = readNonEmptyString(json?.access_token);
  const refresh = readNonEmptyString(json?.refresh_token);
  const expiresInMs = readPositiveSecondsAsMs(json?.expires_in);
  if (!access || !refresh) {
    throw new Error("OpenAI token exchange succeeded but did not return OAuth tokens.");
  }
  const accountId = resolveOpenAICodexAccountId(access);
  if (!accountId) {
    throw new Error("Failed to extract accountId from token.");
  }
  return {
    access,
    refresh,
    expires: Date.now() + (expiresInMs ?? 0),
    accountId,
  };
}

export async function completeOpenAICodexManualAuthorization(params: {
  input: string;
  state: string;
  verifier: string;
  redirectUri?: string;
}): Promise<OAuthCredentials> {
  const { code } = parseManualAuthorizationInput(params.input, params.state);
  const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_CODEX_CLIENT_ID,
      code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri?.trim() || OPENAI_CODEX_REDIRECT_URI,
    }),
  });
  if (!response.ok) {
    const text = (await response.text().catch(() => "")).trim();
    const detail = text ? ` ${text.slice(0, 240)}` : "";
    throw new Error(`Token exchange failed (HTTP ${response.status}).${detail}`);
  }
  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (
    typeof json.access_token !== "string" ||
    typeof json.refresh_token !== "string" ||
    typeof json.expires_in !== "number"
  ) {
    throw new Error("Token exchange returned an incomplete OAuth payload.");
  }
  const accountId = resolveOpenAICodexAccountId(json.access_token);
  if (!accountId) {
    throw new Error("Failed to extract accountId from token.");
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId,
  };
}

export const openAICodexChatReauthCapability: ChatReauthCapability = {
  provider: OPENAI_CODEX_PROVIDER_ID,
  looksLikeCallbackInput: looksLikeOpenAICodexCallbackInput,
  createPendingAuthorization: async (params) => {
    if (params?.preferredFlow === "callback") {
      return {
        flow: "callback",
        ...createOpenAICodexManualAuthorization({ originator: params.originator }),
      };
    }
    try {
      return await createOpenAICodexDeviceAuthorization(params);
    } catch (error) {
      if (!isOpenAICodexDeviceUnavailableError(error)) {
        throw error;
      }
      return {
        flow: "callback",
        ...createOpenAICodexManualAuthorization({ originator: params?.originator }),
      };
    }
  },
  completePendingAuthorization: async ({ input, pending }) =>
    await completeOpenAICodexManualAuthorization({
      input,
      state: pending.state,
      verifier: pending.verifier,
      redirectUri: pending.redirectUri,
    }),
  pollPendingAuthorization: async ({ pending }) => {
    const authorization = await pollOpenAICodexDeviceAuthorization(pending);
    return authorization ? await exchangeOpenAICodexDeviceAuthorization(authorization) : null;
  },
};

/** @deprecated OpenAI Codex OAuth is owned by the OpenAI plugin auth hook. */
export async function loginOpenAICodexOAuth(
  params: OpenAICodexOAuthLoginParams,
): Promise<OAuthCredentials | null> {
  const oauthHandlers = {
    createVpsAwareHandlers: createVpsAwareOAuthHandlers,
  };
  const provider = resolveProviderRuntimePlugin({
    provider: OPENAI_CODEX_PROVIDER_ID,
    config: {},
    bundledProviderVitestCompat: true,
  });
  const oauth = provider?.auth?.find((method) => method.id === OPENAI_CODEX_OAUTH_METHOD_ID);
  if (!oauth) {
    return await loadOpenAICodexOAuthFacade().loginOpenAICodexOAuth({
      ...params,
      oauth: oauthHandlers,
    });
  }

  const context: OpenAICodexOAuthBridgeContext = {
    config: {},
    prompter: params.prompter,
    runtime: params.runtime,
    isRemote: params.isRemote,
    openUrl: params.openUrl,
    signal: params.signal,
    onManualCodeInput: params.onManualCodeInput,
    oauth: oauthHandlers,
  };
  const result = await oauth.run(context);
  const credential = result.profiles[0]?.credential;
  return isOAuthCredential(credential) ? credential : null;
}
