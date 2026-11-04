#!/usr/bin/env bash
# claude-symphony launcher.
#
#   scripts/symphony.sh start   [config] [-- extra cli args]   # background daemon
#   scripts/symphony.sh run     [config] [-- extra cli args]   # foreground (Ctrl-C to stop)
#   scripts/symphony.sh check   [config]                       # validate, list candidates, report labels
#   scripts/symphony.sh labels  [config]                       # create missing GitHub labels
#   scripts/symphony.sh stop | restart | status | logs
#
# Environment:
#   SYMPHONY_ENV_FILE   env file to load (default: <project>/.env; secrets such as GITHUB_TOKEN)
#   SYMPHONY_WORKFLOW   config path when none is given (default: <project>/symphony.yml)
#   SYMPHONY_STATE_DIR  pid/stdout dir (default: <project>/.symphony)
#   SYMPHONY_PORT       passed as --port when set
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${SYMPHONY_STATE_DIR:-$ROOT/.symphony}"
PID_FILE="$STATE_DIR/symphony.pid"
OUT_FILE="$STATE_DIR/symphony.out"
ENV_FILE="${SYMPHONY_ENV_FILE:-$ROOT/.env}"

die() { echo "symphony: $*" >&2; exit 1; }

load_env() {
  if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
  fi
  if [[ -z "${GITHUB_TOKEN:-}" && -z "${GH_TOKEN:-}" ]]; then
    echo "symphony: warning: GITHUB_TOKEN is not set (looked in $ENV_FILE)" >&2
  fi
}

ensure_node() {
  command -v node >/dev/null || die "node is not installed"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  (( major >= 22 )) || die "Node.js >= 22 required (found $(node -v))"
}

ensure_build() {
  if [[ ! -d "$ROOT/node_modules" ]]; then
    echo "symphony: installing dependencies..." >&2
    (cd "$ROOT" && npm ci --no-audit --no-fund >&2)
  fi
  # Rebuild when dist is missing or any source file is newer than the entrypoint.
  if [[ ! -f "$ROOT/dist/cli.js" ]] || [[ -n "$(find "$ROOT/src" -newer "$ROOT/dist/cli.js" -name '*.ts' -print -quit)" ]]; then
    echo "symphony: building..." >&2
    (cd "$ROOT" && npm run --silent build >&2)
  fi
}

running_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && { echo "$pid"; return 0; }
  rm -f "$PID_FILE"
  return 1
}

# Parse "[WORKFLOW] [-- extra...]" into WORKFLOW + EXTRA.
parse_args() {
  WORKFLOW="${SYMPHONY_WORKFLOW:-$ROOT/symphony.yml}"
  EXTRA=()
  if [[ $# -gt 0 && "$1" != "--" && "$1" != -* ]]; then WORKFLOW="$1"; shift; fi
  [[ "${1:-}" == "--" ]] && shift
  EXTRA=("$@")
  [[ -n "${SYMPHONY_PORT:-}" ]] && EXTRA+=(--port "$SYMPHONY_PORT")
  [[ -f "$WORKFLOW" ]] || die "config file not found: $WORKFLOW (copy $ROOT/symphony.example.yml to $ROOT/symphony.yml to start)"
  WORKFLOW="$(cd "$(dirname "$WORKFLOW")" && pwd)/$(basename "$WORKFLOW")"
}

cmd_start() {
  parse_args "$@"
  if pid="$(running_pid)"; then die "already running (pid $pid)"; fi
  ensure_node; ensure_build; load_env
  mkdir -p "$STATE_DIR"
  # Validate first so config errors surface here instead of in the background log.
  node "$ROOT/dist/cli.js" check "$WORKFLOW" || die "workflow check failed; not starting"
  nohup node "$ROOT/dist/cli.js" "$WORKFLOW" "${EXTRA[@]}" >>"$OUT_FILE" 2>&1 < /dev/null &
  echo $! >"$PID_FILE"
  sleep 1
  if pid="$(running_pid)"; then
    echo "symphony started (pid $pid), workflow=$WORKFLOW"
    echo "  output: $OUT_FILE"
  else
    tail -n 20 "$OUT_FILE" >&2 || true
    die "failed to start; see $OUT_FILE"
  fi
}

cmd_run() {
  parse_args "$@"
  ensure_node; ensure_build; load_env
  exec node "$ROOT/dist/cli.js" "$WORKFLOW" "${EXTRA[@]}"
}

cmd_check() {
  parse_args "$@"
  ensure_node; ensure_build; load_env
  exec node "$ROOT/dist/cli.js" check "$WORKFLOW"
}

cmd_labels() {
  parse_args "$@"
  ensure_node; ensure_build; load_env
  exec node "$ROOT/dist/cli.js" labels "$WORKFLOW"
}

cmd_stop() {
  local pid
  if ! pid="$(running_pid)"; then echo "symphony is not running"; return 0; fi
  kill -TERM "$pid"
  for _ in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || { rm -f "$PID_FILE"; echo "symphony stopped"; return 0; }
    sleep 0.5
  done
  echo "symphony: still running after 20s, sending SIGKILL" >&2
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
}

cmd_status() {
  local pid
  if pid="$(running_pid)"; then
    echo "symphony is running (pid $pid)"
  else
    echo "symphony is not running"
    return 3
  fi
}

cmd_logs() {
  [[ -f "$OUT_FILE" ]] || die "no output file yet: $OUT_FILE"
  exec tail -n 100 -f "$OUT_FILE"
}

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

sub="${1:-}"
[[ $# -gt 0 ]] && shift
case "$sub" in
  start) cmd_start "$@" ;;
  run) cmd_run "$@" ;;
  check) cmd_check "$@" ;;
  labels) cmd_labels "$@" ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start "$@" ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  -h | --help | help | "") usage ;;
  *) usage >&2; exit 2 ;;
esac
