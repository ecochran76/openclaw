State: OPEN
Created: 2026-06-27

# Crabbox Broad Gate And Runtime Warning Cleanup Plan

## Current State

`ec-main` is rebased onto current `origin/main` and pushed to `fork/ec-main` at
`8bb2ab3992`. The live patch installed `OpenClaw 2026.6.10 (8bb2ab3)` and the
gateway RPC probe is healthy.

Focused proof already passed on the rebased head:

- focused rebase family gate equivalent: 11 Vitest shards in 287.42s
- extra Slack reliability and Codex auth proof: 7 Vitest shards in 56.57s
- `pnpm config:channels:check`
- `git diff --check`
- `node scripts/run-tsgo.mjs -p tsconfig.plugin-sdk.dts.json --declaration true`
- `pnpm build`
- live patch smoke: 2 Vitest shards in 11.83s

The remaining validation gap is the broad changed gate. It was not run because
`node scripts/crabbox-wrapper.mjs --help` failed before dispatching any work:

```text
[crabbox] bin=crabbox version=unknown provider=azure providers=unknown
[crabbox] selected binary failed basic --version/--help sanity checks
```

Direct local `pnpm check*` was intentionally avoided because this checkout is a
Codex worktree and local pnpm-gated broad checks can reconcile dependencies or
prompt unexpectedly.

Doctor and gateway warnings remain after the successful live patch. None blocked
installation or gateway RPC, but they should be triaged separately so future
rebases have cleaner operator proof.

## 2026-06-27 Progress Update

Baseline reconfirmation found that `origin/main` moved after this plan was
written:

- `HEAD`: `8bb2ab39928a7c4c6d2f2eb820ec4e6c6e567ad8`
- `fork/ec-main`: `8bb2ab39928a7c4c6d2f2eb820ec4e6c6e567ad8`
- `origin/main`: `7bbd09047bd7ce1ce573e0d434abcf72a76de1f6`
- `origin/main...HEAD`: `5 334`
- installed CLI: `OpenClaw 2026.6.10 (8bb2ab3)`
- gateway deep status: read probe `ok`, `admin-capable`

Because the branch is no longer current on `origin/main`, the broad changed
gate would not satisfy this plan's definition of done until the rebase target
is refreshed or explicitly accepted.

Crabbox/Testbox wrapper repair is complete. The local toolchain was missing a
usable `crabbox` binary, so the wrapper fell through to `crabbox` on PATH and
failed its basic sanity checks. A sibling `../crabbox` checkout was cloned from
`openclaw/crabbox`, built with version metadata, and now reports
`0.33.0-240-g399c94a8`. `node scripts/crabbox-wrapper.mjs --help` exits 0 and
selects `../crabbox/bin/crabbox`; `node scripts/crabbox-wrapper.mjs run
--provider blacksmith-testbox --help` also exits 0 and advertises the expected
Blacksmith Testbox provider.

Current runtime warning classification from `openclaw gateway status
--deep --require-rpc` and `openclaw doctor`:

- **Fix now:** none proven to block the running gateway, Slack delivery, Codex
  auth, or the repaired Crabbox/Testbox broad-gate path.
- **Track later:** legacy config-health JSON conflicts with shared SQLite
  state; doctor-preview model ref migrations; `memory-gardener` and
  `slack-expert` minimal profiles need explicit `alsoAllow: ["exec",
  "process"]` only if those agents should retain process tools; plaintext
  secret-bearing config fields should be migrated to SecretRefs by an operator;
  38 orphan transcript files can be archived by doctor when tenant cleanup is
  in scope; selected agents have lower `toolResultMaxChars` than the model auto
  cap.
- **Accept local residual for this plan:** gateway service PATH includes a Node
  version-manager path but the service is active and RPC-capable; disconnected
  `group:memory`, `books_receipts__*`, `mail_receipts__*`, and
  `slack_receipts__*` allowlist entries are inert unless those tools are
  connected; cron model overrides and isolated cron prompt jobs are
  informational; `previews` MCP `PYTHONPATH` is blocked for stdio safety;
  Slack receipts MCP names are normalized to provider-safe tool names; Graphiti
  MCP timed out during doctor validation; the escaped `last30days` skill
  symlink was skipped.

## 2026-06-27 Rebase Refresh And Broad-Gate Blockers

`ec-main` was refreshed onto the new `origin/main` without conflicts:

- refreshed `HEAD`: `2f3374bb96e887072c1b5bb88ba7c9f111385ae6`
- `origin/main`: `7bbd09047bd7ce1ce573e0d434abcf72a76de1f6`
- `origin/main...HEAD`: `0 334`

Lightweight local proof after the clean rebase:

- `git diff --check`: passed
- `node scripts/crabbox-wrapper.mjs --help`: passed with
  `../crabbox/bin/crabbox` version `0.33.0-240-g399c94a8`

The broad changed gate could not dispatch through any approved remote path in
the current operator environment:

- Blacksmith Testbox command:
  `node scripts/crabbox-wrapper.mjs run --provider blacksmith-testbox
  --blacksmith-org openclaw --blacksmith-workflow
  .github/workflows/ci-check-testbox.yml --blacksmith-job check
  --blacksmith-ref main --idle-timeout 90m --ttl 240m --timing-json -- env
  OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1
  CI=1 corepack pnpm check:changed`
  failed before allocation because `blacksmith` was not installed. The
  Blacksmith CLI was then installed to `~/.local/bin/blacksmith` and reports
  `blacksmith version 0.4.46`, but `blacksmith auth status` reports no
  authenticated organization and `blacksmith testbox list --all --org openclaw`
  fails with `not authenticated -- run 'blacksmith auth login' first`.
- Default Azure Crabbox command:
  `node scripts/crabbox-wrapper.mjs run --idle-timeout 90m --ttl 240m
  --timing-json -- env OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1
  OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 corepack pnpm check:changed`
  failed before allocation because `az` is not on `PATH` and
  `AZURE_SUBSCRIPTION_ID` is not configured.
- Brokered AWS Crabbox command:
  `node scripts/crabbox-wrapper.mjs run --provider aws --idle-timeout 90m
  --ttl 240m --timing-json -- env OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1
  OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 corepack pnpm check:changed`
  failed before allocation because the Crabbox broker is not configured; the
  wrapper requested `crabbox login --url https://crabbox.openclaw.ai --provider
  aws`.

These are external/authentication blockers rather than rebase failures. Direct
local `pnpm check:changed` remains intentionally skipped in this Codex worktree.

## Scope

This plan covers:

- restoring a usable Crabbox/Testbox path for repo-approved broad validation;
- running the broad changed gate for the current `ec-main` rebase;
- classifying any broad-gate failures as related to the rebase or unrelated
  current-main/runtime drift;
- triaging the post-live-patch doctor warnings into fixed-now, tracked-later, or
  explicitly accepted operator-local residuals.

## Non-goals

- Do not rerun the full rebase unless `origin/main` moves and the user asks for
  another upstream refresh.
- Do not replace Crabbox/Testbox with direct local `pnpm check*` in this Codex
  worktree unless repo policy changes or the user explicitly accepts that risk.
- Do not broad-clean unrelated tenant state just to make doctor output quiet.
- Do not change secrets, credentials, Slack workspace config, or MCP endpoints
  without an explicit operator decision.

## Fragile Areas To Preserve

Slack reliability and Codex auth remain the two special-watch areas from plan
0012. Any broad-gate failure touching these surfaces should get priority over
generic lint/test cleanup:

- Slack: Socket Mode receive/ack, history reconciliation, watchdog/why-silent
  diagnostics, interaction approvals, message dedupe, delivery attribution, and
  gateway/channel status.
- Codex auth: OpenAI/Codex OAuth compatibility, provider-owned reauth, profile
  precedence, persisted auth profile migration, model/auth status, and doctor
  guidance.

Do not treat a green generic broad gate as replacing these focused proofs. The
focused proofs already passed and should remain named in the final handoff.

## Work Phases

### 1. Reconfirm Baseline

- Fetch `origin/main` and verify `origin/main...HEAD` is still `0 334`.
- Verify `git status -sb` is clean and `fork/ec-main` still points at `HEAD`.
- Verify installed `openclaw --version` reports `2026.6.10 (8bb2ab3)`.
- Verify `openclaw gateway status --deep --require-rpc` still reports read
  probe `ok` and `admin-capable`.

If upstream has moved, pause and decide whether to rebase again before spending
time on broad validation.

### 2. Diagnose Crabbox Wrapper Failure

- Inspect `scripts/crabbox-wrapper.mjs` enough to identify how it selects the
  `crabbox` binary and what it expects from `--version` or `--help`.
- Run the selected `crabbox` binary directly with narrow diagnostic commands
  such as `--version`, `--help`, and any configured provider discovery command.
- Check whether the failure is caused by a missing binary, stale installed
  wrapper, provider configuration, environment, or a recent CLI contract change.
- Prefer a repair that preserves repo policy: make the wrapper select a valid
  binary or update the local installed Crabbox/Testbox toolchain rather than
  bypassing the wrapper.

Acceptance for this phase:

- `node scripts/crabbox-wrapper.mjs --help` exits 0, or
- the failure is proven external/unavailable with exact command output and a
  policy-compliant alternate Testbox path is identified.

### 3. Run Broad Changed Gate

Use the repo-approved broad validation path for Codex worktrees:

```bash
node scripts/crabbox-wrapper.mjs run ... -- env OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 corepack pnpm check:changed
```

Record the exact final command, run id or artifact pointer if Crabbox provides
one, exit status, and relevant failure logs.

If the broad gate fails:

- classify each failure as rebase-related, current-main/unrelated, environment,
  or flaky;
- fix rebase-related failures in the appropriate owner boundary;
- rerun the narrow failed lane first, then rerun the broad gate;
- do not bury Slack reliability or Codex auth regressions under unrelated broad
  failures.

Acceptance for this phase:

- broad changed gate passes, or
- the remaining failure is documented as external/unrelated with enough proof
  that it should not block the `ec-main` rebase handoff.

### 4. Triage Runtime And Doctor Warnings

Classify the post-live-patch warnings into buckets:

- **Fix now:** warnings that can affect current gateway reliability, plugin
  startup, Slack delivery, Codex auth, or broad validation.
- **Track later:** real cleanup work that is not part of this rebase gate.
- **Accept local residual:** operator-local state that is expected and should be
  reported but not changed during this plan.

Known warning candidates:

- gateway service PATH includes version-manager paths;
- legacy config health JSON conflicts with shared SQLite state;
- empty legacy auth profile JSON files remain for several agents;
- `group:memory`, `books_receipts__*`, `mail_receipts__*`, and
  `slack_receipts__*` allowlist entries do not match unless those MCP/plugin
  tools are connected;
- minimal tool profiles no longer implicitly widen `exec` and `process` for
  `memory-gardener` and `slack-expert`;
- plaintext secret-bearing config fields remain in `openclaw.json`;
- 29 orphan transcript files remain under main sessions;
- cron model override and isolated cron job findings are informational;
- `previews` MCP `PYTHONPATH` is blocked for stdio safety;
- Slack receipts MCP tools are normalized to provider-safe names;
- Graphiti MCP timed out during doctor schema validation;
- `last30days` skill symlink escape is skipped.

Acceptance for this phase:

- warnings with direct reliability impact are fixed or explicitly deferred with
  reason;
- no secret values are printed or committed;
- any remaining warnings are summarized in handoff with their blocker status.

### 5. Final Handoff

Final handoff should include:

- current `HEAD`, `origin/main...HEAD`, and branch push status;
- broad changed gate command and result;
- any Crabbox/Testbox repair made;
- Slack reliability and Codex auth proof status from plan 0012;
- installed CLI and gateway RPC status after any changes;
- doctor warning classification and remaining residuals;
- exact proof gaps, if any.

## Definition Of Done

This plan is done when:

- `ec-main` is still current on `origin/main`;
- `fork/ec-main` is still updated to the current `HEAD`;
- a repo-approved broad changed gate has passed, or an external blocker is
  proven and documented;
- the installed gateway remains healthy after any local repairs;
- Slack reliability and Codex auth remain explicitly protected in the closeout;
- doctor/runtime warnings are classified without changing secrets or unrelated
  tenant state.
