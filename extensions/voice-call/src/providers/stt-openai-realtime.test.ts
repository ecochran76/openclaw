import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIRealtimeSTTProvider } from "./stt-openai-realtime.js";

const wsMock = vi.hoisted(() => {
  class MockWebSocket {
    static readonly OPEN = 1;
    readonly url: string;
    readonly options: { headers?: Record<string, string> };
    readyState = MockWebSocket.OPEN;
    sent: string[] = [];
    closed = false;
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(url: string, options: { headers?: Record<string, string> }) {
      this.url = url;
      this.options = options;
      createdSockets.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    }

    emit(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }

    send(payload: string) {
      this.sent.push(payload);
    }

    close() {
      this.closed = true;
      this.readyState = 3;
      this.emit("close", 1000, Buffer.from("closed"));
    }
  }

  const createdSockets: MockWebSocket[] = [];
  return { MockWebSocket, createdSockets };
});

vi.mock("ws", () => ({ default: wsMock.MockWebSocket }));

afterEach(() => {
  wsMock.createdSockets.length = 0;
});

describe("OpenAIRealtimeSTTProvider", () => {
  it("requires an API key", () => {
    expect(() => new OpenAIRealtimeSTTProvider({ apiKey: "" })).toThrow(
      "OpenAI API key required for Realtime STT",
    );
  });

  it("configures realtime transcription on connect and sends mu-law audio", async () => {
    const provider = new OpenAIRealtimeSTTProvider({
      apiKey: "test-key",
      model: "gpt-4o-mini-transcribe",
      silenceDurationMs: 1200,
      vadThreshold: 0.7,
    });
    const session = provider.createSession();
    const connect = session.connect();
    const socket = wsMock.createdSockets[0];
    if (!socket) {
      throw new Error("expected websocket to be created");
    }

    expect(socket.url).toBe("wss://api.openai.com/v1/realtime?intent=transcription");
    expect(socket.options.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "OpenAI-Beta": "realtime=v1",
    });

    socket.emit("open");
    await connect;
    expect(session.isConnected()).toBe(true);

    expect(JSON.parse(socket.sent[0] ?? "{}")).toMatchObject({
      type: "transcription_session.update",
      session: {
        input_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.7,
          prefix_padding_ms: 300,
          silence_duration_ms: 1200,
        },
      },
    });

    session.sendAudio(Buffer.from([1, 2, 3]));
    expect(JSON.parse(socket.sent[1] ?? "{}")).toEqual({
      type: "input_audio_buffer.append",
      audio: "AQID",
    });

    session.close();
    expect(socket.closed).toBe(true);
    expect(session.isConnected()).toBe(false);
  });

  it("emits speech, partial, and final transcript callbacks", async () => {
    const provider = new OpenAIRealtimeSTTProvider({ apiKey: "test-key" });
    const session = provider.createSession();
    const speechStart = vi.fn();
    const partial = vi.fn();
    const transcript = vi.fn();
    session.onSpeechStart(speechStart);
    session.onPartial(partial);
    session.onTranscript(transcript);

    const connect = session.connect();
    const socket = wsMock.createdSockets[0];
    if (!socket) {
      throw new Error("expected websocket to be created");
    }
    socket.emit("open");
    await connect;

    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.delta",
          delta: "hel",
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.delta",
          delta: "lo",
        }),
      ),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "hello",
        }),
      ),
    );

    expect(speechStart).toHaveBeenCalledOnce();
    expect(partial).toHaveBeenNthCalledWith(1, "hel");
    expect(partial).toHaveBeenNthCalledWith(2, "hello");
    expect(transcript).toHaveBeenCalledWith("hello");
  });
});
