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
HOSTNAME="${DOLLHOUSE_HOSTED_HOSTNAME:-}"
PUBLIC_BASE_URL="${DOLLHOUSE_PUBLIC_BASE_URL:-}"
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

validate_git_url_for_clone() {
  validate_bool DOLLHOUSE_HOSTED_ALLOW_CREDENTIAL_GIT_URL "${ALLOW_CREDENTIAL_GIT_URL}"
  if git_url_has_credentials "${GIT_URL}" && [[ "${ALLOW_CREDENTIAL_GIT_URL}" != "true" ]]; then
    die "DOLLHOUSE_HOSTED_GIT_URL must not embed credentials; use a git credential helper or deploy key on the remote host instead"
  fi

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
        shift
        ;;
      --public-base-url)
        PUBLIC_BASE_URL="${1:-}"
        [[ -n "${PUBLIC_BASE_URL}" ]] || die "--public-base-url requires a URL"
        shift
        ;;
      --deploy-dir)
        DEPLOY_DIR="${1:-}"
        [[ -n "${DEPLOY_DIR}" ]] || die "--deploy-dir requires a directory"
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
  if [[ -n "${PUBLIC_BASE_URL}" ]]; then
    return 0
  fi
  [[ -n "${HOSTNAME}" ]] || die "set --hostname, DOLLHOUSE_HOSTED_HOSTNAME, or DOLLHOUSE_PUBLIC_BASE_URL"
  PUBLIC_BASE_URL="https://${HOSTNAME}"

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
  log "dry-run: action=${ACTION} deploy_dir=${DEPLOY_DIR} hostname=${HOSTNAME} ref=${GIT_REF}"
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

  while IFS= read -r -d '' ssh_arg; do
    ssh_command+=("${ssh_arg}")
  done < <(ssh_args)

  log "connecting to ${REMOTE_SSH_TARGET}"
  ssh "${ssh_command[@]}" "${REMOTE_SSH_TARGET}" bash -s -- \
    "${ACTION}" \
    "${DEPLOY_DIR}" \
    "${HOSTNAME}" \
    "${PUBLIC_BASE_URL}" \
    "${GIT_URL}" \
    "${GIT_REF}" \
    "${LOG_LEVEL}" \
    "${SKIP_BACKUP}" \
    "${KEEP_WORKDIR}" \
    "${BACKUP_RETRIES}" \
    "${BACKUP_RETRY_DELAY}" <<'REMOTE_BOOTSTRAP'
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
  cd "${workdir}"
  remote_log "running hosted helper action: ${action}"
  DOLLHOUSE_HOSTED_DEPLOY_DIR="${deploy_dir}" \
  DOLLHOUSE_HOSTED_HOSTNAME="${hostname}" \
  DOLLHOUSE_PUBLIC_BASE_URL="${public_base_url}" \
  DOLLHOUSE_HOSTED_SOURCE_DIR="${workdir}" \
  DOLLHOUSE_HOSTED_GIT_URL="${git_url}" \
  DOLLHOUSE_HOSTED_GIT_REF="${git_ref}" \
  DOLLHOUSE_HOSTED_LOG_LEVEL="${log_level}" \
    bash scripts/hosted-deploy.sh "${action}"

  return 0
}

print_remote_summary() {
  local portfolio_files portfolio_kib

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
    docker ps --format '[hosted-remote] container: {{.Names}} {{.Status}}' | grep 'dollhousemcp' || true
  fi

  return 0
}

remote_need docker
docker compose version >/dev/null 2>&1 || remote_die "Docker Compose is required on the remote host"
backup_existing_deploy
clone_source
run_hosted_helper
print_remote_summary
REMOTE_PAYLOAD

bash "${remote_payload}" "$@"
REMOTE_BOOTSTRAP

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
  debug "action=${ACTION} target=${REMOTE_SSH_TARGET} ref=${GIT_REF} deploy_dir=${DEPLOY_DIR}"
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
