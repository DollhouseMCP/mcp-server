# shellcheck shell=bash
# Configuration and CLI parsing for hosted-deploy.

hosted_deploy_nonempty_env() {
  local name="$1"

  if [[ -n "${!name-}" ]]; then
    return 0
  fi

  return 1
}

hosted_deploy_init_config() {
  ACTION="help"
  ACTION_SET="false"
  DEPLOY_MODE="${DOLLHOUSE_HOSTED_MODE:-cloud}"
  DEPLOY_MODE_SET="false"
  if hosted_deploy_nonempty_env DOLLHOUSE_HOSTED_MODE; then
    DEPLOY_MODE_SET="true"
  fi
  DEPLOY_DIR="${DOLLHOUSE_HOSTED_DEPLOY_DIR:-/opt/dollhousemcp}"
  INSTANCE_NAME="${DOLLHOUSE_HOSTED_INSTANCE_NAME:-}"
  INSTANCE_NAME_SET="false"
  if hosted_deploy_nonempty_env DOLLHOUSE_HOSTED_INSTANCE_NAME; then
    INSTANCE_NAME_SET="true"
  fi
  HOSTNAME="${DOLLHOUSE_HOSTED_HOSTNAME:-}"
  HOSTNAME_SET="false"
  if hosted_deploy_nonempty_env DOLLHOUSE_HOSTED_HOSTNAME; then
    HOSTNAME_SET="true"
  fi
  PUBLIC_BASE_URL="${DOLLHOUSE_PUBLIC_BASE_URL:-}"
  PUBLIC_BASE_URL_SET="false"
  if hosted_deploy_nonempty_env DOLLHOUSE_PUBLIC_BASE_URL; then
    PUBLIC_BASE_URL_SET="true"
  fi
  PROXY_MODE="${DOLLHOUSE_HOSTED_PROXY_MODE:-}"
  PROXY_MODE_SET="false"
  if hosted_deploy_nonempty_env DOLLHOUSE_HOSTED_PROXY_MODE; then
    PROXY_MODE_SET="true"
  fi
  BIND_ADDRESS="${DOLLHOUSE_HOSTED_BIND_ADDRESS:-}"
  BIND_ADDRESS_SET="false"
  if hosted_deploy_nonempty_env DOLLHOUSE_HOSTED_BIND_ADDRESS; then
    BIND_ADDRESS_SET="true"
  fi
  HTTP_BIND_PORT="${DOLLHOUSE_HOSTED_HTTP_BIND_PORT:-}"
  HTTP_BIND_PORT_SET="false"
  if hosted_deploy_nonempty_env DOLLHOUSE_HOSTED_HTTP_BIND_PORT; then
    HTTP_BIND_PORT_SET="true"
  fi
  HTTPS_BIND_PORT="${DOLLHOUSE_HOSTED_HTTPS_BIND_PORT:-}"
  HTTPS_BIND_PORT_SET="false"
  if hosted_deploy_nonempty_env DOLLHOUSE_HOSTED_HTTPS_BIND_PORT; then
    HTTPS_BIND_PORT_SET="true"
  fi
  SOURCE_DIR="${DOLLHOUSE_HOSTED_SOURCE_DIR:-}"
  GIT_URL="${DOLLHOUSE_HOSTED_GIT_URL:-https://github.com/DollhouseMCP/mcp-server.git}"
  GIT_REF="${DOLLHOUSE_HOSTED_GIT_REF:-codex/hosted-http-integration}"
  IMAGE_TAG="${DOLLHOUSE_HOSTED_IMAGE_TAG:-}"
  IMAGE_TAG_SET="false"
  if hosted_deploy_nonempty_env DOLLHOUSE_HOSTED_IMAGE_TAG; then
    IMAGE_TAG_SET="true"
  fi
  MCP_PORT="${DOLLHOUSE_HTTP_PORT:-3000}"
  MEM_LIMIT="${DOLLHOUSE_HOSTED_MEM_LIMIT:-2g}"
  CPU_LIMIT="${DOLLHOUSE_HOSTED_CPUS:-2.0}"
  DOCKER_LOG_MAX_SIZE="${DOLLHOUSE_HOSTED_DOCKER_LOG_MAX_SIZE:-}"
  DOCKER_LOG_MAX_SIZE_SET="false"
  if hosted_deploy_nonempty_env DOLLHOUSE_HOSTED_DOCKER_LOG_MAX_SIZE; then
    DOCKER_LOG_MAX_SIZE_SET="true"
  fi
  DOCKER_LOG_MAX_FILE="${DOLLHOUSE_HOSTED_DOCKER_LOG_MAX_FILE:-}"
  DOCKER_LOG_MAX_FILE_SET="false"
  if hosted_deploy_nonempty_env DOLLHOUSE_HOSTED_DOCKER_LOG_MAX_FILE; then
    DOCKER_LOG_MAX_FILE_SET="true"
  fi
  OPEN_DCR="${DOLLHOUSE_AUTH_OPEN_DCR:-}"
  OPEN_DCR_SET="false"
  if hosted_deploy_nonempty_env DOLLHOUSE_AUTH_OPEN_DCR; then
    OPEN_DCR_SET="true"
  fi
  AUTH_PROVIDER="${DOLLHOUSE_AUTH_PROVIDER:-}"
  AUTH_PROVIDER_SET="false"
  if hosted_deploy_nonempty_env DOLLHOUSE_AUTH_PROVIDER; then
    AUTH_PROVIDER_SET="true"
  fi
  AUTH_METHODS="${DOLLHOUSE_AUTH_METHODS:-}"
  AUTH_METHODS_SET="false"
  if hosted_deploy_nonempty_env DOLLHOUSE_AUTH_METHODS; then
    AUTH_METHODS_SET="true"
  fi
  ALLOWLIST_REQUIRED="${DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED:-}"
  ALLOWLIST_REQUIRED_SET="false"
  if hosted_deploy_nonempty_env DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED; then
    ALLOWLIST_REQUIRED_SET="true"
  fi
  TRUSTED_PROXIES="${DOLLHOUSE_TRUSTED_PROXIES:-}"
  TRUSTED_PROXIES_SET="false"
  if hosted_deploy_nonempty_env DOLLHOUSE_TRUSTED_PROXIES; then
    TRUSTED_PROXIES_SET="true"
  fi
  # App trusted proxies describe the direct hop into the app container
  # (usually Caddy on Docker). Caddy trusted proxies describe the public edge
  # hop, such as Cloudflare, that Caddy may trust for real client IP headers.
  CADDY_ACCESS_LOG="${DOLLHOUSE_HOSTED_CADDY_ACCESS_LOG:-}"
  CADDY_ACCESS_LOG_SET="false"
  if hosted_deploy_nonempty_env DOLLHOUSE_HOSTED_CADDY_ACCESS_LOG; then
    CADDY_ACCESS_LOG_SET="true"
  fi
  CADDY_TRUSTED_PROXIES="${DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES:-}"
  CADDY_TRUSTED_PROXIES_SET="false"
  if hosted_deploy_nonempty_env DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES; then
    CADDY_TRUSTED_PROXIES_SET="true"
  fi
  ALLOWED_HOSTS="${DOLLHOUSE_HTTP_ALLOWED_HOSTS:-}"
  ALLOWED_HOSTS_SET="false"
  if hosted_deploy_nonempty_env DOLLHOUSE_HTTP_ALLOWED_HOSTS; then
    ALLOWED_HOSTS_SET="true"
  fi
  DRY_RUN="${DOLLHOUSE_HOSTED_DRY_RUN:-false}"
  IMPORT_LEGACY_ENV="${DOLLHOUSE_HOSTED_IMPORT_LEGACY_ENV:-true}"
  ALLOW_CREDENTIAL_GIT_URL="${DOLLHOUSE_HOSTED_ALLOW_CREDENTIAL_GIT_URL:-false}"
  POSTGRES_READY_TIMEOUT="${DOLLHOUSE_HOSTED_POSTGRES_READY_TIMEOUT:-60}"
  VERIFY_READY_TIMEOUT="${DOLLHOUSE_HOSTED_VERIFY_READY_TIMEOUT:-60}"
  BOOTSTRAP_GITHUB_USERNAME="${DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME:-}"
  BOOTSTRAP_GITHUB_ID="${DOLLHOUSE_BOOTSTRAP_GITHUB_ID:-}"

  ENV_FILE="${DEPLOY_DIR}/.env.production"
  LEGACY_ENV_FILE="${DEPLOY_DIR}/.env"
  LEGACY_IMPORT_MARKER="${DEPLOY_DIR}/.legacy-env-imported"
  COMPOSE_FILE="${DEPLOY_DIR}/compose.yml"
  CADDY_FILE="${DEPLOY_DIR}/Caddyfile"
  INIT_DB_FILE="${DEPLOY_DIR}/init-db.sh"
  POST_MIGRATION_GRANTS_FILE="${DEPLOY_DIR}/post-migration-grants.sql"
  POST_MIGRATION_GRANTS_SCRIPT_FILE="${DEPLOY_DIR}/apply-post-migration-grants.sh"
  BOOTSTRAP_ADMIN_SCRIPT_FILE="${DEPLOY_DIR}/bootstrap-admin.sh"
  SERVER_DIR="${DEPLOY_DIR}/server"
  APP_CONTAINER_NAME=""
  POSTGRES_CONTAINER_NAME=""
  CADDY_CONTAINER_NAME=""

  return 0
}

usage() {
  cat <<'EOF'
DollhouseMCP hosted deployment helper

Usage:
  scripts/hosted-deploy.sh [--mode MODE] [--dry-run] [--quiet|--debug|--log-level LEVEL] render
  scripts/hosted-deploy.sh [--dry-run] [--quiet|--debug|--log-level LEVEL] install
  scripts/hosted-deploy.sh [--dry-run] [--quiet|--debug|--log-level LEVEL] update
  scripts/hosted-deploy.sh [--dry-run] [--quiet|--debug|--log-level LEVEL] migrate
  scripts/hosted-deploy.sh [--dry-run] [--quiet|--debug|--log-level LEVEL] bootstrap-admin
  scripts/hosted-deploy.sh [--dry-run] [--quiet|--debug|--log-level LEVEL] rollback
  scripts/hosted-deploy.sh [--dry-run] [--quiet|--debug|--log-level LEVEL] verify

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
  DOLLHOUSE_HOSTED_MODE=cloud|lan|enterprise
  DOLLHOUSE_HOSTED_DEPLOY_DIR=/opt/dollhousemcp
  DOLLHOUSE_HOSTED_INSTANCE_NAME=dollhousemcp
  DOLLHOUSE_HOSTED_DRY_RUN=false
  DOLLHOUSE_HOSTED_LOG_LEVEL=info
  DOLLHOUSE_HOSTED_PROXY_MODE=caddy-tls|caddy-http
  DOLLHOUSE_HOSTED_BIND_ADDRESS=0.0.0.0
  DOLLHOUSE_HOSTED_HTTP_BIND_PORT=80
  DOLLHOUSE_HOSTED_HTTPS_BIND_PORT=443
  DOLLHOUSE_HOSTED_CADDY_ACCESS_LOG=true|false
  DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES=173.245.48.0/20,2606:4700::/32
  DOLLHOUSE_HOSTED_DOCKER_LOG_MAX_SIZE=25m
  DOLLHOUSE_HOSTED_DOCKER_LOG_MAX_FILE=5
  DOLLHOUSE_HOSTED_SOURCE_DIR=/path/to/local/repo
  DOLLHOUSE_HOSTED_GIT_REF=codex/hosted-http-integration
  DOLLHOUSE_HOSTED_IMAGE_TAG=dollhousemcp-hosted:alpha
  DOLLHOUSE_AUTH_PROVIDER=embedded|oidc|local
  DOLLHOUSE_AUTH_METHODS=github
  DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=...
  DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=...
  DOLLHOUSE_AUTH_OPEN_DCR=true
  DOLLHOUSE_HOSTED_VERIFY_READY_TIMEOUT=60
  DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME=...
  DOLLHOUSE_BOOTSTRAP_GITHUB_ID=...

Examples:
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com scripts/hosted-deploy.sh --dry-run install
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com scripts/hosted-deploy.sh --debug install
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com scripts/hosted-deploy.sh install
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com scripts/hosted-deploy.sh update
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com scripts/hosted-deploy.sh migrate
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME=octocat scripts/hosted-deploy.sh bootstrap-admin
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com scripts/hosted-deploy.sh rollback
  DOLLHOUSE_PUBLIC_BASE_URL=https://mcp.example.com scripts/hosted-deploy.sh verify
EOF

  return 0
}

parse_args() {
  while [[ "$#" -gt 0 ]]; do
    local arg="${1:-}"
    shift
    case "${arg}" in
      --dry-run)
        DRY_RUN="true"
        ;;
      --mode)
        DEPLOY_MODE="${1:-}"
        [[ -n "${DEPLOY_MODE}" ]] || die "--mode requires cloud, lan, or enterprise"
        DEPLOY_MODE_SET="true"
        shift
        ;;
      --instance-name)
        INSTANCE_NAME="${1:-}"
        [[ -n "${INSTANCE_NAME}" ]] || die "--instance-name requires a name such as dollhousemcp-canary"
        INSTANCE_NAME_SET="true"
        shift
        ;;
      --proxy-mode)
        PROXY_MODE="${1:-}"
        [[ -n "${PROXY_MODE}" ]] || die "--proxy-mode requires caddy-tls or caddy-http"
        PROXY_MODE_SET="true"
        shift
        ;;
      --bind-address)
        BIND_ADDRESS="${1:-}"
        [[ -n "${BIND_ADDRESS}" ]] || die "--bind-address requires an address such as 127.0.0.1 or 0.0.0.0"
        BIND_ADDRESS_SET="true"
        shift
        ;;
      --quiet)
        LOG_LEVEL="quiet"
        ;;
      --debug)
        LOG_LEVEL="debug"
        ;;
      --log-level)
        local level="${1:-}"
        [[ -n "${level}" ]] || die "--log-level requires quiet, info, or debug"
        LOG_LEVEL="${level}"
        shift
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

  return 0
}
