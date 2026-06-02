# shellcheck shell=bash
# Configuration and CLI parsing for hosted-deploy.

hosted_deploy_init_config() {
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
  SERVER_DIR="${DEPLOY_DIR}/server"

  return 0
}

usage() {
  cat <<'EOF'
DollhouseMCP hosted deployment helper

Usage:
  scripts/hosted-deploy.sh [--dry-run] [--quiet|--debug|--log-level LEVEL] render
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
  DOLLHOUSE_HOSTED_DEPLOY_DIR=/opt/dollhousemcp
  DOLLHOUSE_HOSTED_DRY_RUN=false
  DOLLHOUSE_HOSTED_LOG_LEVEL=info
  DOLLHOUSE_HOSTED_SOURCE_DIR=/path/to/local/repo
  DOLLHOUSE_HOSTED_GIT_REF=codex/hosted-http-integration
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
