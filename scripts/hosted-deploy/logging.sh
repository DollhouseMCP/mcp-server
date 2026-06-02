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

  return 0
}

log() {
  if [[ "${LOG_LEVEL}" == "quiet" ]]; then
    return 0
  fi
  printf '[hosted-deploy] %s\n' "$*"

  return 0
}

debug() {
  if [[ "${LOG_LEVEL}" != "debug" ]]; then
    return 0
  fi
  printf '[hosted-deploy] debug: %s\n' "$*" >&2

  return 0
}

warn() {
  printf '[hosted-deploy] warning: %s\n' "$*" >&2

  return 0
}

die() {
  printf '[hosted-deploy] error: %s\n' "$*" >&2
  exit 1
  # shellcheck disable=SC2317
  return 1
}
