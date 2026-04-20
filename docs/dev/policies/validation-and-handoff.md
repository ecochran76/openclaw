# Policy: Validation And Handoff

Use evidence-backed closeout for `ec-main` work, especially after rebases, live patches, plugin-boundary changes, or local feature preservation.

## Validation Selection

Run the narrowest meaningful validation first, then widen when impact is cross-cutting.

- Feature behavior: run the focused tests listed in `docs/dev/local-feature-index.md`.
- Type/lint/import boundaries: run `pnpm check`.
- Build output, packaging, plugin loading, lazy imports, generated surfaces, or published/runtime output: run `pnpm build`.
- Live patch: run `scripts/patch-live-openclaw.sh --expect-branch ec-main --require-expected-branch` and independently verify the gateway.

Scoped tests prove the changed behavior, but they do not automatically replace the normal landing bar for `ec-main`.

## Rebase Repair Gates

After a meaningful upstream rebase, preserve and validate the touched feature families:

- profiles/auth/usage: model auth, profile selection, usage policy tests
- Slack/A2A: sessions send, relay, ingress echo, approvals, Slack interaction tests
- Slack responsiveness: turn tracker, delivery observer, status/why-silent/turn commands
- automation: automation registry, runner, command/status tests
- voice/telephony: voice-call provider and media-stream tests
- live patch: build, package/install, gateway RPC probe

If a broad gate fails, classify whether the failure is related to the touched surface before broadening into unrelated cleanup.

## Commit And Push

- Use `scripts/committer "<message>" <files...>` for scoped commits.
- Keep commits coherent and truthful.
- Commit before risky history operations.
- Push `ec-main` after a validated rebase using `git push --force-with-lease fork ec-main`.
- If the pre-commit hook formats files after a commit attempt, inspect and commit any semantic or formatting follow-up before pushing.

## Handoff Format

Closeout should include:

- what changed
- commit hash or branch state when relevant
- validation commands and pass/fail results
- live patch and gateway status when relevant
- known residual risks or unrelated warnings
- the best next action when one is evident

Avoid vague “what next?” endings when a clear recommendation exists.

## Residual Risk Discipline

Report residual risks explicitly when:

- a test was skipped or timed out
- a live probe had transient failures before succeeding
- warnings remain in auth, plugins, or runtime configuration
- a feature was intentionally kept in core because no stable plugin seam exists yet

Do not hide unrelated runtime warnings, but do not treat them as blockers unless they affect the requested change.
