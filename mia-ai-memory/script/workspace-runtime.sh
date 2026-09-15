#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/docker/.env"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-$HOME/.ai-memory/runtime}"
PID_FILE="$RUNTIME_DIR/workspace-runtime.pid"
LOG_FILE="$RUNTIME_DIR/workspace-runtime.log"
RUNTIME_ENTRY="$PROJECT_ROOT/services/workspace-runtime/src/index.js"
ACTION="${1:-start}"

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

read_env() {
  local key="$1"
  if [[ -f "$ENV_FILE" ]]; then
    grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
  fi
}

runtime_pid() {
  if [[ -f "$PID_FILE" ]]; then
    cat "$PID_FILE" 2>/dev/null || true
  fi
}

runtime_running() {
  local pid
  pid="$(runtime_pid)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

start_runtime() {
  command -v node >/dev/null 2>&1 || fail "Node.js nao encontrado. O Workspace Runtime exige Node.js 22 ou superior."
  local node_major
  node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
  [[ "$node_major" -ge 22 ]] || fail "Node.js 22 ou superior e obrigatorio para o Workspace Runtime. Versao atual: $(node --version)"
  [[ -f "$RUNTIME_ENTRY" ]] || fail "Workspace Runtime nao encontrado em $RUNTIME_ENTRY"
  mkdir -p "$RUNTIME_DIR"
  if runtime_running; then
    printf 'Workspace Runtime ja esta em execucao. PID %s\n' "$(runtime_pid)"
    return 0
  fi
  rm -f "$PID_FILE"
  local host port origins
  host="${AI_MEMORY_WORKSPACE_RUNTIME_HOST:-$(read_env AI_MEMORY_WORKSPACE_RUNTIME_HOST)}"
  port="${AI_MEMORY_WORKSPACE_RUNTIME_PORT:-$(read_env AI_MEMORY_WORKSPACE_RUNTIME_PORT)}"
  origins="${AI_MEMORY_WORKSPACE_ORIGINS:-$(read_env AI_MEMORY_WORKSPACE_ORIGINS)}"
  host="${host:-127.0.0.1}"
  port="${port:-8791}"
  origins="${origins:-http://localhost:5173,http://127.0.0.1:5173}"
  nohup env \
    AI_MEMORY_WORKSPACE_RUNTIME_HOST="$host" \
    AI_MEMORY_WORKSPACE_RUNTIME_PORT="$port" \
    AI_MEMORY_WORKSPACE_ORIGINS="$origins" \
    node "$RUNTIME_ENTRY" >"$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 0.5
  if ! runtime_running; then
    cat "$LOG_FILE" >&2 || true
    fail "Workspace Runtime nao iniciou."
  fi
  printf 'Workspace Runtime iniciado: http://%s:%s (PID %s)\n' "$host" "$port" "$(runtime_pid)"
  printf 'Logs: %s\n' "$LOG_FILE"
}

stop_runtime() {
  if ! runtime_running; then
    rm -f "$PID_FILE"
    printf 'Workspace Runtime nao esta em execucao.\n'
    return 0
  fi
  local pid
  pid="$(runtime_pid)"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      printf 'Workspace Runtime parado.\n'
      return 0
    fi
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  printf 'Workspace Runtime finalizado.\n'
}

status_runtime() {
  if runtime_running; then
    printf 'Workspace Runtime ativo. PID %s\n' "$(runtime_pid)"
    exit 0
  fi
  printf 'Workspace Runtime parado.\n'
  exit 1
}

case "$ACTION" in
  start) start_runtime ;;
  stop) stop_runtime ;;
  restart) stop_runtime; start_runtime ;;
  status) status_runtime ;;
  logs) touch "$LOG_FILE"; tail -f "$LOG_FILE" ;;
  *) fail "Acao invalida: $ACTION. Use start, stop, restart, status ou logs." ;;
esac
