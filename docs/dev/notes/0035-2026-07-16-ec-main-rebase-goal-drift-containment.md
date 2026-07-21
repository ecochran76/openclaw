# ec-main Rebase Goal Drift Containment

Date: 2026-07-16
Plan: `docs/dev/plans/0016-2026-07-14-ec-main-upstream-family-replay.md`
State: contained; replay candidate preserved; not commit-ready

## Incident

The Plan 0016 `/goal` was paused after 28.7 hours and 10,546,555 tokens. It had
reached autoreview Cycle 42 after 50 autoreview invocations, but it had not
created an integration commit. The temporary integration branch remained at
the fixed upstream target `b50822aab53`, while the semantic replay existed only
as a large staged candidate and a path-scoped Cycle 42 stash.

The review loop had drifted operationally: it repeatedly reviewed an
approximately 2.77 MB combined bundle instead of converging through bounded
feature-family commits. The goal remains paused and must not be resumed in that
form.

## Containment Receipts

Containment used non-destructive Git plumbing and retained the original stash:

- `refs/backup/ec-main-drift-containment-20260716-index` at
  `1c636fdecbb6e37c7fb807a25d49323c64bec1bb` preserves the 519-file visible
  index;
- `refs/backup/ec-main-drift-containment-20260716-stash` at
  `3ed35816593d71ca43946affbf59b7e04c1ca9aa` preserves the Cycle 42 stash
  commit;
- `refs/backup/ec-main-drift-containment-20260716-full` at
  `66c42040902a4ea2274b5ef088ffd287a1234117` preserves the restored 573-file
  candidate before this note was staged;
- `stash@{0}` remains present as
  `autoreview-cycle42-scanner-isolation`.

The broad stash apply correctly refused overlapping paths and produced no
conflicts. The 54 paths absent from the visible index were then restored only
from the stash's saved index. Verification found zero remaining differences
from that saved index, zero unmerged paths, zero unstaged or untracked paths,
and a clean `git diff --cached --check`.

## Salvage Verdict

Keep the complete restored candidate as the salvage point. Do not roll back to
the pre-autoreview replay: the first review identified 24 concrete issues,
including correctness and security defects, and many were repaired during the
later cycles. Path comparison found only 17 current paths outside the old
endpoint delta, mostly focused tests and helpers, rather than an unrelated
product expansion.

The candidate is not commit-ready. Six Cycle 42 findings remain valid:

1. `scripts/auto-upgrade-on-release-tag.sh` can exit the no-op path after
   checking out the integration branch without restoring the prior branch.
2. `src/agents/tools/sessions-list-tool.ts` queries explicit agent rows before
   applying session-visibility authorization, exposing row existence.
3. Cross-agent session-selector resolution performs target lookup before the
   caller's authorization boundary.
4. Failure-notice delivery can continue after its source dispatch is aborted.
5. `src/auto-reply/turn-tracker.ts` keeps registries in module-local maps even
   though the runtime can load split module copies.
6. `src/auto-reply/reply-payload.ts` keeps metadata in a module-local weak map,
   so frozen payload metadata can disappear across module copies.

## Bounded Recovery Sequence

1. Keep the original goal paused and do not restart its complete-bundle
   autoreview cycle.
2. Repair only the six known blockers first, with focused regressions at their
   existing owner boundaries.
3. Partition the staged replay into the Plan 0016 families: profiles/Codex,
   Slack/A2A, Slack responsiveness, automation, voice/media, and residual
   scripts/docs/generated output.
4. For each bounded family, run its focused gate and fresh autoreview until no
   actionable findings remain. Keep newly discovered repairs within the owning
   family instead of silently expanding the review bundle.
5. After all family commits converge, run the prescribed heavy checks and build
   through the allowed remote lane.
6. Only after clean proof, move `ec-main`, publish with the recorded
   force-with-lease, perform the plugin-aware tarball live patch, verify runtime
   health, and execute the latest verified Codex model transition.

No branch move, commit, push, live patch, or model change occurred during this
containment audit.
