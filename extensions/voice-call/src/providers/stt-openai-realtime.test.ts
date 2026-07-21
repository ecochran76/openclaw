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

    removeAllListeners() {
      this.handlers.clear();
    }

    listenerCount() {
      return Array.from(this.handlers.values()).reduce(
        (total, handlers) => total + handlers.length,
        0,
      );
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

  it("keeps persistent transcript listeners while resolving concurrent waiters", async () => {
    const session = new OpenAIRealtimeSTTProvider({ apiKey: "test-key" }).createSession();
    const transcript = vi.fn();
    session.onTranscript(transcript);
    const connect = session.connect();
    const socket = wsMock.createdSockets[0];
    if (!socket) {
      throw new Error("expected websocket to be created");
    }
    socket.emit("open");
    await connect;

    const firstWaiter = session.waitForTranscript();
    const secondWaiter = session.waitForTranscript();
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "first",
        }),
      ),
    );

    await expect(Promise.all([firstWaiter, secondWaiter])).resolves.toEqual(["first", "first"]);
    expect(transcript).toHaveBeenCalledWith("first");

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "second",
        }),
      ),
    );
    expect(transcript).toHaveBeenLastCalledWith("second");
    expect(transcript).toHaveBeenCalledTimes(2);
  });

  it("rejects a superseded connection without disconnecting the newer connection", async () => {
    vi.useFakeTimers();
    try {
      const session = new OpenAIRealtimeSTTProvider({ apiKey: "test-key" }).createSession();
      const firstConnect = session.connect();
      const firstSocket = wsMock.createdSockets[0];
      const secondConnect = session.connect();
      const secondSocket = wsMock.createdSockets[1];
      if (!firstSocket || !secondSocket) {
        throw new Error("expected two websockets to be created");
      }
      secondSocket.emit("open");
      await secondConnect;
      const firstRejection = expect(firstConnect).rejects.toThrow(
        "Realtime STT connection superseded",
      );

      await firstRejection;

      expect(firstSocket.closed).toBe(true);
      expect(firstSocket.listenerCount()).toBe(1);
      expect(secondSocket.closed).toBe(false);
      expect(session.isConnected()).toBe(true);
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects connect exactly once when the socket closes before opening", async () => {
    const session = new OpenAIRealtimeSTTProvider({ apiKey: "test-key" }).createSession();
    const connect = session.connect();
    const socket = wsMock.createdSockets[0];
    if (!socket) {
      throw new Error("expected websocket to be created");
    }

    socket.emit("close", 1006, Buffer.from("handshake failed"));

    await expect(connect).rejects.toThrow("Realtime STT connection closed before opening");
    expect(wsMock.createdSockets).toHaveLength(1);
    session.close();
  });

  it("serially retries reconnect timeouts until a later attempt succeeds", async () => {
    vi.useFakeTimers();
    try {
      const session = new OpenAIRealtimeSTTProvider({ apiKey: "test-key" }).createSession();
      const connect = session.connect();
      const initialSocket = wsMock.createdSockets[0];
      if (!initialSocket) {
        throw new Error("expected websocket to be created");
      }
      initialSocket.emit("open");
      await connect;

      initialSocket.emit("close", 1006, Buffer.from("network lost"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(wsMock.createdSockets).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(2_000);
      const recoveredSocket = wsMock.createdSockets[2];
      if (!recoveredSocket) {
        throw new Error("expected a second reconnect websocket to be created");
      }
      recoveredSocket.emit("open");
      await vi.advanceTimersByTimeAsync(0);

      expect(session.isConnected()).toBe(true);
      expect(wsMock.createdSockets).toHaveLength(3);
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending reconnect delay when the session closes", async () => {
    vi.useFakeTimers();
    try {
      const session = new OpenAIRealtimeSTTProvider({ apiKey: "test-key" }).createSession();
      const connect = session.connect();
      const socket = wsMock.createdSockets[0];
      if (!socket) {
        throw new Error("expected websocket to be created");
      }
      socket.emit("open");
      await connect;
      socket.emit("close", 1006, Buffer.from("network lost"));

      session.close();
      await vi.runAllTimersAsync();

      expect(wsMock.createdSockets).toHaveLength(1);
      expect(session.isConnected()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects and clears all pending transcript waits when the socket closes", async () => {
    const session = new OpenAIRealtimeSTTProvider({ apiKey: "test-key" }).createSession();
    const connect = session.connect();
    const socket = wsMock.createdSockets[0];
    if (!socket) {
      throw new Error("expected websocket to be created");
    }
    socket.emit("open");
    await connect;

    const firstWaiter = session.waitForTranscript();
    const secondWaiter = session.waitForTranscript();
    socket.emit("close", 1006, Buffer.from("network lost"));

    await expect(firstWaiter).rejects.toThrow("Realtime STT connection closed");
    await expect(secondWaiter).rejects.toThrow("Realtime STT connection closed");
    session.close();
  });

  it("commits buffered audio and bounds drain until transcription completes", async () => {
    vi.useFakeTimers();
    try {
      const session = new OpenAIRealtimeSTTProvider({ apiKey: "test-key" }).createSession();
      const connect = session.connect();
      const socket = wsMock.createdSockets[0];
      if (!socket) {
        throw new Error("expected websocket to be created");
      }
      socket.emit("open");
      await connect;

      session.sendAudio(Buffer.from([1, 2, 3]));
      const drain = session.drain?.();
      expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toEqual({
        type: "input_audio_buffer.commit",
      });
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.completed",
            transcript: "final words",
          }),
        ),
      );
      await expect(drain).resolves.toBeUndefined();

      session.sendAudio(Buffer.from([4, 5, 6]));
      const boundedDrain = session.drain?.();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(boundedDrain).resolves.toBeUndefined();
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains immediately after server VAD already committed and completed", async () => {
    const session = new OpenAIRealtimeSTTProvider({ apiKey: "test-key" }).createSession();
    const connect = session.connect();
    const socket = wsMock.createdSockets[0];
    if (!socket) {
      throw new Error("expected websocket to be created");
    }
    socket.emit("open");
    await connect;

    session.sendAudio(Buffer.from([1, 2, 3]));
    socket.emit("message", Buffer.from(JSON.stringify({ type: "input_audio_buffer.committed" })));
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "already final",
        }),
      ),
    );
    const sentBeforeDrain = socket.sent.length;

    await expect(session.drain?.()).resolves.toBeUndefined();
    expect(socket.sent).toHaveLength(sentBeforeDrain);
    session.close();
  });
});
