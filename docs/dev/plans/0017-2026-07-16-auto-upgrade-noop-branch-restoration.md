State: CLOSED
Created: 2026-07-16
Closed: 2026-07-16

# Auto-Upgrade No-Op Branch Restoration

## Current State

`scripts/auto-upgrade-on-release-tag.sh` checks out its integration branch
before determining whether the target release is already integrated. The no-op
exit can therefore strand the operator on the integration branch instead of
restoring `PREV_BRANCH`.

Execution owner: dedicated subagent for Plan 0017.

## Scope

- Make every successful no-op path restore the original checkout state.
- Add a regression that proves both branch restoration and unchanged content.
- Preserve the script's existing failure recovery and dirty-tree safeguards.

## Non-Goals

- Reworking release selection, merge policy, pushing, or live patch behavior.
- Switching branches or running the real updater during plan execution.

## Work Phases

1. Trace all exits after the integration checkout and identify the canonical
   restoration helper or cleanup boundary.
2. Implement one restoration path that covers the already-integrated no-op.
3. Add focused shell-harness coverage for the no-op branch.
4. Run the focused script test and `git diff --check` for owned paths.

## Acceptance Criteria

- The no-op result leaves the caller on `PREV_BRANCH`.
- Failure behavior and dirty-tree refusal remain unchanged.
- Focused regression proof passes.

## Definition Of Done

The plan is `CLOSED`, its subagent records exact source/test changes and proof,
and no unrelated path is changed.

## Implementation

- Added `restore_previous_checkout` as the single checkout-restoration helper.
- Reused the helper from error cleanup and normal completion without changing
  their existing best-effort behavior.
- Restored `PREV_BRANCH` before the already-applied no-op exits successfully.
- Added a real temporary-repository regression that starts on `operator-work`,
  exercises the no-op updater path, and proves the branch, repository tree, and
  worktree contents are unchanged. The live checkout and updater were not used.

## Validation Receipts

- Before the fix, `bash scripts/test-auto-upgrade-gateway-identity.sh` failed as
  expected with `expected 'operator-work', got 'ec-main'`.
- After the fix, `bash scripts/test-auto-upgrade-gateway-identity.sh` passed
  with `auto-upgrade gateway identity harness passed`.
- `bash -n scripts/auto-upgrade-on-release-tag.sh scripts/test-auto-upgrade-gateway-identity.sh`
  passed.
- `git diff --check -- scripts/auto-upgrade-on-release-tag.sh scripts/test-auto-upgrade-gateway-identity.sh docs/dev/plans/0017-2026-07-16-auto-upgrade-noop-branch-restoration.md`
  passed.

## Closeout

Acceptance criteria are satisfied. The no-op path restores the caller's branch,
the regression proves repository content remains unchanged, and dirty-tree and
failure checks retain their existing control flow.
