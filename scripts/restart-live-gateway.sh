#!/usr/bin/env bash
set -euo pipefail

# Restart the live gateway with service-manager awareness.
# After global package swaps, a generic `openclaw gateway restart` can leave the
# old process serving stale hashed chunks. Prefer the platform service manager
# when the live gateway is already running under one, then verify RPC health.

DRY_RUN=0
SKIP_PROBE=0
OPENCLAW_ENV_DIR="${OPENCLAW_PATCH_ENV_DIR:-$HOME/.openclaw}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-probe)
      SKIP_PROBE=1
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Usage: restart-live-gateway.sh [options]

Options:
  --dry-run     Print actions without making changes
  --skip-probe  Restart only; skip post-restart RPC probe
  -h, --help    Show help
EOF
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

use_direnv_openclaw() {
  command -v direnv >/dev/null 2>&1 &&
    [[ -d "$OPENCLAW_ENV_DIR" ]] &&
    [[ -f "$OPENCLAW_ENV_DIR/.envrc" ]]
}

print_quoted_command() {
  local first=1
  for arg in "$@"; do
    if [[ "$first" == "1" ]]; then
      printf '%q' "$arg"
      first=0
    else
      printf ' %q' "$arg"
    fi
  done
  printf '\n'
}

openclaw_cli() {
  if use_direnv_openclaw; then
    DIRENV_LOG_FORMAT= direnv exec "$OPENCLAW_ENV_DIR" openclaw "$@"
    return
  fi
  openclaw "$@"
}

run_cmd() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] '
    print_quoted_command "$@"
    return 0
  fi
  "$@"
}

run_openclaw_cli() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] '
    if use_direnv_openclaw; then
      print_quoted_command env DIRENV_LOG_FORMAT= direnv exec "$OPENCLAW_ENV_DIR" openclaw "$@"
    else
      print_quoted_command openclaw "$@"
    fi
    return 0
  fi
  openclaw_cli "$@"
}

parse_gateway_status_summary() {
  node -e '
const fs = require("fs");
const path = require("path");

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.exit(1);
  }

  const service = parsed?.service ?? {};
  const label = typeof service.label === "string" ? service.label : "";
  const loaded = service.loaded === true ? "1" : "0";
  let unit = "";
  const envUnit = service?.command?.environment?.OPENCLAW_SYSTEMD_UNIT;
  if (typeof envUnit === "string" && envUnit.trim().length > 0) {
    unit = envUnit.trim();
  }
  if (!unit) {
    const sourcePath = service?.command?.sourcePath;
    if (typeof sourcePath === "string" && sourcePath.trim().length > 0) {
      const base = path.basename(sourcePath.trim());
      if (base.endsWith(".service")) {
        unit = base;
      }
    }
  }

  process.stdout.write(`${label}\n${loaded}\n${unit}\n`);
});
'
}

GATEWAY_STATUS_JSON="$(openclaw_cli gateway status --json 2>/dev/null || true)"
SERVICE_LABEL=""
SERVICE_LOADED="0"
SYSTEMD_UNIT=""
if [[ -n "$GATEWAY_STATUS_JSON" ]]; then
  mapfile -t gateway_status_summary < <(printf '%s' "$GATEWAY_STATUS_JSON" | parse_gateway_status_summary || true)
  SERVICE_LABEL="${gateway_status_summary[0]:-}"
  SERVICE_LOADED="${gateway_status_summary[1]:-0}"
  SYSTEMD_UNIT="${gateway_status_summary[2]:-}"
fi

if [[ "$SERVICE_LABEL" == "systemd" && -n "$SYSTEMD_UNIT" ]]; then
  echo "info: restarting live gateway via systemd unit $SYSTEMD_UNIT"
  run_cmd systemctl --user restart "$SYSTEMD_UNIT"
else
  if [[ -n "$SERVICE_LABEL" ]]; then
    echo "info: restarting live gateway via openclaw CLI (service=${SERVICE_LABEL:-unknown}, loaded=${SERVICE_LOADED})"
  else
    echo "warning: unable to inspect gateway service manager; falling back to openclaw CLI restart"
  fi
  run_openclaw_cli gateway restart
fi

if [[ "$SKIP_PROBE" == "1" ]]; then
  echo "info: post-restart probe skipped"
  exit 0
fi

echo "info: verifying gateway RPC after restart"
run_openclaw_cli gateway status --deep --require-rpc
