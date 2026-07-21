# Policy: Architecture And Plugin Survivability

This policy governs local features that `ec-main` carries on top of upstream OpenClaw.

## Goal

Keep local features durable across upstream rebases by reducing direct edits in upstream-hot orchestration files and moving feature-owned behavior into plugins, provider/channel capabilities, or narrow compatibility seams when that fits the architecture.

## Default Decision Rule

When adding or repairing a local feature:

1. identify the owning feature family in `docs/dev/local-feature-index.md`
2. choose the narrowest durable home:
   - plugin-owned runtime or capability
   - provider/channel plugin seam
   - core compatibility helper
   - core orchestration change
3. add or preserve a focused behavior test
4. update the relevant local feature doc when the conflict hotspot or validation path changes

Do not put feature-owned policy inline in upstream-hot orchestrators when a helper, adapter, or plugin-owned seam can carry it.

## Plugin-Friendly Features

Prefer plugin-owned implementations for:

- channel-specific presentation, interactions, and transport behavior
- provider-specific auth, usage, reauth, model, and CLI credential behavior
- voice-call telephony runtime behavior
- feature-owned tools and commands that can register through `OpenClawPluginApi`
- compatibility behavior that belongs to a bundled extension rather than core

The strongest current pluginization candidates are:

- automation tool and `/automation` command surfaces
- voice-call STT/TTS backends
- Slack-specific A2A approval rendering and interaction handling
- OpenAI Codex-specific auth/profile adapters

## Core-Seam Features

Keep these as core or core-seam behavior unless a new stable SDK contract is created:

- session store and session resolution
- cross-agent routing and A2A safety policy
- generic auth-profile selection and session override semantics
- generic turn lifecycle, suppression, and delivery attribution
- gateway protocol schemas
- shared config schema and generated config metadata
- live-patch and release operator scripts

Plugins can consume these seams, but they should not own the global invariants.

## Compatibility Seams

Prefer extracting local behavior into named helper modules before editing large orchestration files.

Priority seams:

- dispatch compatibility helpers for `src/auto-reply/reply/dispatch-*`
- runner compatibility helpers for `src/agents/pi-embedded-runner/run/*`
- tool-event payload helpers for `src/agents/pi-embedded-subscribe.handlers.tools*`
- A2A helper modules under `src/agents/a2a/`
- provider-owned helpers under `src/plugins/provider-*.ts`

When a rebase conflict repeats in the same file, the next durable fix should usually be seam extraction, not another inline conflict resolution.

## Boundary Rules

- Core must stay extension-agnostic.
- Extension production code should cross into core through `openclaw/plugin-sdk/*`, manifest metadata, runtime helpers, or local plugin barrels.
- Provider-specific behavior belongs in provider plugins unless it is a generic provider contract.
- Channel-specific behavior belongs in channel plugins unless it is a generic channel contract.
- New plugin seams must be documented, backwards-compatible, and versioned enough for third-party plugins.

## Productization Rule

Reactive live-operator fixes are fieldwork until classified.

Before folding fieldwork into long-lived `ec-main` behavior, classify it as:

- product behavior to keep
- plugin behavior to move
- core seam to extract
- local operator script or note
- temporary patch to retire

Do not let a one-off live patch silently define permanent architecture.
