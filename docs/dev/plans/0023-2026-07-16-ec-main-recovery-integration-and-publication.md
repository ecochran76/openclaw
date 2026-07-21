State: CLOSED
Created: 2026-07-16
Plan Version: 7
Revised: 2026-07-20

# ec-main Upstream-First Recovery, Integration, And Publication

## Current State

Integration, publication, and live patch are complete. The final head
`711d5ea3794854b6452536efc469c77495cdb02e` descends from fresh
`origin/main` `3a9f89e42e949561062c7fae50776ba991803d60` and is ahead by exactly two
downstream commits: `cf92ae3b044` for thin session profile commands and
`711d5ea3794` for plugin-owned buffered media transcription. Local
`ec-main`, `fork/ec-main`, and the isolated execution head all resolve to the
same published SHA.

The exact installed core artifact is OpenClaw `2026.7.2 (711d5ea)`. The
gateway reports matching CLI and gateway versions, a successful admin-capable
RPC probe, and restored Slack channel connections. The matching Codex plugin
`2026.7.2` is loaded. Voice Call `2026.7.2` is installed but left disabled
because this host did not previously have telephony configured; its installed
runtime imports successfully and contains the buffered media transcription
implementation. The installed core command registry and handler bundle contain
`/profile` and `/profiles`.

Earlier Plan 0023 execution classified and packetized a 585-path recovery
candidate, then repeatedly split and reviewed automation packets. That process
produced useful recovery refs and evidence, but it overfit execution to the
historical diff. The packet queue, correction-cycle limits, mandatory neutral
gate for packet maps, and Note 0037 resume algorithm are now historical
receipts only. They no longer control execution.

The current authority is this Version 7 closeout. Its rule is upstream-first:
accept current upstream code and upstream validation as the baseline, then
apply and prove only the smallest downstream delta required for documented
`ec-main` features that upstream does not provide.

Version 4 removes the remaining open-ended family-audit loop. The rebase is
not a historical parity exercise: once current upstream owns an outcome, that
family is closed as `DROP` without replay, downstream tests, or further packet
work. Execution is limited to the frozen downstream outcome ledger below.

Version 5 makes validation inheritance explicit: upstream-owned code inherits
upstream's validation receipts. This plan spends test and review time only on
the downstream lines we add and the exact seams those lines modify. A rebase,
by itself, is not a reason to rerun an upstream gate.

Version 6 applies the bounded-review stop rule to the remaining historical
families. The usage-policy reconstruction was removed after two correction
cycles still left four concrete integration defects in scoped autoreview; at
2,300-plus changed lines it was not a thin preservation seam. The historical
A2A approval flow likewise requires a multi-module permission registry, reply
actions, and Slack integration, while turn/token automation requires rebuilding
the downstream controller around upstream Tasks. These outcomes are `DEFER`,
not publication blockers. The final branch retains only the two already-proven
unique deltas plus the deployment workflow needed to publish them.

Version 7 records closeout. Fresh upstream's unreleased `2026.7.2` package
omits runtime export-map entries still consumed by official external plugins,
and the matching web-provider plugin packages are not yet published. The live
host therefore carries a bounded export-map compatibility overlay for the
installed Codex and disabled Voice Call packages, plus the two already-enabled
web provider plugins. This is an upstream packaging follow-up, not another
historical `ec-main` family and not a reason to reopen the rebase.

## Objective

Produce the smallest maintainable `ec-main` delta on fresh `origin/main` that
preserves our unique features, publish it safely, and prove those features in
the installed runtime.

## Governing Decisions

### Upstream Is The Baseline

- Do not replay a local hunk, test, fixture, generated file, document, or
  compatibility layer when current upstream already provides equivalent
  behavior.
- Do not retest unchanged upstream behavior merely because it appeared in the
  old recovery candidate. Upstream's tests and CI own that baseline.
- Test only retained local behavior and the direct upstream seams changed to
  integrate it.
- Treat a clean upstream-owned path as already proven. A downstream test is
  justified only by a retained downstream behavior, a directly edited seam,
  or the final package/install artifact.
- If equivalence is uncertain, inspect current upstream source, callers,
  tests, and dependency contracts before deciding. Preserve local code only
  when a concrete behavioral gap remains.
- Prefer the current upstream shape even when an older downstream shape is
  easier to replay.

### Minimal Preservation Rule

Every proposed downstream change receives exactly one disposition:

1. `DROP`: upstream already owns equivalent behavior, or the change is stale,
   incidental, generated drift, speculative compatibility, or unrelated
   cleanup.
2. `KEEP`: it implements a documented maintained local feature absent from
   upstream.
3. `MOVE`: the behavior is unique, but belongs in a narrower plugin,
   provider/channel seam, feature helper, or migration owner.
4. `DEFER`: it is valuable but not required to preserve an existing local
   feature; record it outside this rebase rather than expanding this plan.

A `KEEP` or `MOVE` decision must name the local feature, upstream gap, owner
boundary, minimum changed surface, and focused proof. If that case cannot be
made briefly, default to `DROP` or `DEFER`.

### Testing Budget

- Upstream's successful CI is accepted for the unchanged upstream base. Do
  not reproduce its broad, full, release, platform, provider, or channel
  suites locally or remotely.
- No tests for discarded local implementations.
- For each retained family, run only the focused tests that exercise the
  preserved behavior and any directly modified integration seam. The family
  gate is a command menu, not a requirement to run unrelated tests.
- A family classified entirely `DROP` has no downstream executable test gate;
  its evidence is the upstream source/test-contract comparison recorded in
  the matrix.
- Reuse a prior focused result only when the candidate diff, base contract,
  and relevant dependency behavior are unchanged; otherwise rerun the narrow
  proof.
- Near publication, run only cheap diff/format/static sanity for the final
  downstream paths. Run a targeted changed-surface check only when a retained
  seam cannot be covered by its focused test. Do not automatically run the
  repo-wide changed gate.
- Build/package once only because the approved live-patch workflow needs a
  fresh tarball, or earlier if a retained change directly affects module
  loading, generated contracts, plugins, packaging, or published surfaces.
- Broad, full, release, and upstream-owned suites are out of scope unless a
  retained local change creates a concrete cross-cutting risk that targeted
  proof cannot cover.
- Live proof covers retained local features and changed runtime seams. It does
  not replay upstream's entire release validation.

### Completion Bias

- The burden of proof is on retaining code, not dropping it. Historical
  presence, old tests, old review approval, and filename similarity are not
  preservation evidence.
- Stop comparing a family as soon as current upstream source and tests show
  the required product outcome. Record `DROP` and move on.
- Do not preserve an old subsystem when one small adapter, command, policy
  hook, or plugin seam can provide the unique outcome on current upstream.
- Do not expand a retained slice to restore historical implementation detail.
  Preserve the documented user or operator outcome only.
- A retained slice that cannot be made owner-correct and focused must be
  reduced before implementation. It does not authorize a broad replay.

### Review Budget

- Code changes still receive the repo-required fresh autoreview, scoped to the
  coherent retained feature delta.
- Do not autoreview packet maps, discarded code, unchanged upstream code, or
  historical recovery bundles.
- Use one review and at most one consolidated correction per coherent feature
  delta. If that fails, reduce or drop the delta instead of starting another
  open-ended review cycle.
- A completed clean review may be reused only for an identical diff on an
  unchanged relevant base contract.

### Worktree Isolation And Standing Authorization

- Before branch surgery, preserve the current state and create a clean,
  isolated worktree for this upstream-first execution. Do not keep integrating in a
  checkout being mutated by unrelated policy or agent work.
- The user has granted standing authorization for routine read-only checks,
  recovery refs, isolated worktree creation, upstream fetch/comparison,
  bounded keep/drop/move decisions, focused tests, review retries, commits,
  and recovery-safe reconstruction within this objective.
- Stop only for a destructive or unrecoverable operation, changed remote
  publication expectation, external side effect beyond the approved publish
  and live-patch workflow, unresolved product choice, missing recovery
  coverage, or unowned concurrent mutation of the execution worktree.

## Frozen Downstream Outcome Ledger

The durable feature authority remains `docs/dev/local-feature-index.md` and
its linked feature docs, but execution is now constrained to these outcomes:

| Family | Disposition | Maximum retained outcome |
| --- | --- | --- |
| Profiles | `KEEP` | Thin `/profile` and `/profiles` operator commands over upstream auth-profile storage and ordering. Implemented by `cf92ae3b044`. |
| Usage policy | `DEFER` | The bounded fresh-upstream reconstruction remained a 2,300-plus-line subsystem and failed to converge after two review-triggered correction cycles. It is removed from this rebase and requires a separate canonical design. |
| Slack/A2A | `DROP`; approval outcome `DEFER` | Drop local routing, relay, session resolution, announcements, thread targeting, and selector machinery. The approval-on-policy-denial outcome is not a thin seam: the historical implementation spans core permission state/reply actions and Slack interaction integration. |
| Slack responsiveness | `DROP` | Upstream durable ingress/replay, dedupe, restart recovery, progress/task surfaces, steering, and send reconciliation replace the local tracker/watchdog/reconciliation stack. |
| Automation | `DEFER` | Upstream owns run-duration timeouts plus Task lifecycle/status/stop. No thin turn/token-only controller was established without rebuilding the old subsystem, so all downstream automation machinery stays out of this rebase. |
| Voice/telephony | `MOVE` | Plugin-owned buffered media-audio bridge into upstream transcription. Drop local provider discovery and generic STT machinery already owned upstream. |
| Deployment tooling | `KEEP` | Only the tarball live-patch/revert/restart and exact-lease branch discipline needed to publish and install the retained delta. |

No other historical family or path is eligible for replay under this plan.
If a new claimed gap appears, record it for a later plan unless it is strictly
required for one of the retained outcomes above.

## Scope

- refresh the upstream base and establish an isolated execution worktree;
- compare the current downstream feature delta with current upstream;
- produce a compact `KEEP` / `DROP` / `MOVE` / `DEFER` evidence matrix;
- replay or reconstruct only the minimum retained feature code and directly
  coupled tests/docs;
- validate retained behavior with focused proof;
- perform one integrated final-delta audit and the minimum required
  changed-surface/build validation;
- move and publish `ec-main` with an exact force-with-lease;
- patch the installed core and affected external plugins, then prove the
  retained features live;
- transition Codex models only if it remains necessary after the runtime is
  proven and the installed catalog supplies current authority.

## Non-Goals

- preserving the old 585-path candidate as a unit;
- completing the old automation packet ledger;
- replaying historical downstream commits for their own sake;
- reproducing upstream CI or release validation;
- retaining duplicate upstream behavior, internal compatibility shims, stale
  generated output, obsolete tests, or speculative fallbacks;
- adding new feature families or polishing adjacent architecture;
- changing protocol versions or product contracts without explicit approval.

## Execution

### Phase 0 | Stabilize Authority — COMPLETE

1. Re-read branch, remote, recovery refs, index, worktree, and active-process
   state.
2. Preserve any current owned candidate not already reachable from a recovery
   ref.
3. Create a clean isolated worktree from fresh `origin/main`; record its base
   SHA and expected `fork/ec-main` lease SHA.
4. Treat concurrent policy-rollout commits as a separate integration input:
   retain them only if they are intended `ec-main` policy changes, without
   letting their worktree churn invalidate feature preservation.

Exit: one owned clean execution worktree, exact recovery refs, fresh upstream
base, and no ambiguous concurrent writer.

### Phase 1 | Close The Frozen Outcome Ledger

For each ledger row not already closed:

1. compare current upstream behavior and tests with the last known downstream
   behavior;
2. identify only user-visible or operational behavior still absent upstream;
3. assign each candidate surface `KEEP`, `DROP`, `MOVE`, or `DEFER`;
4. state the minimum code and proof for every `KEEP` or `MOVE` row.

Do not reconstruct a giant path manifest. The matrix is feature-outcome based.
When upstream equivalence is established, delete the local implementation and
its redundant tests/docs from the candidate immediately.

Already closed decisions are not reopened unless fresh upstream changed the
relevant contract. Profiles command wiring is committed. Slack responsiveness
and the upstream-owned portions of Slack/A2A are `DROP`. The usage-policy
attempt was removed under the bounded-review stop rule. The conditional A2A
approval and turn/token automation candidates are also closed as `DEFER`
because neither has an owner-correct thin seam. Final delta audit, deployment,
publication, and live proof are complete. The plugin-owned buffered-audio
bridge is committed as `711d5ea3794`.

Exit: every retained behavior has a concise upstream-gap justification and no
historical path remains merely because it was previously staged or reviewed.

### Phase 2 | Apply The Minimal Delta

Process only the frozen `KEEP` and `MOVE` outcomes, smallest first.

For each coherent family delta:

1. implement or replay the smallest owner-correct change;
2. run only its exact focused behavior test(s); do not run a historical family
   gate or whole family bundle;
3. run one scoped autoreview and at most one consolidated correction;
4. commit the accepted family delta immediately with its upstream-gap and test
   receipt;
5. continue only when the prior family is closed.

No arbitrary file-count packetization is required. Split only when a family
delta contains independently testable behavior or crosses owner boundaries.

Exit: every downstream commit maps to one documented local feature or a
necessary integration/deployment seam.

### Phase 3 | Final Delta Audit And Integrated Proof

1. Diff the integrated head against fresh `origin/main`.
2. Require every remaining production line, test, generated artifact, and doc
   change to map to a `KEEP` or `MOVE` row; remove residue.
3. Confirm no upstream implementation was shadowed or duplicated.
4. Reuse focused proof recorded by unchanged immutable downstream commits.
   Rerun only when the retained diff or its direct upstream contract changed.
5. Run cheap final-diff sanity. Add a targeted changed-surface check only for
   a retained integration risk not covered by focused tests. Do not run a
   repo-wide check merely because this is a rebase.
6. Build/package once for the live-patch artifact; do not treat that build as
   an instruction to rerun upstream test suites.
7. Run final diff, ancestry, generated-contract when touched, and
   clean-worktree checks.

Exit: minimal explained diff; focused local-feature proof passes; the one
necessary packaging/runtime gate passes; no unrelated failure is attributed
to the delta without comparison against current upstream.

### Phase 4 | Publish ec-main

1. Verify the integration head descends from the freshly recorded
   `origin/main` SHA.
2. Verify required recovery refs remain reachable.
3. Re-read `fork/ec-main`; abort if it differs from the recorded lease SHA.
4. Move local `ec-main` to the validated integration head.
5. Push only `fork/ec-main` with exact `--force-with-lease`.
6. Verify local and remote `ec-main` resolve to the published SHA.

### Phase 5 | Minimal Live Patch And Proof

1. Use the approved tarball and external-plugin-aware patch workflow.
2. Patch only components affected by the retained delta.
3. Verify installed core/plugin identity and gateway health.
4. Exercise the actual retained feature families and changed delivery/auth
   seams; record exact pass/fail evidence without secrets.
5. Restore any deliberately quiesced operator automation and prove recovery.

If the installed catalog requires a Codex model transition, perform it only
after live auth succeeds, read back every changed route, and run narrow fresh
session smoke turns. Do not create legacy `openai-codex` routes.

## Checkpoints And Progress

Record one checkpoint after each closed feature family and before publication
or live patch. Each checkpoint contains:

- plan version and state transition;
- base/head SHA and owned paths;
- `KEEP` / `MOVE` outcome advanced;
- focused validation and review result;
- remaining families;
- exact next action or stop reason.

Progress is a removed duplicate, a committed unique-feature delta, a passed
final integration gate, publication, or live proof. More packet maps, repeated
review retries without a result, and validation of unchanged upstream code are
not progress.

## Acceptance Criteria

- the final head descends from the fresh recorded `origin/main`;
- every downstream commit and changed line maps to a documented feature absent
  from upstream or a necessary integration/deployment seam;
- no local code, test, doc, generated output, shim, or fallback duplicates
  current upstream behavior;
- retained features pass focused tests at their changed boundaries;
- cheap final-diff sanity passes; any targeted integration check is justified
  by a retained downstream seam rather than by unchanged upstream code;
- the one build/package needed for live patch succeeds;
- scoped autoreview is clean for every final code delta;
- local `ec-main` and `fork/ec-main` match the validated published SHA;
- installed components match that SHA and retained features pass live proof;
- `ROADMAP.md` and `RUNBOOK.md` contain current closeout receipts.

## Recovery Authorities And Historical Receipts

Do not delete the existing recovery refs while this plan is open. Important
authorities include:

- `refs/backup/ec-main-drift-containment-20260716-plan0023`;
- `refs/backup/ec-main-plan0023-family3a-review`;
- `refs/backup/ec-main-plan0023-upstream-preference-20260720`;
- `refs/backup/ec-main-plan0023-upstream-preference-complete-20260720`;
- `refs/backup/ec-main-plan0023-pre-index-complete-20260720`;
- `refs/backup/ec-main-plan0023-r01.1-reworked-candidate`.

Detailed historical classifications and prior pause receipts remain in:

- `docs/dev/notes/0035-2026-07-16-ec-main-rebase-goal-drift-containment.md`;
- `docs/dev/notes/0036-2026-07-16-plan0023-frozen-family-manifest.md`;
- `docs/dev/notes/0037-2026-07-18-plan0023-fresh-agent-handoff.md`;
- `RUNBOOK.md` Turns 30 through 33.

These artifacts are recovery evidence, not instructions to resume the old
packet/review loop.

## Definition Of Done

State is `CLOSED`; the final downstream delta is minimal and fully attributable
to maintained features absent upstream; focused proof, required integrated
proof, publication, and live validation pass; local and remote `ec-main` match;
the installed runtime matches the published source; and no required work
remains.
