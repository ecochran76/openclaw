State: COMPLETE
Created: 2026-05-30

# Slack Socket Mode Hardening

## Current State

Plans `0008` and `0009` improved Slack receiver observability and diagnostics,
but the live SoyLei miss shows OpenClaw still cannot rely on a single Socket
Mode connection as the only real-time receiver. Active history reconciliation
is the durable correctness layer, but Socket Mode should still be hardened so
the fast path misses fewer events.

Slack's Socket Mode contract includes several reliability levers OpenClaw does
not fully use yet:

- multiple concurrent WebSocket connections per app;
- graceful connection refresh before Slack's scheduled disconnects;
- lifecycle/active-state health instead of inferred stale timestamps;
- configurable ping/pong timeouts;
- immediate acknowledgement of envelopes before expensive business work;
- clear classification of Slack refresh disconnects versus network errors.

## Goal

Make Socket Mode a stronger low-latency receiver before active reconciliation is
enabled broadly. The result should reduce missed live events, make reconnects
graceful, and ensure Socket Mode failures are concrete and diagnosable.

## Non-Goals

- Do not replace active history reconciliation.
- Do not add SoyLei-specific behavior.
- Do not use multiple Slack apps for one account.
- Do not route duplicate events into duplicate agent turns.
- Do not hide admission failures behind generic socket restarts.

## Phase 1: Ack Path Audit

- Verify Bolt's automatic Events API ack behavior for Socket Mode in the
  installed SDK version.
- Add tests that prove message/app_mention envelope ack is not delayed by:
  - auth metadata hydration;
  - channel/user allowlist resolution;
  - message preparation;
  - agent dispatch;
  - reply delivery.
- For interactions, slash commands, and option requests, keep explicit `ack()`
  calls before expensive work.

Acceptance:

- A slow message handler still acknowledges the Socket Mode envelope promptly.
- A thrown handler records the failure without suppressing ack/retry semantics.
- Interactive/slash handlers continue to ack inside Slack's expected window.

## Phase 2: Active-State Health

- Use the SDK's real WebSocket active state when available, not only cached
  `connected` status.
- Expose active-state status through channel health:
  - active;
  - connecting/reconnecting;
  - disconnecting/disconnected;
  - active-state unknown.
- Preserve `lastSocketEnvelopeAt` and `lastSlackEventAt` as receiver facts, not
  as the sole health source.

Acceptance:

- A Socket Mode client with inactive WebSocket state is unhealthy even if an old
  connected flag remains true.
- A quiet but active WebSocket is healthy.
- Health output names whether active-state probing was available.

## Phase 3: Proactive Refresh Handling

- Classify Slack disconnect reasons:
  - `warning`;
  - `refresh_requested`;
  - `link_disabled`;
  - network/transport errors;
  - unknown.
- Treat `warning` and `refresh_requested` as expected lifecycle refreshes.
- Start a replacement connection immediately for expected refresh events instead
  of routing through generic error backoff.
- Keep auth/token errors as non-recoverable.

Acceptance:

- Refresh disconnects do not create a long no-receiver gap.
- Network errors still use bounded backoff.
- Operator status distinguishes expected refresh from outage.

## Phase 4: Multi-Connection Fast Path

- Add opt-in account config:
  - `channels.slack.accounts.<id>.socketMode.connectionCount`
  - default `1`, max `10`.
- Start multiple Socket Mode receivers for one account when configured.
- Share message/event dedupe across those receivers:
  - Slack `envelope_id`;
  - message `channel:ts`;
  - durable inbound-delivery state before dispatch.
- Record per-connection lifecycle and aggregate account health.

Acceptance:

- Two connections can receive events without duplicate admissions.
- If one connection disconnects, the account remains healthy while another is
  active.
- Status reports connection count and per-connection fault summaries.

## Phase 5: Ping/Pong Profiles

- Keep per-account ping/pong tuning.
- Document recommended profiles:
  - production: shorter dead-socket detection;
  - desktop/dev: more tolerant of local stalls;
  - flaky networks: longer timeout with active reconciliation enabled.
- Add tests that preserve configured `clientPingTimeout`,
  `serverPingTimeout`, and `pingPongLoggingEnabled`.

Acceptance:

- Existing config remains backward compatible.
- Status exposes effective ping/pong settings without secrets.

## Phase 6: Live Proof

- Patch live OpenClaw and the Slack plugin.
- Enable Socket Mode hardening for SoyLei in observation mode first.
- Run controlled probes in `ask-lei`:
  - explicit top-level mention;
  - explicit thread mention;
  - self/bot event;
  - non-mentioned channel message.
- Verify:
  - no duplicate replies;
  - raw receiver counters advance;
  - admission ledger records expected outcomes;
  - refresh/reconnect events do not produce missed-admission windows.

Acceptance:

- Controlled events are admitted or explicitly dropped.
- Expected Slack refresh does not produce a silent receiver gap.
- A forced single-connection disconnect is tolerated when multi-connection mode
  is enabled.

## Definition Of Done

- Socket Mode health is based on real active/lifecycle state.
- Expected Slack refreshes are handled as refreshes, not outages.
- Optional multi-connection mode works without duplicate agent turns.
- Ack timing is proven for message/app_mention, interactions, slash commands,
  and options.
- Active reconciliation can be enabled afterward as a correctness backstop, not
  as compensation for avoidable Socket Mode gaps.

## Implementation Status

Implemented in source:

- Socket Mode active-state probing from the Slack SDK websocket.
- Per-connection Socket Mode lifecycle snapshots and aggregate account status.
- Slack disconnect envelope classification for `warning`, `refresh_requested`,
  `link_disabled`, network-like reasons, auth-like reasons, and unknown reasons.
- Immediate reconnect after expected Slack refresh disconnects.
- Account-level `channels.slack.accounts.<id>.socketMode.connectionCount`
  config, default `1`, max `10`.
- Multi-connection Socket Mode startup using one shared message context so
  existing in-memory and persistent inbound delivery dedupe gates duplicate
  agent turns.
- Effective Socket Mode settings status through `socketModeSettings`, including
  `clientPingTimeout`, optional `serverPingTimeout`, optional
  `pingPongLoggingEnabled`, and effective `connectionCount`, without Slack
  tokens or webhook secrets.
- Status/schema propagation for active-state, connection count,
  per-connection summaries, receiver counters, effective Socket Mode settings,
  and disconnect reasons.
- Slack operator docs now include production, desktop/dev, and flaky-network
  Socket Mode profiles, plus status verification guidance.

Verified:

- Focused Slack/provider/status tests cover active-state health, refresh
  classification, disconnect-envelope recording, Socket Mode ping/pong config,
  multi-connection startup/status, message/app_mention pre-pipeline ack timing,
  config schema validation, generated channel metadata, and snapshot
  projection.
- Focused Slack/status/watchdog coverage passed with 12 files and 191 tests:
  `extensions/slack/src/monitor/provider.allowlist.test.ts`,
  `extensions/slack/src/monitor/provider.interop.test.ts`,
  `extensions/slack/src/monitor/provider.reconnect.test.ts`,
  `extensions/slack/src/config-schema.test.ts`,
  `src/channels/account-snapshot-fields.test.ts`,
  `src/plugin-sdk/status-helpers.test.ts`,
  `src/gateway/channel-health-policy.test.ts`,
  `src/commands/channels/status.test.ts`,
  `src/commands/channels/slack-watchdog-scan.test.ts`, and
  `src/commands/channels/why-silent.test.ts`.
- `pnpm tsgo:core`, `pnpm tsgo:extensions`, `git diff --check`,
  `pnpm config:channels:check`, focused Slack/status/watchdog Vitest coverage,
  and `pnpm build` passed before live patch.
- Live OpenClaw and the installed Slack plugin were patched from a built
  tarball, and gateway RPC recovered after restart.
- SoyLei Slack now runs with
  `channels.slack.accounts.soylei.socketMode.connectionCount = 2`.
- Live `openclaw channels status --deep --json` showed SoyLei
  `socketConnectionCount: 2`, with `primary` and `socket-2` both
  `socketActiveState: active` and `healthState: healthy`.
- Live status after the final patch showed SoyLei `socketModeSettings` as
  `clientPingTimeout: 30000`, `serverPingTimeout: 45000`,
  `pingPongLoggingEnabled: false`, and `connectionCount: 2`, with no Slack
  secrets exposed.
- Live top-level explicit mention probe in `ask-lei`
  (`C0B0AK14B7X`, `1780195257.319299`, nonce `oc-smh-001`) produced one
  admission ledger record, one Lei reply at `1780195259.352969`, and no
  duplicate reply.
- Live explicit thread mention probe in `ask-lei`
  (`C0B0AK14B7X`, parent `1780195257.319299`, reply `1780195348.201739`,
  nonce `oc-smh-002`) produced one in-thread Lei reply at
  `1780195351.398409`.
- Live non-mention control in `ask-lei`
  (`C0B0AK14B7X`, `1780195355.147999`, nonce `oc-smh-003`) was admitted by
  the channel's current policy and recorded in the channel session/trajectory
  with no incomplete runs; it did not indicate a receiver miss.
- The same live status sample showed receiver counters advancing:
  `rawSocketEnvelopes`, `rawSlackEvents`, `messageEvents`,
  `admissionsRecorded`, and `preparedForDispatch`.
- The earlier user-reported permalink
  `C0B0AK14B7X:1780182187.975599` was confirmed by watchdog scan as
  `missing-admission` with reason `activation-without-ledger-record`, while a
  later replay/transcript sidecar exists. That separates the original failure
  from ordinary model/reply latency.
- A scoped diagnostic disconnect hook exercised `socket-2` with
  `refresh_requested`; SoyLei remained healthy with two active connections,
  status recorded the expected refresh disconnect, and the socket reconnected
  immediately.
- Post-refresh live probe in `ask-lei`
  (`C0B0AK14B7X`, `1780196523.145249`, nonce `oc-smh-004`) was admitted and
  replied to once at `1780196527.342649`.
- Bot/self control records in watchdog/status were classified as
  `not-relevant` / `bot-message`, and runtime counters recorded
  `droppedSelfBotEvents`.
