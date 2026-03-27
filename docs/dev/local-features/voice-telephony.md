# Voice / Telephony

This doc tracks repo-local voice and telephony deltas that matter for `ec-main` rebases and future Slack huddle voice work.

## Scope

- `extensions/voice-call/**`
- streaming STT provider boundaries
- telephony TTS / media-stream interaction
- shared `tools.media.audio` auto-detect behavior that telephony inherits
- local GPU transcription readiness that affects the future voice-call backend choice

Related design note:

- `docs/dev/slack-huddle-telephony-plan.md`

## Current status

- Slice 0 landed locally on `ec-main`: `voice-call` media-stream handling now depends on a provider-neutral streaming STT contract instead of the OpenAI class directly.
- Slice 1 landed locally on `ec-main`: `media-audio` buffered STT can now route telephony segments through the shared `tools.media.audio` runtime.
- Slice 2 landed locally on `ec-main`: shared audio auto-detect now recognizes `faster-whisper` skill wrappers from standard skill roots or `OPENCLAW_FASTER_WHISPER_COMMAND`, so `voice-call` can inherit a local GPU STT backend without a second resolver stack.
- OpenAI Realtime and buffered `media-audio` are the shipped streaming backends today.
- Local GPU transcription feasibility was validated on `2026-03-26` from WSL against an RTX 5080:
  - `small.en`: `3.12x` realtime on an 88s speech sample
  - `distil-large-v3`: `5.83x` realtime on an 88s speech sample
- Practical note: the bundled WSL `nvidia-smi` was misleading on this host, but direct CUDA/NVML probes and actual `faster-whisper` inference succeeded.

## Conflict hotspots

- `extensions/voice-call/src/media-stream.ts`
- `extensions/voice-call/src/webhook.ts`
- `extensions/voice-call/src/providers/stt-*.ts`
- `extensions/voice-call/src/config.ts`
- `extensions/voice-call/index.ts`
- `src/media-understanding/runner.ts`

## Validation

- `pnpm test -- extensions/voice-call/src/media-stream.test.ts`
- `pnpm test -- extensions/voice-call/src/webhook.test.ts`
- `pnpm test -- extensions/voice-call/src/providers/stt-openai-realtime.test.ts`
- `pnpm test -- extensions/voice-call/src/providers/stt-buffered-media.test.ts`
- `pnpm test -- extensions/voice-call/src/providers/stt-factory.test.ts`
- `pnpm test -- src/media-understanding/apply.test.ts`
- `pnpm build`

## Rebase notes

- Keep the provider-neutral STT seam separate from any later faster-whisper or buffered-segment backend work.
- The buffered `media-audio` backend depends on the existing `tools.media.audio` resolution path. Keep telephony STT changes aligned with that shared runtime instead of forking a second audio-model selection stack.
- Prefer shared media-runtime autodetect and explicit command env overrides over adding another voice-call-only local-STT path.
- If a future local backend changes runtime prerequisites, document them here instead of burying them only in chat or ad-hoc setup notes.
