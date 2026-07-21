# Plugin Update And Runtime Verification

State: CLOSED
Created: 2026-07-20

## Objective

Keep official external plugins aligned with the installed OpenClaw core, with
Codex and Slack treated as required runtime surfaces. Establish a repeatable
update path, repair the current stale Slack install, and prove both plugins in
the live Gateway.

## Current State

- The installed CLI and Gateway are OpenClaw `2026.7.2` at `711d5ea3794`.
- Codex is enabled and loaded at exact version `2026.7.2` from a reviewed local
  npm pack. Its session-catalog operation succeeds. The published stable
  version remains `2026.7.1-1`, so bulk update would be a downgrade.
- Slack is enabled and loaded as a trusted official npm install at published
  stable version `2026.7.1`. Both configured accounts are connected and pass
  HTTP 200 probes; a real send to the development channel returned a Slack
  platform receipt.
- Exa, Firecrawl, Perplexity, and TokenJuice are trusted official npm installs
  at their latest published stable version, `2026.7.1`.
- npm does not publish final `2026.7.2` packages for Slack or the four auxiliary
  plugins. Gateway version-drift warnings for those packages are therefore
  unavailable-package exceptions rather than pending actionable updates.
- The installed final core package omits SDK export-map entries required by
  current official packages even though the runtime modules are present. The
  installed package keeps the bounded compatibility export overlay, including
  `provider-http` and `provider-web-fetch-contract` for Firecrawl.

## Ownership And Update Contract

- Codex runtime, provider, session-catalog, and harness behavior remains owned
  by the external `@openclaw/codex` plugin.
- Slack transport, setup, channel lifecycle, and Socket Mode behavior remains
  owned by the external `@openclaw/slack` plugin.
- Normal maintenance uses catalog/npm-backed install records and
  `openclaw plugins update <id>` or `openclaw plugins update --all`.
- When an exact core-matching package is not published, build the plugin-owned
  runtime from the trusted exact source checkout, create an npm tarball, and
  reinstall it with `openclaw plugins install npm-pack:<tarball> --force`.
- Never copy source trees into the managed plugin root or edit generated plugin
  registry state directly.

## Execution

### Receipts: 2026-07-20

- Built and packed exact-source `2026.7.2` artifacts for Codex and Slack.
  The temporary tarball SHA-256 values were
  `76c90ec11215bebac115da1a383e5f694ab606b7e86e50613c32edcb27e36656`
  and `a4f13232bb8026db8a033fbffd28f67c8f047530f13cfcb65c9b4d644f6f9e1a`,
  respectively.
- Preserved the prior managed plugin directories, registry snapshot, plugin
  tarballs, and installed core package metadata outside the repository before
  installation.
- Reinstalled Codex from the exact local npm pack. Runtime inspection reports
  it loaded and enabled at `2026.7.2`, and a real `codex sessions` Gateway
  operation succeeded.
- Reinstalled Slack from the exact local npm pack. It loads at `2026.7.2`, both
  configured accounts connect, and both probes return HTTP 200 after restart.
- The source-built Slack runtime requires plugin-SDK exports missing from the
  installed final `2026.7.2` core package. A bounded installed-package export
  overlay currently supplies those existing runtime modules; this is a live
  compatibility measure, not a repository source change.
- Slack is not yet accepted as fully working: its ingress drain reports that
  `openKeyedStore` is available only to trusted plugins. Local `npm-pack`
  installs are intentionally untrusted even when built from the exact checkout.
- Tested the official `2026.7.2-beta.3` Slack package as the normal trusted
  package path. It rejects current final-version Slack configuration fields, so
  the exact local package was restored instead of deleting valid configuration.

Slack ingress now uses the trusted official package path, and the remaining
exact-version drifts are classified below as unavailable-package exceptions.

### Final Resolution

- Replaced the exact local Slack npm pack with the trusted official
  `@openclaw/slack@2026.7.1` registry package. This restored access to durable
  plugin state and eliminated the once-per-second ingress drain failures.
- Preserved `channels.slack.thread.requireExplicitMention=true`. Removed only
  the two newer tunables absent from the stable schema:
  `channels.slack.accounts.soylei.reconciliation` and
  `channels.slack.accounts.soylei.socketMode.connectionCount`. The complete
  pre-change config remains in the temporary recovery backup.
- Updated Exa, Firecrawl, Perplexity, and TokenJuice from `2026.6.10` to their
  latest published stable `2026.7.1` packages. Kept Codex at exact `2026.7.2`
  because `plugins update --all --dry-run` confirms that the registry path
  would downgrade it to `2026.7.1-1`.
- Added the two missing installed-core exports required by official Firecrawl
  `2026.7.1`, verified both ESM imports from the plugin package root, then
  restarted the Gateway. Firecrawl subsequently loaded with no diagnostics.
- Final runtime inspection reports Codex, Slack, Exa, Firecrawl, Perplexity,
  and TokenJuice loaded and enabled with empty diagnostics. All registry-backed
  packages report trusted official provenance; Codex intentionally remains a
  reviewed local npm-pack install.
- `openclaw codex sessions --limit 1 --json` returned a connected local Gateway
  host and a session. A real Slack message to `oc-dev-openclaw` returned
  platform message id `1784601380.799949` with delivery status `sent`.
- The final Gateway process is admin-capable and listening on both loopback
  families. Both Slack accounts are connected and healthy with no recorded
  error, zero reconnect attempts, and successful probes. The final restart
  window contains no relevant plugin, Codex, Slack ingress, or state-store
  errors.

### Phase 1: Build And Inspect Exact Artifacts

1. Build only the Codex and Slack package-local runtime outputs with
   `scripts/check-plugin-npm-runtime-builds.mjs`.
2. Pack each extension into a temporary directory outside the repository.
3. Require each tarball to identify the expected package and version and to
   contain `dist/index.js`, `openclaw.plugin.json`, and Slack's
   `dist/setup-entry.js`.
4. Record artifact hashes for rollback and provenance.

### Phase 2: Preserve And Install

1. Copy the current managed Codex and Slack package directories and the plugin
   registry snapshot to a temporary recovery directory.
2. Install the reviewed Codex `2026.7.2` npm tarball with `--force`.
3. Install the reviewed Slack `2026.7.2` npm tarball with `--force`.
4. Restart the managed Gateway once after both installs.

### Phase 3: Runtime Proof

1. Require `openclaw plugins inspect codex --runtime --json` to report loaded,
   enabled `2026.7.2` with Codex capabilities, tools, and command registration.
2. Require `openclaw plugins inspect slack --runtime --json` to report loaded,
   enabled `2026.7.2` with the Slack channel registration.
3. Require deep Gateway status, an admin-capable RPC probe, and a real listener
   on port 18789.
4. Require both configured Slack accounts to remain installed, configured, and
   enabled, and use the channel status/probe surface to verify active
   connectivity.
5. Run a Codex endpoint/session probe that exercises the loaded plugin rather
   than relying only on manifest inspection.
6. Inspect bounded restart-window logs and fail on Codex or Slack load/startup
   errors.

### Phase 4: Normalize Future Updates

1. When final `2026.7.2` or a later core-matching version is published, move
   Codex from its local npm tarball and update Slack through official package
   selectors:
   `openclaw plugins update @openclaw/codex` and
   `openclaw plugins update @openclaw/slack`.
2. Use `openclaw plugins update --all --dry-run` before future bulk updates,
   then update, restart, and repeat the runtime proof above.
3. Treat exact-version drift in any active official plugin as a failed update
   until repaired or explicitly documented as an unavailable-package exception.

## Rollback

- Keep the pre-install plugin directories and registry snapshot under `/tmp`
  until all live proof passes.
- If either plugin fails to load, reinstall its preserved package directory or
  prior tarball through the CLI, restart once, and repeat the same proof.
- Do not hand-edit `openclaw.json`, the generated registry, or managed npm
  project contents as a rollback mechanism.

## Definition Of Done

- Codex is installed, enabled, and loaded at the exact Gateway version. Slack
  is installed, enabled, and loaded from the latest trusted official stable
  package; the missing exact package is documented as an unavailable-package
  exception.
- Codex's registered runtime surfaces and one real endpoint/session operation
  succeed.
- Both Slack accounts remain configured and the Gateway reports live channel
  connectivity after restart.
- The Gateway passes deep RPC and listener proof with no relevant startup-log
  errors.
- Every other active registry-backed official plugin is on its latest published
  stable version, or has a documented unavailable-package exception.
- The plan contains exact execution receipts and is changed to `CLOSED`.
