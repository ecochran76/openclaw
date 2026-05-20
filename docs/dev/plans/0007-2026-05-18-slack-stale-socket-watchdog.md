# Slack Stale-Socket Watchdog

State: OPEN
Created: 2026-05-18

## Current State

Slack Socket Mode can recover to an apparently healthy state while a human
message sent during or shortly after a stale-socket lapse is never admitted into
OpenClaw. When this happens, Slack has the message, but OpenClaw has no session
record, queue record, delivery record, wake-trigger record, or explicit ignore
record. The operator experience is indistinguishable from being ignored.

The current permalink inspection work can identify a missing admission after a
human reports a specific message. The missing product behavior is a
deterministic sidecar watchdog that independently compares Slack reality
against OpenClaw admission records and alerts or recovers when there is a gap.

On 2026-05-20, SoyLei `#ask-lei` showed the same missing-admission shape for
`/status` at `1779309189.369149`: Slack history contained the message, gateway
status reported the SoyLei Socket Mode account as connected/healthy, but
`lastInboundAt` was still `null` and `lastTransportActivityAt` had not advanced
since the 15:13:40 stale-socket restart. As an immediate mitigation, the default
transport-stale threshold was tightened from 30 minutes to 10 minutes. That
shrinks the silent Socket Mode exposure window, but it does not replace the
admission-ledger/watchdog work below.

## Scope

- Add a Slack-plugin-owned watchdog that can run as a separate user process from
  the gateway.
- Poll Slack Web API history for configured Slack accounts and bound channels.
- Compare recent relevant Slack messages against an OpenClaw admission ledger.
- Notify an operator when Slack saw a message that OpenClaw did not admit.
- Add guarded replay only after detection and notification are reliable.
- Keep Slack polling, scopes, permalink resolution, and channel semantics in the
  Slack plugin.
- Add only narrow core/plugin-sdk seams when the Slack plugin needs a generic
  admission ledger or synthetic inbound replay contract.

## Non-Goals

- Do not build blind automatic replay in the first slice.
- Do not make Slack Mirror a hard runtime dependency for watchdog operation.
- Do not encode local tenant ids, channel ids, or user-specific policy in
  product code.
- Do not move Slack-specific polling or permalink behavior into core.
- Do not treat bot-authored API smoke messages as proof of human Slack Events
  delivery unless the delivery semantics are explicitly verified.

## Architecture

The durable home is the Slack plugin:

- `extensions/slack`: watchdog implementation, Slack Web API history polling,
  account/channel config, permalink resolution, notification rendering, and
  Slack-specific recovery UX.
- core or `openclaw/plugin-sdk`: admission-ledger and synthetic-inbound replay
  contracts only if existing runtime seams are insufficient.
- runtime config under `~/.openclaw`: watched accounts/channels, polling window,
  notification target, replay mode, and rate limits.

The watchdog should be usable as a short-lived scan command and later as a
systemd user timer or other scheduled sidecar. It should not depend on the
gateway Socket Mode listener being healthy, because the gateway listener is the
component whose missed admissions it is checking.

## Phases

1. Admission ledger.
   - Write a durable, append-friendly admission record when Slack inbound
     handling accepts, drops, ignores, or suppresses a message.
   - Key records by account id, channel id, message timestamp, thread
     timestamp, client message id when available, route agent id, and outcome.
   - Include stable reason codes for explicit ignores/drops.
   - Redact message body by default; preserve enough hash/preview metadata for
     diagnostics without leaking full content into broad logs.

2. Read-only detector.
   - Add a Slack-plugin command or script that polls recent Slack history using
     the bot token.
   - Limit the first slice to configured/bound channels and recent windows.
   - Detect messages that are likely intended for OpenClaw:
     direct bot mention, bound-agent mention, DM, or active-thread policy match.
   - Report `admitted`, `explicitly-ignored`, `not-relevant`, or
     `missing-admission`.
   - Support a permalink-targeted mode for post-mortem work and a bounded
     account/channel scan mode for scheduled checks.

3. Notification mode.
   - Add a guarded notification target for missing admissions.
   - Include permalink, account id, channel id, message timestamp, intended
     agent when known, ledger verdict, and nearby Slack health events.
   - Coalesce duplicate alerts for the same Slack message.
   - Make notification failure visible in the watchdog result instead of hiding
     it behind gateway logs.

4. Guarded recovery.
   - Add an operator-approved replay path for one missed message.
   - Prefer synthetic inbound injection with explicit provenance over reposting
     the Slack message.
   - Refuse replay when the ledger later shows the original was admitted.
   - Record replay attempts and outcomes in the ledger.
   - Expose the recovery action through a CLI command first; consider Slack
     buttons only after CLI behavior is proven.

5. Runtime installation.
   - Package the scanner as a Slack-plugin-owned entrypoint.
   - Add a documented user-scope systemd timer or cron recipe that runs the
     read-only scan.
   - Keep default mode notify-only.
   - Add `openclaw doctor` or channel status visibility for watchdog freshness
     if the process becomes part of the supported runtime.

## Acceptance Criteria

- A known missed Slack permalink can be classified as
  `missing-admission` without reading raw gateway logs.
- A normally handled Slack permalink can be classified as `admitted` with the
  matching OpenClaw admission record.
- A deliberately ignored or policy-dropped Slack message is classified with an
  explicit reason, not as a stale-socket miss.
- A scheduled scan can alert once for a missed mention and then stay quiet on
  subsequent scans unless the state changes.
- Recovery is idempotent and provenance-marked before it can be enabled by
  default.
- The feature is validated through focused Slack plugin tests and the
  `slack-responsiveness` feature-family gate.

## Definition Of Done

- Slack plugin owns the watchdog code and docs.
- Core changes, if any, are narrow generic seams rather than Slack policy.
- Operator can run a read-only scan over a permalink or recent channel window.
- Missing-admission alerts include enough evidence to debug without guessing.
- Replay remains disabled or approval-gated until detection has live evidence.
- The local feature index points to this plan as the stale-socket reconciliation
  roadmap.

## Related Notes

- `docs/dev/notes/0030-2026-05-18-slack-stale-socket-missed-mention.md`
- `docs/dev/plans/0004-2026-04-29-slack-cold-start-hardening.md`
