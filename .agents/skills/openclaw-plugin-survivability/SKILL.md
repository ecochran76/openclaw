---
name: openclaw-plugin-survivability
description: Decide whether OpenClaw local features should live in core, compatibility helpers, plugin SDK seams, bundled plugins, or external plugins. Use when Codex is doing plugin-vs-core architecture, upstream rebase survivability, SDK boundary work, manifest-first migration, bundled plugin ownership, or local feature productization.
---

# OpenClaw Plugin Survivability

Use this skill for architecture decisions that affect long-term rebase survivability.

## Read First

- `docs/dev/policies/architecture-and-plugin-survivability.md`
- `docs/dev/local-feature-index.md`
- `docs/dev/plans/0001-2026-04-20-plugin-survivability-roadmap.md`
- `docs/plugins/architecture.md`
- `docs/plugins/sdk-overview.md` when SDK contract work is involved
- scoped `AGENTS.md` for any touched subtree

## Decision Rule

For each local behavior, choose the narrowest durable home:

1. plugin-owned runtime or capability
2. provider/channel plugin seam
3. named core compatibility helper
4. direct core orchestration change only when the invariant is core-owned

Do not put feature-owned policy inline in upstream-hot orchestrators when a helper, adapter, or plugin-owned seam can carry it.

## Plugin-Friendly Areas

Prefer plugin-owned implementations for:

- channel-specific presentation, interactions, and transport behavior
- provider-specific auth, usage, reauth, model, and CLI credential behavior
- voice-call telephony runtime behavior
- feature-owned tools and commands that can register through `OpenClawPluginApi`
- compatibility behavior that belongs to a bundled extension rather than core

## Core-Seam Areas

Keep these in core or core-seam code unless a stable SDK contract exists:

- session store and session resolution
- cross-agent routing and A2A safety policy
- generic auth-profile selection and session override semantics
- generic turn lifecycle, suppression, and delivery attribution
- gateway protocol schemas
- shared config schema and generated config metadata
- live-patch and release operator scripts

## Review Checklist

- Which local feature family owns this behavior?
- Is the current file an upstream-hot conflict hotspot?
- Can a plugin manifest, provider/channel capability, or runtime helper express it?
- Does the change keep core extension-agnostic?
- Does an existing focused test preserve the behavior?
- Does the relevant feature doc need a conflict-hotspot or validation update?

## Validation

Use the relevant feature-family gate from `scripts/ec-main-rebase-gate.sh`.

For public SDK, plugin loading, manifest, or runtime-boundary changes, also run:

```bash
pnpm build
pnpm check
```

## Closeout Evidence

Report:

- chosen ownership layer
- why rejected alternatives were weaker
- compatibility/test evidence
- docs updated, if any
- best next step
