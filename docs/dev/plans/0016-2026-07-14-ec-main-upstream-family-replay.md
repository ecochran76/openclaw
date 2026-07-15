State: OPEN
Created: 2026-07-14

# ec-main Upstream Feature-Family Replay

## Objective

Rebuild `ec-main` on fresh `origin/main` while preserving only maintained
downstream product behavior. The result must use current upstream ownership,
storage, protocol, plugin, and generated-output contracts; pass focused and
broad proof; update the installed core and external Slack plugin together; and
move configured Codex agents to the latest supported OpenAI Codex model only
after runtime authentication succeeds.

This is a semantic squashed replay, not a blind replay of 339 historical
commits. The downstream history contains 36 repair/rebase/checkpoint strata,
including one 42-file checkpoint that rewrites retired Codex owners. Git found
no patch-id or range-diff matches that can safely classify those commits as
upstreamed. Replaying every historical repair would repeatedly resurrect old
topology and hide semantic drops inside conflict choices.

## Fixed Coordinates

- source/runtime checkpoint: `0b6fe0300302`
- plan-execution checkpoint: `197a33da957`
- published checkpoint: `fork/ec-main` at `197a33da957`
- upstream target: `origin/main` at `b50822aab53e`
- merge base: `7bbd09047bd7`
- divergence at preparation: 6,139 upstream-only / 340 downstream-only
- endpoint forecast: 499 conflict hunks across 165 files
- sibling Codex contract: `bdd282f3bbd5`

Before changing ancestry, create and publish
`backup/ec-main-pre-rebase-20260714-197a33d` at the plan-execution checkpoint.
Record `197a33da957` as the old `fork/ec-main` force-with-lease expectation.

## Replay Method

1. Start a temporary integration branch at the fixed upstream target.
2. Squash-merge the checkpoint once, producing one three-way endpoint conflict
   set instead of replaying historical repair conflicts hundreds of times.
3. Resolve the endpoint semantically against current upstream owners.
4. Stage and commit the resolved result in the family order below. A file that
   carries multiple invariants belongs to the earliest family that owns its
   runtime boundary; do not duplicate or partially stage coupled functions.
5. Regenerate derived files only after source and config owners settle.
6. Move the completed integration commit chain back to `ec-main`, validate,
   and publish with `--force-with-lease` against the recorded checkpoint.

Abort rather than guess if the squash merge exposes a maintained behavior not
covered by this plan, if a conflict would require a new public config/default,
or if an upstream owner cannot express the local invariant cleanly.

## Family 1 | Profiles, OpenAI, And Codex Auth

Upstream wins for canonical SQLite auth-profile storage, provider ordering,
doctor migrations, `/login`, app-server `client-runtime.ts` / `turn-router.ts`,
request timeouts, package dependencies, manifests, model catalogs, and OpenAI
usage authentication.

Preserve only:

- thin `/profile` and `/profiles` session override/operator UX and quota policy;
- the normalized Codex wrapper boundary from `0b6fe0300302`;
- one shared token/account parser for login and auth-sensitive cache identity;
- scoped prepared auth-store authority through client startup and refresh;
- secret-free cache keys that change on token rotation and wrapper account ID;
- canonical provider/profile IDs (`openai`, `openai:<id>`), with
  `openai-codex` accepted only by doctor/migration code.

Do not restore old local refresh-stall plumbing, `client-factory.ts`,
`turnTerminalIdleTimeoutMs`, provider reauth commands, legacy provider routes,
or GPT-5.5 catalog/default snapshots. Direct sibling Codex source establishes
that `account/login/start(chatgptAuthTokens)` takes separate access-token and
account-id fields and that external refresh is client-driven with a bounded
request timeout.

## Family 2 | Slack, A2A, And Bound-Channel Delivery

Upstream wins for current Slack package/version/dependency shape, typed
presentation/approval actions, queued-draft isolation, narrated progress,
canonical delivery receipts/traces, preview/finalization seams, Enterprise
Grid behavior, and exact ambiguous-send reconciliation.

Port onto those owners:

- `sessions_send` ingress echo, strict relay delivery, nested relay guard,
  dual-channel behavior, thread-aware targeting, and bound-channel protection;
- channel-neutral permission requests and Slack approve/deny rendering;
- early acknowledgement, dedupe, active Socket lifecycle, multi-connection
  health, refresh classification, and receiver counters;
- install-record stale-derived-field clearing if upstream still lacks it.

Never resolve by taking a whole downstream Slack dispatch/provider/module.
Do not restore deleted `dispatch.streaming.test.ts`; prove the behavior through
upstream preview/finalization owners.

## Family 3 | Slack Responsiveness And Reconciliation

Preserve:

- `/turn-status`, `/turns`, `/nudge`, `/why-silent`, and `/turn-steer`;
- turn timeline, suppression/delivery attribution, deterministic watchers,
  stalled-run diagnostics, and explicit `reply_stranded` classification;
- admission-gap detection, history reconciliation, guarded recovery,
  watchdog diagnostics, and reconciliation dedupe.

Storage correction is part of this replay. Admission and reconciliation state
must move from JSON/JSONL runtime files to plugin KV/shared SQLite with one
migration owner. Update the installed watchdog reader in the same family. A
JSONL diagnostic log may remain only if it is explicitly a log artifact, not
canonical state. No dual-read, dual-write, or steady-state fallback is allowed.

The expanded `slack-responsiveness` gate is the minimum source proof. Reconcile
any upstream-renamed tests to their new owners before treating a missing path
as a behavior drop.

## Family 4 | Automation

Preserve bounded automation execution, command/status UX, progress reporting,
worker result mapping, job construction, turn accounting, and session
lifecycle. Keep command parsing/status text in automation-owned helpers. Let
upstream auto-reply/tool orchestration win unless a focused automation test
proves a missing generic seam.

## Family 5 | Voice And Media

Preserve voice-call streaming STT, telephony TTS/media-stream integration,
provider selection, buffered transcription, and shared audio autodetection.
Keep plugin-only dependencies plugin-local and current. Remove old config
compat unless a tagged public contract and doctor migration are cited.

## Family 6 | Scripts, Docs, UI, And Residuals

- preserve the branch/live-patch discipline, external-plugin patch option,
  local feature docs, plans, and focused family gate;
- move old Control UI agent-display changes to upstream
  `ui/src/lib/agents/display*` and `ui/src/pages/agents/view*` owners or retire
  them when upstream is same-or-better;
- do not restore deleted `ui/src/ui/app-render.ts`, old agent view files,
  `attempt-bootstrap-routing.ts`, or other retired owner paths;
- classify every residual changed file as maintained feature, upstream
  replacement, generated output, or obsolete repair before commit.

## Generated Output

Regenerate rather than hand-merge:

- config and plugin-SDK baseline hashes;
- bundled channel config metadata;
- schema help/labels;
- gateway protocol schemas and other generated protocol output;
- build/package artifacts required by current upstream scripts.

Protocol version bumps require explicit owner confirmation and are outside
this plan unless already required by the fixed upstream target.

## Validation Matrix

Run narrow proof while each family is resolved, using
`node scripts/run-vitest.mjs` in this checkout. After all source settles:

1. `scripts/ec-main-rebase-gate.sh --family profiles`
2. `scripts/ec-main-rebase-gate.sh --family slack-a2a`
3. `scripts/ec-main-rebase-gate.sh --family slack-responsiveness`
4. `scripts/ec-main-rebase-gate.sh --family automation`
5. `scripts/ec-main-rebase-gate.sh --family voice`
6. current Codex app-server auth/client-runtime/timeout/turn-watch tests
7. prescribed changed checks through Testbox/Crabbox
8. `pnpm build` through the permitted build lane
9. fresh autoreview until no accepted/actionable findings remain
10. `git diff --check`, generated-contract checks, and clean-worktree proof

If upstream moved a listed test, update the gate to the new owner and prove the
same invariant; never delete a gate entry merely to make the wrapper green.

## Publication And Live Proof

- verify `git merge-base --is-ancestor origin/main ec-main` succeeds;
- verify the old checkpoint remains reachable from the published backup ref;
- force-push only `fork/ec-main`, only with `--force-with-lease` against
  `197a33da957`;
- quiesce the SoyLei admission-watchdog timer and active oneshot;
- build/install a tarball with
  `scripts/patch-live-openclaw.sh --expect-branch ec-main --require-expected-branch --patch-external-plugins`;
- verify installed core SHA/version, external Slack version/dependencies,
  registry freshness, repo/installed Slack hashes, plugin doctor, service,
  bound port, RPC read probe, event-loop health, and both Slack accounts;
- run fresh Codex app-server turns on main and a SoyLei agent, recording run ID,
  provider, model, harness, exact output, fallback state, and duration without
  exposing credentials;
- inspect logs for wrapper-parse, refresh-timeout, missing-harness, missing
  dependency, socket reconnect, admission-gap, and stranded-reply failures;
- restore and verify the watchdog timer and one post-patch scan.

## Latest Codex Model Transition

After the rebased runtime proves auth on its upstream default/catalog, identify
the newest supported stable OpenAI Codex model from the installed catalog. The
audit expects `openai/gpt-5.6-sol`, but runtime/catalog proof is authoritative.
Update the global default and all explicit agent-level GPT-5.5 Codex overrides
to that canonical model. Review cron `payload.model` overrides separately;
replace only Codex-default/GPT-5.5 aliases that are intended to track the agent
default, leaving intentional non-Codex jobs unchanged. Read back all 32 agent
routes and run new-session smoke turns after the change. Do not introduce an
`openai-codex` route.

## Acceptance Criteria

- `ec-main` descends from the fixed upstream target;
- the checkpoint is published under a recovery ref;
- every downstream path is classified and obsolete repair strata are absent;
- maintained feature families pass focused gates on current upstream owners;
- Codex wrapper identity is consistent across login/cache and live auth works;
- Slack canonical state obeys SQLite policy and external plugin bytes match;
- generated outputs come from current generators;
- fresh autoreview is clean and prescribed broad proof passes;
- `fork/ec-main` is updated with an exact force-with-lease;
- installed core/gateway/Slack runtime is healthy after a plugin-aware patch;
- configured Codex agents use the latest verified canonical model;
- Plan 0016, `ROADMAP.md`, and `RUNBOOK.md` close with exact receipts.

## Definition Of Done

State is `CLOSED`, `HEAD...fork/ec-main` is `0/0`, the worktree is clean, the
backup ref is reachable, upstream ancestry is proven, source/live/model proof
is recorded, and no required work remains.
