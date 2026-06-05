# shellcheck shell=bash
# Deployment-mode defaults for hosted-deploy.

deployment_env_file_value() {
  local key="$1"

  [[ -f "${ENV_FILE}" ]] || return 0
  awk -F= -v key="${key}" '$1 == key { value = substr($0, length(key) + 2) } END { print value }' "${ENV_FILE}"

  return 0
}

public_base_url_scheme() {
  case "${PUBLIC_BASE_URL}" in
    http://*)
      printf 'http\n'
      ;;
    https://*)
      printf 'https\n'
      ;;
    *)
      die "DOLLHOUSE_PUBLIC_BASE_URL must start with http:// or https://"
      ;;
  esac

  return 0
}

public_base_url_authority() {
  local value="${PUBLIC_BASE_URL#https://}"
  value="${value#http://}"
  printf '%s\n' "${value%%/*}"

  return 0
}

public_base_url_port_for_scheme() {
  local expected_scheme="$1"
  local authority scheme

  scheme="$(public_base_url_scheme)"
  [[ "${scheme}" == "${expected_scheme}" ]] || return 0

  authority="$(public_base_url_authority)"
  if [[ "${authority}" == *:* ]]; then
    printf '%s\n' "${authority##*:}"
  elif [[ "${scheme}" == "http" ]]; then
    printf '80\n'
  else
    printf '443\n'
  fi

  return 0
}

adopt_deployment_config_from_env_file() {
  local value persisted_mode persisted_instance adopt_mode_dependent adopt_instance_dependent
  adopt_mode_dependent="true"
  adopt_instance_dependent="true"
  persisted_mode="$(deployment_env_file_value DOLLHOUSE_HOSTED_MODE)"
  persisted_instance="$(deployment_env_file_value DOLLHOUSE_HOSTED_INSTANCE_NAME)"

  if [[ "${DEPLOY_MODE_SET}" != "true" ]]; then
    [[ -z "${persisted_mode}" ]] || DEPLOY_MODE="${persisted_mode}"
  elif [[ -z "${persisted_mode}" || "${persisted_mode}" != "${DEPLOY_MODE}" ]]; then
    adopt_mode_dependent="false"
  fi

  if [[ "${INSTANCE_NAME_SET}" == "true" && -n "${persisted_instance}" && "${persisted_instance}" != "${INSTANCE_NAME}" ]]; then
    die "cannot rename deployment instance in-place: ${ENV_FILE} has DOLLHOUSE_HOSTED_INSTANCE_NAME=${persisted_instance}," \
      "but ${INSTANCE_NAME} was requested; use a distinct DOLLHOUSE_HOSTED_DEPLOY_DIR for side-by-side deployments"
  fi

  if [[ "${INSTANCE_NAME_SET}" != "true" && -z "${INSTANCE_NAME}" ]]; then
    [[ -z "${persisted_instance}" ]] || INSTANCE_NAME="${persisted_instance}"
  elif [[ -z "${persisted_instance}" || "${persisted_instance}" != "${INSTANCE_NAME}" ]]; then
    adopt_instance_dependent="false"
  fi

  if [[ "${adopt_instance_dependent}" == "true" && "${IMAGE_TAG_SET}" != "true" && -z "${IMAGE_TAG}" ]]; then
    value="$(deployment_env_file_value DOLLHOUSE_HOSTED_IMAGE_TAG)"
    [[ -z "${value}" ]] || IMAGE_TAG="${value}"
  fi

  if [[ "${HOSTNAME_SET}" != "true" && "${PUBLIC_BASE_URL_SET}" != "true" && -z "${HOSTNAME}" ]]; then
    value="$(deployment_env_file_value DOLLHOUSE_HOSTED_HOSTNAME)"
    [[ -z "${value}" ]] || HOSTNAME="${value}"
  fi

  if [[ "${adopt_mode_dependent}" == "true" && "${PUBLIC_BASE_URL_SET}" != "true" && \
    "${HOSTNAME_SET}" != "true" && "${PROXY_MODE_SET}" != "true" && \
    "${HTTP_BIND_PORT_SET}" != "true" && "${HTTPS_BIND_PORT_SET}" != "true" && \
    -z "${PUBLIC_BASE_URL}" ]]; then
    value="$(deployment_env_file_value DOLLHOUSE_PUBLIC_BASE_URL)"
    [[ -z "${value}" ]] || PUBLIC_BASE_URL="${value}"
  fi

  if [[ "${adopt_mode_dependent}" == "true" && "${PROXY_MODE_SET}" != "true" && -z "${PROXY_MODE}" ]]; then
    value="$(deployment_env_file_value DOLLHOUSE_HOSTED_PROXY_MODE)"
    [[ -z "${value}" ]] || PROXY_MODE="${value}"
  fi

  if [[ "${adopt_mode_dependent}" == "true" && "${BIND_ADDRESS_SET}" != "true" && -z "${BIND_ADDRESS}" ]]; then
    value="$(deployment_env_file_value DOLLHOUSE_HOSTED_BIND_ADDRESS)"
    [[ -z "${value}" ]] || BIND_ADDRESS="${value}"
  fi

  if [[ "${adopt_mode_dependent}" == "true" && "${HTTP_BIND_PORT_SET}" != "true" && \
    "${PUBLIC_BASE_URL_SET}" != "true" && -z "${HTTP_BIND_PORT}" ]]; then
    value="$(deployment_env_file_value DOLLHOUSE_HOSTED_HTTP_BIND_PORT)"
    [[ -z "${value}" ]] || HTTP_BIND_PORT="${value}"
  fi

  if [[ "${adopt_mode_dependent}" == "true" && "${HTTPS_BIND_PORT_SET}" != "true" && \
    "${PUBLIC_BASE_URL_SET}" != "true" && -z "${HTTPS_BIND_PORT}" ]]; then
    value="$(deployment_env_file_value DOLLHOUSE_HOSTED_HTTPS_BIND_PORT)"
    [[ -z "${value}" ]] || HTTPS_BIND_PORT="${value}"
  fi

  if [[ "${adopt_mode_dependent}" == "true" && "${OPEN_DCR_SET}" != "true" && -z "${OPEN_DCR}" ]]; then
    value="$(deployment_env_file_value DOLLHOUSE_AUTH_OPEN_DCR)"
    [[ -z "${value}" ]] || OPEN_DCR="${value}"
  fi

  if [[ "${adopt_mode_dependent}" == "true" && "${AUTH_PROVIDER_SET}" != "true" && -z "${AUTH_PROVIDER}" ]]; then
    value="$(deployment_env_file_value DOLLHOUSE_AUTH_PROVIDER)"
    [[ -z "${value}" ]] || AUTH_PROVIDER="${value}"
  fi

  if [[ "${adopt_mode_dependent}" == "true" && "${AUTH_METHODS_SET}" != "true" && \
    "${AUTH_PROVIDER_SET}" != "true" && -z "${AUTH_METHODS}" ]]; then
    value="$(deployment_env_file_value DOLLHOUSE_AUTH_METHODS)"
    [[ -z "${value}" ]] || AUTH_METHODS="${value}"
  fi

  if [[ "${adopt_mode_dependent}" == "true" && "${ALLOWLIST_REQUIRED_SET}" != "true" && -z "${ALLOWLIST_REQUIRED}" ]]; then
    value="$(deployment_env_file_value DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED)"
    [[ -z "${value}" ]] || ALLOWLIST_REQUIRED="${value}"
  fi

  if [[ "${adopt_mode_dependent}" == "true" && "${TRUSTED_PROXIES_SET}" != "true" && \
    "${PROXY_MODE_SET}" != "true" && -z "${TRUSTED_PROXIES}" ]]; then
    value="$(deployment_env_file_value DOLLHOUSE_TRUSTED_PROXIES)"
    [[ -z "${value}" ]] || TRUSTED_PROXIES="${value}"
  fi

  if [[ "${adopt_mode_dependent}" == "true" && "${ALLOWED_HOSTS_SET}" != "true" && \
    "${HOSTNAME_SET}" != "true" && "${PUBLIC_BASE_URL_SET}" != "true" && \
    -z "${ALLOWED_HOSTS}" ]]; then
    value="$(deployment_env_file_value DOLLHOUSE_HTTP_ALLOWED_HOSTS)"
    [[ -z "${value}" ]] || ALLOWED_HOSTS="${value}"
  fi

  return 0
}

default_instance_name() {
  local normalized_dir deploy_basename instance_name
  normalized_dir="${DEPLOY_DIR%/}"
  [[ -n "${normalized_dir}" ]] || normalized_dir="${DEPLOY_DIR}"
  deploy_basename="$(basename "${normalized_dir}")"
  instance_name="$(
    printf '%s\n' "${deploy_basename}" |
      tr '[:upper:]' '[:lower:]' |
      sed 's/[^a-z0-9-]/-/g; s/--*/-/g; s/^-//; s/-$//'
  )"
  if [[ -z "${instance_name}" ]]; then
    instance_name="dollhousemcp"
  fi
  printf '%s\n' "${instance_name}"

  return 0
}

default_image_tag() {
  if [[ "${INSTANCE_NAME}" == "dollhousemcp" ]]; then
    printf 'dollhousemcp-hosted:alpha\n'
  else
    printf '%s-hosted:alpha\n' "${INSTANCE_NAME}"
  fi

  return 0
}

resolve_instance_defaults() {
  if [[ -z "${INSTANCE_NAME}" ]]; then
    INSTANCE_NAME="$(default_instance_name)"
  fi
  validate_instance_name

  if [[ -z "${IMAGE_TAG}" ]]; then
    IMAGE_TAG="$(default_image_tag)"
  fi

  APP_CONTAINER_NAME="${INSTANCE_NAME}"
  POSTGRES_CONTAINER_NAME="${INSTANCE_NAME}-postgres"
  CADDY_CONTAINER_NAME="${INSTANCE_NAME}-caddy"

  return 0
}

mode_default_proxy_mode() {
  case "${DEPLOY_MODE}" in
    cloud|enterprise)
      printf 'caddy-tls\n'
      ;;
    lan)
      printf 'caddy-http\n'
      ;;
    *)
      die "unsupported DOLLHOUSE_HOSTED_MODE: ${DEPLOY_MODE}"
      ;;
  esac

  return 0
}

mode_default_bind_address() {
  case "${DEPLOY_MODE}" in
    cloud|enterprise)
      printf '0.0.0.0\n'
      ;;
    lan)
      printf '127.0.0.1\n'
      ;;
    *)
      die "unsupported DOLLHOUSE_HOSTED_MODE: ${DEPLOY_MODE}"
      ;;
  esac

  return 0
}

mode_default_http_bind_port() {
  case "${DEPLOY_MODE}" in
    cloud|enterprise)
      printf '80\n'
      ;;
    lan)
      printf '3000\n'
      ;;
    *)
      die "unsupported DOLLHOUSE_HOSTED_MODE: ${DEPLOY_MODE}"
      ;;
  esac

  return 0
}

mode_default_open_dcr() {
  case "${DEPLOY_MODE}" in
    cloud)
      printf 'true\n'
      ;;
    lan|enterprise)
      printf 'false\n'
      ;;
    *)
      die "unsupported DOLLHOUSE_HOSTED_MODE: ${DEPLOY_MODE}"
      ;;
  esac

  return 0
}

mode_default_auth_provider() {
  case "${DEPLOY_MODE}" in
    cloud|lan|enterprise)
      printf 'embedded\n'
      ;;
    *)
      die "unsupported DOLLHOUSE_HOSTED_MODE: ${DEPLOY_MODE}"
      ;;
  esac

  return 0
}

mode_default_auth_methods() {
  case "${AUTH_PROVIDER}" in
    embedded)
      printf 'github\n'
      ;;
    local|oidc)
      printf '\n'
      ;;
    *)
      die "unsupported DOLLHOUSE_AUTH_PROVIDER: ${AUTH_PROVIDER}"
      ;;
  esac

  return 0
}

mode_default_allowlist_required() {
  case "${DEPLOY_MODE}" in
    cloud|lan|enterprise)
      printf 'true\n'
      ;;
    *)
      die "unsupported DOLLHOUSE_HOSTED_MODE: ${DEPLOY_MODE}"
      ;;
  esac

  return 0
}

mode_default_trusted_proxies() {
  case "${PROXY_MODE}" in
    caddy-http|caddy-tls)
      printf '172.16.0.0/12\n'
      ;;
    *)
      die "unsupported DOLLHOUSE_HOSTED_PROXY_MODE: ${PROXY_MODE}"
      ;;
  esac

  return 0
}

mode_default_scheme() {
  case "${PROXY_MODE}" in
    caddy-tls)
      printf 'https\n'
      ;;
    caddy-http)
      printf 'http\n'
      ;;
    *)
      die "unsupported DOLLHOUSE_HOSTED_PROXY_MODE: ${PROXY_MODE}"
      ;;
  esac

  return 0
}

default_public_port() {
  case "${PROXY_MODE}" in
    caddy-tls)
      printf '%s\n' "${HTTPS_BIND_PORT}"
      ;;
    caddy-http)
      printf '%s\n' "${HTTP_BIND_PORT}"
      ;;
    *)
      die "unsupported DOLLHOUSE_HOSTED_PROXY_MODE: ${PROXY_MODE}"
      ;;
  esac

  return 0
}

default_public_port_suffix() {
  local scheme="$1"
  local port="$2"

  case "${scheme}:${port}" in
    http:80|https:443)
      printf '\n'
      ;;
    *)
      printf ':%s\n' "${port}"
      ;;
  esac

  return 0
}

resolve_mode_defaults() {
  adopt_deployment_config_from_env_file
  resolve_instance_defaults
  validate_deploy_mode

  if [[ -z "${PROXY_MODE}" ]]; then
    PROXY_MODE="$(mode_default_proxy_mode)"
  fi
  validate_proxy_mode

  if [[ -z "${BIND_ADDRESS}" ]]; then
    BIND_ADDRESS="$(mode_default_bind_address)"
  fi

  if [[ -z "${HTTP_BIND_PORT}" ]]; then
    if [[ "${PUBLIC_BASE_URL_SET}" == "true" && "${PROXY_MODE}" == "caddy-http" ]]; then
      HTTP_BIND_PORT="$(public_base_url_port_for_scheme http)"
    fi
    [[ -n "${HTTP_BIND_PORT}" ]] || HTTP_BIND_PORT="$(mode_default_http_bind_port)"
  fi

  if [[ -z "${HTTPS_BIND_PORT}" ]]; then
    if [[ "${PUBLIC_BASE_URL_SET}" == "true" && "${PROXY_MODE}" == "caddy-tls" ]]; then
      HTTPS_BIND_PORT="$(public_base_url_port_for_scheme https)"
    fi
    [[ -n "${HTTPS_BIND_PORT}" ]] || HTTPS_BIND_PORT="443"
  fi

  if [[ -z "${OPEN_DCR}" ]]; then
    OPEN_DCR="$(mode_default_open_dcr)"
  fi

  if [[ -z "${AUTH_PROVIDER}" ]]; then
    AUTH_PROVIDER="$(mode_default_auth_provider)"
  fi

  if [[ "${AUTH_METHODS_SET}" != "true" && -z "${AUTH_METHODS}" ]]; then
    AUTH_METHODS="$(mode_default_auth_methods)"
  fi

  if [[ -z "${ALLOWLIST_REQUIRED}" ]]; then
    ALLOWLIST_REQUIRED="$(mode_default_allowlist_required)"
  fi

  if [[ -z "${TRUSTED_PROXIES}" ]]; then
    TRUSTED_PROXIES="$(mode_default_trusted_proxies)"
  fi

  return 0
}
