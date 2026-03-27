import { describe, expect, it } from "vitest";
import type { CoreConfig } from "../core-bridge.js";
import { buildBufferedMediaRealtimeTranscriptionProvider } from "./stt-factory.js";

describe("buildBufferedMediaRealtimeTranscriptionProvider", () => {
  it("reports unconfigured without core config", () => {
    const provider = buildBufferedMediaRealtimeTranscriptionProvider();

    expect(provider.id).toBe("media-audio");
    expect(provider.isConfigured({ providerConfig: {} })).toBe(false);
  });

  it("creates a buffered media realtime transcription session with core config", async () => {
    const provider = buildBufferedMediaRealtimeTranscriptionProvider({
      coreConfig: {} as CoreConfig,
    });

    expect(provider.isConfigured({ cfg: {} as CoreConfig, providerConfig: {} })).toBe(true);

    const partials: string[] = [];
    const session = provider.createSession({
      providerConfig: {
        silenceDurationMs: 800,
        vadThreshold: 0.5,
      },
      onPartial: (value) => partials.push(value),
    });

    await session.connect();
    expect(session.isConnected()).toBe(true);
    session.close();
    expect(session.isConnected()).toBe(false);
  });
});
