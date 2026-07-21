# Plan 0023 Fresh-Agent Handoff

Date: 2026-07-18
Status: ready for a fresh top-level orchestrator

## Mission

Continue `docs/dev/plans/0023-2026-07-16-ec-main-recovery-integration-and-publication.md`
to a genuinely rebased, validated, published, and live-proven `ec-main`.
Preserve the full six-phase objective. Do not redefine success around merely
cleaning up the current automation diff.

The immediate task is to replace the oversized automation review loop with the
plan's fresh-context worker/gatekeeper protocol, produce accepted automation
checkpoint commits, and then continue the remaining feature-family queue.

## Authority Order

Read these before acting:

1. root `AGENTS.md` and any scoped `AGENTS.md` owning a selected unit;
2. `docs/dev/plans/0023-2026-07-16-ec-main-recovery-integration-and-publication.md`;
3. `docs/dev/policies/ec-main-integration.md`;
4. `docs/dev/policies/validation-and-handoff.md`;
5. `docs/dev/notes/0036-2026-07-16-plan0023-frozen-family-manifest.md`;
6. `docs/dev/local-feature-index.md` and
   `docs/dev/local-features/automation.md` for the active family;
7. `RUNBOOK.md` and `ROADMAP.md` for existing receipts and plan routing.

The current worktree and external state outrank every snapshot below. Re-audit
before changing the index, spawning a worker, or claiming progress.

## Verified Handoff Snapshot

Verified on 2026-07-18 without fetching:

- paused `/goal` objective: `execute plan 23`;
- branch: `rebase/ec-main-20260714`;
- `HEAD`: `d04feac3852b68a019fd79dbf88a27318c1927e2`;
- local `origin/main`: `b50822aab53e53d1010e7c298d58b45b06838920`;
- ancestry against that local ref: `0` behind, `10` ahead, with
  `origin/main` an ancestor of `HEAD`;
- local `ec-main` and `fork/ec-main`:
  `b15eabcc872f9c300e52a051fbc92c0d7db512f5`;
- frozen recovery commit:
  `refs/backup/ec-main-drift-containment-20260716-plan0023` at
  `7728b41fe9e2dea2927ce4e7037482b24e38aa4f`;
- frozen recovery tree:
  `665bcb1e8f367b5f5621136f6da11363064dfc22`;
- current staged automation-candidate tree:
  `b3920fd2b7a5d2de90d923c1757da83d23a3ba96`;
- index: 56 paths, 6,711 additions, 31 deletions;
- tracked worktree outside the index: 134 paths, 3,669 additions,
  345 deletions;
- untracked: 104 paths;
- no surviving autoreview process was found;
- the Plan 0023 plan, roadmap, runbook, and this handoff are part of the dirty
  recovery tree and may be untracked. Do not delete or overwrite them.

`origin/main` is only a local snapshot. Latest remote upstream is not proven by
this handoff.

## Startup Commands

Run these read-only checks first and compare them with the snapshot:

```bash
git status --short
git branch --show-current
git rev-parse HEAD origin/main ec-main fork/ec-main
git merge-base --is-ancestor origin/main HEAD
git rev-list --left-right --count origin/main...HEAD
git write-tree
git diff --cached --stat
git diff --stat
git show-ref | rg 'refs/backup/ec-main'
pgrep -af 'autoreview|codex.*review' || true
```

Inspect current agents/processes before starting any mutator. Do not switch
branches, stash, reset, clean, or rewrite the shared worktree. If ownership is
clear, record the current staged tree in a recoverable commit/ref before index
surgery. Verify that its tree is exactly the current `git write-tree` result.

Fetch upstream only after the local recovery snapshot is understood. Fetching
may advance `origin/main`; if it does, record the new SHA and do not mix a new
rebase into the automation packetization unit. Finish or safely checkpoint the
current integration chain, then schedule the final upstream reconciliation as
an explicit bounded unit before publication.

## First Orchestrator Assignment

The top-level agent orchestrates. It must not continue the old implementation
or autoreview conversation itself.

1. Re-audit the snapshot and preserve the current staged tree under a new
   recovery ref if no equivalent ref already exists.
2. Spawn one fresh-context, read-only packetization worker. Pass only the
   authority files above, the current staged diff, the Plan 0023 work-unit size
   gate, and this assignment:

   > Partition the current staged automation candidate into exact,
   > non-overlapping semantic work packets. Start from the six-item automation
   > seed queue in Plan 0023. For each packet, name the invariant, owner
   > boundary, exact paths, directly coupled tests, dependencies, focused proof,
   > and stop conditions. Identify paths that belong to an already committed
   > family or the later residual/generated lane. Make no edits. Do not turn
   > file-count slicing into architecture boundaries.

3. Stop that worker. Spawn a different fresh-context neutral gatekeeper in
   read-only mode. Give it the packet map, complete staged diff, plan size gate,
   and this disposition:

   > Be equally hostile to hasty unchecked work and to micro-iteration drift.
   > Check completeness, exclusivity, dependency order, owner boundaries, and
   > whether each unit can receive decisive focused proof. Consolidate all
   > material objections now. Return exactly ACCEPT, CONSOLIDATED_REWORK,
   > REFRAME_OR_SPLIT, or BLOCK. Do not edit code, request stylistic polishing,
   > or drip-feed findings across passes.

4. Permit at most one consolidated packet-map correction, followed by one
   final neutral verdict. A second correction request is a hard stop, not a new
   review loop.
5. Once packetization is accepted, clear/isolate the index only through a
   recovery-safe method that preserves worktree bytes and proves the backup
   tree. Spawn a new fresh worker for automation unit 1 only.
6. Apply the Plan 0023 review budget: one worker turn, one neutral review, at
   most one consolidated rework by a fresh worker, and one final neutral gate.
7. On `ACCEPT`, rerun the prescribed focused proof and create the checkpoint
   immediately. Update Plan 0023 or `RUNBOOK.md` with the exact receipt before
   selecting the next unit.

Only one subagent may mutate the shared checkout at a time. Read-only agents may
run concurrently only when their scopes cannot overlap mutation.

## Seed Automation Units

Plan 0023 owns the detailed contract. Its current seed order is:

1. config, registry persistence, lifecycle, and restart reconciliation;
2. worker contracts and cumulative budgets;
3. dispatch, cancellation, stop races, timeout, and wait cleanup;
4. progress, status, and terminal outcomes;
5. agent tool and portable command surfaces;
6. generated output, gateway wiring, skill, and operator docs.

Do not assume these are already valid path boundaries. The packetization worker
and neutral gatekeeper must prove them from the current diff and dependency
graph.

## Hard Stops

Stop and report instead of improvising when:

- branch, recovery refs, staged tree, or worktree ownership differs without an
  explainable receipt;
- another mutating agent or orphan review process is active;
- a proposed unit exceeds 25 production paths or 1,500 materially changed
  lines without neutral indivisibility approval;
- the final neutral gate finds another semantic defect after consolidated
  rework;
- the diff grows more than 25% without a documented dependency reason;
- the remote force-with-lease expectation changes;
- two packetizations fail neutral acceptance for the same invariant;
- safe continuation would require stash, destructive reset/clean, or discarding
  user-owned bytes.

At every pause, leave one exact next work packet or a concrete blocker. Never
leave "continue autoreview" as the next action.

## Remaining End State

Automation checkpointing is only Phase 2. The next agent must preserve the
remaining Plan 0023 objective: voice/media and residual families, integrated
generated/source proof, current-upstream reconciliation, `ec-main` publication
with exact force-with-lease, plugin-aware live patch, independent runtime proof,
and only then the installed-catalog-proven Codex model transition.

## Suggested Skills

- `openclaw-ec-main-rebase-live-patch` for branch, publication, and live-patch
  contracts;
- `codegraph-workspace` for structural packet boundaries and dependency impact;
- `openclaw-testing` for focused versus remote proof selection;
- `autoreview` only as bounded evidence inside the neutral-gate contract;
- `crabbox` when Plan 0023 reaches heavy integrated, packaging, or live proof.

## Closeout Format For Each Unit

Record:

- work packet and invariant;
- starting and ending SHA/tree;
- exact paths;
- worker identity/context freshness;
- focused commands and results;
- neutral verdict and iteration count;
- checkpoint commit;
- residual worktree ownership;
- one explicit next packet or blocker.
