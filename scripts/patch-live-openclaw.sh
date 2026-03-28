#!/usr/bin/env bash
set -euo pipefail

# Build this repo and install the resulting package globally,
# with a backup of the currently installed global openclaw package.
#
# Usage:
#   scripts/patch-live-openclaw.sh [--dry-run] [--expect-branch ec-main] [--require-expected-branch] [--skip-restart]
#
# Env overrides:
#   OPENCLAW_REPO_DIR=/path/to/openclaw.git
#   BACKUP_DIR=/tmp/openclaw-live-patch-backups
#   OPENCLAW_PATCH_TMP_ROOT=/tmp
#   OPENCLAW_PATCH_EXPECT_BRANCH=ec-main
#   OPENCLAW_PATCH_REQUIRE_EXPECTED_BRANCH=1
#   OPENCLAW_PATCH_SKIP_RESTART=1
#   OPENCLAW_PATCH_ENV_DIR=$HOME/.openclaw
#   OPENCLAW_PATCH_RESTART_FLAG_FILE=/tmp/openclaw-patch-restart-needed.flag

DRY_RUN=0
PATCH_EXPECT_BRANCH="${OPENCLAW_PATCH_EXPECT_BRANCH:-}"
PATCH_REQUIRE_EXPECTED_BRANCH="${OPENCLAW_PATCH_REQUIRE_EXPECTED_BRANCH:-0}"
PATCH_SKIP_RESTART="${OPENCLAW_PATCH_SKIP_RESTART:-0}"
PATCH_RESTART_FLAG_FILE="${OPENCLAW_PATCH_RESTART_FLAG_FILE:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --expect-branch)
      PATCH_EXPECT_BRANCH="$2"
      shift 2
      ;;
    --require-expected-branch)
      PATCH_REQUIRE_EXPECTED_BRANCH=1
      shift
      ;;
    --skip-restart)
      PATCH_SKIP_RESTART=1
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Usage: patch-live-openclaw.sh [options]

Options:
  --dry-run                    Print actions without making changes
  --expect-branch <name>       Warn/error if current git branch differs
  --require-expected-branch    Treat branch mismatch as fatal
  --skip-restart               Install bits but do not restart gateway service
  -h, --help                   Show help
EOF
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

PATCH_NOTIFY_CHANNEL="${OPENCLAW_PATCH_NOTIFY_CHANNEL:-}"
PATCH_NOTIFY_TARGET="${OPENCLAW_PATCH_NOTIFY_TARGET:-}"
PATCH_NOTIFY_REPLY_TO="${OPENCLAW_PATCH_NOTIFY_REPLY_TO:-}"
PATCH_NOTIFY_ACCOUNT="${OPENCLAW_PATCH_NOTIFY_ACCOUNT:-}"
PATCH_RESTART_WARNING_TEXT="${OPENCLAW_PATCH_RESTART_WARNING_TEXT:-}"

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] %s\n' "$*"
  else
    eval "$@"
  fi
}

pack_tarball() {
  local pack_json filename
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] %s\n' "'$NPM_BIN' pack --ignore-scripts --json --pack-destination '$PACK_DIR'"
    return 0
  fi

  pack_json="$("$NPM_BIN" pack --ignore-scripts --json --pack-destination "$PACK_DIR")"
  filename="$(printf '%s' "$pack_json" | node -e '
const fs = require("fs");
const raw = fs.readFileSync(0, "utf8");
let parsed;
try {
  parsed = JSON.parse(raw);
} catch (error) {
  console.error(`error: failed to parse npm pack --json output: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const first = Array.isArray(parsed) ? parsed[0] : parsed;
const filename = first?.filename;
if (typeof filename !== "string" || filename.trim().length === 0) {
  console.error("error: npm pack --json produced no filename");
  process.exit(1);
}
process.stdout.write(filename);
')"

  if [[ -z "$filename" ]]; then
    echo "error: npm pack --json produced no filename" >&2
    exit 1
  fi

  printf '%s\n' "$PACK_DIR/$filename"
}

send_patch_notification() {
  local text="${1:-}"
  if [[ -z "$text" ]]; then
    return 0
  fi
  if [[ -z "$PATCH_NOTIFY_CHANNEL" || -z "$PATCH_NOTIFY_TARGET" ]]; then
    echo "warning: skipping patch notification (missing OPENCLAW_PATCH_NOTIFY_CHANNEL or OPENCLAW_PATCH_NOTIFY_TARGET)"
    return 0
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] openclaw message send --channel %q --target %q --message %q\n' \
      "$PATCH_NOTIFY_CHANNEL" "$PATCH_NOTIFY_TARGET" "$text"
    return 0
  fi

  local cmd=(openclaw message send --channel "$PATCH_NOTIFY_CHANNEL" --target "$PATCH_NOTIFY_TARGET" --message "$text")
  if [[ -n "$PATCH_NOTIFY_REPLY_TO" ]]; then
    cmd+=(--reply-to "$PATCH_NOTIFY_REPLY_TO")
  fi
  if [[ -n "$PATCH_NOTIFY_ACCOUNT" ]]; then
    cmd+=(--account "$PATCH_NOTIFY_ACCOUNT")
  fi

  if ! "${cmd[@]}" >/dev/null 2>&1; then
    echo "warning: failed to send patch notification"
  fi
}

resolve_npm_bin() {
  local openclaw_bin candidate
  openclaw_bin="$(command -v openclaw 2>/dev/null || true)"
  if [[ -n "$openclaw_bin" ]]; then
    candidate="$(dirname "$openclaw_bin")/npm"
    if [[ -x "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  fi
  command -v npm 2>/dev/null || true
}

parse_gateway_service_loaded() {
  node -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  try {
    const loaded = JSON.parse(raw)?.service?.loaded;
    process.stdout.write(loaded === true ? "1" : "0");
  } catch {
    process.stdout.write("0");
  }
});
'
}

has_systemd_gateway_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    return 1
  fi
  if systemctl --user --quiet is-enabled openclaw-gateway.service 2>/dev/null; then
    return 0
  fi
  if systemctl --user --quiet is-enabled "openclaw-gateway@*.service" 2>/dev/null; then
    return 0
  fi
  if systemctl --user --no-pager --no-legend list-unit-files 'openclaw-gateway*.service' 2>/dev/null \
    | awk 'NF{found=1} END{exit found?0:1}'; then
    return 0
  fi
  return 1
}

REPO_DIR="${OPENCLAW_REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
PATCH_TMP_ROOT="${OPENCLAW_PATCH_TMP_ROOT:-${TMPDIR:-/tmp}}"
BACKUP_DIR="${BACKUP_DIR:-$PATCH_TMP_ROOT/openclaw-live-patch-backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
PATCH_WORK_DIR="$(mktemp -d "$PATCH_TMP_ROOT/openclaw-live-patch-$TIMESTAMP.XXXXXX")"
PACK_DIR="$PATCH_WORK_DIR/pack"

cleanup() {
  rm -rf "$PATCH_WORK_DIR"
}
trap cleanup EXIT

if ! git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: REPO_DIR is not a git repo: $REPO_DIR" >&2
  exit 1
fi

cd "$REPO_DIR"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [[ -n "$PATCH_EXPECT_BRANCH" && "$CURRENT_BRANCH" != "$PATCH_EXPECT_BRANCH" ]]; then
  BRANCH_MSG="expected branch '$PATCH_EXPECT_BRANCH' but current branch is '${CURRENT_BRANCH:-unknown}'"
  if [[ "$PATCH_REQUIRE_EXPECTED_BRANCH" == "1" ]]; then
    echo "error: $BRANCH_MSG" >&2
    exit 1
  fi
  echo "warning: $BRANCH_MSG"
fi

NPM_BIN="$(resolve_npm_bin)"
if [[ -z "$NPM_BIN" ]]; then
  echo "error: npm not found in PATH" >&2
  exit 1
fi

echo "info: using npm binary: $NPM_BIN"
PACKAGE_DIR="$("$NPM_BIN" root -g)/openclaw"
BACKUP_TGZ="$BACKUP_DIR/openclaw-global-backup-$TIMESTAMP.tgz"

if [[ -L "$PACKAGE_DIR" && "$(readlink -f "$PACKAGE_DIR")" == "$REPO_DIR" ]]; then
  echo "info: global openclaw is linked to this repo; Control UI assets must be rebuilt after each pnpm build"
fi

run "mkdir -p '$BACKUP_DIR'"
run "mkdir -p '$PACK_DIR'"

if [[ -d "$PACKAGE_DIR" ]]; then
  run "tar -czf '$BACKUP_TGZ' -C '$(dirname "$PACKAGE_DIR")' '$(basename "$PACKAGE_DIR")'"
  echo "backup: $BACKUP_TGZ"
else
  echo "warning: global openclaw package dir not found at $PACKAGE_DIR"
fi

run "pnpm install --frozen-lockfile"
run "pnpm build"
run "pnpm ui:build"
run "node --import tsx scripts/check-bundled-dist-entries.ts"

if [[ "$DRY_RUN" != "1" && ! -f "$REPO_DIR/dist/control-ui/index.html" ]]; then
  echo "error: missing Control UI assets after ui:build: $REPO_DIR/dist/control-ui/index.html" >&2
  exit 1
fi

SMOKE_TEST_CANDIDATES=(
  "src/commands/models/auth.login-profiles.test.ts"
  "src/cli/models-cli.test.ts"
  "src/commands/agent.fallback-retry.test.ts"
)
SMOKE_TESTS=()
for test_file in "${SMOKE_TEST_CANDIDATES[@]}"; do
  if [[ -f "$REPO_DIR/$test_file" ]]; then
    SMOKE_TESTS+=("$test_file")
  fi
done
if [[ ${#SMOKE_TESTS[@]} -gt 0 ]]; then
  run "pnpm test -- --run ${SMOKE_TESTS[*]}"
else
  echo "warning: no configured smoke tests found; skipping targeted pre-install test run"
fi

# Create the tarball outside the repo checkout and install that artifact.
# Never install directly from the repo path; npm can copy a stale ignored dist/
# tree without running this repo's real build/prepack flow.
PKG_TGZ="$(pack_tarball)"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[dry-run] would install latest $PACK_DIR/openclaw-*.tgz globally"
  echo "done (dry-run)"
  exit 0
fi

if [[ -z "$PKG_TGZ" ]]; then
  echo "error: npm pack did not produce a tarball" >&2
  exit 1
fi

if ! tar -tf "$PKG_TGZ" | awk '$0=="package/dist/control-ui/index.html"{found=1} END{exit found?0:1}'; then
  echo "error: tarball is missing Control UI assets (package/dist/control-ui/index.html)" >&2
  exit 1
fi

run "'$NPM_BIN' i -g '$PKG_TGZ'"
run "openclaw --version"

GATEWAY_STATUS_JSON="$(openclaw gateway status --json 2>/dev/null || true)"
GATEWAY_SERVICE_LOADED="$(printf '%s' "$GATEWAY_STATUS_JSON" | parse_gateway_service_loaded)"
if [[ "$GATEWAY_SERVICE_LOADED" == "1" ]] || has_systemd_gateway_service; then
  echo "info: gateway service is loaded; refreshing service command path"
  run "openclaw gateway install --force"
  # `gateway install --force` resolves the runtime from the current shell and can
  # rewrite a previously repaired systemd unit back to an nvm/fnm/volta Node path.
  # Run doctor repair immediately after install so supported system Node 22+
  # remains preferred when available.
  echo "info: repairing gateway service config to keep stable runtime defaults"
  run "openclaw doctor --repair --non-interactive --yes"

  if [[ -n "$PATCH_RESTART_FLAG_FILE" ]]; then
    printf '1\n' > "$PATCH_RESTART_FLAG_FILE"
  fi

  if [[ "$PATCH_SKIP_RESTART" == "1" ]]; then
    echo "info: restart skipped (--skip-restart / OPENCLAW_PATCH_SKIP_RESTART=1)"
  else
    send_patch_notification "$PATCH_RESTART_WARNING_TEXT"
    if [[ "$DRY_RUN" == "1" ]]; then
      OPENCLAW_PATCH_ENV_DIR="${OPENCLAW_PATCH_ENV_DIR:-$HOME/.openclaw}" \
        "$REPO_DIR/scripts/restart-live-gateway.sh" --dry-run
    else
      OPENCLAW_PATCH_ENV_DIR="${OPENCLAW_PATCH_ENV_DIR:-$HOME/.openclaw}" \
        "$REPO_DIR/scripts/restart-live-gateway.sh"
    fi
  fi
fi

echo "done"
