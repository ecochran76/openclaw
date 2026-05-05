# 0020 - SoyLei Slack Thread Participation Gap

Date: 2026-05-05

## Summary

SoyLei OpenClaw Slack responsiveness was flaky in threads where Lei had already
posted. Live evidence showed the Slack inbound path dropping later authorized
thread replies with `reason=no-mention` even though the thread already contained
Lei bot messages.

This looks like a Slack plugin hardening issue: thread participation state can
miss threads where the bot visibly posted, so later no-mention replies in that
thread are treated as ordinary group messages and skipped when
`requireMention=true`.

## Live Evidence

Runtime:

- OpenClaw CLI/runtime: `2026.4.30`
- Gateway service: running and RPC reachable on `127.0.0.1:18789`
- SoyLei Slack account: configured, Socket Mode, enabled
- SoyLei bot user: `U0B0BS18D70`

Observed drops from `/tmp/openclaw/openclaw-2026-05-05.log`:

- `2026-05-05 09:30:17 CDT`
  - account: `soylei`
  - channel: `C06L8DVBWQP` / `website`
  - ts: `1777991415.646899`
  - user: `U0127BGJ3U5`
  - reason: `no-mention`
  - `requireMention=true`
  - `effectiveWasMentioned=false`
- `2026-05-05 09:30:40 CDT`
  - same channel/thread family
  - ts: `1777991436.291899`
  - reason: `no-mention`
- `2026-05-05 09:31:20 CDT`
  - same channel/thread family
  - ts: `1777991478.262349`
  - user: `U012M8NDV3K`
  - reason: `no-mention`

Slack history for root thread `1777985437.317799` showed Lei bot messages
already present before the drops:

- bot reply at `1777990082.563809`
- bot reply at `1777990108.602579`
- later human replies in the same thread were still dropped.

The persistent plugin state did not contain:

```text
soylei:C06L8DVBWQP:1777985437.317799
```

before live repair.

## Live Runtime Repair Applied

Seeded missing `slack.thread-participation` records in
`~/.openclaw/plugin-state/state.sqlite` for SoyLei threads where Slack history
showed the Lei bot had already replied today.

Inserted records:

```text
soylei:C06L8DVBWQP:1777983010.397289 -> soylei-website
soylei:C06L8DVBWQP:1777984926.385999 -> soylei-website
soylei:C06L8DVBWQP:1777985437.317799 -> soylei-website
soylei:C06L8DVBWQP:1777987442.091369 -> soylei-website
soylei:C0B1SPSEDL1:1777989651.666679 -> soylei-marketing
```

These expire after 24 hours, matching the plugin's current participation TTL.

## Suspected Product Gap

The Slack plugin already has `sent-thread-cache` and persistent
`slack.thread-participation` state. The gap appears to be one of:

- visible bot messages are not always counted as `anyReplyDelivered`;
- native/progress/streamed Slack messages can be posted without recording thread
  participation;
- participation is recorded only on some delivery paths and not on all Slack
  bot-authored thread posts;
- status/progress messages in a thread do not establish participation, even
  though users reasonably interpret them as Lei joining the thread.

The product behavior should be deterministic:

- if OpenClaw posts a bot-authored message into a Slack thread, the Slack plugin
  should record thread participation for that account/channel/thread;
- after participation is recorded, authorized no-mention replies in that thread
  should satisfy mention gating unless `threadRequireExplicitMention=true`;
- `/why-silent` or equivalent diagnostics should say when a thread reply was
  dropped because participation was missing.

## Suggested Tests

Add or extend Slack plugin tests around:

- progress/native streaming delivery records thread participation;
- status-only or short final deliveries record thread participation when posted
  in a thread;
- `requireMention=true` thread replies pass after any bot-authored threaded
  post;
- persistent participation lookup works after gateway restart and does not
  require in-memory cache state.

Likely test files:

- `extensions/slack/src/monitor/message-handler/dispatch.streaming.test.ts`
- `extensions/slack/src/monitor/message-handler/prepare.test.ts`
- `extensions/slack/src/sent-thread-cache.test.ts`

## Validation Performed

- `openclaw gateway status --deep --require-rpc` passed.
- `openclaw channels list` showed SoyLei Slack configured and enabled.
- `openclaw status --deep` showed Slack OK.
- Slack Web API history confirmed bot messages existed in the thread before the
  dropped replies.
- SQLite state inspection confirmed the relevant participation key was missing
  before repair and present after repair.

## Residual Risk

The live repair is a runtime-state seed, not a product fix. It should make the
current affected threads respond immediately, but new threads can still miss
participation until the Slack plugin records participation on every relevant
delivery path.
