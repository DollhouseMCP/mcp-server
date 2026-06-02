# shellcheck shell=bash
# Validation helpers for hosted-deploy.

need_command() {
  local command_name="$1"
  local resolved_path

  resolved_path="$(command -v "${command_name}" || true)"
  if [[ -z "${resolved_path}" ]]; then
    die "missing required command: ${command_name}"
  fi
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
}

is_dry_run() {
  [[ "${DRY_RUN}" == "true" ]]
}

validate_no_whitespace() {
  local key="$1"
  local value="$2"

  if [[ "${value}" =~ [[:space:]] ]]; then
    die "${key} must not contain whitespace"
  fi
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
}

validate_port() {
  if [[ ! "${MCP_PORT}" =~ ^[0-9]+$ || "${MCP_PORT}" -lt 1 || "${MCP_PORT}" -gt 65535 ]]; then
    die "DOLLHOUSE_HTTP_PORT must be an integer from 1 to 65535, got: ${MCP_PORT}"
  fi
}

validate_render_value() {
  local key="$1"
  local value="$2"

  validate_no_whitespace "${key}" "${value}"
  if [[ "${value}" == *":"* && "${key}" != "DOLLHOUSE_HOSTED_IMAGE_TAG" ]]; then
    die "${key} contains ':' unexpectedly: ${value}"
  fi
}

validate_render_inputs() {
  validate_bool DOLLHOUSE_AUTH_OPEN_DCR "${OPEN_DCR}"
  validate_hostname
  validate_public_base_url
  validate_port
  validate_render_value DOLLHOUSE_HOSTED_IMAGE_TAG "${IMAGE_TAG}"
  validate_render_value DOLLHOUSE_HOSTED_MEM_LIMIT "${MEM_LIMIT}"
  validate_render_value DOLLHOUSE_HOSTED_CPUS "${CPU_LIMIT}"
}

git_url_has_credentials() {
  local git_url="$1"
  [[ "${git_url}" =~ ^https?://[^/@]+@ ]]
}

validate_git_url_for_clone() {
  validate_bool DOLLHOUSE_HOSTED_ALLOW_CREDENTIAL_GIT_URL "${ALLOW_CREDENTIAL_GIT_URL}"
  if git_url_has_credentials "${GIT_URL}" && [[ "${ALLOW_CREDENTIAL_GIT_URL}" != "true" ]]; then
    die "DOLLHOUSE_HOSTED_GIT_URL must not embed credentials; use a git credential helper, deploy key, or DOLLHOUSE_HOSTED_SOURCE_DIR instead"
  fi
}

resolve_public_base_url() {
  if [[ -n "${PUBLIC_BASE_URL}" ]]; then
    return
  fi
  [[ -n "${HOSTNAME}" ]] || die "set DOLLHOUSE_HOSTED_HOSTNAME or DOLLHOUSE_PUBLIC_BASE_URL"
  PUBLIC_BASE_URL="https://${HOSTNAME}"
}

resolve_hostname() {
  if [[ -n "${HOSTNAME}" ]]; then
    return
  fi
  [[ -n "${PUBLIC_BASE_URL}" ]] || die "set DOLLHOUSE_HOSTED_HOSTNAME or DOLLHOUSE_PUBLIC_BASE_URL"
  HOSTNAME="${PUBLIC_BASE_URL#https://}"
  HOSTNAME="${HOSTNAME#http://}"
  HOSTNAME="${HOSTNAME%%/*}"
}
