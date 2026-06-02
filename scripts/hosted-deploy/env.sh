# shellcheck shell=bash
# Environment-file and secret helpers for hosted-deploy.

ensure_layout() {
  mkdir -p "${DEPLOY_DIR}" "${DEPLOY_DIR}/portfolio" "${DEPLOY_DIR}/logs"
  chmod 0750 "${DEPLOY_DIR}" "${DEPLOY_DIR}/portfolio" "${DEPLOY_DIR}/logs"

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
  local tmp
  tmp="$(mktemp)"
  awk -v key="${key}" -v value="${value}" '
    BEGIN { replaced = 0 }
    $0 ~ "^" key "=" {
      print key "=" value
      replaced = 1
      next
    }
    { print }
    END {
      if (replaced == 0) {
        print key "=" value
      }
    }
  ' "${ENV_FILE}" > "${tmp}"
  install -m 0600 "${tmp}" "${ENV_FILE}"
  rm -f "${tmp}"

  return 0
}

ensure_env_file() {
  ENV_FILE_CREATED=false
  if [[ ! -f "${ENV_FILE}" ]]; then
    ENV_FILE_CREATED=true
    if [[ "${IMPORT_LEGACY_ENV}" == "true" && -f "${LEGACY_ENV_FILE}" ]]; then
      ensure_legacy_env_readable
      log "creating ${ENV_FILE}; selected values will be imported from ${LEGACY_ENV_FILE}"
      install -m 0600 /dev/null "${ENV_FILE}"
    else
      log "creating ${ENV_FILE}"
      install -m 0600 /dev/null "${ENV_FILE}"
    fi
  else
    chmod 0600 "${ENV_FILE}"
  fi

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
  date -u +%Y-%m-%dT%H:%M:%SZ > "${LEGACY_IMPORT_MARKER}"
  chmod 0600 "${LEGACY_IMPORT_MARKER}"

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
    warn "${key} is not set; add it to ${ENV_FILE} before GitHub OAuth sign-in"
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

write_env_defaults() {
  ensure_env_file
  sync_legacy_env_values
  ensure_env_secret POSTGRES_ADMIN_PASSWORD 24
  ensure_env_secret POSTGRES_PASSWORD 24
  ensure_env_secret DOLLHOUSE_COOKIE_SIGNING_SECRET 32
  ensure_env_secret DOLLHOUSE_INVITE_TOKEN_SECRET 32
  ensure_env_secret DOLLHOUSE_AUDIT_HMAC_SECRET 32
  upsert_env_value DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED "true"
  prompt_env_if_missing DOLLHOUSE_AUTH_GITHUB_CLIENT_ID "GitHub OAuth client ID" false
  prompt_env_if_missing DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET "GitHub OAuth client secret" true

  return 0
}

load_env_file() {
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a

  return 0
}
