# shellcheck shell=bash
# Runtime Docker/Compose operations for hosted-deploy.

ensure_docker_prerequisites() {
  need_command docker
  docker compose version >/dev/null 2>&1 || die "Docker Compose is required"

  return 0
}

ensure_runtime_prerequisites() {
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
  compose up -d postgres

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
}

prepare_postgres_before_app_stop() {
  local postgres_id app_id
  postgres_id="$(running_service_id postgres)" || die "cannot resolve running postgres"
  if [[ -n "${postgres_id}" ]]; then
    wait_for_running_postgres "${postgres_id}"
    return 0
  fi
  app_id="$(running_service_id dollhousemcp)" || die "cannot resolve running application"
  [[ -z "${app_id}" ]] || die "running application has no running postgres; refusing database recreation"
  # Only an install/recovery with no running application may start PostgreSQL.
  wait_for_postgres
}

build_app_image() {
  log "building dollhousemcp image"
  compose build dollhousemcp dollhousemcp-migrate

  return 0
}

run_database_migrations() {
  log "running database migrations"
  compose run --rm dollhousemcp-migrate
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

  return 0
}

restart_caddy_proxy() {
  log "refreshing caddy proxy"
  compose up -d --no-deps --force-recreate caddy

  return 0
}

prepare_existing_stack() {
  ensure_runtime_prerequisites
  render_files
  ensure_server_source
  build_app_image
  wait_for_postgres

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
  compose run --rm \
    dollhousemcp-migrate \
    /usr/local/bin/dollhouse-bootstrap-admin "${args[@]}"

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
  local current_id immutable_id
  current_id="$(compose ps -q dollhousemcp)"
  [[ -n "${current_id}" ]] || return 0
  immutable_id="$(docker inspect --format '{{.Id}}' "${current_id}")"
  bash "${HOSTED_DEPLOY_SCRIPT_DIR}/hosted-graceful-stop.sh" "${immutable_id}" 60
}

start_or_update() {
  local service="${1:-all}"
  ensure_prerequisites
  validate_git_url_for_clone
  render_files
  stage_source
  build_app_image
  prepare_postgres_before_app_stop
  refresh_caddy_image
  gracefully_stop_existing_app
  # Schema and identity writes require the successful drain fence. Failure here
  # leaves the app stopped; old-image restart needs a compatible recovery plan.
  run_database_migrations
  run_bootstrap_admin optional
  if [[ "${service}" == "app" ]]; then
    compose up -d dollhousemcp
    restart_caddy_proxy
  else
    compose up -d
  fi
  printf '%s\n' "${STAGED_REVISION}" > "${DEPLOY_DIR}/DEPLOYED_REVISION"
  date -u +%Y-%m-%dT%H:%M:%SZ > "${DEPLOY_DIR}/DEPLOYED_AT"

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
  render_files
  previous="$(latest_previous_bundle)"
  [[ -n "${previous}" ]] || die "no previous server bundle found in ${DEPLOY_DIR}"
  [[ -d "${SERVER_DIR}" ]] || die "no current server bundle found at ${SERVER_DIR}"

  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  current_backup="${DEPLOY_DIR}/server.rollback-from-${timestamp}"
  previous_name="$(basename "${previous}")"

  log "rolling back server source to ${previous_name}"
  mv "${SERVER_DIR}" "${current_backup}"
  if ! mv "${previous}" "${SERVER_DIR}"; then
    mv "${current_backup}" "${SERVER_DIR}" || true
    die "failed to restore ${previous_name}; current server bundle was restored"
  fi

  build_app_image
  prepare_postgres_before_app_stop
  refresh_caddy_image
  # Prepare the selected rollback bundle and images while the current app is
  # healthy. A failed move/build/pull must not create an avoidable outage.
  gracefully_stop_existing_app
  compose up -d dollhousemcp caddy
  printf 'rollback:%s\n' "${previous_name}" > "${DEPLOY_DIR}/DEPLOYED_REVISION"
  date -u +%Y-%m-%dT%H:%M:%SZ > "${DEPLOY_DIR}/DEPLOYED_AT"

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
