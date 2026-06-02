# shellcheck shell=bash
# Logging helpers for hosted-deploy.

LOG_LEVEL="${DOLLHOUSE_HOSTED_LOG_LEVEL:-info}"

validate_log_level() {
  case "${LOG_LEVEL}" in
    quiet|info|debug)
      ;;
    *)
      die "DOLLHOUSE_HOSTED_LOG_LEVEL must be quiet, info, or debug; got: ${LOG_LEVEL}"
      ;;
  esac
}

log() {
  if [[ "${LOG_LEVEL}" == "quiet" ]]; then
    return
  fi
  printf '[hosted-deploy] %s\n' "$*"
}

debug() {
  if [[ "${LOG_LEVEL}" != "debug" ]]; then
    return
  fi
  printf '[hosted-deploy] debug: %s\n' "$*" >&2
}

warn() {
  printf '[hosted-deploy] warning: %s\n' "$*" >&2
}

die() {
  printf '[hosted-deploy] error: %s\n' "$*" >&2
  exit 1
}
