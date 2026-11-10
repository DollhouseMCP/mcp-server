# shellcheck shell=bash
# Action dispatch for hosted-deploy.

run_action() {
  case "${ACTION}" in
    help)
      usage
      ;;
    render)
      need_command openssl
      resolve_public_base_url
      resolve_hostname
      resolve_allowed_hosts
      validate_render_inputs
      ensure_supported_python
      if [[ ! -d "${DEPLOY_DIR}" ]]; then
        (umask 077; mkdir -p "${DEPLOY_DIR}")
      fi
      acquire_caddy_deployment_lock
      render_files
      ;;
    install)
      start_or_update all
      caddy_release accept
      caddy_release release
      finish_caddy_transition
      write_deployed_markers
      ;;
    legacy-offline-update|update)
      start_or_update app
      caddy_release accept
      caddy_release release
      finish_caddy_transition
      write_deployed_markers
      ;;
    migrate)
      run_migrations
      ;;
    bootstrap-admin)
      bootstrap_admin
      ;;
    prepare-caddy-offline)
      prepare_caddy_offline
      ;;
    clone-caddy-volumes)
      clone_caddy_volumes
      ;;
    recover-caddy-proxy)
      recover_caddy_proxy
      ;;
    rollback)
      rollback_server
      caddy_release accept
      caddy_release release
      finish_caddy_transition
      write_deployed_markers
      ;;
    verify)
      verify_deploy
      ;;
    *)
      usage >&2
      die "unknown action: ${ACTION}"
      ;;
  esac

  return 0
}

hosted_deploy_main() {
  hosted_deploy_init_config
  parse_args "$@"
  validate_log_level
  validate_bool DOLLHOUSE_HOSTED_DRY_RUN "${DRY_RUN}"
  validate_bool DOLLHOUSE_HOSTED_IMPORT_LEGACY_ENV "${IMPORT_LEGACY_ENV}"
  debug "action=${ACTION} dry_run=${DRY_RUN} deploy_dir=${DEPLOY_DIR}"

  if is_dry_run && [[ "${ACTION}" != "help" ]]; then
    run_dry_action
  else
    run_action
  fi

  return 0
}
