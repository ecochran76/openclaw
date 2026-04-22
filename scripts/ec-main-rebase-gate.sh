#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: scripts/ec-main-rebase-gate.sh [options]

Run focused ec-main local-feature preservation gates.

Options:
  --family <name>       Feature family to validate: automation, voice, all (default: all)
  --check               Also run pnpm check
  --build               Also run pnpm build
  --live-patch          Run scripts/patch-live-openclaw.sh after gates/check/build
  --list                Print available families and commands without running them
  -h, --help            Show this help

Examples:
  scripts/ec-main-rebase-gate.sh --family automation
  scripts/ec-main-rebase-gate.sh --family voice --check --build
  scripts/ec-main-rebase-gate.sh --family all --check --build --live-patch
EOF
}

family="all"
run_check=0
run_build=0
run_live_patch=0
list_only=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --family)
      if [[ $# -lt 2 ]]; then
        echo "error: --family requires a value" >&2
        exit 2
      fi
      family="$2"
      shift 2
      ;;
    --check)
      run_check=1
      shift
      ;;
    --build)
      run_build=1
      shift
      ;;
    --live-patch)
      run_live_patch=1
      run_build=1
      shift
      ;;
    --list)
      list_only=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

automation_tests=(
  src/automation/command-surface.test.ts
  src/automation/worker-job.test.ts
  src/automation/worker-result.test.ts
  src/automation/progress-reporting.test.ts
  src/automation/runner.test.ts
  src/automation/status.test.ts
  src/agents/tools/automation-tool.test.ts
  src/auto-reply/reply/commands-automation.test.ts
  src/auto-reply/reply/commands-automation-status.test.ts
  src/automation/config.test.ts
)

voice_tests=(
  extensions/voice-call/index.test.ts
  extensions/voice-call/src/config.test.ts
  extensions/voice-call/src/config-compat.test.ts
  extensions/voice-call/src/media-stream.test.ts
  extensions/voice-call/src/webhook.test.ts
  extensions/voice-call/src/providers/stt-provider-config.test.ts
  extensions/voice-call/src/providers/stt-openai-realtime.test.ts
  extensions/voice-call/src/providers/stt-buffered-media-transcriber.test.ts
  extensions/voice-call/src/providers/stt-buffered-media.test.ts
  extensions/voice-call/src/providers/stt-factory.test.ts
  src/media-understanding/apply.test.ts
)

print_family() {
  local name="$1"
  shift
  echo "$name:"
  printf '  %s\n' "$@"
}

run_tests() {
  local name="$1"
  shift
  if [[ $# -eq 0 ]]; then
    return
  fi
  echo "==> $name"
  pnpm test -- "$@"
}

case "$family" in
  automation | voice | all) ;;
  *)
    echo "error: unsupported --family '$family' (expected automation, voice, or all)" >&2
    exit 2
    ;;
esac

cd "$ROOT_DIR"

if [[ "$list_only" -eq 1 ]]; then
  case "$family" in
    automation)
      print_family automation "${automation_tests[@]}"
      ;;
    voice)
      print_family voice "${voice_tests[@]}"
      ;;
    all)
      print_family automation "${automation_tests[@]}"
      print_family voice "${voice_tests[@]}"
      ;;
  esac
  [[ "$run_check" -eq 1 ]] && echo "check: pnpm check"
  [[ "$run_build" -eq 1 ]] && echo "build: pnpm build"
  [[ "$run_live_patch" -eq 1 ]] &&
    echo "live-patch: scripts/patch-live-openclaw.sh --expect-branch ec-main --require-expected-branch"
  exit 0
fi

case "$family" in
  automation)
    run_tests automation "${automation_tests[@]}"
    ;;
  voice)
    run_tests voice "${voice_tests[@]}"
    ;;
  all)
    run_tests automation "${automation_tests[@]}"
    run_tests voice "${voice_tests[@]}"
    ;;
esac

if [[ "$run_check" -eq 1 ]]; then
  echo "==> pnpm check"
  pnpm check
fi

if [[ "$run_build" -eq 1 ]]; then
  echo "==> pnpm build"
  pnpm build
fi

if [[ "$run_live_patch" -eq 1 ]]; then
  echo "==> live patch"
  scripts/patch-live-openclaw.sh --expect-branch ec-main --require-expected-branch
fi
