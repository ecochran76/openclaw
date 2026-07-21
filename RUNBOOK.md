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
  - `pnpm test -- src/agents/openclaw-tools.sessions.test.ts src/agents/a2a/permission-approval-action.test.ts src/agents/embedded-agent-subscribe.handlers.tools.test.ts extensions/slack/src/monitor/events/interactions.test.ts extensions/slack/src/channel.test.ts extensions/slack/src/interactive-replies.test.ts`

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

## Turn 21 | 2026-06-28

- Created `docs/dev/plans/0014-2026-06-28-profile-support-retirement.md` after confirming upstream OpenClaw now owns native auth-profile storage, CLI auth commands, ordering, rotation, and doctor migration.
- Updated `ROADMAP.md`, `docs/dev/local-feature-index.md`, and `docs/dev/local-features/profiles.md` so future profile work aims to retire duplicated `ec-main` storage/CLI ownership and keep only thin operator UX/policy surfaces.

## Turn 22 | 2026-07-14

- Reviewed, validated, committed, and pushed the inherited xAI tool-catalog
  compaction slice as `1255acf401` before fetching upstream.
- Fetched `origin/main` at `b50822aab53`; recorded merge base `7bbd09047b`,
  divergence of 6,139 upstream-only / 339 downstream-only commits, and a
  165-file endpoint conflict forecast.
- Audited Codex app-server auth against sibling Codex source and separated
  fresh inference evidence from inconclusive zero-target model probes.
- Confirmed installed Slack executable bytes match current `ec-main` while
  registry metadata remains stale, so the external-plugin update belongs in
  the post-rebase live patch.
- Opened Plan 0015 for bounded pre-rebase preparation and reserved Plan 0016
  for the full feature-family replay.
- Published and live-patched `0b6fe030030`; a fresh Codex app-server turn
  returned the exact requested output with no fallback, and gateway/Slack deep
  probes remained healthy.
- Closed Plan 0015 and opened Plan 0016 for a recovery-ref-backed semantic
  squash replay, family gates, plugin-aware live patch, and latest Codex model
  transition.

## Turn 23 | 2026-07-16

- Contained the paused Plan 0016 `/goal` after 28.7 hours, 10,546,555 tokens,
  50 autoreview invocations, and 42 review cycles without an integration
  commit.
- Preserved the visible index, Cycle 42 stash, and complete restored candidate
  under `refs/backup/ec-main-drift-containment-20260716-{index,stash,full}`;
  retained the original stash.
- Restored the 54 paths isolated by Cycle 42 from the stash's saved index and
  verified zero remaining saved-index differences, zero unmerged paths, zero
  unstaged or untracked paths, and a clean staged diff check.
- Audited the replay history and chose the complete restored candidate as the
  salvage point rather than discarding valid repairs from earlier review
  cycles.
- Validated six remaining blockers covering auto-upgrade branch restoration,
  two pre-authorization session lookups, aborted failure-notice delivery, and
  two split-module metadata registries.
- Recorded the exact receipts and bounded recovery sequence in
  `docs/dev/notes/0035-2026-07-16-ec-main-rebase-goal-drift-containment.md` and
  added the recovery contract to Plan 0016.
- Next action: repair the six blockers with focused regressions, then review and
  commit one Plan 0016 feature family at a time; do not resume the open-ended
  complete-bundle autoreview loop.

## Turn 24 | 2026-07-16

- Split the six validated Plan 0016 recovery blockers into serialized Plans
  0017 through 0022.
- Required one dedicated subagent per plan, limited each subagent to its owned
  source/tests/plan, and withheld staging, commit, branch, ref, push, and live
  patch authority.
- Added roadmap milestone P08 so recovery progress is visible independently of
  the broader Plan 0016 feature-family replay.
- Execution order avoids shared hotspots: Plans 0017, 0018, and 0021 first;
  Plans 0019, 0020, and 0022 after their results are reconciled.

## Turn 25 | 2026-07-16

- Executed all six recovery plans through dedicated subagents and closed Plans
  0017 through 0022.
- Plan 0017 restored the caller's checkout on an already-integrated auto-upgrade
  no-op and added a real temporary-repository regression.
- Plans 0018 and 0019 moved explicit cross-agent listing and selector policy
  ahead of hidden row/selector lookup while preserving approved and same-agent
  behavior.
- Plan 0020 bound failure-notice and follow-up delivery to the source abort
  signal without removing the intended source-suppression bypass.
- Plans 0021 and 0022 moved coupled turn-tracker state and reply-payload fallback
  metadata to process-global singleton owners with split-module regressions.
- Every plan passed its focused tests, targeted formatting, and scoped diff
  checks. Isolated autoreview for Plans 0020 and 0022 returned no structured
  result before bounded recovery caps and was stopped without retry; fresh
  family-slice autoreview remains mandatory before commit.
- Marked roadmap milestone P08 complete. Next action returns to Plan 0016:
  integrate the six slices into an exact recovery ref, then resume bounded
  feature-family commits and their prescribed gates.

## Turn 26 | 2026-07-16

- Cancelled Plan 0016 rather than resuming its drifted combined replay/review
  contract.
- Preserved Plan 0016 as historical design/evidence and retained its completed
  semantic replay, containment audit, Plans 0017 through 0022, and exact
  six-blocker recovery ref.
- Opened Plan 0023 for only the unfinished work: complete path classification,
  bounded feature-family commits and autoreview, generated/integrated proof,
  current-ref force-with-lease publication, plugin-aware live patch/runtime
  verification, and installed-catalog-backed Codex model transition.
- Corrected the publication coordinate: local `ec-main` and `fork/ec-main` are
  both at `b15eabcc872f9c300e52a051fbc92c0d7db512f5`, which is the successor
  plan's force-with-lease expectation.
- Next action: verify the staged tree against
  `refs/backup/ec-main-drift-containment-20260716-six-blockers`, then create the
  complete one-owner-per-path family manifest before changing the index.

## Turn 27 | 2026-07-16

- Verified the frozen staged tree is
  `665bcb1e8f367b5f5621136f6da11363064dfc22`, exactly matching
  `refs/backup/ec-main-drift-containment-20260716-plan0023` at
  `7728b41fe9e2dea2927ce4e7037482b24e38aa4f`.
- Classified all 585 frozen paths exactly once in
  `docs/dev/notes/0036-2026-07-16-plan0023-frozen-family-manifest.md`: 144
  profiles/Codex, 94 Slack/A2A, 124 Slack responsiveness, 32 automation, 40
  voice/media, and 151 residual.
- Manifest comparison against the checkpoint found zero missing paths, zero
  extra frozen paths, and zero duplicates. The manifest itself is the sole
  post-checkpoint administrative Family 6 path.
- Next action: preserve the classified Phase 1 tree, then isolate, prove,
  autoreview, and commit each feature family in Plan 0023 dependency order.

## Turn 28 | 2026-07-19

- Re-audited the Plan 0023 fresh-agent handoff before resuming `/goal`:
  branch `rebase/ec-main-20260714`, `HEAD` `d04feac3852`, staged tree
  `b3920fd2b7a5`, 56 staged paths, 134 tracked worktree paths, no staged and
  unstaged path overlap, and no active reviewer remained unchanged.
- Confirmed `refs/backup/ec-main-plan0023-family3a-review` preserves the exact
  staged tree, so no additional recovery ref was required.
- Stopped the first read-only packetizer after it failed to return a completed
  artifact; a fresh replacement returned an exact 56-path map with zero
  omissions, duplicates, or extras.
- The first fresh neutral gate returned `REFRAME_OR_SPLIT`. The single allowed
  consolidated correction split timeout cleanup from runner/job orchestration,
  defined Profiles, A2A, Slack-responsiveness, automation, and generated
  mixed-hunk reconstruction order, and required decisive embedded-runner and
  gateway startup tests.
- The final fresh neutral gate returned `BLOCK`. Two independent behaviors
  remained misowned: `buildCommandsPaginationKeyboard` in
  `src/auto-reply/reply/commands-info.ts` was still grouped with tracked-turn
  commands, and `docs/automation/cron-jobs.md` documents cron `toolsAllow`
  narrowing rather than the bounded automation feature.
- Honored the Plan 0023 hard stop. No index surgery, implementation, test,
  commit, fetch, push, live patch, or runtime change followed.
- Concrete blocker: the packetization correction budget is exhausted. Resume
  only with explicit user direction to open a new packetization cycle or
  revise the hard-stop contract; do not silently start a second correction.

## Turn 29 | 2026-07-20

- The user explicitly authorized reopening packetization for the two Turn 28
  ownership defects. The recovery branch, `HEAD`, protected staged tree, path
  counts, and absence of staged/unstaged overlap remained unchanged.
- A fresh read-only correction proved the staged core
  `buildCommandsPaginationKeyboard` is an obsolete duplicate with no caller;
  Telegram/plugin-SDK owners already carry the live implementation and tests.
  The correction assigned that exact hunk for removal before tracked-turn
  reconstruction.
- The correction also removed `docs/automation/cron-jobs.md` from the bounded
  automation docs packet and assigned its six-line `toolsAllow` paragraph to a
  separate Family-6 docs packet behind the cron/tool-policy owners.
- The new fresh final gate returned `BLOCK` only because the named packet proof
  did not establish the paragraph's full claim that an unavailable requested
  tool fails before model prompting. Forwarding and narrowing were covered;
  the separate `src/agents/tool-allowlist-guard.ts` owner and integration
  ordering proof were omitted.
- Honored the new hard stop. No index surgery, implementation, test, commit,
  fetch, push, live patch, or runtime mutation followed.
- Concrete blocker: explicitly authorize one narrow proof/wording correction
  that either adds decisive allowlist-guard ordering evidence or narrows/drops
  the unsupported pre-prompt sentence, followed by one fresh final gate.

## Turn 30 | 2026-07-20

- The user selected an upstream-first rule: preserve downstream code only for
  a feature current upstream does not offer.
- Live comparison found no upstream `src/automation/`, so bounded
  `/automation` remains a real downstream feature. The core command-pagination
  helper and runtime-tools allowlist error helper had no production callers;
  upstream already owns Telegram pagination and cron tool narrowing.
- A fresh read-only disposition gate returned `ACCEPT` for dropping the two
  unused helpers, the allowlist helper's two isolated tests/import, and the
  unsupported six-line cron documentation paragraph while preserving bounded
  automation.
- Preserved the complete pre-removal tracked worktree at
  `refs/backup/ec-main-plan0023-upstream-preference-20260720`, commit
  `87cf7c4c6308b945a53afb82b68b9f5e54b065c9`, tree
  `e3e2f604a00a97f8a26c32ac462df7e9c27706e6`, then applied only the accepted
  stale-fragment removals. The live index was not changed.
- Next action: rebuild the accepted packet ledger without the dropped bytes,
  then perform recovery-safe index isolation and start the earliest dependency
  checkpoint.

## Turn 31 | 2026-07-20

- Rebuilt the upstream-first ledger as 55 accepted paths, 6,675 additions, and
  31 deletions after excluding the six cron-doc lines and 30-line core
  pagination helper; the allowlist helper/tests were never staged.
- The first neutral ledger gate returned `REFRAME_OR_SPLIT`: `A03` must precede
  `A02`, the runner-owned worker-input type coupled `A08` to `A09b`, and the
  first tracked snapshot omitted staged-new paths.
- Repaired recovery coverage at
  `refs/backup/ec-main-plan0023-upstream-preference-complete-20260720`, commit
  `d6d5e4c108fd5c8991a9d2ee8fe53be9e97242c4`, tree
  `4e7b8d4073f0f9ba2a01e354614fa8ceb2eb74c2`; every live-index path is present.
- The single consolidated map correction reordered `A03` before `A02` and
  assigned budget-shape plus worker-input types to
  `src/automation/types.ts`, separating `A08` budget enforcement from `A09b`
  dispatch behavior.
- The fresh final gate returned `REFRAME_OR_SPLIT` because
  `src/agents/tools/automation-tool.ts` in `A10` still imports the worker-input
  type from `src/automation/runner.ts`, whose export the corrected `A09b` would
  remove. The A10 packet must migrate that import to the canonical types owner.
- Honored the final-gate hard stop. The live index still writes tree
  `b3920fd2b7a5d2de90d923c1757da83d23a3ba96`, exactly matching
  `refs/backup/ec-main-plan0023-family3a-review`; no index isolation, tests,
  commit, fetch, push, live patch, or runtime mutation followed.
- Concrete next action requires explicit user authorization: open one new
  packet-map correction cycle for the A10 import migration, then run one fresh
  final gate before index isolation.

## Turn 32 | 2026-07-20

- The user granted standing authorization for routine Plan 0023 packet-map
  corrections and asked that repeated internal approval prompts stop.
- Bounded dependency/order fixes, fresh neutral gates, and recovery-safe index
  reconstruction now continue automatically. Escalation remains required only
  for destructive actions, changed publication authority, external side
  effects, material scope/product decisions, or lost recovery safety.
- Re-audit remained stable: branch `rebase/ec-main-20260714`, `HEAD`
  `d04feac3852`, live staged tree `b3920fd2b7a5`, matching protected backup,
  complete tracked snapshot reachable, and no unmerged paths.
- Next action: correct A10's worker-input type import in the packet ledger, run
  a fresh neutral gate, and proceed directly to recovery-safe reconstruction
  on acceptance.

## Turn 33 | 2026-07-20

- Closed packet-map correction automatically under the user's standing
  authorization. The accepted interpretation is: `automation-tool.ts` does
  not exist at `HEAD`; A10 introduces it whole with the canonical worker-input
  type imported from `automation/types.ts`.
- Recovery-safely rebuilt the live index for R01.1 without changing regular
  tracked worktree blobs. The first candidate's unrelated deletion of the
  upstream Codex-thinking matrix was rejected by a fresh neutral gate.
- Applied the single consolidated rework: restored the upstream test and kept
  only `/profile` and `/profiles` registry/dispatcher wiring. Reworked
  candidate `e66be439523a965c725b34ee712e82db1ec205c3`, tree
  `5a5ffc423bf6e851ba56567c4c651080d97b2fd0`, is exactly two files and 21
  additions.
- Isolated focused proof passed 55 tests; `git diff --cached --check` passed;
  the fresh final neutral gate returned `ACCEPT`.
- Mandatory scoped autoreview was attempted twice against the immutable
  candidate. Both Codex `gpt-5.6-sol` high-reasoning attempts emitted live
  heartbeats but returned no report and stayed service-idle through 30 minutes;
  each was stopped only after the documented diagnostic boundary.
- No commit was created because a missing autoreview report is not a clean
  review. R01.1 remains staged and recoverable. Next action is automatic:
  retry the same scoped autoreview when the service responds, then commit
  immediately on a clean result without requesting authorization.

## Turn 34 | 2026-07-20

- The user replaced the packet-replay strategy with an upstream-first minimal
  preservation rule: current upstream code and upstream validation are the
  baseline; retain and test only unique `ec-main` features and their direct
  integration seams.
- Revised Plan 0023 as Version 2. The 585-path manifest, automation packet
  queue, packet-map neutral gates, and Note 0037 resume algorithm are now
  historical recovery receipts rather than execution authority.
- Version 2 requires a clean isolated execution worktree, a concise
  feature-outcome `KEEP` / `DROP` / `MOVE` / `DEFER` matrix, immediate removal
  of upstream-equivalent code, focused family proof, one scoped review per
  coherent retained delta, and only one final integrated check/build when the
  final surface requires it.
- The prior R01.1 candidate remains preserved at
  `refs/backup/ec-main-plan0023-r01.1-reworked-candidate`, but must be compared
  with fresh upstream before reuse because the branch base and policy rollout
  have moved.
- Next action: stabilize an isolated worktree on fresh `origin/main`, build the
  upstream-gap matrix, and begin with the smallest retained profile delta.

## Turn 35 | 2026-07-20

- Tightened Plan 0023 to Version 3 under the user's explicit downstream-only
  validation rule. Unchanged upstream code inherits upstream CI; broad, full,
  release, platform, provider, and channel suites are not rerun.
- Phase 0 is complete. The isolated execution worktree is based on fresh
  `origin/main` `cadad3b7bd12f8caee09924b1c7bb35fc27d19b8`, which is 2,301
  commits newer than the historical candidate base. The shared dirty state is
  fully recoverable through
  `refs/backup/ec-main-plan0023-v2-pre-isolation-20260720`.
- A fully dropped family has no executable downstream gate. Retained families
  get only focused behavior tests for unique code and directly changed seams;
  final validation is cheap diff/static sanity, any specifically justified
  targeted integration check, and the single build/package needed by the live
  patch.
- Current comparisons already point toward dropping upstream-owned auth
  storage/rotation, A2A routing/session resolution, and Task/Task Flow
  lifecycle machinery. Phase 1 will retain only concrete gaps, then Phase 2
  will implement those small deltas directly on fresh upstream.

## Turn 36 | 2026-07-20

- Revised Plan 0023 to Version 4 to turn the upstream-first rule into a frozen
  execution ledger rather than another open-ended family audit.
- Unchanged upstream code inherits upstream CI. Upstream-owned Slack
  responsiveness, routing/session resolution, Task/Task Flow lifecycle,
  provider discovery, generated drift, compatibility layers, and obsolete
  tests are closed as `DROP` with no downstream executable gate.
- The only eligible retained outcomes are the already committed thin profile
  commands, near-quota usage policy, a conditional thin A2A approval seam,
  per-run automation bounds over upstream Tasks, the plugin-owned buffered
  media-audio bridge, and the deployment tooling required to publish and live
  patch the resulting branch.
- Historical implementation parity is explicitly out of scope. Every retained
  outcome gets only its exact focused test and scoped autoreview; the final
  branch gets cheap diff/static sanity plus the single package build required
  for live installation.

## Turn 37 | 2026-07-20

- Revised Plan 0023 to Version 5 to make upstream validation inheritance an
  explicit execution rule: a rebase alone does not justify rerunning an
  upstream gate. Only retained downstream behavior, directly edited seams,
  and the final package/install artifact receive new proof.
- Narrowed automation from turn/token/duration bounds to conditional turn/token
  enforcement. Current upstream already owns run-duration timeouts and Task
  lifecycle/status/stop, so downstream duration and lifecycle machinery are
  `DROP`. If turn/token controls cannot remain a thin seam, they are deferred
  rather than used to recreate the old automation subsystem.
- Existing focused results may be reused for immutable downstream commits when
  neither their diff nor direct upstream contract changed.

## Turn 38 | 2026-07-20

- Revised Plan 0023 to Version 6 after the usage-policy reconstruction failed
  the bounded-review convergence rule. The staged 2,300-plus-line attempt was
  removed from the isolated execution worktree after two correction cycles;
  the final review still reported a fast-runtime bypass, unsafe switch-target
  eligibility, a lost target warning, and fallback-profile source
  misclassification.
- Classified usage policy, the conditional A2A approval outcome, and turn/token
  automation as `DEFER`. Each requires a broader canonical subsystem or
  cross-owner integration rather than a thin fresh-upstream seam, so none may
  block this rebase.
- The isolated branch is clean and ahead of fresh `origin/main` by exactly two
  proven commits: `23281639cd8` for thin profile commands and `946f3a21338` for
  the plugin-owned buffered voice transcription bridge.
- Next action: audit the final two-commit delta, build/package once, publish
  `fork/ec-main` with the recorded exact lease, then live patch and prove the
  retained features.

## Turn 39 | 2026-07-20

- Closed Plan 0023 Version 7. Rebased the two retained downstream commits onto
  `origin/main` `3a9f89e42e9`; final head is `711d5ea3794` with profile commands
  at `cf92ae3b044` and buffered voice transcription at `711d5ea3794`.
- Published `ec-main` to `fork/ec-main` with exact force-with-lease from
  `b15eabcc872`; local, remote, and isolated heads all resolve to
  `711d5ea3794854b6452536efc469c77495cdb02e`.
- Built and integrity-checked
  `/tmp/openclaw-plan0023-711d5ea3794.tgz` with SHA-256
  `ad4b9e6d8afba8501f31e0f9c8ae7c691fbcd3c27f7da60af35b5aa34e855e`.
  Installed OpenClaw `2026.7.2 (711d5ea)`, migrated stale downstream config,
  regenerated the systemd service, and restored gateway startup after the
  bounded crash-loop records were backed up and cleared.
- Installed matching Codex `2026.7.2`; gateway status reports matching CLI and
  gateway versions, `Read probe: ok`, `Capability: admin-capable`, and restored
  Slack socket connections. Installed Voice Call `2026.7.2` but left it
  disabled because telephony was not previously configured; direct runtime
  import succeeds and the installed bundle contains buffered media
  transcription.
- Fresh upstream's unreleased root package omits runtime export-map entries
  still imported by official external plugins, while matching web-provider
  plugin versions are not yet published. Applied a narrow live export-map
  overlay for the installed Codex, Voice Call, Firecrawl, and Perplexity
  packages. This upstream packaging/version-drift follow-up does not reopen
  the completed rebase.
- Recovery artifacts include
  `/tmp/openclaw-live-patch-backups/openclaw-2026.6.10-b15eabc-20260720-171909.tar.gz`,
  `/tmp/openclaw-live-patch-backups/openclaw.json-before-2026.7.2-20260720-172049`,
  and
  `/tmp/openclaw-live-patch-backups/openclaw-state-before-breaker-clear-20260720-173516.tar.gz`.
