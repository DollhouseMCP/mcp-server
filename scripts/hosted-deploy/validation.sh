# shellcheck shell=bash
# Validation helpers for hosted-deploy.

need_command() {
  local command_name="$1"
  local resolved_path

  resolved_path="$(command -v "${command_name}" || true)"
  if [[ -z "${resolved_path}" ]]; then
    die "missing required command: ${command_name}"
  fi

  return 0
}

validate_bool() {
  local key="$1"
  local value="$2"
  case "${value}" in
    true|false)
      ;;
    *)
      die "${key} must be 'true' or 'false', got: ${value}"
      ;;
  esac

  return 0
}

validate_deploy_mode() {
  case "${DEPLOY_MODE}" in
    cloud|lan|enterprise)
      ;;
    *)
      die "DOLLHOUSE_HOSTED_MODE must be cloud, lan, or enterprise; got: ${DEPLOY_MODE}"
      ;;
  esac

  return 0
}

validate_proxy_mode() {
  case "${PROXY_MODE}" in
    caddy-http|caddy-tls)
      ;;
    *)
      die "DOLLHOUSE_HOSTED_PROXY_MODE must be caddy-tls or caddy-http; got: ${PROXY_MODE}"
      ;;
  esac

  return 0
}

validate_auth_provider() {
  case "${AUTH_PROVIDER}" in
    embedded|oidc|local)
      ;;
    *)
      die "DOLLHOUSE_AUTH_PROVIDER must be embedded, oidc, or local; got: ${AUTH_PROVIDER}"
      ;;
  esac

  return 0
}

validate_auth_methods() {
  validate_no_whitespace DOLLHOUSE_AUTH_METHODS "${AUTH_METHODS}"
  if [[ -n "${AUTH_METHODS}" && ! "${AUTH_METHODS}" =~ ^[A-Za-z0-9,_-]+$ ]]; then
    die "DOLLHOUSE_AUTH_METHODS contains unsupported characters: ${AUTH_METHODS}"
  fi
  if [[ "${AUTH_PROVIDER}" == "embedded" && -z "${AUTH_METHODS}" ]]; then
    die "DOLLHOUSE_AUTH_METHODS must not be empty when DOLLHOUSE_AUTH_PROVIDER=embedded"
  fi

  return 0
}

effective_config_value() {
  local key="$1"
  local value="${!key:-}"

  if [[ -z "${value}" ]]; then
    value="$(deployment_env_file_value "${key}")"
  fi
  printf '%s\n' "${value}"

  return 0
}

validate_oidc_url() {
  local key="$1"
  local value="$2"

  validate_no_whitespace "${key}" "${value}"
  case "${value}" in
    http://*|https://*)
      ;;
    *)
      die "${key} must start with http:// or https:// when DOLLHOUSE_AUTH_PROVIDER=oidc"
      ;;
  esac

  return 0
}

validate_oidc_inputs() {
  [[ "${AUTH_PROVIDER}" == "oidc" ]] || return 0

  local issuer audience
  issuer="$(effective_config_value DOLLHOUSE_AUTH_ISSUER)"
  audience="$(effective_config_value DOLLHOUSE_AUTH_AUDIENCE)"
  [[ -n "${issuer}" ]] || die "DOLLHOUSE_AUTH_ISSUER is required when DOLLHOUSE_AUTH_PROVIDER=oidc"
  [[ -n "${audience}" ]] || die "DOLLHOUSE_AUTH_AUDIENCE is required when DOLLHOUSE_AUTH_PROVIDER=oidc"
  validate_oidc_url DOLLHOUSE_AUTH_ISSUER "${issuer}"
  validate_no_whitespace DOLLHOUSE_AUTH_AUDIENCE "${audience}"

  return 0
}

is_dry_run() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    return 0
  fi

  return 1
}

validate_no_whitespace() {
  local key="$1"
  local value="$2"

  if [[ "${value}" =~ [[:space:]] ]]; then
    die "${key} must not contain whitespace"
  fi

  return 0
}

validate_no_empty_comma_entries() {
  local key="$1"
  local value="$2"

  if [[ "${value}" == ,* || "${value}" == *, || "${value}" == *,,* ]]; then
    die "${key} must not contain empty comma-separated entries"
  fi

  return 0
}

validate_cidr_list() {
  local key="$1"
  local value="$2"
  local cidr address prefix
  local -a cidrs

  [[ -n "${value}" ]] || return 0
  validate_no_whitespace "${key}" "${value}"
  validate_no_empty_comma_entries "${key}" "${value}"
  if [[ ! "${value}" =~ ^[0-9A-Fa-f:.,/]+$ ]]; then
    die "${key} must be a comma-separated CIDR list"
  fi

  IFS=',' read -r -a cidrs <<< "${value}"
  for cidr in "${cidrs[@]}"; do
    if [[ -z "${cidr}" || ! "${cidr}" =~ ^[0-9A-Fa-f:.]+/[0-9]{1,3}$ ]]; then
      die "${key} contains an invalid CIDR entry: ${cidr}"
    fi
    address="${cidr%/*}"
    prefix="${cidr##*/}"
    if [[ "${address}" == *:* ]]; then
      if ! is_ipv6_address "${address}" || (( 10#${prefix} > 128 )); then
        die "${key} contains an invalid CIDR entry: ${cidr}"
      fi
    else
      if ! is_ipv4_address "${address}" || (( 10#${prefix} > 32 )); then
        die "${key} contains an invalid CIDR entry: ${cidr}"
      fi
    fi
  done

  return 0
}

validate_trusted_proxy_list() {
  local key="$1"
  local value="$2"
  local entry address prefix max_prefix
  local -a entries

  [[ -n "${value}" ]] || return 0
  validate_no_whitespace "${key}" "${value}"
  validate_no_empty_comma_entries "${key}" "${value}"

  IFS=',' read -r -a entries <<< "${value}"
  for entry in "${entries[@]}"; do
    case "${entry}" in
      loopback|linklocal|uniquelocal)
        continue
        ;;
    esac

    [[ -n "${entry}" ]] || die "${key} contains an invalid trusted proxy entry: ${entry}"
    if [[ "${entry}" == */* ]]; then
      address="${entry%/*}"
      prefix="${entry##*/}"
      [[ "${prefix}" =~ ^[0-9]{1,3}$ ]] || die "${key} contains an invalid trusted proxy entry: ${entry}"
    else
      address="${entry}"
      prefix=""
    fi

    if [[ "${address}" == *:* ]]; then
      is_ipv6_address "${address}" || die "${key} contains an invalid trusted proxy entry: ${entry}"
      max_prefix=128
    else
      is_ipv4_address "${address}" || die "${key} contains an invalid trusted proxy entry: ${entry}"
      max_prefix=32
    fi

    if [[ -n "${prefix}" ]] && (( 10#${prefix} > max_prefix )); then
      die "${key} contains an invalid trusted proxy entry: ${entry}"
    fi
  done

  return 0
}

validate_instance_name() {
  validate_no_whitespace DOLLHOUSE_HOSTED_INSTANCE_NAME "${INSTANCE_NAME}"
  if [[ ! "${INSTANCE_NAME}" =~ ^[a-z0-9][a-z0-9-]{0,47}$ ]]; then
    die "DOLLHOUSE_HOSTED_INSTANCE_NAME must be 1-48 lowercase letters, numbers, or hyphens and start with a letter or number; got: ${INSTANCE_NAME}"
  fi

  return 0
}

validate_hostname() {
  [[ -n "${HOSTNAME}" ]] || die "hostname resolved to an empty value"
  validate_no_whitespace DOLLHOUSE_HOSTED_HOSTNAME "${HOSTNAME}"
  if [[ "${HOSTNAME}" == *"/"* || "${HOSTNAME}" == *"@"* ]]; then
    die "DOLLHOUSE_HOSTED_HOSTNAME must be a hostname only, for example mcp.example.com"
  fi
  if [[ ! "${HOSTNAME}" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
    die "DOLLHOUSE_HOSTED_HOSTNAME contains unsupported characters: ${HOSTNAME}"
  fi
  if [[ "${HOSTNAME}" == *..* || "${HOSTNAME}" == .* || "${HOSTNAME}" == *. ]]; then
    die "DOLLHOUSE_HOSTED_HOSTNAME must be a valid hostname, got: ${HOSTNAME}"
  fi

  return 0
}

validate_public_base_url() {
  validate_no_whitespace DOLLHOUSE_PUBLIC_BASE_URL "${PUBLIC_BASE_URL}"
  case "${PUBLIC_BASE_URL}" in
    http://*|https://*)
      ;;
    *)
      die "DOLLHOUSE_PUBLIC_BASE_URL must start with http:// or https://"
      ;;
  esac

  local without_scheme
  without_scheme="${PUBLIC_BASE_URL#https://}"
  without_scheme="${without_scheme#http://}"
  if [[ "${without_scheme}" == *"@"* ]]; then
    die "DOLLHOUSE_PUBLIC_BASE_URL must not contain credentials"
  fi
  if [[ "${without_scheme}" == *"/"* || "${without_scheme}" == *"?"* || "${without_scheme}" == *"#"* ]]; then
    die "DOLLHOUSE_PUBLIC_BASE_URL must be an origin only, for example https://mcp.example.com"
  fi

  return 0
}

validate_public_base_url_matches_proxy_mode() {
  local scheme

  scheme="$(public_base_url_scheme)"
  case "${PROXY_MODE}:${scheme}" in
    caddy-http:http|caddy-tls:https)
      ;;
    caddy-http:*)
      die "DOLLHOUSE_PUBLIC_BASE_URL must use http:// when DOLLHOUSE_HOSTED_PROXY_MODE=caddy-http"
      ;;
    caddy-tls:*)
      die "DOLLHOUSE_PUBLIC_BASE_URL must use https:// when DOLLHOUSE_HOSTED_PROXY_MODE=caddy-tls"
      ;;
    *)
      die "unsupported DOLLHOUSE_HOSTED_PROXY_MODE: ${PROXY_MODE}"
      ;;
  esac

  return 0
}

validate_port_value() {
  local key="$1"
  local value="$2"

  if [[ ! "${value}" =~ ^[0-9]+$ || "${value}" -lt 1 || "${value}" -gt 65535 ]]; then
    die "${key} must be an integer from 1 to 65535, got: ${value}"
  fi

  return 0
}

validate_port() {
  validate_port_value DOLLHOUSE_HTTP_PORT "${MCP_PORT}"

  return 0
}

validate_bind_ports() {
  validate_port_value DOLLHOUSE_HOSTED_HTTP_BIND_PORT "${HTTP_BIND_PORT}"
  validate_port_value DOLLHOUSE_HOSTED_HTTPS_BIND_PORT "${HTTPS_BIND_PORT}"

  return 0
}

is_ipv4_address() {
  local value="$1"
  local octet
  local -a octets

  [[ "${value}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  IFS=. read -r -a octets <<< "${value}"
  for octet in "${octets[@]}"; do
    if (( 10#${octet} > 255 )); then
      return 1
    fi
  done

  return 0
}

ipv6_hextet_count() {
  local value="$1"
  local rest part count
  rest="${value}"
  count=0

  while [[ "${rest}" == *:* ]]; do
    part="${rest%%:*}"
    if [[ -n "${part}" ]]; then
      [[ "${part}" =~ ^[0-9A-Fa-f]{1,4}$ ]] || return 1
      count=$((count + 1))
    fi
    rest="${rest#*:}"
  done
  if [[ -n "${rest}" ]]; then
    [[ "${rest}" =~ ^[0-9A-Fa-f]{1,4}$ ]] || return 1
    count=$((count + 1))
  fi

  printf '%s\n' "${count}"
  return 0
}

is_ipv6_address() {
  local value="$1"
  local without_double double_count hextets

  [[ "${value}" == *:* ]] || return 1
  [[ "${value}" =~ ^[0-9A-Fa-f:]+$ ]] || return 1
  [[ "${value}" != *:::* ]] || return 1

  without_double="${value//::/}"
  double_count=$(((${#value} - ${#without_double}) / 2))
  (( double_count <= 1 )) || return 1

  if (( double_count == 0 )); then
    [[ "${value}" != :* && "${value}" != *: ]] || return 1
    hextets="$(ipv6_hextet_count "${value}")" || return 1
    (( hextets == 8 )) || return 1
  else
    [[ "${value}" != :* || "${value}" == ::* ]] || return 1
    [[ "${value}" != *: || "${value}" == *:: ]] || return 1
    hextets="$(ipv6_hextet_count "${value}")" || return 1
    (( hextets < 8 )) || return 1
  fi

  return 0
}

validate_bind_address() {
  validate_no_whitespace DOLLHOUSE_HOSTED_BIND_ADDRESS "${BIND_ADDRESS}"
  if ! is_ipv4_address "${BIND_ADDRESS}"; then
    die "DOLLHOUSE_HOSTED_BIND_ADDRESS must be an IPv4 address such as 127.0.0.1 or 0.0.0.0; got: ${BIND_ADDRESS}"
  fi

  return 0
}

validate_render_value() {
  local key="$1"
  local value="$2"

  validate_no_whitespace "${key}" "${value}"
  if [[ "${value}" == *":"* && "${key}" != "DOLLHOUSE_HOSTED_IMAGE_TAG" ]]; then
    die "${key} contains ':' unexpectedly: ${value}"
  fi

  return 0
}

validate_render_inputs() {
  resolve_mode_defaults
  validate_bool DOLLHOUSE_AUTH_OPEN_DCR "${OPEN_DCR}"
  validate_bool DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED "${ALLOWLIST_REQUIRED}"
  validate_auth_provider
  validate_auth_methods
  validate_oidc_inputs
  validate_hostname
  validate_public_base_url
  validate_public_base_url_matches_proxy_mode
  validate_port
  validate_bind_ports
  validate_bind_address
  validate_no_whitespace DOLLHOUSE_HTTP_ALLOWED_HOSTS "${ALLOWED_HOSTS}"
  validate_trusted_proxy_list DOLLHOUSE_TRUSTED_PROXIES "${TRUSTED_PROXIES}"
  validate_bool DOLLHOUSE_HOSTED_CADDY_ACCESS_LOG "${CADDY_ACCESS_LOG}"
  validate_cidr_list DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES "${CADDY_TRUSTED_PROXIES}"
  validate_render_value DOLLHOUSE_HOSTED_IMAGE_TAG "${IMAGE_TAG}"
  validate_render_value DOLLHOUSE_HOSTED_MEM_LIMIT "${MEM_LIMIT}"
  validate_render_value DOLLHOUSE_HOSTED_CPUS "${CPU_LIMIT}"

  return 0
}

git_url_has_credentials() {
  local git_url="$1"
  if [[ "${git_url}" =~ ^https?://[^/@]+@ ]]; then
    return 0
  fi

  return 1
}

validate_git_url_for_clone() {
  validate_bool DOLLHOUSE_HOSTED_ALLOW_CREDENTIAL_GIT_URL "${ALLOW_CREDENTIAL_GIT_URL}"
  if git_url_has_credentials "${GIT_URL}" && [[ "${ALLOW_CREDENTIAL_GIT_URL}" != "true" ]]; then
    die "DOLLHOUSE_HOSTED_GIT_URL must not embed credentials; use a git credential helper, deploy key, or DOLLHOUSE_HOSTED_SOURCE_DIR instead"
  fi

  return 0
}

resolve_public_base_url() {
  resolve_mode_defaults
  if [[ -n "${PUBLIC_BASE_URL}" ]]; then
    return 0
  fi
  [[ -n "${HOSTNAME}" ]] || die "set DOLLHOUSE_HOSTED_HOSTNAME or DOLLHOUSE_PUBLIC_BASE_URL"
  local scheme port suffix
  scheme="$(mode_default_scheme)"
  port="$(default_public_port)"
  suffix="$(default_public_port_suffix "${scheme}" "${port}")"
  PUBLIC_BASE_URL="${scheme}://${HOSTNAME}${suffix}"

  return 0
}

resolve_hostname() {
  resolve_mode_defaults
  if [[ -n "${HOSTNAME}" ]]; then
    return 0
  fi
  [[ -n "${PUBLIC_BASE_URL}" ]] || die "set DOLLHOUSE_HOSTED_HOSTNAME or DOLLHOUSE_PUBLIC_BASE_URL"
  HOSTNAME="$(public_base_url_authority)"
  HOSTNAME="${HOSTNAME%%:*}"

  return 0
}

resolve_allowed_hosts() {
  resolve_hostname
  if [[ -n "${ALLOWED_HOSTS}" ]]; then
    return 0
  fi
  ALLOWED_HOSTS="localhost,127.0.0.1,${HOSTNAME}"

  return 0
}
