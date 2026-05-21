# SoyLei Thread Follow-Up After Manual Bot Reply Miss

Created: 2026-05-20

State: OPEN

## Observation

In SoyLei Slack `#ask-lei` channel `C0B0AK14B7X`, thread
`1779318546.276599`, Baker posted a follow-up at `1779319619.353539`:

```text
Lei please incorporate the word "Breh" into your vocabulary as well
```

Lei did not answer until the operator asked for recovery. A manual bot-token
reply was posted at `1779321504.707029`.

The same thread later missed another explicit mention. Baker posted at
`1779322434.225859`:

```text
<@U0B0BS18D70> this would be the time after Michael responds to play an excerpt of that song that I sent
```

Lei again did not answer until operator recovery. A manual bot-token reply was
posted at `1779323876.197949`.

## Evidence Checked

- Slack Web API `conversations.replies` showed the Baker message and no
  intervening Lei reply before manual recovery.
- `openclaw tasks list --json` did not reveal a task created for the `breh`
  request or timestamp.
- Gateway and node journals for `2026-05-20 18:25-18:35 CDT` had no matching
  entries for the thread/message/channel/user search terms.
- The thread already had Lei participation before Baker's follow-up, including
  OpenClaw-generated Lei replies and one manual bot-token Lei reply.
- For the second miss, Slack Web API showed the selected message and no
  intervening Lei reply before manual recovery.
- `openclaw tasks list --json` did not reveal a task created for
  `1779322434.225859`.
- Gateway logs for `2026-05-20 19:10-19:18 CDT` showed a default Slack
  `health-monitor` stale-socket restart at `19:16:14`, but no admission or
  dispatch entry for `1779322434.225859`.
- Node service logs for the same window had no matching dispatch/error lines.

## Working Hypothesis

This looks like an inbound Slack admission/thread-follow miss, not a model
behavior choice. The notable wrinkle is that the immediately preceding Lei
reply at `1779319439.182909` was posted manually through Slack Web API using
the Lei bot token. If the thread-follow logic depends on OpenClaw's own
participation ledger rather than Slack-visible bot participation, manual
bot-token replies may not refresh the participation state even though the
thread visibly contains a Lei bot reply.

The thread also had earlier OpenClaw-authored Lei replies, so this may still be
the broader stale-socket/admission-ledger issue rather than only a manual-reply
edge case.

The second miss is stronger evidence of a repeated admission gap because the
message explicitly mentioned the Lei bot in an already-active thread. The nearby
stale-socket restart may be relevant, but the message timestamp precedes the
restart by roughly two minutes, so the fix should inspect both pre-restart
socket liveness and admission-ledger behavior.

## Desired Behavior

- In `#ask-lei`, top-level and in-thread user messages should be admitted under
  the channel's always-respond policy.
- In threads where Lei has participated, follow-up messages from authorized
  users should be admitted even when they do not include an explicit mention.
- If a Slack-visible Lei bot reply is posted outside OpenClaw's normal delivery
  path, either import it into the participation/admission state or avoid relying
  solely on local participation state when Slack history proves bot
  participation.

## Suggested Investigation

1. Inspect Slack admission logs and participation ledger updates around
   `C0B0AK14B7X` / `1779318546.276599` / `1779319619.353539`.
2. Check whether manual bot-token replies are invisible to the participation
   ledger or delivery observer.
3. Add a regression test for: channel configured always-respond, thread has a
   bot-authored Lei reply visible in Slack, authorized user posts unmentioned
   follow-up, OpenClaw admits and dispatches it.
4. Add a second regression test for: authorized user posts an explicit bot
   mention in an already-active thread shortly before a stale-socket restart;
   the event must be admitted or surfaced as a missed-event diagnostic.
5. If the canonical fix is an admission-ledger repair, keep it in the Slack
   extension/runtime surface and avoid solving this with user-scoped scripts.

## Related Notes

- `0030-2026-05-18-slack-stale-socket-missed-mention.md`
- `0032-2026-05-20-soylei-ask-lei-baker-missed-followup.md`
