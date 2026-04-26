---
name: openclaw-gateway-operator
description: Diagnose, repair, and verify a local OpenClaw Gateway runtime. Use when Codex needs to investigate gateway up/down loops, systemd service state, live CLI/version skew, stale PATH entries, doctor gateway findings, port/listener mismatches, or post-live-patch gateway health.
---

# OpenClaw Gateway Operator

Use this skill for local runtime operations, not ordinary source edits.

## Read First

- `docs/dev/policies/validation-and-handoff.md`
- `docs/dev/policies/ec-main-integration.md` when the work follows a rebase, push, or live patch
- `docs/install/exe-dev.md` only when remote install/update behavior is involved

## Triage Order

1. Check source and install identity:
   - `git status --short`
   - `git branch --show-current`
   - `git rev-parse --short HEAD`
   - `command -v openclaw`
   - `openclaw --version`
2. Check gateway service health:
   - `openclaw gateway status --deep --require-rpc`
   - `systemctl --user status openclaw-gateway.service --no-pager`
   - `ss -ltnp 'sport = :18789' || true`
3. If the service flaps or bootstrap fails, inspect bounded logs:
   - `journalctl --user -u openclaw-gateway.service -n 200 --no-pager`
   - `tail -n 200 ~/.openclaw/logs/gateway-restart.log`
   - newest `/tmp/openclaw/openclaw-*.log`

## Repair Rules

- Do not globally install from the checkout path.
- For live patching, use `scripts/patch-live-openclaw.sh --expect-branch ec-main --require-expected-branch`.
- If gateway service config is stale, prefer repo CLI repair/install commands over manual unit edits.
- If a first RPC probe fails immediately after restart, retry after a short warm-up before diagnosing.
- Treat `Read probe: ok` plus `Capability: admin-capable` plus a real listener as healthy.
- Preserve operator auth/profile warnings in the handoff, but do not treat them as gateway blockers unless they break the requested runtime path.

## Closeout Evidence

Report:

- installed `openclaw --version`
- gateway service state and PID
- RPC probe result
- listener result
- residual doctor/auth/plugin warnings
- best next step
