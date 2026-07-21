import { describe, expect, it, vi } from "vitest";
import { pcmToMulaw } from "../telephony-audio.js";
import { BufferedMediaSttProvider } from "./stt-buffered-media.js";

function createPcmFrame(amplitude: number, samples = 160): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(amplitude, i * 2);
  }
  return pcm;
}

const speechFrame = pcmToMulaw(createPcmFrame(10_000));
const silenceFrame = pcmToMulaw(createPcmFrame(0));

describe("BufferedMediaSttProvider", () => {
  it("segments speech and emits a transcript after buffered silence", async () => {
    const transcribeAudioFileImpl = vi.fn(async () => ({ text: "hello from local stt" }));
    const provider = new BufferedMediaSttProvider({
      cfg: {} as never,
      silenceDurationMs: 40,
      minSpeechMs: 20,
      transcribeAudioFileImpl,
    });
    const session = provider.createSession();
    const onSpeechStart = vi.fn();
    const onTranscript = vi.fn();

    session.onSpeechStart(onSpeechStart);
    session.onTranscript(onTranscript);
    await session.connect();

    session.sendAudio(speechFrame);
    session.sendAudio(silenceFrame);
    session.sendAudio(silenceFrame);

    await vi.waitFor(() => {
      expect(transcribeAudioFileImpl).toHaveBeenCalledOnce();
      expect(onTranscript).toHaveBeenCalledWith("hello from local stt");
    });
    expect(onSpeechStart).toHaveBeenCalledOnce();
    session.close();
  });

  it("supports waitForTranscript for completed buffered segments", async () => {
    const provider = new BufferedMediaSttProvider({
      cfg: {} as never,
      silenceDurationMs: 40,
      minSpeechMs: 20,
      transcribeAudioFileImpl: async () => ({ text: "buffered result" }),
    });
    const session = provider.createSession();
    await session.connect();

    const waitPromise = session.waitForTranscript(2000);
    session.sendAudio(speechFrame);
    session.sendAudio(silenceFrame);
    session.sendAudio(silenceFrame);

    await expect(waitPromise).resolves.toBe("buffered result");
    session.close();
  });

  it("drains final buffered speech without requiring trailing silence", async () => {
    const transcriber = vi.fn(async () => "final buffered words");
    const provider = new BufferedMediaSttProvider({
      cfg: {} as never,
      minSpeechMs: 20,
      transcriber,
    });
    const session = provider.createSession();
    const onTranscript = vi.fn();
    session.onTranscript(onTranscript);
    await session.connect();

    session.sendAudio(speechFrame);
    await session.drain?.();

    expect(transcriber).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("final buffered words");
    session.close();
  });

  it("suppresses in-flight and queued transcription results after close", async () => {
    let resolveFirst!: (transcript: string) => void;
    const transcriber = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const provider = new BufferedMediaSttProvider({
      cfg: {} as never,
      silenceDurationMs: 20,
      minSpeechMs: 20,
      transcriber,
    });
    const session = provider.createSession();
    const onPartial = vi.fn();
    const onTranscript = vi.fn();

    session.onPartial(onPartial);
    session.onTranscript(onTranscript);
    await session.connect();

    session.sendAudio(speechFrame);
    session.sendAudio(silenceFrame);
    await vi.waitFor(() => expect(transcriber).toHaveBeenCalledOnce());

    session.sendAudio(speechFrame);
    session.sendAudio(silenceFrame);
    session.close();
    resolveFirst("late transcript");
    await Promise.resolve();
    await Promise.resolve();

    expect(transcriber).toHaveBeenCalledOnce();
    expect(onPartial).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("does not carry completed transcripts across close and reconnect", async () => {
    const transcriber = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("prior call transcript")
      .mockResolvedValueOnce("current call transcript");
    const provider = new BufferedMediaSttProvider({
      cfg: {} as never,
      silenceDurationMs: 20,
      minSpeechMs: 20,
      transcriber,
    });
    const session = provider.createSession();
    const onTranscript = vi.fn();
    session.onTranscript(onTranscript);
    await session.connect();

    session.sendAudio(speechFrame);
    session.sendAudio(silenceFrame);
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledWith("prior call transcript"));

    session.close();
    await session.connect();
    const currentTranscript = session.waitForTranscript(2_000);
    session.sendAudio(speechFrame);
    session.sendAudio(silenceFrame);

    await expect(currentTranscript).resolves.toBe("current call transcript");
    expect(transcriber).toHaveBeenCalledTimes(2);
    session.close();
  });

  it("does not block reconnected transcription behind a stalled prior call", async () => {
    let resolvePrior!: (transcript: string) => void;
    const transcriber = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolvePrior = resolve;
          }),
      )
      .mockResolvedValueOnce("current call transcript");
    const provider = new BufferedMediaSttProvider({
      cfg: {} as never,
      silenceDurationMs: 20,
      minSpeechMs: 20,
      transcriber,
    });
    const session = provider.createSession();
    const onTranscript = vi.fn();
    session.onTranscript(onTranscript);
    await session.connect();

    session.sendAudio(speechFrame);
    session.sendAudio(silenceFrame);
    await vi.waitFor(() => expect(transcriber).toHaveBeenCalledOnce());

    session.close();
    await session.connect();
    const currentTranscript = session.waitForTranscript(2_000);
    session.sendAudio(speechFrame);
    session.sendAudio(silenceFrame);

    await expect(currentTranscript).resolves.toBe("current call transcript");
    expect(transcriber).toHaveBeenCalledTimes(2);
    resolvePrior("late prior call transcript");
    await Promise.resolve();
    await Promise.resolve();
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("current call transcript");
    session.close();
  });

  it("bounds queued segments while the transcription backend is stalled", async () => {
    let resolveFirst!: (transcript: string) => void;
    const transcriber = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue("queued transcript");
    const provider = new BufferedMediaSttProvider({
      cfg: {} as never,
      silenceDurationMs: 20,
      minSpeechMs: 20,
      transcriber,
    });
    const session = provider.createSession();
    await session.connect();

    for (let index = 0; index < 12; index += 1) {
      session.sendAudio(speechFrame);
      session.sendAudio(silenceFrame);
    }
    await vi.waitFor(() => expect(transcriber).toHaveBeenCalledOnce());
    resolveFirst("first transcript");
    await session.drain?.();

    expect(transcriber.mock.calls.length).toBeLessThanOrEqual(5);
    session.close();
  });

  it("does not retain a transcript backlog when a callback consumes transcripts", async () => {
    const provider = new BufferedMediaSttProvider({
      cfg: {} as never,
      silenceDurationMs: 20,
      minSpeechMs: 20,
      transcriber: async () => "callback transcript",
    });
    const session = provider.createSession();
    const onTranscript = vi.fn();
    session.onTranscript(onTranscript);
    await session.connect();

    session.sendAudio(speechFrame);
    session.sendAudio(silenceFrame);
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledOnce());

    await expect(session.waitForTranscript(20)).rejects.toThrow("Transcript timeout");
    session.close();
  });

  it("drops segments that do not meet the minimum speech duration", async () => {
    const transcribeAudioFileImpl = vi.fn(async () => ({ text: "should not happen" }));
    const provider = new BufferedMediaSttProvider({
      cfg: {} as never,
      silenceDurationMs: 40,
      minSpeechMs: 80,
      transcribeAudioFileImpl,
    });
    const session = provider.createSession();
    await session.connect();

    session.sendAudio(speechFrame);
    session.sendAudio(silenceFrame);
    session.sendAudio(silenceFrame);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(transcribeAudioFileImpl).not.toHaveBeenCalled();
    session.close();
  });
});
