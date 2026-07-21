#!/usr/bin/env bash
set -Eeuo pipefail

# Automatically apply upstream tagged releases using an integration branch model:
# - fetch remotes/tags
# - rebase integration branch onto upstream release tag
# - force-update fork integration branch
# - optionally rebase feature branches onto integration branch
# - reinstall live OpenClaw from integration branch via scripts/patch-live-openclaw.sh
#
# Default unattended behavior should keep release automation focused on the
# deployable integration branch. Feature-branch refresh is optional/manual and
# must not be required for a successful live upgrade.
#
# Optional notifications:
# - pre-restart warning (sent right before gateway restart in patch script)
# - success summary
# - failure summary
#
# Usage:
#   scripts/auto-upgrade-on-release-tag.sh [--force] [--dry-run]
#     [--repo-dir /path/to/openclaw.git]
#     [--branch ec-main]
#     [--feature-branch <name> ...]   # optional manual maintenance only
#     [--upstream-remote origin] [--fork-remote fork]
#     [--ref <git-ref>|--commit <sha>|--latest-main]
#     [--channel slack] [--target C0AGFJ7D0RY]
#     [--reply-to 1772115869.821949]
#
# Default behavior (no --ref/--commit/--latest-main): rebase onto latest upstream release tag.
#
# Environment equivalents are supported via OPENCLAW_AUTO_* vars.

REPO_DIR="${OPENCLAW_AUTO_REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
WORK_BRANCH="${OPENCLAW_AUTO_BRANCH:-ec-main}"
FEATURE_BRANCHES_RAW="${OPENCLAW_AUTO_FEATURE_BRANCHES:-}"
UPSTREAM_REMOTE="${OPENCLAW_AUTO_UPSTREAM_REMOTE:-origin}"
FORK_REMOTE="${OPENCLAW_AUTO_FORK_REMOTE:-fork}"

STATE_DIR="${OPENCLAW_AUTO_STATE_DIR:-$HOME/.openclaw/state}"
STATE_FILE="${OPENCLAW_AUTO_STATE_FILE:-$STATE_DIR/openclaw-auto-upgrade.state}"
LOCK_FILE="${OPENCLAW_AUTO_LOCK_FILE:-$STATE_DIR/openclaw-auto-upgrade.lock}"
LOG_DIR="${OPENCLAW_AUTO_LOG_DIR:-$HOME/.openclaw/logs/auto-upgrade}"

NOTIFY_CHANNEL="${OPENCLAW_AUTO_NOTIFY_CHANNEL:-}"
NOTIFY_TARGET="${OPENCLAW_AUTO_NOTIFY_TARGET:-}"
NOTIFY_REPLY_TO="${OPENCLAW_AUTO_NOTIFY_REPLY_TO:-}"
NOTIFY_ACCOUNT="${OPENCLAW_AUTO_NOTIFY_ACCOUNT:-}"

FORCE=0
DRY_RUN=0
NO_FEATURE_SYNC="${OPENCLAW_AUTO_NO_FEATURE_SYNC:-0}"

# Upgrade target selection:
# - default: latest upstream CalVer tag
# - --ref/--commit: rebase onto an explicit git ref
# - --latest-main: rebase onto upstream main HEAD
TARGET_REF="${OPENCLAW_AUTO_TARGET_REF:-}"
TARGET_KIND="${OPENCLAW_AUTO_TARGET_KIND:-}"  # tag|ref
if [[ -z "$TARGET_KIND" ]]; then
  if [[ -n "$TARGET_REF" ]]; then
    TARGET_KIND="ref"
  else
    TARGET_KIND="tag"
  fi
fi
TARGET_LATEST_MAIN=0

declare -a FEATURE_BRANCHES=()
declare -a FEATURE_BRANCH_ARGS=()
declare -a SYNCED_FEATURES=()
declare -a SKIPPED_FEATURES=()

PHASE="INIT"
LATEST_TAG=""
TARGET_LABEL=""
TARGET_SHA=""
EXPECTED_VERSION=""
RUN_LOG=""
PREV_BRANCH=""
IN_ERROR_HANDLER=0
PATCH_RESTART_FLAG_FILE=""
LIVE_ENV_DIR="${OPENCLAW_PATCH_ENV_DIR:-$HOME/.openclaw}"

usage() {
  cat <<'EOF'
Usage: auto-upgrade-on-release-tag.sh [options]

Options:
  --force                    Run even when the target was already applied
  --dry-run                  Print actions without making changes
  --repo-dir <dir>           Path to openclaw repo
  --branch <name>            Integration branch to rebase/push (default: ec-main)
  --feature-branch <name>    Feature branch to rebase onto integration branch (repeatable)
  --no-feature-sync          Skip feature-branch rebase/push step
  --upstream-remote <name>   Upstream remote (default: origin)
  --fork-remote <name>       Fork remote (default: fork)

  Target selection (optional; default is latest upstream release tag):
  --ref <git-ref>            Rebase onto an explicit ref (tag/branch/SHA)
  --commit <sha>             Alias for --ref <sha>
  --latest-main              Rebase onto <upstream-remote>/main HEAD

  Notifications (optional):
  --channel <name>           Notify channel (e.g. slack)
  --target <id>              Notify target (e.g. Slack channel id)
  --reply-to <id>            Reply/thread id for notifications
  --account <id>             Optional channel account id
  -h, --help                 Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --repo-dir)
      REPO_DIR="$2"
      shift 2
      ;;
    --branch)
      WORK_BRANCH="$2"
      shift 2
      ;;
    --feature-branch)
      FEATURE_BRANCH_ARGS+=("$2")
      shift 2
      ;;
    --no-feature-sync)
      NO_FEATURE_SYNC=1
      shift
      ;;
    --upstream-remote)
      UPSTREAM_REMOTE="$2"
      shift 2
      ;;
    --fork-remote)
      FORK_REMOTE="$2"
      shift 2
      ;;

    --ref)
      TARGET_KIND="ref"
      TARGET_REF="$2"
      TARGET_LATEST_MAIN=0
      shift 2
      ;;
    --commit)
      TARGET_KIND="ref"
      TARGET_REF="$2"
      TARGET_LATEST_MAIN=0
      shift 2
      ;;
    --latest-main)
      TARGET_KIND="ref"
      TARGET_REF=""
      TARGET_LATEST_MAIN=1
      shift
      ;;

    --channel)
      NOTIFY_CHANNEL="$2"
      shift 2
      ;;
    --target)
      NOTIFY_TARGET="$2"
      shift 2
      ;;
    --reply-to)
      NOTIFY_REPLY_TO="$2"
      shift 2
      ;;
    --account)
      NOTIFY_ACCOUNT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# Resolve this after parsing so `--upstream-remote` is order-independent while
# preserving last-target-option-wins behavior with --ref/--commit.
if [[ "$TARGET_LATEST_MAIN" == "1" ]]; then
  TARGET_REF="$UPSTREAM_REMOTE/main"
fi

DRY_RUN_TEMP_DIR=""
if [[ "$DRY_RUN" == "1" ]]; then
  source_repo_dir="$REPO_DIR"
  DRY_RUN_TEMP_DIR="$(mktemp -d)"
  git clone -q --no-hardlinks "$source_repo_dir" "$DRY_RUN_TEMP_DIR/repo"
  REPO_DIR="$DRY_RUN_TEMP_DIR/repo"
  while read -r source_ref_sha source_ref_name; do
    git -C "$REPO_DIR" update-ref "$source_ref_name" "$source_ref_sha"
  done < <(git -C "$source_repo_dir" for-each-ref --format='%(objectname) %(refname)' refs/remotes)
  for source_remote in $(git -C "$source_repo_dir" remote); do
    source_remote_url="$(git -C "$source_repo_dir" remote get-url "$source_remote")"
    git -C "$REPO_DIR" remote remove "$source_remote" >/dev/null 2>&1 || true
    git -C "$REPO_DIR" remote add "$source_remote" "$source_remote_url"
  done
fi

add_feature_branch() {
  local raw="${1:-}"
  local branch
  branch="$(printf '%s' "$raw" | sed -e 's/^\s\+//' -e 's/\s\+$//')"
  if [[ -z "$branch" || "$branch" == "$WORK_BRANCH" ]]; then
    return 0
  fi
  local existing
  for existing in "${FEATURE_BRANCHES[@]}"; do
    if [[ "$existing" == "$branch" ]]; then
      return 0
    fi
  done
  FEATURE_BRANCHES+=("$branch")
}

parse_feature_branch_list() {
  local raw="${1:-}"
  local token
  raw="${raw//,/ }"
  for token in $raw; do
    add_feature_branch "$token"
  done
}

if [[ "$NO_FEATURE_SYNC" != "1" ]]; then
  if [[ ${#FEATURE_BRANCH_ARGS[@]} -gt 0 ]]; then
    for feature_branch in "${FEATURE_BRANCH_ARGS[@]}"; do
      add_feature_branch "$feature_branch"
    done
  else
    parse_feature_branch_list "$FEATURE_BRANCHES_RAW"
  fi
fi

if [[ "$DRY_RUN" != "1" ]]; then
  mkdir -p "$STATE_DIR" "$LOG_DIR"
  RUN_LOG="$LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"
  touch "$RUN_LOG"
fi

log() {
  local line="[$(date +'%Y-%m-%d %H:%M:%S %Z')] $*"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '%s\n' "$line" >&2
  else
    echo "$line" | tee -a "$RUN_LOG" >&2
  fi
}

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] $*"
  else
    "$@"
  fi
}

state_get() {
  local key="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    return 1
  fi
  awk -F= -v k="$key" '$1==k{print substr($0, index($0,"=")+1)}' "$STATE_FILE" | tail -n1
}

state_set_all() {
  local last_seen_tag="$1"
  local last_success_tag="$2"
  local last_success_sha="$3"
  local last_success_ts="$4"
  local last_success_ref="${5:-}"
  local last_success_kind="${6:-}"
  local last_success_target_sha="${7:-}"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] would update state file: $STATE_FILE"
    return 0
  fi
  cat > "$STATE_FILE" <<EOF
last_seen_tag=${last_seen_tag}
last_success_tag=${last_success_tag}
last_success_sha=${last_success_sha}
last_success_ts=${last_success_ts}
last_success_ref=${last_success_ref}
last_success_kind=${last_success_kind}
last_success_target_sha=${last_success_target_sha}
EOF
}

send_message() {
  local text="$1"
  if [[ -z "$NOTIFY_CHANNEL" || -z "$NOTIFY_TARGET" ]]; then
    log "notification skipped (channel/target not configured): $text"
    return 0
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] openclaw message send --channel '$NOTIFY_CHANNEL' --target '$NOTIFY_TARGET' --message '$text'"
    return 0
  fi

  local cmd=(openclaw message send --channel "$NOTIFY_CHANNEL" --target "$NOTIFY_TARGET" --message "$text")
  if [[ -n "$NOTIFY_REPLY_TO" ]]; then
    cmd+=(--reply-to "$NOTIFY_REPLY_TO")
  fi
  if [[ -n "$NOTIFY_ACCOUNT" ]]; then
    cmd+=(--account "$NOTIFY_ACCOUNT")
  fi

  if ! "${cmd[@]}" >/dev/null 2>&1; then
    log "warning: failed to send notification"
  fi
}

abort_rebase_if_needed() {
  if [[ -d .git/rebase-merge || -d .git/rebase-apply ]]; then
    log "rebase in progress; aborting"
    git rebase --abort >/dev/null 2>&1 || true
  fi
}

restore_previous_checkout() {
  if [[ -z "$PREV_BRANCH" ]]; then
    return 0
  fi
  local current_branch
  current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ "$current_branch" == "$PREV_BRANCH" ]]; then
    return 0
  fi
  git checkout "$PREV_BRANCH" >/dev/null 2>&1
}

on_error() {
  local line="$1"
  local cmd="$2"
  local rc="$3"

  if [[ "$IN_ERROR_HANDLER" == "1" ]]; then
    exit "$rc"
  fi
  IN_ERROR_HANDLER=1

  {
    abort_rebase_if_needed
    restore_previous_checkout || true
  } || true

  local summary="🚨 OpenClaw auto-upgrade failed | phase=${PHASE} | tag=${LATEST_TAG:-unknown} | branch=${WORK_BRANCH} | rc=${rc}"
  local detail="line=${line} cmd=${cmd}"
  send_message "$summary
$detail
log=${RUN_LOG}"

  log "$summary"
  log "$detail"
  exit "$rc"
}
trap 'on_error "$LINENO" "$BASH_COMMAND" "$?"' ERR
on_exit() {
  local rc="$1"
  if [[ "$rc" != "0" && "$IN_ERROR_HANDLER" != "1" ]]; then
    IN_ERROR_HANDLER=1
    abort_rebase_if_needed
    restore_previous_checkout || true
    summary="🚨 OpenClaw auto-upgrade failed | phase=${PHASE} | tag=${LATEST_TAG:-unknown} | branch=${WORK_BRANCH} | rc=${rc}"
    send_message "$summary
line=$LINENO cmd=explicit exit
log=$RUN_LOG"
    log "$summary"
    log "line=$LINENO cmd=explicit exit"
  fi
  if [[ -n "$DRY_RUN_TEMP_DIR" ]]; then
    rm -rf "$DRY_RUN_TEMP_DIR"
    DRY_RUN_TEMP_DIR=""
  fi
}
trap 'on_exit "$?"' EXIT
exit() {
  local rc="${1:-0}"
  if [[ "$rc" != "0" && "$IN_ERROR_HANDLER" != "1" ]]; then
    on_error "$LINENO" "explicit exit" "$rc"
  fi
  builtin exit "$rc"
}

if [[ ! -d "$REPO_DIR/.git" ]]; then
  log "error: repo is not a git checkout: $REPO_DIR"
  exit 1
fi

cd "$REPO_DIR"
PREV_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"

if [[ "$DRY_RUN" != "1" ]]; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "NOOP: another auto-upgrade run is already active"
    exit 0
  fi
fi

latest_release_tag() {
  local tag
  git ls-remote --tags --refs "$UPSTREAM_REMOTE" \
    | awk '{sub(/^refs\/tags\//, "", $2); print $2}' \
    | grep -E '^v?[0-9]{4}\.[0-9]{1,2}\.[0-9]+(-[0-9]+)?$' \
    | sort -Vr \
    | while IFS= read -r tag; do
        if git merge-base --is-ancestor "$tag" "$UPSTREAM_REMOTE/main"; then
          printf '%s\n' "$tag"
          break
        fi
      done
}

normalize_reported_version() {
  local raw="${1:-}"
  raw="${raw#OpenClaw}"
  raw="${raw//[[:space:]]/}"
  raw="${raw%%(*}"
  printf '%s' "$raw"
}

extract_reported_build_sha() {
  local raw="${1:-}"
  if [[ "$raw" =~ \(([0-9a-f]{7,})\) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

normalize_expected_release_version() {
  local raw="${1:-}"
  raw="${raw#v}"
  printf '%s' "$raw"
}

normalize_expected_release_base_version() {
  local raw
  raw="$(normalize_expected_release_version "${1:-}")"
  printf '%s' "${raw%%-*}"
}

openclaw_live_cli() {
  if command -v direnv >/dev/null 2>&1 &&
    [[ -d "$LIVE_ENV_DIR" ]] &&
    [[ -f "$LIVE_ENV_DIR/.envrc" ]]; then
    DIRENV_LOG_FORMAT= direnv exec "$LIVE_ENV_DIR" openclaw "$@"
    return
  fi
  openclaw "$@"
}

ensure_local_branch() {
  local branch="$1"
  if git show-ref --verify --quiet "refs/heads/$branch"; then
    return 0
  fi
  if git show-ref --verify --quiet "refs/remotes/$FORK_REMOTE/$branch"; then
    log "Creating local branch $branch from $FORK_REMOTE/$branch"
    run git checkout -b "$branch" "$FORK_REMOTE/$branch"
    return 0
  fi
  return 1
}

reconcile_local_branch_with_fork() {
  local branch="$1"
  local remote_ref="refs/remotes/$FORK_REMOTE/$branch"
  if ! git show-ref --verify --quiet "$remote_ref"; then
    RECONCILED_BRANCH_SHA="$(git rev-parse "refs/heads/$branch")"
    return 0
  fi
  local remote_sha
  remote_sha="$(git rev-parse "$remote_ref")"
  if ! git show-ref --verify --quiet "refs/heads/$branch"; then
    if [[ "$DRY_RUN" == "1" ]]; then
      RECONCILED_BRANCH_SHA="$remote_sha"
      return 0
    fi
    log "error: local branch was not created as expected: $branch"
    return 1
  fi

  local local_sha
  local_sha="$(git rev-parse "refs/heads/$branch")"
  if git merge-base --is-ancestor "$remote_sha" "$local_sha"; then
    RECONCILED_BRANCH_SHA="$local_sha"
    return 0
  fi
  if git merge-base --is-ancestor "$local_sha" "$remote_sha"; then
    log "Fast-forwarding local branch $branch to $FORK_REMOTE/$branch (@ ${remote_sha:0:9})"
    run git merge --ff-only "$FORK_REMOTE/$branch"
    RECONCILED_BRANCH_SHA="$remote_sha"
    return 0
  fi

  log "error: local $branch and $FORK_REMOTE/$branch have diverged (local=${local_sha:0:9} remote=${remote_sha:0:9}); reconcile them manually before auto-upgrade"
  return 1
}

PHASE="FETCH"
log "Fetching remotes + tags"
if [[ "$DRY_RUN" == "1" ]]; then
  git fetch --all --prune --tags
else
  run git fetch --all --prune --tags
fi

LAST_SUCCESS_TAG="$(state_get last_success_tag || true)"
LAST_SUCCESS_SHA="$(state_get last_success_sha || true)"
LAST_SUCCESS_REF="$(state_get last_success_ref || true)"
LAST_SUCCESS_KIND="$(state_get last_success_kind || true)"
LAST_SUCCESS_TARGET_SHA="$(state_get last_success_target_sha || true)"
TARGET_ALREADY_APPLIED=0

if [[ "$TARGET_KIND" == "ref" ]]; then
  if [[ -z "$TARGET_REF" ]]; then
    log "error: --ref/--commit/--latest-main selected but no ref provided"
    exit 2
  fi
  TARGET_LABEL="$TARGET_REF"
  TARGET_SHA="$(git rev-parse --verify "$TARGET_REF^{commit}" 2>/dev/null || true)"
  if [[ -z "$TARGET_SHA" ]]; then
    log "error: could not resolve ref to a commit: $TARGET_REF"
    exit 1
  fi

  if [[ "$FORCE" != "1" && -n "$LAST_SUCCESS_TARGET_SHA" && "$TARGET_SHA" == "$LAST_SUCCESS_TARGET_SHA" ]]; then
    TARGET_ALREADY_APPLIED=1
  fi
else
  LATEST_TAG="$(latest_release_tag || true)"
  if [[ -z "$LATEST_TAG" ]]; then
    log "error: could not find a CalVer-style release tag (e.g. 2026.3.4)"
    exit 1
  fi

  TARGET_LABEL="$LATEST_TAG"
  TARGET_SHA="$(git rev-list -n1 "$LATEST_TAG")"
  EXPECTED_VERSION="${LATEST_TAG#v}"

  if [[ "$FORCE" != "1" && "$LATEST_TAG" == "$LAST_SUCCESS_TAG" ]]; then
    TARGET_ALREADY_APPLIED=1
  fi
fi

PHASE="CHECKOUT"
if ! ensure_local_branch "$WORK_BRANCH"; then
  log "error: integration branch not found locally or on $FORK_REMOTE: $WORK_BRANCH"
  exit 1
fi
log "Checking out integration branch $WORK_BRANCH"
run git checkout "$WORK_BRANCH"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  log "error: working tree has tracked changes; commit/stash before auto-upgrade"
  exit 1
fi
reconcile_local_branch_with_fork "$WORK_BRANCH"

if [[ -n "${RECONCILED_BRANCH_SHA:-}" ]]; then
  DEPLOYABLE_HEAD_SHA="$RECONCILED_BRANCH_SHA"
else
  DEPLOYABLE_HEAD_SHA="$(git rev-parse "refs/heads/$WORK_BRANCH")"
fi
if [[
  "$TARGET_ALREADY_APPLIED" == "1" &&
  -n "$LAST_SUCCESS_SHA" &&
  "$DEPLOYABLE_HEAD_SHA" == "$LAST_SUCCESS_SHA"
]]; then
  PHASE="NOOP"
  if [[ "$TARGET_KIND" == "ref" ]]; then
    state_set_all "" "$LAST_SUCCESS_TAG" "$LAST_SUCCESS_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$LAST_SUCCESS_REF" "$LAST_SUCCESS_KIND" "$LAST_SUCCESS_TARGET_SHA"
    log "NOOP: target ref already applied ($TARGET_LABEL @ ${TARGET_SHA:0:9}) and integration branch is unchanged"
  else
    state_set_all "$LATEST_TAG" "$LAST_SUCCESS_TAG" "$LAST_SUCCESS_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$LAST_SUCCESS_REF" "$LAST_SUCCESS_KIND" "$LAST_SUCCESS_TARGET_SHA"
    log "NOOP: latest tag already applied ($LATEST_TAG) and integration branch is unchanged"
  fi
  restore_previous_checkout
  exit 0
fi

PHASE="REBASE"
if [[ "$TARGET_KIND" == "ref" ]]; then
  log "Rebasing integration branch $WORK_BRANCH onto ref $TARGET_LABEL (@ ${TARGET_SHA:0:9})"
  run git rebase "$TARGET_SHA"
else
  log "Rebasing integration branch $WORK_BRANCH onto release tag $LATEST_TAG"
  run git rebase "$LATEST_TAG"
fi

NEW_HEAD_SHA="$(git rev-parse HEAD)"

PHASE="PUSH"
log "Force-updating $FORK_REMOTE/$WORK_BRANCH"
run git push --force-with-lease "$FORK_REMOTE" "$WORK_BRANCH"

if [[ "$NO_FEATURE_SYNC" != "1" && ${#FEATURE_BRANCHES[@]} -gt 0 ]]; then
  PHASE="SYNC_FEATURES"
  for feature_branch in "${FEATURE_BRANCHES[@]}"; do
    if ! ensure_local_branch "$feature_branch"; then
      log "warning: skipping feature branch (not found): $feature_branch"
      SKIPPED_FEATURES+=("$feature_branch")
      continue
    fi

    log "Checking out feature branch $feature_branch"
    run git checkout "$feature_branch"
    if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
      log "error: working tree has tracked changes on $feature_branch; commit/stash before auto-upgrade"
      exit 1
    fi
    reconcile_local_branch_with_fork "$feature_branch"

    log "Rebasing feature branch $feature_branch onto $WORK_BRANCH"
    run git rebase "$WORK_BRANCH"

    log "Force-updating $FORK_REMOTE/$feature_branch"
    run git push --force-with-lease "$FORK_REMOTE" "$feature_branch"
    SYNCED_FEATURES+=("$feature_branch")
  done

  log "Returning to integration branch $WORK_BRANCH"
  run git checkout "$WORK_BRANCH"
fi

PHASE="PATCH"
log "Running patch-live-openclaw.sh"
if [[ "$TARGET_KIND" == "ref" ]]; then
  PATCH_WARNING="⚠️ OpenClaw auto-upgrade for ref ${TARGET_LABEL} (@ ${TARGET_SHA:0:9}) is restarting the gateway now; success will be recorded after verified recovery."
else
  PATCH_WARNING="⚠️ OpenClaw auto-upgrade for tag ${LATEST_TAG} is restarting the gateway now; success will be recorded after verified recovery."
fi
if [[ "$DRY_RUN" != "1" ]]; then
  PATCH_RESTART_FLAG_FILE="$(mktemp "$STATE_DIR/openclaw-auto-upgrade-restart.XXXXXX")"
fi
export OPENCLAW_PATCH_NOTIFY_CHANNEL="$NOTIFY_CHANNEL"
export OPENCLAW_PATCH_NOTIFY_TARGET="$NOTIFY_TARGET"
export OPENCLAW_PATCH_NOTIFY_REPLY_TO="$NOTIFY_REPLY_TO"
export OPENCLAW_PATCH_NOTIFY_ACCOUNT="$NOTIFY_ACCOUNT"
export OPENCLAW_PATCH_RESTART_WARNING_TEXT="$PATCH_WARNING"
export OPENCLAW_PATCH_EXPECT_BRANCH="$WORK_BRANCH"
export OPENCLAW_PATCH_REQUIRE_EXPECTED_BRANCH=1
export OPENCLAW_PATCH_SKIP_RESTART=1
export OPENCLAW_PATCH_RESTART_FLAG_FILE="$PATCH_RESTART_FLAG_FILE"
if [[ "$DRY_RUN" == "1" ]]; then
  run "$REPO_DIR/scripts/patch-live-openclaw.sh" --dry-run --skip-restart
  PHASE="DONE"
  log "Dry-run complete (no changes applied)."
  exit 0
else
  run "$REPO_DIR/scripts/patch-live-openclaw.sh" --skip-restart
fi

RESTART_NEEDED=0
if [[ -n "$PATCH_RESTART_FLAG_FILE" && -f "$PATCH_RESTART_FLAG_FILE" ]]; then
  if grep -q '^1$' "$PATCH_RESTART_FLAG_FILE"; then
    RESTART_NEEDED=1
  fi
fi

if [[ "$RESTART_NEEDED" == "1" ]]; then
  PHASE="RESTART"
  send_message "$PATCH_WARNING"
  log "Restarting gateway and waiting for verified RPC recovery"
  OPENCLAW_PATCH_ENV_DIR="$LIVE_ENV_DIR" \
    run "$REPO_DIR/scripts/restart-live-gateway.sh"
fi

PHASE="VERIFY"
CLI_VERSION_RAW="$(openclaw_live_cli --version 2>/dev/null || true)"
CLI_VERSION="$(normalize_reported_version "$CLI_VERSION_RAW")"
CLI_BUILD_SHA="$(extract_reported_build_sha "$CLI_VERSION_RAW")"
if [[ -z "$CLI_VERSION" ]]; then
  log "error: failed to read openclaw --version"
  exit 1
fi

GATEWAY_APP_VERSION=""
if [[ "$RESTART_NEEDED" == "1" ]]; then
  if ! GATEWAY_STATUS_JSON="$(openclaw_live_cli gateway status --json 2>/dev/null)"; then
    log "error: failed to read restarted gateway identity from $LIVE_ENV_DIR"
    exit 1
  fi
  GATEWAY_APP_VERSION="$(printf '%s' "$GATEWAY_STATUS_JSON" | node "$REPO_DIR/scripts/auto-upgrade-gateway-identity.mjs" || true)"
  if [[ -z "$GATEWAY_APP_VERSION" ]]; then
    log "error: restarted gateway returned no version identity from $LIVE_ENV_DIR"
    exit 1
  fi
fi
GATEWAY_APP_VERSION_NORMALIZED="$(normalize_reported_version "$GATEWAY_APP_VERSION")"
GATEWAY_BUILD_SHA="$(extract_reported_build_sha "$GATEWAY_APP_VERSION")"

if [[ "$TARGET_KIND" != "ref" ]]; then
  if [[ -z "$EXPECTED_VERSION" ]]; then
    log "error: expected version was not computed for tag-based upgrade"
    exit 1
  fi

  EXPECTED_VERSION_NORMALIZED="$(normalize_expected_release_version "$EXPECTED_VERSION")"
  EXPECTED_BASE_VERSION="$(normalize_expected_release_base_version "$EXPECTED_VERSION")"

  if [[ "$CLI_VERSION" != "$EXPECTED_VERSION_NORMALIZED" && "$CLI_VERSION" != "$EXPECTED_BASE_VERSION" ]]; then
    log "error: CLI version mismatch (expected $EXPECTED_VERSION_NORMALIZED or base $EXPECTED_BASE_VERSION, got $CLI_VERSION_RAW)"
    exit 1
  fi

  if [[ -n "$CLI_BUILD_SHA" && "$CLI_BUILD_SHA" != "${NEW_HEAD_SHA:0:${#CLI_BUILD_SHA}}" ]]; then
    log "error: CLI build sha mismatch (expected ${NEW_HEAD_SHA:0:${#CLI_BUILD_SHA}}, got $CLI_BUILD_SHA)"
    exit 1
  fi

  if [[ -n "$GATEWAY_APP_VERSION_NORMALIZED" && "$GATEWAY_APP_VERSION_NORMALIZED" != "$EXPECTED_VERSION_NORMALIZED" && "$GATEWAY_APP_VERSION_NORMALIZED" != "$EXPECTED_BASE_VERSION" ]]; then
    log "error: gateway app version mismatch (expected $EXPECTED_VERSION_NORMALIZED or base $EXPECTED_BASE_VERSION, got $GATEWAY_APP_VERSION)"
    exit 1
  fi
else
  log "Note: ref-based upgrade selected; skipping CalVer version checks (cli=$CLI_VERSION${GATEWAY_APP_VERSION:+ gateway=$GATEWAY_APP_VERSION})"
  if [[ -z "$CLI_BUILD_SHA" ]]; then
    log "error: installed ref build identity is missing a build sha ($CLI_VERSION_RAW)"
    exit 1
  fi
  if [[ "$CLI_BUILD_SHA" != "${NEW_HEAD_SHA:0:${#CLI_BUILD_SHA}}" ]]; then
    log "error: installed ref build sha mismatch (expected ${NEW_HEAD_SHA:0:${#CLI_BUILD_SHA}}, got $CLI_BUILD_SHA)"
    exit 1
  fi
  if [[ -n "$GATEWAY_APP_VERSION_NORMALIZED" && "$GATEWAY_APP_VERSION_NORMALIZED" != "$CLI_VERSION" ]]; then
    log "error: gateway identity does not match installed CLI (cli=$CLI_VERSION gateway=$GATEWAY_APP_VERSION)"
    exit 1
  fi
fi

if [[ "$RESTART_NEEDED" == "1" ]]; then
  if [[ -z "$CLI_BUILD_SHA" ]]; then
    log "error: installed build identity is missing a build sha ($CLI_VERSION_RAW)"
    exit 1
  fi
  if [[ "$CLI_BUILD_SHA" != "${NEW_HEAD_SHA:0:${#CLI_BUILD_SHA}}" ]]; then
    log "error: installed build sha mismatch (expected ${NEW_HEAD_SHA:0:${#CLI_BUILD_SHA}}, got $CLI_BUILD_SHA)"
    exit 1
  fi
  if [[ -z "$GATEWAY_BUILD_SHA" ]]; then
    log "error: restarted gateway identity is missing a build sha ($GATEWAY_APP_VERSION)"
    exit 1
  fi
  if [[ "$GATEWAY_BUILD_SHA" != "${NEW_HEAD_SHA:0:${#GATEWAY_BUILD_SHA}}" ]]; then
    log "error: gateway build sha mismatch (expected ${NEW_HEAD_SHA:0:${#GATEWAY_BUILD_SHA}}, got $GATEWAY_BUILD_SHA)"
    exit 1
  fi
fi

PHASE="STATE"
if [[ "$TARGET_KIND" == "ref" ]]; then
  state_set_all "" "" "$NEW_HEAD_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TARGET_LABEL" "$TARGET_KIND" "$TARGET_SHA"
else
  state_set_all "$LATEST_TAG" "$LATEST_TAG" "$NEW_HEAD_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$LATEST_TAG" "$TARGET_KIND" "$TARGET_SHA"
fi

PHASE="DONE"
if [[ "$TARGET_KIND" == "ref" ]]; then
  SUCCESS_MSG="✅ OpenClaw auto-upgrade complete | ref=${TARGET_LABEL} | integration=${WORK_BRANCH} | head=${NEW_HEAD_SHA:0:9} | cli=${CLI_VERSION}"
else
  SUCCESS_MSG="✅ OpenClaw auto-upgrade complete | tag=${LATEST_TAG} | integration=${WORK_BRANCH} | head=${NEW_HEAD_SHA:0:9} | cli=${CLI_VERSION}"
fi
if [[ -n "$GATEWAY_APP_VERSION" ]]; then
  SUCCESS_MSG+=" | gateway=${GATEWAY_APP_VERSION}"
fi
if [[ "$NO_FEATURE_SYNC" == "1" ]]; then
  SUCCESS_MSG+="\nfeature_sync=disabled"
elif [[ ${#SYNCED_FEATURES[@]} -gt 0 ]]; then
  SUCCESS_MSG+="\nfeature_sync=ok:${SYNCED_FEATURES[*]}"
elif [[ ${#FEATURE_BRANCHES[@]} -gt 0 ]]; then
  SUCCESS_MSG+="\nfeature_sync=none"
fi
if [[ ${#SKIPPED_FEATURES[@]} -gt 0 ]]; then
  SUCCESS_MSG+="\nfeature_sync_skipped=${SKIPPED_FEATURES[*]}"
fi
if [[ "$TARGET_KIND" == "ref" ]]; then
  SUCCESS_MSG+="\ntarget_sha=${TARGET_SHA:0:9}"
else
  SUCCESS_MSG+="\nrelease_sha=${TARGET_SHA:0:9}"
fi

if [[ "$RESTART_NEEDED" == "1" ]]; then
  SUCCESS_MSG+="\ngateway_restart=verified"
fi
send_message "$SUCCESS_MSG"

log "$SUCCESS_MSG"

if [[ -n "$PATCH_RESTART_FLAG_FILE" ]]; then
  rm -f "$PATCH_RESTART_FLAG_FILE" >/dev/null 2>&1 || true
fi

restore_previous_checkout || true

exit 0
