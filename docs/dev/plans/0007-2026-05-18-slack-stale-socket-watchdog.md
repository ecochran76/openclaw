# Slack Stale-Socket Watchdog

State: COMPLETED
Created: 2026-05-18
Completed: 2026-05-29

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
   - 2026-05-20: first reusable scanner helper landed in the Slack plugin
     monitor layer. It classifies supplied Slack history against the admission
     ledger as `admitted`, `explicitly-ignored`, `not-relevant`, or
     `missing-admission`. The scheduled sidecar/CLI wrapper is still pending.
   - 2026-05-20: the scanner and `channels watchdog-scan` wrapper were updated
     to use Slack channel policy. Configured channels with
     `requireMention=false` are eligible even without a bot mention, subject to
     the configured channel user allowlist. The SoyLei `#ask-lei` Baker incident
     validated this path: the read-only scan marked both missed top-level
     messages as `missing-admission` while recognizing a later handled thread
     reply as `admitted`.

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

## Detailed Next Slice: Human Alerts And Missed-Message Reply

Created: 2026-05-29

### Problem Statement

The current watchdog can classify a Slack-visible message as
`missing-admission` and can post a deduped operator alert, but the alert is still
machine-shaped. It reports terse fields such as `new_missing`, raw timestamps,
and `activation-without-ledger-record`. That is useful evidence for a developer,
but it does not immediately tell an operator or channel user what happened.

The user-facing failure is worse in the source Slack channel: the person who
sent the missed message sees no acknowledgement. The watchdog should make the
miss visible by replying to the missed Slack message itself, with clear wording
that OpenClaw missed the message and that recovery is pending, skipped, or
completed.

### Scope For This Slice

- Keep the scanner read path unchanged: Slack history through
  `openclaw channels watchdog-scan`, gateway-backed Slack `read`, and the
  admission ledger remain the source of truth.
- Replace terse operator alert prose with a human-readable summary:
  workspace, channel, local time window, count of missed messages, what the
  watchdog checked, and what the operator should do next.
- Include one concise evidence block per missed message: permalink or channel
  and timestamp, sender if available, thread status, intended agent if known,
  verdict, and plain-English cause.
- Add a separate channel/user acknowledgement write path that replies in the
  thread of each new missed message.
- Keep source-channel replies disabled by default until tests prove idempotency
  and wording. Enable with an explicit CLI option first.
- Record source-channel reply attempts in the watchdog alert state so repeated
  scans do not post repeated apologies or recovery notices.
- Do not perform automatic synthetic inbound replay in this slice. The source
  reply may say recovery is operator-approved, but it must not imply the
  original request was processed unless replay has actually succeeded.

### CLI Shape

Extend `openclaw channels watchdog-scan` with explicit, write-gated options:

- `--alert-target <dest>` remains the operator notification target.
- `--reply-missed` enables a Slack thread reply on newly detected missed
  messages.
- `--reply-account <id>` selects the Slack account used for source replies,
  defaulting to the scanned account.
- `--reply-state <path>` optionally separates source-reply dedupe state from
  operator-alert dedupe state.
- `--dry-run-replies` renders planned source replies into JSON or terminal
  output without sending them.
- `--max-replies <n>` caps source-channel replies per scan, defaulting to a
  small number such as `3`.

The command should reject `--reply-missed` unless a missing-admission result was
found and the message has a usable channel and timestamp. It should continue to
support `--json` with structured fields for alert attempts, source reply
attempts, skipped-known counts, and per-message send errors.

### Human-Readable Operator Alert

Replace the current alert body with copy shaped for a human operator:

```text
OpenClaw missed 1 Slack message that looked eligible for Lei.

Where: SoyLei #ask-lei
When checked: May 28, 2026, 9:19:08 PM CDT to 9:34:08 PM CDT
What checked: Slack history vs OpenClaw admission ledger

Missed message:
- May 28, 2026, 9:32:27 PM CDT
- Slack ts: 1780021947.219859
- Thread: top-level
- Reason: Slack has the message, but OpenClaw has no admission, ignore, session, or trajectory record.

Next action: run the guarded replay command or inspect the permalink before replay.
```

For multiple misses, include a capped list plus `... N more`. Avoid internal
reason codes in the first line. Keep raw ids in the evidence lines because they
are useful for follow-up commands.

### Missed-Message Source Reply

When `--reply-missed` is enabled, post a threaded Slack reply to the missed
message. For a top-level message, use the missed message `ts` as `thread_ts`.
For an existing thread reply, use the message `thread_ts` so the notice stays in
the active thread. The reply should be short and explicit:

```text
OpenClaw missed this message before it reached Lei. I have flagged it for recovery so it is not silently ignored.
```

If a guarded replay is later implemented and succeeds, post a second follow-up
only from the replay path:

```text
Recovery complete: OpenClaw has replayed this missed message into Lei.
```

If replay is refused because an admission record appears later, the watchdog
should not post the "missed" reply. It should classify the result as admitted
or already handled.

### Idempotency And State

Extend watchdog state from a single alert timestamp per message to separate
per-action state:

- `operatorAlertedAt`
- `sourceRepliedAt`
- `sourceReplyTs`
- `replayAttemptedAt`
- `replayOutcome`

Keep the state key stable: account id, channel id, message ts, client message
id when present, and thread ts. If the current JSON state format is already in
use, migrate it at read time by treating a string value as
`operatorAlertedAt`.

State updates should happen only after Slack confirms the send. Failed sends
must be reported in JSON and terminal output without marking the action done.

### Implementation Lanes

1. Refactor alert formatting.
   - Split `formatSlackWatchdogAlert` in
     `src/commands/channels/slack-watchdog-scan.ts` into small pure helpers:
     summary line, scan context, missed-message evidence, and next action.
   - Add tests that assert human-readable wording and keep raw ids available.

2. Add permalink and sender facts.
   - Carry sender id, bot id, subtype, and a redacted text preview or hash into
     watchdog records only when needed for display.
   - Build Slack permalinks when team domain/workspace metadata is available;
     otherwise fall back to channel and timestamp.
   - Do not store full message text in broad alert state.

3. Add source-reply rendering.
   - Add a pure `formatSlackMissedMessageReply` helper.
   - Keep wording neutral: missed before admission, flagged for recovery, no
     promise that an agent has already processed it.
   - Test top-level and thread-reply targeting.

4. Add source-reply send path.
   - Send through gateway `message.action` `send`, same as operator alerts,
     but target the original channel and pass the correct Slack `thread_ts` if
     the send contract supports it.
   - If the generic gateway send contract cannot express Slack thread replies,
     add a narrow Slack-plugin-owned send helper rather than adding Slack policy
     to core.
   - Return structured per-message results in the JSON report.

5. Harden state handling.
   - Replace string-only alert state with an object state while keeping read
     compatibility with existing string values.
   - Deduplicate operator alerts and source replies independently.
   - Add tests for repeated scans: first scan alerts and replies, second scan
     reports skipped-known and sends nothing.

6. Add guarded replay design hooks.
   - Do not replay automatically in this slice.
   - Reserve report fields for replay readiness: `replayEligible`,
     `replayBlockedReason`, and `suggestedReplayCommand`.
   - The future replay command must re-read the ledger immediately before
     injection and refuse if the original message is now admitted.

7. Improve live diagnostics.
   - Add nearby channel health facts to the operator alert when available:
     current `healthState`, last transport activity age, last inbound age, and
     latest stale-socket restart if known.
   - Keep this diagnostic optional. The detection must still work when the
     gateway status call is unavailable.

### Validation

- Focused tests:
  - `pnpm test -- src/commands/channels/slack-watchdog-scan.test.ts`
  - `pnpm test -- extensions/slack/src/monitor/watchdog-scan.test.ts`
  - `pnpm test -- extensions/slack/src/monitor/admission-ledger.test.ts`
- CLI dry-run proof:
  - `openclaw channels watchdog-scan --account soylei --target channel:C0B0AK14B7X --since 30m --json`
  - same command with `--dry-run-replies` for a fixture or live known miss.
- Live guarded proof after tests:
  - Run the scan against the known missed permalink/window.
  - Confirm one operator alert is human-readable.
  - With explicit approval, run `--reply-missed --max-replies 1`.
  - Verify Slack shows exactly one threaded notice on the missed message.
  - Rerun the same scan and verify no duplicate operator alert or source reply.
- Feature-family gate before handoff:
  - `scripts/ec-main-rebase-gate.sh --family slack-responsiveness`

### Definition Of Done For This Slice

- Watchdog operator alerts can be understood without knowing the internal
  ledger reason codes.
- A newly detected missed Slack message can receive exactly one threaded
  watchdog notice when `--reply-missed` is explicitly enabled.
- Repeated scans are idempotent for both operator alerts and source replies.
- The JSON report exposes what was sent, skipped, or failed.
- No automatic replay occurs without a separate guarded recovery command.
- The existing read-only detection behavior remains compatible.

### 2026-05-29 Progress

- Implemented the human-readable operator alert in
  `src/commands/channels/slack-watchdog-scan.ts`.
- Added explicit CLI flags in `src/cli/channels-cli.ts`:
  `--reply-missed`, `--reply-account`, `--reply-state`, `--dry-run-replies`,
  and `--max-replies`.
- Added source-message thread replies for new missing admissions, disabled by
  default and enabled only by `--reply-missed` or rendered by
  `--dry-run-replies`.
- Replaced string-only alert state with per-action object state while retaining
  read compatibility for existing string state values.
- Added JSON reporting for source replies: sent, skipped-known, failed,
  dry-run state, target, thread timestamp, and returned source reply timestamp
  when Slack reports one.
- Added the first guarded replay CLI:
  `openclaw channels watchdog-replay --account <id> --target channel:<id> --ts <slack-ts>`.
  It re-reads Slack history, re-checks the admission ledger, refuses messages
  that are no longer `missing-admission`, defaults to dry-run, and requires
  `--execute` before starting an ingress agent turn.
- Missing-admission records now expose `replayEligible=true` and a
  `suggestedReplayCommand` so operator alerts and JSON reports point at the
  preflight command instead of an unimplemented recovery note.
- Guarded replay dispatches through `agentCommandFromIngress` with Slack
  account, target, session key, thread id, non-owner sender identity, and
  explicit external-user provenance. It records `replayAttemptedAt` and
  `replayOutcome` in watchdog action state so a second `--execute` is refused.
- Guarded replay now writes redacted admission-ledger rows for
  `replay-attempted`, `replay-dispatched`, and `replay-failed`. Replay metadata
  does not mask a real `accepted` or `dropped` admission row, and it does not
  cause the original Slack message to be classified as admitted.
- Successful replay posts a short threaded source follow-up:
  `Recovery complete: OpenClaw has replayed this missed message into the agent.`
- `docs/cli/channels.md` now documents `watchdog-scan`,
  `watchdog-replay`, and a notify-only systemd user timer recipe.
- The default history reader now uses the Slack plugin public API directly,
  leaving the Gateway `message.action read` path as a test/injected fallback.
  That keeps scheduled scans usable as a sidecar check of Slack Web API history
  rather than depending on the Gateway's Slack read action.
- Operator alerts now include optional nearby Slack account health diagnostics
  when Gateway `channels.status` is reachable: health state, connected/running
  booleans, last transport activity age, last inbound age, last disconnect time,
  and any matching channel-health warnings. Health lookup failures are reported
  in JSON/alert text and do not fail the admission-gap scan.
- `watchdog-scan` and `watchdog-replay` now accept Slack `--permalink` input.
  Scan derives the channel id and anchors the scan window around the linked
  Slack timestamp. Replay derives both the target channel and message timestamp,
  so the guarded preflight can start from the reported Slack URL instead of
  manual channel/timestamp splitting.
- The core CLI no longer carries its own duplicate admission-gap classifier.
  It calls the Slack plugin's `scanSlackAdmissionGaps` helper and only adds
  CLI-specific replay command text afterward. Sender/bot/subtype display fields
  and replay eligibility are now part of the Slack plugin scan record shape.
- Operator alert send failures are now visible in the watchdog report instead
  of aborting the scan. Failed alert sends report `sent=0`, `failed=<count>`,
  and an error message, and they do not mark the alert state as completed so a
  later scan can retry the notification.
- Added `openclaw channels watchdog-status` as a read-only state summary for
  the scheduled sidecar. It reports the watchdog state path, known message
  count, operator-alert count, source-reply count, replay attempts, dispatched
  replays, failed replays, and latest action timestamps. This gives operators a
  channel CLI visibility surface for watchdog action state without requiring
  raw JSON inspection.

Validation performed:

```bash
node scripts/run-vitest.mjs src/commands/channels/slack-watchdog-scan.test.ts
node scripts/run-vitest.mjs extensions/slack/src/monitor/watchdog-scan.test.ts extensions/slack/src/monitor/admission-ledger.test.ts
pnpm exec oxfmt --check --threads=1 src/commands/channels/slack-watchdog-scan.ts src/commands/channels/slack-watchdog-scan.test.ts src/cli/channels-cli.ts
git diff --check -- docs/dev/plans/0007-2026-05-18-slack-stale-socket-watchdog.md src/commands/channels/slack-watchdog-scan.ts src/commands/channels/slack-watchdog-scan.test.ts src/cli/channels-cli.ts
pnpm openclaw channels watchdog-scan --account soylei --target channel:C0B0AK14B7X --since 24h --limit 100 --bot-user U0B0BS18D70 --dry-run-replies --json --timeout 15000
node scripts/run-vitest.mjs src/commands/channels/slack-watchdog-scan.test.ts
node scripts/run-vitest.mjs extensions/slack/src/monitor/watchdog-scan.test.ts extensions/slack/src/monitor/admission-ledger.test.ts
pnpm exec oxfmt --check --threads=1 src/commands/channels/slack-watchdog-scan.ts src/commands/channels/slack-watchdog-scan.test.ts src/cli/channels-cli.ts src/commands/channels.ts
git diff --check -- docs/dev/plans/0007-2026-05-18-slack-stale-socket-watchdog.md docs/cli/channels.md src/commands/channels/slack-watchdog-scan.ts src/commands/channels/slack-watchdog-scan.test.ts src/cli/channels-cli.ts src/commands/channels.ts
node scripts/run-vitest.mjs src/commands/channels/slack-watchdog-scan.test.ts extensions/slack/src/monitor/watchdog-scan.test.ts extensions/slack/src/monitor/admission-ledger.test.ts
scripts/ec-main-rebase-gate.sh --family slack-responsiveness
pnpm openclaw channels watchdog-scan --account soylei --target channel:C0B0AK14B7X --since 24h --limit 100 --bot-user U0B0BS18D70 --dry-run-replies --json --timeout 15000
pnpm openclaw channels watchdog-replay --account soylei --target channel:C0B0AK14B7X --ts 1780021947.219859 --since 24h --limit 100 --bot-user U0B0BS18D70 --json --timeout 15000
node scripts/run-vitest.mjs src/commands/channels/slack-watchdog-scan.test.ts
node scripts/run-vitest.mjs src/commands/channels/slack-watchdog-scan.test.ts extensions/slack/src/monitor/watchdog-scan.test.ts extensions/slack/src/monitor/admission-ledger.test.ts
scripts/ec-main-rebase-gate.sh --family slack-responsiveness
scripts/ec-main-rebase-gate.sh --family slack-responsiveness
scripts/ec-main-rebase-gate.sh --family slack-responsiveness
node scripts/run-vitest.mjs src/commands/channels/slack-watchdog-scan.test.ts
node scripts/run-vitest.mjs src/commands/channels/slack-watchdog-scan.test.ts extensions/slack/src/monitor/watchdog-scan.test.ts extensions/slack/src/monitor/admission-ledger.test.ts
scripts/ec-main-rebase-gate.sh --family slack-responsiveness
pnpm openclaw channels watchdog-replay --account soylei --permalink https://polycy.slack.com/archives/C0B0AK14B7X/p1780021947219859 --since 24h --limit 100 --bot-user U0B0BS18D70 --json --timeout 15000
node scripts/run-vitest.mjs src/commands/channels/slack-watchdog-scan.test.ts extensions/slack/src/monitor/watchdog-scan.test.ts extensions/slack/src/monitor/admission-ledger.test.ts
scripts/ec-main-rebase-gate.sh --family slack-responsiveness
node scripts/run-vitest.mjs src/commands/channels/slack-watchdog-scan.test.ts
node scripts/run-vitest.mjs src/commands/channels/slack-watchdog-scan.test.ts extensions/slack/src/monitor/watchdog-scan.test.ts extensions/slack/src/monitor/admission-ledger.test.ts
node scripts/run-vitest.mjs src/commands/channels/slack-watchdog-scan.test.ts
node scripts/run-vitest.mjs src/commands/channels/slack-watchdog-scan.test.ts extensions/slack/src/monitor/watchdog-scan.test.ts extensions/slack/src/monitor/admission-ledger.test.ts
scripts/patch-live-openclaw.sh --expect-branch ec-main --require-expected-branch --patch-external-plugin slack
openclaw --version
openclaw channels watchdog-status --help
openclaw channels watchdog-replay --help
openclaw gateway status --deep --require-rpc
openclaw channels watchdog-status --account soylei --json
openclaw channels watchdog-replay --account soylei --permalink https://polycy.slack.com/archives/C0B0AK14B7X/p1780021947219859 --since 24h --limit 100 --bot-user U0B0BS18D70 --json --timeout 15000
node scripts/run-vitest.mjs src/commands/channels/slack-watchdog-scan.test.ts
node scripts/run-vitest.mjs src/commands/channels/slack-watchdog-scan.test.ts extensions/slack/src/monitor/watchdog-scan.test.ts extensions/slack/src/monitor/admission-ledger.test.ts
pnpm exec oxfmt --check --threads=1 src/commands/channels/slack-watchdog-scan.ts extensions/slack/src/monitor/watchdog-scan.ts extensions/slack/src/monitor/admission-ledger.ts src/cli/channels-cli.ts src/commands/channels.ts
git diff --check -- src/commands/channels/slack-watchdog-scan.ts docs/cli/channels.md docs/dev/plans/0007-2026-05-18-slack-stale-socket-watchdog.md extensions/slack/src/monitor/admission-ledger.test.ts extensions/slack/src/monitor/admission-ledger.ts extensions/slack/src/monitor/watchdog-scan.test.ts extensions/slack/src/monitor/watchdog-scan.ts src/cli/channels-cli.ts src/commands/channels.ts src/commands/channels/slack-watchdog-scan.test.ts
openclaw channels watchdog-scan --account soylei --permalink https://polycy.slack.com/archives/C0B0AK14B7X/p1780021947219859 --since 24h --limit 100 --bot-user U0B0BS18D70 --dry-run-replies --max-replies 10 --json --timeout 15000
openclaw channels watchdog-scan --account soylei --permalink https://polycy.slack.com/archives/C0B0AK14B7X/p1780021947219859 --since 24h --limit 100 --bot-user U0B0BS18D70 --reply-missed --max-replies 1 --json --timeout 15000
openclaw channels watchdog-status --account soylei --json
openclaw channels watchdog-scan --account soylei --permalink https://polycy.slack.com/archives/C0B0AK14B7X/p1780021947219859 --since 24h --limit 100 --bot-user U0B0BS18D70 --dry-run-replies --max-replies 10 --json --timeout 15000
node scripts/run-vitest.mjs src/commands/channels/slack-watchdog-scan.test.ts
node scripts/run-vitest.mjs src/commands/channels/slack-watchdog-scan.test.ts extensions/slack/src/monitor/watchdog-scan.test.ts extensions/slack/src/monitor/admission-ledger.test.ts
pnpm exec oxfmt --check --threads=1 src/commands/channels/slack-watchdog-scan.ts src/commands/channels/slack-watchdog-scan.test.ts extensions/slack/src/monitor/watchdog-scan.ts extensions/slack/src/monitor/admission-ledger.ts src/cli/channels-cli.ts src/commands/channels.ts
git diff --check -- src/commands/channels/slack-watchdog-scan.ts src/commands/channels/slack-watchdog-scan.test.ts docs/dev/plans/0007-2026-05-18-slack-stale-socket-watchdog.md docs/cli/channels.md extensions/slack/src/monitor/admission-ledger.test.ts extensions/slack/src/monitor/admission-ledger.ts extensions/slack/src/monitor/watchdog-scan.test.ts extensions/slack/src/monitor/watchdog-scan.ts src/cli/channels-cli.ts src/commands/channels.ts
scripts/ec-main-rebase-gate.sh --family slack-responsiveness
```

Latest focused test result: 3 files passed, 33 tests passed. This now includes
operator-alert coverage for optional nearby Slack account health diagnostics in
the human-readable alert and JSON report, plus permalink parsing and
permalink-anchored scan/replay preflight coverage. It was rerun after moving
the enriched scan record shape into the Slack plugin scanner and after making
operator alert send failures structured and retryable. It now also covers the
new `watchdog-status` state summary command.

The focused test result was rerun after fixing the packaged watchdog replay
reader to load Slack history through the installed Slack plugin public API
instead of resolving Slack package dependencies from the core install. The
latest rerun passed 3 files and 33 tests; the single-file watchdog CLI rerun
passed 18 tests.

Latest `slack-responsiveness` gate result: 2 Vitest shards passed, including
11 unit-fast tests and 150 auto-reply tests. This was rerun after both the
operator-alert health diagnostics change and the permalink scan/replay command
change, and again after moving enriched scan classification into the Slack
plugin helper and after making operator alert send failures structured and
retryable. It was rerun after adding `watchdog-status`.

Latest live direct Slack-plugin scan dry-run result: scanned 10 recent SoyLei
`#ask-lei` messages, found 3 admitted messages, 4 not-relevant bot/chatter
messages, and 3 `missing-admission` messages. It rendered 3 planned
source-thread replies and sent 0 messages because `--dry-run-replies` was used.

Latest live direct Slack-plugin replay preflight result: the known missed
SoyLei `#ask-lei` message `1780021947.219859` classified as
`missing-admission`, produced `outcome=dry-run`, resolved `agentId` to
`soylei-primary`, and resolved the target delivery thread to
`channel:C0B0AK14B7X` / `1780021947.219859` without starting an agent turn.
The same preflight now works directly from the Slack permalink form and
produced the same dry-run missing-admission result without requiring manual
channel/timestamp extraction.

Live patch evidence: a clean clone at commit `c96f5b136a` was packaged through
`scripts/patch-live-openclaw.sh --expect-branch ec-main
--require-expected-branch --patch-external-plugin slack`, which installed
OpenClaw `2026.5.22 (c96f5b1)` and rebuilt/reinstalled the external Slack
plugin. The gateway restarted and `openclaw gateway status --deep
--require-rpc` reported `Runtime: running`, `Read probe: ok`, and
`Capability: admin-capable`. The first installed replay dry-run exposed a
packaging boundary bug (`@slack/web-api` resolved from core instead of the
external Slack plugin); the source fix now resolves the Slack public API from
the installed plugin registry before falling back to source checkout helpers.
After repatching, the installed dry-run replay for
`https://polycy.slack.com/archives/C0B0AK14B7X/p1780021947219859` returned
`outcome=dry-run`, `verdict=missing-admission`, `agentId=soylei-primary`, and
delivery `channel:C0B0AK14B7X` / thread `1780021947.219859` without dispatching
an agent turn. Installed `watchdog-status --account soylei --json` also
reported 9 known watchdog messages, 9 operator alerts, and no source replies or
replays yet.

Live source-reply evidence: running the explicit write-gated scan with
`--reply-missed --max-replies 1` against the same SoyLei permalink sent exactly
one source-thread notice for message `1780021947.219859` in
`channel:C0B0AK14B7X`, with `sourceReplies.sent=1`, `failed=0`, and the
thread target `1780021947.219859`. `watchdog-status --account soylei --json`
then reported `sourceReplied=1` and `latestSourceRepliedAt` populated. The
first post-reply dry-run exposed an idempotency bug: Slack history began
returning `thread_ts` equal to the top-level `ts`, which changed the action
state key. The key now normalizes top-level `threadTs === ts` to the same key as
an absent thread timestamp, and the source-reply dedupe test covers that
regression. After that fix, the single-file watchdog test passed 18 tests, the
combined watchdog/admission suite passed 33 tests, and
`scripts/ec-main-rebase-gate.sh --family slack-responsiveness` passed both
shards with 11 unit-fast tests and 150 auto-reply tests. The final live patch
installed `OpenClaw 2026.5.22 (c96f5b1)`, restarted the gateway with a green
RPC read probe, and the post-reply dry-run reported `skippedKnown=1`, `sent=0`,
and only the two remaining unreplied missed messages in `sourceReplies.records`.

Live replay preflight against the originally reported permalink was read-only
and still cannot be proven from this checkout/runtime because Slack Web API
returns `channel_not_found` for `channel:C0AHQQCG7J4` under account `soylei`.
Before the direct Slack-plugin reader change, the injected Gateway read path
also refused that target with `Slack read target channel is not allowed.`

`pnpm tsgo:core` was also attempted for compile-shape proof and is currently
blocked by unrelated existing errors in
`src/agents/pi-embedded-runner/run/attempt.ts`,
`src/auto-reply/reply/agent-runner-execution.ts`,
`src/commands/models/list.status-command.ts`, and
`src/status/status-text.ts`.

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
