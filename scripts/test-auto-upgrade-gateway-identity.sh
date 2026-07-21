#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PARSER="$ROOT_DIR/scripts/auto-upgrade-gateway-identity.mjs"
UPGRADER="$ROOT_DIR/scripts/auto-upgrade-on-release-tag.sh"

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "error: $label: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

assert_eq \
  "2026.7.15 (abcdef123)" \
  "$(printf '%s' '{"primaryTargetId":"local","targets":[{"id":"local","connect":{"rpcOk":true},"self":{"version":"2026.7.15","buildCommit":"abcdef123"}}]}' | node "$PARSER")" \
  "primary gateway identity"
assert_eq \
  "2026.7.16 (123456789)" \
  "$(printf '%s' '{"targets":[{"active":true,"connect":{"rpcOk":true},"self":{"version":"2026.7.16 (123456789)"}}]}' | node "$PARSER")" \
  "active gateway identity"
assert_eq \
  "2026.7.17 (987654321)" \
  "$(printf '%s' '{"primaryTargetId":"offline","targets":[{"id":"offline","active":true,"connect":{"rpcOk":false},"self":{"version":"stale","buildCommit":"stale"}},{"id":"reachable","connect":{"rpcOk":true},"self":{"version":"2026.7.17","buildCommit":"987654321"}}]}' | node "$PARSER")" \
  "unreachable primary falls back to reachable gateway identity"
assert_eq "" "$(printf '%s' '{"targets":[]}' | node "$PARSER")" "missing gateway identity"

assert_path_absent() {
  local path="$1"
  local label="$2"
  if [[ -e "$path" ]]; then
    echo "error: $label: unexpected filesystem entry at $path" >&2
    exit 1
  fi
}

assert_contains() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "$actual" != *"$expected"* ]]; then
    echo "error: $label: missing '$expected'" >&2
    exit 1
  fi
}

assert_not_contains() {
  local unexpected="$1"
  local actual="$2"
  local label="$3"
  if [[ "$actual" == *"$unexpected"* ]]; then
    echo "error: $label: unexpectedly contained '$unexpected'" >&2
    exit 1
  fi
}

make_upgrade_fixture() {
  local repo="$1"
  local remote_repo="${repo}-${UPSTREAM_FIXTURE_REMOTE}.git"
  git init -q -b ec-main "$repo"
  git -C "$repo" config user.name "OpenClaw Test"
  git -C "$repo" config user.email "test@openclaw.invalid"
  printf 'fixture\n' > "$repo/fixture.txt"
  git -C "$repo" add fixture.txt
  git -C "$repo" commit -qm "fixture"
  git -C "$repo" tag 2026.7.15
  git init -q --bare "$remote_repo"
  git -C "$repo" remote add "$UPSTREAM_FIXTURE_REMOTE" "$remote_repo"
  git -C "$repo" push -q "$UPSTREAM_FIXTURE_REMOTE" HEAD:main refs/tags/2026.7.15
}

run_dry_run_fixture() {
  local repo="$1"
  local state_dir="$2"
  local log_dir="$3"
  shift 3
  OPENCLAW_AUTO_STATE_DIR="$state_dir" \
    OPENCLAW_AUTO_STATE_FILE="$state_dir/upgrade.state" \
    OPENCLAW_AUTO_LOCK_FILE="$state_dir/upgrade.lock" \
    OPENCLAW_AUTO_LOG_DIR="$log_dir" \
    bash "$UPGRADER" --dry-run --repo-dir "$repo" --branch ec-main "$@" 2>&1
}

run_fixture() {
  local repo="$1"
  local state_dir="$2"
  local log_dir="$3"
  shift 3
  OPENCLAW_AUTO_STATE_DIR="$state_dir" \
    OPENCLAW_AUTO_STATE_FILE="$state_dir/upgrade.state" \
    OPENCLAW_AUTO_LOCK_FILE="$state_dir/upgrade.lock" \
    OPENCLAW_AUTO_LOG_DIR="$log_dir" \
    bash "$UPGRADER" --repo-dir "$repo" --branch ec-main "$@" 2>&1
}

fixture_root="$(mktemp -d)"
trap 'rm -rf "$fixture_root"' EXIT
UPSTREAM_FIXTURE_REMOTE="origin"

explicit_failure_repo="$fixture_root/explicit-failure-repo"
explicit_failure_state="$fixture_root/explicit-failure-state"
explicit_failure_logs="$fixture_root/explicit-failure-logs"
make_upgrade_fixture "$explicit_failure_repo"
explicit_failure_output="$(run_dry_run_fixture "$explicit_failure_repo" "$explicit_failure_state" "$explicit_failure_logs" --ref refs/heads/missing 2>&1 || true)"
assert_contains "OpenClaw auto-upgrade failed" "$explicit_failure_output" "explicit failure cleanup path"

planned_repo="$fixture_root/planned-repo"
planned_state="$fixture_root/planned-state"
planned_logs="$fixture_root/planned-logs"
make_upgrade_fixture "$planned_repo"
planned_output="$(run_dry_run_fixture "$planned_repo" "$planned_state" "$planned_logs")"
assert_contains "Dry-run complete (no changes applied)." "$planned_output" "planned dry-run output"
assert_path_absent "$planned_state" "planned dry-run state directory"
assert_path_absent "$planned_logs" "planned dry-run log directory"

custom_remote_repo="$fixture_root/custom-remote-repo"
custom_remote_state="$fixture_root/custom-remote-state"
custom_remote_logs="$fixture_root/custom-remote-logs"
UPSTREAM_FIXTURE_REMOTE="upstream2"
make_upgrade_fixture "$custom_remote_repo"
git -C "$custom_remote_repo" update-ref refs/remotes/upstream2/main HEAD
foreign_remote_repo="${custom_remote_repo}-origin.git"
git init -q --bare "$foreign_remote_repo"
git -C "$custom_remote_repo" remote add origin "$foreign_remote_repo"
git -C "$custom_remote_repo" tag 2099.1.1
git -C "$custom_remote_repo" push -q origin HEAD:main refs/tags/2099.1.1
custom_remote_output="$(run_dry_run_fixture "$custom_remote_repo" "$custom_remote_state" "$custom_remote_logs" --upstream-remote upstream2)"
assert_contains "release tag 2026.7.15" "$custom_remote_output" "configured upstream tag discovery"
assert_not_contains "2099.1.1" "$custom_remote_output" "foreign upstream tag exclusion"
UPSTREAM_FIXTURE_REMOTE="origin"

ref_repo="$fixture_root/ref-repo"
ref_state="$fixture_root/ref-state"
ref_logs="$fixture_root/ref-logs"
make_upgrade_fixture "$ref_repo"
printf 'ref target\n' >> "$ref_repo/fixture.txt"
git -C "$ref_repo" commit -qam "ref target"
git -C "$ref_repo" push -q origin HEAD:main
ref_output="$(
  OPENCLAW_AUTO_TARGET_REF=origin/main \
    run_dry_run_fixture "$ref_repo" "$ref_state" "$ref_logs"
)"
assert_contains "onto ref origin/main" "$ref_output" "environment ref target inference"
assert_path_absent "$ref_state" "ref dry-run state directory"
assert_path_absent "$ref_logs" "ref dry-run log directory"

remote_ahead_repo="$fixture_root/remote-ahead-repo"
remote_ahead_state="$fixture_root/remote-ahead-state"
remote_ahead_logs="$fixture_root/remote-ahead-logs"
make_upgrade_fixture "$remote_ahead_repo"
remote_ahead_base="$(git -C "$remote_ahead_repo" rev-parse HEAD)"
printf 'remote only\n' >> "$remote_ahead_repo/fixture.txt"
git -C "$remote_ahead_repo" commit -qam "remote only"
remote_ahead_sha="$(git -C "$remote_ahead_repo" rev-parse HEAD)"
git -C "$remote_ahead_repo" update-ref refs/remotes/fork/ec-main "$remote_ahead_sha"
git -C "$remote_ahead_repo" reset -q --hard "$remote_ahead_base"
remote_ahead_output="$(run_dry_run_fixture "$remote_ahead_repo" "$remote_ahead_state" "$remote_ahead_logs")"
assert_contains "Fast-forwarding local branch ec-main to fork/ec-main" "$remote_ahead_output" "remote-ahead reconciliation"

local_ahead_repo="$fixture_root/local-ahead-repo"
local_ahead_state="$fixture_root/local-ahead-state"
local_ahead_logs="$fixture_root/local-ahead-logs"
make_upgrade_fixture "$local_ahead_repo"
local_ahead_base="$(git -C "$local_ahead_repo" rev-parse HEAD)"
git -C "$local_ahead_repo" update-ref refs/remotes/fork/ec-main "$local_ahead_base"
printf 'local only\n' >> "$local_ahead_repo/fixture.txt"
git -C "$local_ahead_repo" commit -qam "local only"
local_ahead_output="$(run_dry_run_fixture "$local_ahead_repo" "$local_ahead_state" "$local_ahead_logs")"
assert_not_contains "Fast-forwarding local branch ec-main" "$local_ahead_output" "local-ahead reconciliation"

diverged_repo="$fixture_root/diverged-repo"
diverged_state="$fixture_root/diverged-state"
diverged_logs="$fixture_root/diverged-logs"
make_upgrade_fixture "$diverged_repo"
diverged_base="$(git -C "$diverged_repo" rev-parse HEAD)"
printf 'remote only\n' >> "$diverged_repo/fixture.txt"
git -C "$diverged_repo" commit -qam "remote only"
diverged_remote_sha="$(git -C "$diverged_repo" rev-parse HEAD)"
git -C "$diverged_repo" update-ref refs/remotes/fork/ec-main "$diverged_remote_sha"
git -C "$diverged_repo" reset -q --hard "$diverged_base"
printf 'local only\n' >> "$diverged_repo/fixture.txt"
git -C "$diverged_repo" commit -qam "local only"
if diverged_output="$(run_dry_run_fixture "$diverged_repo" "$diverged_state" "$diverged_logs" 2>&1)"; then
  echo "error: diverged branch reconciliation unexpectedly succeeded" >&2
  exit 1
fi
assert_contains "have diverged" "$diverged_output" "diverged reconciliation"
assert_not_contains "Rebasing integration branch" "$diverged_output" "diverged reconciliation stops before rebase"

noop_repo="$fixture_root/noop-repo"
noop_state="$fixture_root/noop-state"
noop_logs="$fixture_root/noop-logs"
make_upgrade_fixture "$noop_repo"
mkdir -p "$noop_state"
noop_sha="$(git -C "$noop_repo" rev-parse HEAD)"
cat > "$noop_state/upgrade.state" <<EOF
last_seen_tag=2026.7.15
last_success_tag=2026.7.15
last_success_sha=$noop_sha
last_success_ts=2026-07-15T00:00:00Z
last_success_ref=2026.7.15
last_success_kind=tag
last_success_target_sha=$noop_sha
EOF
noop_state_before="$(cat "$noop_state/upgrade.state")"
noop_output="$(run_dry_run_fixture "$noop_repo" "$noop_state" "$noop_logs")"
assert_contains "[dry-run] would update state file: $noop_state/upgrade.state" "$noop_output" "no-op dry-run state preview"
assert_contains "NOOP: latest tag already applied (2026.7.15) and integration branch is unchanged" "$noop_output" "no-op dry-run output"
assert_eq "$noop_state_before" "$(cat "$noop_state/upgrade.state")" "no-op dry-run state contents"
assert_path_absent "$noop_state/upgrade.lock" "no-op dry-run lock file"
assert_path_absent "$noop_logs" "no-op dry-run log directory"

noop_restore_repo="$fixture_root/noop-restore-repo"
noop_restore_state="$fixture_root/noop-restore-state"
noop_restore_logs="$fixture_root/noop-restore-logs"
make_upgrade_fixture "$noop_restore_repo"
noop_restore_sha="$(git -C "$noop_restore_repo" rev-parse HEAD)"
noop_restore_tree="$(git -C "$noop_restore_repo" rev-parse HEAD^{tree})"
git -C "$noop_restore_repo" checkout -qb operator-work
mkdir -p "$noop_restore_state"
cat > "$noop_restore_state/upgrade.state" <<EOF
last_seen_tag=2026.7.15
last_success_tag=2026.7.15
last_success_sha=$noop_restore_sha
last_success_ts=2026-07-15T00:00:00Z
last_success_ref=2026.7.15
last_success_kind=tag
last_success_target_sha=$noop_restore_sha
EOF
noop_restore_output="$(run_fixture "$noop_restore_repo" "$noop_restore_state" "$noop_restore_logs")"
assert_contains "NOOP: latest tag already applied (2026.7.15) and integration branch is unchanged" "$noop_restore_output" "real no-op output"
assert_eq "operator-work" "$(git -C "$noop_restore_repo" branch --show-current)" "real no-op branch restoration"
assert_eq "$noop_restore_tree" "$(git -C "$noop_restore_repo" rev-parse HEAD^{tree})" "real no-op repository tree"
assert_eq "" "$(git -C "$noop_restore_repo" status --porcelain)" "real no-op worktree contents"

changed_head_repo="$fixture_root/changed-head-repo"
changed_head_state="$fixture_root/changed-head-state"
changed_head_logs="$fixture_root/changed-head-logs"
make_upgrade_fixture "$changed_head_repo"
changed_head_success_sha="$(git -C "$changed_head_repo" rev-parse HEAD)"
printf 'new downstream change\n' >> "$changed_head_repo/fixture.txt"
git -C "$changed_head_repo" commit -qam "new downstream change"
mkdir -p "$changed_head_state"
cat > "$changed_head_state/upgrade.state" <<EOF
last_seen_tag=2026.7.15
last_success_tag=2026.7.15
last_success_sha=$changed_head_success_sha
last_success_ts=2026-07-15T00:00:00Z
last_success_ref=2026.7.15
last_success_kind=tag
last_success_target_sha=$changed_head_success_sha
EOF
changed_head_output="$(run_dry_run_fixture "$changed_head_repo" "$changed_head_state" "$changed_head_logs")"
assert_not_contains "NOOP:" "$changed_head_output" "changed integration head no-op guard"
assert_contains "Rebasing integration branch ec-main" "$changed_head_output" "changed integration head continues upgrade"

remote_changed_repo="$fixture_root/remote-changed-repo"
remote_changed_state="$fixture_root/remote-changed-state"
remote_changed_logs="$fixture_root/remote-changed-logs"
make_upgrade_fixture "$remote_changed_repo"
remote_changed_success_sha="$(git -C "$remote_changed_repo" rev-parse HEAD)"
printf 'remote downstream change\n' >> "$remote_changed_repo/fixture.txt"
git -C "$remote_changed_repo" commit -qam "remote downstream change"
remote_changed_sha="$(git -C "$remote_changed_repo" rev-parse HEAD)"
git -C "$remote_changed_repo" update-ref refs/remotes/fork/ec-main "$remote_changed_sha"
git -C "$remote_changed_repo" reset -q --hard "$remote_changed_success_sha"
mkdir -p "$remote_changed_state"
cat > "$remote_changed_state/upgrade.state" <<EOF
last_seen_tag=2026.7.15
last_success_tag=2026.7.15
last_success_sha=$remote_changed_success_sha
last_success_ts=2026-07-15T00:00:00Z
last_success_ref=2026.7.15
last_success_kind=tag
last_success_target_sha=$remote_changed_success_sha
EOF
remote_changed_output="$(run_dry_run_fixture "$remote_changed_repo" "$remote_changed_state" "$remote_changed_logs")"
assert_contains "Fast-forwarding local branch ec-main to fork/ec-main" "$remote_changed_output" "remote reconciliation before no-op"
assert_not_contains "NOOP:" "$remote_changed_output" "remote integration head no-op guard"

ref_noop_repo="$fixture_root/ref-noop-repo"
ref_noop_state="$fixture_root/ref-noop-state"
ref_noop_logs="$fixture_root/ref-noop-logs"
make_upgrade_fixture "$ref_noop_repo"
ref_noop_sha="$(git -C "$ref_noop_repo" rev-parse HEAD)"
mkdir -p "$ref_noop_state"
cat > "$ref_noop_state/upgrade.state" <<EOF
last_seen_tag=
last_success_tag=
last_success_sha=$ref_noop_sha
last_success_ts=2026-07-15T00:00:00Z
last_success_ref=origin/main
last_success_kind=ref
last_success_target_sha=$ref_noop_sha
EOF
ref_noop_output="$(run_dry_run_fixture "$ref_noop_repo" "$ref_noop_state" "$ref_noop_logs" --ref origin/main)"
assert_contains "NOOP: target ref already applied (origin/main" "$ref_noop_output" "ref no-op branch head guard"

identity_gate_line="$(grep -n 'restarted gateway returned no version identity' "$UPGRADER" | cut -d: -f1)"
build_gate_line="$(grep -n 'installed build identity is missing a build sha' "$UPGRADER" | cut -d: -f1)"
gateway_build_gate_line="$(grep -n 'restarted gateway identity is missing a build sha' "$UPGRADER" | cut -d: -f1)"
ref_build_gate_line="$(grep -n 'installed ref build identity is missing a build sha' "$UPGRADER" | cut -d: -f1)"
state_write_line="$(grep -n '^PHASE="STATE"' "$UPGRADER" | cut -d: -f1)"
if (( identity_gate_line >= state_write_line || build_gate_line >= state_write_line || gateway_build_gate_line >= state_write_line || ref_build_gate_line >= state_write_line )); then
  echo "error: gateway identity gates must run before success state is written" >&2
  exit 1
fi

echo "auto-upgrade gateway identity harness passed"
