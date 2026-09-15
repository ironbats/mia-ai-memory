#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/docker/docker-compose.yml"
ENV_FILE="$PROJECT_ROOT/docker/.env"
ENV_EXAMPLE="$PROJECT_ROOT/docker/cognitive.env.example"
WORKSPACE_RUNTIME_SCRIPT="$PROJECT_ROOT/script/workspace-runtime.sh"

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

env_value() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return 0
  fi
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

set_env_value() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

generate_master_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr -d '\n'
    return 0
  fi
  head -c 32 /dev/urandom | base64 | tr -d '\n'
}

command -v docker >/dev/null 2>&1 || fail "Docker nao encontrado. Instale o Docker Engine ou Docker Desktop."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 nao encontrado."
docker info >/dev/null 2>&1 || fail "Docker daemon nao esta em execucao ou o usuario nao possui permissao."
[[ -f "$COMPOSE_FILE" ]] || fail "Compose nao encontrado em $COMPOSE_FILE"

if [[ ! -f "$ENV_FILE" ]]; then
  [[ -f "$ENV_EXAMPLE" ]] || fail "Arquivo de exemplo nao encontrado em $ENV_EXAMPLE"
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  printf 'Arquivo local criado: %s\n' "$ENV_FILE"
fi

if [[ -z "$(env_value COGNITIVE_CREDENTIALS_MASTER_KEY_BASE64)" ]]; then
  MASTER_KEY="$(generate_master_key)"
  [[ -n "$MASTER_KEY" ]] || fail "Nao foi possivel gerar a chave mestra de credenciais."
  set_env_value COGNITIVE_CREDENTIALS_MASTER_KEY_BASE64 "$MASTER_KEY"
  printf 'Chave mestra local do cofre de credenciais gerada em %s.\n' "$ENV_FILE"
fi

WORKSPACE_RUNTIME_READY=false
if [[ -f "$WORKSPACE_RUNTIME_SCRIPT" ]]; then
  chmod +x "$WORKSPACE_RUNTIME_SCRIPT" 2>/dev/null || true
  if "$WORKSPACE_RUNTIME_SCRIPT" start; then
    WORKSPACE_RUNTIME_READY=true
  else
    printf 'AVISO: Workspace Runtime local nao iniciou. O backend continuara disponivel, mas escrita fisica e terminal real da IDE ficarao desabilitados.\n' >&2
  fi
else
  printf 'AVISO: Workspace Runtime nao encontrado em %s. O backend continuara sem terminal real da IDE.\n' "$WORKSPACE_RUNTIME_SCRIPT" >&2
fi

COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

on_error() {
  local exit_code=$?
  printf '\nFalha ao subir o backend. Estado atual:\n' >&2
  "${COMPOSE[@]}" ps >&2 || true
  printf '\nUltimos logs:\n' >&2
  "${COMPOSE[@]}" logs --tail=120 >&2 || true
  exit "$exit_code"
}

trap on_error ERR

"${COMPOSE[@]}" config >/dev/null
"${COMPOSE[@]}" up -d --build

wait_for_service() {
  local service="$1"
  local attempts="${2:-90}"
  local container_id=""
  local status=""
  local i

  for ((i = 1; i <= attempts; i++)); do
    container_id="$("${COMPOSE[@]}" ps -q "$service" 2>/dev/null || true)"
    if [[ -n "$container_id" ]]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
      if [[ "$status" == "healthy" || "$status" == "running" ]]; then
        return 0
      fi
      if [[ "$status" == "unhealthy" || "$status" == "exited" || "$status" == "dead" ]]; then
        printf 'Servico %s entrou em estado %s.\n' "$service" "$status" >&2
        return 1
      fi
    fi
    sleep 2
  done

  printf 'Servico %s nao ficou saudavel.\n' "$service" >&2
  return 1
}

wait_for_service ai-memory
wait_for_service cognitive-db
wait_for_service cognitive-api

trap - ERR

CORE_ADDRESS="$("${COMPOSE[@]}" port ai-memory 49374 | head -n 1)"
API_ADDRESS="$("${COMPOSE[@]}" port cognitive-api 8787 | head -n 1)"

printf '\nBackend iniciado com sucesso.\n'
printf 'AI Memory Core: http://%s\n' "$CORE_ADDRESS"
printf 'Cognitive API: http://%s\n' "$API_ADDRESS"
printf 'Cognitive API health: http://%s/healthz\n' "$API_ADDRESS"
printf 'Credential Vault: configurado com chave AES-256-GCM persistida no docker/.env\n'
if [[ "$WORKSPACE_RUNTIME_READY" == "true" ]]; then
  printf 'Workspace Runtime: http://127.0.0.1:%s\n' "${AI_MEMORY_WORKSPACE_RUNTIME_PORT:-8791}"
else
  printf 'Workspace Runtime: indisponivel; Browser Workspace continua funcional.\n'
fi
printf '\nPara acompanhar logs:\n'
printf 'docker compose --env-file "%s" -f "%s" logs -f\n' "$ENV_FILE" "$COMPOSE_FILE"
