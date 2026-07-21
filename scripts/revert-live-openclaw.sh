#!/usr/bin/env bash
set -euo pipefail

# Restore a previously backed-up global OpenClaw install tarball.
#
# Usage:
#   scripts/revert-live-openclaw.sh [backup-tgz] [--dry-run]
#
# Examples:
#   scripts/revert-live-openclaw.sh
#   scripts/revert-live-openclaw.sh /tmp/openclaw-live-patch-backups/openclaw-global-backup-20260225-185329.tgz
#   scripts/revert-live-openclaw.sh --dry-run

DRY_RUN=0
BACKUP_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -*)
      echo "error: unknown argument: $1" >&2
      exit 2
      ;;
    *)
      if [[ -n "$BACKUP_ARG" ]]; then
        echo "error: specify at most one backup archive" >&2
        exit 2
      fi
      BACKUP_ARG="$1"
      shift
      ;;
  esac
done

run_cmd() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

metadata_get() {
  local key="$1"
  local metadata_file="$2"
  awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1); exit }' "$metadata_file"
}

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PATCH_TMP_ROOT="${OPENCLAW_PATCH_TMP_ROOT:-${TMPDIR:-/tmp}}"
BACKUP_DIR="${BACKUP_DIR:-$PATCH_TMP_ROOT/openclaw-live-patch-backups}"

if [[ -n "$BACKUP_ARG" ]]; then
  BACKUP_TGZ="$BACKUP_ARG"
else
  BACKUP_TGZ="$(ls -1t "$BACKUP_DIR"/openclaw-global-backup-*.tgz 2>/dev/null | head -n1 || true)"
fi

if [[ -z "$BACKUP_TGZ" ]]; then
  echo "error: no backup archive found. expected in: $BACKUP_DIR" >&2
  exit 1
fi

if [[ ! -f "$BACKUP_TGZ" ]]; then
  echo "error: backup archive not found: $BACKUP_TGZ" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
RESTORE_STAGE_DIR=""
RESTORE_HOLD_DIR=""
RESTORE_SWAPPED=0
cleanup() {
  if [[ "$RESTORE_SWAPPED" == "1" ]]; then
    rm -rf "$RESTORE_PACKAGE_DIR" >/dev/null 2>&1 || true
    if [[ -n "$RESTORE_HOLD_DIR" && ( -e "$RESTORE_HOLD_DIR" || -L "$RESTORE_HOLD_DIR" ) ]]; then
      mv "$RESTORE_HOLD_DIR" "$RESTORE_PACKAGE_DIR" >/dev/null 2>&1 || true
    fi
  fi
  if [[ -n "$RESTORE_STAGE_DIR" ]]; then
    rm -rf "$RESTORE_STAGE_DIR"
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

tar -xzf "$BACKUP_TGZ" -C "$TMP_DIR"

if [[ ! -f "$TMP_DIR/openclaw/package.json" ]]; then
  echo "error: backup archive does not contain openclaw/package.json" >&2
  exit 1
fi

BACKUP_METADATA="$TMP_DIR/.openclaw-live-patch-backup-metadata"
if [[ ! -f "$BACKUP_METADATA" ]]; then
  echo "error: backup archive has no npm-prefix metadata and cannot be restored safely: $BACKUP_TGZ" >&2
  exit 1
fi

BACKUP_FORMAT="$(metadata_get format "$BACKUP_METADATA")"
RESTORE_PREFIX="$(metadata_get npm_prefix "$BACKUP_METADATA")"
RESTORE_PACKAGE_DIR="$(metadata_get package_dir "$BACKUP_METADATA")"
if [[ "$BACKUP_FORMAT" != "1" || -z "$RESTORE_PREFIX" ]]; then
  echo "error: invalid backup metadata in: $BACKUP_TGZ" >&2
  exit 1
fi

EXPECTED_PACKAGE_DIR="$RESTORE_PREFIX/lib/node_modules/openclaw"
if [[ "$RESTORE_PACKAGE_DIR" != "$EXPECTED_PACKAGE_DIR" ]]; then
  echo "error: backup package path does not match its npm prefix: $RESTORE_PACKAGE_DIR" >&2
  exit 1
fi

RESTORE_SRC="$TMP_DIR/openclaw"
RESTORE_PARENT="$(dirname "$RESTORE_PACKAGE_DIR")"
RESTORE_CLI="$RESTORE_PREFIX/bin/openclaw"

if [[ "$DRY_RUN" == "1" ]]; then
  run_cmd mkdir -p "$RESTORE_PARENT"
  run_cmd cp -a "$RESTORE_SRC" "$RESTORE_PARENT/.openclaw-restore.STAGED"
  run_cmd mv "$RESTORE_PACKAGE_DIR" "$RESTORE_PARENT/.openclaw-revert-current.STAGED"
  run_cmd mv "$RESTORE_PARENT/.openclaw-restore.STAGED" "$RESTORE_PACKAGE_DIR"
  run_cmd "$RESTORE_CLI" --version
else
  mkdir -p "$RESTORE_PARENT"
  RESTORE_STAGE_DIR="$(mktemp -d "$RESTORE_PARENT/.openclaw-restore.XXXXXX")"
  RESTORE_STAGED_PACKAGE="$RESTORE_STAGE_DIR/openclaw"
  cp -a "$RESTORE_SRC" "$RESTORE_STAGED_PACKAGE"

  if [[ -e "$RESTORE_PACKAGE_DIR" || -L "$RESTORE_PACKAGE_DIR" ]]; then
    RESTORE_HOLD_DIR="$(mktemp -d "$RESTORE_PARENT/.openclaw-revert-current.XXXXXX")"
    rmdir "$RESTORE_HOLD_DIR"
    mv "$RESTORE_PACKAGE_DIR" "$RESTORE_HOLD_DIR"
  fi
  RESTORE_SWAPPED=1
  mv "$RESTORE_STAGED_PACKAGE" "$RESTORE_PACKAGE_DIR"

  if [[ ! -x "$RESTORE_CLI" ]] || ! "$RESTORE_CLI" --version; then
    echo "error: restored OpenClaw package failed CLI verification; restoring the pre-revert package" >&2
    exit 1
  fi

  RESTORE_SWAPPED=0
  if [[ -n "$RESTORE_HOLD_DIR" ]]; then
    rm -rf "$RESTORE_HOLD_DIR"
    RESTORE_HOLD_DIR=""
  fi
fi

echo "restored from: $BACKUP_TGZ"
echo "restored npm prefix: $RESTORE_PREFIX"
