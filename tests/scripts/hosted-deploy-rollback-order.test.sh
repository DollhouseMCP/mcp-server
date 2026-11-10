#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ "${1:-}" == "--case" ]]; then
  MODE="$2"
  DEPLOY_DIR="$3"
  SERVER_DIR="${DEPLOY_DIR}/server"
  EVENTS="${DEPLOY_DIR}/events"
  source "${REPO_ROOT}/scripts/hosted-deploy/source.sh"
  source "${REPO_ROOT}/scripts/hosted-deploy/runtime.sh"
  source "${REPO_ROOT}/scripts/hosted-deploy/render.sh"

  log() { :; }
  die() { printf '%s\n' "$*" >&2; exit 1; }
  ensure_runtime_prerequisites() { :; }
  render_files() {
    if [[ "${MODE}" == noop-* ]]; then
      CADDY_FILE="${DEPLOY_DIR}/Caddyfile"
      caddyfile_content() { printf '%s\n' "${REQUESTED_CONFIG}"; }
      require_safe_caddyfile_change
    fi
  }
  validate_persisted_caddy_fields() { :; }
  resolve_mode_defaults() { :; }
  validate_caddy_selection() { :; }
  validate_registry_selection() { :; }
  acquire_caddy_deployment_lock() { :; }
  IMAGE_MODE=build
  [[ "${MODE}" != registry-refusal ]] || IMAGE_MODE=registry
  CADDY_IMAGE=fixture CADDY_DATA_VOLUME=fixture_data CADDY_CONFIG_VOLUME=fixture_config
  caddy_transition() {
    local action="$1"
    case "${action}" in
      select-rollback) printf '%s/server.prev-20000101\n' "${DEPLOY_DIR}" ;;
      begin-rollback) printf '%032d\n' 0 ;;
      stage) : ;;
      *) die "unexpected transition action: ${action}" ;;
    esac
  }
  recover_selected_caddy() {
    local previous="$1"
    printf 'proxy-recovery:%s\n' "$(basename "${previous}")" >> "${EVENTS}"
    [[ "${MODE}" != "recovery-failure" ]] || return 1
    if [[ "${MODE}" == invalid-result ]]; then
      printf '{"outcome":"unexpected"}\n'
    elif [[ "${MODE}" == noop-* ]]; then
      printf '{"outcome":"unchanged"}\n'
    else
      printf '{"restored_id":"%064d","preserved_replacement_id":"%064d"}\n' 1 2
    fi
  }
  # Real moves exercise bundle restoration on failed promotion.
  mv() {
    local source_path="$1"
    printf 'move:%s\n' "$(basename "${source_path}")" >> "${EVENTS}"
    if [[ "${MODE}" == "promotion-failure" && "${source_path}" == *server.prev-* ]]; then
      return 1
    fi
    command mv "$@"
  }
  compose() {
    printf 'compose:%s\n' "$*" >> "${EVENTS}"
    case "$1" in
      build)
        [[ "$*" == "build dollhousemcp" ]]
        [[ "$(cat "${SERVER_DIR}/version")" == "previous" ]]
        ! grep -q 'AS migration' "${SERVER_DIR}/docker/Dockerfile"
        [[ "${MODE}" != "build-failure" ]]
        ;;
      pull) [[ "${MODE}" != "pull-failure" ]] ;;
      up) printf 'replacement\n' >> "${EVENTS}" ;;
      *) die "unexpected compose command" ;;
    esac
  }
  prepare_postgres_before_app_stop() {
    printf 'postgres-ready\n' >> "${EVENTS}"
    [[ "${MODE}" != "readiness-failure" ]]
  }
  gracefully_stop_existing_app() {
    printf 'graceful-stop\n' >> "${EVENTS}"
    [[ "${MODE}" != "drain-refusal" ]]
  }
  rollback_server
  exit 0
fi

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf -- "${TMP_ROOT}"' EXIT

fail() { printf 'rollback-order test: %s\n' "$*" >&2; exit 1; }

for mode in registry-refusal recovery-failure promotion-failure build-failure readiness-failure drain-refusal success noop-same noop-changed invalid-result; do
  fixture="${TMP_ROOT}/${mode}"
  mkdir -p "${fixture}/server" "${fixture}/server.prev-20000101"
  printf 'current\n' > "${fixture}/server/version"
  printf 'previous\n' > "${fixture}/server.prev-20000101/version"
  mkdir -p "${fixture}/server.prev-20000101/docker"
  printf 'FROM node AS builder\nFROM builder AS production\n' > "${fixture}/server.prev-20000101/docker/Dockerfile"
  printf 'fixture-config\n' > "${fixture}/Caddyfile"
  : > "${fixture}/events"
  printf 'current-revision\n' > "${fixture}/DEPLOYED_REVISION"
  printf '2000-01-01T00:00:00Z\n' > "${fixture}/DEPLOYED_AT"
  set +e
  if [[ "${mode}" == noop-changed ]]; then requested=changed; else requested=fixture-config; fi
  REQUESTED_CONFIG="${requested}" bash "$0" --case "${mode}" "${fixture}" > "${fixture}/stdout" 2> "${fixture}/stderr"
  status=$?
  set -e
  if [[ "${mode}" == "success" || "${mode}" == "noop-same" ]]; then
    [[ "${status}" == 0 ]] || fail "success exited ${status}"
    # Compare the whole sequence, including the chosen source and image build.
    expected=$'proxy-recovery:server.prev-20000101\nmove:server\nmove:server.prev-20000101\ncompose:build dollhousemcp\npostgres-ready\ngraceful-stop\ncompose:up -d --pull never --no-build --no-deps --force-recreate dollhousemcp\nreplacement'
    [[ "$(cat "${fixture}/events")" == "${expected}" ]] || fail "unexpected replacement order"
    [[ "$(cat "${fixture}/DEPLOYED_REVISION")" == "rollback:server.prev-20000101" ]] || fail "successful replacement marker missing"
    [[ "$(cat "${fixture}/DEPLOYED_AT")" != "2000-01-01T00:00:00Z" ]] || fail "successful replacement timestamp missing"
  else
    [[ "${status}" != 0 ]] || fail "${mode} unexpectedly succeeded"
    [[ "$(cat "${fixture}/DEPLOYED_REVISION")" == "current-revision" ]] || fail "failed rollback changed deployed revision"
    [[ "$(cat "${fixture}/DEPLOYED_AT")" == "2000-01-01T00:00:00Z" ]] || fail "failed rollback changed deployed timestamp"
    if grep -q '^replacement$' "${fixture}/events"; then fail "replacement after ${mode}"; fi
    if [[ "${mode}" == "drain-refusal" ]]; then
      grep -q '^graceful-stop$' "${fixture}/events" || fail "drain refusal not reached"
    elif grep -q '^graceful-stop$' "${fixture}/events"; then
      fail "healthy app stopped before ${mode}"
    fi
  fi
  if [[ "${mode}" == "registry-refusal" ]]; then
    [[ ! -s "${fixture}/events" ]] || fail "registry refusal occurred after mutation"
  fi
  if [[ "${mode}" == "registry-refusal" || "${mode}" == "promotion-failure" || "${mode}" == "recovery-failure" || "${mode}" == "noop-changed" || "${mode}" == "invalid-result" ]]; then
    [[ "$(cat "${fixture}/server/version")" == "current" ]] || fail "failed promotion lost current bundle"
    [[ "$(cat "${fixture}/server.prev-20000101/version")" == "previous" ]] || fail "failed promotion lost previous bundle"
  else
    [[ "$(cat "${fixture}/server/version")" == "previous" ]] || fail "wrong selected rollback source"
    backups=("${fixture}"/server.rollback-from-*)
    [[ "${#backups[@]}" == 1 && "$(cat "${backups[0]}/version")" == "current" ]] || fail "current bundle not retained"
  fi
  printf 'rollback-order PASS %s\n' "${mode}"
done
