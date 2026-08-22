# shellcheck shell=bash
# Environment-file and secret helpers for hosted-deploy.

ensure_container_portfolio_permissions() {
  if chown -R 1001:1001 "${DEPLOY_DIR}/portfolio" 2>/dev/null; then
    return 0
  fi

  if [[ "$(id -u)" == "0" ]]; then
    die "failed to set container ownership on ${DEPLOY_DIR}/portfolio"
  fi

  return 0
}

ensure_layout() {
  mkdir -p "${DEPLOY_DIR}" "${DEPLOY_DIR}/portfolio" "${DEPLOY_DIR}/logs"
  chmod 0750 "${DEPLOY_DIR}" "${DEPLOY_DIR}/portfolio" "${DEPLOY_DIR}/logs"
  ensure_container_portfolio_permissions

  return 0
}

random_hex() {
  local bytes="$1"

  if [[ ! "${bytes}" =~ ^[0-9]+$ || "${bytes}" -le 0 ]]; then
    die "random secret byte count must be a positive integer, got: ${bytes}"
  fi

  openssl rand -hex "${bytes}" || die "failed to generate ${bytes} random bytes with openssl"

  return 0
}

random_base64() {
  local bytes="$1"

  if [[ ! "${bytes}" =~ ^[0-9]+$ || "${bytes}" -le 0 ]]; then
    die "random secret byte count must be a positive integer, got: ${bytes}"
  fi

  openssl rand -base64 "${bytes}" || die "failed to generate ${bytes} random bytes with openssl"

  return 0
}

env_file_value() {
  local file="$1"
  local key="$2"

  [[ -f "${file}" ]] || return 0
  awk -F= -v key="${key}" '$1 == key { value = substr($0, length(key) + 2) } END { print value }' "${file}"

  return 0
}

env_value() {
  local key="$1"
  env_file_value "${ENV_FILE}" "${key}"

  return 0
}

ensure_legacy_env_readable() {
  [[ -f "${LEGACY_ENV_FILE}" ]] || return 0
  [[ -r "${LEGACY_ENV_FILE}" ]] || \
    die "${LEGACY_ENV_FILE} exists but is not readable; fix permissions or set DOLLHOUSE_HOSTED_IMPORT_LEGACY_ENV=false"

  return 0
}

upsert_env_value() {
  local key="$1"
  local value="$2"
  local tmp line current_key replaced
  [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "invalid environment key: ${key}"
  if [[ "${value}" == *$'\n'* || "${value}" == *$'\r'* ]]; then
    die "environment value for ${key} must not contain a newline"
  fi
  tmp="$(mktemp)"
  replaced=false
  while IFS= read -r line || [[ -n "${line}" ]]; do
    current_key="${line%%=*}"
    if [[ "${current_key}" == "${key}" ]]; then
      if [[ "${replaced}" == "false" ]]; then
        printf '%s=%s\n' "${key}" "${value}" >> "${tmp}"
        replaced=true
      fi
      continue
    fi
    printf '%s\n' "${line}" >> "${tmp}"
  done < "${ENV_FILE}"
  if [[ "${replaced}" == "false" ]]; then
    printf '%s=%s\n' "${key}" "${value}" >> "${tmp}"
  fi
  install -m 0600 "${tmp}" "${ENV_FILE}"
  rm -f "${tmp}"

  return 0
}

legacy_import_keys() {
  if [[ "${ENV_FILE_CREATED:-false}" == "true" ]]; then
    cat <<'EOF'
POSTGRES_ADMIN_PASSWORD
POSTGRES_PASSWORD
POSTGRES_APP_PASSWORD
DOLLHOUSE_DATABASE_URL
DOLLHOUSE_DATABASE_ADMIN_URL
DOLLHOUSE_COOKIE_SIGNING_SECRET
DOLLHOUSE_INVITE_TOKEN_SECRET
DOLLHOUSE_AUDIT_HMAC_SECRET
DOLLHOUSE_AUTH_GITHUB_CLIENT_ID
DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET
DOLLHOUSE_GITHUB_CLIENT_ID
DOLLHOUSE_GITHUB_CLIENT_SECRET
DOLLHOUSE_MASTER_ENCRYPTION_KEY
DOLLHOUSE_MASTER_ENCRYPTION_KEY_ID
DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED
DOLLHOUSE_SIGNING_KEY_REWRAP_ON_STARTUP
DOLLHOUSE_AUTH_GENERATION
EOF
  else
    cat <<'EOF'
POSTGRES_ADMIN_PASSWORD
POSTGRES_PASSWORD
POSTGRES_APP_PASSWORD
DOLLHOUSE_DATABASE_URL
DOLLHOUSE_DATABASE_ADMIN_URL
EOF
  fi

  return 0
}

sync_legacy_env_values() {
  [[ "${IMPORT_LEGACY_ENV}" == "true" ]] || return 0
  [[ -f "${LEGACY_ENV_FILE}" ]] || return 0
  [[ ! -f "${LEGACY_IMPORT_MARKER}" ]] || return 0
  ensure_legacy_env_readable

  local key legacy_value current_value imported_count imported_keys
  imported_count=0
  imported_keys=""

  while IFS= read -r key; do
    legacy_value="$(env_file_value "${LEGACY_ENV_FILE}" "${key}")"
    [[ -n "${legacy_value}" ]] || continue

    current_value="$(env_value "${key}")"
    if [[ "${current_value}" != "${legacy_value}" ]]; then
      upsert_env_value "${key}" "${legacy_value}"
      imported_count=$((imported_count + 1))
      imported_keys="${imported_keys:+${imported_keys}, }${key}"
    fi
  done < <(legacy_import_keys)

  if (( imported_count > 0 )); then
    log "imported ${imported_count} existing secret/config key(s) from ${LEGACY_ENV_FILE}: ${imported_keys}"
  fi
  return 0
}

ensure_env_secret() {
  local key="$1"
  local bytes="$2"
  local existing
  existing="$(env_value "${key}")"
  if [[ -n "${existing}" ]]; then
    return 0
  fi
  upsert_env_value "${key}" "$(random_hex "${bytes}")"

  return 0
}

ensure_env_secret_base64() {
  local key="$1"
  local bytes="$2"
  local existing
  existing="$(env_value "${key}")"
  if [[ -n "${existing}" ]]; then
    return 0
  fi
  upsert_env_value "${key}" "$(random_base64 "${bytes}")"

  return 0
}

maybe_set_env_from_process() {
  local key="$1"
  local value="${!key:-}"
  local existing
  existing="$(env_value "${key}")"
  if [[ -n "${existing}" || -z "${value}" ]]; then
    return 0
  fi
  upsert_env_value "${key}" "${value}"

  return 0
}

process_variable_is_set() {
  local key="$1"
  declare -p "${key}" >/dev/null 2>&1
}

validate_auth_generation() {
  local value="$1"
  local max_safe_integer='9007199254740991'
  if [[ ! "${value}" =~ ^[1-9][0-9]*$ ]] || \
    ((${#value} > ${#max_safe_integer})) || \
    { ((${#value} == ${#max_safe_integer})) && ((10#${value} > 10#${max_safe_integer})); }; then
    die "DOLLHOUSE_AUTH_GENERATION must be a positive safe integer"
  fi
}

trim_ascii_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "${value}"
}

validate_master_key_id() {
  local value="$1"
  local label="$2"
  local byte_length

  [[ "${value}" =~ ^[A-Za-z0-9._:-]+$ ]] || \
    die "${label} must be nonempty and use only ASCII letters, digits, '.', '_', ':', or '-'"
  byte_length="$(LC_ALL=C printf '%s' "${value}" | wc -c | tr -d '[:space:]')"
  (( byte_length <= 255 )) || die "${label} must be at most 255 UTF-8 bytes"
}

validate_master_key_base64() {
  local value="$1"
  local label="$2"
  local decoded_bytes

  [[ "${value}" =~ ^[A-Za-z0-9+/]{43}=$ ]] || \
    die "${label} must be a base64-encoded 32-byte key"
  if ! decoded_bytes="$(printf '%s' "${value}" | openssl base64 -d -A 2>/dev/null | wc -c | tr -d '[:space:]')"; then
    die "${label} must be valid base64"
  fi
  [[ "${decoded_bytes}" == "32" ]] || die "${label} must decode to exactly 32 bytes"
}

validate_retired_master_keys() {
  local value="$1"
  local active_key_id="$2"
  local entry key_id encoded seen
  local -a entries

  [[ -n "${value}" ]] || return 0
  seen=""
  IFS=',' read -r -a entries <<< "${value}"
  for entry in "${entries[@]}"; do
    entry="$(trim_ascii_whitespace "${entry}")"
    [[ "${entry}" == *=* ]] || \
      die "DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED entries must be 'keyId=base64key'"
    key_id="$(trim_ascii_whitespace "${entry%%=*}")"
    encoded="$(trim_ascii_whitespace "${entry#*=}")"
    validate_master_key_id "${key_id}" "retained master-key ID"
    validate_master_key_base64 "${encoded}" "retained master key '${key_id}'"
    [[ "${key_id}" != "${active_key_id}" ]] || \
      die "DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED must not contain the active key ID '${active_key_id}'"
    case $'\n'"${seen}"$'\n' in
      *$'\n'"${key_id}"$'\n'*) die "retained master-key ID '${key_id}' is duplicated" ;;
    esac
    seen="${seen}${seen:+$'\n'}${key_id}"
  done
}

retired_master_keys_contains() {
  local value="$1"
  local expected_key_id="$2"
  local expected_key="$3"
  local entry key_id encoded
  local -a entries

  [[ -n "${value}" ]] || return 1
  IFS=',' read -r -a entries <<< "${value}"
  for entry in "${entries[@]}"; do
    entry="$(trim_ascii_whitespace "${entry}")"
    key_id="$(trim_ascii_whitespace "${entry%%=*}")"
    encoded="$(trim_ascii_whitespace "${entry#*=}")"
    if [[ "${key_id}" == "${expected_key_id}" && "${encoded}" == "${expected_key}" ]]; then
      return 0
    fi
  done
  return 1
}

apply_auth_generation_from_process() {
  local key="DOLLHOUSE_AUTH_GENERATION"
  process_variable_is_set "${key}" || return 0

  local requested="${!key}"
  [[ -n "${requested}" ]] || return 0
  validate_auth_generation "${requested}"

  local persisted
  persisted="$(env_value "${key}")"
  if [[ -n "${persisted}" ]]; then
    validate_auth_generation "${persisted}"
    if (( requested < persisted )); then
      die "DOLLHOUSE_AUTH_GENERATION cannot move backwards from ${persisted} to ${requested}"
    fi
    (( requested == persisted )) && return 0
  fi
  upsert_env_value "${key}" "${requested}"
}

apply_master_encryption_controls_from_process() {
  local persisted_key persisted_key_id persisted_retired
  local target_key target_key_id target_retired rewrap
  local key_supplied id_supplied retired_supplied key_changed id_changed

  persisted_key="$(env_value DOLLHOUSE_MASTER_ENCRYPTION_KEY)"
  persisted_key_id="$(env_value DOLLHOUSE_MASTER_ENCRYPTION_KEY_ID)"
  persisted_retired="$(env_value DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED)"
  [[ -n "${persisted_key_id}" ]] || persisted_key_id="master-v1"

  key_supplied=false
  id_supplied=false
  retired_supplied=false
  process_variable_is_set DOLLHOUSE_MASTER_ENCRYPTION_KEY && key_supplied=true
  process_variable_is_set DOLLHOUSE_MASTER_ENCRYPTION_KEY_ID && id_supplied=true
  process_variable_is_set DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED && retired_supplied=true

  if [[ "${key_supplied}" == "true" ]]; then
    target_key="${DOLLHOUSE_MASTER_ENCRYPTION_KEY}"
  elif [[ -n "${persisted_key}" ]]; then
    target_key="${persisted_key}"
  else
    target_key="$(random_base64 32)"
  fi
  if [[ "${id_supplied}" == "true" ]]; then
    target_key_id="${DOLLHOUSE_MASTER_ENCRYPTION_KEY_ID}"
  else
    target_key_id="${persisted_key_id}"
  fi
  if [[ "${retired_supplied}" == "true" ]]; then
    target_retired="${DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED}"
  else
    target_retired="${persisted_retired}"
  fi

  validate_master_key_id "${target_key_id}" "DOLLHOUSE_MASTER_ENCRYPTION_KEY_ID"
  validate_master_key_base64 "${target_key}" "DOLLHOUSE_MASTER_ENCRYPTION_KEY"
  validate_retired_master_keys "${target_retired}" "${target_key_id}"

  if [[ -n "${persisted_key}" ]]; then
    validate_master_key_id "${persisted_key_id}" "persisted DOLLHOUSE_MASTER_ENCRYPTION_KEY_ID"
    validate_master_key_base64 "${persisted_key}" "persisted DOLLHOUSE_MASTER_ENCRYPTION_KEY"
    key_changed=false
    id_changed=false
    [[ "${target_key}" == "${persisted_key}" ]] || key_changed=true
    [[ "${target_key_id}" == "${persisted_key_id}" ]] || id_changed=true
    if [[ "${key_changed}" != "${id_changed}" ]]; then
      die "DOLLHOUSE_MASTER_ENCRYPTION_KEY and DOLLHOUSE_MASTER_ENCRYPTION_KEY_ID must rotate together"
    fi
    if [[ "${key_changed}" == "true" ]] && \
      ! retired_master_keys_contains "${target_retired}" "${persisted_key_id}" "${persisted_key}"; then
      die "master-key rotation requires the previous key '${persisted_key_id}' in DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED"
    fi
  fi

  if process_variable_is_set DOLLHOUSE_SIGNING_KEY_REWRAP_ON_STARTUP; then
    rewrap="${DOLLHOUSE_SIGNING_KEY_REWRAP_ON_STARTUP}"
    [[ "${rewrap}" == "true" || "${rewrap}" == "false" ]] || \
      die "DOLLHOUSE_SIGNING_KEY_REWRAP_ON_STARTUP must be true or false"
    upsert_env_value DOLLHOUSE_SIGNING_KEY_REWRAP_ON_STARTUP "${rewrap}"
  fi

  # The complete envelope-key state is written to the staging file only after
  # every supplied value and transition invariant has passed validation.
  upsert_env_value DOLLHOUSE_MASTER_ENCRYPTION_KEY "${target_key}"
  upsert_env_value DOLLHOUSE_MASTER_ENCRYPTION_KEY_ID "${target_key_id}"
  if [[ "${retired_supplied}" == "true" || -n "${persisted_retired}" ]]; then
    upsert_env_value DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED "${target_retired}"
  fi
}

prompt_env_if_missing() {
  local key="$1"
  local label="$2"
  local secret="${3:-false}"
  local existing
  existing="$(env_value "${key}")"
  if [[ -n "${existing}" ]]; then
    return 0
  fi
  maybe_set_env_from_process "${key}"
  existing="$(env_value "${key}")"
  if [[ -n "${existing}" ]]; then
    return 0
  fi
  if [[ ! -t 0 ]]; then
    warn "${key} is not set; add it to ${ENV_FILE_DISPLAY_PATH:-${ENV_FILE}} before GitHub OAuth sign-in"
    return 0
  fi

  local value
  if [[ "${secret}" == "true" ]]; then
    read -r -s -p "${label}: " value
    printf '\n'
  else
    read -r -p "${label}: " value
  fi
  [[ -n "${value}" ]] || return 0
  upsert_env_value "${key}" "${value}"

  return 0
}

auth_methods_include() {
  local needle="$1"
  local method

  IFS=',' read -r -a methods <<< "${AUTH_METHODS}"
  for method in "${methods[@]}"; do
    if [[ "${method}" == "${needle}" ]]; then
      return 0
    fi
  done

  return 1
}

write_env_defaults_to_staged_file() {
  sync_legacy_env_values
  upsert_env_value DOLLHOUSE_HOSTED_INSTANCE_NAME "${INSTANCE_NAME}"
  upsert_env_value DOLLHOUSE_HOSTED_IMAGE_TAG "${IMAGE_TAG}"
  upsert_env_value DOLLHOUSE_HOSTED_MODE "${DEPLOY_MODE}"
  upsert_env_value DOLLHOUSE_HOSTED_HOSTNAME "${HOSTNAME}"
  upsert_env_value DOLLHOUSE_PUBLIC_BASE_URL "${PUBLIC_BASE_URL}"
  upsert_env_value DOLLHOUSE_HOSTED_PROXY_MODE "${PROXY_MODE}"
  upsert_env_value DOLLHOUSE_HOSTED_BIND_ADDRESS "${BIND_ADDRESS}"
  upsert_env_value DOLLHOUSE_HOSTED_HTTP_BIND_PORT "${HTTP_BIND_PORT}"
  upsert_env_value DOLLHOUSE_HOSTED_HTTPS_BIND_PORT "${HTTPS_BIND_PORT}"
  upsert_env_value DOLLHOUSE_HTTP_PORT "${MCP_PORT}"
  upsert_env_value DOLLHOUSE_HTTP_ALLOWED_HOSTS "${ALLOWED_HOSTS}"
  upsert_env_value DOLLHOUSE_TRUSTED_PROXIES "${TRUSTED_PROXIES}"
  upsert_env_value DOLLHOUSE_HOSTED_CADDY_ACCESS_LOG "${CADDY_ACCESS_LOG}"
  upsert_env_value DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES "${CADDY_TRUSTED_PROXIES}"
  upsert_env_value DOLLHOUSE_HOSTED_DOCKER_LOG_MAX_SIZE "${DOCKER_LOG_MAX_SIZE}"
  upsert_env_value DOLLHOUSE_HOSTED_DOCKER_LOG_MAX_FILE "${DOCKER_LOG_MAX_FILE}"
  upsert_env_value DOLLHOUSE_AUTH_PROVIDER "${AUTH_PROVIDER}"
  upsert_env_value DOLLHOUSE_AUTH_METHODS "${AUTH_METHODS}"
  upsert_env_value DOLLHOUSE_AUTH_OPEN_DCR "${OPEN_DCR}"
  upsert_env_value DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED "${ALLOWLIST_REQUIRED}"
  ensure_env_secret POSTGRES_ADMIN_PASSWORD 24
  ensure_env_secret POSTGRES_PASSWORD 24
  ensure_env_secret DOLLHOUSE_COOKIE_SIGNING_SECRET 32
  ensure_env_secret DOLLHOUSE_INVITE_TOKEN_SECRET 32
  ensure_env_secret DOLLHOUSE_AUDIT_HMAC_SECRET 32
  maybe_set_env_from_process DOLLHOUSE_AUTH_ISSUER
  maybe_set_env_from_process DOLLHOUSE_AUTH_AUDIENCE
  maybe_set_env_from_process DOLLHOUSE_AUTH_JWKS_URI
  maybe_set_env_from_process DOLLHOUSE_AUTH_OIDC_REQUIRE_TYP
  maybe_set_env_from_process DOLLHOUSE_AUTH_ALLOWLIST_SEED_FILE
  apply_auth_generation_from_process
  apply_master_encryption_controls_from_process
  if [[ "${AUTH_PROVIDER}" == "embedded" ]] && auth_methods_include github; then
    prompt_env_if_missing DOLLHOUSE_AUTH_GITHUB_CLIENT_ID "GitHub OAuth client ID" false
    prompt_env_if_missing DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET "GitHub OAuth client secret" true
  fi

  return 0
}

write_env_defaults() {
  local target_env_file staged_env_file target_was_created mark_legacy_import
  target_env_file="${ENV_FILE}"
  target_was_created=false
  mark_legacy_import=false
  [[ -f "${target_env_file}" ]] || target_was_created=true

  if [[ "${IMPORT_LEGACY_ENV}" == "true" && -f "${LEGACY_ENV_FILE}" && ! -f "${LEGACY_IMPORT_MARKER}" ]]; then
    ensure_legacy_env_readable
    mark_legacy_import=true
  fi

  staged_env_file="$(mktemp "${target_env_file}.staged.XXXXXX")"
  if [[ -f "${target_env_file}" ]]; then
    install -m 0600 "${target_env_file}" "${staged_env_file}"
  else
    install -m 0600 /dev/null "${staged_env_file}"
    if [[ "${mark_legacy_import}" == "true" ]]; then
      log "creating ${target_env_file}; selected values will be imported from ${LEGACY_ENV_FILE}"
    else
      log "creating ${target_env_file}"
    fi
  fi

  if ! (
    set -e
    ENV_FILE="${staged_env_file}"
    ENV_FILE_DISPLAY_PATH="${target_env_file}"
    ENV_FILE_CREATED="${target_was_created}"
    write_env_defaults_to_staged_file
  ); then
    rm -f "${staged_env_file}"
    return 1
  fi

  chmod 0600 "${staged_env_file}"
  mv -f "${staged_env_file}" "${target_env_file}"
  ENV_FILE="${target_env_file}"
  if [[ "${mark_legacy_import}" == "true" ]]; then
    date -u +%Y-%m-%dT%H:%M:%SZ > "${LEGACY_IMPORT_MARKER}"
    chmod 0600 "${LEGACY_IMPORT_MARKER}"
  fi

  return 0
}

load_env_file() {
  local line key value loaded_key
  # The empty sentinel keeps `${loaded_keys[@]}` nounset-safe on macOS Bash 3.2.
  local loaded_keys=('')
  if ! cmp -s "${ENV_FILE}" <(LC_ALL=C tr -d '\000' < "${ENV_FILE}"); then
    die "${ENV_FILE} contains a NUL byte"
  fi
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    [[ "${line}" == *=* ]] || die "invalid environment record in ${ENV_FILE}"
    key="${line%%=*}"
    value="${line#*=}"
    [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "invalid environment key in ${ENV_FILE}: ${key}"
    for loaded_key in "${loaded_keys[@]}"; do
      [[ "${loaded_key}" != "${key}" ]] || die "duplicate environment key in ${ENV_FILE}: ${key}"
    done
    loaded_keys+=("${key}")
    printf -v "${key}" '%s' "${value}"
    export "${key?}"
  done < "${ENV_FILE}"

  return 0
}
