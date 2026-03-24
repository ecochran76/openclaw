# Rebase-friendly branching playbook (upstream + ecochran76 fork)

## Goal

Keep persistent local feature work moving in parallel on top of `openclaw/openclaw` without letting stale side branches create merge chaos or block deployable upgrades.

Maintained local workstreams on `ec-main`:

- **Profiles / auth / OAuth**
- **Slack / A2A**
- **Slack / agent responsiveness**
- **Automation**

## Remote assumptions in this clone

This repo currently uses:

- `origin` = `https://github.com/openclaw/openclaw.git` (official upstream)
- `fork` = `https://github.com/ecochran76/openclaw.git` (personal fork)

> Note: this is inverted from the common naming convention. Commands below intentionally use this mapping.

## Branch roles

- `origin/main` (upstream): truth source for daily rebase base.
- `fork/main` (fork main): stable promotion target in ecochran76 fork.
- `ec-main` (integration branch in fork): working integration branch carrying the maintained local compatibility layer.
- topic branches (`feat/a2a-*`, `feat/auth-*`, `feat/slack-*`, `feat/automation-*`): isolated maintenance branches for active work that has not yet been fully integrated into `ec-main`.

## Invariants (must hold)

1. `ec-main` is rebased onto latest `origin/main` frequently.
2. Topic branches are rebased onto latest `ec-main` (not directly onto `fork/main`).
3. Promotion to `fork/main` only happens from a known-good `ec-main` state.
4. Integration into `ec-main` uses **small, topic-scoped commits** and `cherry-pick -x` when partial adoption is needed.
5. Avoid merge commits in this stack; prefer rebase + fast-forward.
6. **Unattended release upgrade automation targets `ec-main` only**. Topic-branch refresh is a separate maintenance task and must not block live patching.
7. Once a deployable slice lands in `ec-main`, do not keep treating the topic branch copy as the canonical truth.

## One-time bootstrap

```bash
# Always start by syncing
git fetch origin --prune
git fetch fork --prune

# Integration branch from fork main
# (if ec-main does not exist yet)
git switch -c ec-main --track fork/main
```

Create topic branches from `ec-main` or track the corresponding `fork/*` branch if it already exists.

Examples:

```bash
git switch -c feat/a2a-ingress-echo ec-main
git switch -c feat/profile-upgrade --track fork/feat/openai-codex-oauth-profile-id || \
  git switch -c feat/profile-upgrade ec-main
git switch -c feat/slack-turns ec-main
git switch -c feat/automation ec-main
```

## Daily sync loop

### A) Refresh integration branch (`ec-main`)

```bash
git fetch origin --prune
git fetch fork --prune

git switch ec-main
git rebase origin/main
git push fork ec-main --force-with-lease
```

### B) Refresh active topic branches

```bash
# Example only; refresh the branches that are still active.
git switch feat/profile-upgrade
git rebase ec-main
git push fork feat/profile-upgrade --force-with-lease

git switch feat/a2a-ingress-echo
git rebase ec-main
git push fork feat/a2a-ingress-echo --force-with-lease
```

Treat this as a **developer maintenance loop**, not part of unattended production upgrade automation.
If a topic branch stops being actively developed, archive/delete it or remove it from helper scripts that still mention it.

## Integrating feature work into `ec-main`

Use one of these patterns:

### Pattern 1: Full feature slice (linear, clean)

```bash
git switch ec-main
git cherry-pick -x <start-commit>^..<end-commit>
# run focused validation
git push fork ec-main
```

### Pattern 2: Selective commit pickup (safer for partial readiness)

```bash
git switch ec-main
git cherry-pick -x <commit-a>
git cherry-pick -x <commit-b>
# run focused validation
git push fork ec-main
```

## Promotion from `ec-main` to `fork/main`

When integration is validated:

```bash
git fetch fork --prune
git switch main
# If local main tracks upstream, explicitly reset local main to fork/main before promotion:
git reset --hard fork/main

git merge --ff-only ec-main
git push fork main
```

## Conflict-minimizing commit discipline

- Keep commits narrow (one behavior change per commit).
- Separate config/schema changes from runtime behavior changes.
- Separate tests from implementation only when tests are large/follow-up.
- Include migration-safe defaults where possible.
- Avoid broad renames in active subsystems during feature work.
- Do not mix infra/script churn, auth/profile work, and product behavior on the same long-lived topic branch unless they are inseparable.
- If a commit is useful beyond its topic branch, cherry-pick it into `ec-main` early instead of letting the branch become a catch-all queue.
- Prefer short-lived stacked branches for cross-cutting prep work over one umbrella branch that absorbs everything.

## Guardrails for fast-moving upstream

- Rebase `ec-main` daily (or before each integration PR).
- If rebase conflicts repeat, enable rerere once:

```bash
git config rerere.enabled true
git config rerere.autoupdate true
```

- Use `--force-with-lease`, never plain `--force`.
- Keep CI required on topic branches and `ec-main` before promoting to `fork/main`.

## Hotfix protocol

If urgent fix is needed while features are in flight:

1. branch from latest `origin/main` (or latest promoted `fork/main`, depending on urgency scope),
2. implement + validate,
3. cherry-pick into `ec-main`, then rebase active topic branches onto updated `ec-main`.

## Recovery snippets

```bash
# Find pre-rebase state
git reflog --date=iso

# Recover branch head
git switch <branch>
git reset --hard <reflog-sha>

# Abort in-progress rebase
git rebase --abort
```

## Suggested cadence

- Morning: rebase `ec-main` onto `origin/main`.
- During day: rebase active topic branches onto `ec-main` before opening/refreshing PRs.
- End of day: integrate stable slices into `ec-main`, run focused validation, optionally promote to `fork/main`.

## Execution model for the 2026-03-21 repair pass

When a large rebase is already in flight, finish it in **feature order**, not purely by file order:

1. **Profiles / auth / OAuth** conflicts first, preserving the already-maintained local auth layer.
2. **Slack / A2A** conflicts next, keeping routing and session semantics coherent.
3. **Slack responsiveness** commits as a coherent series, because they build on shared tracked-turn state.
4. **Automation** commits after responsiveness, followed by focused validation.

Do not rewrite the runbook mid-conflict. Finish the mechanical rebase first, then update docs and validation guidance from the stabilized `ec-main` result.

## Upgrade notes from the 2026-03-23 forward-port onto upstream `2026.3.23`

The `ec-main` forward-port onto current upstream was viable, but not as a blind rebase.

The durable lesson is that future upgrades should preserve newer upstream seams and reapply local behavior onto them, instead of restoring older local structural choices.

### Conflict seams that mattered

- `src/auto-reply/reply/commands-core.ts` and related command wiring:
  - upstream now prefers runtime-loaded command registration
  - local commands such as `/profile`, `/profiles`, and automation status should be wired through `src/auto-reply/reply/commands-handlers.runtime.ts`, not by reviving older static registration tables
- tracked-turn / status surfaces:
  - `src/auto-reply/reply/dispatch-from-config.ts`
  - `src/auto-reply/turn-tracker.ts`
  - `src/auto-reply/status.ts`
  - these files now carry a coherent local responsiveness layer; replaying later commits without the underlying tracked-turn helpers is fragile
- session / A2A schema surfaces:
  - `src/config/schema.base.generated.ts`
  - `src/config/schema.help.ts`
  - `src/config/schema.labels.ts`
  - `src/config/zod-schema.session.ts`
  - upgrades here often look like random config churn but are really generated-schema drift
- profile/auth runtime snapshot behavior:
  - `src/agents/auth-profiles/store.ts`
  - `src/infra/provider-usage.auth.ts`
  - `src/infra/provider-usage.load.ts`
  - preserve current runtime-snapshot ordering/normalization semantics rather than backporting older store shapes
- packaging and live-patch scripts:
  - `scripts/copy-bundled-plugin-metadata.mjs`
  - `scripts/patch-live-openclaw.sh`
  - `scripts/release-check.ts`
  - these now act as upgrade safety rails and should be kept aligned with release/install expectations

### Porting rules that survived this upgrade

- prefer upstream runtime-loader and helper-based shapes when local behavior can be layered onto them
- keep large rebases in feature order:
  1. profiles/auth
  2. Slack/A2A
  3. Slack responsiveness
  4. automation
- when session config changed, reconcile generated schema files early instead of chasing downstream type/test noise
- run `pnpm check` and `pnpm build` from the finished integration head before repointing `ec-main`
- expect `pnpm build` to go quiet during runtime postbuild packaging; verify completion before treating silence as failure

### Likely future breakpoints

If upstream keeps moving in the same direction, the next upgrades are most likely to hurt in:

- auto-reply command registration and command metadata
- tracked-turn/state inspection commands
- session/A2A config schema generation
- auth/profile normalization and usage reporting
- packaging/postbuild/release-check scripts
