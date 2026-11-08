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
  HOSTED_DEPLOY_LIB_DIR="${REPO_ROOT}/scripts/hosted-deploy"
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
  resolve_public_base_url() { :; }
  resolve_hostname() { :; }
  resolve_allowed_hosts() { :; }
  validate_render_inputs() { :; }
  validate_persisted_caddy_fields() { :; }
  resolve_mode_defaults() { :; }
  validate_caddy_selection() { :; }
  acquire_caddy_deployment_lock() { :; }
  CADDY_IMAGE=fixture CADDY_DATA_VOLUME=fixture_data CADDY_CONFIG_VOLUME=fixture_config
  verify_prepared_caddy() {
    printf 'prepared-clone\n' >> "${EVENTS}"
    [[ "${MODE}" != clone-refusal ]] || return 1
    PREVIOUS_BUNDLE="${DEPLOY_DIR}/server.prev-fixture"
  }
  CADDY_CONTAINER_NAME=fixture-caddy HOSTED_CADDY_LOCK_FD=9
  caddy_transition() {
    local action="$1"
    case "${action}" in
      status) if [[ "${MODE}" == fresh-retry ]]; then printf 'fresh\n'; else printf 'none\n'; fi ;;
      begin-update|begin-fresh|begin-rollback) printf 'transition-pending\n' >> "${EVENTS}"; printf '%032d\n' 0 ;;
      retry-fresh) printf 'transition-retry\n' >> "${EVENTS}"; printf '%032d\n' 0 ;;
      retain-unstarted) mv "${SERVER_DIR}" "${DEPLOY_DIR}/server.unstarted-fixture" ;;
      select-rollback) printf '%s/server.prev-20000101\n' "${DEPLOY_DIR}" ;;
      stage) printf 'transition-staged\n' >> "${EVENTS}" ;;
      bind-admission) printf 'admission-bound\n' >> "${EVENTS}" ;;
      *) die "unexpected transition action: ${action}" ;;
    esac
  }
  caddy_unchanged_request_json() { printf '{}\n'; }
  caddy_recovery_request_json() { printf '{}\n'; }
  python3() {
    local command_path="$1"
    if [[ "${command_path}" == */caddy_unchanged_action.py ]]; then
      cat >/dev/null
      printf 'prepared-clone\n' >> "${EVENTS}"
      printf '%s\n' "${DEPLOY_DIR}/server.prev-fixture"
    elif [[ "${command_path}" == */caddy_verify_noop_action.py ]]; then
      cat >/dev/null
      printf 'hardened-recheck\n' >> "${EVENTS}"
    else
      command python3 "$@"
    fi
  }
  recover_selected_caddy() {
    printf 'proxy-recovery\n' >> "${EVENTS}"
    [[ "${MODE}" != recovery-failure ]] || return 1
    printf '{"restored_id":"%064d","preserved_replacement_id":"%064d"}\n' 1 2
  }
  refresh_caddy_image() { compose pull caddy; }
  prepare_fresh_caddy_volumes() { printf 'fresh-volumes\n' >> "${EVENTS}"; }
  recheck_caddy_image() { printf 'caddy-rechecked\n' >> "${EVENTS}"; }
  recheck_caddy_transition() { printf 'caddy-transition-rechecked\n' >> "${EVENTS}"; }
  render_files() { printf 'render\n' >> "${EVENTS}"; }
  sleep() { :; }
  stage_from_source_dir() {
    local incoming="$1"
    printf 'new\n' > "${incoming}/version"
    printf 'new-revision\n'
  }
  selected_postgres() {
    if [[ "${MODE}" == missing-pg || "${MODE}" == fresh-install || "${MODE}" == fresh-retry ]]; then
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
    [[ -f "${DEPLOY_DIR}/stopped" || "${MODE}" == fresh-install || "${MODE}" == fresh-retry ]] || die "replacement without drain"
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
    local operation="$1"
    printf 'compose:%s\n' "$*" >> "${EVENTS}"
    case "${operation}" in
      ps)
        local service="$3"
        if [[ "${service}" == postgres ]]; then selected_postgres
        elif [[ "${MODE}" != fresh-install && "${MODE}" != fresh-retry ]]; then printf '%s\n' "${APP_ID}"
        fi
        ;;
      build) [[ "${MODE}" != build-failure ]] ;;
      pull) [[ "${MODE}" != pull-failure ]] ;;
      up)
        if [[ "$*" == 'up -d --pull never postgres' ]]; then
          [[ "${MODE}" == fresh-install || "${MODE}" == fresh-retry ]] || die "existing PG recreation"
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
    local operation="$1"
    printf 'docker:%s\n' "$*" >> "${EVENTS}"
    if [[ "${operation}" == inspect ]]; then
      [[ "${MODE}" != inspect-failure ]] || return 1
      local format="$3" inspect_target="$4"
      if [[ "${format}" == '{{.Config.User}}|{{.State.Running}}' ]]; then
        if [[ "${MODE}" == hardened ]]; then printf '1001:1001|true\n'; else printf '|false\n'; fi
      elif [[ "${format}" == '{{.Id}}' ]]; then printf '%s\n' "${inspect_target}"
      elif [[ "${inspect_target}" == "${PG_ID}" && "${MODE}" == stopped-pg ]]; then printf 'false\n'
      else printf 'true\n'
      fi
    elif [[ "${operation}" == image && "${2:-}" == inspect ]]; then
      return 0
    elif [[ "${operation}" == exec ]]; then
      local exec_target="$2"
      [[ "${exec_target}" == "${PG_ID}" ]] || die "unexpected docker operation"
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
TMP_ROOT="$(cd "${TMP_ROOT}" && pwd -P)"
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
  if [[ "${mode}" == fresh-install ]]; then rm -rf "${fixture}/server"; fi
  printf 'SELECT 1;\n' > "${fixture}/grants.sql"
  printf 'old-revision\n' > "${fixture}/DEPLOYED_REVISION"
  printf '2000-01-01T00:00:00Z\n' > "${fixture}/DEPLOYED_AT"
  set +e
  bash "$0" --case "${action}" "${mode}" "${fixture}" "${service}" > "${fixture}/stdout" 2> "${fixture}/stderr"
  status=$?
  set -e
  if [[ "${mode}" == success || "${mode}" == fresh-install || "${mode}" == fresh-retry || "${mode}" == hardened ]]; then
    [[ "${status}" == 0 ]] || fail "${action}/${service}/${mode} exited ${status}"
    if [[ "${mode}" == fresh-retry ]]; then
      assert_order "${fixture}/events" transition-retry render
    else
      assert_order "${fixture}/events" transition-pending render
    fi
    if [[ "${mode}" == hardened ]]; then
      assert_order "${fixture}/events" prepared-clone graceful-stop
      assert_order "${fixture}/events" hardened-recheck graceful-stop
      if grep -q '^compose:pull caddy$' "${fixture}/events"; then fail "unchanged proxy was pulled"; fi
    elif [[ "${action}" == rollback ]]; then
      assert_order "${fixture}/events" proxy-recovery graceful-stop
    else
      assert_order "${fixture}/events" 'compose:pull caddy' graceful-stop
    fi
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
  if [[ "${mode}" != fresh-install && "${mode}" != fresh-retry ]] && grep -q '^compose:up -d --pull never postgres$' "${fixture}/events"; then fail "existing database recreated"; fi
  # Stage/move real bundles: the prior running source is recoverable even when
  # prepared source and image tags differ from the unchanged running image.
  if [[ "${action}" == rollback ]]; then
    prior=("${fixture}"/server.rollback-from-*)
  else
    prior=("${fixture}"/server.prev-*)
    prior=("${prior[@]:1}")
  fi
  if [[ "${mode}" == fresh-retry ]]; then
    [[ "$(cat "${fixture}/server.unstarted-fixture/version")" == current ]] || fail "unstarted source was not retained"
  elif [[ "${mode}" == pull-failure || ( "${action}" == update && "${mode}" == inspect-failure ) ]]; then
    [[ "$(cat "${fixture}/server/version")" == current ]] || fail "preparation failure changed current source"
  elif [[ "${mode}" != fresh-install ]]; then
    [[ "${#prior[@]}" == 1 && "$(cat "${prior[0]}/version")" == current ]] || fail "prior source not recoverable"
  fi
  printf 'preparation-order PASS %s/%s/%s\n' "${action}" "${service}" "${mode}"
}

for action in update rollback; do
  for mode in build-failure readiness-failure drain-refusal missing-pg stopped-pg identity-change inspect-failure success; do
    check_fixture "${action}" "${mode}" app
  done
done
check_fixture update pull-failure app
check_fixture update hardened app
check_fixture update fresh-retry app
for service in app all; do
  for mode in migration-failure bootstrap-failure replacement-failure success fresh-install; do
    check_fixture update "${mode}" "${service}"
  done
done

# Exercise the real root creation and lock validation before any transition.
for mode in fresh-000 fresh-002 existing-unsafe; do
  root="${TMP_ROOT}/${mode}"
  if [[ "${mode}" == existing-unsafe ]]; then mkdir "${root}"; chmod 0777 "${root}"; fi
  mask="${mode#fresh-}"
  [[ "${mode}" != existing-unsafe ]] || mask=077
  if (umask "${mask}"; bash -c '
    source "$1"
    DEPLOY_DIR="$2"; SERVER_DIR="$2/server"
    ensure_prerequisites() { :; }; validate_git_url_for_clone() { :; }
    resolve_public_base_url() { :; }; resolve_hostname() { :; }
    resolve_allowed_hosts() { :; }; validate_render_inputs() { :; }
    need_command() { :; }; flock() { :; }; die() { exit 1; }
    caddy_transition() { return 1; }
    start_or_update
  ' _ "${REPO_ROOT}/scripts/hosted-deploy/runtime.sh" "${root}"); then
    fail "root fixture unexpectedly advanced past transition"
  fi
  if [[ "${mode}" == existing-unsafe ]]; then
    [[ ! -e "${root}/.caddy-deploy.lock" ]] || fail "unsafe existing root was modified"
  else
    [[ -f "${root}/.caddy-deploy.lock" ]] || fail "fresh root did not reach lock"
    python3 -c 'import os,stat,sys; sys.exit(0 if stat.S_IMODE(os.stat(sys.argv[1]).st_mode)==0o700 else 1)' "${root}" || fail "fresh root is not private"
  fi
  printf 'preparation-order PASS root/%s\n' "${mode}"
done
