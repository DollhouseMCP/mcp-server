# shellcheck shell=bash
# Dry-run planning for hosted-deploy.

describe_render_plan() {
  resolve_public_base_url
  resolve_hostname
  resolve_allowed_hosts
  validate_render_inputs
  log "dry-run: deployment mode=${DEPLOY_MODE} instance=${INSTANCE_NAME} proxy_mode=${PROXY_MODE} bind=${BIND_ADDRESS} public_url=${PUBLIC_BASE_URL}"
  log "dry-run: compose project=${INSTANCE_NAME} image=${IMAGE_TAG} caddy=${CADDY_IMAGE}"
  log "dry-run: caddy data=${CADDY_DATA_VOLUME} config=${CADDY_CONFIG_VOLUME}; image and volumes require qualification"
  log "dry-run: Docker json-file log rotation max-size=${DOCKER_LOG_MAX_SIZE} max-file=${DOCKER_LOG_MAX_FILE}"
  log "dry-run: auth provider=${AUTH_PROVIDER} methods=${AUTH_METHODS:-none} generation=${AUTH_GENERATION} open_dcr=${OPEN_DCR} allowlist_required=${ALLOWLIST_REQUIRED}"
  log "dry-run: would render deployment files in ${DEPLOY_DIR}"
  log "dry-run: would preserve or create ${ENV_FILE}"
  log "dry-run: would write ${COMPOSE_FILE}"
  log "dry-run: would write ${CADDY_FILE}"
  log "dry-run: would write ${INIT_DB_FILE} without embedding the app database password"
  log "dry-run: would write ${POST_MIGRATION_GRANTS_FILE} without embedding the app database password"
  log "dry-run: would write ${POST_MIGRATION_GRANTS_SCRIPT_FILE} to pass grant passwords through container environment"
  log "dry-run: hosted bootstrap requires the administrator database URL inside the maintenance container"

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

describe_image_preparation() {
  if [[ "${IMAGE_MODE}" == registry ]]; then
    log "dry-run: would pull and verify both digest-qualified runtime and migration images before draining the app"
    log "dry-run: image-pair source labels establish consistency, not provenance or security qualification"
  else
    log "dry-run: would build dollhousemcp image"
  fi
}

dry_run_start_or_update() {
  local service="${1:-all}"

  validate_git_url_for_clone
  describe_render_plan
  describe_source_plan
  describe_image_preparation
  log "dry-run: would check the pinned running postgres without recreation for up to ${POSTGRES_READY_TIMEOUT}s; start postgres only if no application is running"
  log "dry-run: would retain a verified unchanged hardened caddy proxy; otherwise pull and admit the selected image before stopping the current app"
  log "dry-run: would require non-force graceful stop before schema or admin changes"
  log "dry-run: would run database migrations"
  log "dry-run: would apply post-migration database grants"
  describe_bootstrap_plan optional
  if [[ "${service}" == "app" ]]; then
    log "dry-run: would restart dollhousemcp; retain an unchanged qualified caddy proxy or refresh it after admission"
  else
    log "dry-run: would recreate the application, retaining an unchanged qualified caddy proxy when applicable"
  fi
  log "dry-run: would record deployed revision and time only after replacement succeeds"
  log "dry-run: would verify ${PUBLIC_BASE_URL}/healthz, /readyz, and /mcp for up to ${VERIFY_READY_TIMEOUT}s"
  log "dry-run: would warn, not fail, if /readyz reports bootstrap_required before the first admin is claimed"

  return 0
}

dry_run_migrations() {
  describe_render_plan
  log "dry-run: would require existing server source at ${SERVER_DIR}"
  describe_image_preparation
  log "dry-run: would start postgres and wait up to ${POSTGRES_READY_TIMEOUT}s"
  log "dry-run: would run database migrations"
  log "dry-run: would apply post-migration database grants"

  return 0
}

dry_run_bootstrap_admin() {
  describe_render_plan
  log "dry-run: would require existing server source at ${SERVER_DIR}"
  describe_image_preparation
  log "dry-run: would start postgres and wait up to ${POSTGRES_READY_TIMEOUT}s"
  log "dry-run: would run database migrations"
  log "dry-run: would apply post-migration database grants"
  describe_bootstrap_plan required

  return 0
}

dry_run_rollback() {
  describe_render_plan
  [[ "${IMAGE_MODE}" != registry ]] || die "registry rollback is unsupported; select a qualified roll-forward plan before any recovery"
  log "dry-run: would use the exact completed receipt-bound rollback source"
  if [[ -d "${SERVER_DIR}" ]]; then
    log "dry-run: current server bundle exists at ${SERVER_DIR}"
  else
    log "dry-run: current server bundle is not present yet"
  fi
  local previous
  if [[ -d "${DEPLOY_DIR}/.caddy-state" ]] && previous="$(caddy_transition select-rollback 2>/dev/null)"; then
    log "dry-run: validated rollback candidate is ${previous}"
  else
    log "dry-run: no completed, unambiguous rollback candidate is available"
  fi
  log "dry-run: would validate and restore or retain the recorded proxy before moving source"
  log "dry-run: would rebuild dollhousemcp, check pinned postgres, and require non-force graceful stop before app replacement"
  log "dry-run: would verify ${PUBLIC_BASE_URL}/healthz, /readyz, and /mcp for up to ${VERIFY_READY_TIMEOUT}s"
  log "dry-run: would warn, not fail, if /readyz reports bootstrap_required before the first admin is claimed"

  return 0
}

dry_run_verify() {
  resolve_public_base_url
  resolve_hostname
  validate_render_inputs
  log "dry-run: would check ${PUBLIC_BASE_URL}/healthz for up to ${VERIFY_READY_TIMEOUT}s"
  log "dry-run: would check ${PUBLIC_BASE_URL}/readyz for up to ${VERIFY_READY_TIMEOUT}s"
  log "dry-run: would check ${PUBLIC_BASE_URL}/mcp returns 401 without a bearer token for up to ${VERIFY_READY_TIMEOUT}s"

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
    clone-caddy-volumes)
      validate_persisted_caddy_fields
      resolve_mode_defaults
      validate_caddy_selection "${CADDY_IMAGE}" "${CADDY_DATA_VOLUME}" "${CADDY_CONFIG_VOLUME}"
      log "dry-run: would require the existing proxy stopped and clone its volumes to ${CADDY_DATA_VOLUME} and ${CADDY_CONFIG_VOLUME}"
      ;;
    recover-caddy-proxy)
      validate_persisted_caddy_fields
      resolve_mode_defaults
      validate_caddy_selection "${CADDY_IMAGE}" "${CADDY_DATA_VOLUME}" "${CADDY_CONFIG_VOLUME}"
      log "dry-run: would validate the selected previous bundle and its proxy receipt before proxy-only recovery"
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
