# OpenClaw `ec-main` Runbook

This runbook is a dated log of planning-contract and execution events that should remain discoverable across sessions.

## Turn 1 | 2026-04-20

- Adopted serialized planning, notes, and memory conventions from the repo-policy-selector policy library.
- Created `docs/dev/plans/0001-2026-04-20-plugin-survivability-roadmap.md` as the first active serialized plan.
- Created `docs/dev/notes/0001-2026-04-20-policy-layer-and-planning-convention-adoption.md`.
- Created `docs/dev/memories/0001-2026-04-20-ec-main-continuity-conventions.md`.

## Turn 2 | 2026-04-20

- Implemented the first plugin-survivability slice from `docs/dev/plans/0001-2026-04-20-plugin-survivability-roadmap.md`.
- Moved the OpenAI Codex chat reauth capability object into `src/plugins/provider-openai-codex-oauth.ts`.
- Added the generic `ChatReauthCapability` type to `src/plugins/provider-auth-types.ts`.
- Kept `src/auto-reply/reply/reauth-capabilities.ts` as a provider-neutral lookup surface.
- Validation passed:
  - `pnpm test -- src/auto-reply/reply/reauth-capabilities.test.ts src/auto-reply/reply/commands-reauth.test.ts src/plugins/provider-openai-codex-oauth.chat-reauth.test.ts src/plugins/provider-openai-codex-oauth.test.ts src/commands/models/auth.test.ts`
  - `pnpm build`

## Turn 3 | 2026-04-20

- Implemented the second plugin-survivability slice from `docs/dev/plans/0001-2026-04-20-plugin-survivability-roadmap.md`.
- Kept core A2A permission approval payloads generic by emitting text plus `channelData.a2aApproval` metadata from `src/agents/a2a/permission-approval-reply.ts`.
- Moved Slack approval button presentation into Slack-owned helpers in `extensions/slack/src/interactive-replies.ts`.
- Kept Slack A2A approval rendering independent from the optional inline interactive-replies capability toggle.
- Updated core and Slack tests so core asserts safety metadata while Slack asserts Slack-specific interactive rendering.
- Validation passed:
  - `pnpm test -- src/agents/openclaw-tools.sessions.test.ts src/agents/a2a/permission-approval-action.test.ts src/agents/pi-embedded-subscribe.handlers.tools.test.ts extensions/slack/src/monitor/events/interactions.test.ts extensions/slack/src/channel.test.ts extensions/slack/src/interactive-replies.test.ts`

## Turn 4 | 2026-04-20

- Stabilized the first failing-test slice observed after the plugin-survivability work.
- Isolated gateway auth tests from live `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD` environment credentials so local operator secrets cannot change expected unauthenticated request behavior.
- Isolated auth-profile store tests from live `CODEX_HOME` so real Codex CLI profile state cannot be imported into temp fixture stores.
- Split Codex CLI OAuth reuse from runtime overlays: Codex CLI credentials can still be used as explicit usable bootstrap credentials, but they no longer silently overlay persisted profile health/status or agent runtime store state.
- Kept expired external CLI credentials from replacing the canonical OAuth refresh context.
- Updated auth-profile state tests for the current storage contract: order, last-good, and usage stats live in per-agent `auth-state.json`, while `auth-profiles.json` stores secret-bearing credentials.
- Validation passed:
  - `pnpm test -- src/gateway/auth.test.ts src/gateway/call.test.ts src/gateway/server-runtime-config.test.ts src/gateway/server.auth.compat-baseline.test.ts src/gateway/server.auth.control-ui.test.ts src/agents/auth-health.test.ts src/agents/auth-profiles.external-cli-sync.test.ts src/agents/auth-profiles/external-oauth.test.ts src/agents/auth-profiles/oauth.openai-codex-refresh-fallback.test.ts src/agents/auth-profiles/profiles.test.ts src/agents/auth-profiles.runtime-snapshot-order.test.ts src/agents/auth-profiles.runtime-snapshot-external-update.test.ts src/agents/auth-profiles.ensureauthprofilestore.test.ts`

## Turn 5 | 2026-04-21

- Stabilized the next full-suite failure clusters after the auth environment slice.
- Fixed gateway probe diagnostics so unresolved configured SecretRefs stay visible even when live gateway env credentials provide the usable fallback.
- Changed doctor legacy-config migration validation to raw plugin-aware validation and tightened raw plugin validation so default-enabled plugin schemas do not invalidate unrelated migrated config.
- Regenerated config schema artifacts after adding labels for `auth.usagePolicy`.
- Updated stale command/docs coverage for `/profile`, `/profiles`, `/reauth`, legacy auth aliases, generic provider fixtures, and cron delivery logger mocking.
- Hardened timing-sensitive tests and behavior:
  - Extension package boundary timing now uses monotonic elapsed timers.
  - Git exploit regression helpers have bounded subprocess waits.
  - Provider usage auth opens the auth profile store lazily so plugin-owned usage auth does not touch local stores.
  - WebSocket send failures fall back to HTTP immediately in auto mode, while mid-request disconnects surface as stream errors.
  - Session label resolution now applies the deleted-agent guard.
- Validation passed:
  - `pnpm test -- src/agents/openai-ws-stream.test.ts src/commands/auth-choice.preferred-provider.test.ts src/agents/tools/sessions-list-tool.test.ts src/agents/tools/sessions-spawn-tool.test.ts src/gateway/sessions-resolve.test.ts src/gateway/sessions-resolve-store.test.ts src/gateway/server.sessions.gateway-server-sessions-a.test.ts src/gateway/server.chat.gateway-server-chat.test.ts test/scripts/check-extension-package-tsc-boundary.test.ts src/infra/host-env-security.test.ts src/infra/provider-usage.auth.plugin.test.ts src/infra/run-node.test.ts src/commands/auth-choice-legacy.test.ts src/commands/gateway-status/helpers.test.ts src/commands/doctor/shared/legacy-web-search-migrate.test.ts src/docs/slash-commands-doc.test.ts src/config/schema.help.quality.test.ts src/config/schema.base.generated.test.ts src/plugins/contracts/core-extension-facade-boundary.test.ts src/cron/delivery.failure-notify.test.ts`
  - `pnpm check`
- Full-suite note:
  - A full `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test` probe was run far enough to expose and fix these clusters through the agent/gateway lanes, but was not rerun to final completion after the last WebSocket patch due runtime cost. Treat the focused set plus `pnpm check` as the evidence for this stabilization turn.

## Turn 6 | 2026-04-21

- Continued full-suite stabilization from the clean `ec-main` state after Turn 5.
- Restored `/tasks` to the native command registry so implemented task status handling is exposed consistently through native command specs and chat command lists.
- Added the active automation run compact line to `/status` by reusing the automation registry/status formatter, preserving the Slack-visible automation state the operator expected.
- Updated abort cascade coverage to use the current controller-owned subagent listing seam instead of the legacy requester-list mock.
- Preserved voice-call plugin compatibility:
  - Plugin runtime config parsing now uses the existing voice-call legacy config migration helper, so deprecated `provider: "log"`, `twilio.from`, and legacy streaming keys normalize before strict schema validation.
  - `responseModel` is optional again so voice responses inherit the active runtime default unless explicitly configured.
- Updated Telegram command pagination expectations after `/tasks` returned to the command registry.
- Hardened browser Chrome internal tests on Linux by making mocked executable discovery cover both macOS `Google Chrome` and Linux `google-chrome` candidate paths.
- Validation passed:
  - `pnpm test -- src/auto-reply/commands-registry.test.ts src/auto-reply/reply/abort.test.ts src/auto-reply/reply/commands-automation-status.test.ts src/automation/status.test.ts src/auto-reply/status.test.ts extensions/telegram/src/bot.test.ts extensions/voice-call/index.test.ts extensions/voice-call/src/config.test.ts extensions/voice-call/src/response-generator.test.ts extensions/voice-call/src/response-model.test.ts extensions/voice-call/src/config-compat.test.ts`
  - `pnpm test -- extensions/browser/src/browser/chrome.internal.test.ts`
  - `pnpm check`
- Full-suite note:
  - The original `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test` run completed red before these fixes landed. It exposed the fixed deterministic failures above plus one `ERR_WORKER_OUT_OF_MEMORY` in an extension lane. Rerun the full suite after this turn if a final all-green landing gate is required.

## Turn 7 | 2026-04-21

- Closed the Turn 6 full-suite caveat with a final end-to-end full test pass.
- Fixed the launchd supervised gateway restart test to use fake timers only around the restart-delay assertion, avoiding cross-test `Date.now()` / timer contamination while preserving the startup path on real timers.
- Stabilized the oversized extension-channels shard:
  - `test/vitest/vitest.extension-channels.config.ts` now uses `pool: "forks"`.
  - The shard overrides full-suite `OPENCLAW_VITEST_MAX_WORKERS=1` with a small fixed 4-worker split so Discord/Slack/Signal/iMessage/Line tests do not accumulate the whole channel graph in one process.
  - Updated the scoped-config meta-test to document the extension-channels fork-pool exception and worker split.
- Validation passed:
  - `pnpm test -- src/cli/gateway-cli/run-loop.test.ts`
  - `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm exec vitest run --config test/vitest/vitest.extension-channels.config.ts`
  - `pnpm exec vitest run --config test/vitest/vitest.full-core-support-boundary.config.ts`
  - `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test`
  - `pnpm check`

## Turn 8 | 2026-04-21

- Started Phase 3 of the plugin-survivability roadmap: automation command/status seams.
- Moved automation slash-command surface helpers out of auto-reply and into `src/automation/command-surface.ts`.
- Kept `src/auto-reply/reply/commands-automation-shared.ts` as a compatibility re-export while updating the live automation command handler to import from the automation-owned surface directly.
- Added helper-level coverage for automation usage text, natural-language command suggestion generation, run-bound parsing, accepted-run acknowledgement formatting, command-tail slicing, and tool-result text extraction.
- Validation passed:
  - `pnpm test -- src/automation/command-surface.test.ts src/auto-reply/reply/commands-automation.test.ts src/auto-reply/reply/commands-automation-status.test.ts src/agents/tools/automation-tool.test.ts src/automation/status.test.ts src/automation/config.test.ts`
  - `pnpm check`
  - `pnpm build`

## Turn 9 | 2026-04-21

- Continued Phase 3 by extracting automation progress/status payload shaping out of generic tool/runner code.
- Moved isolated worker result parsing and `RESULT:` control-line mapping into `src/automation/worker-result.ts`.
- Moved progress summary truncation, final-summary candidate selection, turn-update candidate selection, and self-reported-incomplete detection into `src/automation/progress-reporting.ts`.
- Kept `src/agents/tools/automation-tool.ts` and `src/automation/runner.ts` as thin orchestration surfaces for execution, delivery, accounting, and lifecycle.
- Added helper-level coverage for worker result mapping and progress-reporting decisions.
- Validation passed:
  - `pnpm test -- src/automation/worker-result.test.ts src/automation/progress-reporting.test.ts src/automation/runner.test.ts src/automation/status.test.ts src/agents/tools/automation-tool.test.ts src/auto-reply/reply/commands-automation.test.ts src/auto-reply/reply/commands-automation-status.test.ts src/automation/command-surface.test.ts src/automation/config.test.ts`
  - `pnpm check`
  - `pnpm build`

## Turn 10 | 2026-04-21

- Finished the remaining obvious Phase 3 automation seam by moving worker protocol/job construction into automation-owned code.
- Added `src/automation/worker-job.ts` for the worker control-line prompt and isolated cron-compatible automation worker job shape.
- Updated `src/agents/tools/automation-tool.ts` to consume the automation-owned worker job/control prompt while keeping it focused on dependency wiring, delivery, and tool action orchestration.
- Added helper-level coverage for the worker control-line contract and cron job shape.
- Validation passed:
  - `pnpm test -- src/automation/worker-job.test.ts src/automation/worker-result.test.ts src/automation/progress-reporting.test.ts src/automation/runner.test.ts src/automation/status.test.ts src/agents/tools/automation-tool.test.ts src/auto-reply/reply/commands-automation.test.ts src/auto-reply/reply/commands-automation-status.test.ts src/automation/command-surface.test.ts src/automation/config.test.ts`
  - `pnpm check`
  - `pnpm build`

## Turn 11 | 2026-04-21

- Marked Phase 3 complete in `docs/dev/plans/0001-2026-04-20-plugin-survivability-roadmap.md` and advanced the current next action to Phase 4.
- Started Phase 4 voice/local STT plugin hardening with a small extension-owned seam.
- Added `extensions/voice-call/src/providers/stt-provider-config.ts` to normalize voice-call streaming STT provider ids, provider-owned config blobs, OpenAI realtime defaults/API-key lookup, and buffered media numeric options.
- Updated `extensions/voice-call/src/providers/stt-factory.ts` to consume the voice-call-owned config helper while keeping provider selection and provider construction inside the extension.
- Added helper-level tests for default provider resolution, provider config lookup, OpenAI realtime defaults/API key precedence, and media-audio numeric option fallback.
- Validation passed:
  - `pnpm test -- extensions/voice-call/src/providers/stt-provider-config.test.ts extensions/voice-call/src/providers/stt-factory.test.ts extensions/voice-call/src/providers/stt-buffered-media.test.ts extensions/voice-call/src/providers/stt-openai-realtime.test.ts extensions/voice-call/src/media-stream.test.ts extensions/voice-call/src/webhook.test.ts src/media-understanding/apply.test.ts`
  - `pnpm check`
  - `pnpm build`

## Turn 12 | 2026-04-21

- Continued Phase 4 by separating buffered media STT segmentation from local media-runtime transcription staging.
- Added `extensions/voice-call/src/providers/stt-buffered-media-transcriber.ts` as the voice-call-owned adapter that stages telephony PCM as a temporary WAV and invokes the shared media-understanding transcription runtime.
- Updated `BufferedMediaSttProvider` so it owns telephony buffering/VAD/session behavior while delegating temp-file and transcription invocation details to the adapter.
- Preserved the existing `transcribeAudioFileImpl` test injection path and added direct adapter coverage for WAV staging, transcript trimming, blank transcript normalization, and temp cleanup.
- Validation passed:
  - `pnpm test -- extensions/voice-call/src/providers/stt-buffered-media-transcriber.test.ts extensions/voice-call/src/providers/stt-buffered-media.test.ts extensions/voice-call/src/providers/stt-provider-config.test.ts extensions/voice-call/src/providers/stt-factory.test.ts extensions/voice-call/src/media-stream.test.ts extensions/voice-call/src/webhook.test.ts src/media-understanding/apply.test.ts`
  - `pnpm check`
  - `pnpm build`

## Turn 13 | 2026-04-21

- Completed the Phase 4 closeout review for voice/local STT plugin hardening.
- Updated voice-call plugin UI hints in both `extensions/voice-call/index.ts` and `extensions/voice-call/openclaw.plugin.json` from legacy `streaming.sttProvider`, `streaming.openaiApiKey`, and `streaming.sttModel` keys to canonical `streaming.provider` and `streaming.providers.openai.*` keys.
- Added preservation coverage in `extensions/voice-call/index.test.ts` so legacy streaming UI hint keys do not reappear.
- Marked Phase 4 complete in `docs/dev/plans/0001-2026-04-20-plugin-survivability-roadmap.md` and advanced the current next action to Phase 5 rebase gate consolidation.
- Validation passed:
  - `pnpm test -- extensions/voice-call/index.test.ts extensions/voice-call/src/config-compat.test.ts extensions/voice-call/src/config.test.ts extensions/voice-call/src/providers/stt-provider-config.test.ts extensions/voice-call/src/providers/stt-factory.test.ts extensions/voice-call/src/providers/stt-buffered-media-transcriber.test.ts extensions/voice-call/src/providers/stt-buffered-media.test.ts extensions/voice-call/src/media-stream.test.ts extensions/voice-call/src/webhook.test.ts src/media-understanding/apply.test.ts`
  - `pnpm check`
  - `pnpm build`

## Turn 14 | 2026-04-21

- Started Phase 5 rebase gate consolidation by updating feature-family validation references.
- Updated `docs/dev/local-feature-index.md` so automation validation points at the Phase 3 seam tests and voice/telephony validation points at the Phase 4 config/transcriber/UI-hint preservation tests.
- Updated `docs/dev/local-features/automation.md` with the new automation seam ownership map and focused validation runbook.
- Updated `docs/dev/local-features/voice-telephony.md` with Phase 4 ownership notes, new conflict hotspots, and the expanded focused validation set.
- Replaced the stale March repair plan in the local feature index with the current Phase 5 gate-consolidation sequence.
- Validation passed:
  - `pnpm test -- src/automation/command-surface.test.ts src/automation/worker-job.test.ts src/automation/worker-result.test.ts src/automation/progress-reporting.test.ts src/automation/runner.test.ts src/automation/status.test.ts src/agents/tools/automation-tool.test.ts src/auto-reply/reply/commands-automation.test.ts src/auto-reply/reply/commands-automation-status.test.ts src/automation/config.test.ts extensions/voice-call/index.test.ts extensions/voice-call/src/config.test.ts extensions/voice-call/src/config-compat.test.ts extensions/voice-call/src/media-stream.test.ts extensions/voice-call/src/webhook.test.ts extensions/voice-call/src/providers/stt-provider-config.test.ts extensions/voice-call/src/providers/stt-openai-realtime.test.ts extensions/voice-call/src/providers/stt-buffered-media-transcriber.test.ts extensions/voice-call/src/providers/stt-buffered-media.test.ts extensions/voice-call/src/providers/stt-factory.test.ts src/media-understanding/apply.test.ts`
  - `pnpm check`

## Turn 15 | 2026-04-21

- Added `scripts/ec-main-rebase-gate.sh` as the repeatable focused gate wrapper for the local automation and voice/telephony feature families.
- The wrapper supports `--family automation`, `--family voice`, `--family all`, `--check`, `--build`, `--live-patch`, and `--list`.
- Updated `docs/dev/local-feature-index.md`, `docs/dev/policies/ec-main-integration.md`, and `docs/dev/policies/validation-and-handoff.md` to point future rebase/live-patch work at the wrapper.
- Updated the plugin survivability roadmap current action to reflect that automation and voice/telephony now have a concrete gate command; remaining Phase 5 work is deciding whether profiles and Slack families need similar wrappers.
- Validation passed:
  - `scripts/ec-main-rebase-gate.sh --help`
  - `scripts/ec-main-rebase-gate.sh --family automation --list`
  - `scripts/ec-main-rebase-gate.sh --family all --check --build --live-patch --list`
  - `scripts/ec-main-rebase-gate.sh --family all`
  - `pnpm check`

## Turn 16 | 2026-04-21

- Expanded `scripts/ec-main-rebase-gate.sh` beyond automation and voice/telephony to cover every local feature family tracked in `docs/dev/local-feature-index.md`: profiles, Slack/A2A, Slack responsiveness, automation, and voice/telephony.
- Updated `docs/dev/local-feature-index.md`, `docs/dev/policies/ec-main-integration.md`, `docs/dev/policies/validation-and-handoff.md`, and `docs/dev/plans/0001-2026-04-20-plugin-survivability-roadmap.md` so rebase repair has one canonical feature-gate entry point.
- Validation passed:
  - `scripts/ec-main-rebase-gate.sh --help`
  - `scripts/ec-main-rebase-gate.sh --family all --list`
  - `scripts/ec-main-rebase-gate.sh --family all`
  - `pnpm check`

## Turn 17 | 2026-04-21

- Closed `docs/dev/plans/0001-2026-04-20-plugin-survivability-roadmap.md` after Phase 5 met its exit criteria.
- Kept possible stricter live-patch preflight as future work for a new serialized plan only if the next rebase/live-patch cycle shows repeated operator mistakes around `--live-patch`.
- Validation checked:
  - `rg -n "Phase 5 is in progress|Continue Phase 5|remaining Phase 5|The next implementation slice is Phase 5" docs/dev/plans/0001-2026-04-20-plugin-survivability-roadmap.md RUNBOOK.md docs/dev/local-feature-index.md` returned only historical Turn 15 context in `RUNBOOK.md`.

## Turn 18 | 2026-04-26

- Created `docs/dev/plans/0002-2026-04-26-openclaw-agent-skill-catalog.md` for the OpenClaw-specific Codex agent skill catalog.
- Added the first skill batch:
  - `.agents/skills/openclaw-gateway-operator/SKILL.md`
  - `.agents/skills/openclaw-auth-profile-debugger/SKILL.md`
  - `.agents/skills/openclaw-feature-preservation/SKILL.md`
- Updated `ROADMAP.md` with the new skill catalog plan.

## Turn 19 | 2026-04-26

- Created `docs/dev/plans/0003-2026-04-26-openclaw-agent-skill-catalog-batch-2.md` for the next OpenClaw-specific Codex agent skill batch.
- Added the second skill batch:
  - `.agents/skills/openclaw-automation-maintainer/SKILL.md`
  - `.agents/skills/openclaw-slack-runtime-debugger/SKILL.md`
  - `.agents/skills/openclaw-agent-bootstrap-debugger/SKILL.md`
  - `.agents/skills/openclaw-plugin-survivability/SKILL.md`
- Updated `ROADMAP.md` with the batch-2 skill catalog plan.

## Turn 20 | 2026-05-18

- Added `scripts/openclaw-health-snapshot.mjs` as a read-only, timeout-bounded
  operator health surface.
- The snapshot checks gateway RPC, Slack channel config, cron, wake-trigger
  status, and wake-trigger checker/alert timers.
- Updated the gateway operator and wake-trigger skills so agents check wake
  health alongside gateway, Slack, cron, and timer health.
- Updated the wake-trigger plan with the current userland diagnostic and alert
  surfaces.
