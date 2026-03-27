# Slack Huddle Support in the Telephony Stack

## Goal

Explore how OpenClaw could support Slack Huddles as a voice surface without confusing that work with the existing phone-centric `voice-call` plugin.

The practical question is not "can telephony place a call?" because that already exists.
The question is:

- can Slack act as a voice ingress / egress surface for the same runtime,
- can that be done through supported Slack APIs,
- and if not, what is the least risky approximation that still gives useful voice workflows?

## Current local architecture

Relevant code already in tree:

- `extensions/voice-call/`
- `extensions/slack/`
- `extensions/openai/speech-provider.ts`
- `extensions/elevenlabs/speech-provider.ts`

Current voice-call baseline:

- `extensions/voice-call/src/runtime.ts` wires provider selection, webhook serving, media streams, tunnel/Tailscale exposure, and telephony TTS.
- `extensions/voice-call/src/webhook.ts` owns inbound webhook handling and currently instantiates the realtime STT path.
- `extensions/voice-call/src/media-stream.ts` is Twilio-style bidirectional audio stream handling over WebSocket.
- `extensions/voice-call/src/config.ts` models telephony providers, webhook exposure, TTS, and streaming STT config.

Current provider baseline:

- Telephony providers today are `twilio`, `telnyx`, `plivo`, and `mock`.
- OpenAI and ElevenLabs speech providers already expose `synthesizeTelephony`, so the TTS side of the telephony stack is already abstracted reasonably well.
- The repo already has audio transcription providers behind the media-understanding registry.
  - `src/media-understanding/provider-registry.ts` seeds built-in `groq` and `deepgram` audio providers.
  - plugin registration adds more audio providers, including `openai` and `google`.
- In the current tree, ElevenLabs and Microsoft are TTS surfaces, not call-STT surfaces.

Important STT detail:

- The realtime media-stream path is effectively hard-wired to OpenAI Realtime today.
- `extensions/voice-call/src/webhook.ts` directly constructs `OpenAIRealtimeSTTProvider`.
- `extensions/voice-call/src/providers/index.ts` only exports `OpenAIRealtimeSTTProvider` for streaming STT.
- `extensions/voice-call/src/config.ts` restricts `streaming.sttProvider` to `openai-realtime`.

There is also a separate `stt` config block in `extensions/voice-call/src/config.ts` with `provider: "openai"` and `model: "whisper-1"`, but that does not appear to drive the active media-stream path. In practice, the current low-latency call stack is realtime-first, not Whisper-first.

Slack baseline:

- `extensions/slack/src/channel.ts` is a message/thread/channel transport.
- The Slack extension currently looks like a chat transport, not a call transport.
- There is no obvious huddle-specific route, command, or runtime surface in the Slack extension today.

## Slack platform facts that matter

Official Slack docs show that apps can observe huddle-related state, but that is not the same thing as being able to start or join a native Slack Huddle.

Relevant Slack docs:

- Conversation object:
  `https://docs.slack.dev/reference/objects/conversation-object/`
- `user_huddle_changed` event:
  `https://docs.slack.dev/reference/events/user_huddle_changed/`
- Calls API:
  `https://docs.slack.dev/reference/methods/calls.add/`

What those docs tell us:

- Slack conversation/message payloads explicitly include huddle data.
  - The conversation object says a conversation can be "a huddle".
  - `conversations.history` examples include `subtype: "huddle_thread"` and a `room` object with `call_family: "huddle"`, `canvas_thread_ts`, and `thread_root_ts`.
- Slack emits `user_huddle_changed`.
  - That event includes `profile.huddle_state` and `profile.huddle_state_call_id`.
- Slack's documented call creation path is the Calls API.
  - `calls.add` registers a new call for a third-party provider.
  - It requires an `external_unique_id` and a `join_url`.
  - In other words, Slack knows how to represent and launch external calls.

What I do **not** see in the public Slack docs:

- a documented Web API method to create a native Slack Huddle,
- a documented Web API method to join a native Slack Huddle as an app,
- a documented low-level media stream API for apps to ingest live Huddle audio directly.

Inference:

- "true Huddle support" should be treated as a research-risk item, not as an assumed implementation detail.
- The documented path today is "observe huddles" and "register external calls in Slack", not "drive Slack Huddles directly".

## Product framing

There are three materially different outcomes that could all be described loosely as "Slack huddle support":

### 1. Huddle-aware Slack companion

OpenClaw detects that a Huddle exists and uses Slack thread metadata / events to coordinate a voice workflow around it.

Examples:

- notice that a huddle started in a channel,
- post a thread message offering "bring OpenClaw in by phone/web call",
- attach transcripts, summaries, or follow-up notes back into the huddle thread,
- react to `user_huddle_changed` and `huddle_thread` activity for UX.

This is the lowest-risk Slack-facing feature because it depends on documented observation surfaces.

### 2. Slack-visible external OpenClaw call

OpenClaw uses Slack's Calls API to register an external call object inside Slack.

Examples:

- start an OpenClaw-managed call and post it into Slack as a call block,
- give Slack users a `join_url` that enters an OpenClaw voice surface,
- represent the call in a Slack-native way without pretending it is a true Huddle.

This is likely the most realistic "native-feeling" Slack voice integration available from public docs.

### 3. True native Huddle bridge

OpenClaw starts or joins an actual Slack Huddle and participates as a voice endpoint.

This is the highest-value outcome if it were possible, but currently the least certain.
Unless a supported Slack API exists, this path likely falls into one of these buckets:

- blocked,
- enterprise/private API only,
- brittle browser automation,
- or unsupported reverse engineering.

That means it should not be the first implementation slice.

## Recommendation

Do **not** start with "join a real Slack Huddle".

Start with two lower-risk tracks:

1. make the telephony/media-stream STT layer pluggable enough to support both local and cloud-hosted STT backends,
2. add Slack-facing huddle awareness plus external-call affordances.

That order keeps the architectural work reusable even if true Huddle control turns out to be impossible.

## STT backend spike

If we want to "try it with Whisper first", the right interpretation is still:

- first make the live voice stack capable of using a local / near-local Whisper-family STT backend,
- but do not stop there; the same seam should also allow remote providers when local Whisper latency is not good enough,
- then reuse that STT path for any future Slack voice surface where raw audio becomes available.

This is useful even if Slack Huddle ingest never ships, because it improves telephony and any future browser/device voice surfaces.

### Why this should come first

- The current realtime path is OpenAI-specific.
- Local Whisper or faster-whisper is attractive for:
  - lower marginal cost,
  - deterministic local behavior,
  - better operator control,
  - easier experimentation with buffering / chunking / VAD,
  - shared reuse with the non-telephony local audio stack already being explored elsewhere.
- Cloud-hosted transcription still matters because:
  - local Whisper may be too slow on some hosts,
  - operators may prefer a managed provider for latency consistency,
  - the repo already has reusable audio-transcription providers that can back a buffered telephony path.

### What needs to change

Introduce a generic realtime-or-streaming STT interface in `extensions/voice-call/src/providers/` so `MediaStreamHandler` depends on a contract, not `OpenAIRealtimeSTTProvider` directly.

Minimal target shape:

- `createSession()`
- `sendAudio(chunk)`
- `close()`
- callbacks or events for:
  - `partialTranscript`
  - `finalTranscript`
  - `speechStart`
  - `error`

Then:

- move `OpenAIRealtimeSTTProvider` behind that interface,
- add a `whisper-stream` or `faster-whisper-stream` implementation,
- add a buffered adapter that can call existing media-understanding audio providers such as `deepgram`, `groq`, `openai`, or `google`,
- update `extensions/voice-call/src/config.ts` so `streaming.sttProvider` is not a single-value enum.

### Local and cloud implementation sketch

For a first pass, do not overfit to "true realtime".

Use a segment-oriented local stream:

- ingest mu-law 8k audio from the live stream,
- convert to PCM16,
- buffer speech chunks using existing VAD boundaries or a lightweight local VAD,
- transcribe completed segments via local Whisper/faster-whisper,
- emit partials only if latency is good enough; otherwise emit finals only.

This would still be good enough for:

- phone conversation auto-response,
- call transcript logs,
- barge-in detection heuristics,
- a future Slack voice companion if an audio source appears.

For cloud-hosted STT, reuse the same segment boundaries:

- ingest mu-law 8k audio from the live stream,
- convert to PCM16,
- buffer completed speech segments,
- submit those segments to a configured remote transcription provider,
- emit final transcripts first; only add partial synthesis if a provider proves low-latency enough.

This avoids pretending that every cloud provider supports the same realtime semantics as OpenAI Realtime.

## Proposed implementation slices

## Slice 0: Make voice-call STT pluggable

Target:

- remove the direct `OpenAIRealtimeSTTProvider` dependency from `VoiceCallWebhookServer` and `MediaStreamHandler`.

Concrete work:

- define a provider-neutral streaming STT contract,
- adapt `OpenAIRealtimeSTTProvider`,
- extend config/schema/tests to allow multiple streaming STT backends,
- make the dormant `stt` config story coherent with the streaming config story.

Acceptance:

- current OpenAI Realtime behavior remains unchanged,
- provider selection moves into config/runtime assembly instead of webhook hard-coding.

## Slice 1: Add pluggable local and cloud STT backends

Target:

- support both a local Whisper-family backend and cloud-hosted segment transcription backends for the telephony media stream.

Concrete work:

- implement audio conversion / chunk buffering,
- add local process or embedded backend management for Whisper/faster-whisper,
- add a provider adapter that uses registered audio transcription providers,
- support at least one cloud-backed path from the existing provider set (`deepgram`, `groq`, `openai`, or `google`),
- measure final-transcript latency under realistic call audio,
- define fallback behavior when local STT is overloaded or explicitly not preferred.

Acceptance:

- a Twilio/Telnyx call can run end-to-end with local STT and existing telephony TTS,
- the same call path can be switched to a cloud-hosted transcription provider without code changes,
- transcripts are good enough to drive basic auto-response,
- latency is measured and documented.

## Slice 2: Add Slack huddle awareness

Target:

- make the Slack extension aware of huddle lifecycle signals without claiming direct Huddle control.

Concrete work:

- ingest/store `user_huddle_changed` where useful,
- detect `huddle_thread` / `room.call_family === "huddle"` in message history or live events,
- map huddle thread metadata to an OpenClaw session/thread model,
- expose a Slack-thread UX such as:
  - `Join with OpenClaw`
  - `Start external call`
  - `Transcribe attached recording`
  - `Summarize huddle`

Acceptance:

- when a huddle starts, OpenClaw can recognize the thread context and offer the right next action.

## Slice 3: Add Slack Calls API integration

Target:

- register OpenClaw-managed external calls inside Slack via the Calls API.

Concrete work:

- add Slack-side call registration in the Slack extension or a shared call adapter,
- create a stable `external_unique_id`,
- generate `join_url` / optional desktop deep link,
- post call blocks into the relevant channel/thread,
- sync participants/status as far as the public API supports.

Acceptance:

- Slack users can launch an OpenClaw-managed call from Slack without leaving the thread context blindly,
- the implementation remains clearly "external call in Slack", not fake "native Huddle".

## Slice 4: Research true native Huddle bridge

Do this only after Slices 0 through 3 are working.

Research questions:

- Is there any supported Slack API for starting a Huddle?
- Is there any supported Slack API for joining a Huddle as an app?
- Is there any supported way to consume live Huddle media as an app?
- If not, is browser automation acceptable for experimental/dev-only usage?

Exit criteria:

- either document a supported path,
- or explicitly mark true native Huddle participation out of scope.

## Architecture guidance

Keep Slack-specific logic out of the core telephony provider layer.

The telephony stack should remain responsible for:

- call lifecycle,
- webhook/media handling,
- audio conversion,
- streaming STT,
- telephony TTS,
- transcript-driven auto-response.

Slack-specific code should be responsible for:

- huddle detection,
- thread/session binding,
- call registration into Slack,
- Slack UX,
- Slack-originated commands and state reflection.

That keeps the stack reusable for:

- Twilio/Telnyx/Plivo direct use,
- Slack external-call workflows,
- possible future Teams/Meet/Discord/Nextcloud Talk integrations,
- browser or device voice surfaces.

## Risks

### 1. Public API gap

The biggest risk is that Slack may simply not expose a supported native-Huddle control plane.

Mitigation:

- design the first useful feature around huddle awareness + external calls, not around true Huddle control.

### 2. Over-coupling Slack to telephony internals

If Huddle work patches directly into provider-specific code, the design will become brittle fast.

Mitigation:

- put the abstraction boundary at the call/session layer and the STT/TTS layer, not in provider-specific Twilio code.

### 3. Whisper latency

Local Whisper may be too slow for tight interrupt/response loops if implemented naively.

Mitigation:

- start with segment-final transcripts,
- measure before promising partials,
- prefer faster-whisper / GPU where available,
- treat low-latency partial streaming as an optimization, not as phase-one scope.

### 4. Provider capability mismatch

Not every cloud provider has the same semantics as OpenAI Realtime.

Mitigation:

- separate realtime-session providers from buffered segment providers,
- keep a shared transcript event contract above them,
- do not force remote batch-like providers to fake partials they cannot deliver.

### 5. False equivalence between Calls API and Huddles

A Slack-visible external call is useful, but it is not the same user experience as a native Huddle.

Mitigation:

- name the feature honestly in code and UX.

## Recommended next step

The first concrete engineering spike should be:

1. refactor `voice-call` streaming STT behind a provider-neutral interface,
2. add a local Whisper/faster-whisper implementation,
3. add at least one cloud-backed segment transcription provider through the same seam,
4. prove that the telephony path works well enough with both local and cloud STT options,
5. then add Slack huddle awareness and Slack Calls API registration as the first Slack-facing voice integration.

That sequence gives us a useful outcome even if true native Huddle participation never becomes viable.
