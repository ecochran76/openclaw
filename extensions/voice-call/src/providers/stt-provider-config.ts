import type { VoiceCallStreamingConfig } from "../config.js";

export const DEFAULT_STREAMING_STT_PROVIDER_ID = "openai-realtime";
export const DEFAULT_OPENAI_REALTIME_STT_MODEL = "gpt-4o-transcribe";
export const DEFAULT_STREAMING_STT_SILENCE_DURATION_MS = 800;
export const DEFAULT_STREAMING_STT_VAD_THRESHOLD = 0.5;

export type VoiceCallStreamingProviderConfig = Record<string, unknown>;

export function resolveStreamingSttProviderId(config: VoiceCallStreamingConfig): string {
  return config.provider ?? DEFAULT_STREAMING_STT_PROVIDER_ID;
}

export function resolveStreamingSttProviderConfig(
  config: VoiceCallStreamingConfig,
  providerId = resolveStreamingSttProviderId(config),
): VoiceCallStreamingProviderConfig {
  return config.providers[providerId] ?? {};
}

export function readStreamingProviderNumber(
  providerConfig: VoiceCallStreamingProviderConfig,
  key: string,
  fallback: number,
): number {
  const value = providerConfig[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function resolveOpenAIRealtimeSttConfig(
  providerConfig: VoiceCallStreamingProviderConfig,
  env: { OPENAI_API_KEY?: string } = process.env,
): {
  apiKey?: string;
  model: string;
  silenceDurationMs: number;
  vadThreshold: number;
} {
  return {
    apiKey:
      (typeof providerConfig.apiKey === "string" ? providerConfig.apiKey : undefined) ??
      env.OPENAI_API_KEY,
    model:
      typeof providerConfig.model === "string"
        ? providerConfig.model
        : DEFAULT_OPENAI_REALTIME_STT_MODEL,
    silenceDurationMs: readStreamingProviderNumber(
      providerConfig,
      "silenceDurationMs",
      DEFAULT_STREAMING_STT_SILENCE_DURATION_MS,
    ),
    vadThreshold: readStreamingProviderNumber(
      providerConfig,
      "vadThreshold",
      DEFAULT_STREAMING_STT_VAD_THRESHOLD,
    ),
  };
}

export function resolveBufferedMediaSttConfig(providerConfig: VoiceCallStreamingProviderConfig): {
  silenceDurationMs: number;
  vadThreshold: number;
} {
  return {
    silenceDurationMs: readStreamingProviderNumber(
      providerConfig,
      "silenceDurationMs",
      DEFAULT_STREAMING_STT_SILENCE_DURATION_MS,
    ),
    vadThreshold: readStreamingProviderNumber(
      providerConfig,
      "vadThreshold",
      DEFAULT_STREAMING_STT_VAD_THRESHOLD,
    ),
  };
}
