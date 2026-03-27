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
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(transcribeAudioFileImpl).not.toHaveBeenCalled();
    session.close();
  });
});
