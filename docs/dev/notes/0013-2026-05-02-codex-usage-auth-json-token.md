# 0013 - 2026-05-02 - Codex Usage Auth JSON Token

## Summary

`openclaw channels list` can report:

```text
Usage:
  Codex: Token expired
```

even when all active `openai-codex` OAuth profile timestamps are valid and direct
usage endpoint calls succeed.

## Evidence

- Active runtime profiles `openai-codex:ecochran76`, `openai-codex:pcg`,
  `openai-codex:work`, and `openai-codex:soylei` had valid local OAuth expiry
  timestamps through 2026-05-10.
- Direct redacted calls to
  `https://chatgpt.com/backend-api/wham/usage` with each profile's access token
  returned HTTP 200.
- `loadProviderUsageSummary({ providers: ["openai-codex"], profileId })`
  returned `error: "Token expired"` for each active profile.

## Root Cause

The OpenAI Codex provider formats OAuth credentials for Codex model transport as
JSON:

```json
{ "token": "...", "accountId": "..." }
```

The usage hook reused that transport-formatted value through
`ctx.resolveOAuthToken()`, then `fetchCodexUsage()` sent the entire JSON string
as the Bearer token. The ChatGPT usage endpoint rejected that malformed
Authorization header with 401/403, which OpenClaw displayed as `Token expired`.

## Fix Direction

The Codex provider's `resolveUsageAuth` hook should unwrap transport-formatted
OAuth JSON before calling `fetchCodexUsage()`, preserving `accountId` metadata.

Focused regression coverage belongs in:

- `extensions/openai/openai-codex-provider.test.ts`

## Validation

```text
pnpm test extensions/openai/openai-codex-provider.test.ts
```

Result: 1 test file passed, 34 tests passed.
