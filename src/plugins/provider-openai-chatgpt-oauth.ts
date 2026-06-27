import { createHash, randomBytes } from "node:crypto";
import { formatErrorMessage } from "../infra/errors.js";
import { ensureGlobalUndiciEnvProxyDispatcher } from "../infra/net/undici-global-dispatcher.js";
import type { OAuthCredentials } from "../llm/oauth.js";
import { loadActivatedBundledPluginPublicSurfaceModuleSync } from "../plugin-sdk/facade-runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { ChatReauthCapability } from "./provider-auth-types.js";
import { resolveProviderRuntimePlugin } from "./provider-hook-runtime.js";
import type { OAuthPrompt } from "./provider-oauth-flow.js";
import { createVpsAwareOAuthHandlers } from "./provider-oauth-flow.js";
import {
  formatOpenAIOAuthTlsPreflightFix,
  runOpenAIOAuthTlsPreflight,
} from "./provider-openai-chatgpt-oauth-tls.js";

const manualInputPromptMessage = "Paste the authorization code (or full redirect URL):";
const openAICodexOAuthOriginator = "openclaw";
const localManualFallbackDelayMs = 15_000;
const localManualFallbackGraceMs = 1_000;
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
export const OPENAI_CODEX_SCOPE =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
const OPENAI_CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";

type OpenAICodexOAuthFailureCode =
  | "callback_timeout"
  | "callback_validation_failed"
  | "unsupported_region";
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

function waitForDelayOrLoginSettle(params: {
  delayMs: number;
  waitForLoginToSettle: Promise<void>;
}): Promise<"delay" | "settled"> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (outcome: "delay" | "settled") => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeoutHandle);
      resolve(outcome);
    };
    const timeoutHandle = setTimeout(() => finish("delay"), params.delayMs);
    params.waitForLoginToSettle.then(
      () => finish("settled"),
      () => finish("settled"),
    );
  });
}

function createNeverSettlingPromptResult(): Promise<string> {
  return new Promise<string>(() => undefined);
}

function createOpenAICodexOAuthError(
  code: OpenAICodexOAuthFailureCode,
  message: string,
  cause?: unknown,
): Error & { code: OpenAICodexOAuthFailureCode } {
  const error = new Error(`OpenAI Codex OAuth failed (${code}): ${message}`, { cause });
  return Object.assign(error, { code });
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

function rewriteOpenAICodexOAuthError(error: unknown): Error {
  const message = formatErrorMessage(error);
  if (/unsupported_country_region_territory/i.test(message)) {
    return createOpenAICodexOAuthError(
      "unsupported_region",
      [
        "OpenAI rejected the token exchange for this country, region, or network route.",
        "If you normally use a proxy, verify HTTPS_PROXY, HTTP_PROXY, or ALL_PROXY is set for the OpenClaw process and then retry `openclaw models auth login --provider openai-codex`.",
      ].join(" "),
      error,
    );
  }
  if (/state mismatch|missing authorization code/i.test(message)) {
    return createOpenAICodexOAuthError("callback_validation_failed", message, error);
  }
  return error instanceof Error ? error : new Error(message);
}

function createManualCodeInputHandler(params: {
  isRemote: boolean;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  runtime: RuntimeEnv;
  updateProgress: (message: string) => void;
  stopProgress: (message?: string) => void;
  waitForLoginToSettle: Promise<void>;
  hasBrowserAuthStarted: () => boolean;
}): (() => Promise<string>) | undefined {
  let manualFallbackPromise: Promise<string> | undefined;
  if (params.isRemote) {
    return async () => {
      manualFallbackPromise ??= params.onPrompt({
        message: manualInputPromptMessage,
      });
      return await manualFallbackPromise;
    };
  }

  const runLocalManualFallback = async () => {
    if (!params.hasBrowserAuthStarted()) {
      params.updateProgress(
        "Local OAuth callback was unavailable. Paste the redirect URL to continue…",
      );
      params.runtime.log(
        "OpenAI Codex OAuth local callback did not start; switching to manual entry immediately.",
      );
      params.stopProgress("Manual OAuth entry required");
      return await params.onPrompt({
        message: manualInputPromptMessage,
      });
    }

    const outcome = await waitForDelayOrLoginSettle({
      delayMs: localManualFallbackDelayMs,
      waitForLoginToSettle: params.waitForLoginToSettle,
    });
    if (outcome === "settled") {
      // markLoginSettled() runs in loginOpenAICodexOAuth's finally block, so
      // reaching this branch means the outer login call has already completed.
      // Return a never-settling promise to suppress an unnecessary manual
      // prompt without feeding placeholder input back into the upstream flow.
      return await createNeverSettlingPromptResult();
    }

    const settledDuringGraceWindow = await waitForDelayOrLoginSettle({
      delayMs: localManualFallbackGraceMs,
      waitForLoginToSettle: params.waitForLoginToSettle,
    });
    if (settledDuringGraceWindow === "settled") {
      return await createNeverSettlingPromptResult();
    }

    params.updateProgress("Browser callback did not finish. Paste the redirect URL to continue…");
    params.runtime.log(
      `OpenAI Codex OAuth callback did not arrive within ${localManualFallbackDelayMs}ms; switching to manual entry (callback_timeout).`,
    );
    params.stopProgress("Manual OAuth entry required");
    return await params.onPrompt({
      message: manualInputPromptMessage,
    });
  };

  return async () => {
    manualFallbackPromise ??= runLocalManualFallback();
    return await manualFallbackPromise;
  };
}

function decodeBase64UrlJson(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
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

function extractAccountId(accessToken: string): string | null {
  const payload = decodeBase64UrlJson(accessToken.split(".")[1] ?? "");
  const auth =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)[OPENAI_CODEX_JWT_CLAIM_PATH]
      : null;
  const authRecord = auth && typeof auth === "object" ? (auth as Record<string, unknown>) : null;
  const accountId = authRecord?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : null;
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
  const accountId = extractAccountId(access);
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
  const accountId = extractAccountId(json.access_token);
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
  provider: "openai-codex",
  looksLikeCallbackInput: looksLikeOpenAICodexCallbackInput,
  createPendingAuthorization: async (params) => {
    if (params?.preferredFlow === "callback") {
      return {
        flow: "callback",
        ...createOpenAICodexManualAuthorization({ originator: params.originator }),
      };
    }
    try {
      return await createOpenAICodexDeviceAuthorization();
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
      state: pending.state ?? "",
      verifier: pending.verifier ?? "",
      redirectUri: pending.redirectUri,
    }),
  pollPendingAuthorization: async ({ pending }) => {
    const authorization = await pollOpenAICodexDeviceAuthorization({
      deviceAuthId: pending.deviceAuthId,
      userCode: pending.userCode,
      expiresAt: pending.expiresAt,
    });
    if (!authorization) {
      return null;
    }
    return await exchangeOpenAICodexDeviceAuthorization(authorization);
  },
};

export async function loginOpenAICodexOAuth(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  signal?: AbortSignal;
  originator?: string;
  onManualCodeInput?: () => Promise<string>;
  localBrowserMessage?: string;
}): Promise<OAuthCredentials | null> {
  const { prompter, runtime, isRemote, openUrl, localBrowserMessage } = params;

  ensureGlobalUndiciEnvProxyDispatcher();

  const preflight = await runOpenAIOAuthTlsPreflight();
  if (!preflight.ok && preflight.kind === "tls-cert") {
    const hint = formatOpenAIOAuthTlsPreflightFix(preflight);
    await prompter.note(hint, "OAuth prerequisites");
    runtime.error(hint);
    throw new Error(`OpenAI Codex OAuth prerequisites failed: ${preflight.message}`);
  }

  await prompter.note(
    isRemote
      ? [
          "You are running in a remote/VPS environment.",
          "A URL will be shown for you to open in your LOCAL browser.",
          "Open it, sign in, then paste the redirect URL here.",
          "If this OpenClaw process can receive the browser callback, sign-in may finish automatically before you paste.",
        ].join("\n")
      : [
          "Browser will open for OpenAI authentication.",
          "If the callback doesn't auto-complete, paste the redirect URL.",
          "OpenAI OAuth uses localhost:1455 for the callback.",
        ].join("\n"),
    "OpenAI Codex OAuth",
  );

  const spin = prompter.progress("Starting OAuth flow…");
  let progressActive = true;
  const updateProgress = (message: string) => {
    if (progressActive) {
      spin.update(message);
    }
  };
  const stopProgress = (message?: string) => {
    if (progressActive) {
      progressActive = false;
      spin.stop(message);
    }
  };
  let browserAuthStarted = false;
  let markLoginSettled!: () => void;
  const waitForLoginToSettle = new Promise<void>((resolve) => {
    markLoginSettled = resolve;
  });
  try {
    const { onAuth: baseOnAuth, onPrompt } = createVpsAwareOAuthHandlers({
      isRemote,
      prompter,
      runtime,
      spin,
      openUrl,
      localBrowserMessage: localBrowserMessage ?? "Complete sign-in in browser…",
      manualPromptMessage: manualInputPromptMessage,
    });
    const onAuth: typeof baseOnAuth = async (event) => {
      browserAuthStarted = true;
      await baseOnAuth(event);
    };
    const oauth = { createVpsAwareHandlers: createVpsAwareOAuthHandlers };
    const providerOAuth = resolveProviderRuntimePlugin({
      provider: "openai",
      config: {},
    })?.auth?.find((entry) => entry.id === "oauth")?.run;
    if (providerOAuth) {
      const result = await providerOAuth({
        config: {},
        prompter,
        runtime,
        isRemote,
        openUrl,
        signal: params.signal,
        onManualCodeInput: params.onManualCodeInput,
        oauth,
      });
      stopProgress("OpenAI OAuth complete");
      const credential = result.profiles[0]?.credential;
      return credential?.type === "oauth" ? credential : null;
    }

    const facade = loadActivatedBundledPluginPublicSurfaceModuleSync<{
      loginOpenAICodexOAuth: (facadeParams: {
        prompter: WizardPrompter;
        runtime: RuntimeEnv;
        isRemote: boolean;
        openUrl: (url: string) => Promise<void>;
        signal?: AbortSignal;
        originator?: string;
        onManualCodeInput?: () => Promise<string>;
        localBrowserMessage?: string;
        oauth: { createVpsAwareHandlers: typeof createVpsAwareOAuthHandlers };
      }) => Promise<OAuthCredentials | null>;
    }>({
      dirName: "openai",
      artifactBasename: "api.js",
    });
    const creds = await facade.loginOpenAICodexOAuth({
      prompter,
      runtime,
      isRemote,
      openUrl,
      signal: params.signal,
      onManualCodeInput: params.onManualCodeInput,
      localBrowserMessage,
      oauth,
    });
    stopProgress("OpenAI OAuth complete");
    return creds ?? null;
  } catch (err) {
    stopProgress("OpenAI OAuth failed");
    const rewrittenError = rewriteOpenAICodexOAuthError(err);
    runtime.error(String(rewrittenError));
    await prompter.note("Trouble with OAuth? See https://docs.openclaw.ai/start/faq", "OAuth help");
    throw rewrittenError;
  } finally {
    markLoginSettled();
  }
}
