#!/usr/bin/env bash

# DollhouseMCP hosted deployment helper.
#
# This is the repo-owned precursor to a public one-line installer. It renders
# and updates the Docker Compose + Caddy + Postgres deployment shape used for
# hosted Streamable HTTP alpha deployments while preserving secrets and state.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ACTION="help"
ACTION_SET="false"
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
DRY_RUN="${DOLLHOUSE_HOSTED_DRY_RUN:-false}"
ALLOW_CREDENTIAL_GIT_URL="${DOLLHOUSE_HOSTED_ALLOW_CREDENTIAL_GIT_URL:-false}"
POSTGRES_READY_TIMEOUT="${DOLLHOUSE_HOSTED_POSTGRES_READY_TIMEOUT:-60}"
BOOTSTRAP_GITHUB_USERNAME="${DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME:-}"
BOOTSTRAP_GITHUB_ID="${DOLLHOUSE_BOOTSTRAP_GITHUB_ID:-}"

ENV_FILE="${DEPLOY_DIR}/.env.production"
COMPOSE_FILE="${DEPLOY_DIR}/compose.yml"
CADDY_FILE="${DEPLOY_DIR}/Caddyfile"
INIT_DB_FILE="${DEPLOY_DIR}/init-db.sh"
SERVER_DIR="${DEPLOY_DIR}/server"

usage() {
  cat <<'EOF'
DollhouseMCP hosted deployment helper

Usage:
  scripts/hosted-deploy.sh [--dry-run] render
  scripts/hosted-deploy.sh [--dry-run] install
  scripts/hosted-deploy.sh [--dry-run] update
  scripts/hosted-deploy.sh [--dry-run] migrate
  scripts/hosted-deploy.sh [--dry-run] bootstrap-admin
  scripts/hosted-deploy.sh [--dry-run] rollback
  scripts/hosted-deploy.sh [--dry-run] verify

Actions:
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
  DOLLHOUSE_HOSTED_DRY_RUN=false
  DOLLHOUSE_HOSTED_SOURCE_DIR=/path/to/local/repo
  DOLLHOUSE_HOSTED_GIT_REF=codex/hosted-http-integration
  DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=...
  DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=...
  DOLLHOUSE_AUTH_OPEN_DCR=true
  DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME=...
  DOLLHOUSE_BOOTSTRAP_GITHUB_ID=...

Examples:
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com scripts/hosted-deploy.sh --dry-run install
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

parse_args() {
  local arg
  for arg in "$@"; do
    case "${arg}" in
      --dry-run)
        DRY_RUN="true"
        ;;
      help|--help|-h)
        if [[ "${ACTION_SET}" == "true" ]]; then
          die "only one action may be provided"
        fi
        ACTION="help"
        ACTION_SET="true"
        ;;
      --*)
        die "unknown option: ${arg}"
        ;;
      *)
        if [[ "${ACTION_SET}" == "true" ]]; then
          die "only one action may be provided; got '${ACTION}' and '${arg}'"
        fi
        ACTION="${arg}"
        ACTION_SET="true"
        ;;
    esac
  done
}

need_command() {
  local command_name="$1"
  local resolved_path

  resolved_path="$(command -v "${command_name}" || true)"
  if [[ -z "${resolved_path}" ]]; then
    die "missing required command: ${command_name}"
  fi
}

validate_bool() {
  local key="$1"
  local value="$2"
  case "${value}" in
    true|false)
      ;;
    *)
      die "${key} must be 'true' or 'false', got: ${value}"
      ;;
  esac
}

is_dry_run() {
  [[ "${DRY_RUN}" == "true" ]]
}

validate_no_whitespace() {
  local key="$1"
  local value="$2"

  if [[ "${value}" =~ [[:space:]] ]]; then
    die "${key} must not contain whitespace"
  fi
}

validate_hostname() {
  [[ -n "${HOSTNAME}" ]] || die "hostname resolved to an empty value"
  validate_no_whitespace DOLLHOUSE_HOSTED_HOSTNAME "${HOSTNAME}"
  if [[ "${HOSTNAME}" == *"/"* || "${HOSTNAME}" == *"@"* ]]; then
    die "DOLLHOUSE_HOSTED_HOSTNAME must be a hostname only, for example mcp.example.com"
  fi
  if [[ ! "${HOSTNAME}" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
    die "DOLLHOUSE_HOSTED_HOSTNAME contains unsupported characters: ${HOSTNAME}"
  fi
  if [[ "${HOSTNAME}" == *..* || "${HOSTNAME}" == .* || "${HOSTNAME}" == *. ]]; then
    die "DOLLHOUSE_HOSTED_HOSTNAME must be a valid hostname, got: ${HOSTNAME}"
  fi
}

validate_public_base_url() {
  validate_no_whitespace DOLLHOUSE_PUBLIC_BASE_URL "${PUBLIC_BASE_URL}"
  case "${PUBLIC_BASE_URL}" in
    http://*|https://*)
      ;;
    *)
      die "DOLLHOUSE_PUBLIC_BASE_URL must start with http:// or https://"
      ;;
  esac

  local without_scheme
  without_scheme="${PUBLIC_BASE_URL#https://}"
  without_scheme="${without_scheme#http://}"
  if [[ "${without_scheme}" == *"@"* ]]; then
    die "DOLLHOUSE_PUBLIC_BASE_URL must not contain credentials"
  fi
  if [[ "${without_scheme}" == *"/"* || "${without_scheme}" == *"?"* || "${without_scheme}" == *"#"* ]]; then
    die "DOLLHOUSE_PUBLIC_BASE_URL must be an origin only, for example https://mcp.example.com"
  fi
}

validate_port() {
  if [[ ! "${MCP_PORT}" =~ ^[0-9]+$ || "${MCP_PORT}" -lt 1 || "${MCP_PORT}" -gt 65535 ]]; then
    die "DOLLHOUSE_HTTP_PORT must be an integer from 1 to 65535, got: ${MCP_PORT}"
  fi
}

validate_render_value() {
  local key="$1"
  local value="$2"

  validate_no_whitespace "${key}" "${value}"
  if [[ "${value}" == *":"* && "${key}" != "DOLLHOUSE_HOSTED_IMAGE_TAG" ]]; then
    die "${key} contains ':' unexpectedly: ${value}"
  fi
}

validate_render_inputs() {
  validate_bool DOLLHOUSE_AUTH_OPEN_DCR "${OPEN_DCR}"
  validate_hostname
  validate_public_base_url
  validate_port
  validate_render_value DOLLHOUSE_HOSTED_IMAGE_TAG "${IMAGE_TAG}"
  validate_render_value DOLLHOUSE_HOSTED_MEM_LIMIT "${MEM_LIMIT}"
  validate_render_value DOLLHOUSE_HOSTED_CPUS "${CPU_LIMIT}"
}

git_url_has_credentials() {
  [[ "$1" =~ ^https?://[^/@]+@ ]]
}

validate_git_url_for_clone() {
  validate_bool DOLLHOUSE_HOSTED_ALLOW_CREDENTIAL_GIT_URL "${ALLOW_CREDENTIAL_GIT_URL}"
  if git_url_has_credentials "${GIT_URL}" && [[ "${ALLOW_CREDENTIAL_GIT_URL}" != "true" ]]; then
    die "DOLLHOUSE_HOSTED_GIT_URL must not embed credentials; use a git credential helper, deploy key, or DOLLHOUSE_HOSTED_SOURCE_DIR instead"
  fi
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
  need_command tar
}

ensure_layout() {
  mkdir -p "${DEPLOY_DIR}" "${DEPLOY_DIR}/portfolio" "${DEPLOY_DIR}/logs"
  chmod 0750 "${DEPLOY_DIR}" "${DEPLOY_DIR}/portfolio" "${DEPLOY_DIR}/logs"
}

random_hex() {
  local bytes="$1"

  if [[ ! "${bytes}" =~ ^[0-9]+$ || "${bytes}" -le 0 ]]; then
    die "random secret byte count must be a positive integer, got: ${bytes}"
  fi

  openssl rand -hex "${bytes}" || die "failed to generate ${bytes} random bytes with openssl"
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
      DOLLHOUSE_APP_DB_PASSWORD: \${POSTGRES_PASSWORD}
    volumes:
      - ./pgdata:/var/lib/postgresql/data
      - ./init-db.sh:/docker-entrypoint-initdb.d/00-create-roles.sh:ro
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
  cat > "${INIT_DB_FILE}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${DOLLHOUSE_APP_DB_PASSWORD:?DOLLHOUSE_APP_DB_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  -v app_password="${DOLLHOUSE_APP_DB_PASSWORD}" <<'SQL'
SELECT format(
  'CREATE ROLE dollhouse_app WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
  :'app_password'
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dollhouse_app')
\gexec
ALTER ROLE dollhouse_app WITH PASSWORD :'app_password';
GRANT CONNECT ON DATABASE dollhousemcp TO dollhouse_app;
GRANT USAGE ON SCHEMA public TO dollhouse_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dollhouse_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO dollhouse_app;
SQL
EOF
  chmod 0750 "${INIT_DB_FILE}"
}

detect_default_source_dir() {
  if [[ -n "${SOURCE_DIR}" ]]; then
    return
  fi
  if git -C "${REPO_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    SOURCE_DIR="${REPO_ROOT}"
  fi
}

unique_path() {
  local base="$1"
  local candidate="${base}"
  local suffix=1

  while [[ -e "${candidate}" ]]; do
    candidate="${base}-${suffix}"
    suffix=$((suffix + 1))
  done
  printf '%s\n' "${candidate}"
}

redact_url() {
  local url="$1"

  if [[ "${url}" =~ ^(https?://)([^/@]+@)(.*)$ ]]; then
    printf '%s***@%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[3]}"
    return
  fi
  printf '%s\n' "${url}"
}

stage_from_source_dir() {
  local incoming="$1"
  local revision

  [[ -d "${SOURCE_DIR}" ]] || die "DOLLHOUSE_HOSTED_SOURCE_DIR does not exist: ${SOURCE_DIR}"
  if ! git -C "${SOURCE_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    die "DOLLHOUSE_HOSTED_SOURCE_DIR is not a git checkout: ${SOURCE_DIR}"
  fi

  log "staging source from ${SOURCE_DIR}" >&2
  if ! git -C "${SOURCE_DIR}" archive --format=tar HEAD | tar -xf - -C "${incoming}"; then
    die "failed to archive HEAD from ${SOURCE_DIR}; check that it has a valid commit and that ${incoming} is writable"
  fi
  revision="$(git -C "${SOURCE_DIR}" rev-parse HEAD)" || \
    die "failed to resolve HEAD revision from ${SOURCE_DIR}"
  printf '%s\n' "${revision}"
}

stage_from_remote_git() {
  local incoming="$1"
  local revision redacted_url

  validate_git_url_for_clone
  redacted_url="$(redact_url "${GIT_URL}")"
  log "cloning ${redacted_url} (${GIT_REF})" >&2
  rmdir "${incoming}" || die "failed to prepare incoming clone directory: ${incoming}"
  if ! git clone --depth 1 --branch "${GIT_REF}" "${GIT_URL}" "${incoming}"; then
    die "failed to clone ${redacted_url} at ref ${GIT_REF}; check DOLLHOUSE_HOSTED_GIT_URL, DOLLHOUSE_HOSTED_GIT_REF, network access, and git credentials"
  fi
  revision="$(git -C "${incoming}" rev-parse HEAD)" || \
    die "failed to resolve cloned revision from ${redacted_url}"
  printf '%s\n' "${revision}"
}

stage_source() {
  local timestamp incoming revision previous_bundle
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  incoming="$(unique_path "${DEPLOY_DIR}/server.incoming-${timestamp}")"
  mkdir "${incoming}"

  detect_default_source_dir
  if [[ -n "${SOURCE_DIR}" ]]; then
    revision="$(stage_from_source_dir "${incoming}")"
  else
    revision="$(stage_from_remote_git "${incoming}")"
  fi

  if [[ -d "${SERVER_DIR}" ]]; then
    previous_bundle="$(unique_path "${DEPLOY_DIR}/server.prev-${timestamp}")"
    mv "${SERVER_DIR}" "${previous_bundle}" || die "failed to move current server bundle to ${previous_bundle}"
  fi
  mv "${incoming}" "${SERVER_DIR}" || die "failed to promote incoming server bundle to ${SERVER_DIR}"
  printf '%s\n' "${revision}" > "${DEPLOY_DIR}/DEPLOYED_REVISION"
  date -u +%Y-%m-%dT%H:%M:%SZ > "${DEPLOY_DIR}/DEPLOYED_AT"
}

render_files() {
  resolve_public_base_url
  resolve_hostname
  validate_render_inputs
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
    die "DOLLHOUSE_HOSTED_POSTGRES_READY_TIMEOUT must be an integer number of seconds; try 60, 120, or 300"
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
  validate_git_url_for_clone
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
  [[ -d "${DEPLOY_DIR}" ]] || return 0
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
  resolve_hostname
  validate_render_inputs
  log "checking ${PUBLIC_BASE_URL}/healthz"
  curl -fsS "${PUBLIC_BASE_URL}/healthz" >/dev/null
  log "checking ${PUBLIC_BASE_URL}/readyz"
  curl -fsS "${PUBLIC_BASE_URL}/readyz" >/dev/null

  local status
  status="$(curl -sS -o /dev/null -w '%{http_code}' "${PUBLIC_BASE_URL}/mcp")"
  [[ "${status}" == "401" ]] || die "expected /mcp to return 401 without a bearer token, got ${status}"
  log "verification passed"
}

describe_render_plan() {
  resolve_public_base_url
  resolve_hostname
  validate_render_inputs
  log "dry-run: would render deployment files in ${DEPLOY_DIR}"
  log "dry-run: would preserve or create ${ENV_FILE}"
  log "dry-run: would write ${COMPOSE_FILE}"
  log "dry-run: would write ${CADDY_FILE}"
  log "dry-run: would write ${INIT_DB_FILE} without embedding the app database password"
}

describe_source_plan() {
  detect_default_source_dir
  if [[ -n "${SOURCE_DIR}" ]]; then
    [[ -d "${SOURCE_DIR}" ]] || die "DOLLHOUSE_HOSTED_SOURCE_DIR does not exist: ${SOURCE_DIR}"
    if ! git -C "${SOURCE_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      die "DOLLHOUSE_HOSTED_SOURCE_DIR is not a git checkout: ${SOURCE_DIR}"
    fi
    log "dry-run: would stage source from ${SOURCE_DIR}"
  else
    validate_git_url_for_clone
    log "dry-run: would clone $(redact_url "${GIT_URL}") at ref ${GIT_REF}"
  fi
}

describe_bootstrap_plan() {
  local mode="${1:-optional}"

  if [[ -n "${BOOTSTRAP_GITHUB_ID}" ]]; then
    log "dry-run: would bootstrap GitHub admin id ${BOOTSTRAP_GITHUB_ID}"
  elif [[ -n "${BOOTSTRAP_GITHUB_USERNAME}" ]]; then
    log "dry-run: would bootstrap GitHub admin username ${BOOTSTRAP_GITHUB_USERNAME}"
  elif [[ "${mode}" == "required" ]]; then
    log "dry-run: would require DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME or DOLLHOUSE_BOOTSTRAP_GITHUB_ID"
  else
    log "dry-run: would skip admin bootstrap because no bootstrap identity is set"
  fi
}

dry_run_start_or_update() {
  local service="${1:-all}"

  validate_git_url_for_clone
  describe_render_plan
  describe_source_plan
  log "dry-run: would build dollhousemcp image"
  log "dry-run: would start postgres and wait up to ${POSTGRES_READY_TIMEOUT}s"
  log "dry-run: would run database migrations"
  describe_bootstrap_plan optional
  if [[ "${service}" == "app" ]]; then
    log "dry-run: would restart dollhousemcp service"
  else
    log "dry-run: would start or update the full compose stack"
  fi
  log "dry-run: would verify ${PUBLIC_BASE_URL}/healthz, /readyz, and /mcp"
}

dry_run_migrations() {
  describe_render_plan
  log "dry-run: would require existing server source at ${SERVER_DIR}"
  log "dry-run: would build dollhousemcp image"
  log "dry-run: would start postgres and wait up to ${POSTGRES_READY_TIMEOUT}s"
  log "dry-run: would run database migrations"
}

dry_run_bootstrap_admin() {
  describe_render_plan
  log "dry-run: would require existing server source at ${SERVER_DIR}"
  log "dry-run: would build dollhousemcp image"
  log "dry-run: would start postgres and wait up to ${POSTGRES_READY_TIMEOUT}s"
  log "dry-run: would run database migrations"
  describe_bootstrap_plan required
}

dry_run_rollback() {
  describe_render_plan
  log "dry-run: would restore the newest server.prev-* bundle"
  if [[ -d "${SERVER_DIR}" ]]; then
    log "dry-run: current server bundle exists at ${SERVER_DIR}"
  else
    log "dry-run: current server bundle is not present yet"
  fi
  local previous
  previous="$(latest_previous_bundle)"
  if [[ -n "${previous}" ]]; then
    log "dry-run: newest rollback candidate is ${previous}"
  else
    log "dry-run: no server.prev-* rollback candidate found yet"
  fi
  log "dry-run: would rebuild dollhousemcp image and restart dollhousemcp + caddy"
  log "dry-run: would verify ${PUBLIC_BASE_URL}/healthz, /readyz, and /mcp"
}

dry_run_verify() {
  resolve_public_base_url
  resolve_hostname
  validate_render_inputs
  log "dry-run: would check ${PUBLIC_BASE_URL}/healthz"
  log "dry-run: would check ${PUBLIC_BASE_URL}/readyz"
  log "dry-run: would check ${PUBLIC_BASE_URL}/mcp returns 401 without a bearer token"
}

run_dry_action() {
  log "dry-run mode enabled; no files, source bundles, containers, git clones, or HTTP requests will be changed"
  case "${ACTION}" in
    render)
      describe_render_plan
      ;;
    install)
      dry_run_start_or_update all
      ;;
    update)
      dry_run_start_or_update app
      ;;
    migrate)
      dry_run_migrations
      ;;
    bootstrap-admin)
      dry_run_bootstrap_admin
      ;;
    rollback)
      dry_run_rollback
      ;;
    verify)
      dry_run_verify
      ;;
    *)
      usage >&2
      die "unknown action: ${ACTION}"
      ;;
  esac
}

run_action() {
  case "${ACTION}" in
    help)
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
}

parse_args "$@"
validate_bool DOLLHOUSE_HOSTED_DRY_RUN "${DRY_RUN}"

if is_dry_run && [[ "${ACTION}" != "help" ]]; then
  run_dry_action
else
  run_action
fi
