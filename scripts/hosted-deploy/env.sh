# shellcheck shell=bash
# Environment-file and secret helpers for hosted-deploy.

ensure_layout() {
  mkdir -p "${DEPLOY_DIR}" "${DEPLOY_DIR}/portfolio" "${DEPLOY_DIR}/logs"
  chmod 0750 "${DEPLOY_DIR}" "${DEPLOY_DIR}/portfolio" "${DEPLOY_DIR}/logs"
}

random_hex() {
  local bytes="$1"

  if [[ ! "${bytes}" =~ ^[0-9]+$ || "${bytes}" -le 0 ]]; then
    die "random secret byte count must be a positive integer, got: ${bytes}"
  fi

  openssl rand -hex "${bytes}" || die "failed to generate ${bytes} random bytes with openssl"
}

env_value() {
  local key="$1"
  [[ -f "${ENV_FILE}" ]] || return 0
  awk -F= -v key="${key}" '$1 == key { value = substr($0, length(key) + 2) } END { print value }' "${ENV_FILE}"
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
}

ensure_env_file() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    log "creating ${ENV_FILE}"
    install -m 0600 /dev/null "${ENV_FILE}"
  else
    chmod 0600 "${ENV_FILE}"
  fi
}

ensure_env_secret() {
  local key="$1"
  local bytes="$2"
  local existing
  existing="$(env_value "${key}")"
  if [[ -n "${existing}" ]]; then
    return
  fi
  upsert_env_value "${key}" "$(random_hex "${bytes}")"
}

maybe_set_env_from_process() {
  local key="$1"
  local value="${!key:-}"
  local existing
  existing="$(env_value "${key}")"
  if [[ -n "${existing}" || -z "${value}" ]]; then
    return
  fi
  upsert_env_value "${key}" "${value}"
}

prompt_env_if_missing() {
  local key="$1"
  local label="$2"
  local secret="${3:-false}"
  local existing
  existing="$(env_value "${key}")"
  if [[ -n "${existing}" ]]; then
    return
  fi
  maybe_set_env_from_process "${key}"
  existing="$(env_value "${key}")"
  if [[ -n "${existing}" ]]; then
    return
  fi
  if [[ ! -t 0 ]]; then
    warn "${key} is not set; add it to ${ENV_FILE} before GitHub OAuth sign-in"
    return
  fi

  local value
  if [[ "${secret}" == "true" ]]; then
    read -r -s -p "${label}: " value
    printf '\n'
  else
    read -r -p "${label}: " value
  fi
  [[ -n "${value}" ]] || return
  upsert_env_value "${key}" "${value}"
}

write_env_defaults() {
  ensure_env_file
  ensure_env_secret POSTGRES_ADMIN_PASSWORD 24
  ensure_env_secret POSTGRES_PASSWORD 24
  ensure_env_secret DOLLHOUSE_COOKIE_SIGNING_SECRET 32
  ensure_env_secret DOLLHOUSE_INVITE_TOKEN_SECRET 32
  ensure_env_secret DOLLHOUSE_AUDIT_HMAC_SECRET 32
  upsert_env_value DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED "true"
  prompt_env_if_missing DOLLHOUSE_AUTH_GITHUB_CLIENT_ID "GitHub OAuth client ID" false
  prompt_env_if_missing DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET "GitHub OAuth client secret" true
}

load_env_file() {
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
}
