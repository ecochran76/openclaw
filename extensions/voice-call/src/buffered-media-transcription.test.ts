import fs from "node:fs/promises";
import { pcmToMulaw } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import {
  buildBufferedMediaRealtimeTranscriptionProvider,
  createBufferedMediaTranscriber,
} from "./buffered-media-transcription.js";

function pcmFrame(amplitude: number, samples = 160): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    pcm.writeInt16LE(amplitude, index * 2);
  }
  return pcm;
}

const speechFrame = pcmToMulaw(pcmFrame(10_000));
const silenceFrame = pcmToMulaw(pcmFrame(0));

describe("buffered media realtime transcription", () => {
  it("segments Twilio audio and emits the batch media transcript", async () => {
    const transcriber = vi.fn(async () => "local transcript");
    const provider = buildBufferedMediaRealtimeTranscriptionProvider({ transcriber });
    const onSpeechStart = vi.fn();
    const onTranscript = vi.fn();
    const session = provider.createSession({
      cfg: {} as never,
      providerConfig: { silenceDurationMs: 40, minSpeechMs: 20 },
      onSpeechStart,
      onTranscript,
    });

    await session.connect();
    session.sendAudio(speechFrame);
    session.sendAudio(silenceFrame);
    session.sendAudio(silenceFrame);

    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledWith("local transcript"));
    expect(onSpeechStart).toHaveBeenCalledOnce();
    expect(transcriber).toHaveBeenCalledOnce();
    session.close();
  });

  it("suppresses an in-flight result after the stream closes", async () => {
    let resolveTranscript!: (value: string) => void;
    const transcriber = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveTranscript = resolve;
        }),
    );
    const provider = buildBufferedMediaRealtimeTranscriptionProvider({ transcriber });
    const onTranscript = vi.fn();
    const session = provider.createSession({
      cfg: {} as never,
      providerConfig: { silenceDurationMs: 20, minSpeechMs: 20 },
      onTranscript,
    });

    await session.connect();
    session.sendAudio(speechFrame);
    session.sendAudio(silenceFrame);
    await vi.waitFor(() => expect(transcriber).toHaveBeenCalledOnce());
    session.close();
    resolveTranscript("late transcript");
    await Promise.resolve();
    await Promise.resolve();

    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("rejects oversized audio before decoding or buffering it", async () => {
    const transcriber = vi.fn(async () => "should not run");
    const provider = buildBufferedMediaRealtimeTranscriptionProvider({ transcriber });
    const session = provider.createSession({
      cfg: {} as never,
      providerConfig: { silenceDurationMs: 20, minSpeechMs: 20 },
    });

    await session.connect();
    session.sendAudio(Buffer.alloc(8 * 1024 + 1));
    session.sendAudio(silenceFrame);
    await Promise.resolve();

    expect(transcriber).not.toHaveBeenCalled();
    session.close();
  });

  it("keeps minimum speech duration within the resolved segment duration", async () => {
    const transcriber = vi.fn(async () => "bounded transcript");
    const onTranscript = vi.fn();
    const provider = buildBufferedMediaRealtimeTranscriptionProvider({ transcriber });
    const session = provider.createSession({
      cfg: {} as never,
      providerConfig: { minSpeechMs: 30_000, maxSegmentMs: 100 },
      onTranscript,
    });

    await session.connect();
    for (let index = 0; index < 5; index += 1) {
      session.sendAudio(speechFrame);
    }

    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledWith("bounded transcript"));
    session.close();
  });

  it("bounds queued segments while the batch backend is stalled", async () => {
    let resolveFirst!: (value: string) => void;
    const transcriber = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue("queued transcript");
    const provider = buildBufferedMediaRealtimeTranscriptionProvider({ transcriber });
    const session = provider.createSession({
      cfg: {} as never,
      providerConfig: { silenceDurationMs: 20, minSpeechMs: 20 },
    });

    await session.connect();
    for (let index = 0; index < 12; index += 1) {
      session.sendAudio(speechFrame);
      session.sendAudio(silenceFrame);
    }
    await vi.waitFor(() => expect(transcriber).toHaveBeenCalledOnce());
    resolveFirst("first transcript");
    await vi.waitFor(() => expect(transcriber).toHaveBeenCalledTimes(5));

    expect(transcriber).toHaveBeenCalledTimes(5);
    session.close();
  });

  it("stages PCM as WAV, trims the result, and removes the temporary file", async () => {
    let stagedPath = "";
    const transcribeAudioFileImpl = vi.fn(async ({ filePath }) => {
      stagedPath = filePath;
      const staged = await fs.readFile(filePath);
      expect(staged.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(staged.subarray(8, 12).toString("ascii")).toBe("WAVE");
      return { text: "  staged transcript  " };
    });
    const transcriber = createBufferedMediaTranscriber({ transcribeAudioFileImpl });

    await expect(
      transcriber({
        pcm: Buffer.alloc(320),
        cfg: { tools: { media: { audio: { enabled: true } } } } as never,
        agentDir: "/tmp/agent",
      }),
    ).resolves.toBe("staged transcript");
    expect(transcribeAudioFileImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp/agent",
        mime: "audio/wav",
      }),
    );
    await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
