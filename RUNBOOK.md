# OpenClaw `ec-main` Runbook

This runbook is a dated log of planning-contract and execution events that should remain discoverable across sessions.

## Turn 1 | 2026-04-20

- Adopted serialized planning, notes, and memory conventions from the repo-policy-selector policy library.
- Created `docs/dev/plans/0001-2026-04-20-plugin-survivability-roadmap.md` as the first active serialized plan.
- Created `docs/dev/notes/0001-2026-04-20-policy-layer-and-planning-convention-adoption.md`.
- Created `docs/dev/memories/0001-2026-04-20-ec-main-continuity-conventions.md`.

## Turn 2 | 2026-04-20

- Implemented the first plugin-survivability slice from `docs/dev/plans/0001-2026-04-20-plugin-survivability-roadmap.md`.
- Moved the OpenAI Codex chat reauth capability object into `src/plugins/provider-openai-codex-oauth.ts`.
- Added the generic `ChatReauthCapability` type to `src/plugins/provider-auth-types.ts`.
- Kept `src/auto-reply/reply/reauth-capabilities.ts` as a provider-neutral lookup surface.
- Validation passed:
  - `pnpm test -- src/auto-reply/reply/reauth-capabilities.test.ts src/auto-reply/reply/commands-reauth.test.ts src/plugins/provider-openai-codex-oauth.chat-reauth.test.ts src/plugins/provider-openai-codex-oauth.test.ts src/commands/models/auth.test.ts`
  - `pnpm build`
