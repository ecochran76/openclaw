# 0016 - 2026-05-04 - Slack Channel Helper Tenant Footguns

## Summary

During SoyLei company-bot channel setup, the local
`~/.openclaw/workspace/scripts/slack_channels` helper exposed two operational
footguns:

- `slack_channels create --help` was treated as a real channel create request
  with `--help` as the channel name instead of printing usage.
- The helper always reads `SLACK_BOT_TOKEN`, so multi-tenant Slack work can
  silently target the default Slack tenant unless the caller overrides the env
  var for the intended tenant.

## Field Impact

Two accidental channels were created in the default Cochran Group Slack tenant
before the correct SoyLei tenant token was used. Both accidental channels were
archived and their local note-store mappings were removed.

The intended SoyLei channel was created only after overriding the helper with
the SoyLei Slack user token. The SoyLei bot token authenticated successfully
but lacked `conversations.create` scope.

## Suggested Hardening

- Add real `--help` handling for the helper and subcommands.
- Reject channel names beginning with `-`.
- Add an explicit `--account` or `--token-env` argument instead of relying only
  on `SLACK_BOT_TOKEN`.
- Print the Slack team name/id before mutating operations, or require
  `--confirm-team <team_id>` for create/invite actions.
- Consider productizing this helper into OpenClaw tenant-aware Slack channel
  management instead of leaving it as a user-scoped script.

## Validation Context

The accidental channels were archived through Slack `conversations.archive`.
The SoyLei channel create path was retried with the SoyLei user token and
individual invites for Michael, Baker, and Lei.
