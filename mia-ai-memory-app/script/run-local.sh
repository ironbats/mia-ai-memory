#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_HOST="${FRONTEND_HOST:-0.0.0.0}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
COGNITIVE_API_URL="${COGNITIVE_API_URL:-http://127.0.0.1:8787}"

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js nao encontrado. Instale Node.js 22 ou superior."
command -v npm >/dev/null 2>&1 || fail "npm nao encontrado."
[[ -f "$PROJECT_ROOT/package.json" ]] || fail "package.json nao encontrado em $PROJECT_ROOT"

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
[[ "$NODE_MAJOR" -ge 22 ]] || fail "Node.js 22 ou superior e obrigatorio. Versao atual: $(node --version)"

cd "$PROJECT_ROOT"

if [[ ! -x "$PROJECT_ROOT/node_modules/.bin/vite" ]]; then
  if [[ -f "$PROJECT_ROOT/package-lock.json" ]]; then
    npm ci --no-audit --no-fund
  else
    npm install --no-audit --no-fund --no-package-lock
  fi
fi

if command -v curl >/dev/null 2>&1; then
  if ! curl -fsS "$COGNITIVE_API_URL/healthz" >/dev/null 2>&1; then
    printf 'AVISO: backend nao respondeu em %s/healthz. O frontend sera iniciado mesmo assim.\n' "$COGNITIVE_API_URL" >&2
  fi
fi

export COGNITIVE_API_URL

printf 'Frontend: http://127.0.0.1:%s\n' "$FRONTEND_PORT"
printf 'Backend configurado: %s\n' "$COGNITIVE_API_URL"

exec npm run dev -- --host "$FRONTEND_HOST" --port "$FRONTEND_PORT"
