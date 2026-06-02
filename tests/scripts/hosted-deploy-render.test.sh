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
assert_contains "${COMPOSE_FILE}" "DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED: \${DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED:-true}"
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

log "render behavior passed"
