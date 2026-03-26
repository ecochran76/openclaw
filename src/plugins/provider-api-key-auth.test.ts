import { describe, expect, it, vi } from "vitest";
import { createProviderApiKeyAuthMethod } from "./provider-api-key-auth.js";

function createPrompter() {
  return {
    note: vi.fn(async () => undefined),
    confirm: vi.fn(async () => true),
    text: vi.fn(async () => ""),
  };
}

describe("createProviderApiKeyAuthMethod", () => {
  it("uses the requested profile id for interactive single-profile API key auth", async () => {
    const method = createProviderApiKeyAuthMethod({
      providerId: "demo",
      methodId: "api-key",
      label: "Demo API key",
      optionKey: "demoApiKey",
      flagName: "--demo-api-key",
      envVar: "DEMO_API_KEY",
      promptMessage: "Enter Demo API key",
      defaultModel: "demo/model",
    });

    const result = await method.run({
      config: {},
      profileId: "demo:work",
      opts: { token: "sk-demo", tokenProvider: "demo" },
      prompter: createPrompter() as never,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
      allowSecretRefPrompt: false,
      isRemote: false,
      openUrl: vi.fn(async () => undefined),
      oauth: { createVpsAwareHandlers: vi.fn() as never },
    });

    expect(result.profiles.map((profile) => profile.profileId)).toEqual(["demo:work"]);
  });

  it("passes the requested profile id through non-interactive API key auth", async () => {
    const method = createProviderApiKeyAuthMethod({
      providerId: "demo",
      methodId: "api-key",
      label: "Demo API key",
      optionKey: "demoApiKey",
      flagName: "--demo-api-key",
      envVar: "DEMO_API_KEY",
      promptMessage: "Enter Demo API key",
      defaultModel: "demo/model",
    });
    const resolveApiKey = vi.fn(async () => ({ key: "sk-demo", source: "profile" as const }));

    const result = await method.runNonInteractive?.({
      authChoice: "demo-api-key",
      config: {},
      baseConfig: {},
      opts: {},
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
      profileId: "demo:work",
      resolveApiKey,
      toApiKeyCredential: vi.fn(),
    });

    expect(resolveApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "demo",
        profileId: "demo:work",
      }),
    );
    expect(result?.auth?.profiles?.["demo:work"]).toMatchObject({
      provider: "demo",
      mode: "api_key",
    });
  });

  it("keeps fixed-profile providers pinned even when a requested profile id is supplied", async () => {
    const method = createProviderApiKeyAuthMethod({
      providerId: "demo",
      methodId: "api-key",
      label: "Demo API key",
      optionKey: "demoApiKey",
      flagName: "--demo-api-key",
      envVar: "DEMO_API_KEY",
      promptMessage: "Enter Demo API key",
      profileId: "demo:fixed",
      allowProfile: false,
    });
    const resolveApiKey = vi.fn(async () => ({ key: "sk-demo", source: "profile" as const }));

    const interactive = await method.run({
      config: {},
      profileId: "demo:work",
      opts: { token: "sk-demo", tokenProvider: "demo" },
      prompter: createPrompter() as never,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
      allowSecretRefPrompt: false,
      isRemote: false,
      openUrl: vi.fn(async () => undefined),
      oauth: { createVpsAwareHandlers: vi.fn() as never },
    });

    const nonInteractive = await method.runNonInteractive?.({
      authChoice: "demo-api-key",
      config: {},
      baseConfig: {},
      opts: {},
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
      profileId: "demo:work",
      resolveApiKey,
      toApiKeyCredential: vi.fn(),
    });

    expect(interactive.profiles.map((profile) => profile.profileId)).toEqual(["demo:fixed"]);
    expect(resolveApiKey).toHaveBeenCalledWith(
      expect.not.objectContaining({
        profileId: "demo:work",
      }),
    );
    expect(nonInteractive?.auth?.profiles?.["demo:fixed"]).toMatchObject({
      provider: "demo",
      mode: "api_key",
    });
  });
});
