State: CLOSED
Created: 2026-07-14

# ec-main Pre-Rebase Preparation

## Closeout

Completed on 2026-07-14 at `0b6fe030030` and published to `fork/ec-main`.
Fresh autoreview found no accepted or actionable findings. The tarball live
patch built successfully, installed `2026.6.10 (0b6fe03)`, refreshed the
gateway service, and passed its RPC read probe. A deliberate Codex app-server
turn (`76bd4139-e845-427f-a866-e89c2acc6d18`) returned the exact requested
text in 14,132 ms on `openai/gpt-5.5` with the Codex harness and no fallback.
Both Slack accounts then probed HTTP 200, connected with zero reconnects, and
reported healthy Socket Mode state; SoyLei reconciliation reported zero
missing/failed candidates and one recovered candidate. The admission-watchdog
timer was restored after patching and started a fresh scan at 22:46:57 CDT.

Plan 0016 now owns the upstream replay, post-rebase external-plugin patch,
latest Codex model transition, and final runtime proof.

## Current State

The requested `ec-mail` branch does not exist locally or on the configured
remotes. Repo policy identifies `ec-main` as the deployable downstream branch,
so this plan treats `ec-mail` as a reference to `ec-main`.

The recoverable pre-fetch checkpoint is complete:

- `ec-main` and `fork/ec-main` are both `1255acf401`.
- the worktree is clean.
- `1255acf401` carries the reviewed xAI tool-catalog compaction fix.
- focused proof passed for local-model defaults, Tool Search catalogs, the
  embedded attempt path, and Copilot BYOK; fresh autoreview reported no
  accepted or actionable findings.

The 2026-07-14 fetch moved `origin/main` to `b50822aab53`. The merge base is
`7bbd09047bd`, with 6,139 upstream-only commits and 339 downstream-only
commits. Patch-id analysis found no exact downstream duplicates in upstream.
Endpoint merge analysis found 499 conflict-marker hunks across 165 unique
files; this is a conflict-shape lower bound, not a per-commit rebase result.

The most important live baseline facts are:

- core and gateway are healthy at `2026.6.10 (502a5fe)` with deep RPC passing;
- recent Codex app-server turns completed, but a deliberate fresh turn is still
  required because provider-filtered model probes returned no targets;
- current OpenClaw routes all 32 configured agents through `openai/gpt-5.5`
  with the Codex runtime;
- Slack accounts are connected and healthy;
- Slack registry metadata reports `2026.5.22`, but installed Slack `dist`
  bytes and key hashes match the current `ec-main` checkout, so a pre-rebase
  reinstall would add risk without changing executable code;
- the post-rebase patch must update core, Slack package bytes, dependencies,
  and registry metadata together.

## Scope

- make the pre-rebase checkpoint durable and published;
- record fresh ancestry, conflict, Codex, Slack, and runtime evidence;
- harden the current Codex app-server auth wrapper boundary before replay;
- preserve upstream Codex prepared-auth/scoped-store direction rather than
  reviving older app-server code;
- establish focused source and live baselines for Codex auth and Slack health;
- repair stale rebase planning indexes and close superseded Plan 0012;
- leave a clean, pushed `ec-main` checkpoint from which Plan 0016 can execute
  the upstream replay.

## Non-Goals

- do not start the full upstream rebase in this plan;
- do not blindly cherry-pick `fix/codex-app-server-auth-unwrap` or old Codex
  auth-probe commits built on retired runner paths;
- do not reinstall Slack before the rebase when installed bytes already match;
- do not mechanically squash 339 commits without a feature-family replay map;
- do not hand-merge generated baselines before source contracts settle;
- do not preserve obsolete repair commits merely to retain historical shape.

## Authoritative Inputs

- `docs/dev/policies/ec-main-integration.md`
- `docs/dev/policies/architecture-and-plugin-survivability.md`
- `docs/dev/policies/validation-and-handoff.md`
- `docs/dev/local-feature-index.md`
- `docs/dev/memories/0002-2026-05-16-codex-auth-and-slack-plugin-repair.md`
- `docs/dev/notes/0034-2026-05-22-codex-oauth-wrapper-and-refresh-stall.md`
- OpenClaw source at `1255acf401` and `origin/main` at `b50822aab53`
- sibling Codex source at `bdd282f3bb`
- installed gateway, plugin registry, plugin bytes, channel probes, and logs

## Phase 1 | Checkpoint And Fetch

State: COMPLETE

- review and validate inherited worktree changes;
- commit them as one coherent agent-runtime change;
- push `fork/ec-main` and verify `HEAD...fork/ec-main = 0/0`;
- fetch all remotes with pruning;
- record exact head, target, merge base, and divergence.

## Phase 2 | Pre-Rebase Audit

State: COMPLETE

- classify all downstream commits by feature family and ownership boundary;
- compute overlap and conflict-shape evidence;
- inspect current upstream renames and retired paths;
- audit Codex app-server auth against sibling Codex protocol/runtime source;
- audit Slack receive/send/reconciliation/watchdog behavior as one reliability
  surface;
- compare installed Slack bytes separately from stale registry metadata.

## Phase 3 | Codex Auth Preservation Update

State: COMPLETE

- replace the current partial JSON wrapper parser with one shared parser that
  accepts the provider wrapper shapes already observed at the plugin boundary;
- use the same normalized token and account identity for app-server login and
  auth-sensitive cache keys;
- cover token and OAuth profiles, snake-case and nested wrapper shapes, and
  account-id-sensitive cache identity;
- retain raw-token behavior and malformed-wrapper fallback;
- inspect sibling Codex `account/login/start`, `account/read`, and external
  auth refresh contracts before verdict;
- do not restore the retired local auth-refresh-stall implementation when
  upstream now owns the timeout/runtime path.

## Phase 4 | Slack And Planning Preparation

State: COMPLETE

- record that current installed Slack bytes match the branch despite stale
  registry metadata;
- preserve turn tracking, why-silent/turn-steer, A2A approval/relay,
  admission-ledger/history reconciliation, Socket lifecycle, and stranded-reply
  invariants in the Plan 0016 replay map;
- expand the centralized Slack responsiveness gate beyond its current three
  tests so delivery, preview/streaming, socket lifecycle, admission,
  reconciliation, watchdog, account-snapshot, and gateway-health behavior is
  represented before replay;
- treat the admission ledger and reconciliation JSON/JSONL stores as explicit
  policy debt: Plan 0016 must migrate runtime state to plugin KV/shared SQLite
  under one migration owner, or retain the debt only with explicit owner
  approval; the installed watchdog reader must move with that state owner;
- quiesce the nearly continuous two-minute SoyLei watchdog around live patching,
  then restore and verify its timer and latest run;
- take upstream Slack package/version/dependency shape while reapplying only
  local external-plugin/build flags and proven downstream invariants;
- close superseded Plan 0012 with its June 27 completion evidence;
- repair `ROADMAP.md` states that lag their closed plans;
- append this preparation slice to `RUNBOOK.md`.

## Phase 5 | Pre-Rebase Validation And Publication

State: COMPLETE

Completed source proof:

- Codex auth bridge, shared-client, and config: 195 tests passed;
- expanded Slack responsiveness gate: 25 files across five prescribed Vitest
  shards, 811 tests passed;
- `scripts/ec-main-rebase-gate.sh --family slack-responsiveness --list` and
  `bash -n scripts/ec-main-rebase-gate.sh` passed;
- `pnpm docs:list` and `git diff --check` passed.

- run focused Codex auth-bridge/shared-client/config tests;
- run the Slack account, interaction, receiver, reconciliation, watchdog, and
  channel-probe baselines selected by the audit;
- run `git diff --check`, exact-file formatting, and any generated-contract
  checks touched by preparation;
- run fresh autoreview until no accepted/actionable finding remains;
- commit and push the clean pre-rebase checkpoint;
- run a deliberate current-branch Codex app-server turn with a unique session
  key and verify exact output without exposing credentials;
- recheck Slack probe health and gateway deep RPC after the turn.

## Acceptance Criteria

- branch/fork checkpoint and fresh upstream coordinates are recorded exactly;
- Codex auth wrapper parsing and cache identity share one tested normalization
  boundary;
- sibling Codex protocol/runtime behavior has been inspected directly;
- Slack executable bytes are distinguished from registry metadata and no
  unnecessary pre-rebase reinstall occurs;
- focused Codex and Slack baselines pass or retain exact actionable failures;
- a fresh Codex app-server turn proves current authentication before rebase;
- planning indexes reflect closed historical work and the active preparation;
- `ec-main` is clean, committed, and pushed before Plan 0016 begins.

## Definition Of Done

- all phases are `COMPLETE`;
- this plan is `CLOSED` with exact commit and validation receipts;
- `HEAD...fork/ec-main` is `0/0`;
- Plan 0016 exists with a feature-family replay order, conflict ownership map,
  test matrix, force-with-lease publication step, plugin-aware live patch, and
  post-rebase Codex/Slack runtime proof.
