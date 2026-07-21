import { describe, expect, it } from "vitest";
import type { VoiceCallStreamingConfig } from "../config.js";
import {
  resolveBufferedMediaSttConfig,
  resolveOpenAIRealtimeSttConfig,
  resolveStreamingSttProviderConfig,
  resolveStreamingSttProviderId,
} from "./stt-provider-config.js";

function streamingConfig(overrides?: Partial<VoiceCallStreamingConfig>): VoiceCallStreamingConfig {
  return {
    enabled: true,
    streamPath: "/voice/stream",
    providers: {},
    preStartTimeoutMs: 5000,
    maxPendingConnections: 32,
    maxPendingConnectionsPerIp: 4,
    maxConnections: 128,
    ...overrides,
  };
}

describe("voice-call STT provider config", () => {
  it("defaults to the OpenAI realtime streaming provider", () => {
    expect(resolveStreamingSttProviderId(streamingConfig())).toBe("openai-realtime");
  });

  it("resolves provider-owned config blobs without widening factory logic", () => {
    const config = streamingConfig({
      provider: "media-audio",
      providers: {
        "media-audio": { silenceDurationMs: 900 },
      },
    });

    expect(resolveStreamingSttProviderConfig(config)).toEqual({ silenceDurationMs: 900 });
  });

  it("prefers explicit OpenAI API keys over the environment", () => {
    expect(
      resolveOpenAIRealtimeSttConfig(
        {
          apiKey: "sk-explicit",
          model: "custom-transcribe",
          silenceDurationMs: 650,
          vadThreshold: 0.7,
        },
        { OPENAI_API_KEY: "sk-env" },
      ),
    ).toEqual({
      apiKey: "sk-explicit",
      model: "custom-transcribe",
      silenceDurationMs: 650,
      vadThreshold: 0.7,
    });
  });

  it("falls back to default OpenAI realtime values", () => {
    expect(resolveOpenAIRealtimeSttConfig({}, { OPENAI_API_KEY: "sk-env" })).toEqual({
      apiKey: "sk-env",
      model: "gpt-4o-transcribe",
      silenceDurationMs: 800,
      vadThreshold: 0.5,
    });
  });

  it("normalizes buffered media STT numeric options", () => {
    expect(
      resolveBufferedMediaSttConfig({
        silenceDurationMs: Number.NaN,
        vadThreshold: 0.65,
      }),
    ).toEqual({
      silenceDurationMs: 800,
      vadThreshold: 0.65,
    });
  });
});
