# Example Tenant Thread Follow-Up After Manual Bot Reply Miss

Created: 2026-05-20

State: OPEN

## Observation

In example tenant Slack `#always-listen` channel `channel-id-redacted`, thread
`timestamp-redacted`, the requester posted a private follow-up at
`timestamp-redacted`. The message body is intentionally omitted.

agent did not answer until the operator asked for recovery. A manual bot-token
reply was posted at `timestamp-redacted`.

The same thread later missed another explicit mention. The private message body
and actor identifiers are intentionally omitted.

agent again did not answer until operator recovery. A manual bot-token reply was
posted at `timestamp-redacted`.

## Evidence Checked

- Slack Web API `conversations.replies` showed the requester message and no
  intervening agent reply before manual recovery.
- `openclaw tasks list --json` did not reveal a task created for the `breh`
  request or timestamp.
- Gateway and node journals for `2026-05-20 18:25-18:35 CDT` had no matching
  entries for the thread/message/channel/user search terms.
- The thread already had agent participation before requester's follow-up, including
  OpenClaw-generated agent replies and one manual bot-token agent reply.
- For the second miss, Slack Web API showed the selected message and no
  intervening agent reply before manual recovery.
- `openclaw tasks list --json` did not reveal a task created for
  `timestamp-redacted`.
- Gateway logs for `2026-05-20 19:10-19:18 CDT` showed a default Slack
  `health-monitor` stale-socket restart at `19:16:14`, but no admission or
  dispatch entry for `timestamp-redacted`.
- Node service logs for the same window had no matching dispatch/error lines.
- Added installed diagnostic command support for explicit thread scans:

  ```bash
  openclaw channels watchdog-scan \
    --account example \
    --target channel:channel-id-redacted \
    --thread timestamp-redacted \
    --since 4h \
    --limit 50 \
    --bot-user user-id-redacted \
    --json
  ```

- Installed diagnostic scan result after live patch:
  `scanned=20`, `admitted=5`, `not-relevant=9`, `missing-admission=6`.
  Missing admissions included `timestamp-redacted` and the explicit bot mention
  at `timestamp-redacted`.

## Fixes Landed

- `dac3fe61af Add Slack watchdog thread scan` adds `--thread <ts>` to
  `openclaw channels watchdog-scan`.
- The command now passes `threadId` through the gateway-backed Slack
  `message.action read` path, so it uses Slack `conversations.replies` instead
  of only channel history.
- The scanner treats the explicit `--thread` value as an active thread and
  still infers active threads from accepted admission-ledger rows.
- Regression coverage now verifies that a requester-style explicit bot mention in a
  thread is read through the gateway with `threadId` and reported as
  `missing-admission` when the admission ledger lacks a row.

## Working Hypothesis

This looks like an inbound Slack admission/thread-follow miss, not a model
behavior choice. The notable wrinkle is that the immediately preceding agent
reply at `timestamp-redacted` was posted manually through Slack Web API using
the agent bot token. If the thread-follow logic depends on OpenClaw's own
participation ledger rather than Slack-visible bot participation, manual
bot-token replies may not refresh the participation state even though the
thread visibly contains a agent bot reply.

The thread also had earlier OpenClaw-authored agent replies, so this may still be
the broader stale-socket/admission-ledger issue rather than only a manual-reply
edge case.

The second miss is stronger evidence of a repeated admission gap because the
message explicitly mentioned the agent bot in an already-active thread. The nearby
stale-socket restart may be relevant, but the message timestamp precedes the
restart by roughly two minutes, so the fix should inspect both pre-restart
socket liveness and admission-ledger behavior.

## Desired Behavior

- In `#always-listen`, top-level and in-thread user messages should be admitted under
  the channel's always-respond policy.
- In threads where agent has participated, follow-up messages from authorized
  users should be admitted even when they do not include an explicit mention.
- If a Slack-visible agent bot reply is posted outside OpenClaw's normal delivery
  path, either import it into the participation/admission state or avoid relying
  solely on local participation state when Slack history proves bot
  participation.

## Suggested Investigation

1. Inspect Slack admission logs and participation ledger updates around
   `channel-id-redacted` / `timestamp-redacted` / `timestamp-redacted`.
2. Check whether manual bot-token replies are invisible to the participation
   ledger or delivery observer.
3. Add a regression test for: channel configured always-respond, thread has a
   bot-authored agent reply visible in Slack, authorized user posts unmentioned
   follow-up, OpenClaw admits and dispatches it.
4. Add a second regression test for: authorized user posts an explicit bot
   mention in an already-active thread shortly before a stale-socket restart;
   the event must be admitted or surfaced as a missed-event diagnostic.
5. If the canonical fix is an admission-ledger repair, keep it in the Slack
   extension/runtime surface and avoid solving this with user-scoped scripts.

## Related Notes

- `0030-2026-05-18-slack-stale-socket-missed-mention.md`
- `0032-2026-05-20-soylei-ask-lei-baker-missed-followup.md`
