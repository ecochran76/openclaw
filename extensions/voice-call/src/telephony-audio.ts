// Voice Call plugin module implements telephony audio behavior.
export {
  convertPcmToMulaw8k,
  mulawToPcm as convertMulawToPcm16,
  pcmToMulaw,
  resamplePcmTo8k,
} from "openclaw/plugin-sdk/realtime-voice";

const TELEPHONY_CHANNELS = 1;
const TELEPHONY_BIT_DEPTH = 16;
const TELEPHONY_SAMPLE_RATE = 8000;

export function getTelephonyPcmDurationMs(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) {
    return 0;
  }
  return (samples / TELEPHONY_SAMPLE_RATE) * 1000;
}

/**
 * Build a WAV container for 8kHz mono 16-bit PCM telephony audio.
 */
export function buildTelephonyWavBuffer(pcm: Buffer): Buffer {
  const blockAlign = (TELEPHONY_CHANNELS * TELEPHONY_BIT_DEPTH) / 8;
  const byteRate = TELEPHONY_SAMPLE_RATE * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(TELEPHONY_CHANNELS, 22);
  header.writeUInt32LE(TELEPHONY_SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(TELEPHONY_BIT_DEPTH, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Chunk audio buffer into 20ms frames for streaming (8kHz mono mu-law).
 */
export function chunkAudio(audio: Buffer, chunkSize = 160): Generator<Buffer, void, unknown> {
  return (function* () {
    for (let i = 0; i < audio.length; i += chunkSize) {
      yield audio.subarray(i, Math.min(i + chunkSize, audio.length));
    }
  })();
}
