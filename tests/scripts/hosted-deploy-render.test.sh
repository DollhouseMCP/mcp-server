#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOSTED_DEPLOY="${REPO_ROOT}/scripts/hosted-deploy.sh"
TMP_ROOT="$(mktemp -d)"

cleanup() {
  if [[ -n "${TMP_ROOT:-}" && -d "${TMP_ROOT}" && "${TMP_ROOT}" == "${TMPDIR:-/tmp}"* ]]; then
    rm -R "${TMP_ROOT}"
  fi
}
trap cleanup EXIT

log() {
  printf '[hosted-deploy-render-test] %s\n' "$*"
}

fail() {
  printf '[hosted-deploy-render-test] error: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  grep -Fq "${expected}" "${file}" || fail "expected ${file} to contain: ${expected}"
}

env_value() {
  local key="$1"
  local file="$2"
  awk -F= -v key="${key}" '$1 == key { value = substr($0, length(key) + 2) } END { print value }' "${file}"
}

set_env_value() {
  local key="$1"
  local value="$2"
  local file="$3"
  local tmp
  tmp="$(mktemp)"
  awk -v key="${key}" -v value="${value}" '
    $0 ~ "^" key "=" {
      print key "=" value
      next
    }
    { print }
  ' "${file}" > "${tmp}"
  mv "${tmp}" "${file}"
}

render_with_dcr() {
  local deploy_dir="$1"
  local dcr_value="$2"

  if [[ -n "${dcr_value}" ]]; then
    DOLLHOUSE_HOSTED_DEPLOY_DIR="${deploy_dir}" \
    DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
    DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client \
    DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret \
    DOLLHOUSE_AUTH_OPEN_DCR="${dcr_value}" \
      bash "${HOSTED_DEPLOY}" render
  else
    DOLLHOUSE_HOSTED_DEPLOY_DIR="${deploy_dir}" \
    DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
    DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client \
    DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret \
      bash "${HOSTED_DEPLOY}" render
  fi
}

DEPLOY_DIR="${TMP_ROOT}/deploy"
ENV_FILE="${DEPLOY_DIR}/.env.production"
COMPOSE_FILE="${DEPLOY_DIR}/compose.yml"
CADDY_FILE="${DEPLOY_DIR}/Caddyfile"
INIT_DB_FILE="${DEPLOY_DIR}/init-db.sh"

log "rendering default alpha configuration"
render_with_dcr "${DEPLOY_DIR}" ""

[[ -f "${ENV_FILE}" ]] || fail "missing ${ENV_FILE}"
[[ -f "${COMPOSE_FILE}" ]] || fail "missing ${COMPOSE_FILE}"
[[ -f "${CADDY_FILE}" ]] || fail "missing ${CADDY_FILE}"
[[ -f "${INIT_DB_FILE}" ]] || fail "missing ${INIT_DB_FILE}"

assert_contains "${COMPOSE_FILE}" 'DOLLHOUSE_AUTH_OPEN_DCR: "true"'
assert_contains "${COMPOSE_FILE}" "DOLLHOUSE_APP_DB_PASSWORD: \${POSTGRES_PASSWORD}"
assert_contains "${COMPOSE_FILE}" "DOLLHOUSE_DATABASE_URL: postgres://dollhouse_app:\${POSTGRES_PASSWORD}@postgres:5432/dollhousemcp"
assert_contains "${COMPOSE_FILE}" "DOLLHOUSE_HTTP_ALLOWED_HOSTS: localhost,127.0.0.1,mcp.example.com"
assert_contains "${COMPOSE_FILE}" "DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED: \${DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED:-true}"
assert_contains "${COMPOSE_FILE}" "dollhousemcp-migrate:"
assert_contains "${COMPOSE_FILE}" "target: builder"
assert_contains "${CADDY_FILE}" 'mcp.example.com {'
assert_contains "${INIT_DB_FILE}" 'CREATE ROLE dollhouse_app'
assert_contains "${INIT_DB_FILE}" 'DOLLHOUSE_APP_DB_PASSWORD'
assert_contains "${ENV_FILE}" 'DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client'
assert_contains "${ENV_FILE}" 'DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret'

first_postgres_password="$(env_value POSTGRES_PASSWORD "${ENV_FILE}")"
first_cookie_secret="$(env_value DOLLHOUSE_COOKIE_SIGNING_SECRET "${ENV_FILE}")"
[[ -n "${first_postgres_password}" ]] || fail "POSTGRES_PASSWORD was not generated"
[[ -n "${first_cookie_secret}" ]] || fail "DOLLHOUSE_COOKIE_SIGNING_SECRET was not generated"
if grep -Fq "${first_postgres_password}" "${INIT_DB_FILE}"; then
  fail "init-db.sh should not contain the generated app database password"
fi

log "rendering stricter DCR override"
render_with_dcr "${DEPLOY_DIR}" "false"
assert_contains "${COMPOSE_FILE}" 'DOLLHOUSE_AUTH_OPEN_DCR: "false"'

second_postgres_password="$(env_value POSTGRES_PASSWORD "${ENV_FILE}")"
second_cookie_secret="$(env_value DOLLHOUSE_COOKIE_SIGNING_SECRET "${ENV_FILE}")"
[[ "${first_postgres_password}" == "${second_postgres_password}" ]] || fail "POSTGRES_PASSWORD changed on re-render"
[[ "${first_cookie_secret}" == "${second_cookie_secret}" ]] || fail "DOLLHOUSE_COOKIE_SIGNING_SECRET changed on re-render"

log "checking legacy .env import for existing deployments"
LEGACY_DEPLOY_DIR="${TMP_ROOT}/legacy-deploy"
mkdir -p "${LEGACY_DEPLOY_DIR}"
cat > "${LEGACY_DEPLOY_DIR}/.env" <<'EOF'
POSTGRES_ADMIN_PASSWORD=legacy-admin-password
POSTGRES_PASSWORD=legacy-app-password
DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=legacy-client
DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=legacy-secret
EOF
cat > "${LEGACY_DEPLOY_DIR}/.env.production" <<'EOF'
POSTGRES_ADMIN_PASSWORD=generated-admin-password
POSTGRES_PASSWORD=generated-app-password
DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=generated-client
DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=generated-secret
EOF
DOLLHOUSE_HOSTED_DEPLOY_DIR="${LEGACY_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  bash "${HOSTED_DEPLOY}" render
[[ "$(env_value POSTGRES_ADMIN_PASSWORD "${LEGACY_DEPLOY_DIR}/.env.production")" == "legacy-admin-password" ]] || \
  fail "legacy POSTGRES_ADMIN_PASSWORD was not imported"
[[ "$(env_value POSTGRES_PASSWORD "${LEGACY_DEPLOY_DIR}/.env.production")" == "legacy-app-password" ]] || \
  fail "legacy POSTGRES_PASSWORD was not imported"
[[ "$(env_value DOLLHOUSE_AUTH_GITHUB_CLIENT_ID "${LEGACY_DEPLOY_DIR}/.env.production")" == "legacy-client" ]] || \
  fail "legacy GitHub client ID was not imported"
[[ "$(env_value DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET "${LEGACY_DEPLOY_DIR}/.env.production")" == "legacy-secret" ]] || \
  fail "legacy GitHub client secret was not imported"
cat > "${LEGACY_DEPLOY_DIR}/.env" <<'EOF'
POSTGRES_ADMIN_PASSWORD=stale-admin-password
POSTGRES_PASSWORD=stale-app-password
DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=stale-client
DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=stale-secret
EOF
set_env_value POSTGRES_PASSWORD "rotated-app-password" "${LEGACY_DEPLOY_DIR}/.env.production"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${LEGACY_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  bash "${HOSTED_DEPLOY}" render
[[ "$(env_value POSTGRES_PASSWORD "${LEGACY_DEPLOY_DIR}/.env.production")" == "rotated-app-password" ]] || \
  fail "legacy import should run only once"

log "checking dry-run render does not write files"
DRY_RUN_DEPLOY_DIR="${TMP_ROOT}/dry-run-deploy"
DRY_RUN_OUTPUT="${TMP_ROOT}/dry-run.out"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${DRY_RUN_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  bash "${HOSTED_DEPLOY}" --dry-run render > "${DRY_RUN_OUTPUT}"
[[ ! -e "${DRY_RUN_DEPLOY_DIR}" ]] || fail "dry-run render should not create ${DRY_RUN_DEPLOY_DIR}"
assert_contains "${DRY_RUN_OUTPUT}" "dry-run: would render deployment files"

log "checking quiet logging mode"
QUIET_OUTPUT="${TMP_ROOT}/quiet.out"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${TMP_ROOT}/quiet-deploy" \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  bash "${HOSTED_DEPLOY}" --quiet --dry-run render > "${QUIET_OUTPUT}"
[[ ! -s "${QUIET_OUTPUT}" ]] || fail "quiet dry-run should not produce normal log output"

log "checking debug logging mode"
DEBUG_OUTPUT="${TMP_ROOT}/debug.out"
DEBUG_ERROR="${TMP_ROOT}/debug.err"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${TMP_ROOT}/debug-deploy" \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  bash "${HOSTED_DEPLOY}" --debug --dry-run render > "${DEBUG_OUTPUT}" 2> "${DEBUG_ERROR}"
assert_contains "${DEBUG_OUTPUT}" "dry-run: would render deployment files"
assert_contains "${DEBUG_ERROR}" "debug: action=render dry_run=true"

log "checking invalid public base URL rejection"
BAD_URL_OUTPUT="${TMP_ROOT}/bad-url.out"
if DOLLHOUSE_HOSTED_DEPLOY_DIR="${TMP_ROOT}/bad-url-deploy" \
  DOLLHOUSE_PUBLIC_BASE_URL=https://mcp.example.com/path \
    bash "${HOSTED_DEPLOY}" --dry-run render > "${BAD_URL_OUTPUT}" 2>&1; then
  fail "dry-run render with path-bearing public URL unexpectedly succeeded"
fi
assert_contains "${BAD_URL_OUTPUT}" "DOLLHOUSE_PUBLIC_BASE_URL must be an origin only"

log "render behavior passed"
