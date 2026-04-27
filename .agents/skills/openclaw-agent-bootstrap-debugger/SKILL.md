---
name: openclaw-agent-bootstrap-debugger
description: Debug OpenClaw agent bootstrap, identity, memory, and skill visibility problems. Use when Codex needs to investigate agents stuck in bootstrap mode, lost identity, missing MEMORY/SOUL/USER files, workspace template issues, skill allowlists, bootstrap file size warnings, or per-agent workspace/config drift.
---

# OpenClaw Agent Bootstrap Debugger

Use this skill when an agent seems to have lost identity, memory, or available skills.

## Read First

- `docs/start/bootstrapping.md`
- `docs/reference/AGENTS.default.md`
- `docs/tools/skills-config.md`
- `docs/tools/creating-skills.md`
- `docs/dev/policies/validation-and-handoff.md`

## Triage Order

1. Identify the agent id and workspace path.
2. Inspect bootstrap and identity files without printing secrets:
   - `AGENTS.md`
   - `BOOTSTRAP.md`
   - `IDENTITY.md`
   - `USER.md`
   - `SOUL.md`
   - `MEMORY.md`
   - `memory/YYYY-MM-DD.md`
3. Check whether `BOOTSTRAP.md` still exists. If it does, the agent may legitimately still be in first-run bootstrap.
4. Inspect skill visibility:
   - workspace `skills/`
   - workspace `.agents/skills/`
   - `~/.agents/skills`
   - `~/.openclaw/skills`
   - `agents.defaults.skills`
   - `agents.list[].skills`
5. Check bootstrap-size warnings before adding more root instructions.

## Common Findings

- Identity loss is often workspace mismatch, not memory deletion.
- `BOOTSTRAP.md` remaining in the workspace can keep first-run behavior alive.
- A per-agent explicit `skills: []` allowlist hides all skills.
- Agent-specific skill lists replace defaults; they do not merge.
- Root bootstrap files near size limits can truncate useful context even when the files exist.

## Repair Rules

- Do not delete identity or memory files unless the user explicitly asks.
- Prefer preserving and editing existing identity files over reseeding templates.
- If the workspace path is wrong, fix config or point the agent at the intended workspace rather than copying memory blindly.
- If skills are missing because of allowlists, update the narrowest relevant agent config.
- Keep durable observations in `MEMORY.md` or dated `memory/` files, not chat history only.

## Closeout Evidence

Report:

- active agent id and workspace
- whether bootstrap is still active
- which identity/memory files exist
- skill root/allowlist finding
- recommended repair
- best next step
