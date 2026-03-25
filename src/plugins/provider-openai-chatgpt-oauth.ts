// Bridges OpenAI ChatGPT OAuth credentials into provider plugin auth.
import { createHash, randomBytes } from "node:crypto";
import type { OAuthCredentials } from "../llm/oauth.js";
import { resolveOpenAICodexAccountId } from "../llm/utils/oauth/openai-chatgpt-jwt.js";
import { loadActivatedBundledPluginPublicSurfaceModuleSync } from "../plugin-sdk/facade-runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { resolveProviderRuntimePlugin } from "./provider-hook-runtime.js";
import { createVpsAwareOAuthHandlers } from "./provider-oauth-flow.js";
import type { ProviderAuthContext } from "./types.js";

const OPENAI_CODEX_PROVIDER_ID = "openai";
const OPENAI_CODEX_OAUTH_METHOD_ID = "oauth";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const OPENAI_CODEX_SCOPE = "openid profile email offline_access";

type OpenAICodexOAuthBridgeContext = ProviderAuthContext & {
  signal?: AbortSignal;
  onManualCodeInput?: () => Promise<string>;
};

export type OpenAICodexManualAuthorization = {
  state: string;
  verifier: string;
  authorizationUrl: string;
  redirectUri: string;
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

function parseManualAuthorizationInput(
  input: string,
  expectedState: string,
): { code: string; state: string } {
  const trimmed = input.trim();
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

export function looksLikeOpenAICodexCallbackInput(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) {
    return false;
  }
  return (
    /\/auth\/callback\?/i.test(trimmed) ||
    (/code=/.test(trimmed) && /state=/.test(trimmed)) ||
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
