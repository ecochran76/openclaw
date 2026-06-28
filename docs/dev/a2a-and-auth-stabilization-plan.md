# A2A and Auth Stabilization Plan

Status: proposed (execution-ready)
Owner: dev-openclaw
Branch baseline: `ec-main`

## Why this plan exists

The recent `sessions_send` / A2A work materially improved the feature:

- ingress echo exists
- nested `sessions_send` relay is guarded by default
- dual-channel relay exists
- relay verbosity exists
- announce duplication in dual-channel mode was reduced

But two related problems remain before adding more feature surface:

1. **A2A delivery semantics still need stabilization**
   - the config and docs exposed strict-ish relay controls before runtime behavior fully matched
   - sync vs async behavior is still uneven
   - test coverage is better than before, but still concentrated in tool-level tests

2. **OAuth profile propagation still drifts across agents**
   - one agent can refresh a shared profile while sibling agents keep stale refresh tokens
   - this can surface as `refresh_token_reused` failures
   - local/manual sync mitigations worked operationally, but the fix still needs to land as first-class product behavior

These are not separate problems in practice. Both are really about the same thing:

- **delivery / state propagation must match the user-visible contract**
- **runtime behavior must match docs/config claims**
- **cross-agent behavior must be deterministic, not best-effort folklore**

The recommendation is therefore:

- **do not add new A2A features yet**
- finish the current A2A control surface
- finish the OAuth/profile propagation follow-up from the project ledger
- only then resume new feature work

---

## Related docs and notes

A2A design/planning docs already in-tree:

- `docs/dev/a2a-ingress-echo-implementation-plan.md`
- `docs/dev/a2a-dual-channel-relay-plan.md`
- `docs/dev/a2a-relay-delivery-contract-plan.md`

Auth/profile planning docs already in-tree:

- `docs/dev/multi-profile-auth-plan.md`
- `docs/dev/profile-first-class-auth-implementation-plan.md`
- `docs/dev/codex-status-profile-quota-plan.md`

Relevant project ledger note:

- `~/.openclaw/notes/dev-projects/openclaw.md`
  - 2026-03-10: OAuth profile propagation follow-up for profile-support branch

This document is the **execution-order plan** that ties those together.

---

## Current state summary

## A2A (`sessions_send`)

Implemented or partially implemented:

- ingress echo
- nested relay guard
- dual-channel relay
- relay verbosity
- local WIP for structured relay result metadata
- local WIP for strict `relay.requireDelivery` enforcement
- local WIP tests for:
  - strict target-only relay failure
  - dual-channel partial relay success

Still weak / incomplete:

- strict relay semantics are not fully landed and validated end-to-end
- async (`timeoutSeconds=0`) strictness semantics are weaker than sync mode
- per-turn relay observability is still summarized heavily
- docs/config/help need verification against runtime behavior after the latest changes
- gateway/e2e coverage should be stronger before adding more knobs

## OAuth / auth profiles

Observed operational failure mode:

- `openai-codex:work` refreshes in one agent store
- sibling agents keep stale refresh tokens
- later refresh attempts fail with `refresh_token_reused`

Desired behavior already captured in the ledger:

- `main` should be treated as the canonical shared OAuth store for long-lived profiles
- retire the explicit profile sync helper in favor of upstream-owned auth profile storage and
  rotation surfaces
- consider promoting fresher credentials into `main` automatically after a successful non-main refresh
- keep writes profile-scoped and avoid clobbering unrelated auth metadata
- add regression coverage

Local WIP already started in this area:

- canonical-main auth-store path helpers
- retired profile-scoped sync helper implementation
- retired CLI scaffolding for `models auth sync`
- refresh-promotion logic from non-main -> canonical main
- read/write refactors to avoid mutating merged runtime views directly

Still incomplete:

- `writeOAuthCredentials(...)` option typing still needs to absorb `profileId`
- the auth/profile slice is not yet fully compile-clean
- targeted tests for stale-refresh drift are not yet in place
- the WIP needs to be turned into a small, reviewable commit stack

---

## Decision / scope gate

Before adding new A2A features, complete these in order:

1. **Land A2A relay delivery-contract stabilization**
2. **Land OAuth profile propagation / canonical-main sync behavior**
3. **Run targeted tests + compile validation**
4. **Patch/live-install only from a clean `ec-main` state**

New A2A features should wait until these are done.

---

## Definition of success

This plan is complete when all are true:

1. `session.agentToAgent.relay.requireDelivery` has real runtime effect in sync paths.
2. `sessions_send` returns structured relay result metadata that explains success / partial / blocked outcomes.
3. Async A2A behavior is documented clearly and no longer implies stronger guarantees than it provides.
4. `main` is treated as the canonical shared OAuth store for long-lived profiles.
5. There is a first-class profile sync command/helper for copying one profile to selected or all agent stores.
6. Successful non-main OAuth refreshes can promote fresher credentials into `main` without clobbering unrelated auth state.
7. Profile writes remain **profile-scoped** and preserve order / usage stats / unrelated entries.
8. Tests exist for both A2A strictness and multi-agent auth drift regression paths.
9. Docs / schema help / runtime behavior match.

---

## Workstream A — Finish A2A relay delivery contract

This is the first stabilization slice because it completes an already-exposed feature surface.

### A1. Finish the local WIP and make it compile-clean

**Primary files**

- `src/agents/tools/sessions-send-tool.ts`
- `src/agents/tools/sessions-send-tool.a2a.ts`
- `src/agents/openclaw-tools.sessions.test.ts`

**Current WIP direction (good)**

- structured `relay` result object
- per-target statuses
- strict blocking behavior for required relay failure
- `partial` handling for best-effort dual-channel failure cases

**Required cleanup**

- ensure status values are internally consistent (`disabled`, `not_applicable`, `sent`, `partial`, `failed`, `blocked`, `pending`)
- verify sync result handling only blocks when it should
- make sure async path returns a coherent default relay state without pretending success too early
- keep announce semantics separate from relay semantics

**Acceptance criteria**

- targeted tests pass
- sync path returns structured relay metadata
- strict sync failure produces machine-readable failure result
- no change to default behavior when relay is disabled

### A2. Tighten async (`timeoutSeconds=0`) contract

**Problem**

Sync mode can know more than async mode. That is fine. What is not fine is pretending both have the same delivery guarantees.

**Changes**

- explicitly define what `relay.status="pending"` means in fire-and-forget mode
- ensure docs/help do not imply strict background enforcement that cannot be surfaced back to the original caller result
- prefer logging + runtime event visibility over fake certainty

**Acceptance criteria**

- async tool result is honest about what is known at return time
- docs describe the difference between sync and async delivery guarantees

### A3. Improve relay observability without bloating normal output

**Changes**

- keep top-level summary concise
- include per-target detail in tool results
- consider adding optional internal debug detail for per-turn relay attempts when `mirrorTurns=all`

**Not required in normal output**

- full transcript duplication
- raw gateway payload dumps

**Acceptance criteria**

- normal results are readable
- debugging partial failures is practical

### A4. Expand tests beyond the current happy path

**Add / strengthen tests for**

1. relay disabled
2. target-only strict success
3. target-only strict failure
4. dual-channel best-effort partial success
5. dual-channel best-effort full failure
6. dual-channel strict failure
7. async accepted path with relay enabled
8. label-based target resolution with relay enabled
9. thread-aware delivery resolution where relevant
10. backward compatibility with ingress echo + nested relay guard

**Suggested files**

- `src/agents/openclaw-tools.sessions.test.ts`
- gateway/e2e coverage where practical

### A5. Reconcile docs and config help

**Files**

- `docs/dev/a2a-relay-delivery-contract-plan.md`
- user-facing session-tool docs / config reference
- schema help / labels if wording drifted

**Goal**

Make sure strictness, best-effort behavior, and result statuses described in docs match runtime exactly.

---

## Workstream B — Finish OAuth profile propagation / canonical-main behavior

This is the second stabilization slice and directly addresses the 2026-03-10 ledger note.

### B1. Fix the current compile mismatch in auth login flow

**Known issue**

`src/commands/models/auth.ts` passes `profileId` into `writeOAuthCredentials(...)`, but the option type still does not expose that field.

**Primary files**

- `src/commands/onboard-auth.credentials.ts`
- `src/commands/models/auth.ts`

**Changes**

- add `profileId?: string` to `WriteOAuthCredentialsOptions`
- ensure the write path honors an explicit profile ID override rather than deriving only from email/default
- preserve existing `syncSiblingAgents` behavior where still intended

**Acceptance criteria**

- compile error is gone
- explicit `openai-codex:work` login path remains supported

### B2. Land canonical-main path helpers as explicit product behavior

**Primary files**

- `src/agents/auth-profiles/paths.ts`
- `src/agents/auth-profiles/store.ts`
- `src/agents/auth-profiles.ts`

**Goal**

Stop relying on implicit “main = whatever current env resolves to” behavior in code paths that are supposed to target the canonical shared store.

**Changes**

- keep explicit helpers like:
  - canonical agent dir resolution
  - canonical main agent dir resolution
  - canonical main auth store path resolution
- use them only where shared-store semantics are intended
- do not silently change unrelated per-agent override semantics

**Acceptance criteria**

- reads/writes targeting shared-main behavior are explicit in code
- tests prove canonical-main resolution works regardless of current agent env

### B3. Add a first-class profile sync helper / command

Retired by `docs/dev/plans/0014-2026-06-28-profile-support-retirement.md`: `ec-main`
no longer carries the local `openclaw models auth sync` command. Future work in this
area should use upstream auth profile storage/rotation surfaces or a separately justified
operator UX, not revive the deleted CLI command.

**Primary files**

- `src/agents/auth-profiles/profiles.ts`
- `src/cli/models-cli.ts`

**Retired rules**

- copy only the selected profile
- do not overwrite unrelated profiles
- do not clobber per-agent order overrides
- do not drop usage stats / lastGood / other unrelated top-level data
- prefer locked file updates

**Acceptance criteria**

- sync works for one target, many targets, and `all`
- source/target identity is explicit in result output
- failures are reported per target rather than silently swallowed

### B4. Promote fresher non-main OAuth refreshes back into `main`

**Primary files**

- `src/agents/auth-profiles/oauth.ts`
- `src/agents/auth-profiles/store.ts`
- `src/agents/auth-profiles/profiles.ts`

**Goal**

When a long-lived shared profile is refreshed successfully in a non-main agent, promote the fresher credential into canonical `main` so sibling agents do not keep stale refresh tokens.

**Rules**

- promotion should be profile-scoped
- promotion should not overwrite unrelated store state
- promotion should happen only after a successful refresh
- promotion should not create recursive/ambiguous “who is canonical?” behavior

**Acceptance criteria**

- refreshed profile in non-main can be copied into canonical `main`
- sibling agents can subsequently sync from canonical `main`
- no unrelated auth metadata is lost

### B5. Keep local read/write semantics safe

**Problem**

Runtime code often reads merged auth views (main + agent). That is useful for resolution but dangerous for writes.

**Changes**

- keep explicit separation between:
  - merged runtime read view
  - raw per-agent file view
- ensure write/update helpers use the raw file view when they are supposed to modify one concrete store
- preserve lock discipline

**Acceptance criteria**

- no code path writes a merged view back as if it were a single raw store unless that is explicitly intended
- order / usage stats / lastGood survive profile updates

### B6. Add regression tests for stale-refresh drift

**Test cases**

1. main has fresher profile; worker adopts it
2. worker refreshes successfully; canonical main gets promoted copy
3. sync command copies one profile to selected agents only
4. stale worker tokens no longer keep failing after canonical sync
5. no unrelated profile/order metadata is lost during sync/promotion
6. `refresh_token_reused` regression is covered by a deterministic test harness where possible

**Suggested files**

- auth-profiles oauth tests
- onboard-auth tests
- retired auth-sync command tests

---

## Workstream C — Integration discipline / branch hygiene

These bugs got worse because code, docs, and live installs drifted across branches.

### C1. Treat `ec-main` as the integration truth

**Rules**

- branch feature work from `ec-main`
- keep slices small and topic-scoped
- merge/cherry-pick must-keep behavior into `ec-main` before live patching
- do not depend on feature-only behavior living outside `ec-main`

### C2. Keep the commit stack reviewable

Recommended commit stack:

1. **A2A runtime enforcement/types**
2. **A2A tests**
3. **A2A docs/help parity**
4. **Auth write-option typing + canonical path cleanup**
5. **Auth profile sync helper + CLI**
6. **OAuth refresh-promotion behavior**
7. **Auth regression tests**
8. **Optional final docs note**

### C3. Avoid live patching from a dirty tree

Before any install/patch:

- review `git status`
- separate A2A and auth commits from unrelated A2A experiments or local package artifacts
- avoid patching from a tree with unrelated modified files

---

## Workstream D — Validation and rollout

### D1. Targeted validation before any live patch

Run targeted tests first, not just full repo compile.

**A2A**

- `src/agents/openclaw-tools.sessions.test.ts`
- any gateway/e2e tests relevant to `sessions_send`

**Auth/profile**

- `src/commands/models/auth.test.ts`
- `src/commands/onboard-auth.test.ts`
- auth-profiles oauth fallback / drift tests
- retired auth-sync command tests

### D2. Full compile as a sanity gate

Use full compile only after targeted tests pass, while remembering the repo may have unrelated standing type issues.

### D3. Live patch sequencing

Only after:

1. code is committed cleanly on `ec-main`
2. targeted tests pass
3. docs are in sync
4. runtime/install target is understood

Suggested live order:

1. install/patch runtime from clean `ec-main`
2. validate `/profile` and `/profiles`
3. validate `openai-codex:work` auth path
4. validate one non-main refresh / canonical-main sync path
5. validate `sessions_send` strict and best-effort behavior in the relevant Slack channels

---

## Priority order (recommended)

### Phase 1 — A2A stabilization

Do this first.

Deliverables:

- relay result contract finalized
- strict sync relay failure enforced
- docs/help aligned
- tests green for the current A2A surface

### Phase 2 — Auth/profile propagation

Do this second.

Deliverables:

- compile-clean profile-id write path
- explicit profile sync command/helper
- non-main refresh promotion into canonical main
- regression tests for multi-agent stale-refresh drift

### Phase 3 — Integration + live validation

Do this third.

Deliverables:

- clean `ec-main`
- targeted validations complete
- live patch from clean state
- smoke tests in the real Slack-linked agent channels

### Phase 4 — Only then consider new features

Possible future work after stabilization:

- richer A2A per-turn visibility for `mirrorTurns=all`
- stronger background event surfacing for async strict relay failures
- broader first-class auth-profile UX polish

But not before the first three phases are done.

---

## Open questions to resolve during implementation

1. In async A2A mode, do we want structured runtime events for strict relay failures observed after the tool already returned `accepted`?
   - Recommended: yes, later; not required for the first landing.

2. Should profile sync default source always be canonical `main`, or should the CLI force `--from-agent` for non-main sources?
   - Recommended: default to `main`, allow explicit override.

3. Should successful non-main refresh promotion always update `main`, or only for providers/profile IDs marked shared?
   - Recommended first pass: promote for explicitly selected/shared long-lived profiles already used this way; avoid over-generalizing if test coverage is weak.

4. Do we want a user-facing status command to show profile divergence across agents?
   - Nice follow-up, not required for the first fix.

---

## Short recommendation

Before new A2A features, finish these two stabilization slices in order:

1. **complete and land the A2A relay delivery contract**
2. **complete and land OAuth profile propagation with canonical-main sync behavior**

That is the cleanest way to turn the current useful-but-wobbly behavior into something trustworthy enough to build on.
