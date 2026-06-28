# Profile Support Retirement Plan

State: OPEN - source cleanup validated; installed-runtime proof pending
Created: 2026-06-28

## Current State

`ec-main` still carries a broad local profile feature family, but upstream OpenClaw now owns most of the durable base layer:

- per-agent SQLite auth profile storage
- `openclaw models auth` profile listing and login flows
- provider profile order and rotation state
- OpenAI Codex to canonical OpenAI auth/profile migration
- doctor import of legacy `auth-profiles.json` and `auth-state.json`

The remaining local value is operator UX and policy on top of that base layer, especially chat-visible profile selection and diagnostics. The recent upgrade incident showed the cost of duplicated ownership: local runtime code and upstream SQLite storage drifted, causing `/profiles` to appear empty even though upgrade backups still contained credentials.

## Goal

Shrink the `ec-main` profile delta to the smallest durable layer:

1. upstream OpenClaw owns auth profile storage, migration, CLI auth commands, ordering, cooldown, and rotation;
2. `ec-main` owns only operator-specific chat/UI/policy behavior that upstream does not provide;
3. future rebases do not require replaying a parallel profile implementation.

## Scope

- Audit every `ec-main` profile/auth/usage delta against current `origin/main`.
- Delete or revert local storage, migration, resolver, and CLI-profile code that duplicates upstream behavior.
- Keep `/profile` and `/profiles` only if they remain useful operator UX and can call upstream profile APIs directly.
- Keep local usage/quota policy only where it is not covered by upstream failover/profile rotation.
- Update profile feature docs and gate commands so they validate the retained thin layer, not the retired implementation.

## Non-Goals

- Do not remove upstream OpenClaw auth-profile support.
- Do not remove valid credentials or rewrite live auth stores as part of source cleanup.
- Do not preserve legacy `openai-codex` runtime aliases in steady-state code unless upstream already requires them for a shipped migration boundary.
- Do not introduce new storage formats, sidecar files, or fallback readers.
- Do not make Codex upstream responsible for OpenClaw multi-profile routing; Codex still has config profiles but not OpenClaw-style named auth profiles.

## Phase 1 - Inventory And Classification

Create a profile delta map with one row per local surface:

- path or symbol
- upstream equivalent, if any
- owner decision: upstream-owned, local-thin-UX, local-policy, obsolete
- user-visible behavior protected
- validation test or proof

Required checks:

- compare `ec-main...origin/main` for `src/agents/auth-profiles/**`, `src/commands/models/**`, `src/auto-reply/reply/commands-profiles*`, profile-related UI files, profile usage helpers, and docs;
- confirm upstream behavior from current source, not from stale local docs;
- inspect Codex source only for dependency-backed Codex auth claims.

Exit criteria:

- every local profile delta has an owner decision;
- obsolete duplicate surfaces are listed for deletion;
- retained local surfaces have a named upstream API they should call.

### Phase 1 Inventory - 2026-06-28

Source comparison: current `ec-main` against `origin/main` fetched at `f37e45ecc1`.

| Surface                                     | Local paths                                                                                                                     | Upstream equivalent                                                                                                                           | Owner decision                                                                    | Protected behavior                                                                                                         | Required proof                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Auth profile SQLite store/state durability  | `src/agents/auth-profiles/persisted.ts`, `src/agents/auth-profiles/store.ts`, `src/agents/auth-profiles/sqlite.ts`              | upstream SQLite auth-profile store helpers and doctor import                                                                                  | upstream-owned                                                                    | installed runtime must list restored profiles from `openclaw-agent.sqlite`; no steady-state JSON auth profile reads/writes | SQLite store tests, doctor import tests, installed `models auth list`                            |
| Legacy JSON and OAuth sidecar import/repair | `src/agents/auth-profiles/legacy-oauth-sidecar.ts`, `persisted.ts`, `paths.ts`, `repair.ts`, `docs/gateway/doctor.md`           | upstream doctor import of `auth-profiles.json`, `auth-state.json`, and Codex profile migration                                                | upstream-owned except any live-observed shipped migration gap                     | old files migrate through doctor, not runtime fallback                                                                     | doctor auth/profile migration tests                                                              |
| External CLI/Codex auth bootstrap           | `external-auth.ts`, `external-cli-*`, `oauth.openai-codex-refresh-fallback.test.ts`, `oauth.ts`, `constants.ts`                 | upstream OpenAI auth profiles plus Codex app-server auth; Codex itself has one `CODEX_HOME/auth.json`, not OpenClaw-style named auth profiles | local-policy until each behavior is matched upstream                              | operator can reuse safe Codex auth material without shadowing configured profiles or reviving `openai-codex` as canonical  | focused external-auth/OAuth refresh tests; direct Codex source citation when making Codex claims |
| Session profile override semantics          | `session-override.ts`, `session-override.test.ts`, `profiles.ts`, `profiles.test.ts`, `types.ts`                                | upstream profile order/rotation plus session stickiness; no upstream chat command layer                                                       | local-thin-UX if limited to session override metadata and upstream resolver calls | `/profile <id>` sets session override only; `/profile clear` clears only override                                          | command tests plus session override tests                                                        |
| Chat profile commands                       | `src/auto-reply/reply/commands-profiles.ts`, `commands-profiles.test.ts`                                                        | no current upstream equivalent found                                                                                                          | local-thin-UX                                                                     | `/profiles` and `/profile` show/select canonical provider profiles for chat sessions                                       | command tests; live chat/gateway smoke when patched                                              |
| CLI auth/profile additions                  | `src/commands/models/auth.ts`, retired `auth-sync.ts`, `src/cli/models-cli.ts`                                                  | upstream `openclaw models auth` supports list/login/profile-id and SQLite store                                                               | upstream-owned except narrow retained options that upstream lacks                 | no duplicate CLI auth implementation on `ec-main`                                                                          | CLI auth tests only for retained deltas                                                          |
| Usage/quota policy                          | `src/infra/provider-usage.auth.ts`, `provider-usage.policy.ts`, usage tests                                                     | upstream model failover/profile rotation and status surfaces                                                                                  | local-policy retained                                                             | avoid choosing locally known exhausted profiles when upstream does not cover the live operator case                        | usage policy tests; status consistency checks                                                    |
| Agent UI primary auth profile picker        | `ui/src/ui/views/agents-utils.ts`, `agents-panels-overview.ts`, related tests                                                   | upstream agents UI and config editing                                                                                                         | local-thin-UX retained                                                            | operator can choose provider primary profile without corrupting auth order                                                 | UI helper tests and relevant agents view tests                                                   |
| Profile docs and gates                      | `docs/dev/local-features/profiles.md`, `docs/dev/local-feature-index.md`, `scripts/ec-main-rebase-gate.sh`, older profile plans | upstream docs plus local feature docs                                                                                                         | local-docs                                                                        | rebase gates validate retained thin layer, not retired storage forks                                                       | `scripts/ec-main-rebase-gate.sh --family profiles --list`, docs sanity                           |

Initial Phase 2 slice already identified from the 2026-06-28 live incident:

- `loadPersistedAuthProfileStore` must read the SQLite store row, not `auth-profiles.json`.
- `saveAuthProfileStore` must write through `writePersistedAuthProfileStoreRaw`, not `saveJsonFile`.
- `writePersistedAuthProfileStateRaw` must not side-write `auth-state.json`.
- `/profiles` may normalize `codex` / `openai-codex` command context to canonical `openai`, but must not reintroduce `openai-codex` as storage ownership.

### Phase 2 Progress - 2026-06-28

Completed first cleanup slice:

- repointed runtime profile store load/save/state persistence to the upstream SQLite store row;
- stopped steady-state state writes from recreating `auth-state.json`;
- moved locked profile mutations to a dedicated `state/locks/auth-profile-store/*` lock target instead of creating `auth-profiles.json` as the lock anchor;
- changed runtime profile-store cache freshness to track the SQLite database path instead of retired JSON sidecars;
- kept doctor/import as the migration owner for legacy JSON;
- normalized chat command provider context from `codex` / `openai-codex` to canonical `openai`;
- removed the obsolete `rewriteInlineOAuthSecrets` runtime JSON rewrite hook after the SQLite load path made it unreachable.
- removed the local `openclaw models auth sync` command, its helper, tests, and public docs because it duplicated CLI profile ownership outside upstream `models auth`.
- kept deprecated hidden `models auth login --notify-slack*` device-code delivery compatibility, while leaving chat-safe reauth on `/reauth --device-code`; removed legacy `openai-codex` profile-id rewriting; retained CLI bare profile-id qualification because `--profile-id work` is a documented login contract and provider auth methods consume canonical `ctx.profileId` values.
- classified the external CLI/Codex bootstrap delta against upstream Codex source: Codex supports config profiles, but auth is still one `CODEX_HOME/auth.json` snapshot that requires explicit reload, so OpenClaw may keep a narrow safe bootstrap/recovery bridge while upstream OpenClaw owns canonical `openai` profile storage.
- restored Codex CLI/default profile constants to canonical `openai:codex-cli` / `openai:default`, kept `openai-codex:*` only as legacy aliases/import inputs, and removed the unused `externalCliDiscoveryExisting` export left over from broader local profile sync.
- converted the refresh-token-reuse state assertion to the SQLite state loader so tests no longer depend on retired `auth-state.json` runtime writes.
- converted auth-store cache/concurrency tests from direct `auth-profiles.json` fixtures and `*.json.lock` paths to SQLite raw-store fixtures and the dedicated auth-profile-store lock target.
- removed the runtime legacy OAuth sidecar resolver/preservation path from `src/agents/auth-profiles`; only doctor/import keeps sidecar migration code.
- removed session override fallback reads from legacy `auth-profiles.json`; session profile order now comes from the canonical store/config resolver only.
- converted the OAuth promotion-to-main test fixture from direct `auth-profiles.json` writes to SQLite auth-store helpers and updated its OAuth mock to the current `llm/oauth.js` facade.
- moved runtime snapshot keys to the SQLite database path and stopped auth-source probes from treating retired `auth-profiles.json` / `auth-state.json` files as runtime sources.
- converted provider-usage auth tests from retired JSON auth-store fixtures to canonical auth-store mock fixtures.
- updated model status/auth-overview tests to expect the SQLite auth-profile display path instead of `auth-profiles.json`.
- switched usage policy/cache test fixtures from `openai-codex` to canonical `openai` provider/profile ids, leaving legacy `openai-codex` only in compatibility/migration/alias-focused tests.
- canonicalized CLI reauth fallback guidance from legacy `openai-codex` to `openai` while keeping legacy chat/profile-id aliases accepted.
- canonicalized the UI auth-profile helper fixtures to `openai` while keeping the helper itself provider-agnostic.
- expanded the `profiles` rebase gate to include retained usage policy/cache and UI profile-picker tests.

Validation:

- `node scripts/run-vitest.mjs src/agents/auth-profiles.sqlite-store.test.ts src/commands/doctor-auth-flat-profiles.test.ts src/auto-reply/reply/commands-profiles.test.ts`
- `node scripts/run-vitest.mjs src/agents/auth-profiles/profiles.test.ts src/agents/auth-profiles.sqlite-store.test.ts src/commands/doctor-auth-flat-profiles.test.ts src/auto-reply/reply/commands-profiles.test.ts`
- `node scripts/run-vitest.mjs src/agents/auth-profiles/profiles.test.ts src/cli/models-cli.test.ts src/commands/models/auth.test.ts src/commands/models/auth.login-profiles.test.ts`
- `node scripts/run-vitest.mjs src/cli/models-cli.test.ts src/commands/models/auth.test.ts src/commands/models/auth.login-profiles.test.ts src/agents/auth-profiles/profile-id.test.ts src/plugins/provider-api-key-auth.test.ts`
- `node scripts/run-vitest.mjs src/plugins/provider-openai-codex-cli-profile.test.ts src/agents/auth-profiles.external-cli-sync.test.ts src/agents/auth-profiles/oauth.openai-codex-refresh-fallback.test.ts src/agents/auth-profiles/oauth-refresh-failure.test.ts`
- `node scripts/run-vitest.mjs src/agents/agent-auth-discovery.external-cli.test.ts src/agents/auth-profiles.external-cli-scope.test.ts src/agents/auth-profiles.readonly-sync.test.ts src/agents/auth-profiles.external-cli-sync.test.ts src/plugins/provider-openai-codex-cli-profile.test.ts`
- `node scripts/run-vitest.mjs src/agents/auth-profiles.store-cache.test.ts src/agents/auth-profiles/profiles.test.ts src/agents/auth-profiles.sqlite-store.test.ts`
- `node scripts/run-vitest.mjs src/agents/auth-profiles/persisted-boundary.test.ts src/commands/doctor-auth-oauth-sidecar.test.ts src/commands/doctor/shared/legacy-oauth-sidecar.test.ts src/commands/doctor-auth-flat-profiles.test.ts src/agents/auth-profiles/session-override.test.ts src/agents/auth-profiles.store-cache.test.ts src/agents/auth-profiles/profiles.test.ts src/agents/auth-profiles.sqlite-store.test.ts src/agents/auth-profiles/oauth.promotion-to-main.test.ts`
- `node scripts/run-vitest.mjs src/plugins/provider-openai-codex-cli-profile.test.ts src/agents/auth-profiles.external-cli-sync.test.ts src/agents/auth-profiles/oauth.openai-codex-refresh-fallback.test.ts src/agents/auth-profiles/oauth-refresh-failure.test.ts src/agents/agent-auth-discovery.external-cli.test.ts src/agents/auth-profiles.external-cli-scope.test.ts src/agents/auth-profiles.readonly-sync.test.ts`
- `node scripts/run-vitest.mjs src/agents/auth-profiles/session-override.test.ts src/agents/auth-profiles/profiles.test.ts src/agents/auth-profiles.store-cache.test.ts src/agents/auth-profiles.sqlite-store.test.ts src/agents/auth-profiles/oauth.promotion-to-main.test.ts`
- `node scripts/run-vitest.mjs src/infra/provider-usage.auth.normalizes-keys.test.ts`
- `node scripts/run-vitest.mjs src/commands/models/list.auth-overview.test.ts src/commands/models/list.status.test.ts`
- `node scripts/run-vitest.mjs src/infra/provider-usage.policy.test.ts src/infra/provider-usage.cache.test.ts`
- `node scripts/run-vitest.mjs src/agents/auth-profiles/reauth-guidance.test.ts`
- `node scripts/run-vitest.mjs ui/src/ui/views/agents-utils.test.ts`
- `node scripts/run-vitest.mjs src/auto-reply/reply/commands-profiles.test.ts src/agents/auth-profiles/session-override.test.ts src/agents/auth-profiles/profiles.test.ts src/agents/auth-profiles.store-cache.test.ts src/agents/auth-profiles.sqlite-store.test.ts src/commands/doctor-auth-flat-profiles.test.ts src/commands/doctor-auth-oauth-sidecar.test.ts src/commands/models/auth.test.ts src/commands/models/auth.login-profiles.test.ts src/cli/models-cli.test.ts src/infra/provider-usage.policy.test.ts src/infra/provider-usage.cache.test.ts src/infra/provider-usage.auth.normalizes-keys.test.ts ui/src/ui/views/agents-utils.test.ts`
- `scripts/ec-main-rebase-gate.sh --family profiles`
- `scripts/ec-main-rebase-gate.sh --family profiles --list`
- `pnpm docs:list`
- `pnpm build`
- `git diff --check`

Closeout validation refreshed after the final cleanup pass:

- `node scripts/run-vitest.mjs src/agents/auth-profiles.store-cache.test.ts`
- `scripts/ec-main-rebase-gate.sh --family profiles`
- `git diff --check`
- `.agents/skills/autoreview/scripts/autoreview --mode local`

Known proof gaps:

- `pnpm check:changed` through the normal remote wrapper did not start because Blacksmith authentication is missing locally (`not authenticated -- run 'blacksmith auth login' first`).
- The local child `check:changed` path reached the branch-wide typecheck lane and failed on pre-existing drift outside this profile-retirement slice; the touched cache-test type errors observed in that run were fixed and revalidated by the focused cache test plus the full profile gate.
- Installed-runtime proof is still pending. Per live-patch policy, this source cleanup needs commit/push before running `scripts/patch-live-openclaw.sh --expect-branch ec-main --require-expected-branch`, then `oc main` and chat `/profiles` must be checked against the installed runtime.

Remaining Phase 2 candidates:

- audit any remaining runtime references to legacy JSON paths and keep only constants/messages needed by doctor/import, negative assertions, or user-facing migration diagnostics.

## Phase 2 - Delete Duplicate Core Profile Ownership

Remove local code that duplicates upstream profile storage or migration responsibilities:

- storage read/write forks;
- JSON fallback or sidecar persistence paths that upstream replaced with SQLite;
- local profile id normalization helpers that only compensate for old `openai-codex` runtime shapes;
- duplicated CLI login/list/add logic when upstream `models auth` owns it;
- tests that only protect retired internals.

For each deletion, prefer using upstream helpers directly over adding adapters.

Exit criteria:

- runtime profile credentials are read and written through upstream SQLite helpers only;
- `openclaw doctor --fix` remains the only legacy auth-store migration owner;
- no local code path can silently reintroduce JSON auth profile runtime reads/writes.

## Phase 3 - Preserve Thin Operator UX

Rebuild any retained `ec-main` profile UX as a thin layer over upstream APIs:

- `/profiles` lists upstream profile order for the active canonical provider;
- `/profile <id>` records only the session-level override, not credential state;
- `/profile clear` removes only the session-level override;
- chat output shows enough source/effective-profile context to debug operator mistakes;
- Codex-backed sessions display canonical `openai` profile choices without reviving `openai-codex` as a profile owner.

If upstream adds equivalent chat commands before this phase starts, delete the local commands instead of maintaining a fork.

Exit criteria:

- local chat commands do not own storage, migration, or provider policy;
- retained command tests prove only command parsing, provider-context normalization, session override behavior, and output text.

## Phase 4 - Usage And Quota Policy Reconciliation

Compare local profile-aware usage/quota behavior against upstream model failover and profile rotation:

- keep only policy that protects the local operator from known live failure modes not covered upstream;
- move any provider-specific policy into provider-owned hooks where possible;
- delete stale usage presentation helpers when upstream status/model surfaces already report the same source.

Exit criteria:

- usage/quota code has one owner per decision;
- status surfaces agree on effective profile, usage source, and next candidate;
- no local quota cache can force a stale profile choice when upstream has fresher cooldown/rotation state.

## Phase 5 - Docs, Gates, And Live Upgrade Proof

Update the local feature documentation after code cleanup:

- `docs/dev/local-features/profiles.md`
- `docs/dev/local-feature-index.md`
- `scripts/ec-main-rebase-gate.sh`
- any stale profile plans that still describe local storage ownership as current

Validation:

- focused profile command tests for retained chat UX;
- upstream auth-profile storage and doctor tests affected by the cleanup;
- `scripts/ec-main-rebase-gate.sh --family profiles`;
- `git diff --check`;
- `pnpm build` if runtime packaging, lazy imports, or live patch output changed;
- installed-runtime proof after packaging when the cleanup affects the live gateway.

Exit criteria:

- the profile gate validates the retained thin layer only;
- docs no longer describe retired local storage/CLI ownership as active;
- installed `oc main` lists profiles and chat `/profiles` behaves as designed after live patch.

## Definition Of Done

- The local profile delta is documented, minimal, and intentional.
- Upstream OpenClaw owns profile storage, migration, CLI auth commands, ordering, cooldown, and rotation.
- `ec-main` owns only the remaining operator UX/policy surfaces that upstream does not provide.
- Future rebases can treat profile conflicts as small command/UI/policy conflicts instead of full auth-store conflicts.
- The plan is closed with exact source diffs, validation commands, installed-runtime proof when applicable, and any intentionally deferred upstream PR candidates.
