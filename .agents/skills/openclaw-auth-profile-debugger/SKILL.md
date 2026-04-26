---
name: openclaw-auth-profile-debugger
description: Diagnose OpenClaw model auth profiles, expired refresh tokens, default profile confusion, ChatGPT-vs-API account/model support, device-code login flows, and agent-specific profile selection. Use when Codex needs to explain or fix openai-codex, google-gemini-cli, profile status, /status mismatches, or model auth routing.
---

# OpenClaw Auth Profile Debugger

Use this skill when the problem is credential/profile selection rather than model reasoning or prompt quality.

## Read First

- `docs/auth-credential-semantics.md`
- `docs/dev/local-features/profiles.md`
- `docs/dev/local-feature-index.md`
- `docs/dev/policies/validation-and-handoff.md`

## Triage Order

1. Identify the active agent and requested model/provider.
2. Inspect the user-visible status first:
   - `openclaw models auth status`
   - `openclaw status`
   - `openclaw doctor`
3. Inspect profile files only when needed, and do not print secrets:
   - `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
   - `~/.openclaw/agents/<agentId>/agent/auth-state.json`
4. Confirm account/model compatibility before treating auth as broken. ChatGPT-account Codex auth and API-account access can support different model sets.

## Common Findings

- `refresh_token_reused` means the stored refresh token is invalid for reuse; re-auth that profile.
- Expired dormant profiles can be real warnings without blocking a different active profile.
- `/status` may not expose the same profile details as `models auth status` or `doctor`.
- An agent can use a non-default profile through agent config or runtime profile selection.
- Device-code auth requires the command to be one shell command; line breaks before flags can make the shell run flags as separate commands.

## Safe Repair Commands

Prefer explicit provider and profile id:

```bash
openclaw models auth login --provider openai-codex --method device-code --profile-id openai-codex:<profile>
openclaw models auth login --provider google-gemini-cli --profile-id google-gemini-cli:<profile>
```

After repair:

```bash
openclaw models auth status
openclaw doctor
```

## Validation

For source changes touching profile behavior, use the profile family gate:

```bash
scripts/ec-main-rebase-gate.sh --family profiles
```

For narrow tests, use the profile commands listed in `docs/dev/local-feature-index.md`.

## Closeout Evidence

Report:

- which profile was active or expired
- whether the profile is blocking the requested agent/model
- exact re-auth command when user action is required
- validation command results when source changed
- best next step
