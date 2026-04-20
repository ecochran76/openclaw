# Policy: `ec-main` Integration

`ec-main` is the deployable downstream integration branch for local OpenClaw feature work.

## Branch Model

- Treat `origin/main` as upstream.
- Treat `fork/ec-main` as the private downstream integration branch.
- Rebase `ec-main` onto fresh `origin/main` when preserving a small understandable downstream delta is the goal.
- Force-push only with `--force-with-lease`, and only for documented rebase-managed branches such as `ec-main`.
- Do not rewrite unrelated shared branches as part of `ec-main` maintenance.
- Before risky rebases or broad conflict repair, create or confirm a recoverable commit checkpoint.

## Local Feature Preservation

Preserve the maintained local feature families listed in `docs/dev/local-feature-index.md`:

- profiles / auth / usage policy
- Slack / A2A approvals and relay behavior
- Slack / agent responsiveness
- automation
- voice / telephony / local STT
- outbound relay and bound-channel protections

When a rebase conflict touches these areas, resolve by preserving user-visible behavior and focused preservation tests, not by mechanically accepting either side.

## Rebase Order

When a rebase queue clearly contains several local feature families, resolve in this order:

1. profiles / auth / OAuth
2. Slack / A2A routing, approvals, and relay behavior
3. Slack responsiveness and tracked-turn behavior
4. automation
5. voice / telephony
6. live-patch and upgrade scripts

This order keeps dependencies coherent: automation command/status behavior depends on turn tracking; A2A approval UX depends on routing and permission records; live-patch scripts should validate the integrated result, not drive semantic resolution.

## Planning Authority

This repo now uses top-level `ROADMAP.md` and `RUNBOOK.md` as lightweight indexes for serialized planning-contract adoption. Existing feature planning remains under `docs/dev/` and should be migrated only when active or touched.

Use these canonical local planning surfaces:

- roadmap index: `ROADMAP.md`
- runbook log: `RUNBOOK.md`
- bounded active plans: `docs/dev/plans/`
- feature map: `docs/dev/local-feature-index.md`
- compatibility plan: `docs/dev/upstream-compat-feature-preservation-plan.md`
- rebase playbook: `docs/dev/rebase-friendly-branching-playbook.md`
- feature-specific plans under `docs/dev/*.md` and `docs/dev/local-features/*.md`

Do not scatter new durable plans into arbitrary docs paths. New bounded plans should use serialized filenames under `docs/dev/plans/`. If a new local feature family is added, update `docs/dev/local-feature-index.md` and create a bounded feature note under `docs/dev/local-features/`.

## Live Patch Flow

The normal post-rebase deploy path is:

1. fetch upstream remotes
2. rebase `ec-main` onto `origin/main`
3. run focused preservation tests for touched feature families
4. run `pnpm check`
5. run `pnpm build` when build output, packaging, runtime loading, plugin boundaries, or published surfaces changed
6. commit with `scripts/committer`
7. push `fork/ec-main` with `--force-with-lease`
8. run `scripts/patch-live-openclaw.sh --expect-branch ec-main --require-expected-branch`
9. verify gateway health independently with `openclaw gateway status --deep --require-rpc`, systemd or launchd status, and port checks where relevant

Do not use direct local-directory global installs for live patching.

## Multi-Agent Safety

- Treat overlapping agent work as reconciliation, not casual cleanup.
- Inspect `git status` before branch-sensitive work.
- Commit only your intended changes unless the user explicitly asks for `commit all`.
- Do not use stash, branch checkout, worktree mutation, or destructive git commands unless explicitly requested.
- If multiple agents touched a hotspot file, inspect history and intended behavior before overwriting.
