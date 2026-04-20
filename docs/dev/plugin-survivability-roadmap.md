# Plugin Survivability Roadmap

This roadmap tracks how `ec-main` should reduce rebase pressure by moving local feature behavior toward plugins, provider/channel capabilities, or narrow core seams.

It complements:

- `docs/dev/local-feature-index.md`
- `docs/dev/upstream-compat-feature-preservation-plan.md`
- `docs/dev/upstream-compat-refactor-plan.md`
- `docs/dev/policies/architecture-and-plugin-survivability.md`

## Goal

Keep the local `ec-main` feature set deployable while rebasing frequently onto upstream OpenClaw.

The goal is not to make every local feature a plugin. The goal is to put each behavior in the narrowest durable home:

- plugin-owned runtime or capability when the behavior is provider, channel, or extension-specific
- core compatibility helper when the behavior is local policy layered onto upstream orchestration
- core contract or schema only when the behavior is a global invariant
- operator script or runbook when the behavior is local deployment practice rather than product runtime behavior

## Roadmap Principles

- Preserve current user-visible behavior before reshaping internals.
- Prefer seam extraction before broad plugin migration.
- Keep global invariants in core: session resolution, A2A safety, turn lifecycle, gateway protocol, config schema, and generic profile selection.
- Move provider-specific behavior behind provider capability contracts.
- Move channel-specific presentation and interaction behavior behind channel plugin surfaces.
- Keep preservation tests attached to behavior, not file shape.
- When a conflict repeats in the same upstream-hot file, make the next repair a seam extraction unless there is a clear reason not to.

## Phase 1: Provider Auth Capability Seam

Status: next recommended implementation slice.

Purpose: reduce `/reauth` and profile/auth rebase pressure by moving provider-specific behavior behind provider-owned capabilities.

Scope:

- keep current OpenAI Codex chat reauth behavior unchanged
- extract provider-neutral capability lookup for chat-native reauth
- move OpenAI Codex start/complete/fallback behavior behind that capability
- keep generic `/reauth` orchestration provider-agnostic

Primary files:

- `src/auto-reply/reply/commands-reauth.ts`
- `src/plugins/provider-openai-codex-oauth.ts`
- `src/commands/models/auth.ts`
- `src/plugins/provider-auth-helpers.ts`

Validation:

```bash
pnpm test -- src/auto-reply/reply/commands-reauth.test.ts
pnpm test -- src/commands/openai-codex-oauth.test.ts
pnpm test -- src/plugins/provider-openai-codex-oauth.chat-reauth.test.ts
pnpm test -- src/commands/models/auth.test.ts
pnpm build
```

Exit criteria:

- `/reauth` no longer needs OpenAI Codex-specific logic inline in the command flow
- OpenAI Codex behavior remains preserved by focused tests
- the provider capability seam is documented or typed clearly enough for another provider to implement later

## Phase 2: Slack A2A Presentation Boundary

Purpose: keep Slack-specific approval rendering and interaction handling in Slack-owned surfaces while preserving generic A2A safety in core.

Scope:

- keep permission semantics and A2A safety policy in core
- move Slack-specific approval payload rendering toward Slack plugin helpers
- keep config patching and explicit retry semantics unchanged
- avoid hardcoding Slack-only presentation policy in generic tool-event handlers

Primary files:

- `src/agents/a2a/*`
- `src/agents/pi-embedded-subscribe.handlers.tools*`
- `extensions/slack/src/monitor/events/interactions.test.ts`
- `src/agents/openclaw-tools.sessions.test.ts`

Validation:

```bash
pnpm test -- src/agents/openclaw-tools.sessions.test.ts
pnpm test -- src/agents/a2a/permission-approval-action.test.ts
pnpm test -- src/agents/pi-embedded-subscribe.handlers.tools.test.ts
pnpm test -- extensions/slack/src/monitor/events/interactions.test.ts
```

Exit criteria:

- generic A2A tests assert permission and routing semantics
- Slack tests assert Slack approval interaction behavior
- shared tool-event handlers route payloads rather than owning Slack-specific formatting

## Phase 3: Automation Command And Status Seams

Purpose: make automation easier to preserve during rebases without prematurely forcing the whole feature into a plugin.

Scope:

- keep bounds, turn accounting, and session lifecycle in core
- extract automation command parsing and help/status text into feature-owned helpers
- extract automation progress/status payload shaping away from generic dispatch/tool handlers
- leave room for a future plugin-owned automation command surface after the seams stabilize

Primary files:

- `src/agents/tools/automation-tool.ts`
- `src/automation/*`
- `src/auto-reply/reply/commands-automation.ts`
- `src/auto-reply/reply/commands-automation-shared.ts`
- `src/auto-reply/reply/commands-automation-status.test.ts`

Validation:

```bash
pnpm test -- src/agents/openclaw-tools.automation.test.ts
pnpm test -- src/auto-reply/reply/commands-automation.test.ts
pnpm test -- src/auto-reply/reply/commands-automation-status.test.ts
pnpm test -- src/config/config.automation-defaults.test.ts
pnpm build
```

Exit criteria:

- automation behavior survives rebases through helper-level preservation tests
- upstream-hot auto-reply command loaders stay thin
- per-turn progress announcements remain covered

## Phase 4: Voice And Local STT Plugin Hardening

Purpose: keep voice-call and local STT behavior extension-owned while using shared media/runtime detection where appropriate.

Scope:

- keep `voice-call` telephony runtime behavior in the extension
- keep provider-neutral streaming STT contracts stable
- prefer shared media-runtime autodetect over voice-call-only local STT paths
- keep faster-whisper and local GPU STT integration behind command/config seams

Primary files:

- `extensions/voice-call/src/media-stream.ts`
- `extensions/voice-call/src/webhook.ts`
- `extensions/voice-call/src/providers/stt-*.ts`
- `src/media-understanding/apply.test.ts`

Validation:

```bash
pnpm test -- extensions/voice-call/src/media-stream.test.ts
pnpm test -- extensions/voice-call/src/webhook.test.ts
pnpm test -- extensions/voice-call/src/providers/stt-openai-realtime.test.ts
pnpm test -- extensions/voice-call/src/providers/stt-buffered-media.test.ts
pnpm test -- extensions/voice-call/src/providers/stt-factory.test.ts
pnpm test -- src/media-understanding/apply.test.ts
pnpm build
```

Exit criteria:

- voice-call provider choices stay extension-owned
- shared media autodetect remains generic
- local STT behavior can be preserved without editing unrelated core runtime files

## Phase 5: Rebase Gate Consolidation

Purpose: turn the roadmap into a repeatable rebase/live-patch gate.

Scope:

- keep `docs/dev/local-feature-index.md` validation commands current
- add or update preservation tests when feature seams move
- record new conflict hotspots in the relevant local feature doc
- keep broad checks for landing and build-impact changes, but use focused feature lanes for semantic repair

Validation:

```bash
pnpm check
pnpm test
pnpm build
```

Use the full gate near final landing when the touched surface can affect build output, packaging, lazy-loading/module boundaries, plugin SDK surfaces, or published runtime behavior.

Exit criteria:

- rebase repairs can be triaged by feature family
- focused preservation tests catch the local behavior regressions that matter
- live patching follows `docs/dev/policies/ec-main-integration.md`

## Decision Matrix

| Feature area                          | Durable home                                        | Next move                                       |
| ------------------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| OpenAI Codex reauth/profile specifics | provider capability seam                            | implement Phase 1                               |
| Slack A2A approval rendering          | Slack plugin plus generic A2A core seam             | implement Phase 2 after provider auth           |
| Automation command/status UX          | feature-owned helpers, then possible plugin surface | extract seams before pluginizing                |
| Automation bounds/session lifecycle   | core                                                | preserve as global invariant                    |
| Slack turn lifecycle                  | core turn tracking plus channel presentation seams  | avoid Slack-specific policy in generic dispatch |
| Voice-call telephony runtime          | extension/plugin                                    | harden existing plugin-owned seams              |
| Local STT backend selection           | shared media/runtime seam plus extension consumers  | keep autodetect generic                         |
| Live patch and upgrade routines       | operator scripts and policies                       | do not pluginize                                |

## Current Next Action

Start with Phase 1: provider auth capability seam for `/reauth`.

That slice gives the best immediate rebase-survivability return because it moves a known provider-specific hotspot toward the provider boundary without changing user-visible behavior.
