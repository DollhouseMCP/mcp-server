#!/usr/bin/env bash

# SSH operator wrapper for hosted DollhouseMCP deployments.
#
# This keeps the production deployment behavior in scripts/hosted-deploy.sh,
# while automating the remote operator steps: preflight, backups, remote clone,
# helper invocation, and public post-checks.

set -euo pipefail

ACTION="update"
ACTION_SET="false"
REMOTE_SSH_TARGET="${DOLLHOUSE_REMOTE_SSH_TARGET:-${DOLLHOUSE_HOSTED_SSH_TARGET:-}}"
REMOTE_SSH_IDENTITY_FILE="${DOLLHOUSE_REMOTE_SSH_IDENTITY_FILE:-}"
REMOTE_SSH_PORT="${DOLLHOUSE_REMOTE_SSH_PORT:-}"
REMOTE_KNOWN_HOSTS_FILE="${DOLLHOUSE_REMOTE_KNOWN_HOSTS_FILE:-}"
REMOTE_ACCEPT_HOST_KEY="${DOLLHOUSE_REMOTE_ACCEPT_HOST_KEY:-false}"
SSH_HOST=""
DEPLOY_DIR="${DOLLHOUSE_HOSTED_DEPLOY_DIR:-/opt/dollhousemcp}"
INSTANCE_NAME="${DOLLHOUSE_HOSTED_INSTANCE_NAME:-}"
INSTANCE_NAME_SET="false"
[[ -z "${INSTANCE_NAME}" ]] || INSTANCE_NAME_SET="true"
DEPLOY_MODE="${DOLLHOUSE_HOSTED_MODE:-}"
DEPLOY_MODE_SET="false"
[[ -z "${DEPLOY_MODE}" ]] || DEPLOY_MODE_SET="true"
PROXY_MODE="${DOLLHOUSE_HOSTED_PROXY_MODE:-}"
PROXY_MODE_SET="false"
[[ -z "${PROXY_MODE}" ]] || PROXY_MODE_SET="true"
BIND_ADDRESS="${DOLLHOUSE_HOSTED_BIND_ADDRESS:-}"
BIND_ADDRESS_SET="false"
[[ -z "${BIND_ADDRESS}" ]] || BIND_ADDRESS_SET="true"
HTTP_BIND_PORT="${DOLLHOUSE_HOSTED_HTTP_BIND_PORT:-}"
HTTP_BIND_PORT_SET="false"
[[ -z "${HTTP_BIND_PORT}" ]] || HTTP_BIND_PORT_SET="true"
HTTPS_BIND_PORT="${DOLLHOUSE_HOSTED_HTTPS_BIND_PORT:-}"
HTTPS_BIND_PORT_SET="false"
[[ -z "${HTTPS_BIND_PORT}" ]] || HTTPS_BIND_PORT_SET="true"
AUTH_PROVIDER="${DOLLHOUSE_AUTH_PROVIDER:-}"
AUTH_METHODS="${DOLLHOUSE_AUTH_METHODS:-}"
AUTH_OPEN_DCR="${DOLLHOUSE_AUTH_OPEN_DCR:-}"
AUTH_ALLOWLIST_REQUIRED="${DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED:-}"
AUTH_ISSUER="${DOLLHOUSE_AUTH_ISSUER:-}"
AUTH_AUDIENCE="${DOLLHOUSE_AUTH_AUDIENCE:-}"
AUTH_JWKS_URI="${DOLLHOUSE_AUTH_JWKS_URI:-}"
AUTH_OIDC_REQUIRE_TYP="${DOLLHOUSE_AUTH_OIDC_REQUIRE_TYP:-}"
AUTH_ALLOWLIST_SEED_FILE="${DOLLHOUSE_AUTH_ALLOWLIST_SEED_FILE:-}"
MCP_PORT="${DOLLHOUSE_HTTP_PORT:-}"
IMAGE_TAG="${DOLLHOUSE_HOSTED_IMAGE_TAG:-}"
MEM_LIMIT="${DOLLHOUSE_HOSTED_MEM_LIMIT:-}"
CPU_LIMIT="${DOLLHOUSE_HOSTED_CPUS:-}"
IMPORT_LEGACY_ENV="${DOLLHOUSE_HOSTED_IMPORT_LEGACY_ENV:-}"
POSTGRES_READY_TIMEOUT="${DOLLHOUSE_HOSTED_POSTGRES_READY_TIMEOUT:-}"
VERIFY_READY_TIMEOUT="${DOLLHOUSE_HOSTED_VERIFY_READY_TIMEOUT:-}"
ALLOWED_HOSTS="${DOLLHOUSE_HTTP_ALLOWED_HOSTS:-}"
TRUSTED_PROXIES="${DOLLHOUSE_TRUSTED_PROXIES:-}"
BOOTSTRAP_GITHUB_USERNAME="${DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME:-}"
BOOTSTRAP_GITHUB_ID="${DOLLHOUSE_BOOTSTRAP_GITHUB_ID:-}"
HOSTNAME="${DOLLHOUSE_HOSTED_HOSTNAME:-}"
HOSTNAME_SET="false"
[[ -z "${HOSTNAME}" ]] || HOSTNAME_SET="true"
PUBLIC_BASE_URL="${DOLLHOUSE_PUBLIC_BASE_URL:-}"
PUBLIC_BASE_URL_SET="false"
[[ -z "${PUBLIC_BASE_URL}" ]] || PUBLIC_BASE_URL_SET="true"
GIT_URL="${DOLLHOUSE_HOSTED_GIT_URL:-https://github.com/DollhouseMCP/mcp-server.git}"
GIT_REF="${DOLLHOUSE_HOSTED_GIT_REF:-codex/hosted-http-integration}"
ALLOW_CREDENTIAL_GIT_URL="${DOLLHOUSE_HOSTED_ALLOW_CREDENTIAL_GIT_URL:-false}"
LOG_LEVEL="${DOLLHOUSE_HOSTED_LOG_LEVEL:-info}"
SKIP_BACKUP="${DOLLHOUSE_REMOTE_SKIP_BACKUP:-false}"
SKIP_LOCAL_VERIFY="${DOLLHOUSE_REMOTE_SKIP_LOCAL_VERIFY:-false}"
KEEP_WORKDIR="${DOLLHOUSE_REMOTE_KEEP_WORKDIR:-false}"
DRY_RUN="${DOLLHOUSE_REMOTE_DRY_RUN:-false}"
BACKUP_RETRIES="${DOLLHOUSE_REMOTE_BACKUP_RETRIES:-3}"
BACKUP_RETRY_DELAY="${DOLLHOUSE_REMOTE_BACKUP_RETRY_DELAY:-2}"

usage() {
  cat <<'EOF'
DollhouseMCP hosted remote deployment wrapper

Usage:
  scripts/hosted-remote-deploy.sh [options] install
  scripts/hosted-remote-deploy.sh [options] update
  scripts/hosted-remote-deploy.sh [options] migrate
  scripts/hosted-remote-deploy.sh [options] bootstrap-admin
  scripts/hosted-remote-deploy.sh [options] rollback
  scripts/hosted-remote-deploy.sh [options] verify
  scripts/hosted-remote-deploy.sh [options] enroll-host

Options:
  --target USER@HOST        SSH target. Env: DOLLHOUSE_REMOTE_SSH_TARGET
  --identity-file PATH      SSH identity file. Env: DOLLHOUSE_REMOTE_SSH_IDENTITY_FILE
  --port PORT               SSH port. Env: DOLLHOUSE_REMOTE_SSH_PORT
  --known-hosts PATH        Known hosts file. Env: DOLLHOUSE_REMOTE_KNOWN_HOSTS_FILE
  --accept-host-key         Append scanned host key during enroll-host
  --hostname HOSTNAME       Public hostname. Env: DOLLHOUSE_HOSTED_HOSTNAME
  --public-base-url URL     Public origin. Env: DOLLHOUSE_PUBLIC_BASE_URL
  --deploy-dir DIR          Remote deploy dir. Env: DOLLHOUSE_HOSTED_DEPLOY_DIR
  --instance-name NAME      Compose/container name prefix. Env: DOLLHOUSE_HOSTED_INSTANCE_NAME
  --mode MODE               Hosted mode: cloud, lan, or enterprise
  --proxy-mode MODE         Hosted proxy mode: caddy-tls or caddy-http
  --bind-address ADDRESS    IPv4 host bind address for Caddy
  --http-bind-port PORT     Host HTTP port for Caddy
  --https-bind-port PORT    Host HTTPS port for Caddy
  --git-url URL             Repository URL cloned remotely. Env: DOLLHOUSE_HOSTED_GIT_URL
  --ref REF                 Branch/ref cloned remotely. Env: DOLLHOUSE_HOSTED_GIT_REF
  --skip-backup             Skip DB/env backup before remote action
  --backup-retries N        Backup attempts before failing. Env: DOLLHOUSE_REMOTE_BACKUP_RETRIES
  --backup-retry-delay N    Base seconds for exponential backup retry backoff
  --skip-local-verify       Skip local public endpoint checks after remote action
  --keep-workdir            Keep remote temporary clone for debugging
  --dry-run                 Print the plan without opening SSH
  --quiet|--debug           Logging mode passed to the hosted helper
  --log-level LEVEL         quiet, info, or debug

Example:
  DOLLHOUSE_REMOTE_SSH_TARGET=root@203.0.113.10 \
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  DOLLHOUSE_HOSTED_GIT_REF=codex/hosted-http-integration \
    scripts/hosted-remote-deploy.sh update
EOF

  return 0
}

log() {
  if [[ "${LOG_LEVEL}" != "quiet" ]]; then
    printf '[hosted-remote] %s\n' "$*"
  fi

  return 0
}

debug() {
  if [[ "${LOG_LEVEL}" == "debug" ]]; then
    printf '[hosted-remote] debug: %s\n' "$*" >&2
  fi

  return 0
}

die() {
  printf '[hosted-remote] error: %s\n' "$*" >&2
  exit 1
}

need_command() {
  local command_name="$1"

  command -v "${command_name}" >/dev/null 2>&1 || die "missing required command: ${command_name}"

  return 0
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

  return 0
}

validate_port_value() {
  local key="$1"
  local value="$2"

  if [[ -n "${value}" && ( ! "${value}" =~ ^[0-9]+$ || "${value}" -lt 1 || "${value}" -gt 65535 ) ]]; then
    die "${key} must be an integer from 1 to 65535, got: ${value}"
  fi

  return 0
}

validate_positive_integer() {
  local key="$1"
  local value="$2"

  if [[ ! "${value}" =~ ^[0-9]+$ || "${value}" -lt 1 ]]; then
    die "${key} must be an integer greater than or equal to 1, got: ${value}"
  fi

  return 0
}

validate_nonnegative_integer() {
  local key="$1"
  local value="$2"

  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    die "${key} must be an integer greater than or equal to 0, got: ${value}"
  fi

  return 0
}

expand_path() {
  local path="$1"

  case "${path}" in
    \~)
      printf '%s\n' "${HOME}"
      ;;
    \~/*)
      printf '%s/%s\n' "${HOME}" "${path#~/}"
      ;;
    *)
      printf '%s\n' "${path}"
      ;;
  esac

  return 0
}

git_url_has_credentials() {
  local git_url="$1"

  if [[ "${git_url}" =~ ^https?://[^/@]+@ ]]; then
    return 0
  fi

  return 1
}

redact_url() {
  local url="$1"

  if [[ "${url}" =~ ^(https?://)[^/@]+@(.+)$ ]]; then
    printf '%s[redacted]@%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    return 0
  fi

  printf '%s\n' "${url}"
  return 0
}

shell_quote() {
  local value="$1"

  printf "'"
  printf '%s' "${value}" | sed "s/'/'\\\\''/g"
  printf "'"

  return 0
}

validate_git_url_for_clone() {
  validate_bool DOLLHOUSE_HOSTED_ALLOW_CREDENTIAL_GIT_URL "${ALLOW_CREDENTIAL_GIT_URL}"
  if git_url_has_credentials "${GIT_URL}" && [[ "${ALLOW_CREDENTIAL_GIT_URL}" != "true" ]]; then
    die "DOLLHOUSE_HOSTED_GIT_URL must not embed credentials; use a git credential helper or deploy key on the remote host instead"
  fi

  return 0
}

adopt_remote_public_base_url() {
  local output_file="$1"
  local remote_public_base_url

  remote_public_base_url="$(
    sed -n 's/^\[hosted-remote\] effective public URL: //p' "${output_file}" |
      tail -n 1
  )"
  [[ -n "${remote_public_base_url}" ]] || return 0
  if [[ "${remote_public_base_url}" =~ [[:space:]] ]]; then
    die "remote helper returned a public URL containing whitespace: ${remote_public_base_url}"
  fi
  case "${remote_public_base_url}" in
    http://*|https://*)
      ;;
    *)
      die "remote helper returned an unsupported public URL: ${remote_public_base_url}"
      ;;
  esac

  PUBLIC_BASE_URL="${remote_public_base_url}"
  log "using remote effective public URL for verification: ${PUBLIC_BASE_URL}"

  return 0
}

parse_args() {
  while [[ "$#" -gt 0 ]]; do
    local arg="${1:-}"
    shift
    case "${arg}" in
      --target)
        REMOTE_SSH_TARGET="${1:-}"
        [[ -n "${REMOTE_SSH_TARGET}" ]] || die "--target requires USER@HOST"
        shift
        ;;
      --identity-file)
        REMOTE_SSH_IDENTITY_FILE="${1:-}"
        [[ -n "${REMOTE_SSH_IDENTITY_FILE}" ]] || die "--identity-file requires a path"
        shift
        ;;
      --port)
        REMOTE_SSH_PORT="${1:-}"
        [[ -n "${REMOTE_SSH_PORT}" ]] || die "--port requires a port number"
        shift
        ;;
      --known-hosts)
        REMOTE_KNOWN_HOSTS_FILE="${1:-}"
        [[ -n "${REMOTE_KNOWN_HOSTS_FILE}" ]] || die "--known-hosts requires a path"
        shift
        ;;
      --accept-host-key)
        REMOTE_ACCEPT_HOST_KEY="true"
        ;;
      --hostname)
        HOSTNAME="${1:-}"
        [[ -n "${HOSTNAME}" ]] || die "--hostname requires a hostname"
        HOSTNAME_SET="true"
        shift
        ;;
      --public-base-url)
        PUBLIC_BASE_URL="${1:-}"
        [[ -n "${PUBLIC_BASE_URL}" ]] || die "--public-base-url requires a URL"
        PUBLIC_BASE_URL_SET="true"
        shift
        ;;
      --deploy-dir)
        DEPLOY_DIR="${1:-}"
        [[ -n "${DEPLOY_DIR}" ]] || die "--deploy-dir requires a directory"
        shift
        ;;
      --instance-name)
        INSTANCE_NAME="${1:-}"
        [[ -n "${INSTANCE_NAME}" ]] || die "--instance-name requires a name such as dollhousemcp-canary"
        INSTANCE_NAME_SET="true"
        shift
        ;;
      --mode)
        DEPLOY_MODE="${1:-}"
        [[ -n "${DEPLOY_MODE}" ]] || die "--mode requires cloud, lan, or enterprise"
        DEPLOY_MODE_SET="true"
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
      --http-bind-port)
        HTTP_BIND_PORT="${1:-}"
        [[ -n "${HTTP_BIND_PORT}" ]] || die "--http-bind-port requires a port number"
        HTTP_BIND_PORT_SET="true"
        shift
        ;;
      --https-bind-port)
        HTTPS_BIND_PORT="${1:-}"
        [[ -n "${HTTPS_BIND_PORT}" ]] || die "--https-bind-port requires a port number"
        HTTPS_BIND_PORT_SET="true"
        shift
        ;;
      --git-url)
        GIT_URL="${1:-}"
        [[ -n "${GIT_URL}" ]] || die "--git-url requires a URL"
        shift
        ;;
      --ref)
        GIT_REF="${1:-}"
        [[ -n "${GIT_REF}" ]] || die "--ref requires a branch or ref"
        shift
        ;;
      --skip-backup)
        SKIP_BACKUP="true"
        ;;
      --backup-retries)
        BACKUP_RETRIES="${1:-}"
        [[ -n "${BACKUP_RETRIES}" ]] || die "--backup-retries requires a count"
        shift
        ;;
      --backup-retry-delay)
        BACKUP_RETRY_DELAY="${1:-}"
        [[ -n "${BACKUP_RETRY_DELAY}" ]] || die "--backup-retry-delay requires a second count"
        shift
        ;;
      --skip-local-verify)
        SKIP_LOCAL_VERIFY="true"
        ;;
      --keep-workdir)
        KEEP_WORKDIR="true"
        ;;
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
        LOG_LEVEL="${1:-}"
        [[ -n "${LOG_LEVEL}" ]] || die "--log-level requires quiet, info, or debug"
        shift
        ;;
      help|--help|-h)
        usage
        exit 0
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

validate_action() {
  case "${ACTION}" in
    install|update|migrate|bootstrap-admin|rollback|verify|enroll-host)
      ;;
    *)
      die "unknown action: ${ACTION}"
      ;;
  esac

  return 0
}

resolve_ssh_host() {
  local target_host

  target_host="${REMOTE_SSH_TARGET#*@}"
  if [[ "${target_host}" =~ ^\[([^]]+)\](:([0-9]+))?$ ]]; then
    SSH_HOST="${BASH_REMATCH[1]}"
    if [[ -z "${REMOTE_SSH_PORT}" && -n "${BASH_REMATCH[3]:-}" ]]; then
      REMOTE_SSH_PORT="${BASH_REMATCH[3]}"
    fi
    return 0
  fi

  if [[ "${target_host}" == *":"* ]]; then
    die "IPv6 SSH targets must use bracket form, for example root@[2001:db8::1]"
  fi

  SSH_HOST="${target_host}"
  [[ -n "${SSH_HOST}" ]] || die "could not resolve host from SSH target: ${REMOTE_SSH_TARGET}"

  return 0
}

known_hosts_lookup() {
  if [[ -n "${REMOTE_SSH_PORT}" && "${REMOTE_SSH_PORT}" != "22" ]]; then
    printf '[%s]:%s\n' "${SSH_HOST}" "${REMOTE_SSH_PORT}"
    return 0
  fi

  printf '%s\n' "${SSH_HOST}"
  return 0
}

resolve_known_hosts_file_for_enroll() {
  if [[ -z "${REMOTE_KNOWN_HOSTS_FILE}" ]]; then
    [[ -n "${HOME:-}" ]] || die "HOME is required when --known-hosts is not provided"
    REMOTE_KNOWN_HOSTS_FILE="${HOME}/.ssh/known_hosts"
    return 0
  fi

  REMOTE_KNOWN_HOSTS_FILE="$(expand_path "${REMOTE_KNOWN_HOSTS_FILE}")"
  return 0
}

resolve_public_base_url() {
  local scheme port suffix

  if [[ -n "${PUBLIC_BASE_URL}" ]]; then
    return 0
  fi
  [[ -n "${HOSTNAME}" ]] || die "set --hostname, DOLLHOUSE_HOSTED_HOSTNAME, or DOLLHOUSE_PUBLIC_BASE_URL"
  if [[ "${DEPLOY_MODE}" == "lan" || "${PROXY_MODE}" == "caddy-http" ]]; then
    scheme="http"
    port="${HTTP_BIND_PORT:-3000}"
  else
    scheme="https"
    port="${HTTPS_BIND_PORT:-443}"
  fi
  case "${scheme}:${port}" in
    http:80|https:443)
      suffix=""
      ;;
    *)
      suffix=":${port}"
      ;;
  esac
  PUBLIC_BASE_URL="${scheme}://${HOSTNAME}${suffix}"

  return 0
}

resolve_hostname() {
  if [[ -n "${HOSTNAME}" ]]; then
    return 0
  fi
  [[ -n "${PUBLIC_BASE_URL}" ]] || die "set --hostname, DOLLHOUSE_HOSTED_HOSTNAME, or DOLLHOUSE_PUBLIC_BASE_URL"
  HOSTNAME="${PUBLIC_BASE_URL#https://}"
  HOSTNAME="${HOSTNAME#http://}"
  HOSTNAME="${HOSTNAME%%/*}"

  return 0
}

default_instance_name() {
  local normalized_dir deploy_basename instance_name
  normalized_dir="${DEPLOY_DIR%/}"
  [[ -n "${normalized_dir}" ]] || normalized_dir="${DEPLOY_DIR}"
  deploy_basename="$(basename "${normalized_dir}")"
  instance_name="$(
    printf '%s\n' "${deploy_basename}" |
      tr '[:upper:]' '[:lower:]' |
      sed 's/[^a-z0-9-]/-/g; s/--*/-/g; s/^-//; s/-$//'
  )"
  if [[ -z "${instance_name}" ]]; then
    instance_name="dollhousemcp"
  fi
  printf '%s\n' "${instance_name}"

  return 0
}

resolve_instance_name() {
  if [[ -z "${INSTANCE_NAME}" ]]; then
    INSTANCE_NAME="$(default_instance_name)"
  fi

  return 0
}

validate_no_whitespace() {
  local key="$1"
  local value="$2"

  if [[ "${value}" =~ [[:space:]] ]]; then
    die "${key} must not contain whitespace"
  fi

  return 0
}

validate_instance_name() {
  validate_no_whitespace DOLLHOUSE_HOSTED_INSTANCE_NAME "${INSTANCE_NAME}"
  if [[ ! "${INSTANCE_NAME}" =~ ^[a-z0-9][a-z0-9-]{0,47}$ ]]; then
    die "DOLLHOUSE_HOSTED_INSTANCE_NAME must be 1-48 lowercase letters, numbers, or hyphens and start with a letter or number; got: ${INSTANCE_NAME}"
  fi

  return 0
}

validate_optional_deploy_mode() {
  [[ -n "${DEPLOY_MODE}" ]] || return 0
  case "${DEPLOY_MODE}" in
    cloud|lan|enterprise)
      ;;
    *)
      die "DOLLHOUSE_HOSTED_MODE must be cloud, lan, or enterprise; got: ${DEPLOY_MODE}"
      ;;
  esac

  return 0
}

validate_optional_proxy_mode() {
  [[ -n "${PROXY_MODE}" ]] || return 0
  case "${PROXY_MODE}" in
    caddy-tls|caddy-http)
      ;;
    *)
      die "DOLLHOUSE_HOSTED_PROXY_MODE must be caddy-tls or caddy-http; got: ${PROXY_MODE}"
      ;;
  esac

  return 0
}

is_ipv4_address() {
  local value="$1"
  local octet
  local -a octets

  [[ "${value}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  IFS=. read -r -a octets <<< "${value}"
  for octet in "${octets[@]}"; do
    if (( 10#${octet} > 255 )); then
      return 1
    fi
  done

  return 0
}

validate_optional_bind_address() {
  [[ -n "${BIND_ADDRESS}" ]] || return 0
  validate_no_whitespace DOLLHOUSE_HOSTED_BIND_ADDRESS "${BIND_ADDRESS}"
  if ! is_ipv4_address "${BIND_ADDRESS}"; then
    die "DOLLHOUSE_HOSTED_BIND_ADDRESS must be an IPv4 address such as 127.0.0.1 or 0.0.0.0; got: ${BIND_ADDRESS}"
  fi

  return 0
}

validate_forwarded_hosted_inputs() {
  validate_port_value DOLLHOUSE_HTTP_PORT "${MCP_PORT}"
  validate_no_whitespace DOLLHOUSE_HOSTED_IMAGE_TAG "${IMAGE_TAG}"
  validate_no_whitespace DOLLHOUSE_HOSTED_MEM_LIMIT "${MEM_LIMIT}"
  validate_no_whitespace DOLLHOUSE_HOSTED_CPUS "${CPU_LIMIT}"
  validate_no_whitespace DOLLHOUSE_HTTP_ALLOWED_HOSTS "${ALLOWED_HOSTS}"
  validate_no_whitespace DOLLHOUSE_TRUSTED_PROXIES "${TRUSTED_PROXIES}"
  validate_no_whitespace DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME "${BOOTSTRAP_GITHUB_USERNAME}"
  validate_no_whitespace DOLLHOUSE_BOOTSTRAP_GITHUB_ID "${BOOTSTRAP_GITHUB_ID}"
  if [[ -n "${IMPORT_LEGACY_ENV}" ]]; then
    validate_bool DOLLHOUSE_HOSTED_IMPORT_LEGACY_ENV "${IMPORT_LEGACY_ENV}"
  fi
  if [[ -n "${POSTGRES_READY_TIMEOUT}" ]]; then
    validate_nonnegative_integer DOLLHOUSE_HOSTED_POSTGRES_READY_TIMEOUT "${POSTGRES_READY_TIMEOUT}"
  fi
  if [[ -n "${VERIFY_READY_TIMEOUT}" ]]; then
    validate_nonnegative_integer DOLLHOUSE_HOSTED_VERIFY_READY_TIMEOUT "${VERIFY_READY_TIMEOUT}"
  fi

  return 0
}

validate_log_level() {
  case "${LOG_LEVEL}" in
    quiet|info|debug)
      ;;
    *)
      die "log level must be quiet, info, or debug; got: ${LOG_LEVEL}"
      ;;
  esac

  return 0
}

validate_config() {
  validate_action
  validate_log_level
  validate_bool DOLLHOUSE_REMOTE_SKIP_BACKUP "${SKIP_BACKUP}"
  validate_bool DOLLHOUSE_REMOTE_SKIP_LOCAL_VERIFY "${SKIP_LOCAL_VERIFY}"
  validate_bool DOLLHOUSE_REMOTE_KEEP_WORKDIR "${KEEP_WORKDIR}"
  validate_bool DOLLHOUSE_REMOTE_DRY_RUN "${DRY_RUN}"
  validate_bool DOLLHOUSE_REMOTE_ACCEPT_HOST_KEY "${REMOTE_ACCEPT_HOST_KEY}"
  validate_port_value DOLLHOUSE_REMOTE_SSH_PORT "${REMOTE_SSH_PORT}"
  validate_optional_deploy_mode
  validate_optional_proxy_mode
  validate_optional_bind_address
  validate_port_value DOLLHOUSE_HOSTED_HTTP_BIND_PORT "${HTTP_BIND_PORT}"
  validate_port_value DOLLHOUSE_HOSTED_HTTPS_BIND_PORT "${HTTPS_BIND_PORT}"
  validate_forwarded_hosted_inputs
  validate_positive_integer DOLLHOUSE_REMOTE_BACKUP_RETRIES "${BACKUP_RETRIES}"
  validate_nonnegative_integer DOLLHOUSE_REMOTE_BACKUP_RETRY_DELAY "${BACKUP_RETRY_DELAY}"
  [[ -n "${REMOTE_SSH_TARGET}" ]] || die "set --target or DOLLHOUSE_REMOTE_SSH_TARGET"
  [[ "${REMOTE_SSH_TARGET}" != *[[:space:]]* ]] || die "SSH target must not contain whitespace"
  resolve_ssh_host
  [[ -z "${REMOTE_SSH_IDENTITY_FILE}" || -f "${REMOTE_SSH_IDENTITY_FILE}" ]] || \
    die "SSH identity file does not exist: ${REMOTE_SSH_IDENTITY_FILE}"
  if [[ "${ACTION}" == "enroll-host" ]]; then
    resolve_known_hosts_file_for_enroll
    return 0
  fi
  validate_git_url_for_clone
  resolve_instance_name
  validate_instance_name
  if [[ -n "${REMOTE_KNOWN_HOSTS_FILE}" ]]; then
    REMOTE_KNOWN_HOSTS_FILE="$(expand_path "${REMOTE_KNOWN_HOSTS_FILE}")"
    [[ -f "${REMOTE_KNOWN_HOSTS_FILE}" ]] || \
      die "known hosts file does not exist: ${REMOTE_KNOWN_HOSTS_FILE}; run enroll-host or provide a managed known_hosts file"
  fi
  resolve_public_base_url
  resolve_hostname

  return 0
}

ssh_args() {
  if [[ -n "${REMOTE_SSH_IDENTITY_FILE}" ]]; then
    printf '%s\0%s\0%s\0%s\0' -i "${REMOTE_SSH_IDENTITY_FILE}" -o IdentitiesOnly=yes
  fi
  if [[ -n "${REMOTE_SSH_PORT}" ]]; then
    printf '%s\0%s\0' -p "${REMOTE_SSH_PORT}"
  fi
  printf '%s\0%s\0' -o StrictHostKeyChecking=yes
  if [[ -n "${REMOTE_KNOWN_HOSTS_FILE}" ]]; then
    printf '%s\0%s\0' -o "UserKnownHostsFile=${REMOTE_KNOWN_HOSTS_FILE}"
  fi

  return 0
}

run_dry_plan() {
  if [[ "${ACTION}" == "enroll-host" ]]; then
    log "dry-run: would scan SSH host keys for ${SSH_HOST}${REMOTE_SSH_PORT:+:${REMOTE_SSH_PORT}}"
    log "dry-run: would print fingerprints for out-of-band verification"
    log "dry-run: would use known hosts file ${REMOTE_KNOWN_HOSTS_FILE}"
    if [[ "${REMOTE_ACCEPT_HOST_KEY}" == "true" ]]; then
      log "dry-run: would append the scanned host key after operator acceptance"
    else
      log "dry-run: would not write without --accept-host-key"
    fi
    return 0
  fi

  log "dry-run: would connect to ${REMOTE_SSH_TARGET}"
  log "dry-run: action=${ACTION} deploy_dir=${DEPLOY_DIR} instance=${INSTANCE_NAME} hostname=${HOSTNAME} ref=${GIT_REF}"
  if [[ -n "${DEPLOY_MODE}${PROXY_MODE}${BIND_ADDRESS}${HTTP_BIND_PORT}${HTTPS_BIND_PORT}" ]]; then
    log "dry-run: hosted overrides mode=${DEPLOY_MODE:-default} proxy_mode=${PROXY_MODE:-default} bind=${BIND_ADDRESS:-default} http_port=${HTTP_BIND_PORT:-default} https_port=${HTTPS_BIND_PORT:-default}"
  fi
  if [[ -n "${MCP_PORT}${IMAGE_TAG}${MEM_LIMIT}${CPU_LIMIT}${IMPORT_LEGACY_ENV}${POSTGRES_READY_TIMEOUT}${VERIFY_READY_TIMEOUT}${ALLOWED_HOSTS}${TRUSTED_PROXIES}" ]]; then
    log "dry-run: hosted runtime overrides mcp_port=${MCP_PORT:-default} image_tag=${IMAGE_TAG:-default} mem=${MEM_LIMIT:-default} cpus=${CPU_LIMIT:-default}"
    log "dry-run: hosted config overrides import_legacy_env=${IMPORT_LEGACY_ENV:-default} postgres_ready_timeout=${POSTGRES_READY_TIMEOUT:-default} verify_ready_timeout=${VERIFY_READY_TIMEOUT:-default}"
    log "dry-run: hosted network overrides allowed_hosts=${ALLOWED_HOSTS:-default} trusted_proxies=${TRUSTED_PROXIES:-default}"
  fi
  if [[ -n "${BOOTSTRAP_GITHUB_USERNAME}${BOOTSTRAP_GITHUB_ID}" ]]; then
    log "dry-run: hosted bootstrap override github_username=${BOOTSTRAP_GITHUB_USERNAME:-default} github_id=${BOOTSTRAP_GITHUB_ID:-default}"
  fi
  if [[ "${SKIP_BACKUP}" == "true" ]]; then
    log "dry-run: would skip remote DB/env backups"
  else
    log "dry-run: would create remote DB/env backups when an existing deployment is present"
    log "dry-run: backup retries=${BACKUP_RETRIES} base_retry_delay=${BACKUP_RETRY_DELAY}s exponential_backoff=true"
  fi
  log "dry-run: would clone $(redact_url "${GIT_URL}") at ${GIT_REF} on the remote host"
  log "dry-run: would run scripts/hosted-deploy.sh ${ACTION} on the remote host"
  if [[ "${SKIP_LOCAL_VERIFY}" == "true" ]]; then
    log "dry-run: would skip local public endpoint checks"
  else
    log "dry-run: would check ${PUBLIC_BASE_URL}/healthz, /readyz, and unauthenticated /mcp"
  fi

  return 0
}

run_enroll_host() {
  local keyscan_output
  local lookup
  local known_hosts_dir

  need_command ssh-keyscan
  need_command ssh-keygen

  keyscan_output="$(mktemp /tmp/dollhouse-known-host.XXXXXX)"
  chmod 0600 "${keyscan_output}"

  log "scanning SSH host key for ${SSH_HOST}${REMOTE_SSH_PORT:+:${REMOTE_SSH_PORT}}"
  if [[ -n "${REMOTE_SSH_PORT}" ]]; then
    ssh-keyscan -T 10 -p "${REMOTE_SSH_PORT}" "${SSH_HOST}" > "${keyscan_output}" 2>/dev/null || {
      rm -f "${keyscan_output}"
      die "failed to scan SSH host key for ${SSH_HOST}"
    }
  else
    ssh-keyscan -T 10 "${SSH_HOST}" > "${keyscan_output}" 2>/dev/null || {
      rm -f "${keyscan_output}"
      die "failed to scan SSH host key for ${SSH_HOST}"
    }
  fi
  if [[ ! -s "${keyscan_output}" ]]; then
    rm -f "${keyscan_output}"
    die "ssh-keyscan returned no host keys for ${SSH_HOST}"
  fi

  lookup="$(known_hosts_lookup)"
  log "host key fingerprint(s) for ${lookup}:"
  ssh-keygen -lf "${keyscan_output}"

  if [[ -f "${REMOTE_KNOWN_HOSTS_FILE}" ]] && ssh-keygen -F "${lookup}" -f "${REMOTE_KNOWN_HOSTS_FILE}" >/dev/null 2>&1; then
    log "known hosts file already contains ${lookup}: ${REMOTE_KNOWN_HOSTS_FILE}"
    rm -f "${keyscan_output}"
    return 0
  fi

  if [[ "${REMOTE_ACCEPT_HOST_KEY}" != "true" ]]; then
    log "not writing host key; verify the fingerprint out of band, then rerun with --accept-host-key"
    rm -f "${keyscan_output}"
    return 0
  fi

  known_hosts_dir="$(dirname "${REMOTE_KNOWN_HOSTS_FILE}")"
  mkdir -p "${known_hosts_dir}"
  chmod 0700 "${known_hosts_dir}" 2>/dev/null || true
  touch "${REMOTE_KNOWN_HOSTS_FILE}"
  chmod 0600 "${REMOTE_KNOWN_HOSTS_FILE}"
  cat "${keyscan_output}" >> "${REMOTE_KNOWN_HOSTS_FILE}"
  log "wrote ${lookup} to ${REMOTE_KNOWN_HOSTS_FILE}"
  rm -f "${keyscan_output}"

  return 0
}

run_remote_action() {
  local ssh_command=()
  local ssh_arg
  local remote_command
  local remote_payload_arg
  local remote_payload_args=()
  local remote_output
  local helper_hostname helper_public_base_url helper_instance_name
  local helper_deploy_mode helper_proxy_mode helper_bind_address
  local helper_http_bind_port helper_https_bind_port
  local helper_auth_provider helper_auth_methods helper_auth_open_dcr
  local helper_auth_allowlist_required helper_auth_issuer helper_auth_audience
  local helper_auth_jwks_uri helper_auth_oidc_require_typ helper_auth_allowlist_seed_file
  local helper_mcp_port helper_image_tag helper_mem_limit helper_cpu_limit
  local helper_import_legacy_env helper_postgres_ready_timeout helper_verify_ready_timeout
  local helper_allowed_hosts helper_trusted_proxies
  local helper_bootstrap_github_username helper_bootstrap_github_id

  helper_hostname=""
  helper_public_base_url=""
  helper_instance_name=""
  helper_deploy_mode=""
  helper_proxy_mode=""
  helper_bind_address=""
  helper_http_bind_port=""
  helper_https_bind_port=""
  helper_auth_provider="${AUTH_PROVIDER}"
  helper_auth_methods="${AUTH_METHODS}"
  helper_auth_open_dcr="${AUTH_OPEN_DCR}"
  helper_auth_allowlist_required="${AUTH_ALLOWLIST_REQUIRED}"
  helper_auth_issuer="${AUTH_ISSUER}"
  helper_auth_audience="${AUTH_AUDIENCE}"
  helper_auth_jwks_uri="${AUTH_JWKS_URI}"
  helper_auth_oidc_require_typ="${AUTH_OIDC_REQUIRE_TYP}"
  helper_auth_allowlist_seed_file="${AUTH_ALLOWLIST_SEED_FILE}"
  helper_mcp_port="${MCP_PORT}"
  helper_image_tag="${IMAGE_TAG}"
  helper_mem_limit="${MEM_LIMIT}"
  helper_cpu_limit="${CPU_LIMIT}"
  helper_import_legacy_env="${IMPORT_LEGACY_ENV}"
  helper_postgres_ready_timeout="${POSTGRES_READY_TIMEOUT}"
  helper_verify_ready_timeout="${VERIFY_READY_TIMEOUT}"
  helper_allowed_hosts="${ALLOWED_HOSTS}"
  helper_trusted_proxies="${TRUSTED_PROXIES}"
  helper_bootstrap_github_username="${BOOTSTRAP_GITHUB_USERNAME}"
  helper_bootstrap_github_id="${BOOTSTRAP_GITHUB_ID}"
  [[ "${HOSTNAME_SET}" != "true" ]] || helper_hostname="${HOSTNAME}"
  [[ "${PUBLIC_BASE_URL_SET}" != "true" ]] || helper_public_base_url="${PUBLIC_BASE_URL}"
  [[ "${INSTANCE_NAME_SET}" != "true" ]] || helper_instance_name="${INSTANCE_NAME}"
  [[ "${DEPLOY_MODE_SET}" != "true" ]] || helper_deploy_mode="${DEPLOY_MODE}"
  [[ "${PROXY_MODE_SET}" != "true" ]] || helper_proxy_mode="${PROXY_MODE}"
  [[ "${BIND_ADDRESS_SET}" != "true" ]] || helper_bind_address="${BIND_ADDRESS}"
  [[ "${HTTP_BIND_PORT_SET}" != "true" ]] || helper_http_bind_port="${HTTP_BIND_PORT}"
  [[ "${HTTPS_BIND_PORT_SET}" != "true" ]] || helper_https_bind_port="${HTTPS_BIND_PORT}"

  while IFS= read -r -d '' ssh_arg; do
    ssh_command+=("${ssh_arg}")
  done < <(ssh_args)

  remote_payload_args=(
    "${ACTION}"
    "${DEPLOY_DIR}"
    "${helper_hostname}"
    "${helper_public_base_url}"
    "${GIT_URL}"
    "${GIT_REF}"
    "${LOG_LEVEL}"
    "${SKIP_BACKUP}"
    "${KEEP_WORKDIR}"
    "${BACKUP_RETRIES}"
    "${BACKUP_RETRY_DELAY}"
    "${helper_instance_name}"
    "${helper_deploy_mode}"
    "${helper_proxy_mode}"
    "${helper_bind_address}"
    "${helper_http_bind_port}"
    "${helper_https_bind_port}"
    "${helper_auth_provider}"
    "${helper_auth_methods}"
    "${helper_auth_open_dcr}"
    "${helper_auth_allowlist_required}"
    "${helper_auth_issuer}"
    "${helper_auth_audience}"
    "${helper_auth_jwks_uri}"
    "${helper_auth_oidc_require_typ}"
    "${helper_auth_allowlist_seed_file}"
    "${helper_mcp_port}"
    "${helper_image_tag}"
    "${helper_mem_limit}"
    "${helper_cpu_limit}"
    "${helper_import_legacy_env}"
    "${helper_postgres_ready_timeout}"
    "${helper_verify_ready_timeout}"
    "${helper_allowed_hosts}"
    "${helper_trusted_proxies}"
    "${helper_bootstrap_github_username}"
    "${helper_bootstrap_github_id}"
  )
  remote_command="bash -s --"
  for remote_payload_arg in "${remote_payload_args[@]}"; do
    remote_command+=" $(shell_quote "${remote_payload_arg}")"
  done

  log "connecting to ${REMOTE_SSH_TARGET}"
  remote_output="$(mktemp /tmp/dollhouse-remote-output.XXXXXX)"
  if ! {
    # shellcheck disable=SC2029 # remote_command is intentionally quoted locally to preserve empty arguments over SSH.
    ssh "${ssh_command[@]}" "${REMOTE_SSH_TARGET}" "${remote_command}" <<'REMOTE_BOOTSTRAP'
set -euo pipefail

# Run the payload from a file so stdin-consuming remote commands cannot consume
# the rest of the script while it is still being streamed over SSH.
remote_payload="$(mktemp /tmp/dollhouse-remote-wrapper.XXXXXX.sh)"
chmod 0600 "${remote_payload}"
cleanup_remote_payload() {
  case "${remote_payload}" in
    /tmp/dollhouse-remote-wrapper.*.sh)
      rm -f "${remote_payload}"
      ;;
  esac

  return 0
}
trap cleanup_remote_payload EXIT

cat > "${remote_payload}" <<'REMOTE_PAYLOAD'
set -euo pipefail

action="$1"
deploy_dir="$2"
hostname="$3"
public_base_url="$4"
git_url="$5"
git_ref="$6"
log_level="$7"
skip_backup="$8"
keep_workdir="$9"
backup_retries="${10}"
backup_retry_delay="${11}"
instance_name="${12}"
deploy_mode="${13}"
proxy_mode="${14}"
bind_address="${15}"
http_bind_port="${16}"
https_bind_port="${17}"
auth_provider="${18}"
auth_methods="${19}"
auth_open_dcr="${20}"
auth_allowlist_required="${21}"
auth_issuer="${22}"
auth_audience="${23}"
auth_jwks_uri="${24}"
auth_oidc_require_typ="${25}"
auth_allowlist_seed_file="${26}"
mcp_port="${27}"
image_tag="${28}"
mem_limit="${29}"
cpu_limit="${30}"
import_legacy_env="${31}"
postgres_ready_timeout="${32}"
verify_ready_timeout="${33}"
allowed_hosts="${34}"
trusted_proxies="${35}"
bootstrap_github_username="${36}"
bootstrap_github_id="${37}"
workdir=""

remote_log() {
  if [[ "${log_level}" != "quiet" ]]; then
    printf '[hosted-remote] %s\n' "$*"
  fi

  return 0
}

remote_warn() {
  printf '[hosted-remote] warning: %s\n' "$*" >&2

  return 0
}

remote_redact_url() {
  local url="$1"

  if [[ "${url}" =~ ^(https?://)[^/@]+@(.+)$ ]]; then
    printf '%s[redacted]@%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    return 0
  fi

  printf '%s\n' "${url}"
  return 0
}

remote_die() {
  printf '[hosted-remote] error: %s\n' "$*" >&2
  exit 1
}

remote_need() {
  local command_name="$1"

  command -v "${command_name}" >/dev/null 2>&1 || remote_die "missing required command on remote host: ${command_name}"

  return 0
}

remote_cleanup() {
  if [[ "${keep_workdir}" == "true" || -z "${workdir}" ]]; then
    return 0
  fi
  case "${workdir}" in
    /tmp/dollhouse-hosted.*)
      rm -R "${workdir}" 2>/dev/null || true
      ;;
  esac

  return 0
}
trap remote_cleanup EXIT

remote_compose() {
  (cd "${deploy_dir}" && docker compose --env-file "${deploy_dir}/.env.production" -f "${deploy_dir}/compose.yml" "$@")
}

backup_delay_for_attempt() {
  local attempt="$1"
  local delay="${backup_retry_delay}"
  local index

  for ((index = 1; index < attempt; index++)); do
    delay=$((delay * 2))
  done

  printf '%s\n' "${delay}"
  return 0
}

sleep_between_backup_attempts() {
  local attempt="$1"
  local delay

  delay="$(backup_delay_for_attempt "${attempt}")"
  if [[ "${delay}" -gt 0 ]]; then
    sleep "${delay}"
  fi

  return 0
}

backup_requires_database() {
  case "${action}" in
    update|migrate|rollback)
      return 0
      ;;
  esac

  return 1
}

backup_env_files() {
  local stamp="$1"
  local file backup_name

  for file in .env .env.production; do
    if [[ -f "${deploy_dir}/${file}" ]]; then
      backup_name="${deploy_dir}/backups/${file#.}.pre-remote-${action}-${stamp}"
      cp "${deploy_dir}/${file}" "${backup_name}" || \
        remote_die "failed to copy ${file} backup to ${backup_name}"
      chmod 0600 "${backup_name}" || \
        remote_die "failed to secure ${file} backup permissions for ${backup_name}"
      remote_log "backed up ${file} to ${backup_name}"
    fi
  done

  return 0
}

remote_env_file_value() {
  local key="$1"

  [[ -f "${deploy_dir}/.env.production" ]] || return 0
  awk -F= -v key="${key}" '$1 == key { value = substr($0, length(key) + 2) } END { print value }' "${deploy_dir}/.env.production"

  return 0
}

wait_for_database_backup_ready() {
  local attempt retry_delay

  for ((attempt = 1; attempt <= backup_retries; attempt++)); do
    if remote_compose exec -T postgres pg_isready -U dollhouse -d dollhousemcp >/dev/null 2>&1; then
      if [[ "${attempt}" -gt 1 ]]; then
        remote_log "postgres ready for backup on attempt ${attempt}/${backup_retries}"
      fi
      return 0
    fi

    if [[ "${attempt}" -lt "${backup_retries}" ]]; then
      retry_delay="$(backup_delay_for_attempt "${attempt}")"
      remote_warn "postgres not ready for backup attempt ${attempt}/${backup_retries}; retrying in ${retry_delay}s"
      sleep_between_backup_attempts "${attempt}"
    fi
  done

  if backup_requires_database; then
    remote_die "postgres is not ready for pre-${action} backup after ${backup_retries} attempt(s); set DOLLHOUSE_REMOTE_SKIP_BACKUP=true only if you have a separate backup"
  fi

  remote_warn "postgres is not ready after ${backup_retries} attempt(s); skipping database backup"
  return 1
}

quarantine_partial_backup() {
  local tmp_file="$1"
  local backup_file="$2"
  local attempt="$3"
  local failed_file

  if [[ ! -f "${tmp_file}" ]]; then
    return 0
  fi

  if [[ ! -s "${tmp_file}" ]]; then
    rm -f "${tmp_file}"
    return 0
  fi

  failed_file="${backup_file}.failed-attempt-${attempt}"
  mv "${tmp_file}" "${failed_file}" || \
    remote_die "failed to quarantine partial database backup ${tmp_file}"
  chmod 0600 "${failed_file}" || \
    remote_die "failed to secure quarantined partial database backup ${failed_file}"
  remote_warn "partial database backup from attempt ${attempt} moved to ${failed_file}"

  return 0
}

dump_database_with_retries() {
  local backup_file="$1"
  local attempt retry_delay tmp_file

  for ((attempt = 1; attempt <= backup_retries; attempt++)); do
    tmp_file="${backup_file}.tmp"
    rm -f "${tmp_file}"
    remote_log "creating database backup ${backup_file} (attempt ${attempt}/${backup_retries})"

    if remote_compose exec -T postgres pg_dump -U dollhouse dollhousemcp > "${tmp_file}"; then
      if [[ ! -s "${tmp_file}" ]]; then
        remote_warn "database backup attempt ${attempt}/${backup_retries} produced an empty dump"
        rm -f "${tmp_file}"
      else
        mv "${tmp_file}" "${backup_file}" || \
          remote_die "failed to finalize database backup ${backup_file}"
        chmod 0600 "${backup_file}" || \
          remote_die "failed to secure database backup permissions for ${backup_file}"
        return 0
      fi
    else
      quarantine_partial_backup "${tmp_file}" "${backup_file}" "${attempt}"
    fi

    if [[ "${attempt}" -lt "${backup_retries}" ]]; then
      retry_delay="$(backup_delay_for_attempt "${attempt}")"
      remote_warn "database backup attempt ${attempt}/${backup_retries} failed; retrying in ${retry_delay}s"
      sleep_between_backup_attempts "${attempt}"
    fi
  done

  remote_die "failed to create database backup ${backup_file} after ${backup_retries} attempt(s); partial attempts were quarantined as ${backup_file}.failed-attempt-*"
}

backup_database() {
  local stamp="$1"
  local backup_file

  if [[ ! -f "${deploy_dir}/compose.yml" || ! -f "${deploy_dir}/.env.production" ]]; then
    remote_log "no compose.yml/.env.production pair found; skipping database backup"
    return 0
  fi

  wait_for_database_backup_ready || return 0

  backup_file="${deploy_dir}/backups/pre-remote-${action}-${stamp}.sql"
  dump_database_with_retries "${backup_file}"

  return 0
}

backup_existing_deploy() {
  local stamp

  if [[ "${skip_backup}" == "true" ]]; then
    remote_warn "remote backup skipped by operator request"
    return 0
  fi
  if [[ ! -d "${deploy_dir}" ]]; then
    remote_log "no existing deploy dir at ${deploy_dir}; skipping backup"
    return 0
  fi

  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "${deploy_dir}/backups" || \
    remote_die "failed to create backup directory ${deploy_dir}/backups"
  chmod 0750 "${deploy_dir}/backups" || \
    remote_die "failed to secure backup directory permissions for ${deploy_dir}/backups"
  backup_env_files "${stamp}"
  backup_database "${stamp}"

  return 0
}

clone_source() {
  remote_need git

  workdir="$(mktemp -d /tmp/dollhouse-hosted.XXXXXX)"
  remote_log "cloning $(remote_redact_url "${git_url}") (${git_ref}) to ${workdir}"
  git clone --depth 1 --branch "${git_ref}" "${git_url}" "${workdir}" || \
    remote_die "failed to clone $(remote_redact_url "${git_url}") at ${git_ref}"

  return 0
}

run_hosted_helper() {
  local helper_env=()

  cd "${workdir}"
  remote_log "running hosted helper action: ${action}"
  helper_env+=("DOLLHOUSE_HOSTED_DEPLOY_DIR=${deploy_dir}")
  [[ -z "${instance_name}" ]] || helper_env+=("DOLLHOUSE_HOSTED_INSTANCE_NAME=${instance_name}")
  [[ -z "${hostname}" ]] || helper_env+=("DOLLHOUSE_HOSTED_HOSTNAME=${hostname}")
  [[ -z "${public_base_url}" ]] || helper_env+=("DOLLHOUSE_PUBLIC_BASE_URL=${public_base_url}")
  helper_env+=("DOLLHOUSE_HOSTED_SOURCE_DIR=${workdir}")
  helper_env+=("DOLLHOUSE_HOSTED_GIT_URL=${git_url}")
  helper_env+=("DOLLHOUSE_HOSTED_GIT_REF=${git_ref}")
  helper_env+=("DOLLHOUSE_HOSTED_LOG_LEVEL=${log_level}")
  [[ -z "${mcp_port}" ]] || helper_env+=("DOLLHOUSE_HTTP_PORT=${mcp_port}")
  [[ -z "${image_tag}" ]] || helper_env+=("DOLLHOUSE_HOSTED_IMAGE_TAG=${image_tag}")
  [[ -z "${mem_limit}" ]] || helper_env+=("DOLLHOUSE_HOSTED_MEM_LIMIT=${mem_limit}")
  [[ -z "${cpu_limit}" ]] || helper_env+=("DOLLHOUSE_HOSTED_CPUS=${cpu_limit}")
  [[ -z "${import_legacy_env}" ]] || helper_env+=("DOLLHOUSE_HOSTED_IMPORT_LEGACY_ENV=${import_legacy_env}")
  [[ -z "${postgres_ready_timeout}" ]] || helper_env+=("DOLLHOUSE_HOSTED_POSTGRES_READY_TIMEOUT=${postgres_ready_timeout}")
  [[ -z "${verify_ready_timeout}" ]] || helper_env+=("DOLLHOUSE_HOSTED_VERIFY_READY_TIMEOUT=${verify_ready_timeout}")
  [[ -z "${allowed_hosts}" ]] || helper_env+=("DOLLHOUSE_HTTP_ALLOWED_HOSTS=${allowed_hosts}")
  [[ -z "${trusted_proxies}" ]] || helper_env+=("DOLLHOUSE_TRUSTED_PROXIES=${trusted_proxies}")
  [[ -z "${bootstrap_github_username}" ]] || helper_env+=("DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME=${bootstrap_github_username}")
  [[ -z "${bootstrap_github_id}" ]] || helper_env+=("DOLLHOUSE_BOOTSTRAP_GITHUB_ID=${bootstrap_github_id}")
  [[ -z "${deploy_mode}" ]] || helper_env+=("DOLLHOUSE_HOSTED_MODE=${deploy_mode}")
  [[ -z "${proxy_mode}" ]] || helper_env+=("DOLLHOUSE_HOSTED_PROXY_MODE=${proxy_mode}")
  [[ -z "${bind_address}" ]] || helper_env+=("DOLLHOUSE_HOSTED_BIND_ADDRESS=${bind_address}")
  [[ -z "${http_bind_port}" ]] || helper_env+=("DOLLHOUSE_HOSTED_HTTP_BIND_PORT=${http_bind_port}")
  [[ -z "${https_bind_port}" ]] || helper_env+=("DOLLHOUSE_HOSTED_HTTPS_BIND_PORT=${https_bind_port}")
  [[ -z "${auth_provider}" ]] || helper_env+=("DOLLHOUSE_AUTH_PROVIDER=${auth_provider}")
  [[ -z "${auth_methods}" ]] || helper_env+=("DOLLHOUSE_AUTH_METHODS=${auth_methods}")
  [[ -z "${auth_open_dcr}" ]] || helper_env+=("DOLLHOUSE_AUTH_OPEN_DCR=${auth_open_dcr}")
  [[ -z "${auth_allowlist_required}" ]] || helper_env+=("DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED=${auth_allowlist_required}")
  [[ -z "${auth_issuer}" ]] || helper_env+=("DOLLHOUSE_AUTH_ISSUER=${auth_issuer}")
  [[ -z "${auth_audience}" ]] || helper_env+=("DOLLHOUSE_AUTH_AUDIENCE=${auth_audience}")
  [[ -z "${auth_jwks_uri}" ]] || helper_env+=("DOLLHOUSE_AUTH_JWKS_URI=${auth_jwks_uri}")
  [[ -z "${auth_oidc_require_typ}" ]] || helper_env+=("DOLLHOUSE_AUTH_OIDC_REQUIRE_TYP=${auth_oidc_require_typ}")
  [[ -z "${auth_allowlist_seed_file}" ]] || helper_env+=("DOLLHOUSE_AUTH_ALLOWLIST_SEED_FILE=${auth_allowlist_seed_file}")
  (
    unset DOLLHOUSE_HOSTED_INSTANCE_NAME
    unset DOLLHOUSE_HOSTED_HOSTNAME
    unset DOLLHOUSE_PUBLIC_BASE_URL
    unset DOLLHOUSE_HOSTED_MODE
    unset DOLLHOUSE_HOSTED_PROXY_MODE
    unset DOLLHOUSE_HOSTED_BIND_ADDRESS
    unset DOLLHOUSE_HOSTED_HTTP_BIND_PORT
    unset DOLLHOUSE_HOSTED_HTTPS_BIND_PORT
    unset DOLLHOUSE_HTTP_PORT
    unset DOLLHOUSE_HOSTED_IMAGE_TAG
    unset DOLLHOUSE_HOSTED_MEM_LIMIT
    unset DOLLHOUSE_HOSTED_CPUS
    unset DOLLHOUSE_HOSTED_IMPORT_LEGACY_ENV
    unset DOLLHOUSE_HOSTED_POSTGRES_READY_TIMEOUT
    unset DOLLHOUSE_HOSTED_VERIFY_READY_TIMEOUT
    unset DOLLHOUSE_HTTP_ALLOWED_HOSTS
    unset DOLLHOUSE_TRUSTED_PROXIES
    unset DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME
    unset DOLLHOUSE_BOOTSTRAP_GITHUB_ID
    unset DOLLHOUSE_AUTH_PROVIDER
    unset DOLLHOUSE_AUTH_METHODS
    unset DOLLHOUSE_AUTH_OPEN_DCR
    unset DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED
    unset DOLLHOUSE_AUTH_ISSUER
    unset DOLLHOUSE_AUTH_AUDIENCE
    unset DOLLHOUSE_AUTH_JWKS_URI
    unset DOLLHOUSE_AUTH_OIDC_REQUIRE_TYP
    unset DOLLHOUSE_AUTH_ALLOWLIST_SEED_FILE
    env "${helper_env[@]}" bash scripts/hosted-deploy.sh "${action}"
  )

  return 0
}

print_remote_summary() {
  local portfolio_files portfolio_kib summary_instance_name

  if [[ -f "${deploy_dir}/DEPLOYED_REVISION" ]]; then
    remote_log "deployed revision: $(cat "${deploy_dir}/DEPLOYED_REVISION")"
  fi
  if [[ -f "${deploy_dir}/DEPLOYED_AT" ]]; then
    remote_log "deployed at: $(cat "${deploy_dir}/DEPLOYED_AT")"
  fi
  if [[ -d "${deploy_dir}/portfolio" ]]; then
    portfolio_files="$(find "${deploy_dir}/portfolio" -type f | wc -l | tr -d ' ')"
    portfolio_kib="$(du -sk "${deploy_dir}/portfolio" | awk '{ print $1 }')"
    remote_log "portfolio: ${portfolio_files} file(s), ${portfolio_kib} KiB"
  fi
  if command -v docker >/dev/null 2>&1; then
    summary_instance_name="$(remote_env_file_value DOLLHOUSE_HOSTED_INSTANCE_NAME)"
    [[ -n "${summary_instance_name}" ]] || summary_instance_name="${instance_name}"
    if [[ -n "${summary_instance_name}" ]]; then
      docker ps --format '[hosted-remote] container: {{.Names}} {{.Status}}' | grep -F "${summary_instance_name}" || true
    else
      docker ps --format '[hosted-remote] container: {{.Names}} {{.Status}}' | grep 'dollhousemcp' || true
    fi
  fi

  return 0
}

print_effective_public_base_url() {
  local effective_public_base_url

  effective_public_base_url="$(remote_env_file_value DOLLHOUSE_PUBLIC_BASE_URL)"
  [[ -n "${effective_public_base_url}" ]] || effective_public_base_url="${public_base_url}"
  [[ -n "${effective_public_base_url}" ]] || return 0
  printf '[hosted-remote] effective public URL: %s\n' "${effective_public_base_url}"

  return 0
}

remote_need docker
docker compose version >/dev/null 2>&1 || remote_die "Docker Compose is required on the remote host"
backup_existing_deploy
clone_source
run_hosted_helper
print_effective_public_base_url
print_remote_summary
REMOTE_PAYLOAD

bash "${remote_payload}" "$@"
REMOTE_BOOTSTRAP
  } | tee "${remote_output}"; then
    rm -f "${remote_output}"
    return 1
  fi
  adopt_remote_public_base_url "${remote_output}"
  rm -f "${remote_output}"

  return 0
}

verify_public_endpoint() {
  local status

  if [[ "${SKIP_LOCAL_VERIFY}" == "true" ]]; then
    log "local public endpoint verification skipped"
    return 0
  fi

  need_command curl
  log "checking ${PUBLIC_BASE_URL}/healthz from this machine"
  curl -fsS "${PUBLIC_BASE_URL}/healthz" >/dev/null
  log "checking ${PUBLIC_BASE_URL}/readyz from this machine"
  curl -fsS "${PUBLIC_BASE_URL}/readyz" >/dev/null
  log "checking unauthenticated ${PUBLIC_BASE_URL}/mcp from this machine"
  status="$(curl -sS -o /dev/null -w '%{http_code}' "${PUBLIC_BASE_URL}/mcp")"
  [[ "${status}" == "401" ]] || die "expected /mcp to return 401 without a bearer token, got ${status}"
  log "remote deployment wrapper verification passed"

  return 0
}

main() {
  parse_args "$@"
  validate_config
  debug "action=${ACTION} target=${REMOTE_SSH_TARGET} ref=${GIT_REF} deploy_dir=${DEPLOY_DIR} instance=${INSTANCE_NAME}"
  if [[ "${DRY_RUN}" == "true" ]]; then
    run_dry_plan
  elif [[ "${ACTION}" == "enroll-host" ]]; then
    run_enroll_host
  else
    need_command ssh
    run_remote_action
    verify_public_endpoint
  fi

  return 0
}

main "$@"
