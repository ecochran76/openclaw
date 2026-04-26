---
name: openclaw-feature-preservation
description: Preserve OpenClaw ec-main local feature families during source edits, rebases, conflict repair, and upstream compatibility work. Use when Codex touches profiles/auth, Slack/A2A, Slack responsiveness, automation, voice/telephony, outbound relay, plugin survivability, or local feature validation.
---

# OpenClaw Feature Preservation

Use this skill before changing or repairing a maintained `ec-main` local feature family.

## Read First

- `docs/dev/local-feature-index.md`
- `docs/dev/policies/ec-main-integration.md`
- `docs/dev/policies/architecture-and-plugin-survivability.md`
- `docs/dev/policies/validation-and-handoff.md`
- the specific feature doc named by `docs/dev/local-feature-index.md`

## Feature Families

Preserve these maintained local families:

- profiles / auth / usage policy
- Slack / A2A approvals and relay behavior
- Slack / agent responsiveness
- automation
- voice / telephony / local STT
- outbound relay and bound-channel protections

## Workflow

1. Identify the touched family before editing.
2. Read the family doc and its focused validation commands.
3. Prefer durable homes in this order:
   - plugin-owned runtime or capability
   - provider/channel plugin seam
   - named core compatibility helper
   - direct core orchestration change only when the invariant is genuinely core-owned
4. If a rebase conflict repeats in an upstream-hot file, extract or preserve a helper instead of reapplying the same inline patch.
5. Update the feature doc or feature index when validation paths, conflict hotspots, or ownership boundaries change.

## Validation

Use the gate wrapper first:

```bash
scripts/ec-main-rebase-gate.sh --family profiles
scripts/ec-main-rebase-gate.sh --family slack-a2a
scripts/ec-main-rebase-gate.sh --family slack-responsiveness
scripts/ec-main-rebase-gate.sh --family automation
scripts/ec-main-rebase-gate.sh --family voice
scripts/ec-main-rebase-gate.sh --family all --check --build
```

Use `--list` when planning or when the user only wants command visibility.

## Conflict Priorities

When several local families are involved, resolve in the order from `docs/dev/policies/ec-main-integration.md`:

1. profiles / auth / OAuth
2. Slack / A2A routing, approvals, and relay behavior
3. Slack responsiveness and tracked-turn behavior
4. automation
5. voice / telephony
6. live-patch and upgrade scripts

## Closeout Evidence

Report:

- touched feature family
- why the selected home is plugin-owned, seam-owned, helper-owned, or core-owned
- focused validation commands and results
- docs/index updates, if any
- best next step
