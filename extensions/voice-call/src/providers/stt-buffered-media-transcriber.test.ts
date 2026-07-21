import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createBufferedMediaTranscriber } from "./stt-buffered-media-transcriber.js";

describe("voice-call buffered media transcriber", () => {
  it("stages telephony PCM as a temporary WAV and trims the media transcript", async () => {
    let stagedPath = "";
    const transcribeAudioFileImpl = vi.fn(async ({ filePath }) => {
      stagedPath = filePath;
      const staged = await fs.readFile(filePath);
      expect(staged.subarray(0, 4).toString("ascii")).toBe("RIFF");
      return { text: "  hello from media runtime  " };
    });
    const transcriber = createBufferedMediaTranscriber({ transcribeAudioFileImpl });

    await expect(
      transcriber({
        pcm: Buffer.alloc(320),
        cfg: { tools: { media: { audio: { enabled: true } } } } as never,
        agentDir: "/tmp/agent",
      }),
    ).resolves.toBe("hello from media runtime");

    expect(transcribeAudioFileImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.any(Object),
        agentDir: "/tmp/agent",
        mime: "audio/wav",
      }),
    );
    await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("normalizes blank transcripts to undefined", async () => {
    const transcriber = createBufferedMediaTranscriber({
      transcribeAudioFileImpl: vi.fn(async () => ({ text: "   " })),
    });

    await expect(
      transcriber({ pcm: Buffer.alloc(320), cfg: {} as never }),
    ).resolves.toBeUndefined();
  });
});
