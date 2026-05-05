# SoyLei Slack Socket Stale Ingress

State: OPEN
Created: 2026-05-04

## Observation

The SoyLei `#ask-lei` channel missed inbound messages while `openclaw channels status --probe` still reported Slack as connected and working. Slack history contained the user messages, but the Gateway logs had no corresponding ingress or delivery records for the SoyLei channel.

The channel configuration was correct: the SoyLei account was bound to `soylei-primary`, the channel policy allowed top-level messages without a mention, and authorized users were resolved. Restarting `openclaw-gateway.service` re-established Slack Socket Mode and inbound activity resumed.

## Product Gap

OpenClaw already has a channel health monitor that can restart stale sockets when a channel reports `lastTransportActivityAt`. Slack Socket Mode reported `lastEventAt` and `lastInboundAt` for app events, but did not seed transport liveness on socket connect. That meant the monitor could not classify a connected-but-stale Slack account as `stale-socket`.

Slack app events are not equivalent to transport liveness, but a successful Socket Mode connect is transport activity. Seeding `lastTransportActivityAt` on connect gives the existing health monitor a conservative restart boundary for sockets that remain connected but transport-silent beyond the configured stale threshold.

## Follow-Up

- Keep `lastEventAt` and `lastInboundAt` scoped to Slack application events.
- Use `lastTransportActivityAt` for Socket Mode connection liveness and stale-socket restart decisions.
- Consider adding a richer Slack SDK hook later if upstream exposes ping/pong or lower-level websocket activity as a public event.
- Add a `why silent` diagnostic that compares newest Slack history for a bound channel against OpenClaw's last inbound event age.
