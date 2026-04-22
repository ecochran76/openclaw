---
name: openclaw-ec-main-rebase-live-patch
description: Run and repair the OpenClaw ec-main downstream maintenance flow. Use when Codex needs to fetch upstream, rebase ec-main onto origin/main, preserve local feature families through conflicts, run ec-main rebase gates, push fork/ec-main safely, live patch the installed OpenClaw, or verify the gateway after a live patch.
---

# OpenClaw ec-main Rebase And Live Patch

Use this skill for the downstream `ec-main` maintenance loop: fetch upstream, rebase, preserve local feature behavior, validate, push, live patch, and verify the live gateway.

## Read First

- `docs/dev/policies/ec-main-integration.md`
- `docs/dev/policies/validation-and-handoff.md`
- `docs/dev/local-feature-index.md` when choosing focused preservation tests.
- Scoped `AGENTS.md` files only for boundaries touched by conflicts or fixes.

## Branch And Safety Rules

- Upstream: `origin/main`.
- Downstream branch: local `ec-main`, pushed to `fork/ec-main`.
- Start with `git status --short` and `git branch --show-current`.
- Do not use destructive git commands.
- Do not stash, switch branches, or rewrite unrelated branches unless explicitly requested.
- Preserve unrelated user changes. If they conflict with the rebase task, stop and ask.
- Force-push `ec-main` only with `git push --force-with-lease fork ec-main`.
- Do not install globally from the local checkout path. Live patch must use the repo script/tarball path.

## Standard Flow

```bash
git fetch --all --prune
git rebase origin/main
```

If `git rebase --continue` opens an editor or fails because the editor is unavailable, use:

```bash
GIT_EDITOR=true git rebase --continue
```

Resolve conflicts by preserving the local feature families, not by mechanically taking either side.

Preferred conflict-resolution order:

1. profiles / auth / OAuth / usage policy
2. Slack / A2A routing, approvals, and relay behavior
3. Slack responsiveness and tracked-turn behavior
4. automation
5. voice / telephony / local STT
6. live-patch and upgrade scripts

## Common Rebase Repair Patterns

- Auth/profile conflicts: preserve profile selection, no-external-profile reads for status/diagnostics, runtime secret hydration, and main-agent/subagent merge semantics.
- Provider usage conflicts: preserve direct injected auth, plugin-owned usage hooks, provider-specific credential source gating, and OAuth-vs-api-key ordering.
- A2A/session conflicts: preserve ACP skip tokens, relay metadata, injected gateway callers, announce/reply helpers, and required relay failure handling.
- Gateway secret conflicts: preserve startup SecretRef preflight, durable SecretRef reload behavior, and shared-token websocket disconnects after auth rotation.
- WebSocket conflicts: preserve auto-mode fallback/retry semantics separately from explicit websocket-mode error behavior.
- Plugin dependency failures during live patch can be transient while bundled runtime deps install. Re-run doctor/plugin checks before treating them as source failures.

## Validation

Run narrow tests for touched surfaces first, then widen.

Local feature gate:

```bash
scripts/ec-main-rebase-gate.sh --family all
```

Use narrower families while resolving:

```bash
scripts/ec-main-rebase-gate.sh --family profiles
scripts/ec-main-rebase-gate.sh --family slack-a2a
scripts/ec-main-rebase-gate.sh --family slack-responsiveness
scripts/ec-main-rebase-gate.sh --family automation
scripts/ec-main-rebase-gate.sh --family voice
```

Landing gates:

```bash
pnpm check
pnpm test
pnpm build
```

Run `pnpm build` before live patch when the rebase touches build output, packaging, plugin loading, lazy imports, generated surfaces, or runtime/public output.

If dependencies are missing or stale, run:

```bash
pnpm install
```

Then retry the exact failed command once.

## Commit And Push

After the tree is green:

```bash
scripts/committer "Fix ec-main rebase integration" <paths...>
git push --force-with-lease fork ec-main
```

If the hook reruns a redundant expensive changed-scope lane after equivalent full gates have already passed, `FAST_COMMIT=1 git commit ...` is acceptable. State exactly which full gates already passed.

## Live Patch

```bash
scripts/patch-live-openclaw.sh --expect-branch ec-main --require-expected-branch
```

Then verify independently:

```bash
openclaw --version
openclaw gateway status --deep --require-rpc
openclaw doctor
```

If the first gateway probe fails during warm-up, retry before diagnosing. If it still fails, inspect:

```bash
journalctl --user -u openclaw-gateway.service -n 200 --no-pager
```

## Closeout

Report:

- branch/head and pushed commit
- validation commands and results
- live patch result and installed version
- gateway RPC result
- residual warnings from doctor or logs
- best next step
