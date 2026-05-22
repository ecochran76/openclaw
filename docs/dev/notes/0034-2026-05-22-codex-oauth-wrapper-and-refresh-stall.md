# Codex OAuth Wrapper And Refresh Stall

Date: 2026-05-22

## Context

After the upstream transition from the Pi-era Codex path to the newer Codex
plugin/app-server integration, the live `ec-main` gateway degraded again even
though `/status` and `openclaw models auth list` showed valid OpenAI Codex
OAuth profile expirations.

The user-visible symptoms were:

- Slack turns appeared to stall or silently fail after progress started.
- `/reauth openai-codex:soylei` could update stored credentials, but the live
  model probe timed out.
- Command-lane logs reported timeouts such as
  `auth-probe:openai-codex:openai-codex:soylei`.
- Backend calls failed with `Could not parse your authentication token`.
- App-server fallback hit `auth refresh request timed out after 10s`.

## Findings

Two related but distinct defects were present.

First, embedded OpenAI Codex turns could receive a provider-formatted OAuth
credential value:

```json
{ "token": "...", "accountId": "..." }
```

That JSON wrapper is valid provider metadata, but it is not a bearer token. The
embedded PI/OpenAI transport was passing the whole JSON string as the
Authorization bearer value, which produced the backend parse error.

Second, Codex app-server `account/chatgptAuthTokens/refresh` requests forced a
refresh-token rotation even when OpenClaw already had a valid, unexpired access
token. That made harmless app-server token requests vulnerable to
refresh-token-reuse and timeout failures, then poisoned profile cooldown state
for otherwise usable credentials.

The runtime proof split the problem cleanly:

- direct redacted backend smokes with stored access tokens succeeded;
- gateway embedded turns failed before the wrapper normalization fix;
- app-server fallback failed in the refresh request path before the soft-refresh
  fix;
- the same gateway probe succeeded after both fixes were live-patched.

## Fixes Applied

- `extensions/codex/src/app-server/auth-bridge.ts` unwraps OpenAI Codex
  provider-formatted OAuth JSON only at the Codex app-server bridge/cache-key
  boundary where it must become a raw bearer token.
- `extensions/codex/src/app-server/auth-bridge.ts` treats app-server
  refresh-token requests as soft refreshes when the current OAuth access token
  is still valid beyond a small skew window.
- `extensions/codex/src/app-server/shared-client.ts` keys the shared app-server
  client on a redacted auth account/token fingerprint, so token/profile rotation
  restarts the app-server instead of reusing a stale child.
- `src/agents/pi-embedded-runner/stream-resolution.ts` keeps OpenAI Codex on the
  boundary-aware transport instead of provider-owned PI wrappers that can lose
  Codex-specific auth/header semantics.

## Validation

Focused regression checks:

```bash
node scripts/run-vitest.mjs extensions/codex/src/app-server/auth-bridge.test.ts extensions/codex/src/app-server/config.test.ts extensions/codex/src/app-server/shared-client.test.ts
node scripts/run-vitest.mjs src/agents/auth-profiles/oauth.test.ts src/agents/pi-embedded-runner/stream-resolution.test.ts -t "OpenAI Codex|Codex|boundary-aware|config compatibility"
git diff --check
pnpm build
```

Observed results:

- focused auth/streaming regression group: 15 files passed, 703 tests passed
- auth-profile focused check: 2 files passed, 34 tests passed
- `git diff --check`: passed
- `pnpm build`: passed

Live runtime validation:

```bash
scripts/patch-live-openclaw.sh --expect-branch ec-main --require-expected-branch --patch-external-plugins
openclaw gateway status --deep --require-rpc
openclaw agent --session-key agent:main:diagnostic:codex-auth-normalized-20260522 --message 'Reply with exactly OK.' --timeout 120 --json
```

Observed result:

- live patch installed core and external Slack plugin tarballs and restarted the
  gateway;
- gateway RPC was healthy on Node 24.14;
- clean gateway probe returned exactly `OK` through `openai-codex/gpt-5.5` in
  about 14 seconds with `runner: embedded` and no fallback.

## Rebase Watchpoints

- Preserve Codex OAuth JSON unwrapping at the app-server bridge/cache-key
  boundary. Do not unwrap it in the generic auth-profile resolver; normal
  OpenAI Codex responses auth may need the `accountId` metadata.
- Do not force OAuth refresh merely because Codex app-server asks for refreshed
  ChatGPT tokens; return the current valid access token unless it is near
  expiry.
- Keep app-server shared-client cache keys sensitive to auth account/token
  generation, but only through redacted fingerprints.
- After rebases touching Codex, validate with a live gateway agent probe, not
  only `models auth list` or `/status`; those can prove stored expiry state
  without proving the actual model transport.

## Related Notes

- `0013-2026-05-02-codex-usage-auth-json-token.md`
- `0029-2026-05-16-codex-plugin-rebase-survivability.md`
