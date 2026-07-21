#!/usr/bin/env bash
set -euo pipefail

# Cron entrypoint for unattended integration-branch auto-upgrades.
# - Script sends its own Slack notifications (warning, success, failure)
# - This wrapper stays silent for cron delivery plumbing
# - Unattended release upgrades target the deployable integration branch only.
#   Persistent feature branches are intentionally excluded by default so stale
#   rebases cannot block live upgrade/install of ec-main.
# - Because ec-main is maintained by rebasing onto origin/main, the unattended
#   cron path should default to upstream main, not the latest release tag,
#   unless an explicit target env was already provided by the operator.

REPO_DIR="${OPENCLAW_AUTO_REPO_DIR:-/home/ecochran76/workspace.local/openclaw.git}"
CHANNEL="${OPENCLAW_AUTO_NOTIFY_CHANNEL:-slack}"
TARGET="${OPENCLAW_AUTO_NOTIFY_TARGET:-C0AGFJ7D0RY}"
REPLY_TO="${OPENCLAW_AUTO_NOTIFY_REPLY_TO:-1772115869.821949}"
BRANCH="${OPENCLAW_AUTO_BRANCH:-ec-main}"
NO_FEATURE_SYNC="${OPENCLAW_AUTO_NO_FEATURE_SYNC:-1}"
FEATURE_BRANCHES_RAW="${OPENCLAW_AUTO_FEATURE_BRANCHES:-}"

EXTRA_ARGS=()
if [[ "${OPENCLAW_AUTO_FORCE:-0}" == "1" ]]; then
  EXTRA_ARGS+=(--force)
fi
if [[ "${OPENCLAW_AUTO_DRY_RUN:-0}" == "1" ]]; then
  EXTRA_ARGS+=(--dry-run)
fi
if [[ "$NO_FEATURE_SYNC" == "1" ]]; then
  EXTRA_ARGS+=(--no-feature-sync)
fi

FEATURE_ARGS=()
if [[ "$NO_FEATURE_SYNC" != "1" ]]; then
  FEATURE_BRANCHES_RAW="${FEATURE_BRANCHES_RAW//,/ }"
  for feature_branch in $FEATURE_BRANCHES_RAW; do
    if [[ -n "$feature_branch" ]]; then
      FEATURE_ARGS+=(--feature-branch "$feature_branch")
    fi
  done
fi

if [[ -z "${OPENCLAW_AUTO_TARGET_KIND:-}" && -z "${OPENCLAW_AUTO_TARGET_REF:-}" ]]; then
  EXTRA_ARGS+=(--latest-main)
fi

"$REPO_DIR/scripts/auto-upgrade-on-release-tag.sh" \
  --repo-dir "$REPO_DIR" \
  --branch "$BRANCH" \
  "${FEATURE_ARGS[@]}" \
  --upstream-remote origin \
  --fork-remote fork \
  --channel "$CHANNEL" \
  --target "$TARGET" \
  --reply-to "$REPLY_TO" \
  "${EXTRA_ARGS[@]}"

echo "NO_REPLY"
