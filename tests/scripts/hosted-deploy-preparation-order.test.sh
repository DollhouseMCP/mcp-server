#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ "${1:-}" == --case ]]; then
  ACTION="$2"
  MODE="$3"
  DEPLOY_DIR="$4"
  SERVICE="$5"
  SERVER_DIR="${DEPLOY_DIR}/server"
  SOURCE_DIR="${DEPLOY_DIR}/source"
  POST_MIGRATION_GRANTS_FILE="${DEPLOY_DIR}/grants.sql"
  POSTGRES_READY_TIMEOUT=1
  BOOTSTRAP_GITHUB_ID=123
  BOOTSTRAP_GITHUB_USERNAME=""
  EVENTS="${DEPLOY_DIR}/events"
  PG_ID="$(printf 'a%.0s' {1..64})"
  OTHER_PG_ID="$(printf 'b%.0s' {1..64})"
  APP_ID="$(printf 'c%.0s' {1..64})"
  source "${REPO_ROOT}/scripts/hosted-deploy/source.sh"
  source "${REPO_ROOT}/scripts/hosted-deploy/runtime.sh"
  log() { :; }
  warn() { :; }
  die() { printf '%s\n' "$*" >&2; exit 1; }
  ensure_prerequisites() { :; }
  ensure_runtime_prerequisites() { :; }
  validate_git_url_for_clone() { :; }
  render_files() { :; }
  sleep() { :; }
  stage_from_source_dir() {
    local incoming="$1"
    printf 'new\n' > "${incoming}/version"
    printf 'new-revision\n'
  }
  selected_postgres() {
    if [[ "${MODE}" == missing-pg || "${MODE}" == fresh-install ]]; then
      [[ -f "${DEPLOY_DIR}/pg-started" ]] || return 0
    fi
    if [[ -f "${DEPLOY_DIR}/selection-changed" ]]; then
      printf '%s\n' "${OTHER_PG_ID}"
    else
      printf '%s\n' "${PG_ID}"
    fi
  }
  record_replacement() {
    printf 'replacement\n' >> "${EVENTS}"
    [[ -f "${DEPLOY_DIR}/stopped" || "${MODE}" == fresh-install ]] || die "replacement without drain"
    [[ "${MODE}" != replacement-failure ]]
  }
  maintenance_command() {
    if [[ "$*" == *dollhouse-bootstrap-admin* ]]; then
      printf 'bootstrap\n' >> "${EVENTS}"
      [[ "${MODE}" != bootstrap-failure ]]
    else
      printf 'migration\n' >> "${EVENTS}"
      [[ -f "${DEPLOY_DIR}/stopped" ]] || die "migration before drain"
      [[ "${MODE}" != migration-failure ]]
    fi
  }
  compose() {
    printf 'compose:%s\n' "$*" >> "${EVENTS}"
    case "$1" in
      ps)
        if [[ "$3" == postgres ]]; then selected_postgres
        elif [[ "${MODE}" != fresh-install ]]; then printf '%s\n' "${APP_ID}"
        fi
        ;;
      build) [[ "${MODE}" != build-failure ]] ;;
      pull) [[ "${MODE}" != pull-failure ]] ;;
      up)
        if [[ "$*" == 'up -d postgres' ]]; then
          [[ "${MODE}" == fresh-install ]] || die "existing PG recreation"
          touch "${DEPLOY_DIR}/pg-started"
        else record_replacement
        fi
        ;;
      exec) printf 'grants-or-fresh-readiness\n' >> "${EVENTS}" ;;
      run) maintenance_command "$@" ;;
      *) die "unexpected compose operation" ;;
    esac
  }
  docker() {
    printf 'docker:%s\n' "$*" >> "${EVENTS}"
    if [[ "$1" == inspect ]]; then
      [[ "${MODE}" != inspect-failure ]] || return 1
      if [[ "$3" == '{{.Id}}' ]]; then printf '%s\n' "$4"
      elif [[ "$4" == "${PG_ID}" && "${MODE}" == stopped-pg ]]; then printf 'false\n'
      else printf 'true\n'
      fi
    elif [[ "$1" == exec && "$2" == "${PG_ID}" ]]; then
      [[ "${MODE}" != readiness-failure ]] || return 1
      if [[ "${MODE}" == identity-change ]]; then touch "${DEPLOY_DIR}/selection-changed"; fi
    else die "unexpected docker operation"
    fi
  }
  gracefully_stop_existing_app() {
    printf 'graceful-stop\n' >> "${EVENTS}"
    [[ "${MODE}" != drain-refusal ]] || return 1
    touch "${DEPLOY_DIR}/stopped"
  }
  if [[ "${ACTION}" == rollback ]]; then rollback_server
  else start_or_update "${SERVICE}"
  fi
  exit 0
fi

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf -- "${TMP_ROOT}"' EXIT
fail() { printf 'preparation-order test: %s\n' "$*" >&2; exit 1; }
assert_order() {
  local events="$1"
  local first="$2"
  local second="$3"
  local first_line second_line
  first_line="$(grep -nFx "${first}" "${events}" | head -1 | cut -d: -f1)"
  second_line="$(grep -nFx "${second}" "${events}" | head -1 | cut -d: -f1)"
  [[ -n "${first_line}" && -n "${second_line}" && "${first_line}" -lt "${second_line}" ]] || fail "wrong order: ${first}, ${second}"
}
check_fixture() {
  local action="$1"
  local mode="$2"
  local service="$3"
  local fixture
  fixture="$(mktemp -d "${TMP_ROOT}/${action}-${service}-${mode}.XXXXXX")"
  local status expected_revision
  mkdir -p "${fixture}/server" "${fixture}/server.prev-20000101" "${fixture}/source"
  printf 'current\n' > "${fixture}/server/version"
  printf 'previous\n' > "${fixture}/server.prev-20000101/version"
  printf 'SELECT 1;\n' > "${fixture}/grants.sql"
  printf 'old-revision\n' > "${fixture}/DEPLOYED_REVISION"
  printf '2000-01-01T00:00:00Z\n' > "${fixture}/DEPLOYED_AT"
  set +e
  bash "$0" --case "${action}" "${mode}" "${fixture}" "${service}" > "${fixture}/stdout" 2> "${fixture}/stderr"
  status=$?
  set -e
  if [[ "${mode}" == success || "${mode}" == fresh-install ]]; then
    [[ "${status}" == 0 ]] || fail "${action}/${service}/${mode} exited ${status}"
    assert_order "${fixture}/events" 'compose:pull caddy' graceful-stop
    assert_order "${fixture}/events" graceful-stop replacement
    if [[ "${action}" == rollback ]]; then expected_revision='rollback:server.prev-20000101'
    else expected_revision=new-revision; assert_order "${fixture}/events" graceful-stop migration
    fi
    [[ "$(cat "${fixture}/DEPLOYED_REVISION")" == "${expected_revision}" ]] || fail "successful marker missing"
  else
    [[ "${status}" != 0 ]] || fail "${action}/${service}/${mode} unexpectedly passed"
    [[ "$(cat "${fixture}/DEPLOYED_REVISION")" == old-revision ]] || fail "failed operation changed deployed revision"
    [[ "$(cat "${fixture}/DEPLOYED_AT")" == '2000-01-01T00:00:00Z' ]] || fail "failed operation changed deployed time"
    case "${mode}" in
      migration-failure|bootstrap-failure|replacement-failure) [[ -f "${fixture}/stopped" ]] || fail "missing strict drain" ;;
      drain-refusal) grep -q '^graceful-stop$' "${fixture}/events" || fail "missing refusal" ;;
      *) if grep -q '^graceful-stop$' "${fixture}/events"; then fail "healthy app stopped on preparation failure"; fi ;;
    esac
    if [[ "${mode}" != replacement-failure ]] && grep -q '^replacement$' "${fixture}/events"; then fail "replacement after failure"; fi
  fi
  if [[ "${mode}" != fresh-install ]] && grep -q '^compose:up -d postgres$' "${fixture}/events"; then fail "existing database recreated"; fi
  # Stage/move real bundles: the prior running source is recoverable even when
  # prepared source and image tags differ from the unchanged running image.
  if [[ "${action}" == rollback ]]; then
    prior=("${fixture}"/server.rollback-from-*)
  else
    prior=("${fixture}"/server.prev-*)
    prior=("${prior[@]:1}")
  fi
  [[ "${#prior[@]}" == 1 && "$(cat "${prior[0]}/version")" == current ]] || fail "prior source not recoverable"
  printf 'preparation-order PASS %s/%s/%s\n' "${action}" "${service}" "${mode}"
}

for action in update rollback; do
  for mode in build-failure readiness-failure pull-failure drain-refusal missing-pg stopped-pg identity-change inspect-failure success; do
    check_fixture "${action}" "${mode}" app
  done
done
for service in app all; do
  for mode in migration-failure bootstrap-failure replacement-failure success fresh-install; do
    check_fixture update "${mode}" "${service}"
  done
done
