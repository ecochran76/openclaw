import type { OAuthCredentials } from "../llm/oauth.js";
import type { ChatReauthCapability } from "./provider-auth-types.js";

const PROVIDER_ID = "xai";
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const XAI_OAUTH_FETCH_TIMEOUT_MS = 30_000;
const XAI_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const XAI_DEVICE_CODE_DEFAULT_EXPIRES_IN_MS = 5 * 60_000;

type XaiDeviceCodeDiscovery = {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
};

type XaiDeviceCodeAuthorization = {
  flow: "device_code";
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  authorizationUrl: string;
  intervalMs: number;
  createdAt: number;
  expiresAt: number;
};

function readStringRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizePositiveSecondsToMs(value: unknown): number | undefined {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds * 1000) : undefined;
}

function isTrustedXaiOAuthEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && (url.hostname === "x.ai" || url.hostname.endsWith(".x.ai"));
  } catch {
    return false;
  }
}

function requireTrustedXaiOAuthEndpoint(endpoint: string, label: string): string {
  if (!isTrustedXaiOAuthEndpoint(endpoint)) {
    throw new Error(`xAI OAuth discovery returned untrusted ${label}`);
  }
  return endpoint;
}

function xaiUserAgent(): string {
  const version = process.env.OPENCLAW_VERSION?.trim();
  return version ? `openclaw/${version}` : "openclaw";
}

async function readJsonResponse(response: Response, context: string): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const json = readStringRecord(body);
    const errorText = json.error_description ?? json.error;
    throw new Error(
      `${context} failed (${response.status})${typeof errorText === "string" ? `: ${errorText}` : ""}`,
    );
  }
  return body;
}

async function fetchXaiDeviceCodeDiscovery(): Promise<XaiDeviceCodeDiscovery> {
  const response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": xaiUserAgent(),
    },
    signal: AbortSignal.timeout(XAI_OAUTH_FETCH_TIMEOUT_MS),
  });
  const json = readStringRecord(await readJsonResponse(response, "xAI OAuth discovery"));
  const deviceAuthorizationEndpoint = readNonEmptyString(json.device_authorization_endpoint);
  const tokenEndpoint = readNonEmptyString(json.token_endpoint);
  if (!deviceAuthorizationEndpoint || !tokenEndpoint) {
    throw new Error("xAI OAuth discovery response is missing device code endpoints");
  }
  return {
    deviceAuthorizationEndpoint: requireTrustedXaiOAuthEndpoint(
      deviceAuthorizationEndpoint,
      "device authorization endpoint",
    ),
    tokenEndpoint: requireTrustedXaiOAuthEndpoint(tokenEndpoint, "token endpoint"),
  };
}

async function createXaiDeviceAuthorization(
  params: { now?: () => number } = {},
): Promise<XaiDeviceCodeAuthorization> {
  const now = params.now ?? Date.now;
  const discovery = await fetchXaiDeviceCodeDiscovery();
  const response = await fetch(discovery.deviceAuthorizationEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": xaiUserAgent(),
    },
    body: new URLSearchParams({
      client_id: XAI_OAUTH_CLIENT_ID,
      scope: XAI_OAUTH_SCOPE,
    }),
    signal: AbortSignal.timeout(XAI_OAUTH_FETCH_TIMEOUT_MS),
  });
  const json = readStringRecord(await readJsonResponse(response, "xAI device code request"));
  const deviceCode = readNonEmptyString(json.device_code);
  const userCode = readNonEmptyString(json.user_code);
  const verificationUri = readNonEmptyString(json.verification_uri);
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error(
      "xAI device code response is missing device_code, user_code, or verification_uri",
    );
  }
  const verificationUriComplete = readNonEmptyString(json.verification_uri_complete);
  const trustedVerificationUri = requireTrustedXaiOAuthEndpoint(
    verificationUri,
    "device verification URI",
  );
  const verificationUrl = verificationUriComplete
    ? requireTrustedXaiOAuthEndpoint(verificationUriComplete, "complete device verification URI")
    : trustedVerificationUri;
  const createdAt = now();
  return {
    flow: "device_code",
    deviceAuthId: deviceCode,
    userCode,
    verificationUrl,
    authorizationUrl: verificationUrl,
    intervalMs: normalizePositiveSecondsToMs(json.interval) ?? XAI_DEVICE_CODE_DEFAULT_INTERVAL_MS,
    createdAt,
    expiresAt:
      createdAt +
      (normalizePositiveSecondsToMs(json.expires_in) ?? XAI_DEVICE_CODE_DEFAULT_EXPIRES_IN_MS),
  };
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> {
  const part = token?.split(".")[1];
  if (!part) {
    return {};
  }
  try {
    return readStringRecord(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
  } catch {
    return {};
  }
}

function normalizeExpires(value: unknown): number | undefined {
  const expiresInMs = normalizePositiveSecondsToMs(value);
  return expiresInMs ? Date.now() + expiresInMs : undefined;
}

function parseXaiOAuthCredentials(value: unknown): OAuthCredentials {
  const json = readStringRecord(value);
  const access = readNonEmptyString(json.access_token);
  const refresh = readNonEmptyString(json.refresh_token);
  if (!access || !refresh) {
    throw new Error("xAI OAuth token response is missing access_token or refresh_token");
  }
  const idToken = readNonEmptyString(json.id_token);
  const payload = decodeJwtPayload(idToken ?? access);
  const email = readNonEmptyString(payload.email);
  const displayName = readNonEmptyString(payload.name);
  const accountId = readNonEmptyString(payload.sub);
  return {
    access,
    refresh,
    expires:
      normalizeExpires(json.expires_in) ?? Date.now() + XAI_DEVICE_CODE_DEFAULT_EXPIRES_IN_MS,
    issuer: XAI_OAUTH_ISSUER,
    authFlow: "device-code",
    ...(idToken ? { idToken } : {}),
    ...(email ? { email } : {}),
    ...(displayName ? { displayName } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

async function pollXaiDeviceAuthorization(params: {
  deviceAuthId?: string;
}): Promise<OAuthCredentials | null> {
  if (!params.deviceAuthId) {
    throw new Error("xAI device code re-auth is missing its device code");
  }
  const discovery = await fetchXaiDeviceCodeDiscovery();
  const response = await fetch(discovery.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": xaiUserAgent(),
    },
    body: new URLSearchParams({
      grant_type: XAI_DEVICE_CODE_GRANT_TYPE,
      client_id: XAI_OAUTH_CLIENT_ID,
      device_code: params.deviceAuthId,
    }),
    signal: AbortSignal.timeout(XAI_OAUTH_FETCH_TIMEOUT_MS),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok) {
    return parseXaiOAuthCredentials(body);
  }
  const error = readNonEmptyString(readStringRecord(body).error);
  if (error === "authorization_pending" || error === "slow_down") {
    return null;
  }
  if (error === "access_denied" || error === "authorization_denied") {
    throw new Error("xAI device authorization was denied");
  }
  if (error === "expired_token") {
    throw new Error("xAI device code expired. Start a new /reauth flow.");
  }
  const detail = readNonEmptyString(readStringRecord(body).error_description) ?? error;
  throw new Error(
    `xAI device token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`,
  );
}

export const xaiChatReauthCapability: ChatReauthCapability = {
  provider: PROVIDER_ID,
  looksLikeCallbackInput: () => false,
  createPendingAuthorization: async () => await createXaiDeviceAuthorization(),
  completePendingAuthorization: async () => {
    throw new Error("xAI Slack re-auth uses device-code login; start with /reauth --device-code.");
  },
  pollPendingAuthorization: async ({ pending }) =>
    await pollXaiDeviceAuthorization({ deviceAuthId: pending.deviceAuthId }),
};
