import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/infra-runtime";
import { transcribeAudioFile } from "openclaw/plugin-sdk/media-understanding-runtime";
import {
  buildTelephonyWavBuffer,
  convertMulawToPcm16,
  getTelephonyPcmDurationMs,
} from "../telephony-audio.js";
import type { VoiceCallStreamingSttProvider, VoiceCallStreamingSttSession } from "./stt-types.js";

const DEFAULT_MIN_SPEECH_MS = 300;
const DEFAULT_MAX_SEGMENT_MS = 15_000;

export interface BufferedMediaSttConfig {
  cfg: OpenClawConfig;
  agentDir?: string;
  silenceDurationMs?: number;
  vadThreshold?: number;
  minSpeechMs?: number;
  maxSegmentMs?: number;
  transcribeAudioFileImpl?: typeof transcribeAudioFile;
}

function resolveSpeechThreshold(vadThreshold: number): number {
  return 0.015 + vadThreshold * 0.05;
}

function computeAverageAbsLevel(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) {
    return 0;
  }
  let total = 0;
  for (let i = 0; i < samples; i++) {
    total += Math.abs(pcm.readInt16LE(i * 2)) / 32768;
  }
  return total / samples;
}

type TranscriptWaiter = {
  resolve: (value: string) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

class BufferedMediaSttSession implements VoiceCallStreamingSttSession {
  private connected = false;
  private closed = false;
  private onTranscriptCallback: ((transcript: string) => void) | null = null;
  private onPartialCallback: ((partial: string) => void) | null = null;
  private onSpeechStartCallback: (() => void) | null = null;
  private transcriptBacklog: string[] = [];
  private transcriptWaiters: TranscriptWaiter[] = [];
  private transcriptionChain = Promise.resolve();
  private speaking = false;
  private segmentBuffers: Buffer[] = [];
  private segmentSpeechMs = 0;
  private segmentTotalMs = 0;
  private silenceMs = 0;

  constructor(
    private readonly config: Required<Omit<BufferedMediaSttConfig, "agentDir">> & {
      agentDir?: string;
    },
  ) {}

  async connect(): Promise<void> {
    this.closed = false;
    this.connected = true;
  }

  sendAudio(audio: Buffer): void {
    if (this.closed || !this.connected || audio.length === 0) {
      return;
    }

    const pcm = convertMulawToPcm16(audio);
    const durationMs = getTelephonyPcmDurationMs(pcm);
    if (durationMs <= 0) {
      return;
    }

    const isSpeech =
      computeAverageAbsLevel(pcm) >= resolveSpeechThreshold(this.config.vadThreshold);

    if (isSpeech) {
      if (!this.speaking) {
        this.speaking = true;
        this.segmentBuffers = [];
        this.segmentSpeechMs = 0;
        this.segmentTotalMs = 0;
        this.silenceMs = 0;
        this.onSpeechStartCallback?.();
      }
      this.segmentSpeechMs += durationMs;
      this.silenceMs = 0;
      this.segmentBuffers.push(pcm);
      this.segmentTotalMs += durationMs;
    } else if (this.speaking) {
      this.segmentBuffers.push(pcm);
      this.segmentTotalMs += durationMs;
      this.silenceMs += durationMs;
    } else {
      return;
    }

    if (this.speaking && this.segmentTotalMs >= this.config.maxSegmentMs) {
      this.flushSegment();
      return;
    }

    if (this.speaking && this.silenceMs >= this.config.silenceDurationMs) {
      this.flushSegment();
    }
  }

  onPartial(callback: (partial: string) => void): void {
    this.onPartialCallback = callback;
  }

  onTranscript(callback: (transcript: string) => void): void {
    this.onTranscriptCallback = callback;
  }

  onSpeechStart(callback: () => void): void {
    this.onSpeechStartCallback = callback;
  }

  async waitForTranscript(timeoutMs = 30000): Promise<string> {
    const next = this.transcriptBacklog.shift();
    if (next) {
      return next;
    }

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.transcriptWaiters = this.transcriptWaiters.filter(
          (entry) => entry.timeout !== timeout,
        );
        reject(new Error("Transcript timeout"));
      }, timeoutMs);
      this.transcriptWaiters.push({ resolve, reject, timeout });
    });
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    if (this.speaking && this.segmentSpeechMs >= this.config.minSpeechMs) {
      this.flushSegment();
    }
    const waiters = this.transcriptWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Transcript session closed"));
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  private flushSegment(): void {
    const speakingEnough = this.segmentSpeechMs >= this.config.minSpeechMs;
    const pcm = Buffer.concat(this.segmentBuffers);
    this.speaking = false;
    this.segmentBuffers = [];
    this.segmentSpeechMs = 0;
    this.segmentTotalMs = 0;
    this.silenceMs = 0;

    if (!speakingEnough || pcm.length === 0) {
      return;
    }

    this.transcriptionChain = this.transcriptionChain
      .then(async () => {
        const tempRoot = resolvePreferredOpenClawTmpDir();
        await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
        const tempDir = await fs.mkdtemp(path.join(tempRoot, "voice-call-stt-"));
        const filePath = path.join(tempDir, `segment-${randomUUID()}.wav`);

        try {
          await fs.writeFile(filePath, buildTelephonyWavBuffer(pcm));
          const result = await this.config.transcribeAudioFileImpl({
            filePath,
            cfg: this.config.cfg,
            agentDir: this.config.agentDir,
            mime: "audio/wav",
          });
          const transcript = result.text?.trim();
          if (!transcript) {
            return;
          }
          this.onPartialCallback?.(transcript);
          this.onTranscriptCallback?.(transcript);
          const waiter = this.transcriptWaiters.shift();
          if (waiter) {
            clearTimeout(waiter.timeout);
            waiter.resolve(transcript);
          } else {
            this.transcriptBacklog.push(transcript);
          }
        } catch (error) {
          console.warn(
            `[voice-call] Buffered media transcription failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } finally {
          await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
      })
      .catch(() => {});
  }
}

export class BufferedMediaSttProvider implements VoiceCallStreamingSttProvider {
  readonly name = "media-audio";
  private readonly cfg: OpenClawConfig;
  private readonly agentDir?: string;
  private readonly silenceDurationMs: number;
  private readonly vadThreshold: number;
  private readonly minSpeechMs: number;
  private readonly maxSegmentMs: number;
  private readonly transcribeAudioFileImpl: typeof transcribeAudioFile;

  constructor(config: BufferedMediaSttConfig) {
    this.cfg = config.cfg;
    this.agentDir = config.agentDir;
    this.silenceDurationMs = config.silenceDurationMs ?? 800;
    this.vadThreshold = config.vadThreshold ?? 0.5;
    this.minSpeechMs = config.minSpeechMs ?? DEFAULT_MIN_SPEECH_MS;
    this.maxSegmentMs = config.maxSegmentMs ?? DEFAULT_MAX_SEGMENT_MS;
    this.transcribeAudioFileImpl = config.transcribeAudioFileImpl ?? transcribeAudioFile;
  }

  createSession(): VoiceCallStreamingSttSession {
    return new BufferedMediaSttSession({
      cfg: this.cfg,
      agentDir: this.agentDir,
      silenceDurationMs: this.silenceDurationMs,
      vadThreshold: this.vadThreshold,
      minSpeechMs: this.minSpeechMs,
      maxSegmentMs: this.maxSegmentMs,
      transcribeAudioFileImpl: this.transcribeAudioFileImpl,
    });
  }
}
