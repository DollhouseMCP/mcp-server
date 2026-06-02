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
DEPLOY_DIR="${DOLLHOUSE_HOSTED_DEPLOY_DIR:-/opt/dollhousemcp}"
HOSTNAME="${DOLLHOUSE_HOSTED_HOSTNAME:-}"
PUBLIC_BASE_URL="${DOLLHOUSE_PUBLIC_BASE_URL:-}"
GIT_URL="${DOLLHOUSE_HOSTED_GIT_URL:-https://github.com/DollhouseMCP/mcp-server.git}"
GIT_REF="${DOLLHOUSE_HOSTED_GIT_REF:-codex/hosted-http-integration}"
LOG_LEVEL="${DOLLHOUSE_HOSTED_LOG_LEVEL:-info}"
SKIP_BACKUP="${DOLLHOUSE_REMOTE_SKIP_BACKUP:-false}"
SKIP_LOCAL_VERIFY="${DOLLHOUSE_REMOTE_SKIP_LOCAL_VERIFY:-false}"
KEEP_WORKDIR="${DOLLHOUSE_REMOTE_KEEP_WORKDIR:-false}"
DRY_RUN="${DOLLHOUSE_REMOTE_DRY_RUN:-false}"

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

Options:
  --target USER@HOST        SSH target. Env: DOLLHOUSE_REMOTE_SSH_TARGET
  --identity-file PATH      SSH identity file. Env: DOLLHOUSE_REMOTE_SSH_IDENTITY_FILE
  --hostname HOSTNAME       Public hostname. Env: DOLLHOUSE_HOSTED_HOSTNAME
  --public-base-url URL     Public origin. Env: DOLLHOUSE_PUBLIC_BASE_URL
  --deploy-dir DIR          Remote deploy dir. Env: DOLLHOUSE_HOSTED_DEPLOY_DIR
  --git-url URL             Repository URL cloned remotely. Env: DOLLHOUSE_HOSTED_GIT_URL
  --ref REF                 Branch/ref cloned remotely. Env: DOLLHOUSE_HOSTED_GIT_REF
  --skip-backup             Skip DB/env backup before remote action
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
    install|update|migrate|bootstrap-admin|rollback|verify)
      ;;
    *)
      die "unknown action: ${ACTION}"
      ;;
  esac

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
  [[ -n "${REMOTE_SSH_TARGET}" ]] || die "set --target or DOLLHOUSE_REMOTE_SSH_TARGET"
  [[ "${REMOTE_SSH_TARGET}" != *[[:space:]]* ]] || die "SSH target must not contain whitespace"
  [[ -z "${REMOTE_SSH_IDENTITY_FILE}" || -f "${REMOTE_SSH_IDENTITY_FILE}" ]] || \
    die "SSH identity file does not exist: ${REMOTE_SSH_IDENTITY_FILE}"
  resolve_public_base_url
  resolve_hostname

  return 0
}

ssh_args() {
  if [[ -n "${REMOTE_SSH_IDENTITY_FILE}" ]]; then
    printf '%s\0%s\0%s\0%s\0' -i "${REMOTE_SSH_IDENTITY_FILE}" -o IdentitiesOnly=yes
  fi
  printf '%s\0%s\0' -o StrictHostKeyChecking=accept-new

  return 0
}

run_dry_plan() {
  log "dry-run: would connect to ${REMOTE_SSH_TARGET}"
  log "dry-run: action=${ACTION} deploy_dir=${DEPLOY_DIR} hostname=${HOSTNAME} ref=${GIT_REF}"
  if [[ "${SKIP_BACKUP}" == "true" ]]; then
    log "dry-run: would skip remote DB/env backups"
  else
    log "dry-run: would create remote DB/env backups when an existing deployment is present"
  fi
  log "dry-run: would clone ${GIT_URL} at ${GIT_REF} on the remote host"
  log "dry-run: would run scripts/hosted-deploy.sh ${ACTION} on the remote host"
  if [[ "${SKIP_LOCAL_VERIFY}" == "true" ]]; then
    log "dry-run: would skip local public endpoint checks"
  else
    log "dry-run: would check ${PUBLIC_BASE_URL}/healthz, /readyz, and unauthenticated /mcp"
  fi

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
    "${KEEP_WORKDIR}" <<'REMOTE_BOOTSTRAP'
set -euo pipefail

remote_payload="$(mktemp /tmp/dollhouse-remote-wrapper.XXXXXX.sh)"
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

  return 0
}

backup_env_files() {
  local stamp="$1"
  local file backup_name

  for file in .env .env.production; do
    if [[ -f "${deploy_dir}/${file}" ]]; then
      backup_name="${deploy_dir}/backups/${file#.}.pre-remote-${action}-${stamp}"
      cp "${deploy_dir}/${file}" "${backup_name}"
      chmod 0600 "${backup_name}"
      remote_log "backed up ${file} to ${backup_name}"
    fi
  done

  return 0
}

backup_database() {
  local stamp="$1"
  local backup_file

  if [[ ! -f "${deploy_dir}/compose.yml" || ! -f "${deploy_dir}/.env.production" ]]; then
    remote_log "no compose.yml/.env.production pair found; skipping database backup"
    return 0
  fi

  if ! remote_compose exec -T postgres pg_isready -U dollhouse -d dollhousemcp >/dev/null 2>&1; then
    case "${action}" in
      update|migrate|rollback)
        remote_die "postgres is not ready for pre-${action} backup; set DOLLHOUSE_REMOTE_SKIP_BACKUP=true only if you have a separate backup"
        ;;
      *)
        remote_warn "postgres is not ready; skipping database backup"
        return 0
        ;;
    esac
  fi

  backup_file="${deploy_dir}/backups/pre-remote-${action}-${stamp}.sql"
  remote_log "creating database backup ${backup_file}"
  remote_compose exec -T postgres pg_dump -U dollhouse dollhousemcp > "${backup_file}" || \
    remote_die "failed to create database backup ${backup_file}"
  chmod 0600 "${backup_file}"

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
  mkdir -p "${deploy_dir}/backups"
  chmod 0750 "${deploy_dir}/backups"
  backup_env_files "${stamp}"
  backup_database "${stamp}"

  return 0
}

clone_source() {
  remote_need git

  workdir="$(mktemp -d /tmp/dollhouse-hosted.XXXXXX)"
  remote_log "cloning ${git_url} (${git_ref}) to ${workdir}"
  git clone --depth 1 --branch "${git_ref}" "${git_url}" "${workdir}" || \
    remote_die "failed to clone ${git_url} at ${git_ref}"

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
  else
    need_command ssh
    run_remote_action
    verify_public_endpoint
  fi

  return 0
}

main "$@"
