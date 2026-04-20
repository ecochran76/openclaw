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

## Turn 3 | 2026-04-20

- Implemented the second plugin-survivability slice from `docs/dev/plans/0001-2026-04-20-plugin-survivability-roadmap.md`.
- Kept core A2A permission approval payloads generic by emitting text plus `channelData.a2aApproval` metadata from `src/agents/a2a/permission-approval-reply.ts`.
- Moved Slack approval button presentation into Slack-owned helpers in `extensions/slack/src/interactive-replies.ts`.
- Kept Slack A2A approval rendering independent from the optional inline interactive-replies capability toggle.
- Updated core and Slack tests so core asserts safety metadata while Slack asserts Slack-specific interactive rendering.
- Validation passed:
  - `pnpm test -- src/agents/openclaw-tools.sessions.test.ts src/agents/a2a/permission-approval-action.test.ts src/agents/pi-embedded-subscribe.handlers.tools.test.ts extensions/slack/src/monitor/events/interactions.test.ts extensions/slack/src/channel.test.ts extensions/slack/src/interactive-replies.test.ts`

## Turn 4 | 2026-04-20

- Stabilized the first failing-test slice observed after the plugin-survivability work.
- Isolated gateway auth tests from live `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD` environment credentials so local operator secrets cannot change expected unauthenticated request behavior.
- Isolated auth-profile store tests from live `CODEX_HOME` so real Codex CLI profile state cannot be imported into temp fixture stores.
- Split Codex CLI OAuth reuse from runtime overlays: Codex CLI credentials can still be used as explicit usable bootstrap credentials, but they no longer silently overlay persisted profile health/status or agent runtime store state.
- Kept expired external CLI credentials from replacing the canonical OAuth refresh context.
- Updated auth-profile state tests for the current storage contract: order, last-good, and usage stats live in per-agent `auth-state.json`, while `auth-profiles.json` stores secret-bearing credentials.
- Validation passed:
  - `pnpm test -- src/gateway/auth.test.ts src/gateway/call.test.ts src/gateway/server-runtime-config.test.ts src/gateway/server.auth.compat-baseline.test.ts src/gateway/server.auth.control-ui.test.ts src/agents/auth-health.test.ts src/agents/auth-profiles.external-cli-sync.test.ts src/agents/auth-profiles/external-oauth.test.ts src/agents/auth-profiles/oauth.openai-codex-refresh-fallback.test.ts src/agents/auth-profiles/profiles.test.ts src/agents/auth-profiles.runtime-snapshot-order.test.ts src/agents/auth-profiles.runtime-snapshot-external-update.test.ts src/agents/auth-profiles.ensureauthprofilestore.test.ts`
