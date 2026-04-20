# Policy Adoption Feedback

Date: 2026-04-20

## Installed Decision

OpenClaw adopted a custom policy composition for `ec-main`, not a direct generated starter profile.

The selector's deterministic first pass recommended `website-maintenance` because this repo contains live-patch, drift, visual release, and operator-language signals. That classification is useful evidence, but it is not the dominant workflow for `ec-main`.

Corrected classification:

- repo purpose: `product-engineering`
- local branch mode: downstream fork maintenance
- operational overlay: live operator/runtime workflows
- execution bias: balanced, with explicit multi-agent reconciliation

## Modules Adopted Locally

Base profile influence:

- `repo-product-engineering`

Local overlays:

- `upstream-fork-maintenance`
- `runtime-vs-product-boundary`
- `fieldwork-productization`
- `multi-agent-reconciliation`
- `subagent-workflow-optimization`

## What Worked

- The selector correctly found that this repo has no current `docs/dev/policies/` adoption.
- It identified many existing `AGENTS.md` sections as mature local policy to preserve or merge, not overwrite.
- It detected planning drift: there are many `docs/dev/*.md` plan files but no canonical top-level `ROADMAP.md`, `RUNBOOK.md`, or `docs/dev/plans/` contract.

## What Needed Override

- `website-maintenance` overfit to live-patch and drift terminology.
- For OpenClaw, live-patch work is an operator overlay on a product-engineering fork, not the primary repo archetype.
- The first adoption should not thin `AGENTS.md` aggressively because it contains mature repo-specific build, plugin, security, release, and platform rules.

## Future Policy Work

- Consider a dedicated shared profile for “downstream product fork with live operator deployment” if this pattern recurs.
- Consider a migration slice for canonical planning surfaces, but do not introduce `ROADMAP.md` and `RUNBOOK.md` casually while `docs/dev/local-feature-index.md` and feature docs are the active authority.
- Update this feedback file after meaningful policy friction or after upgrading the installed policy source.
