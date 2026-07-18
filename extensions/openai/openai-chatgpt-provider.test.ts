// Openai tests cover openai chatgpt provider plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const refreshOpenAICodexTokenMock = vi.hoisted(() => vi.fn());
const loginOpenAICodexDeviceCodeMock = vi.hoisted(() => vi.fn());

vi.mock("./openai-chatgpt-provider.runtime.js", () => ({
  refreshOpenAICodexToken: refreshOpenAICodexTokenMock,
}));

vi.mock("./openai-chatgpt-device-code.js", () => ({
  loginOpenAICodexDeviceCode: loginOpenAICodexDeviceCodeMock,
}));

let buildOpenAIProvider: typeof import("./openai-provider.js").buildOpenAIProvider;
const CODEX_PROVIDER_CONFIG = {
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
} as const;

describe("OpenAI provider Codex transport hooks", () => {
  beforeAll(async () => {
    ({ buildOpenAIProvider } = await import("./openai-provider.js"));
  });

  beforeEach(() => {
    refreshOpenAICodexTokenMock.mockReset();
    loginOpenAICodexDeviceCodeMock.mockReset();
  });

  it("exposes ChatGPT OAuth on the canonical OpenAI provider", () => {
    const provider = buildOpenAIProvider();

    expect(provider.id).toBe("openai");
    expect(provider.aliases).toBeUndefined();
    expect(provider.hookAliases).toEqual(["azure-openai", "azure-openai-responses"]);
    expect(provider.auth?.map((method) => method.id)).toEqual(["oauth", "device-code", "api-key"]);
    expect(provider.auth?.map((method) => method.wizard?.choiceId)).toEqual([
      "openai",
      "openai-device-code",
      "openai-api-key",
    ]);
    expect(provider.oauthProfileIdRepairs).toBeUndefined();
  });

  it("stores device-code logins as OpenAI OAuth profiles", async () => {
    const provider = buildOpenAIProvider();
    const deviceCodeMethod = provider.auth?.find((method) => method.id === "device-code");
    const controller = new AbortController();
    loginOpenAICodexDeviceCodeMock.mockResolvedValueOnce({
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_700_000_000_000,
    });

    const result = await deviceCodeMethod?.run({
      isRemote: false,
      openUrl: vi.fn(async () => {}),
      prompter: {
        note: vi.fn(async () => {}),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      },
      runtime: { log: vi.fn(), error: vi.fn() },
      config: {},
      oauth: {},
      signal: controller.signal,
    } as never);

    expect(loginOpenAICodexDeviceCodeMock).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );

    expect(result?.profiles?.[0]).toMatchObject({
      profileId: "openai:default",
      credential: {
        type: "oauth",
        provider: "openai",
        access: "access-token",
        refresh: "refresh-token",
      },
    });
    expect(result?.defaultModel).toBe("openai/gpt-5.6-sol");
    expect(result?.configPatch?.agents?.defaults?.models).toEqual({
      "openai/gpt-5.6-sol": {},
    });
  });

  async function runRemoteDeviceCodeAuthFlow(env: NodeJS.ProcessEnv = process.env) {
    const provider = buildOpenAIProvider();
    const deviceCodeMethod = provider.auth?.find((method) => method.id === "device-code");
    const note = vi.fn(async () => {});
    const progress = { update: vi.fn(), stop: vi.fn() };
    const runtime = { log: vi.fn(), error: vi.fn() };
    loginOpenAICodexDeviceCodeMock.mockImplementationOnce(async ({ onVerification }) => {
      await onVerification({
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "CODE-12345",
        expiresInMs: 900_000,
      });
      return {
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      };
    });

    const result = await deviceCodeMethod?.run({
      config: {},
      env,
      prompter: {
        note,
        progress: vi.fn(() => progress),
      },
      runtime,
      isRemote: true,
      openUrl: async () => {},
      oauth: {},
    } as never);

    expect(result?.profiles?.map((profile) => profile.profileId)).toContain("openai:default");
    return { note, runtime };
  }

  it("shows the device pairing code on the remote operator prompt", async () => {
    const { note } = await runRemoteDeviceCodeAuthFlow();

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Code: CODE-12345"),
      "OpenAI Codex device code",
    );
  });

  it("does not write the device pairing code to the runtime log in remote mode", async () => {
    const { runtime } = await runRemoteDeviceCodeAuthFlow();

    const logOutput = runtime.log.mock.calls.flat().join("\n");
    expect(logOutput).toContain("https://auth.openai.com/codex/device");
    expect(logOutput).not.toContain("CODE-12345");
  });

  it("shows the device pairing code in remote mode with an explicit operator override", async () => {
    const { note, runtime } = await runRemoteDeviceCodeAuthFlow({
      ...process.env,
      OPENCLAW_SHOW_REMOTE_DEVICE_CODE: "1",
    });

    const logOutput = runtime.log.mock.calls.flat().join("\n");
    expect(logOutput).toContain("https://auth.openai.com/codex/device");
    expect(logOutput).not.toContain("CODE-12345");
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Code: CODE-12345"),
      "OpenAI Codex device code",
    );
  });

  it("routes Codex-backed OpenAI models through the Codex Responses transport", () => {
    const provider = buildOpenAIProvider();

    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4",
      providerConfig: { api: "openai-chatgpt-responses" },
      modelRegistry: { find: () => null },
    } as never);

    expect(model).toMatchObject({
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
  });

  it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])(
    "resolves %s through the Codex Responses transport without live catalog metadata",
    (modelId) => {
      const provider = buildOpenAIProvider();

      const model = provider.resolveDynamicModel?.({
        provider: "openai",
        modelId,
        authProfileMode: "oauth",
        providerConfig: CODEX_PROVIDER_CONFIG,
        modelRegistry: { find: () => null },
      } as never);

      expect(model).toMatchObject({
        provider: "openai",
        id: modelId,
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        input: ["text", "image"],
        contextWindow: 372_000,
        contextTokens: 372_000,
        maxTokens: 128_000,
        thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
      });
    },
  );

  it("does not invent a bare GPT-5.6 alias for the Codex transport", () => {
    const provider = buildOpenAIProvider();

    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.6",
      authProfileMode: "oauth",
      providerConfig: CODEX_PROVIDER_CONFIG,
      modelRegistry: { find: () => null },
    } as never);

    expect(model).toBeUndefined();
  });

  it.each([
    { name: "fills a missing map", thinkingLevelMap: undefined, expectedOff: null },
    { name: "preserves explicit overrides", thinkingLevelMap: { off: "low" }, expectedOff: "low" },
  ])("$name on registry-backed GPT-5.6 models", ({ thinkingLevelMap, expectedOff }) => {
    const provider = buildOpenAIProvider();
    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      authProfileMode: "oauth",
      providerConfig: CODEX_PROVIDER_CONFIG,
      modelRegistry: {
        find: () => ({
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          reasoning: true,
          input: ["text"],
          cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
          contextWindow: 372_000,
          maxTokens: 128_000,
          ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        }),
      },
    } as never);

    expect(model).toMatchObject({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      input: ["text", "image"],
      thinkingLevelMap: { off: expectedOff, xhigh: "xhigh", max: "max" },
    });
  });

  it("keeps default Codex-backed OpenAI catalog models on the Codex Responses transport", () => {
    const provider = buildOpenAIProvider();

    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.5",
      providerConfig: { api: "openai-chatgpt-responses" },
      modelRegistry: {
        find: () => ({
          provider: "openai",
          id: "gpt-5.5",
          name: "gpt-5.5",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
          contextWindow: 400_000,
          maxTokens: 128_000,
        }),
      },
    } as never);

    expect(model).toMatchObject({
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
  });

  it("keeps cloned Codex-backed OpenAI models on the Codex Responses transport", () => {
    const provider = buildOpenAIProvider();

    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4",
      providerConfig: { api: "openai-chatgpt-responses" },
      modelRegistry: {
        find: () => ({
          provider: "openai",
          id: "gpt-5.4",
          name: "gpt-5.4",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
          contextWindow: 128_000,
          maxTokens: 16_384,
        }),
      },
    } as never);

    expect(model).toMatchObject({
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
  });

  it("refreshes ChatGPT OAuth credentials under the OpenAI provider", async () => {
    const provider = buildOpenAIProvider();
    refreshOpenAICodexTokenMock.mockResolvedValueOnce({
      access: "new-access",
      refresh: "new-refresh",
      expires: 1_700_000_000_000,
    });

    await expect(
      provider.refreshOAuth?.({
        type: "oauth",
        provider: "openai",
        access: "old-access",
        refresh: "old-refresh",
        expires: Date.now() - 60_000,
      }),
    ).resolves.toMatchObject({
      type: "oauth",
      provider: "openai",
      access: "new-access",
      refresh: "new-refresh",
    });
  });

  it("keeps prior account metadata while retaining refreshed and rotated tokens", async () => {
    const provider = buildOpenAIProvider();
    const credential = {
      type: "oauth" as const,
      provider: "openai",
      access: "cached-access-token",
      refresh: "refresh-token",
      expires: Date.now() - 60_000,
      accountId: "acct-123",
    };
    refreshOpenAICodexTokenMock.mockResolvedValueOnce({
      access: "opaque-refreshed-access-token",
      refresh: "rotated-refresh-token",
      expires: Date.now() + 60_000,
    });

    await expect(provider.refreshOAuth?.(credential)).resolves.toMatchObject({
      type: "oauth",
      provider: "openai",
      access: "opaque-refreshed-access-token",
      refresh: "rotated-refresh-token",
      accountId: "acct-123",
    });
  });

  it("formats OAuth credentials with account metadata for ChatGPT responses", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider.formatApiKey?.({
        type: "oauth",
        provider: "openai",
        access: "chatgpt-access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
        accountId: "acct-123",
      }),
    ).toBe(JSON.stringify({ token: "chatgpt-access-token", accountId: "acct-123" }));
  });

  it("unwraps Codex transport auth before usage fetches", async () => {
    const provider = buildOpenAIProvider();

    await expect(
      provider.resolveUsageAuth?.({
        provider: "openai",
        config: {},
        env: {},
        resolveApiKeyFromConfigAndStore: () => undefined,
        resolveOAuthToken: async () => ({
          token: JSON.stringify({ token: "codex-access-token", accountId: "acct-123" }),
        }),
      }),
    ).resolves.toEqual({
      token: "codex-access-token",
      accountId: "acct-123",
    });
  });
});
