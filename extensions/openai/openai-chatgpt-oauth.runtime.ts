import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import { ensureGlobalUndiciEnvProxyDispatcher } from "openclaw/plugin-sdk/runtime-env";
import { formatCliCommand } from "openclaw/plugin-sdk/setup-tools";

const manualInputPromptMessage = "Paste the authorization code (or full redirect URL):";
const openAICodexOAuthOriginator = "openclaw";
const openAICodexClientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const openAICodexAuthorizeUrl = "https://auth.openai.com/oauth/authorize";
const openAICodexTokenUrl = "https://auth.openai.com/oauth/token";
const openAICodexRedirectUri = "http://localhost:1455/auth/callback";
const openAICodexCallbackHost = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
export const openAICodexOAuthScope =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
const localManualFallbackDelayMs = 15_000;
const localManualFallbackGraceMs = 1_000;
const openAIAuthProbeUrl =
  "https://auth.openai.com/oauth/authorize?response_type=code&client_id=openclaw-preflight&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email";
const jwtClaimPath = "https://api.openai.com/auth";

const tlsCertErrorCodes = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const tlsCertErrorPatterns = [
  /unable to get local issuer certificate/i,
  /unable to verify the first certificate/i,
  /self[- ]signed certificate/i,
  /certificate has expired/i,
];

type OpenAICodexOAuthFailureCode =
  | "callback_timeout"
  | "callback_validation_failed"
  | "unsupported_region";

type PreflightFailureKind = "tls-cert" | "network";
type OpenAIOAuthTlsPreflightResult =
  | { ok: true }
  | {
      ok: false;
      kind: PreflightFailureKind;
      code?: string;
      message: string;
    };

type OAuthCredentials = {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
};

type OpenAICodexAuthorizationFlow = {
  state: string;
  url: string;
  verifier: string;
};

type OpenAICodexLocalOAuthServer = {
  cancelWait: () => void;
  close: () => void;
  waitForCode: () => Promise<{ code: string } | null>;
};

type OpenAICodexTokenExchangeResult =
  | {
      type: "success";
      access: string;
      refresh: string;
      expires: number;
    }
  | {
      type: "failed";
      status?: number;
      message: string;
    };

function getErrorRecord(error: unknown): Record<string, unknown> | null {
  return error && typeof error === "object" ? (error as Record<string, unknown>) : null;
}

function extractFailure(error: unknown): {
  code?: string;
  message: string;
  kind: PreflightFailureKind;
} {
  const root = getErrorRecord(error);
  const rootCause = getErrorRecord(root?.cause);
  const code = typeof rootCause?.code === "string" ? rootCause.code : undefined;
  const message =
    typeof rootCause?.message === "string"
      ? rootCause.message
      : typeof root?.message === "string"
        ? root.message
        : String(error);
  const isTlsCertError =
    (code ? tlsCertErrorCodes.has(code) : false) ||
    tlsCertErrorPatterns.some((pattern) => pattern.test(message));
  return {
    code,
    message,
    kind: isTlsCertError ? "tls-cert" : "network",
  };
}

function resolveHomebrewPrefixFromExecPath(execPath: string): string | null {
  const marker = `${path.sep}Cellar${path.sep}`;
  const idx = execPath.indexOf(marker);
  if (idx > 0) {
    return execPath.slice(0, idx);
  }
  return process.env.HOMEBREW_PREFIX?.trim() || null;
}

function resolveCertBundlePath(): string | null {
  const prefix = resolveHomebrewPrefixFromExecPath(process.execPath);
  return prefix ? path.join(prefix, "etc", "openssl@3", "cert.pem") : null;
}

async function runOpenAIOAuthTlsPreflight(options?: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<OpenAIOAuthTlsPreflightResult> {
  const timeoutMs = Math.min(options?.timeoutMs ?? 5000, MAX_TIMER_TIMEOUT_MS);
  const fetchImpl = options?.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(openAIAuthProbeUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return { ok: true };
  } catch (error) {
    const failure = extractFailure(error);
    return {
      ok: false,
      kind: failure.kind,
      code: failure.code,
      message: failure.message,
    };
  }
}

function formatOpenAIOAuthTlsPreflightFix(
  result: Exclude<OpenAIOAuthTlsPreflightResult, { ok: true }>,
): string {
  if (result.kind !== "tls-cert") {
    return [
      "OpenAI OAuth prerequisites check failed due to a network error before the browser flow.",
      `Cause: ${result.message}`,
      "Verify DNS/firewall/proxy access to auth.openai.com and retry.",
    ].join("\n");
  }
  const certBundlePath = resolveCertBundlePath();
  const lines = [
    "OpenAI OAuth prerequisites check failed: Node/OpenSSL cannot validate TLS certificates.",
    `Cause: ${result.code ? `${result.code} (${result.message})` : result.message}`,
    "",
    "Fix (Homebrew Node/OpenSSL):",
    `- ${formatCliCommand("brew postinstall ca-certificates")}`,
    `- ${formatCliCommand("brew postinstall openssl@3")}`,
  ];
  if (certBundlePath) {
    lines.push(`- Verify cert bundle exists: ${certBundlePath}`);
  }
  lines.push("- Retry the OAuth login flow.");
  return lines.join("\n");
}

function settleAfterDelay(params: {
  delayMs: number;
  waitForLoginToSettle: Promise<void>;
}): Promise<"delay" | "settled"> {
  return new Promise((resolve) => {
    let done = false;
    const complete = (outcome: "delay" | "settled") => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => complete("delay"), params.delayMs);
    params.waitForLoginToSettle.then(
      () => complete("settled"),
      () => complete("settled"),
    );
  });
}

function waitForeverForPromptInput(): Promise<string> {
  return new Promise<string>(() => undefined);
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) {
    return {};
  }
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // Fall through to non-URL forms.
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  return { code: value };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) {
      return null;
    }
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function getOpenAICodexAccountId(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.[jwtClaimPath];
  if (!auth || typeof auth !== "object") {
    return null;
  }
  const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

async function createOpenAICodexAuthorizationFlow(
  originator = openAICodexOAuthOriginator,
): Promise<OpenAICodexAuthorizationFlow> {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = randomBytes(16).toString("hex");
  const url = new URL(openAICodexAuthorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", openAICodexClientId);
  url.searchParams.set("redirect_uri", openAICodexRedirectUri);
  url.searchParams.set("scope", openAICodexOAuthScope);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", originator);
  return { state, url: url.toString(), verifier };
}

function oauthHtml(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>OpenClaw OAuth</title><body>${message}</body>`;
}

function startOpenAICodexLocalOAuthServer(state: string): Promise<OpenAICodexLocalOAuthServer> {
  let server: Server | undefined;
  let settleWait: ((value: { code: string } | null) => void) | undefined;
  const waitForCodePromise = new Promise<{ code: string } | null>((resolve) => {
    let settled = false;
    settleWait = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
  });

  server = createServer((req, res) => {
    try {
      const url = new URL(req.url || "", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(oauthHtml("Callback route not found."));
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(oauthHtml("State mismatch."));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(oauthHtml("Missing authorization code."));
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(oauthHtml("OpenAI authentication completed. You can close this window."));
      settleWait?.({ code });
    } catch {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(oauthHtml("Internal error while processing OAuth callback."));
    }
  });

  return new Promise((resolve) => {
    server
      ?.listen(1455, openAICodexCallbackHost, () => {
        resolve({
          cancelWait: () => settleWait?.(null),
          close: () => server?.close(),
          waitForCode: () => waitForCodePromise,
        });
      })
      .on("error", () => {
        settleWait?.(null);
        resolve({
          cancelWait: () => undefined,
          close: () => {
            try {
              server?.close();
            } catch {
              // ignore close races
            }
          },
          waitForCode: async () => null,
        });
      });
  });
}

async function exchangeOpenAICodexAuthorizationCode(
  code: string,
  verifier: string,
): Promise<OpenAICodexTokenExchangeResult> {
  const response = await fetch(openAICodexTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: openAICodexClientId,
      code,
      code_verifier: verifier,
      redirect_uri: openAICodexRedirectUri,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      type: "failed",
      status: response.status,
      message: `OpenAI Codex token exchange failed (${response.status}): ${text || response.statusText}`,
    };
  }
  const json = (await response.json()) as Record<string, unknown>;
  if (
    typeof json.access_token !== "string" ||
    typeof json.refresh_token !== "string" ||
    typeof json.expires_in !== "number"
  ) {
    return {
      type: "failed",
      message: `OpenAI Codex token exchange response missing fields: ${JSON.stringify(json)}`,
    };
  }
  return {
    type: "success",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

async function loginOpenAICodexWithOpenClawOAuth(params: {
  onAuth: (event: { url: string; instructions: string }) => Promise<void> | void;
  onManualCodeInput?: () => Promise<string>;
  onProgress?: (message: string) => void;
  onPrompt: (prompt: { message: string }) => Promise<string>;
  originator?: string;
}): Promise<OAuthCredentials> {
  const { state, url, verifier } = await createOpenAICodexAuthorizationFlow(params.originator);
  const server = await startOpenAICodexLocalOAuthServer(state);
  await params.onAuth({
    url,
    instructions: "A browser window should open. Complete login to finish.",
  });

  let code: string | undefined;
  try {
    if (params.onManualCodeInput) {
      let manualCode: string | undefined;
      let manualError: Error | undefined;
      const manualPromise = params
        .onManualCodeInput()
        .then((input) => {
          manualCode = input;
          server.cancelWait();
        })
        .catch((err) => {
          manualError = err instanceof Error ? err : new Error(String(err));
          server.cancelWait();
        });
      const result = await server.waitForCode();
      if (manualError) {
        throw manualError;
      }
      if (result?.code) {
        code = result.code;
      } else if (manualCode) {
        const parsed = parseAuthorizationInput(manualCode);
        if (parsed.state && parsed.state !== state) {
          throw new Error("State mismatch");
        }
        code = parsed.code;
      }
      if (!code) {
        await manualPromise;
        if (manualError) {
          throw manualError;
        }
        if (manualCode) {
          const parsed = parseAuthorizationInput(manualCode);
          if (parsed.state && parsed.state !== state) {
            throw new Error("State mismatch");
          }
          code = parsed.code;
        }
      }
    } else {
      const result = await server.waitForCode();
      if (result?.code) {
        code = result.code;
      }
    }

    if (!code) {
      const input = await params.onPrompt({ message: manualInputPromptMessage });
      const parsed = parseAuthorizationInput(input);
      if (parsed.state && parsed.state !== state) {
        throw new Error("State mismatch");
      }
      code = parsed.code;
    }
    if (!code) {
      throw new Error("Missing authorization code");
    }

    params.onProgress?.("Exchanging OAuth code...");
    const tokenResult = await exchangeOpenAICodexAuthorizationCode(code, verifier);
    if (tokenResult.type !== "success") {
      throw new Error(tokenResult.message);
    }
    const accountId = getOpenAICodexAccountId(tokenResult.access);
    if (!accountId) {
      throw new Error("Failed to extract accountId from token");
    }
    return {
      access: tokenResult.access,
      refresh: tokenResult.refresh,
      expires: tokenResult.expires,
      accountId,
    };
  } finally {
    server.close();
  }
}

function createOpenAICodexOAuthError(
  code: OpenAICodexOAuthFailureCode,
  message: string,
  cause?: unknown,
): Error & { code: OpenAICodexOAuthFailureCode } {
  return Object.assign(new Error(`OpenAI Codex OAuth failed (${code}): ${message}`, { cause }), {
    code,
  });
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
  onPrompt: (prompt: { message: string }) => Promise<string>;
  runtime: ProviderAuthContext["runtime"];
  updateProgress: (message: string) => void;
  stopProgress: (message?: string) => void;
  waitForLoginToSettle: Promise<void>;
  hasBrowserAuthStarted: () => boolean;
}): (() => Promise<string>) | undefined {
  let manualFallbackPromise: Promise<string> | undefined;
  const promptForManualCode = () => params.onPrompt({ message: manualInputPromptMessage });
  if (params.isRemote) {
    return async () => {
      manualFallbackPromise ??= promptForManualCode();
      return await manualFallbackPromise;
    };
  }

  const switchToManualEntry = async (progressMessage: string, logMessage?: string) => {
    params.updateProgress(progressMessage);
    if (logMessage) {
      params.runtime.log(logMessage);
    }
    params.stopProgress("Manual OAuth entry required");
    return await promptForManualCode();
  };

  const runLocalManualFallback = async () => {
    if (!params.hasBrowserAuthStarted()) {
      return await switchToManualEntry(
        "Local OAuth callback was unavailable. Paste the redirect URL to continue...",
        "OpenAI Codex OAuth local callback did not start; switching to manual entry immediately.",
      );
    }

    const firstWait = await settleAfterDelay({
      delayMs: localManualFallbackDelayMs,
      waitForLoginToSettle: params.waitForLoginToSettle,
    });
    if (firstWait === "settled") {
      return await waitForeverForPromptInput();
    }
    const graceWait = await settleAfterDelay({
      delayMs: localManualFallbackGraceMs,
      waitForLoginToSettle: params.waitForLoginToSettle,
    });
    if (graceWait === "settled") {
      return await waitForeverForPromptInput();
    }
    return await switchToManualEntry(
      "Browser callback did not finish. Paste the redirect URL to continue...",
      `OpenAI Codex OAuth callback did not arrive within ${localManualFallbackDelayMs}ms; switching to manual entry (callback_timeout).`,
    );
  };

  return async () => {
    manualFallbackPromise ??= runLocalManualFallback();
    return await manualFallbackPromise;
  };
}

export async function loginOpenAICodexOAuth(params: {
  prompter: ProviderAuthContext["prompter"];
  runtime: ProviderAuthContext["runtime"];
  oauth: ProviderAuthContext["oauth"];
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
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

  const spin = prompter.progress("Starting OAuth flow...");
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
    const { onAuth: baseOnAuth, onPrompt } = params.oauth.createVpsAwareHandlers({
      isRemote,
      prompter,
      runtime,
      spin,
      openUrl,
      localBrowserMessage: localBrowserMessage ?? "Complete sign-in in browser...",
      manualPromptMessage: manualInputPromptMessage,
    });
    const onAuth: typeof baseOnAuth = async (event) => {
      browserAuthStarted = true;
      await baseOnAuth(event);
    };

    const creds = await loginOpenAICodexWithOpenClawOAuth({
      onAuth,
      onPrompt,
      originator: openAICodexOAuthOriginator,
      onManualCodeInput: createManualCodeInputHandler({
        isRemote,
        onPrompt,
        runtime,
        updateProgress,
        stopProgress,
        waitForLoginToSettle,
        hasBrowserAuthStarted: () => browserAuthStarted,
      }),
      onProgress: (msg: string) => updateProgress(msg),
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

export const testing = {
  runOpenAIOAuthTlsPreflight,
};
