State: OPEN
Created: 2026-06-26

# ec-main Rebase Compatibility Plan

## Current State

`ec-main` has a large upstream delta to absorb. After fetching on 2026-06-26:

- `origin/main` was `512f0f1bf7`.
- `ec-main` was `cd54c03768`.
- ancestry math showed `origin/main` ahead by 10699 commits and `ec-main`
  ahead by 337 commits.
- dry merge analysis reported 186 conflicted paths across auth/profile, agent
  runner, session/A2A, Slack, gateway, config, plugin SDK, provider/plugin, and
  voice surfaces.

The goal is to keep local features shaped like additive compatibility layers on
top of upstream direction, not as restored older subsystem forks.

## Scope

This plan covers the next `ec-main` rebase onto fresh `origin/main` and the
follow-up repairs that keep future rebases practical.

Feature families to preserve:

- profiles / auth / usage policy
- Slack / A2A approvals and relay behavior
- Slack / agent responsiveness, watchdogs, and history reconciliation
- automation command and status behavior
- voice / telephony / local STT
- outbound relay and bound-channel protections

## Fragile Areas That Need Extra Attention

Historically, two areas have broken after `ec-main` rebases more often than
other local feature families:

- Slack reliability: Socket Mode receive/ack behavior, tracked-turn routing,
  relay attribution, watchdog diagnostics, duplicate suppression, and now
  history reconciliation all sit across plugin, channel-status, and gateway
  seams. Treat Slack conflicts as runtime reliability conflicts, not just type
  or test conflicts.
- Codex auth: provider-formatted OAuth tokens, shared-client refresh behavior,
  profile selection, no-external-profile diagnostics, and model/status commands
  have repeatedly looked healthy in static config while failing at runtime.
  Treat Codex/OpenAI auth conflicts as live credential-flow conflicts, not just
  schema conflicts.

The rebase should preserve these behaviors by adapting them to upstream's
current ownership boundaries. Do not take an upstream or downstream side
mechanically in these files. For both areas, require source review, focused
tests, and live or near-live operator proof before considering the rebase done.

## Non-goals

- Do not remove local behavior just to reduce conflict count.
- Do not reintroduce older local file layouts when upstream has moved the
  concept to a newer seam.
- Do not make core depend on Slack-private implementation details when a plugin
  status/config contract can carry the needed facts.
- Do not resolve generated-file conflicts by hand before the source contract is
  reconciled.

## Conflict Forecast

### Profiles, Auth, And Codex OAuth

Likely paths:

- `extensions/codex/src/app-server/*`
- `extensions/openai/*`
- `src/agents/auth-profiles*`
- `src/commands/models/*`
- `src/infra/provider-usage*`
- `src/plugins/provider-*`

Preferred shape:

- keep provider-specific OAuth and shared-client behavior inside provider
  plugins when upstream has moved that ownership there;
- preserve local profile selection, quota/usage visibility, and no-external-
  profile status behavior as helpers layered onto upstream profile contracts;
- preserve provider-formatted OAuth token normalization and shared-client
  refresh semantics before asking for `/reauth` again;
- verify that Codex model/status commands read the same auth/profile source the
  runtime agent path will use;
- avoid reviving deleted provider-core bridges unless no plugin seam exists.

Extra checks:

- inspect the current Codex/OpenAI plugin auth path before resolving conflicts;
- prove both API-key and OAuth/profile paths still surface actionable status;
- if `/reauth` appears successful but runtime turns fail, debug the auth wrapper
  and shared-client path before treating it as an operator credential issue.

### Agent Runner And Tool Surface

Likely paths:

- `src/agents/embedded-agent-runner/*`
- legacy `src/agents/pi-embedded-runner/*` additions
- `src/agents/tools/sessions-*`
- `src/agents/openclaw-tools.sessions.test.ts`

Preferred shape:

- follow upstream renames from `pi-embedded-*` toward current embedded-agent
  runner names;
- port local behavior into the new runner modules instead of preserving stale
  paths;
- keep session/A2A target, relay, and permission behavior in small helpers or
  tool adapters rather than broad tool-file forks.

### Slack Receiver, Reconciliation, And Send Path

Likely paths:

- `extensions/slack/src/monitor/message-handler*`
- `extensions/slack/src/monitor/provider*`
- `extensions/slack/src/monitor/events/messages.ts`
- `extensions/slack/src/send*`
- `extensions/slack/src/config-ui-hints.ts`

Preferred shape:

- keep history reconciliation plugin-local under `extensions/slack`;
- call the normal Slack message handler for recovery instead of creating a
  separate reply path;
- bypass live-event debounce only for explicit history replay, and preserve the
  upstream Socket Mode lifecycle and ack model;
- preserve live duplicate suppression, history-replay dedupe reservations,
  ledger admission idempotency, and tracked-turn attribution together;
- keep name-based channel targeting narrow so reconciliation does not scan
  unrelated rooms in large workspaces;
- surface reconciliation state through sanitized account status fields, not by
  exposing ledger files or Slack-private state directly.

Extra checks:

- inspect receive, send, watchdog, tracked-turn, and reconciliation paths as one
  reliability surface;
- prove old thread roots, pending reply cursors, replay-dispatched messages,
  and live retry dedupe still behave correctly after conflict repair;
- preserve Slack runtime behavior through the external plugin/live patch path
  when the rebase changes deployed Slack code.

### Channel Status, Gateway Protocol, And Config

Likely paths:

- `src/channels/account-snapshot-fields.ts`
- `src/channels/plugins/types.core.ts`
- `src/gateway/protocol/schema/channels.ts`
- `src/config/types.slack.ts`
- `src/config/zod-schema.providers-core.ts`
- generated config metadata and docs baselines

Preferred shape:

- keep changes additive and optional on protocol/config contracts;
- sanitize plugin-owned runtime state before it reaches gateway clients;
- regenerate generated artifacts only after the source schemas and SDK contract
  are final;
- avoid channel-specific branches in core where generic status extras work.

### Auto-reply, Automation, And Delivery State

Likely paths:

- `src/auto-reply/reply/*`
- `src/auto-reply/fallback-state.ts`
- automation status and command surfaces
- outbound delivery runner files

Preferred shape:

- keep automation command/status UX in automation-owned helpers;
- preserve delivery attribution and progress behavior through existing outbound
  delivery contracts;
- avoid mixing Slack reconciliation recovery with generic auto-reply command
  routing.

### Voice And Media

Likely paths:

- `extensions/voice-call/*`
- `src/media-understanding/defaults.ts`
- media tool shared helpers

Preferred shape:

- preserve upstream provider/media defaults where possible;
- layer local STT/telephony behavior through plugin config and media-provider
  seams;
- validate with voice focused tests only after auth/session/Slack conflicts are
  already coherent.

## Rebase Execution Order

1. Create or confirm a clean `ec-main` checkpoint before starting the rebase.
2. Rebase onto fresh `origin/main`.
3. Resolve profiles/auth/Codex provider conflicts first, including shared-client
   OAuth behavior and model/status command diagnostics.
4. Resolve agent runner rename and session/A2A tool conflicts next.
5. Resolve Slack receiver, send, and reconciliation conflicts as one coherent
   plugin-local reliability slice.
6. Resolve channel status, gateway protocol, config schemas, and generated
   artifacts.
7. Resolve automation/outbound and voice/media conflicts.
8. Regenerate generated artifacts and docs baselines.
9. Run focused family gates, then broad checks/build.
10. Push `fork/ec-main` with `--force-with-lease`, then live patch with the
    external Slack plugin patch path if Slack runtime changed.

## Validation Plan

Minimum focused proof after conflict repair:

- `scripts/ec-main-rebase-gate.sh --family profiles`
- `scripts/ec-main-rebase-gate.sh --family slack-a2a`
- `scripts/ec-main-rebase-gate.sh --family slack-responsiveness`
- `scripts/ec-main-rebase-gate.sh --family automation`
- `scripts/ec-main-rebase-gate.sh --family voice`
- `pnpm check`
- `pnpm build`

Additional Slack reconciliation proof if the Slack conflicts are non-trivial:

- `node scripts/run-vitest.mjs extensions/slack/src/monitor/reconciliation.test.ts extensions/slack/src/monitor/provider.allowlist.test.ts extensions/slack/src/monitor/message-handler.test.ts src/commands/channels/why-silent.test.ts src/commands/channels/slack-watchdog-scan.test.ts src/channels/account-snapshot-fields.test.ts src/plugin-sdk/status-helpers.test.ts`
- `pnpm config:channels:check`

Additional Codex auth proof if Codex/OpenAI auth conflicts are non-trivial:

- focused tests for Codex/OpenAI auth profile loading, OAuth/shared-client
  refresh, model/status commands, and no-external-profile diagnostics;
- an operator-path smoke that confirms the runtime Codex agent path and CLI
  diagnostics agree on the active profile/auth source;
- if live credentials cannot be exercised, document the missing live proof and
  preserve a concrete reproduction command for the next operator.

## Definition Of Done

- `ec-main` rebases onto fresh `origin/main` with local features preserved.
- Rebase repairs follow current upstream ownership and naming rather than
  restoring stale local structures.
- Slack receive/send/reconciliation/watchdog behavior and Codex auth/profile
  behavior have explicit focused proof or a documented live-proof blocker.
- Generated artifacts match their source schemas.
- Focused family gates pass; broad check/build pass or any unrelated upstream
  failure is documented with scoped proof.
- `fork/ec-main` is updated with `--force-with-lease`.
- Live patch uses the plugin-aware path when external Slack runtime code changes.
