import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { transcribeAudioFile } from "openclaw/plugin-sdk/media-understanding-runtime";
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCallbacks,
} from "openclaw/plugin-sdk/realtime-transcription";
import { calculateMulawRms, mulawToPcm } from "openclaw/plugin-sdk/realtime-voice";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/sandbox";

const PROVIDER_ID = "media-audio";
const DEFAULT_SILENCE_DURATION_MS = 800;
const DEFAULT_VAD_THRESHOLD = 0.5;
const DEFAULT_MIN_SPEECH_MS = 300;
const DEFAULT_MAX_SEGMENT_MS = 15_000;
const MAX_SEGMENT_MS = 60_000;
const MAX_INBOUND_AUDIO_BYTES = 8 * 1024;
const MAX_PENDING_SEGMENTS = 4;
const MAX_PENDING_AUDIO_BYTES = 1024 * 1024;
const TELEPHONY_SAMPLE_RATE = 8000;

type BufferedMediaTranscriber = (params: {
  pcm: Buffer;
  cfg: OpenClawConfig;
  agentDir?: string;
}) => Promise<string | undefined>;

type BufferedMediaProviderDeps = {
  resolveAgentDir?: (cfg: OpenClawConfig) => string;
  transcriber?: BufferedMediaTranscriber;
};

type BufferedMediaSessionConfig = RealtimeTranscriptionSessionCallbacks & {
  cfg: OpenClawConfig;
  agentDir?: string;
  silenceDurationMs: number;
  vadThreshold: number;
  minSpeechMs: number;
  maxSegmentMs: number;
  transcriber: BufferedMediaTranscriber;
};

type PendingSegment = {
  generation: number;
  pcm: Buffer;
};

function readNumber(
  config: RealtimeTranscriptionProviderConfig,
  key: string,
  fallback: number,
  limits: { min: number; max: number },
): number {
  const value = config[key];
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= limits.min &&
    value <= limits.max
    ? value
    : fallback;
}

function resolveSessionConfig(config: RealtimeTranscriptionProviderConfig): {
  silenceDurationMs: number;
  vadThreshold: number;
  minSpeechMs: number;
  maxSegmentMs: number;
} {
  const maxSegmentMs = readNumber(config, "maxSegmentMs", DEFAULT_MAX_SEGMENT_MS, {
    min: 100,
    max: MAX_SEGMENT_MS,
  });
  const minSpeechMs = readNumber(config, "minSpeechMs", DEFAULT_MIN_SPEECH_MS, {
    min: 0,
    max: MAX_SEGMENT_MS,
  });
  return {
    silenceDurationMs: readNumber(config, "silenceDurationMs", DEFAULT_SILENCE_DURATION_MS, {
      min: 20,
      max: 30_000,
    }),
    vadThreshold: readNumber(config, "vadThreshold", DEFAULT_VAD_THRESHOLD, {
      min: 0,
      max: 1,
    }),
    minSpeechMs: Math.min(minSpeechMs, maxSegmentMs),
    maxSegmentMs,
  };
}

function buildPcmWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(TELEPHONY_SAMPLE_RATE, 24);
  header.writeUInt32LE(TELEPHONY_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function createBufferedMediaTranscriber(options?: {
  transcribeAudioFileImpl?: typeof transcribeAudioFile;
}): BufferedMediaTranscriber {
  const transcribeAudioFileImpl = options?.transcribeAudioFileImpl ?? transcribeAudioFile;
  return async ({ pcm, cfg, agentDir }) => {
    const tempRoot = resolvePreferredOpenClawTmpDir();
    await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
    const tempDir = await fs.mkdtemp(path.join(tempRoot, "voice-call-stt-"));
    const filePath = path.join(tempDir, `segment-${randomUUID()}.wav`);
    try {
      await fs.writeFile(filePath, buildPcmWav(pcm));
      const result = await transcribeAudioFileImpl({
        filePath,
        cfg,
        agentDir,
        mime: "audio/wav",
      });
      return result.text?.trim() || undefined;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

class BufferedMediaTranscriptionSession implements RealtimeTranscriptionSession {
  private connected = false;
  private closed = true;
  private generation = 0;
  private processingGeneration: number | null = null;
  private pendingSegments: PendingSegment[] = [];
  private pendingBytes = 0;
  private speaking = false;
  private segmentBuffers: Buffer[] = [];
  private segmentSpeechMs = 0;
  private segmentTotalMs = 0;
  private silenceMs = 0;

  constructor(private readonly config: BufferedMediaSessionConfig) {}

  async connect(): Promise<void> {
    this.generation += 1;
    this.closed = false;
    this.connected = true;
  }

  sendAudio(audio: Buffer): void {
    if (
      this.closed ||
      !this.connected ||
      audio.length === 0 ||
      audio.length > MAX_INBOUND_AUDIO_BYTES
    ) {
      return;
    }

    const durationMs = (audio.length / TELEPHONY_SAMPLE_RATE) * 1000;
    const speechThreshold = 0.015 + this.config.vadThreshold * 0.05;
    const isSpeech = calculateMulawRms(audio) >= speechThreshold;

    if (isSpeech) {
      if (!this.speaking) {
        this.speaking = true;
        this.segmentBuffers = [];
        this.segmentSpeechMs = 0;
        this.segmentTotalMs = 0;
        this.silenceMs = 0;
        this.config.onSpeechStart?.();
      }
      this.segmentSpeechMs += durationMs;
      this.silenceMs = 0;
      this.segmentBuffers.push(mulawToPcm(audio));
      this.segmentTotalMs += durationMs;
    } else if (this.speaking) {
      this.segmentBuffers.push(mulawToPcm(audio));
      this.segmentTotalMs += durationMs;
      this.silenceMs += durationMs;
    } else {
      return;
    }

    if (
      this.segmentTotalMs >= this.config.maxSegmentMs ||
      this.silenceMs >= this.config.silenceDurationMs
    ) {
      this.flushSegment();
    }
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    this.generation += 1;
    this.processingGeneration = null;
    this.pendingSegments = [];
    this.pendingBytes = 0;
    this.resetSegment();
  }

  isConnected(): boolean {
    return this.connected;
  }

  private flushSegment(): void {
    const pcm = Buffer.concat(this.segmentBuffers);
    const speechMs = this.segmentSpeechMs;
    const generation = this.generation;
    this.resetSegment();

    if (
      speechMs < this.config.minSpeechMs ||
      pcm.length === 0 ||
      pcm.length > MAX_PENDING_AUDIO_BYTES
    ) {
      return;
    }

    // Keep request-time memory bounded if a batch transcription backend stalls.
    while (
      this.pendingSegments.length >= MAX_PENDING_SEGMENTS ||
      this.pendingBytes + pcm.length > MAX_PENDING_AUDIO_BYTES
    ) {
      const dropped = this.pendingSegments.shift();
      if (!dropped) {
        break;
      }
      this.pendingBytes -= dropped.pcm.length;
    }
    this.pendingSegments.push({ generation, pcm });
    this.pendingBytes += pcm.length;
    this.startProcessing(generation);
  }

  private startProcessing(generation: number): void {
    if (this.processingGeneration === generation) {
      return;
    }
    this.processingGeneration = generation;
    void this.processPending(generation).finally(() => {
      if (this.processingGeneration === generation) {
        this.processingGeneration = null;
      }
    });
  }

  private async processPending(generation: number): Promise<void> {
    while (!this.closed && generation === this.generation) {
      const segment = this.pendingSegments.shift();
      if (!segment) {
        return;
      }
      this.pendingBytes -= segment.pcm.length;
      try {
        const transcript = await this.config.transcriber({
          pcm: segment.pcm,
          cfg: this.config.cfg,
          agentDir: this.config.agentDir,
        });
        if (transcript && !this.closed && generation === this.generation) {
          this.config.onTranscript?.(transcript);
        }
      } catch (error) {
        if (!this.closed && generation === this.generation) {
          this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
  }

  private resetSegment(): void {
    this.speaking = false;
    this.segmentBuffers = [];
    this.segmentSpeechMs = 0;
    this.segmentTotalMs = 0;
    this.silenceMs = 0;
  }
}

export function buildBufferedMediaRealtimeTranscriptionProvider(
  deps: BufferedMediaProviderDeps = {},
): RealtimeTranscriptionProviderPlugin {
  const transcriber = deps.transcriber ?? createBufferedMediaTranscriber();
  return {
    id: PROVIDER_ID,
    label: "Media Audio Transcription",
    autoSelectOrder: 1000,
    resolveConfig: ({ rawConfig }) => rawConfig,
    isConfigured: ({ cfg }) => Boolean(cfg) && cfg?.tools?.media?.audio?.enabled !== false,
    createSession: (request) => {
      const cfg = request.cfg;
      if (!cfg) {
        throw new Error("media-audio transcription requires core config");
      }
      return new BufferedMediaTranscriptionSession({
        ...resolveSessionConfig(request.providerConfig),
        cfg,
        agentDir: deps.resolveAgentDir?.(cfg),
        transcriber,
        onPartial: request.onPartial,
        onTranscript: request.onTranscript,
        onSpeechStart: request.onSpeechStart,
        onError: request.onError,
      });
    },
  };
}
