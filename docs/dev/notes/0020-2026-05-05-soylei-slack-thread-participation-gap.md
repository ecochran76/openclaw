# 0020 - example tenant Slack Thread Participation Gap

Date: 2026-05-05

## Summary

example tenant OpenClaw Slack responsiveness was flaky in threads where Lei had already
posted. Live evidence showed the Slack inbound path dropping later authorized
thread replies with `reason=no-mention` even though the thread already contained
Lei bot messages.

This looks like a Slack plugin hardening issue: thread participation state can
miss threads where the bot visibly posted, so later no-mention replies in that
thread are treated as ordinary group messages and skipped when
`requireMention=true`.

A second nuance matters for diagnosis: Slack thread replies keep
`parent_user_id` set to the root message author. In the affected thread, the
root author was a human, so replies that visually appeared to be "to Lei" still
had `parent_user_id` equal to the human root author. OpenClaw therefore cannot
depend on `reply_to_bot` semantics for non-bot-root threads; durable
thread-participation state is the right primitive.

## Live Evidence

Runtime:

- OpenClaw CLI/runtime: `2026.4.30`
- Gateway service: running and RPC reachable on `127.0.0.1:18789`
- example tenant Slack account: configured, Socket Mode, enabled
- example tenant bot user: `user-id-redacted`

Observed drops from `/tmp/openclaw/openclaw-2026-05-05.log`:

- `2026-05-05 09:30:17 CDT`
  - account: `example`
  - channel: `channel-id-redacted` / `website`
  - ts: `timestamp-redacted`
  - user: `user-id-redacted`
  - reason: `no-mention`
  - `requireMention=true`
  - `effectiveWasMentioned=false`
- `2026-05-05 09:30:40 CDT`
  - same channel/thread family
  - ts: `timestamp-redacted`
  - reason: `no-mention`
- `2026-05-05 09:31:20 CDT`
  - same channel/thread family
  - ts: `timestamp-redacted`
  - user: `user-id-redacted`
  - reason: `no-mention`

Slack history for root thread `timestamp-redacted` showed Lei bot messages
already present before the drops:

- bot reply at `timestamp-redacted`
- bot reply at `timestamp-redacted`
- later human replies in the same thread were still dropped.

The same Slack history showed every threaded human reply carrying
`parent_user_id=user-id-redacted`, the human root author, including replies after Lei
had posted. That explains why the UI can feel like a direct reply to Lei while
the OpenClaw `reply_to_bot` signal remains false.

The persistent plugin state did not contain:

```text
example:channel-id-redacted:timestamp-redacted
```

before live repair.

## Live Runtime Repair Applied

Seeded missing `slack.thread-participation` records in
`~/.openclaw/plugin-state/state.sqlite` for example tenant threads where Slack history
showed the Lei bot had already replied today.

Inserted records:

```text
example:channel-id-redacted:timestamp-redacted -> example-website
example:channel-id-redacted:timestamp-redacted -> example-website
example:channel-id-redacted:timestamp-redacted -> example-website
example:channel-id-redacted:timestamp-redacted -> example-website
example:channel-id-redacted:timestamp-redacted -> example-marketing
```

These expire after 24 hours, matching the plugin's current participation TTL.

At `2026-05-05 09:41:36 CDT`, the gateway health monitor also restarted both
Slack sockets:

```text
[slack:default] health-monitor: restarting (reason: stale-socket)
[slack:example] health-monitor: restarting (reason: stale-socket)
```

The sockets reconnected and example tenant channels re-resolved by `09:41:38 CDT`. This
is separate from the mention-gate bug, but it likely contributed to the
operator's broader "flaky responsiveness" observation.

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
- Slack `parent_user_id` only identifies the root author, not the message a user
  visually replied beneath in the thread UI, so `reply_to_bot` is insufficient
  for non-bot-root threads.
- stale Slack sockets can overlap with thread-participation misses and make
  operator-visible behavior hard to explain without a single diagnostic surface.

The product behavior should be deterministic:

- if OpenClaw posts a bot-authored message into a Slack thread, the Slack plugin
  should record thread participation for that account/channel/thread;
- after participation is recorded, authorized no-mention replies in that thread
  should satisfy mention gating unless `threadRequireExplicitMention=true`;
- `/why-silent` or equivalent diagnostics should say when a thread reply was
  dropped because participation was missing.
- `/why-silent` should also report stale socket restarts and whether a relevant
  thread participation key existed at decision time.

## Suggested Tests

Add or extend Slack plugin tests around:

- progress/native streaming delivery records thread participation;
- status-only or short final deliveries record thread participation when posted
  in a thread;
- `requireMention=true` thread replies pass after any bot-authored threaded
  post;
- persistent participation lookup works after gateway restart and does not
  require in-memory cache state.
- `parent_user_id` on a human-root thread does not satisfy `reply_to_bot`, and
  the thread still passes after recorded bot participation.
- health-monitor stale-socket restarts are visible in channel diagnostics near
  dropped inbound events.

Likely test files:

- `extensions/slack/src/monitor/message-handler/dispatch.streaming.test.ts`
- `extensions/slack/src/monitor/message-handler/prepare.test.ts`
- `extensions/slack/src/sent-thread-cache.test.ts`

## Validation Performed

- `openclaw gateway status --deep --require-rpc` passed.
- `openclaw channels list` showed example tenant Slack configured and enabled.
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

## 2026-05-05 Source Fix

Patched the Slack send primitive so every successful bot-authored Slack post
with a `thread_ts` records `slack.thread-participation` for the resolved account,
channel, and thread. This covers standard text sends, block/status sends, media
caption follow-ups, and preview/status messages that route through
`sendMessageSlack`, instead of relying only on the inbound monitor's final
delivery bookkeeping.

Added regression coverage for:

- successful threaded text and block sends seeding participation;
- human-root thread replies still dropping when no explicit mention and no
  participation record exists;
- human-root thread replies passing after recorded bot participation.

Validation:

```text
pnpm test extensions/slack/src/send.blocks.test.ts extensions/slack/src/monitor/message-handler/prepare.test.ts extensions/slack/src/sent-thread-cache.test.ts
scripts/ec-main-rebase-gate.sh --family slack-responsiveness
git diff --check
```
