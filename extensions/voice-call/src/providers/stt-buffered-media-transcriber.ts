import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/infra-runtime";
import { transcribeAudioFile } from "openclaw/plugin-sdk/media-understanding-runtime";
import { buildTelephonyWavBuffer } from "../telephony-audio.js";

export type VoiceCallBufferedMediaTranscribeAudioFile = typeof transcribeAudioFile;

export type VoiceCallBufferedMediaTranscriber = (params: {
  pcm: Buffer;
  cfg: OpenClawConfig;
  agentDir?: string;
}) => Promise<string | undefined>;

export function createBufferedMediaTranscriber(options?: {
  transcribeAudioFileImpl?: VoiceCallBufferedMediaTranscribeAudioFile;
}): VoiceCallBufferedMediaTranscriber {
  const transcribeAudioFileImpl = options?.transcribeAudioFileImpl ?? transcribeAudioFile;
  return async ({ pcm, cfg, agentDir }) => {
    const tempRoot = resolvePreferredOpenClawTmpDir();
    await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
    const tempDir = await fs.mkdtemp(path.join(tempRoot, "voice-call-stt-"));
    const filePath = path.join(tempDir, `segment-${randomUUID()}.wav`);

    try {
      await fs.writeFile(filePath, buildTelephonyWavBuffer(pcm));
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
