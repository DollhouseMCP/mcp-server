#!/usr/bin/env bash

# DollhouseMCP hosted deployment helper.
#
# This is the repo-owned precursor to a public one-line installer. It renders
# and updates the Docker Compose + Caddy + Postgres deployment shape used for
# hosted Streamable HTTP alpha deployments while preserving secrets and state.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ACTION="${1:-help}"
DEPLOY_DIR="${DOLLHOUSE_HOSTED_DEPLOY_DIR:-/opt/dollhousemcp}"
HOSTNAME="${DOLLHOUSE_HOSTED_HOSTNAME:-}"
PUBLIC_BASE_URL="${DOLLHOUSE_PUBLIC_BASE_URL:-}"
SOURCE_DIR="${DOLLHOUSE_HOSTED_SOURCE_DIR:-}"
GIT_URL="${DOLLHOUSE_HOSTED_GIT_URL:-https://github.com/DollhouseMCP/mcp-server.git}"
GIT_REF="${DOLLHOUSE_HOSTED_GIT_REF:-codex/hosted-http-integration}"
IMAGE_TAG="${DOLLHOUSE_HOSTED_IMAGE_TAG:-dollhousemcp-hosted:alpha}"
MCP_PORT="${DOLLHOUSE_HTTP_PORT:-3000}"
MEM_LIMIT="${DOLLHOUSE_HOSTED_MEM_LIMIT:-2g}"
CPU_LIMIT="${DOLLHOUSE_HOSTED_CPUS:-2.0}"
OPEN_DCR="${DOLLHOUSE_AUTH_OPEN_DCR:-true}"
POSTGRES_READY_TIMEOUT="${DOLLHOUSE_HOSTED_POSTGRES_READY_TIMEOUT:-60}"
BOOTSTRAP_GITHUB_USERNAME="${DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME:-}"
BOOTSTRAP_GITHUB_ID="${DOLLHOUSE_BOOTSTRAP_GITHUB_ID:-}"

ENV_FILE="${DEPLOY_DIR}/.env.production"
COMPOSE_FILE="${DEPLOY_DIR}/compose.yml"
CADDY_FILE="${DEPLOY_DIR}/Caddyfile"
INIT_DB_FILE="${DEPLOY_DIR}/init-db.sql"
SERVER_DIR="${DEPLOY_DIR}/server"

usage() {
  cat <<'EOF'
DollhouseMCP hosted deployment helper

Usage:
  scripts/hosted-deploy.sh render
  scripts/hosted-deploy.sh install
  scripts/hosted-deploy.sh update
  scripts/hosted-deploy.sh migrate
  scripts/hosted-deploy.sh bootstrap-admin
  scripts/hosted-deploy.sh rollback
  scripts/hosted-deploy.sh verify

Required for render/install/update/migrate/bootstrap-admin/rollback unless DOLLHOUSE_PUBLIC_BASE_URL is set:
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com

Common environment:
  DOLLHOUSE_HOSTED_DEPLOY_DIR=/opt/dollhousemcp
  DOLLHOUSE_HOSTED_SOURCE_DIR=/path/to/local/repo
  DOLLHOUSE_HOSTED_GIT_REF=codex/hosted-http-integration
  DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=...
  DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=...
  DOLLHOUSE_AUTH_OPEN_DCR=true
  DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME=...
  DOLLHOUSE_BOOTSTRAP_GITHUB_ID=...

Examples:
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com scripts/hosted-deploy.sh install
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com scripts/hosted-deploy.sh update
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com scripts/hosted-deploy.sh migrate
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME=octocat scripts/hosted-deploy.sh bootstrap-admin
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com scripts/hosted-deploy.sh rollback
  DOLLHOUSE_PUBLIC_BASE_URL=https://mcp.example.com scripts/hosted-deploy.sh verify
EOF
}

log() {
  printf '[hosted-deploy] %s\n' "$*"
}

warn() {
  printf '[hosted-deploy] warning: %s\n' "$*" >&2
}

die() {
  printf '[hosted-deploy] error: %s\n' "$*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

resolve_public_base_url() {
  if [[ -n "${PUBLIC_BASE_URL}" ]]; then
    return
  fi
  [[ -n "${HOSTNAME}" ]] || die "set DOLLHOUSE_HOSTED_HOSTNAME or DOLLHOUSE_PUBLIC_BASE_URL"
  PUBLIC_BASE_URL="https://${HOSTNAME}"
}

resolve_hostname() {
  if [[ -n "${HOSTNAME}" ]]; then
    return
  fi
  [[ -n "${PUBLIC_BASE_URL}" ]] || die "set DOLLHOUSE_HOSTED_HOSTNAME or DOLLHOUSE_PUBLIC_BASE_URL"
  HOSTNAME="${PUBLIC_BASE_URL#https://}"
  HOSTNAME="${HOSTNAME#http://}"
  HOSTNAME="${HOSTNAME%%/*}"
}

ensure_docker_prerequisites() {
  need_command docker
  docker compose version >/dev/null 2>&1 || die "Docker Compose is required"
}

ensure_runtime_prerequisites() {
  ensure_docker_prerequisites
  need_command openssl
}

ensure_prerequisites() {
  ensure_runtime_prerequisites
  need_command git
}

ensure_layout() {
  mkdir -p "${DEPLOY_DIR}" "${DEPLOY_DIR}/portfolio" "${DEPLOY_DIR}/logs"
  chmod 0750 "${DEPLOY_DIR}" "${DEPLOY_DIR}/portfolio" "${DEPLOY_DIR}/logs"
}

random_hex() {
  openssl rand -hex "$1"
}

env_value() {
  local key="$1"
  [[ -f "${ENV_FILE}" ]] || return 0
  awk -F= -v key="${key}" '$1 == key { value = substr($0, length(key) + 2) } END { print value }' "${ENV_FILE}"
}

upsert_env_value() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"
  awk -v key="${key}" -v value="${value}" '
    BEGIN { replaced = 0 }
    $0 ~ "^" key "=" {
      print key "=" value
      replaced = 1
      next
    }
    { print }
    END {
      if (replaced == 0) {
        print key "=" value
      }
    }
  ' "${ENV_FILE}" > "${tmp}"
  install -m 0600 "${tmp}" "${ENV_FILE}"
  rm -f "${tmp}"
}

ensure_env_file() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    log "creating ${ENV_FILE}"
    install -m 0600 /dev/null "${ENV_FILE}"
  else
    chmod 0600 "${ENV_FILE}"
  fi
}

ensure_env_secret() {
  local key="$1"
  local bytes="$2"
  local existing
  existing="$(env_value "${key}")"
  if [[ -n "${existing}" ]]; then
    return
  fi
  upsert_env_value "${key}" "$(random_hex "${bytes}")"
}

maybe_set_env_from_process() {
  local key="$1"
  local value="${!key:-}"
  local existing
  existing="$(env_value "${key}")"
  if [[ -n "${existing}" || -z "${value}" ]]; then
    return
  fi
  upsert_env_value "${key}" "${value}"
}

prompt_env_if_missing() {
  local key="$1"
  local label="$2"
  local secret="${3:-false}"
  local existing
  existing="$(env_value "${key}")"
  if [[ -n "${existing}" ]]; then
    return
  fi
  maybe_set_env_from_process "${key}"
  existing="$(env_value "${key}")"
  if [[ -n "${existing}" ]]; then
    return
  fi
  if [[ ! -t 0 ]]; then
    warn "${key} is not set; add it to ${ENV_FILE} before GitHub OAuth sign-in"
    return
  fi

  local value
  if [[ "${secret}" == "true" ]]; then
    read -r -s -p "${label}: " value
    printf '\n'
  else
    read -r -p "${label}: " value
  fi
  [[ -n "${value}" ]] || return
  upsert_env_value "${key}" "${value}"
}

write_env_defaults() {
  ensure_env_file
  ensure_env_secret POSTGRES_ADMIN_PASSWORD 24
  ensure_env_secret POSTGRES_PASSWORD 24
  ensure_env_secret DOLLHOUSE_COOKIE_SIGNING_SECRET 32
  ensure_env_secret DOLLHOUSE_INVITE_TOKEN_SECRET 32
  ensure_env_secret DOLLHOUSE_AUDIT_HMAC_SECRET 32
  upsert_env_value DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED "true"
  prompt_env_if_missing DOLLHOUSE_AUTH_GITHUB_CLIENT_ID "GitHub OAuth client ID" false
  prompt_env_if_missing DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET "GitHub OAuth client secret" true
}

load_env_file() {
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
}

write_compose() {
  cat > "${COMPOSE_FILE}" <<EOF
services:
  postgres:
    image: postgres:17-alpine
    container_name: dollhousemcp-postgres
    restart: unless-stopped
    env_file:
      - .env.production
    environment:
      POSTGRES_USER: dollhouse
      POSTGRES_PASSWORD: \${POSTGRES_ADMIN_PASSWORD}
      POSTGRES_DB: dollhousemcp
    volumes:
      - ./pgdata:/var/lib/postgresql/data
      - ./init-db.sql:/docker-entrypoint-initdb.d/00-create-roles.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U dollhouse -d dollhousemcp"]
      interval: 10s
      timeout: 3s
      retries: 10

  dollhousemcp:
    build:
      context: ./server
      dockerfile: docker/Dockerfile
      target: production
    image: ${IMAGE_TAG}
    container_name: dollhousemcp
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    env_file:
      - .env.production
    environment:
      NODE_ENV: production
      DOLLHOUSE_DISABLE_UPDATES: "true"
      DOLLHOUSE_SECURITY_MODE: strict
      DOLLHOUSE_TRANSPORT: streamable-http
      DOLLHOUSE_HTTP_HOST: 0.0.0.0
      DOLLHOUSE_HTTP_PORT: "${MCP_PORT}"
      DOLLHOUSE_HTTP_ALLOWED_HOSTS: ${HOSTNAME}
      DOLLHOUSE_TRUSTED_PROXIES: 172.16.0.0/12
      DOLLHOUSE_PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}
      DOLLHOUSE_STORAGE_BACKEND: database
      DOLLHOUSE_DATABASE_URL: postgres://dollhouse_app:\${POSTGRES_PASSWORD}@postgres:5432/dollhousemcp
      DOLLHOUSE_DATABASE_ADMIN_URL: postgres://dollhouse:\${POSTGRES_ADMIN_PASSWORD}@postgres:5432/dollhousemcp
      DOLLHOUSE_DATABASE_SSL: disable
      DOLLHOUSE_DATABASE_POOL_SIZE: "20"
      DOLLHOUSE_AUTH_ENABLED: "true"
      DOLLHOUSE_AUTH_PROVIDER: embedded
      DOLLHOUSE_AUTH_METHODS: github
      DOLLHOUSE_AUTH_STORAGE_BACKEND: postgres
      DOLLHOUSE_AUTH_OPEN_DCR: "${OPEN_DCR}"
      DOLLHOUSE_WEB_AUTH_ENABLED: "true"
      DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED: \${DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED:-true}
    expose:
      - "${MCP_PORT}"
    volumes:
      - ./portfolio:/home/dollhouse/.dollhouse
    tmpfs:
      - /tmp:noexec,nosuid,size=200M,mode=1777
      - /app/tmp:noexec,nosuid,size=200M,mode=1777
      - /app/logs:noexec,nosuid,size=100M,mode=1777
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    mem_limit: ${MEM_LIMIT}
    cpus: ${CPU_LIMIT}

  caddy:
    image: caddy:2
    container_name: dollhousemcp-caddy
    restart: unless-stopped
    depends_on:
      - dollhousemcp
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  caddy_data:
  caddy_config:
EOF
}

write_caddyfile() {
  cat > "${CADDY_FILE}" <<EOF
${HOSTNAME} {
    encode gzip

    reverse_proxy dollhousemcp:${MCP_PORT} {
        header_up Host {host}
        header_up X-Forwarded-Proto https
        transport http {
            read_timeout 1h
            write_timeout 1h
            dial_timeout 30s
        }
    }
}
EOF
}

write_init_db() {
  local app_password="${POSTGRES_PASSWORD:-}"
  [[ -n "${app_password}" ]] || die "POSTGRES_PASSWORD missing from ${ENV_FILE}"
  [[ "${app_password}" != *"'"* ]] || die "POSTGRES_PASSWORD must not contain single quotes for init-db.sql generation"

  cat > "${INIT_DB_FILE}" <<EOF
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dollhouse_app') THEN
    CREATE ROLE dollhouse_app WITH LOGIN PASSWORD '${app_password}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
\$\$;
GRANT CONNECT ON DATABASE dollhousemcp TO dollhouse_app;
GRANT USAGE ON SCHEMA public TO dollhouse_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dollhouse_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO dollhouse_app;
EOF
  chmod 0640 "${INIT_DB_FILE}"
}

detect_default_source_dir() {
  if [[ -n "${SOURCE_DIR}" ]]; then
    return
  fi
  if git -C "${REPO_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    SOURCE_DIR="${REPO_ROOT}"
  fi
}

stage_source() {
  local timestamp incoming revision
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  incoming="${DEPLOY_DIR}/server.incoming-${timestamp}"
  mkdir "${incoming}"

  detect_default_source_dir
  if [[ -n "${SOURCE_DIR}" ]]; then
    log "staging source from ${SOURCE_DIR}"
    git -C "${SOURCE_DIR}" archive --format=tar HEAD | tar -xf - -C "${incoming}"
    revision="$(git -C "${SOURCE_DIR}" rev-parse HEAD)"
  else
    log "cloning ${GIT_URL} (${GIT_REF})"
    rmdir "${incoming}"
    git clone --depth 1 --branch "${GIT_REF}" "${GIT_URL}" "${incoming}"
    revision="$(git -C "${incoming}" rev-parse HEAD)"
  fi

  if [[ -d "${SERVER_DIR}" ]]; then
    mv "${SERVER_DIR}" "${DEPLOY_DIR}/server.prev-${timestamp}"
  fi
  mv "${incoming}" "${SERVER_DIR}"
  printf '%s\n' "${revision}" > "${DEPLOY_DIR}/DEPLOYED_REVISION"
  date -u +%Y-%m-%dT%H:%M:%SZ > "${DEPLOY_DIR}/DEPLOYED_AT"
}

render_files() {
  resolve_public_base_url
  resolve_hostname
  ensure_layout
  write_env_defaults
  load_env_file
  write_compose
  write_caddyfile
  write_init_db
  log "rendered deployment files in ${DEPLOY_DIR}"
}

compose() {
  (cd "${DEPLOY_DIR}" && docker compose -f "${COMPOSE_FILE}" "$@")
}

ensure_server_source() {
  [[ -d "${SERVER_DIR}" ]] || die "server source not staged at ${SERVER_DIR}; run install or update first"
}

validate_postgres_timeout() {
  [[ "${POSTGRES_READY_TIMEOUT}" =~ ^[0-9]+$ ]] || \
    die "DOLLHOUSE_HOSTED_POSTGRES_READY_TIMEOUT must be an integer number of seconds"
}

wait_for_postgres() {
  validate_postgres_timeout
  log "starting postgres"
  compose up -d postgres

  log "waiting for postgres to become ready"
  local elapsed=0
  until compose exec -T postgres pg_isready -U dollhouse -d dollhousemcp >/dev/null 2>&1; do
    if (( elapsed >= POSTGRES_READY_TIMEOUT )); then
      compose ps postgres >&2 || true
      die "postgres did not become ready within ${POSTGRES_READY_TIMEOUT}s"
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
}

build_app_image() {
  log "building dollhousemcp image"
  compose build dollhousemcp
}

run_database_migrations() {
  log "running database migrations"
  compose run --rm dollhousemcp npm run db:migrate
}

prepare_existing_stack() {
  ensure_runtime_prerequisites
  render_files
  ensure_server_source
  build_app_image
  wait_for_postgres
}

run_bootstrap_admin() {
  local mode="${1:-required}"
  local args=()

  if [[ -n "${BOOTSTRAP_GITHUB_ID}" ]]; then
    if [[ -n "${BOOTSTRAP_GITHUB_USERNAME}" ]]; then
      warn "DOLLHOUSE_BOOTSTRAP_GITHUB_ID is set; ignoring DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME"
    fi
    args=(--method github --github-id "${BOOTSTRAP_GITHUB_ID}")
  elif [[ -n "${BOOTSTRAP_GITHUB_USERNAME}" ]]; then
    args=(--method github --github-username "${BOOTSTRAP_GITHUB_USERNAME}")
  elif [[ "${mode}" == "optional" ]]; then
    return
  elif [[ -t 0 ]]; then
    read -r -p "Admin GitHub username: " BOOTSTRAP_GITHUB_USERNAME
    [[ -n "${BOOTSTRAP_GITHUB_USERNAME}" ]] || die "admin GitHub username is required"
    args=(--method github --github-username "${BOOTSTRAP_GITHUB_USERNAME}")
  else
    die "set DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME or DOLLHOUSE_BOOTSTRAP_GITHUB_ID"
  fi

  log "bootstrapping GitHub admin"
  compose run --rm dollhousemcp npx dollhouse-admin-bootstrap "${args[@]}"
}

bootstrap_admin() {
  prepare_existing_stack
  run_database_migrations
  run_bootstrap_admin required
}

start_or_update() {
  local service="${1:-all}"
  ensure_prerequisites
  render_files
  stage_source
  build_app_image
  wait_for_postgres
  run_database_migrations
  run_bootstrap_admin optional
  if [[ "${service}" == "app" ]]; then
    compose up -d dollhousemcp
  else
    compose up -d
  fi
}

run_migrations() {
  prepare_existing_stack
  run_database_migrations
}

latest_previous_bundle() {
  find "${DEPLOY_DIR}" -maxdepth 1 -type d -name 'server.prev-*' -print | sort | tail -n 1
}

rollback_server() {
  local previous timestamp current_backup previous_name

  ensure_runtime_prerequisites
  render_files
  previous="$(latest_previous_bundle)"
  [[ -n "${previous}" ]] || die "no previous server bundle found in ${DEPLOY_DIR}"
  [[ -d "${SERVER_DIR}" ]] || die "no current server bundle found at ${SERVER_DIR}"

  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  current_backup="${DEPLOY_DIR}/server.rollback-from-${timestamp}"
  previous_name="$(basename "${previous}")"

  log "rolling back server source to ${previous_name}"
  mv "${SERVER_DIR}" "${current_backup}"
  if ! mv "${previous}" "${SERVER_DIR}"; then
    mv "${current_backup}" "${SERVER_DIR}" || true
    die "failed to restore ${previous_name}; current server bundle was restored"
  fi

  printf 'rollback:%s\n' "${previous_name}" > "${DEPLOY_DIR}/DEPLOYED_REVISION"
  date -u +%Y-%m-%dT%H:%M:%SZ > "${DEPLOY_DIR}/DEPLOYED_AT"

  build_app_image
  wait_for_postgres
  compose up -d dollhousemcp caddy
}

verify_deploy() {
  need_command curl
  resolve_public_base_url
  log "checking ${PUBLIC_BASE_URL}/healthz"
  curl -fsS "${PUBLIC_BASE_URL}/healthz" >/dev/null
  log "checking ${PUBLIC_BASE_URL}/readyz"
  curl -fsS "${PUBLIC_BASE_URL}/readyz" >/dev/null

  local status
  status="$(curl -sS -o /dev/null -w '%{http_code}' "${PUBLIC_BASE_URL}/mcp")"
  [[ "${status}" == "401" ]] || die "expected /mcp to return 401 without a bearer token, got ${status}"
  log "verification passed"
}

case "${ACTION}" in
  help|--help|-h)
    usage
    ;;
  render)
    need_command openssl
    render_files
    ;;
  install)
    start_or_update all
    verify_deploy
    ;;
  update)
    start_or_update app
    verify_deploy
    ;;
  migrate)
    run_migrations
    ;;
  bootstrap-admin)
    bootstrap_admin
    ;;
  rollback)
    rollback_server
    verify_deploy
    ;;
  verify)
    verify_deploy
    ;;
  *)
    usage >&2
    die "unknown action: ${ACTION}"
    ;;
esac
