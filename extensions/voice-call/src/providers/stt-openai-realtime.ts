/**
 * OpenAI Realtime STT Provider
 *
 * Uses the OpenAI Realtime API for streaming transcription with:
 * - Direct mu-law audio support (no conversion needed)
 * - Built-in server-side VAD for turn detection
 * - Low-latency streaming transcription
 * - Partial transcript callbacks for real-time UI updates
 */

import WebSocket from "ws";
import type { VoiceCallStreamingSttProvider, VoiceCallStreamingSttSession } from "./stt-types.js";

/**
 * Configuration for OpenAI Realtime STT.
 */
export interface RealtimeSTTConfig {
  /** OpenAI API key */
  apiKey: string;
  /** Model to use (default: gpt-4o-transcribe) */
  model?: string;
  /** Silence duration in ms before considering speech ended (default: 800) */
  silenceDurationMs?: number;
  /** VAD threshold 0-1 (default: 0.5) */
  vadThreshold?: number;
}

export type RealtimeSTTSession = VoiceCallStreamingSttSession;

/**
 * Provider factory for OpenAI Realtime STT sessions.
 */
export class OpenAIRealtimeSTTProvider implements VoiceCallStreamingSttProvider {
  readonly name = "openai-realtime";
  private apiKey: string;
  private model: string;
  private silenceDurationMs: number;
  private vadThreshold: number;

  constructor(config: RealtimeSTTConfig) {
    if (!config.apiKey) {
      throw new Error("OpenAI API key required for Realtime STT");
    }
    this.apiKey = config.apiKey;
    this.model = config.model || "gpt-4o-transcribe";
    this.silenceDurationMs = config.silenceDurationMs ?? 800;
    this.vadThreshold = config.vadThreshold ?? 0.5;
  }

  /**
   * Create a new realtime transcription session.
   */
  createSession(): RealtimeSTTSession {
    return new OpenAIRealtimeSTTSession(
      this.apiKey,
      this.model,
      this.silenceDurationMs,
      this.vadThreshold,
    );
  }
}

/**
 * WebSocket-based session for real-time speech-to-text.
 */
class OpenAIRealtimeSTTSession implements VoiceCallStreamingSttSession {
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly RECONNECT_DELAY_MS = 1000;

  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private activeConnectAttempt: {
    socket: WebSocket;
    reject: (error: Error) => void;
  } | null = null;
  private reconnectTask: Promise<void> | null = null;
  private reconnectDelay: {
    timeout: ReturnType<typeof setTimeout>;
    resolve: (continueReconnect: boolean) => void;
  } | null = null;
  private reconnectAttempts = 0;
  private pendingTranscript = "";
  private onTranscriptCallback: ((transcript: string) => void) | null = null;
  private readonly transcriptWaiters = new Set<{
    resolve: (transcript: string) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private onPartialCallback: ((partial: string) => void) | null = null;
  private onSpeechStartCallback: (() => void) | null = null;
  private drainWaiters = new Set<() => void>();
  private hasUncommittedAudio = false;
  private transcriptionInFlight = false;
  private static readonly DRAIN_TIMEOUT_MS = 5_000;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly silenceDurationMs: number,
    private readonly vadThreshold: number,
  ) {}

  async connect(): Promise<void> {
    this.cancelReconnectDelay();
    this.rejectActiveConnectAttempt(new Error("Realtime STT connection superseded"));
    this.disposeCurrentSocket();
    this.closed = false;
    this.reconnectAttempts = 0;
    return this.doConnect();
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = "wss://api.openai.com/v1/realtime?intent=transcription";

      const socket = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });
      this.ws = socket;
      let settled = false;
      let opened = false;

      const settle = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (this.activeConnectAttempt?.socket === socket) {
          this.activeConnectAttempt = null;
        }
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      socket.on("open", () => {
        if (this.ws !== socket || this.closed) {
          this.closeSocketSilently(socket);
          settle(new Error("Realtime STT connection superseded"));
          return;
        }
        console.log("[RealtimeSTT] WebSocket connected");
        opened = true;
        this.connected = true;
        this.reconnectAttempts = 0;

        // Configure the transcription session
        this.sendEvent({
          type: "transcription_session.update",
          session: {
            input_audio_format: "g711_ulaw",
            input_audio_transcription: {
              model: this.model,
            },
            turn_detection: {
              type: "server_vad",
              threshold: this.vadThreshold,
              prefix_padding_ms: 300,
              silence_duration_ms: this.silenceDurationMs,
            },
          },
        });

        settle();
      });

      socket.on("message", (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString());
          this.handleEvent(event);
        } catch (e) {
          console.error("[RealtimeSTT] Failed to parse event:", e);
        }
      });

      socket.on("error", (error) => {
        console.error("[RealtimeSTT] WebSocket error:", error);
        if (!settled) {
          if (this.ws === socket) {
            this.ws = null;
          }
          this.closeSocketSilently(socket);
          settle(error instanceof Error ? error : new Error(String(error)));
        }
      });

      socket.on("close", (code, reason) => {
        console.log(
          `[RealtimeSTT] WebSocket closed (code: ${code}, reason: ${reason?.toString() || "none"})`,
        );
        const wasCurrentSocket = this.ws === socket;
        if (wasCurrentSocket) {
          this.ws = null;
          this.connected = false;
          this.rejectTranscriptWaiters(new Error("Realtime STT connection closed"));
        }
        if (!settled) {
          settle(new Error("Realtime STT connection closed before opening"));
        }

        // Attempt reconnection if not intentionally closed
        if (!this.closed && wasCurrentSocket && opened) {
          void this.attemptReconnect();
        }
      });

      const timeout = setTimeout(() => {
        if (this.ws === socket && !this.connected) {
          this.ws = null;
        }
        // Detach before closing so this failed initial connection cannot schedule
        // a background reconnect or mutate a newer socket's session state.
        this.closeSocketSilently(socket);
        settle(new Error("Realtime STT connection timeout"));
      }, 10000);
      this.activeConnectAttempt = { socket, reject: (error) => settle(error) };
    });
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed || this.reconnectTask) {
      return this.reconnectTask ?? undefined;
    }

    this.reconnectTask = (async () => {
      while (
        !this.closed &&
        this.reconnectAttempts < OpenAIRealtimeSTTSession.MAX_RECONNECT_ATTEMPTS
      ) {
        this.reconnectAttempts++;
        const delay =
          OpenAIRealtimeSTTSession.RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1);
        console.log(
          `[RealtimeSTT] Reconnecting ${this.reconnectAttempts}/${OpenAIRealtimeSTTSession.MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`,
        );

        if (!(await this.waitForReconnectDelay(delay))) {
          return;
        }

        try {
          await this.doConnect();
          if (this.connected) {
            console.log("[RealtimeSTT] Reconnected successfully");
            return;
          }
        } catch (error) {
          if (!this.closed) {
            console.error("[RealtimeSTT] Reconnect failed:", error);
          }
        }
      }

      if (!this.closed) {
        console.error(
          `[RealtimeSTT] Max reconnect attempts (${OpenAIRealtimeSTTSession.MAX_RECONNECT_ATTEMPTS}) reached`,
        );
      }
    })();

    try {
      await this.reconnectTask;
    } finally {
      this.reconnectTask = null;
    }
  }

  private waitForReconnectDelay(delayMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.reconnectDelay = null;
        resolve(true);
      }, delayMs);
      this.reconnectDelay = { timeout, resolve };
    });
  }

  private cancelReconnectDelay(): void {
    const delay = this.reconnectDelay;
    if (!delay) {
      return;
    }
    this.reconnectDelay = null;
    clearTimeout(delay.timeout);
    delay.resolve(false);
  }

  private rejectActiveConnectAttempt(error: Error): void {
    const attempt = this.activeConnectAttempt;
    this.activeConnectAttempt = null;
    attempt?.reject(error);
  }

  private disposeCurrentSocket(): void {
    const socket = this.ws;
    this.ws = null;
    if (!socket) {
      return;
    }
    this.closeSocketSilently(socket);
    this.connected = false;
  }

  private closeSocketSilently(socket: WebSocket): void {
    socket.removeAllListeners();
    // Closing a connecting ws can emit a final error after normal listeners are detached.
    socket.on("error", (error) => {
      void error;
    });
    socket.close();
  }

  private handleEvent(event: {
    type: string;
    delta?: string;
    transcript?: string;
    error?: unknown;
  }): void {
    switch (event.type) {
      case "transcription_session.created":
      case "transcription_session.updated":
      case "input_audio_buffer.speech_stopped":
        console.log(`[RealtimeSTT] ${event.type}`);
        break;

      case "input_audio_buffer.committed":
        console.log(`[RealtimeSTT] ${event.type}`);
        this.hasUncommittedAudio = false;
        this.transcriptionInFlight = true;
        break;

      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          this.pendingTranscript += event.delta;
          this.onPartialCallback?.(this.pendingTranscript);
        }
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          console.log(`[RealtimeSTT] Transcript: ${event.transcript}`);
          this.onTranscriptCallback?.(event.transcript);
          const waiters = [...this.transcriptWaiters];
          this.transcriptWaiters.clear();
          for (const waiter of waiters) {
            clearTimeout(waiter.timeout);
            waiter.resolve(event.transcript);
          }
        }
        this.pendingTranscript = "";
        this.hasUncommittedAudio = false;
        this.transcriptionInFlight = false;
        this.resolveDrainWaiters();
        break;

      case "input_audio_buffer.speech_started":
        console.log("[RealtimeSTT] Speech started");
        this.pendingTranscript = "";
        this.onSpeechStartCallback?.();
        break;

      case "error":
        console.error("[RealtimeSTT] Error:", event.error);
        break;
    }
  }

  private sendEvent(event: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  sendAudio(muLawData: Buffer): void {
    if (!this.connected) {
      return;
    }
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: muLawData.toString("base64"),
    });
    this.hasUncommittedAudio = true;
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
    if (this.closed) {
      throw new Error("Realtime STT connection closed");
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.transcriptWaiters.delete(waiter);
        reject(new Error("Transcript timeout"));
      }, timeoutMs);
      const waiter = { resolve, reject, timeout };
      this.transcriptWaiters.add(waiter);
    });
  }

  async drain(): Promise<void> {
    if (this.closed || !this.connected) {
      return;
    }
    if (!this.hasUncommittedAudio && !this.transcriptionInFlight) {
      return;
    }
    if (this.hasUncommittedAudio) {
      this.hasUncommittedAudio = false;
      this.transcriptionInFlight = true;
      this.sendEvent({ type: "input_audio_buffer.commit" });
    }
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timeout);
        this.drainWaiters.delete(finish);
        resolve();
      };
      const timeout = setTimeout(finish, OpenAIRealtimeSTTSession.DRAIN_TIMEOUT_MS);
      this.drainWaiters.add(finish);
    });
  }

  private resolveDrainWaiters(): void {
    for (const resolve of [...this.drainWaiters]) {
      resolve();
    }
  }

  private rejectTranscriptWaiters(error: Error): void {
    const waiters = [...this.transcriptWaiters];
    this.transcriptWaiters.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }

  close(): void {
    this.closed = true;
    this.cancelReconnectDelay();
    this.rejectActiveConnectAttempt(new Error("Realtime STT connection closed"));
    this.rejectTranscriptWaiters(new Error("Realtime STT connection closed"));
    this.resolveDrainWaiters();
    this.hasUncommittedAudio = false;
    this.transcriptionInFlight = false;
    this.disposeCurrentSocket();
  }

  isConnected(): boolean {
    return this.connected;
  }
}
