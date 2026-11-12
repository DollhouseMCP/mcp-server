# shellcheck shell=bash
# Runtime Docker/Compose operations for hosted-deploy.

ensure_docker_prerequisites() {
  need_command docker
  docker compose version >/dev/null 2>&1 || die "Docker Compose is required"

  return 0
}

ensure_supported_python() {
  need_command python3
  python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)' ||
    die "Python 3.11 or newer is required before deployment"
}

ensure_runtime_prerequisites() {
  ensure_supported_python
  ensure_docker_prerequisites
  need_command openssl

  return 0
}

ensure_prerequisites() {
  ensure_runtime_prerequisites
  need_command git
  need_command tar

  return 0
}

compose() {
  local status=0

  (cd "${DEPLOY_DIR}" && docker compose --project-name "${INSTANCE_NAME}" --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@") || status=$?
  return "${status}"
}

ensure_server_source() {
  [[ -d "${SERVER_DIR}" ]] || die "server source not staged at ${SERVER_DIR}; run install or update first"

  return 0
}

validate_postgres_timeout() {
  [[ "${POSTGRES_READY_TIMEOUT}" =~ ^[0-9]+$ ]] || \
    die "DOLLHOUSE_HOSTED_POSTGRES_READY_TIMEOUT must be an integer number of seconds; try 60, 120, or 300"

  return 0
}

validate_verify_timeout() {
  [[ "${VERIFY_READY_TIMEOUT}" =~ ^[0-9]+$ ]] || \
    die "DOLLHOUSE_HOSTED_VERIFY_READY_TIMEOUT must be an integer number of seconds; try 30, 60, or 120"

  return 0
}

wait_for_postgres() {
  validate_postgres_timeout
  log "starting postgres"
  if ! docker image inspect postgres:17-alpine >/dev/null 2>&1; then
    compose pull postgres
  fi
  compose up -d --pull never postgres

  log "waiting for postgres to become ready"
  local elapsed=0
  until compose exec -T postgres pg_isready -U dollhouse -d dollhousemcp >/dev/null 2>&1; do
    if (( elapsed >= POSTGRES_READY_TIMEOUT )); then
      compose ps postgres >&2 || true
      die "postgres did not become ready within ${POSTGRES_READY_TIMEOUT}s"
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  return 0
}

running_service_id() {
  local service="$1"
  local selected immutable_id running
  selected="$(compose ps -q "${service}")" || die "cannot resolve ${service} container"
  [[ -n "${selected}" ]] || return 0
  immutable_id="$(docker inspect --format '{{.Id}}' "${selected}")" || die "cannot inspect ${service} identity"
  running="$(docker inspect --format '{{.State.Running}}' "${immutable_id}")" || die "cannot inspect ${service} running state"
  [[ "${immutable_id}" =~ ^[a-f0-9]{64}$ ]] || die "invalid ${service} container identity"
  [[ "${running}" == true || "${running}" == false ]] || die "invalid ${service} running state"
  [[ "${running}" == true ]] || return 0
  printf '%s\n' "${immutable_id}"
}

wait_for_running_postgres() {
  local immutable_id="$1"
  local elapsed=0 selected_id
  validate_postgres_timeout
  log "waiting for the existing postgres container without recreating it"
  until docker exec "${immutable_id}" pg_isready -U dollhouse -d dollhousemcp >/dev/null 2>&1; do
    if (( elapsed >= POSTGRES_READY_TIMEOUT )); then
      die "existing postgres did not become ready within ${POSTGRES_READY_TIMEOUT}s"
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  selected_id="$(running_service_id postgres)" || die "cannot recheck postgres identity"
  [[ "${selected_id}" == "${immutable_id}" ]] || die "selected postgres identity changed during preparation"
  return 0
}

existing_app_id() {
  local selected immutable_id
  selected="$(compose ps --all -q dollhousemcp)" || die "cannot resolve application container"
  [[ -n "${selected}" ]] || return 0
  immutable_id="$(docker inspect --format '{{.Id}}' "${selected}")" || die "cannot inspect application identity"
  [[ "${immutable_id}" =~ ^[a-f0-9]{64}$ ]] || die "invalid application container identity"
  printf '%s\n' "${immutable_id}"
}

prepare_postgres_before_app_stop() {
  local postgres_id app_id
  postgres_id="$(running_service_id postgres)" || die "cannot resolve running postgres"
  if [[ -n "${postgres_id}" ]]; then
    wait_for_running_postgres "${postgres_id}"
    return 0
  fi
  app_id="$(existing_app_id)" || die "cannot resolve existing application"
  [[ -z "${app_id}" ]] || die "existing application has no running postgres; refusing database recreation"
  # Only an install/recovery with no running application may start PostgreSQL.
  wait_for_postgres
}

require_slim_maintenance_source() {
  local dockerfile="${SERVER_DIR}/docker/Dockerfile"
  local cli="${SERVER_DIR}/src/cli/migrate-database.ts"
  [[ -f "${dockerfile}" && -f "${cli}" ]] && \
    [[ $(grep -Ec '^FROM[[:space:]]+production[[:space:]]+AS[[:space:]]+migration[[:space:]]*$' "${dockerfile}") == 1 ]] || \
    die "this source predates slim maintenance; roll forward to a supported source and render again before migrate or bootstrap-admin"
}

build_app_image() {
  require_slim_maintenance_source
  log "building dollhousemcp image"
  compose build dollhousemcp dollhousemcp-migrate

  return 0
}

prepare_app_images() {
  if [[ "${IMAGE_MODE}" == registry ]]; then
    REGISTRY_ADMISSION="$(python3 "${HOSTED_DEPLOY_LIB_DIR}/registry_image_admission.py" prepare "${RUNTIME_IMAGE}" "${MIGRATION_IMAGE}")" || die "registry image pair preparation failed"
  else
    build_app_image
  fi
}

recheck_registry_images() {
  [[ "${IMAGE_MODE}" == registry ]] || return 0
  local current
  current="$(python3 "${HOSTED_DEPLOY_LIB_DIR}/registry_image_admission.py" inspect "${RUNTIME_IMAGE}" "${MIGRATION_IMAGE}")" || die "registry image pair recheck failed"
  [[ -n "${REGISTRY_ADMISSION:-}" && "${current}" == "${REGISTRY_ADMISSION}" ]] || die "registry image pair changed after preparation"
}

run_database_migrations() {
  if [[ "${ACTION:-}" == legacy-offline-update ]]; then legacy_recovery_boundary write-intent; fi
  log "running database migrations"
  recheck_registry_images
  compose run --rm --pull never --no-deps dollhousemcp-migrate
  log "applying post-migration database grants"
  [[ -r "${POST_MIGRATION_GRANTS_FILE}" ]] || \
    die "post-migration grants file is not readable at ${POST_MIGRATION_GRANTS_FILE}; run render or install again"
  compose exec -T postgres /usr/local/bin/apply-post-migration-grants \
    < "${POST_MIGRATION_GRANTS_FILE}"

  return 0
}

refresh_caddy_image() {
  log "refreshing caddy image"
  compose pull caddy
  CADDY_ADMISSION_RECEIPT="$(python3 "${HOSTED_DEPLOY_LIB_DIR}/caddy_image_admission.py" "${CADDY_IMAGE}")" || \
    die "Caddy image did not match the retained qualification"

  return 0
}

caddy_request_json() {
  HOSTED_CADDY_REQUEST_ROOT="${DEPLOY_DIR}" HOSTED_CADDY_REQUEST_INSTANCE="${INSTANCE_NAME}" \
    HOSTED_CADDY_REQUEST_DATA="${CADDY_DATA_VOLUME}" HOSTED_CADDY_REQUEST_CONFIG="${CADDY_CONFIG_VOLUME}" \
    python3 -c 'import json, os; print(json.dumps({"deploy_dir":os.environ["HOSTED_CADDY_REQUEST_ROOT"], "instance":os.environ["HOSTED_CADDY_REQUEST_INSTANCE"], "data_volume":os.environ["HOSTED_CADDY_REQUEST_DATA"], "config_volume":os.environ["HOSTED_CADDY_REQUEST_CONFIG"]}))'
}

clone_caddy_volumes() {
  ensure_runtime_prerequisites
  validate_persisted_caddy_fields
  resolve_mode_defaults
  validate_caddy_selection "${CADDY_IMAGE}" "${CADDY_DATA_VOLUME}" "${CADDY_CONFIG_VOLUME}"
  caddy_request_json | python3 "${HOSTED_DEPLOY_LIB_DIR}/caddy_clone_action.py"
}

prepare_caddy_offline() {
  ensure_runtime_prerequisites
  validate_persisted_caddy_fields
  resolve_mode_defaults
  validate_caddy_selection "${CADDY_IMAGE}" "${CADDY_DATA_VOLUME}" "${CADDY_CONFIG_VOLUME}"
  caddy_fresh_request_json | python3 "${HOSTED_DEPLOY_LIB_DIR}/caddy_offline_prepare.py"
}

acquire_caddy_deployment_lock() {
  need_command flock
  python3 -c 'import os, stat, sys; p=sys.argv[1]; s=os.lstat(p); sys.exit(0 if stat.S_ISDIR(s.st_mode) and s.st_uid == os.geteuid() and not s.st_mode & 0o022 and os.path.realpath(p) == p else 1)' "${DEPLOY_DIR}" || \
    die "deployment directory must be canonical and protected"
  [[ ! -L "${DEPLOY_DIR}/.caddy-deploy.lock" ]] || die "deployment lock must not be a symlink"
  local old_umask
  old_umask="$(umask)"
  umask 077
  exec 9>>"${DEPLOY_DIR}/.caddy-deploy.lock"
  HOSTED_CADDY_LOCK_FD=9
  umask "${old_umask}"
  python3 -c 'import os, stat, sys; f=os.fstat(int(sys.argv[1])); p=os.lstat(sys.argv[2]); sys.exit(0 if stat.S_ISREG(f.st_mode) and f.st_uid == os.geteuid() and f.st_nlink == 1 and not f.st_mode & 0o077 and (f.st_dev, f.st_ino) == (p.st_dev, p.st_ino) else 1)' \
    "${HOSTED_CADDY_LOCK_FD}" "${DEPLOY_DIR}/.caddy-deploy.lock" || die "deployment lock is unsafe"
  flock --nonblock "${HOSTED_CADDY_LOCK_FD}" || die "another Caddy deployment operation holds the lock"
  [[ ! -e "${DEPLOY_DIR}/.caddy-offline-stop-issued" && ! -L "${DEPLOY_DIR}/.caddy-offline-stop-issued" ]] || \
    die "an earlier Caddy stop has an unknown outcome; operator reconciliation is required"
  python3 "${HOSTED_DEPLOY_LIB_DIR}/caddy_transition_state.py" "${DEPLOY_DIR}" || \
    die "a Caddy verification or release requires operator reconciliation"
}

verify_prepared_caddy() {
  PREVIOUS_BUNDLE="$(caddy_request_json | python3 "${HOSTED_DEPLOY_LIB_DIR}/caddy_prepared_action.py")" || \
    die "no safe prepared Caddy clone matches this source; run clone-caddy-volumes with the proxy stopped"
  [[ "${PREVIOUS_BUNDLE}" == "${DEPLOY_DIR}/server.prev-"* ]] || die "invalid previous bundle destination"
  CADDY_RECOVERY_VERIFIED=true
}

caddy_unchanged_request_json() {
  local expected_hash
  expected_hash="$(caddyfile_content | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')"
  HOSTED_CADDY_REQUEST_ROOT="${DEPLOY_DIR}" HOSTED_CADDY_REQUEST_INSTANCE="${INSTANCE_NAME}" \
    HOSTED_CADDY_REQUEST_DATA="${CADDY_DATA_VOLUME}" HOSTED_CADDY_REQUEST_CONFIG="${CADDY_CONFIG_VOLUME}" \
    HOSTED_CADDY_REQUEST_IMAGE="${CADDY_IMAGE}" HOSTED_CADDY_EXPECTED_HASH="${expected_hash}" \
    HOSTED_CADDY_PROXY_MODE="${PROXY_MODE}" HOSTED_CADDY_BIND="${BIND_ADDRESS}" \
    HOSTED_CADDY_HTTP_PORT="${HTTP_BIND_PORT}" HOSTED_CADDY_HTTPS_PORT="${HTTPS_BIND_PORT}" \
    python3 -c 'import json, os; e=os.environ; print(json.dumps({"deploy_dir":e["HOSTED_CADDY_REQUEST_ROOT"], "instance":e["HOSTED_CADDY_REQUEST_INSTANCE"], "data_volume":e["HOSTED_CADDY_REQUEST_DATA"], "config_volume":e["HOSTED_CADDY_REQUEST_CONFIG"], "image":e["HOSTED_CADDY_REQUEST_IMAGE"], "expected_caddy_sha256":e["HOSTED_CADDY_EXPECTED_HASH"], "proxy_mode":e["HOSTED_CADDY_PROXY_MODE"], "bind_address":e["HOSTED_CADDY_BIND"], "http_port":e["HOSTED_CADDY_HTTP_PORT"], "https_port":e["HOSTED_CADDY_HTTPS_PORT"]}))'
}

prepare_current_caddy() {
  local observed observed_user observed_running
  observed="$(docker inspect --format '{{.Config.User}}|{{.State.Running}}' "${CADDY_CONTAINER_NAME}")" || \
    die "cannot identify the current Caddy proxy"
  [[ "${observed}" == *'|'* ]] || die "invalid Caddy proxy state"
  observed_user="${observed%|*}"
  observed_running="${observed##*|}"
  [[ "${observed_running}" == true || "${observed_running}" == false ]] || die "invalid Caddy proxy state"
  if [[ "${observed_user}" == '1001:1001' && "${observed_running}" == true ]]; then
    PREVIOUS_BUNDLE="$(caddy_unchanged_request_json | \
      HOSTED_CADDY_LOCK_FD="${HOSTED_CADDY_LOCK_FD}" python3 "${HOSTED_DEPLOY_LIB_DIR}/caddy_unchanged_action.py")" || \
      die "current hardened proxy differs from the requested profile; a separate offline migration is required"
    [[ "${PREVIOUS_BUNDLE}" == "${DEPLOY_DIR}/server.prev-"* ]] || die "invalid previous bundle destination"
    CADDY_KEEP_PROXY=true
    CADDY_RECOVERY_VERIFIED=true
  else
    verify_prepared_caddy
  fi
}

caddy_recovery_request_json() {
  HOSTED_CADDY_REQUEST_ROOT="${DEPLOY_DIR}" HOSTED_CADDY_REQUEST_INSTANCE="${INSTANCE_NAME}" \
    HOSTED_CADDY_REQUEST_DATA="${CADDY_DATA_VOLUME}" HOSTED_CADDY_REQUEST_CONFIG="${CADDY_CONFIG_VOLUME}" \
    HOSTED_CADDY_REQUEST_PREVIOUS="$1" HOSTED_CADDY_REQUEST_IMAGE="${CADDY_IMAGE}" \
    python3 -c 'import json, os; print(json.dumps({"deploy_dir":os.environ["HOSTED_CADDY_REQUEST_ROOT"], "instance":os.environ["HOSTED_CADDY_REQUEST_INSTANCE"], "data_volume":os.environ["HOSTED_CADDY_REQUEST_DATA"], "config_volume":os.environ["HOSTED_CADDY_REQUEST_CONFIG"], "previous":os.environ["HOSTED_CADDY_REQUEST_PREVIOUS"], "image":os.environ["HOSTED_CADDY_REQUEST_IMAGE"]}))'
}

caddy_transition_request_json() {
  HOSTED_CADDY_REQUEST_ROOT="${DEPLOY_DIR}" HOSTED_CADDY_REQUEST_INSTANCE="${INSTANCE_NAME}" \
    HOSTED_CADDY_REQUEST_DATA="${CADDY_DATA_VOLUME}" HOSTED_CADDY_REQUEST_CONFIG="${CADDY_CONFIG_VOLUME}" \
    HOSTED_CADDY_REQUEST_IMAGE="${CADDY_IMAGE}" HOSTED_CADDY_REQUEST_PREVIOUS="${PREVIOUS_BUNDLE:-}" \
    HOSTED_CADDY_TRANSITION_TOKEN="${CADDY_TRANSITION_TOKEN:-}" HOSTED_CADDY_ADMISSION="${CADDY_ADMISSION_RECEIPT:-}" \
    python3 -c 'import json, os; e=os.environ; print(json.dumps({"deploy_dir":e["HOSTED_CADDY_REQUEST_ROOT"], "instance":e["HOSTED_CADDY_REQUEST_INSTANCE"], "data_volume":e["HOSTED_CADDY_REQUEST_DATA"], "config_volume":e["HOSTED_CADDY_REQUEST_CONFIG"], "image":e["HOSTED_CADDY_REQUEST_IMAGE"], "previous":e["HOSTED_CADDY_REQUEST_PREVIOUS"], "token":e["HOSTED_CADDY_TRANSITION_TOKEN"], "admission":json.loads(e["HOSTED_CADDY_ADMISSION"] or "null")}))'
}

caddy_transition() {
  local action="$1"
  caddy_transition_request_json | \
    HOSTED_CADDY_LOCK_FD="${HOSTED_CADDY_LOCK_FD:-}" python3 "${HOSTED_DEPLOY_LIB_DIR}/caddy_transition_action.py" "${action}"
}

finish_caddy_transition() {
  caddy_transition finish >/dev/null || die "the completed deployment could not be recorded; operator recovery is required"
}

caddy_release_request_json() {
  HOSTED_CADDY_REQUEST_ROOT="${DEPLOY_DIR}" HOSTED_CADDY_REQUEST_INSTANCE="${INSTANCE_NAME}" \
    HOSTED_CADDY_REQUEST_DATA="${CADDY_DATA_VOLUME}" HOSTED_CADDY_REQUEST_CONFIG="${CADDY_CONFIG_VOLUME}" \
    HOSTED_CADDY_TRANSITION_TOKEN="${CADDY_TRANSITION_TOKEN:-}" HOSTED_CADDY_KEEP="${CADDY_KEEP_PROXY:-false}" \
    HOSTED_CADDY_PUBLIC_URL="${PUBLIC_BASE_URL}" HOSTED_CADDY_VERIFY_TIMEOUT="${VERIFY_READY_TIMEOUT}" \
    HOSTED_RENDER_MODE="${PROXY_MODE}" HOSTED_RENDER_HOST="${HOSTNAME}" HOSTED_RENDER_HTTP="${HTTP_BIND_PORT}" \
    HOSTED_RENDER_MCP="${MCP_PORT}" HOSTED_RENDER_TRUSTED="${CADDY_TRUSTED_PROXIES}" HOSTED_RENDER_LOG="${CADDY_ACCESS_LOG}" \
    python3 -c 'import json, os; e=os.environ; print(json.dumps({"deploy_dir":e["HOSTED_CADDY_REQUEST_ROOT"],"instance":e["HOSTED_CADDY_REQUEST_INSTANCE"],"data_volume":e["HOSTED_CADDY_REQUEST_DATA"],"config_volume":e["HOSTED_CADDY_REQUEST_CONFIG"],"token":e["HOSTED_CADDY_TRANSITION_TOKEN"],"keep_proxy":e["HOSTED_CADDY_KEEP"]=="true","public_base_url":e["HOSTED_CADDY_PUBLIC_URL"],"timeout":int(e["HOSTED_CADDY_VERIFY_TIMEOUT"]),"allow_bootstrap":True,"renderer":{"PROXY_MODE":e["HOSTED_RENDER_MODE"],"HOSTNAME":e["HOSTED_RENDER_HOST"],"HTTP_BIND_PORT":e["HOSTED_RENDER_HTTP"],"MCP_PORT":e["HOSTED_RENDER_MCP"],"CADDY_TRUSTED_PROXIES":e["HOSTED_RENDER_TRUSTED"],"CADDY_ACCESS_LOG":e["HOSTED_RENDER_LOG"]}}))'
}

caddy_release() {
  local action="$1"
  caddy_release_request_json | HOSTED_CADDY_LOCK_FD="${HOSTED_CADDY_LOCK_FD}" \
    python3 "${HOSTED_DEPLOY_LIB_DIR}/caddy_release_action.py" "${action}" || \
    die "Caddy verification or release failed; inspect the pending state before any recovery"
}

write_deployed_markers() {
  printf '%s\n' "${STAGED_REVISION}" > "${DEPLOY_DIR}/DEPLOYED_REVISION"
  date -u +%Y-%m-%dT%H:%M:%SZ > "${DEPLOY_DIR}/DEPLOYED_AT"
}

caddy_fresh_request_json() {
  HOSTED_CADDY_REQUEST_ROOT="${DEPLOY_DIR}" HOSTED_CADDY_REQUEST_INSTANCE="${INSTANCE_NAME}" \
    HOSTED_CADDY_REQUEST_DATA="${CADDY_DATA_VOLUME}" HOSTED_CADDY_REQUEST_CONFIG="${CADDY_CONFIG_VOLUME}" \
    HOSTED_CADDY_REQUEST_IMAGE="${CADDY_IMAGE}" \
    python3 -c 'import json, os; print(json.dumps({"deploy_dir":os.environ["HOSTED_CADDY_REQUEST_ROOT"], "instance":os.environ["HOSTED_CADDY_REQUEST_INSTANCE"], "data_volume":os.environ["HOSTED_CADDY_REQUEST_DATA"], "config_volume":os.environ["HOSTED_CADDY_REQUEST_CONFIG"], "image":os.environ["HOSTED_CADDY_REQUEST_IMAGE"]}))'
}

prepare_fresh_caddy_volumes() {
  caddy_fresh_request_json | \
    HOSTED_CADDY_LOCK_FD="${HOSTED_CADDY_LOCK_FD}" python3 "${HOSTED_DEPLOY_LIB_DIR}/caddy_fresh_action.py"
}

recheck_caddy_transition() {
  local fresh="$1"
  if [[ "${fresh}" == true ]]; then
    caddy_fresh_request_json | python3 "${HOSTED_DEPLOY_LIB_DIR}/caddy_fresh_recheck.py" >/dev/null || \
      die "fresh Caddy volumes no longer match their receipt"
  else
    caddy_recovery_request_json "${PREVIOUS_BUNDLE}" | python3 "${HOSTED_DEPLOY_LIB_DIR}/caddy_prestart_action.py" >/dev/null || \
      die "the original Caddy proxy or cloned volumes changed"
  fi
}

recover_selected_caddy() {
  local previous="$1"
  caddy_recovery_request_json "${previous}" | \
    HOSTED_CADDY_LOCK_FD="${HOSTED_CADDY_LOCK_FD}" python3 "${HOSTED_DEPLOY_LIB_DIR}/caddy_recover_action.py"
}

recover_caddy_proxy() {
  local previous
  ensure_runtime_prerequisites
  validate_persisted_caddy_fields
  resolve_mode_defaults
  validate_caddy_selection "${CADDY_IMAGE}" "${CADDY_DATA_VOLUME}" "${CADDY_CONFIG_VOLUME}"
  acquire_caddy_deployment_lock
  previous="$(caddy_transition select-proxy)" || die "no unambiguous proxy recovery source is available"
  if [[ "${previous}" == '@current' ]]; then
    caddy_recovery_request_json "${previous}" | \
      HOSTED_CADDY_LOCK_FD="${HOSTED_CADDY_LOCK_FD}" python3 "${HOSTED_DEPLOY_LIB_DIR}/caddy_pending_proxy_action.py"
  else
    recover_selected_caddy "${previous}"
  fi
}

recheck_caddy_image() {
  local current
  [[ -n "${CADDY_ADMISSION_RECEIPT:-}" ]] || die "Caddy image admission is missing"
  current="$(python3 "${HOSTED_DEPLOY_LIB_DIR}/caddy_image_admission.py" "${CADDY_IMAGE}")" || \
    die "Caddy image recheck failed"
  [[ "${current}" == "${CADDY_ADMISSION_RECEIPT}" ]] || die "Caddy image changed after admission"
}

start_prepared_caddy_proxy() {
  local route
  route="$(caddy_transition start-proxy)" || die "prepared Caddy replacement refused; preserve its receipts"
  case "${route}" in
    compose) compose up -d --pull never --no-deps --force-recreate caddy ;;
    native) ;;
    *) die "prepared Caddy replacement returned an unknown route" ;;
  esac
}

prepare_existing_stack() {
  ensure_runtime_prerequisites
  ensure_server_source
  acquire_caddy_deployment_lock
  resolve_mode_defaults
  if [[ "${IMAGE_MODE}" == build ]]; then require_slim_maintenance_source; fi
  render_files
  prepare_app_images
  prepare_postgres_before_app_stop

  return 0
}

run_bootstrap_admin() {
  local mode="${1:-required}"
  local args=()

  if [[ -n "${BOOTSTRAP_GITHUB_ID}" ]]; then
    if [[ -n "${BOOTSTRAP_GITHUB_USERNAME}" ]]; then
      warn "DOLLHOUSE_BOOTSTRAP_GITHUB_ID is set; ignoring DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME"
    fi
    args=(--method github --github-id "${BOOTSTRAP_GITHUB_ID}")
  elif [[ -n "${BOOTSTRAP_GITHUB_USERNAME}" ]]; then
    args=(--method github --github-username "${BOOTSTRAP_GITHUB_USERNAME}")
  elif [[ "${mode}" == "optional" ]]; then
    return 0
  elif [[ -t 0 ]]; then
    read -r -p "Admin GitHub username: " BOOTSTRAP_GITHUB_USERNAME
    [[ -n "${BOOTSTRAP_GITHUB_USERNAME}" ]] || die "admin GitHub username is required"
    args=(--method github --github-username "${BOOTSTRAP_GITHUB_USERNAME}")
  else
    die "set DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME or DOLLHOUSE_BOOTSTRAP_GITHUB_ID"
  fi

  log "bootstrapping GitHub admin"
  recheck_registry_images
  compose run --rm --pull never --no-deps dollhousemcp-migrate node dist/cli/admin-bootstrap.js --require-admin-url "${args[@]}"

  return 0
}

bootstrap_admin() {
  prepare_existing_stack
  run_database_migrations
  run_bootstrap_admin required

  return 0
}

# Resolve and stop only this application's current immutable container.
# No compose stop/down/recreate may precede this successful fence.
gracefully_stop_existing_app() {
  local immutable_id
  immutable_id="$(existing_app_id)" || die "cannot resolve existing application"
  if [[ "${ACTION:-}" == legacy-offline-update ]]; then
    [[ -n "${immutable_id}" ]] || die "legacy handoff requires the original app"
    legacy_handoff stop
  else
    [[ -n "${immutable_id}" ]] || return 0
    bash "${HOSTED_DEPLOY_SCRIPT_DIR}/hosted-graceful-stop.sh" "${immutable_id}" 60
  fi
}

# The explicit legacy action alone may consume a checkpoint, never an env bypass.
legacy_request_json() {
  local app_id postgres_id
  app_id="$(existing_app_id)" || die "legacy app selection failed"
  postgres_id="$(running_service_id postgres)" || die "legacy database selection failed"
  [[ -n "${app_id}" && -n "${postgres_id}" ]] || die "legacy services must already exist"
  HOSTED_LEGACY_ROOT="${DEPLOY_DIR}" HOSTED_LEGACY_INSTANCE="${INSTANCE_NAME}" \
    HOSTED_LEGACY_DATA="${CADDY_DATA_VOLUME}" HOSTED_LEGACY_CONFIG="${CADDY_CONFIG_VOLUME}" \
    HOSTED_LEGACY_TOKEN="${CADDY_TRANSITION_TOKEN:-}" HOSTED_LEGACY_CHECKPOINT="${LEGACY_CHECKPOINT:-}" \
    HOSTED_LEGACY_APP="${app_id}" HOSTED_LEGACY_POSTGRES="${postgres_id}" \
    python3 -c 'import json,os; e=os.environ; print(json.dumps(dict(zip(("deploy_dir","instance","data_volume","config_volume","token","checkpoint_dir","app_id","postgres_id"),(e["HOSTED_LEGACY_"+k] for k in ("ROOT","INSTANCE","DATA","CONFIG","TOKEN","CHECKPOINT","APP","POSTGRES"))))))'
}

legacy_handoff() {
  local action="$1"
  legacy_request_json | \
    HOSTED_CADDY_LOCK_FD="${HOSTED_CADDY_LOCK_FD}" python3 "${HOSTED_DEPLOY_LIB_DIR}/legacy_handoff.py" "${action}" >/dev/null || \
    die "legacy handoff refused; keep the fence closed and inspect checkpoint/recovery receipts"
}

legacy_recovery_boundary() {
  local action="$1"
  legacy_request_json | \
    HOSTED_CADDY_LOCK_FD="${HOSTED_CADDY_LOCK_FD}" python3 "${HOSTED_DEPLOY_LIB_DIR}/legacy_recovery_boundary.py" "${action}" || \
    die "legacy recovery baseline or forward-write boundary refused"
}

verify_legacy_handoff() {
  if [[ "${ACTION:-}" == legacy-offline-update ]]; then legacy_handoff verify; fi
  return 0
}

start_or_update() {
  local fresh="false"
  local transition_status
  ensure_prerequisites
  validate_git_url_for_clone
  resolve_public_base_url
  resolve_hostname
  resolve_allowed_hosts
  validate_render_inputs
  if [[ ! -d "${DEPLOY_DIR}" ]]; then
    (umask 077; mkdir -p "${DEPLOY_DIR}")
  fi
  acquire_caddy_deployment_lock
  transition_status="$(caddy_transition status)" || die "Caddy transition state is unavailable"
  if [[ "${ACTION:-}" == legacy-offline-update ]]; then
    [[ "${IMAGE_MODE}" == registry && -d "${SERVER_DIR}" ]] || die "legacy handoff requires an existing registry-mode deployment"
    legacy_handoff preflight
    # Arming's own checks, before a transition exists: a refusal here leaves nothing pending.
    legacy_recovery_boundary check
  fi
  if [[ -d "${SERVER_DIR}" ]]; then
    if [[ "${transition_status}" == fresh ]]; then
      CADDY_TRANSITION_TOKEN="$(caddy_transition retry-fresh)" || die "pending first install cannot be retried safely"
      caddy_transition retain-unstarted >/dev/null || die "unstarted source could not be retained safely"
      fresh="true"
    else
      [[ "${transition_status}" == none ]] || die "a previous transition requires operator recovery"
      prepare_current_caddy
      CADDY_TRANSITION_TOKEN="$(caddy_transition begin-update)" || die "could not bind the pending source transition"
    fi
  else
    fresh="true"
    if [[ "${transition_status}" == fresh ]]; then
      CADDY_TRANSITION_TOKEN="$(caddy_transition retry-fresh)" || die "pending first install cannot be retried safely"
    else
      [[ "${transition_status}" == none ]] || die "a previous transition requires operator recovery"
      CADDY_TRANSITION_TOKEN="$(caddy_transition begin-fresh)" || die "could not record the first-install transition"
    fi
  fi
  if [[ "${ACTION:-}" == legacy-offline-update ]]; then legacy_recovery_boundary arm; fi
  render_files
  if [[ "${CADDY_KEEP_PROXY:-false}" != true ]]; then
    refresh_caddy_image
    caddy_transition bind-admission >/dev/null || die "qualified Caddy image admission could not be recorded"
  fi
  if [[ "${fresh}" == true ]]; then
    prepare_fresh_caddy_volumes
  fi
  stage_source
  caddy_transition stage >/dev/null || die "staged source identity could not be recorded"
  prepare_app_images
  prepare_postgres_before_app_stop
  if [[ "${CADDY_KEEP_PROXY:-false}" == true ]]; then
    caddy_recovery_request_json "${PREVIOUS_BUNDLE}" | python3 "${HOSTED_DEPLOY_LIB_DIR}/caddy_verify_noop_action.py" >/dev/null || \
      die "the preserved Caddy proxy no longer matches its recovery receipt"
  else
    recheck_caddy_image
    recheck_caddy_transition "${fresh}"
  fi
  caddy_release prepare
  if [[ "${CADDY_KEEP_PROXY:-false}" != true ]]; then
    recheck_caddy_image
    start_prepared_caddy_proxy
  fi
  caddy_release confirm
  caddy_release probe-fence
  recheck_registry_images
  gracefully_stop_existing_app
  # Schema and identity writes require the successful drain fence. Failure here
  # leaves the app stopped; old-image restart needs a compatible recovery plan.
  verify_legacy_handoff
  run_database_migrations
  verify_legacy_handoff
  run_bootstrap_admin optional
  recheck_registry_images
  verify_legacy_handoff
  compose up -d --pull never --no-build --no-deps --force-recreate dollhousemcp
  return 0
}

run_migrations() {
  prepare_existing_stack
  run_database_migrations

  return 0
}

response_excerpt() {
  local file="$1"

  tr '\n' ' ' < "${file}" | cut -c 1-240

  return 0
}

curl_status() {
  local url="$1"
  local body_file="$2"
  local status
  if ! status="$(curl -sS -o "${body_file}" -w '%{http_code}' "${url}" 2>/dev/null)"; then
    status="000"
  fi
  printf '%s\n' "${status}"

  return 0
}

check_healthz() {
  validate_verify_timeout

  local body_file status excerpt elapsed
  elapsed=0
  while true; do
    body_file="$(mktemp)"
    status="$(curl_status "${PUBLIC_BASE_URL}/healthz" "${body_file}")"
    if [[ "${status}" == "200" ]]; then
      rm -f "${body_file}"
      return 0
    fi

    if (( elapsed >= VERIFY_READY_TIMEOUT )); then
      excerpt="$(response_excerpt "${body_file}")"
      rm -f "${body_file}"
      if [[ -n "${excerpt}" ]]; then
        die "expected /healthz to return 200 within ${VERIFY_READY_TIMEOUT}s, got ${status}: ${excerpt}"
      fi
      die "expected /healthz to return 200 within ${VERIFY_READY_TIMEOUT}s, got ${status}"
    fi
    rm -f "${body_file}"
    sleep 1
    elapsed=$((elapsed + 1))
  done
}

check_readyz() {
  local mode="$1"
  validate_verify_timeout

  local body_file status excerpt elapsed
  elapsed=0
  while true; do
    body_file="$(mktemp)"
    status="$(curl_status "${PUBLIC_BASE_URL}/readyz" "${body_file}")"
    if [[ "${status}" == "200" ]]; then
      rm -f "${body_file}"
      return 0
    fi

    if [[ "${mode}" == "allow-bootstrap-required" && "${status}" == "503" ]] && \
      grep -Fq 'bootstrap_required' "${body_file}"; then
      rm -f "${body_file}"
      warn "/readyz reports bootstrap_required; run bootstrap-admin after setting DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME or DOLLHOUSE_BOOTSTRAP_GITHUB_ID"
      return 0
    fi

    if (( elapsed >= VERIFY_READY_TIMEOUT )); then
      excerpt="$(response_excerpt "${body_file}")"
      rm -f "${body_file}"
      if [[ -n "${excerpt}" ]]; then
        die "expected /readyz to return 200 within ${VERIFY_READY_TIMEOUT}s, got ${status}: ${excerpt}"
      fi
      die "expected /readyz to return 200 within ${VERIFY_READY_TIMEOUT}s, got ${status}"
    fi
    rm -f "${body_file}"
    sleep 1
    elapsed=$((elapsed + 1))
  done
}

check_mcp_unauthenticated() {
  validate_verify_timeout

  local body_file status excerpt elapsed
  elapsed=0
  while true; do
    body_file="$(mktemp)"
    status="$(curl_status "${PUBLIC_BASE_URL}/mcp" "${body_file}")"
    if [[ "${status}" == "401" ]]; then
      rm -f "${body_file}"
      return 0
    fi

    if (( elapsed >= VERIFY_READY_TIMEOUT )); then
      excerpt="$(response_excerpt "${body_file}")"
      rm -f "${body_file}"
      if [[ -n "${excerpt}" ]]; then
        die "expected /mcp to return 401 without a bearer token within ${VERIFY_READY_TIMEOUT}s, got ${status}: ${excerpt}"
      fi
      die "expected /mcp to return 401 without a bearer token within ${VERIFY_READY_TIMEOUT}s, got ${status}"
    fi
    rm -f "${body_file}"
    sleep 1
    elapsed=$((elapsed + 1))
  done
}

rollback_server() {
  local previous timestamp current_backup previous_name

  ensure_runtime_prerequisites
  validate_persisted_caddy_fields
  resolve_mode_defaults
  validate_registry_selection
  [[ "${IMAGE_MODE}" != registry ]] || die "registry rollback is unsupported; select a qualified roll-forward plan before any recovery"
  validate_caddy_selection "${CADDY_IMAGE}" "${CADDY_DATA_VOLUME}" "${CADDY_CONFIG_VOLUME}"
  acquire_caddy_deployment_lock
  previous="$(caddy_transition select-rollback)" || die "no unambiguous completed rollback source is available"
  [[ -d "${SERVER_DIR}" ]] || die "no current server bundle found at ${SERVER_DIR}"
  PREVIOUS_BUNDLE="${previous}"
  caddy_recovery_request_json "${previous}" | python3 "${HOSTED_DEPLOY_LIB_DIR}/caddy_rollback_guard.py" || \
    die "rollback requires a different proxy; retain the recovery point for a separately qualified plan"
  CADDY_TRANSITION_TOKEN="$(caddy_transition begin-rollback)" || die "could not record the rollback transition"
  CADDY_KEEP_PROXY=true
  render_files

  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  current_backup="${DEPLOY_DIR}/server.rollback-from-${timestamp}"
  previous_name="$(basename "${previous}")"

  log "rolling back server source to ${previous_name}"
  mv "${SERVER_DIR}" "${current_backup}"
  if ! mv "${previous}" "${SERVER_DIR}"; then
    mv "${current_backup}" "${SERVER_DIR}" || true
    die "failed to restore ${previous_name}; current server bundle was restored"
  fi
  caddy_transition stage >/dev/null || die "rollback source identity could not be recorded"

  # Rollback does not run migrations; previous source may predate the slim target.
  compose build dollhousemcp
  prepare_postgres_before_app_stop
  caddy_release prepare
  caddy_release confirm
  caddy_release probe-fence
  # Prepare the selected rollback bundle and images while the current app is
  # healthy. A failed move/build/pull must not create an avoidable outage.
  gracefully_stop_existing_app
  compose up -d --pull never --no-build --no-deps --force-recreate dollhousemcp
  STAGED_REVISION="rollback:${previous_name}"

  return 0
}

verify_deploy() {
  local readyz_mode="${1:-strict}"

  need_command curl
  resolve_public_base_url
  resolve_hostname
  validate_render_inputs
  log "checking ${PUBLIC_BASE_URL}/healthz for up to ${VERIFY_READY_TIMEOUT}s"
  check_healthz
  log "checking ${PUBLIC_BASE_URL}/readyz for up to ${VERIFY_READY_TIMEOUT}s"
  check_readyz "${readyz_mode}"
  log "checking ${PUBLIC_BASE_URL}/mcp for unauthenticated 401 for up to ${VERIFY_READY_TIMEOUT}s"
  check_mcp_unauthenticated
  log "verification passed"

  return 0
}
