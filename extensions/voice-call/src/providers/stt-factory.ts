import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import type { CoreAgentDeps, CoreConfig } from "../core-bridge.js";
import { BufferedMediaSttProvider } from "./stt-buffered-media.js";

export type BufferedMediaRealtimeTranscriptionProviderDeps = {
  coreConfig?: CoreConfig | null;
  agentRuntime?: CoreAgentDeps | null;
};

export function buildBufferedMediaRealtimeTranscriptionProvider(
  deps: BufferedMediaRealtimeTranscriptionProviderDeps = {},
): RealtimeTranscriptionProviderPlugin {
  return {
    id: "media-audio",
    label: "Media Audio Transcription",
    autoSelectOrder: 50,
    resolveConfig: ({ rawConfig }) => rawConfig,
    isConfigured: ({ cfg }) => Boolean(cfg ?? deps.coreConfig),
    createSession: (req) => {
      const cfg = deps.coreConfig;
      if (!cfg) {
        throw new Error("media-audio transcription requires core config");
      }
      const raw = req.providerConfig;
      const provider = new BufferedMediaSttProvider({
        cfg,
        agentDir: deps.agentRuntime?.resolveAgentDir?.(cfg, "main"),
        silenceDurationMs:
          typeof raw.silenceDurationMs === "number" ? raw.silenceDurationMs : undefined,
        vadThreshold: typeof raw.vadThreshold === "number" ? raw.vadThreshold : undefined,
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
