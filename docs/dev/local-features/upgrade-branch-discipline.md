# Local Feature — Upgrade / Branch Discipline

## Summary

This is the operational discipline that keeps local OpenClaw improvements deployable while upstream keeps moving.

It is less a user-facing feature than a repo-local survival system.

## Core rules

- `ec-main` is the **only deployable integration branch**.
- unattended upgrades and live patch automation must target `ec-main` only.
- long-lived feature branches are maintenance branches, not release blockers.
- once a deployable slice is on `ec-main`, do not keep treating the feature branch as the canonical copy.
- cherry-pick deployable slices early instead of stacking unrelated work together for days.
- the maintained local compatibility layer currently includes at least:
  - profiles / auth / OAuth
  - Slack / A2A
  - Slack / agent responsiveness
  - automation

## Why it exists

We hit two expensive failures:

1. unattended upgrade automation was blocked by stale feature-branch rebases
2. a branch that looked “rebased” still was not actually on the intended release-tag lineage

Both failures were process/documentation failures as much as code failures.

## Operational guidance

### For unattended upgrades

- default to `--no-feature-sync`
- keep the cron path focused on deployable `ec-main`
- treat feature-branch maintenance as explicit/manual work

### For rebases

- verify ancestry with `git rev-list --left-right --count <tag>...ec-main`
- do not trust a merely conflict-free replay if the graph still diverges the wrong way
- confirm local `ec-main` tracks `fork/ec-main`, not `fork/main`
- resolve large rebases in feature order when the remaining queue is clearly clustered

### For feature branches

- keep them single-purpose
- rebase onto `ec-main`
- document conflict hotspots
- upstream or cherry-pick stable slices quickly

## Runbook — finishing a large `ec-main` rebase

When `ec-main` is already mid-rebase and the queue contains coherent feature slices, finish it in this order:

1. **Profiles / auth / OAuth**
   - preserve the maintained local auth/profile layer already present on `ec-main`
   - prefer merges that keep profile-aware selection, sync, and status semantics coherent
2. **Slack / A2A**
   - preserve routing, targeting, and relay semantics as a coherent local layer
3. **Slack / agent responsiveness**
   - treat tracked-turn, delivery attribution, nudges, steering, and inspection as one feature series
   - avoid partially adopting later turn-tracker behavior without the tests/status surface that explain it
4. **Automation**
   - land bounded automation tool/runtime changes after tracked-turn semantics have settled
   - then wire in automation commands/status and run focused validation

## Validation / operator checklist

Before saying an upgrade path is fixed:

1. confirm `ec-main` ancestry vs the target tag
2. confirm local upstream tracking is correct
3. run focused validation for the repaired hotspot areas:
   - profiles / auth / OAuth
   - Slack / A2A
   - Slack responsiveness
   - automation
4. push repaired `ec-main`
5. rerun the real upgrade wrapper
6. distinguish branch-plumbing failures from build/test/install failures

## Related docs

- `docs/dev/rebase-friendly-branching-playbook.md`
- `docs/dev/local-feature-index.md`

## User-visible failure symptoms when discipline slips

- unattended upgrades fail on irrelevant feature-branch conflicts
- live installs lose local behavior that only existed on a feature branch
- repeated rebase conflicts in the same hotspots
- branch status references the wrong upstream tracking target
