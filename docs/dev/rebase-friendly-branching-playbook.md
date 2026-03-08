# Rebase-friendly branching playbook (upstream + ecochran76 fork)

## Goal

Keep two active features moving in parallel while rebasing frequently onto `openclaw/openclaw` without creating merge chaos.

Features in scope:

- **A2A ingress echo** (`sessions_send` recipient-channel echo + act)
- **Profile upgrading** (existing profile workstream)

## Remote assumptions in this clone

This repo currently uses:

- `origin` = `https://github.com/openclaw/openclaw.git` (official upstream)
- `fork` = `https://github.com/ecochran76/openclaw.git` (personal fork)

> Note: this is inverted from the common naming convention. Commands below intentionally use this mapping.

## Branch roles

- `origin/main` (upstream): truth source for daily rebase base.
- `fork/main` (fork main): stable promotion target in ecochran76 fork.
- `ec-main` (integration branch in fork): working integration branch that carries advances from both features.
- `feat/a2a-ingress-echo`: isolated branch for inter-agent echo feature.
- `feat/profile-upgrade`: isolated branch for profile upgrading feature.

## Invariants (must hold)

1. `ec-main` is rebased onto latest `origin/main` frequently.
2. Feature branches are rebased onto latest `ec-main` (not directly onto `fork/main`).
3. Promotion to `fork/main` only happens from a known-good `ec-main` state.
4. Integration into `ec-main` uses **small, topic-scoped commits** and `cherry-pick -x` when partial adoption is needed.
5. Avoid merge commits in this stack; prefer rebase + fast-forward.

## One-time bootstrap

```bash
# Always start by syncing
git fetch origin --prune
git fetch fork --prune

# 1) Integration branch from fork main
# (if ec-main does not exist yet)
git switch -c ec-main --track fork/main

# 2) Feature branches
# A2A branch starts from ec-main baseline
git switch -c feat/a2a-ingress-echo ec-main

# Profile branch can follow existing remote branch if present
git switch -c feat/profile-upgrade --track fork/feat/openai-codex-oauth-profile-id || \
  git switch -c feat/profile-upgrade ec-main
```

## Daily sync loop

### A) Refresh integration branch (`ec-main`)

```bash
git fetch origin --prune
git fetch fork --prune

git switch ec-main
# Keep integration branch current with upstream
git rebase origin/main
# Publish updated integration branch
# (force-with-lease is expected after rebase)
git push fork ec-main --force-with-lease
```

### B) Refresh feature branches

```bash
# A2A
git switch feat/a2a-ingress-echo
git rebase ec-main
git push fork feat/a2a-ingress-echo --force-with-lease

# Profile
git switch feat/profile-upgrade
git rebase ec-main
git push fork feat/profile-upgrade --force-with-lease
```

## Integrating feature work into `ec-main`

Use one of these patterns:

### Pattern 1: Full feature slice (linear, clean)

```bash
git switch ec-main
git cherry-pick -x <start-commit>^..<end-commit>
# run tests
git push fork ec-main
```

### Pattern 2: Selective commit pickup (safer for partial readiness)

```bash
git switch ec-main
git cherry-pick -x <commit-a>
git cherry-pick -x <commit-b>
# run tests
git push fork ec-main
```

## Promotion from `ec-main` to `fork/main`

When integration is validated:

```bash
git fetch fork --prune
git switch main
# If local main tracks upstream, explicitly reset local main to fork/main before promotion:
git reset --hard fork/main

# Bring in tested integration branch
# (prefer fast-forward if possible)
git merge --ff-only ec-main

git push fork main
```

## Conflict-minimizing commit discipline

- Keep commits narrow (one behavior change per commit).
- Separate config/schema changes from runtime behavior changes.
- Separate tests from implementation only when tests are large/follow-up.
- Include migration-safe defaults (feature flags default-off where possible).
- Avoid broad renames in active subsystems during feature work.

## Guardrails for fast-moving upstream

- Rebase `ec-main` daily (or before each integration PR).
- If rebase conflicts repeat, enable rerere once:

```bash
git config rerere.enabled true
git config rerere.autoupdate true
```

- Use `--force-with-lease`, never plain `--force`.
- Keep CI required on feature branches and `ec-main` before promoting to `fork/main`.

## Hotfix protocol

If urgent fix is needed while features are in flight:

1. branch from latest `origin/main` (or latest promoted `fork/main`, depending on urgency scope),
2. implement + validate,
3. cherry-pick into `ec-main`, then rebase both feature branches onto updated `ec-main`.

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
- During day: feature branches rebase onto `ec-main` before opening/refreshing PRs.
- End of day: integrate stable slices into `ec-main`, run full tests, optionally promote to `fork/main`.
