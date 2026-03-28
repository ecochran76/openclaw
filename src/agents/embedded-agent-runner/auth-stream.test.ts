import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createAuthAwareStreamFn } from "./auth-stream.js";

describe("createAuthAwareStreamFn", () => {
  const streamSimpleMock = vi.fn();

  beforeEach(() => {
    streamSimpleMock.mockReset().mockReturnValue({ kind: "stream" });
  });

  it("injects model-registry auth into the default stream path", async () => {
    const modelRegistry = {
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true as const,
        apiKey: "oauth-token",
        headers: { "X-Auth-Source": "registry" },
      })),
    };
    const streamFn = createAuthAwareStreamFn({
      modelRegistry,
      deps: {
        streamSimple: streamSimpleMock,
      },
    });
    const model = {
      provider: "openai-codex",
      id: "gpt-5.4",
      api: "openai-codex-responses",
      input: ["text"],
    } as unknown as Model<Api>;
    const context = {
      messages: [],
    } as never;

    await streamFn(model, context, {
      headers: { "X-Call": "1" },
    });

    expect(modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(model);
    expect(streamSimpleMock).toHaveBeenCalledWith(
      model,
      context,
      expect.objectContaining({
        apiKey: "oauth-token",
        headers: {
          "X-Auth-Source": "registry",
          "X-Call": "1",
        },
      }),
    );
  });

  it("preserves explicit per-call apiKey overrides", async () => {
    const streamFn = createAuthAwareStreamFn({
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({
          ok: true as const,
          apiKey: "oauth-token",
          headers: undefined,
        })),
      },
      deps: {
        streamSimple: streamSimpleMock,
      },
    });

    await streamFn({} as never, {} as never, {
      apiKey: "explicit-key",
    });

    expect(streamSimpleMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        apiKey: "explicit-key",
      }),
    );
  });

  it("surfaces model-registry auth errors before calling the provider stream", async () => {
    const streamFn = createAuthAwareStreamFn({
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({
          ok: false as const,
          error: 'No API key found for "openai-codex"',
        })),
      },
      deps: {
        streamSimple: streamSimpleMock,
      },
    });

    await expect(streamFn({} as never, {} as never, {})).rejects.toThrow(
      'No API key found for "openai-codex"',
    );
    expect(streamSimpleMock).not.toHaveBeenCalled();
  });
});
