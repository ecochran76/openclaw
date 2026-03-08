#!/usr/bin/env bash
set -euo pipefail

# Cron entrypoint for unattended release-tag auto-upgrades.
# - Script sends its own Slack notifications (warning, success, failure)
# - This wrapper stays silent for cron delivery plumbing

REPO_DIR="${OPENCLAW_AUTO_REPO_DIR:-/home/ecochran76/workspace.local/openclaw.git}"
CHANNEL="${OPENCLAW_AUTO_NOTIFY_CHANNEL:-slack}"
TARGET="${OPENCLAW_AUTO_NOTIFY_TARGET:-C0AGFJ7D0RY}"
REPLY_TO="${OPENCLAW_AUTO_NOTIFY_REPLY_TO:-1772115869.821949}"
BRANCH="${OPENCLAW_AUTO_BRANCH:-ec-main}"
FEATURE_BRANCHES_RAW="${OPENCLAW_AUTO_FEATURE_BRANCHES:-feat/a2a-ingress-echo,feat/profile-upgrade}"

EXTRA_ARGS=()
if [[ "${OPENCLAW_AUTO_FORCE:-0}" == "1" ]]; then
  EXTRA_ARGS+=(--force)
fi
if [[ "${OPENCLAW_AUTO_DRY_RUN:-0}" == "1" ]]; then
  EXTRA_ARGS+=(--dry-run)
fi
if [[ "${OPENCLAW_AUTO_NO_FEATURE_SYNC:-0}" == "1" ]]; then
  EXTRA_ARGS+=(--no-feature-sync)
fi

FEATURE_ARGS=()
if [[ "${OPENCLAW_AUTO_NO_FEATURE_SYNC:-0}" != "1" ]]; then
  FEATURE_BRANCHES_RAW="${FEATURE_BRANCHES_RAW//,/ }"
  for feature_branch in $FEATURE_BRANCHES_RAW; do
    if [[ -n "$feature_branch" ]]; then
      FEATURE_ARGS+=(--feature-branch "$feature_branch")
    fi
  done
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
