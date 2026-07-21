import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import type { CoreAgentDeps, CoreConfig } from "../core-bridge.js";
import { BufferedMediaSttProvider } from "./stt-buffered-media.js";
import { resolveBufferedMediaSttConfig } from "./stt-provider-config.js";
import { BUFFERED_MEDIA_REALTIME_TRANSCRIPTION_PROVIDER_ID } from "./stt-types.js";

export type BufferedMediaRealtimeTranscriptionProviderDeps = {
  coreConfig?: CoreConfig | null;
  agentRuntime?: CoreAgentDeps | null;
};

function isBufferedMediaTranscriptionUsable(cfg: CoreConfig | null | undefined): boolean {
  return Boolean(cfg) && cfg?.tools?.media?.audio?.enabled !== false;
}

export function buildBufferedMediaRealtimeTranscriptionProvider(
  deps: BufferedMediaRealtimeTranscriptionProviderDeps = {},
): RealtimeTranscriptionProviderPlugin {
  return {
    id: BUFFERED_MEDIA_REALTIME_TRANSCRIPTION_PROVIDER_ID,
    label: "Media Audio Transcription",
    resolveConfig: ({ rawConfig }) => rawConfig,
    isConfigured: ({ cfg }) => isBufferedMediaTranscriptionUsable(cfg ?? deps.coreConfig),
    createSession: (req) => {
      const cfg = req.cfg ?? deps.coreConfig;
      if (!cfg) {
        throw new Error("media-audio transcription requires core config");
      }
      const providerOptions = resolveBufferedMediaSttConfig(req.providerConfig);
      const raw = req.providerConfig;
      const provider = new BufferedMediaSttProvider({
        cfg,
        agentDir: deps.agentRuntime?.resolveAgentDir?.(cfg, "main"),
        silenceDurationMs: providerOptions.silenceDurationMs,
        vadThreshold: providerOptions.vadThreshold,
        minSpeechMs: typeof raw.minSpeechMs === "number" ? raw.minSpeechMs : undefined,
        maxSegmentMs: typeof raw.maxSegmentMs === "number" ? raw.maxSegmentMs : undefined,
      });
      const session = provider.createSession();
      if (req.onPartial) {
        session.onPartial(req.onPartial);
      }
      if (req.onTranscript) {
        session.onTranscript(req.onTranscript);
      }
      if (req.onSpeechStart) {
        session.onSpeechStart(req.onSpeechStart);
      }
      return session;
    },
  };
}
