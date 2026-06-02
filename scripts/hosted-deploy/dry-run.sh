# shellcheck shell=bash
# Dry-run planning for hosted-deploy.

describe_render_plan() {
  resolve_public_base_url
  resolve_hostname
  validate_render_inputs
  log "dry-run: would render deployment files in ${DEPLOY_DIR}"
  log "dry-run: would preserve or create ${ENV_FILE}"
  log "dry-run: would write ${COMPOSE_FILE}"
  log "dry-run: would write ${CADDY_FILE}"
  log "dry-run: would write ${INIT_DB_FILE} without embedding the app database password"

  return 0
}

describe_source_plan() {
  detect_default_source_dir
  if [[ -n "${SOURCE_DIR}" ]]; then
    [[ -d "${SOURCE_DIR}" ]] || die "DOLLHOUSE_HOSTED_SOURCE_DIR does not exist: ${SOURCE_DIR}"
    if ! git -C "${SOURCE_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      die "DOLLHOUSE_HOSTED_SOURCE_DIR is not a git checkout: ${SOURCE_DIR}"
    fi
    log "dry-run: would stage source from ${SOURCE_DIR}"
  else
    validate_git_url_for_clone
    log "dry-run: would clone $(redact_url "${GIT_URL}") at ref ${GIT_REF}"
  fi

  return 0
}

describe_bootstrap_plan() {
  local mode="${1:-optional}"

  if [[ -n "${BOOTSTRAP_GITHUB_ID}" ]]; then
    log "dry-run: would bootstrap GitHub admin id ${BOOTSTRAP_GITHUB_ID}"
  elif [[ -n "${BOOTSTRAP_GITHUB_USERNAME}" ]]; then
    log "dry-run: would bootstrap GitHub admin username ${BOOTSTRAP_GITHUB_USERNAME}"
  elif [[ "${mode}" == "required" ]]; then
    log "dry-run: would require DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME or DOLLHOUSE_BOOTSTRAP_GITHUB_ID"
  else
    log "dry-run: would skip admin bootstrap because no bootstrap identity is set"
  fi

  return 0
}

dry_run_start_or_update() {
  local service="${1:-all}"

  validate_git_url_for_clone
  describe_render_plan
  describe_source_plan
  log "dry-run: would build dollhousemcp image"
  log "dry-run: would start postgres and wait up to ${POSTGRES_READY_TIMEOUT}s"
  log "dry-run: would run database migrations"
  describe_bootstrap_plan optional
  if [[ "${service}" == "app" ]]; then
    log "dry-run: would restart dollhousemcp service"
  else
    log "dry-run: would start or update the full compose stack"
  fi
  log "dry-run: would verify ${PUBLIC_BASE_URL}/healthz, /readyz, and /mcp"
  log "dry-run: would warn, not fail, if /readyz reports bootstrap_required before the first admin is claimed"

  return 0
}

dry_run_migrations() {
  describe_render_plan
  log "dry-run: would require existing server source at ${SERVER_DIR}"
  log "dry-run: would build dollhousemcp image"
  log "dry-run: would start postgres and wait up to ${POSTGRES_READY_TIMEOUT}s"
  log "dry-run: would run database migrations"

  return 0
}

dry_run_bootstrap_admin() {
  describe_render_plan
  log "dry-run: would require existing server source at ${SERVER_DIR}"
  log "dry-run: would build dollhousemcp image"
  log "dry-run: would start postgres and wait up to ${POSTGRES_READY_TIMEOUT}s"
  log "dry-run: would run database migrations"
  describe_bootstrap_plan required

  return 0
}

dry_run_rollback() {
  describe_render_plan
  log "dry-run: would restore the newest server.prev-* bundle"
  if [[ -d "${SERVER_DIR}" ]]; then
    log "dry-run: current server bundle exists at ${SERVER_DIR}"
  else
    log "dry-run: current server bundle is not present yet"
  fi
  local previous
  previous="$(latest_previous_bundle)"
  if [[ -n "${previous}" ]]; then
    log "dry-run: newest rollback candidate is ${previous}"
  else
    log "dry-run: no server.prev-* rollback candidate found yet"
  fi
  log "dry-run: would rebuild dollhousemcp image and restart dollhousemcp + caddy"
  log "dry-run: would verify ${PUBLIC_BASE_URL}/healthz, /readyz, and /mcp"
  log "dry-run: would warn, not fail, if /readyz reports bootstrap_required before the first admin is claimed"

  return 0
}

dry_run_verify() {
  resolve_public_base_url
  resolve_hostname
  validate_render_inputs
  log "dry-run: would check ${PUBLIC_BASE_URL}/healthz"
  log "dry-run: would check ${PUBLIC_BASE_URL}/readyz"
  log "dry-run: would check ${PUBLIC_BASE_URL}/mcp returns 401 without a bearer token"

  return 0
}

run_dry_action() {
  log "dry-run mode enabled; no files, source bundles, containers, git clones, or HTTP requests will be changed"
  case "${ACTION}" in
    render)
      describe_render_plan
      ;;
    install)
      dry_run_start_or_update all
      ;;
    update)
      dry_run_start_or_update app
      ;;
    migrate)
      dry_run_migrations
      ;;
    bootstrap-admin)
      dry_run_bootstrap_admin
      ;;
    rollback)
      dry_run_rollback
      ;;
    verify)
      dry_run_verify
      ;;
    *)
      usage >&2
      die "unknown action: ${ACTION}"
      ;;
  esac

  return 0
}
