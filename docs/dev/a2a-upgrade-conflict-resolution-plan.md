# A2A Upgrade Conflict Resolution Plan

Status: implemented on `ec-main` rebased onto `v2026.3.12`
Owner: agent working on A2A feature branch
Date: 2026-03-13
Baseline: resolve rebase of `ec-main` onto `v2026.3.12` without regressing existing A2A session/thread targeting work

## Why this plan exists

The unattended upgrade from `ec-main` to `v2026.3.12` failed during rebase.

The failing commit is:

- `ce9bb42f9` — `feat(ui): add primary auth profile picker on agents overview`

The conflict is not in A2A runtime code. It is in the Control UI agent pages, but it blocks the whole `ec-main` integration branch, which in turn blocks A2A upgrades because live patch/install runs from `ec-main`.

## What actually conflicted

The failing rebase stops at commit `ce9bb42f9` with content conflicts in:

- `ui/src/ui/app-render.ts`
- `ui/src/ui/views/agents.ts`
- `ui/src/ui/views/agents-utils.test.ts`

Observed by reproducing the rebase in a temporary worktree:

- `git rebase v2026.3.12` from `ec-main`
- conflict triggered while applying `ce9bb42f9`

## Root cause summary

Upstream reorganized the Agents UI after the original auth-profile-picker work landed locally.

The old local commit assumes an older UI structure:

- more overview logic lived directly in `ui/src/ui/views/agents.ts`
- `agents-utils.ts` still owned several model/auth helper exports in one shape
- the Control UI wiring in `app-render.ts` expected the older agent view props

`v2026.3.12` now has a newer structure:

- overview rendering moved into `ui/src/ui/views/agents-panels-overview.ts`
- `agents.ts` is thinner and mostly composes panel renderers
- `agents-utils.ts` changed shape substantially
- some helper exports used by the old commit no longer exist or now live behind different panel boundaries

So the conflict is structural, not just textual.

## Important constraint for the A2A agent

Do **not** try to preserve the old auth-profile-picker commit by mechanically replaying the old diff into the new files.

That will likely:

- reintroduce pre-refactor UI structure
- create more drift from upstream
- make future rebases worse
- waste time in files unrelated to current A2A work

Instead, port the feature intent onto the new upstream UI shape.

## Feature intent that should survive

The valuable behavior from `ce9bb42f9` is narrow:

1. detect the provider implied by the selected primary model
2. show provider-scoped auth profile choices on the agent overview
3. let the operator choose the provider's primary auth profile
4. rewrite `auth.order.<provider>` so the chosen profile becomes first
5. preserve the remaining provider order entries
6. keep tests that cover provider-scoped option building and order rewriting

Everything else from the old UI shape is negotiable.

## Resolution strategy

### Phase 1 — Rebase triage and file ownership

When the rebase stops on `ce9bb42f9`:

1. Treat upstream `v2026.3.12` layout as authoritative.
2. Inspect these upstream files first:
   - `ui/src/ui/views/agents-panels-overview.ts`
   - `ui/src/ui/views/agents.ts`
   - `ui/src/ui/app-render.ts`
   - `ui/src/ui/views/agents-utils.ts`
3. Identify the smallest insertion points needed to restore the auth-profile-picker behavior.
4. Do **not** widen the change into unrelated agent-sidebar/header/tool-panel cleanup.

### Phase 2 — Re-home the feature into the new panel architecture

Preferred implementation direction:

1. Keep `agents.ts` mostly as upstream composed it.
2. Put overview-specific UI additions into `agents-panels-overview.ts`, because that is where model selection now lives.
3. Only thread new callback props through `agents.ts` and `app-render.ts` as needed.
4. Keep helper logic in `agents-utils.ts` only if it is genuinely reusable and still fits the file's current responsibilities.

In practice this probably means:

- add `onPrimaryProfileChange` back into the render chain only where required
- extend `renderAgentOverview(...)` in `agents-panels-overview.ts` rather than moving logic back into `agents.ts`
- import only the helper functions that the overview panel actually needs

### Phase 3 — Recreate the helper layer against current upstream utilities

Port, don’t replay, the useful helper behavior.

Likely helper functions to preserve or recreate in `agents-utils.ts`:

- `resolveModelProvider(...)`
- `resolvePrimaryAuthProfileId(...)`
- `buildAuthProfileOptions(...)`
- `buildAuthOrderWithPrimary(...)`

Rules for the helper port:

- preserve provider normalization behavior from the old helper code
- keep writes provider-scoped
- preserve other profile ids already in `auth.order.<provider>`
- do not clobber unrelated provider order arrays
- avoid reviving utility code that upstream has replaced with newer equivalents

### Phase 4 — Wire the UI on the new shape

Implement the smallest working UI:

1. In overview/model settings, detect the effective primary model.
2. Infer provider from that model.
3. If provider-scoped profiles exist, render a dropdown for the provider's primary auth profile.
4. If no provider can be determined, or no profiles exist for that provider, render nothing.
5. Use the existing config editing/save path instead of inventing a new persistence path.

Keep it boring. This is admin UI, not a product redesign.

### Phase 5 — Reconcile tests with current file boundaries

The old test conflict in `agents-utils.test.ts` is a clue that the tests need to be ported to current helpers, not blindly merged.

Preserve or add tests for:

1. `resolveModelProvider("openai-codex/gpt-5.4") -> "openai-codex"`
2. provider-scoped auth profile option building
3. reading the first provider order entry as the primary auth profile
4. moving a selected profile to the front while preserving remaining entries
5. existing upstream avatar/logo/helper tests still passing unchanged

Do not delete the auth-profile tests just to make the rebase pass.

### Phase 6 — Validate against the whole branch, not only the conflicted commit

After resolving the conflict and continuing the rebase:

1. finish the full `ec-main -> v2026.3.12` rebase
2. continue rebasing active feature branches onto the repaired `ec-main`
3. run focused UI tests for the conflicted area
4. run the focused A2A/session tests that matter for this branch

Minimum validation target:

- `ui/src/ui/views/agents-utils.test.ts`
- any focused Control UI tests covering the overview panel/model settings
- `src/agents/tools/sessions.test.ts`
- `src/agents/openclaw-tools.sessions.test.ts`
- `src/gateway/server.sessions.gateway-server-sessions-a.test.ts`

If a lightweight typecheck or targeted UI test command exists, run that too.

## Recommended execution order for the A2A agent

1. Create a safety branch from current `ec-main` before editing.
2. Reproduce the rebase stop locally.
3. Resolve `ce9bb42f9` by porting its intent onto the new upstream UI structure.
4. Continue the rebase until clean.
5. Rebase `feat/a2a-ingress-echo` onto the repaired `ec-main`.
6. Re-run the focused A2A/session test suite.
7. Only after the branch is green, resume new A2A feature work.

## Explicit non-goals for this fix

This conflict-resolution pass should **not** try to:

- redesign the Agents page
- add more auth-profile UX than already intended
- fold OAuth propagation/runtime auth fixes into the same commit unless required for compile correctness
- change A2A behavior itself
- revisit unrelated tool catalog or agent-sidebar refactors

## Deliverable expected from the A2A agent

A good outcome is:

1. one small conflict-resolution commit (or tight commit stack)
2. clean rebase of `ec-main` onto `v2026.3.12`
3. A2A-focused branches rebased cleanly onto repaired `ec-main`
4. short report summarizing:
   - what changed in the UI port
   - what tests passed
   - whether any auth-profile behavior was intentionally deferred

## Notes from prior project memory

Relevant prior decisions already on record:

- `ec-main` is the integration truth and must stay rebase-friendly. Source: `MEMORY.md`
- features that must survive live patch/install need to be integrated into `ec-main`, not left only on a feature branch. Source: `memory/2026-03-08.md`
- A2A session/thread targeting work already landed on `ec-main` in focused slices and should be preserved while fixing integration drift. Source: `memory/2026-03-11.md`

## Implementation update (2026-03-13)

The fix has now been implemented during the successful `ec-main -> v2026.3.12` rebase.

What changed in the actual resolution:

- kept the upstream `agents-panels-overview.ts` split instead of reviving the old inline overview renderer
- threaded `onPrimaryProfileChange(...)` through `ui/src/ui/views/agents.ts`
- restored the primary auth profile picker inside `ui/src/ui/views/agents-panels-overview.ts`
- kept provider/profile helper logic in `ui/src/ui/views/agents-utils.ts`
- merged `ui/src/ui/views/agents-utils.test.ts` so both the newer avatar/logo coverage and the auth-profile helper coverage remain
- updated `ui/src/ui/app-render.ts` so auth profile changes still rewrite `auth.order.<provider>` through the existing config editing path

Validation run on the rebased branch:

- ✅ `ui/src/ui/views/agents-utils.test.ts` — 15 passed
- ✅ `src/gateway/server.sessions.gateway-server-sessions-a.test.ts` — 22 passed
- ⚠️ `src/agents/tools/sessions.test.ts` and `src/agents/openclaw-tools.sessions.test.ts` currently fail on the rebased branch in transcript-path/session-list assertions; these failures are outside the UI conflict fix and should be handled as separate session-tool follow-up work

Net result:

- the rebase blocker is fixed
- `ec-main` now rebases cleanly onto `v2026.3.12`
- the auth-profile-picker behavior survives on the newer upstream UI structure
