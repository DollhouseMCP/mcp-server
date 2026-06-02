# shellcheck shell=bash
# Action dispatch for hosted-deploy.

run_action() {
  case "${ACTION}" in
    help)
      usage
      ;;
    render)
      need_command openssl
      render_files
      ;;
    install)
      start_or_update all
      verify_deploy
      ;;
    update)
      start_or_update app
      verify_deploy
      ;;
    migrate)
      run_migrations
      ;;
    bootstrap-admin)
      bootstrap_admin
      ;;
    rollback)
      rollback_server
      verify_deploy
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
  debug "action=${ACTION} dry_run=${DRY_RUN} deploy_dir=${DEPLOY_DIR}"

  if is_dry_run && [[ "${ACTION}" != "help" ]]; then
    run_dry_action
  else
    run_action
  fi

  return 0
}
