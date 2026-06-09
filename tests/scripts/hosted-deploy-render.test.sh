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

assert_line() {
  local file="$1"
  local expected="$2"
  grep -Fxq "${expected}" "${file}" || fail "expected ${file} to contain line: ${expected}"
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -Fq "${unexpected}" "${file}"; then
    fail "expected ${file} not to contain: ${unexpected}"
  fi
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

assert_line "${COMPOSE_FILE}" 'name: deploy'
assert_line "${COMPOSE_FILE}" '    container_name: deploy-postgres'
assert_line "${COMPOSE_FILE}" '    container_name: deploy'
assert_line "${COMPOSE_FILE}" '    container_name: deploy-caddy'
assert_contains "${COMPOSE_FILE}" 'image: deploy-hosted:alpha'
assert_contains "${COMPOSE_FILE}" 'image: deploy-hosted:alpha-migrate'
assert_contains "${COMPOSE_FILE}" 'DOLLHOUSE_AUTH_OPEN_DCR: "true"'
assert_contains "${COMPOSE_FILE}" "DOLLHOUSE_APP_DB_PASSWORD: \${POSTGRES_PASSWORD}"
assert_contains "${COMPOSE_FILE}" "DOLLHOUSE_DATABASE_URL: postgres://dollhouse_app:\${POSTGRES_PASSWORD}@postgres:5432/dollhousemcp"
assert_contains "${COMPOSE_FILE}" "DOLLHOUSE_HTTP_ALLOWED_HOSTS: localhost,127.0.0.1,mcp.example.com"
assert_contains "${COMPOSE_FILE}" "DOLLHOUSE_TRUSTED_PROXIES: 172.16.0.0/12"
assert_contains "${COMPOSE_FILE}" 'DOLLHOUSE_UNSAFE_NO_TLS: "true"'
assert_contains "${COMPOSE_FILE}" 'DOLLHOUSE_AUTH_PROVIDER: embedded'
assert_contains "${COMPOSE_FILE}" 'DOLLHOUSE_AUTH_METHODS: "github"'
assert_contains "${COMPOSE_FILE}" 'DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED: "true"'
assert_contains "${COMPOSE_FILE}" '      - "0.0.0.0:80:80"'
assert_contains "${COMPOSE_FILE}" '      - "0.0.0.0:443:443"'
assert_contains "${COMPOSE_FILE}" "dollhousemcp-migrate:"
assert_contains "${COMPOSE_FILE}" "target: builder"
assert_contains "${CADDY_FILE}" 'mcp.example.com {'
assert_contains "${CADDY_FILE}" '    log {'
assert_contains "${CADDY_FILE}" '            request>uri query {'
assert_contains "${CADDY_FILE}" '                replace code REDACTED'
assert_contains "${CADDY_FILE}" '                replace state REDACTED'
assert_contains "${CADDY_FILE}" '            request>headers>Authorization delete'
assert_contains "${CADDY_FILE}" '        header_up X-Forwarded-For {client_ip}'
assert_contains "${CADDY_FILE}" '        header_up X-Real-IP {client_ip}'
assert_not_contains "${CADDY_FILE}" 'trusted_proxies static'
assert_contains "${INIT_DB_FILE}" 'CREATE ROLE dollhouse_app'
assert_contains "${INIT_DB_FILE}" 'DOLLHOUSE_APP_DB_PASSWORD'
assert_contains "${ENV_FILE}" 'DOLLHOUSE_HOSTED_MODE=cloud'
assert_contains "${ENV_FILE}" 'DOLLHOUSE_HOSTED_INSTANCE_NAME=deploy'
assert_contains "${ENV_FILE}" 'DOLLHOUSE_HOSTED_IMAGE_TAG=deploy-hosted:alpha'
assert_contains "${ENV_FILE}" 'DOLLHOUSE_HOSTED_PROXY_MODE=caddy-tls'
assert_contains "${ENV_FILE}" 'DOLLHOUSE_HOSTED_BIND_ADDRESS=0.0.0.0'
assert_contains "${ENV_FILE}" 'DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com'
assert_contains "${ENV_FILE}" 'DOLLHOUSE_PUBLIC_BASE_URL=https://mcp.example.com'
assert_contains "${ENV_FILE}" 'DOLLHOUSE_HOSTED_CADDY_ACCESS_LOG=true'
assert_contains "${ENV_FILE}" 'DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES='
assert_contains "${ENV_FILE}" 'DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client'
assert_contains "${ENV_FILE}" 'DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret'

first_postgres_password="$(env_value POSTGRES_PASSWORD "${ENV_FILE}")"
first_cookie_secret="$(env_value DOLLHOUSE_COOKIE_SIGNING_SECRET "${ENV_FILE}")"
first_master_key="$(env_value DOLLHOUSE_MASTER_ENCRYPTION_KEY "${ENV_FILE}")"
[[ -n "${first_postgres_password}" ]] || fail "POSTGRES_PASSWORD was not generated"
[[ -n "${first_cookie_secret}" ]] || fail "DOLLHOUSE_COOKIE_SIGNING_SECRET was not generated"
[[ -n "${first_master_key}" ]] || fail "DOLLHOUSE_MASTER_ENCRYPTION_KEY was not generated"
[[ "${#first_master_key}" == "44" ]] || fail "DOLLHOUSE_MASTER_ENCRYPTION_KEY should be a 32-byte base64 value"
if [[ ! "${first_master_key}" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]; then
  fail "DOLLHOUSE_MASTER_ENCRYPTION_KEY should be base64"
fi
if grep -Fq "${first_postgres_password}" "${INIT_DB_FILE}"; then
  fail "init-db.sh should not contain the generated app database password"
fi

log "rendering stricter DCR override"
render_with_dcr "${DEPLOY_DIR}" "false"
assert_contains "${COMPOSE_FILE}" 'DOLLHOUSE_AUTH_OPEN_DCR: "false"'

log "rendering cloud configuration behind Cloudflare"
CLOUDFLARE_DEPLOY_DIR="${TMP_ROOT}/cloudflare-deploy"
CLOUDFLARE_ENV_FILE="${CLOUDFLARE_DEPLOY_DIR}/.env.production"
CLOUDFLARE_CADDY_FILE="${CLOUDFLARE_DEPLOY_DIR}/Caddyfile"
CLOUDFLARE_SAMPLE_CIDRS="173.245.48.0/20,103.21.244.0/22,2400:cb00::/32,2a06:98c0::/29"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${CLOUDFLARE_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client \
DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret \
DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES="${CLOUDFLARE_SAMPLE_CIDRS}" \
  bash "${HOSTED_DEPLOY}" render
assert_contains "${CLOUDFLARE_CADDY_FILE}" '{'
assert_contains "${CLOUDFLARE_CADDY_FILE}" '        trusted_proxies static 173.245.48.0/20 103.21.244.0/22 2400:cb00::/32 2a06:98c0::/29'
assert_contains "${CLOUDFLARE_CADDY_FILE}" '        trusted_proxies_strict'
assert_contains "${CLOUDFLARE_CADDY_FILE}" '    log {'
assert_contains "${CLOUDFLARE_ENV_FILE}" 'DOLLHOUSE_HOSTED_CADDY_ACCESS_LOG=true'
assert_contains "${CLOUDFLARE_ENV_FILE}" "DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES=${CLOUDFLARE_SAMPLE_CIDRS}"

log "checking restated proxy mode preserves persisted Cloudflare edge CIDRs"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${CLOUDFLARE_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_PROXY_MODE=caddy-tls \
  bash "${HOSTED_DEPLOY}" render
assert_contains "${CLOUDFLARE_CADDY_FILE}" '        trusted_proxies static 173.245.48.0/20 103.21.244.0/22 2400:cb00::/32 2a06:98c0::/29'
assert_contains "${CLOUDFLARE_ENV_FILE}" "DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES=${CLOUDFLARE_SAMPLE_CIDRS}"

log "checking Caddy trusted proxy CIDR validation"
CADDY_BAD_CIDR_OUTPUT="${TMP_ROOT}/caddy-bad-cidr.out"
if DOLLHOUSE_HOSTED_DEPLOY_DIR="${TMP_ROOT}/caddy-bad-cidr-deploy" \
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client \
  DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret \
  DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES='173.245.48.0/20,{bad}' \
    bash "${HOSTED_DEPLOY}" --dry-run render > "${CADDY_BAD_CIDR_OUTPUT}" 2>&1; then
  fail "Caddy trusted proxy render with invalid CIDR unexpectedly succeeded"
fi
assert_contains "${CADDY_BAD_CIDR_OUTPUT}" "DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES must be a comma-separated CIDR list"

log "checking Caddy trusted proxy prefix validation"
CADDY_BAD_PREFIX_OUTPUT="${TMP_ROOT}/caddy-bad-prefix.out"
if DOLLHOUSE_HOSTED_DEPLOY_DIR="${TMP_ROOT}/caddy-bad-prefix-deploy" \
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client \
  DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret \
  DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES='173.245.48.0/999' \
    bash "${HOSTED_DEPLOY}" --dry-run render > "${CADDY_BAD_PREFIX_OUTPUT}" 2>&1; then
  fail "Caddy trusted proxy render with invalid prefix length unexpectedly succeeded"
fi
assert_contains "${CADDY_BAD_PREFIX_OUTPUT}" "DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES contains an invalid CIDR entry: 173.245.48.0/999"

log "checking in-place instance rename rejection"
INSTANCE_RENAME_OUTPUT="${TMP_ROOT}/instance-rename.out"
if DOLLHOUSE_HOSTED_DEPLOY_DIR="${DEPLOY_DIR}" \
  DOLLHOUSE_HOSTED_INSTANCE_NAME=renamed-deploy \
    bash "${HOSTED_DEPLOY}" --dry-run render > "${INSTANCE_RENAME_OUTPUT}" 2>&1; then
  fail "in-place instance rename unexpectedly succeeded"
fi
assert_contains "${INSTANCE_RENAME_OUTPUT}" "cannot rename deployment instance in-place"
assert_contains "${INSTANCE_RENAME_OUTPUT}" "DOLLHOUSE_HOSTED_INSTANCE_NAME=deploy"

second_postgres_password="$(env_value POSTGRES_PASSWORD "${ENV_FILE}")"
second_cookie_secret="$(env_value DOLLHOUSE_COOKIE_SIGNING_SECRET "${ENV_FILE}")"
second_master_key="$(env_value DOLLHOUSE_MASTER_ENCRYPTION_KEY "${ENV_FILE}")"
[[ "${first_postgres_password}" == "${second_postgres_password}" ]] || fail "POSTGRES_PASSWORD changed on re-render"
[[ "${first_cookie_secret}" == "${second_cookie_secret}" ]] || fail "DOLLHOUSE_COOKIE_SIGNING_SECRET changed on re-render"
[[ "${first_master_key}" == "${second_master_key}" ]] || fail "DOLLHOUSE_MASTER_ENCRYPTION_KEY changed on re-render"

log "rendering side-by-side canary with derived instance names"
CANARY_DEPLOY_DIR="${TMP_ROOT}/dollhousemcp-canary"
CANARY_ENV_FILE="${CANARY_DEPLOY_DIR}/.env.production"
CANARY_COMPOSE_FILE="${CANARY_DEPLOY_DIR}/compose.yml"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${CANARY_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_MODE=lan \
DOLLHOUSE_HOSTED_HOSTNAME=canary.local \
DOLLHOUSE_HOSTED_HTTP_BIND_PORT=3100 \
DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client \
DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret \
  bash "${HOSTED_DEPLOY}" render
assert_line "${CANARY_COMPOSE_FILE}" 'name: dollhousemcp-canary'
assert_line "${CANARY_COMPOSE_FILE}" '    container_name: dollhousemcp-canary-postgres'
assert_line "${CANARY_COMPOSE_FILE}" '    container_name: dollhousemcp-canary'
assert_line "${CANARY_COMPOSE_FILE}" '    container_name: dollhousemcp-canary-caddy'
assert_contains "${CANARY_COMPOSE_FILE}" 'image: dollhousemcp-canary-hosted:alpha'
assert_contains "${CANARY_COMPOSE_FILE}" 'image: dollhousemcp-canary-hosted:alpha-migrate'
assert_contains "${CANARY_COMPOSE_FILE}" 'DOLLHOUSE_PUBLIC_BASE_URL: http://canary.local:3100'
assert_contains "${CANARY_COMPOSE_FILE}" '      - "127.0.0.1:3100:3100"'
assert_contains "${CANARY_ENV_FILE}" 'DOLLHOUSE_HOSTED_INSTANCE_NAME=dollhousemcp-canary'
assert_contains "${CANARY_ENV_FILE}" 'DOLLHOUSE_HOSTED_IMAGE_TAG=dollhousemcp-canary-hosted:alpha'

log "rendering local/LAN configuration"
LAN_DEPLOY_DIR="${TMP_ROOT}/lan-deploy"
LAN_ENV_FILE="${LAN_DEPLOY_DIR}/.env.production"
LAN_COMPOSE_FILE="${LAN_DEPLOY_DIR}/compose.yml"
LAN_CADDY_FILE="${LAN_DEPLOY_DIR}/Caddyfile"
LAN_PUBLIC_BASE_URL_LINE='DOLLHOUSE_PUBLIC_BASE_URL: http://lanbox.local:3000'
LAN_LOOPBACK_PORT_MAPPING='      - "127.0.0.1:3000:3000"'
LAN_CADDY_SITE='http://lanbox.local:3000 {'
DOLLHOUSE_HOSTED_DEPLOY_DIR="${LAN_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_MODE=lan \
DOLLHOUSE_HOSTED_HOSTNAME=lanbox.local \
DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client \
DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret \
  bash "${HOSTED_DEPLOY}" render
assert_contains "${LAN_COMPOSE_FILE}" "${LAN_PUBLIC_BASE_URL_LINE}"
assert_contains "${LAN_COMPOSE_FILE}" 'DOLLHOUSE_UNSAFE_NO_TLS: "true"'
assert_contains "${LAN_COMPOSE_FILE}" 'DOLLHOUSE_AUTH_PROVIDER: embedded'
assert_contains "${LAN_COMPOSE_FILE}" 'DOLLHOUSE_AUTH_METHODS: "github"'
assert_contains "${LAN_COMPOSE_FILE}" 'DOLLHOUSE_AUTH_OPEN_DCR: "false"'
assert_contains "${LAN_COMPOSE_FILE}" 'DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED: "true"'
assert_contains "${LAN_COMPOSE_FILE}" "${LAN_LOOPBACK_PORT_MAPPING}"
assert_contains "${LAN_CADDY_FILE}" "${LAN_CADDY_SITE}"
assert_not_contains "${LAN_CADDY_FILE}" '    log {'
assert_contains "${LAN_CADDY_FILE}" 'header_up X-Forwarded-Proto http'
assert_contains "${LAN_ENV_FILE}" 'DOLLHOUSE_HOSTED_MODE=lan'
assert_contains "${LAN_ENV_FILE}" 'DOLLHOUSE_HOSTED_PROXY_MODE=caddy-http'
assert_contains "${LAN_ENV_FILE}" 'DOLLHOUSE_HOSTED_BIND_ADDRESS=127.0.0.1'
assert_contains "${LAN_ENV_FILE}" 'DOLLHOUSE_HOSTED_CADDY_ACCESS_LOG=false'
assert_contains "${LAN_ENV_FILE}" 'DOLLHOUSE_AUTH_OPEN_DCR=false'

log "checking LAN deployment mode persists on re-render"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${LAN_DEPLOY_DIR}" \
  bash "${HOSTED_DEPLOY}" render
assert_contains "${LAN_COMPOSE_FILE}" "${LAN_PUBLIC_BASE_URL_LINE}"
assert_contains "${LAN_COMPOSE_FILE}" "${LAN_LOOPBACK_PORT_MAPPING}"
assert_contains "${LAN_CADDY_FILE}" "${LAN_CADDY_SITE}"

log "checking empty mode env preserves persisted deployment mode"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${LAN_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_MODE='' \
  bash "${HOSTED_DEPLOY}" render
assert_contains "${LAN_COMPOSE_FILE}" "${LAN_PUBLIC_BASE_URL_LINE}"
assert_contains "${LAN_COMPOSE_FILE}" "${LAN_LOOPBACK_PORT_MAPPING}"
assert_contains "${LAN_CADDY_FILE}" "${LAN_CADDY_SITE}"
assert_contains "${LAN_ENV_FILE}" 'DOLLHOUSE_HOSTED_MODE=lan'

log "checking empty hostname env preserves persisted hostname"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${LAN_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_HOSTNAME='' \
  bash "${HOSTED_DEPLOY}" render
assert_contains "${LAN_COMPOSE_FILE}" "${LAN_PUBLIC_BASE_URL_LINE}"
assert_contains "${LAN_COMPOSE_FILE}" "${LAN_LOOPBACK_PORT_MAPPING}"
assert_contains "${LAN_CADDY_FILE}" "${LAN_CADDY_SITE}"
assert_contains "${LAN_ENV_FILE}" 'DOLLHOUSE_HOSTED_HOSTNAME=lanbox.local'

log "checking explicit mode switch recomputes dependent defaults"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${LAN_DEPLOY_DIR}" \
  bash "${HOSTED_DEPLOY}" --mode enterprise render
assert_contains "${LAN_COMPOSE_FILE}" 'DOLLHOUSE_PUBLIC_BASE_URL: https://lanbox.local'
assert_contains "${LAN_COMPOSE_FILE}" '      - "0.0.0.0:80:80"'
assert_contains "${LAN_COMPOSE_FILE}" '      - "0.0.0.0:443:443"'
assert_contains "${LAN_CADDY_FILE}" 'lanbox.local {'
assert_not_contains "${LAN_CADDY_FILE}" "${LAN_CADDY_SITE}"
assert_contains "${LAN_ENV_FILE}" 'DOLLHOUSE_HOSTED_MODE=enterprise'
assert_contains "${LAN_ENV_FILE}" 'DOLLHOUSE_HOSTED_PROXY_MODE=caddy-tls'
assert_contains "${LAN_ENV_FILE}" 'DOLLHOUSE_HOSTED_BIND_ADDRESS=0.0.0.0'
assert_contains "${LAN_ENV_FILE}" 'DOLLHOUSE_PUBLIC_BASE_URL=https://lanbox.local'

log "checking explicit public URL switch derives hostname"
LAN_URL_SWITCH_DEPLOY_DIR="${TMP_ROOT}/lan-url-switch-deploy"
LAN_URL_SWITCH_ENV_FILE="${LAN_URL_SWITCH_DEPLOY_DIR}/.env.production"
LAN_URL_SWITCH_COMPOSE_FILE="${LAN_URL_SWITCH_DEPLOY_DIR}/compose.yml"
LAN_URL_SWITCH_CADDY_FILE="${LAN_URL_SWITCH_DEPLOY_DIR}/Caddyfile"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${LAN_URL_SWITCH_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_MODE=lan \
DOLLHOUSE_HOSTED_HOSTNAME=lanbox.local \
DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client \
DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret \
  bash "${HOSTED_DEPLOY}" render
DOLLHOUSE_HOSTED_DEPLOY_DIR="${LAN_URL_SWITCH_DEPLOY_DIR}" \
DOLLHOUSE_PUBLIC_BASE_URL=https://mcp.enterprise.test \
  bash "${HOSTED_DEPLOY}" --mode enterprise render
assert_contains "${LAN_URL_SWITCH_COMPOSE_FILE}" 'DOLLHOUSE_PUBLIC_BASE_URL: https://mcp.enterprise.test'
assert_contains "${LAN_URL_SWITCH_CADDY_FILE}" 'mcp.enterprise.test {'
assert_not_contains "${LAN_URL_SWITCH_CADDY_FILE}" 'lanbox.local {'
assert_contains "${LAN_URL_SWITCH_ENV_FILE}" 'DOLLHOUSE_HOSTED_HOSTNAME=mcp.enterprise.test'
assert_contains "${LAN_URL_SWITCH_ENV_FILE}" 'DOLLHOUSE_PUBLIC_BASE_URL=https://mcp.enterprise.test'
assert_contains "${LAN_URL_SWITCH_ENV_FILE}" 'DOLLHOUSE_HOSTED_PROXY_MODE=caddy-tls'
assert_contains "${LAN_URL_SWITCH_ENV_FILE}" 'DOLLHOUSE_HOSTED_BIND_ADDRESS=0.0.0.0'

log "checking explicit LAN public URL port drives HTTP bind port"
LAN_URL_PORT_DEPLOY_DIR="${TMP_ROOT}/lan-url-port-deploy"
LAN_URL_PORT_ENV_FILE="${LAN_URL_PORT_DEPLOY_DIR}/.env.production"
LAN_URL_PORT_COMPOSE_FILE="${LAN_URL_PORT_DEPLOY_DIR}/compose.yml"
LAN_URL_PORT_CADDY_FILE="${LAN_URL_PORT_DEPLOY_DIR}/Caddyfile"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${LAN_URL_PORT_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_MODE=lan \
DOLLHOUSE_PUBLIC_BASE_URL=http://lanbox.local:3100 \
DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client \
DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret \
  bash "${HOSTED_DEPLOY}" render
assert_contains "${LAN_URL_PORT_COMPOSE_FILE}" 'DOLLHOUSE_PUBLIC_BASE_URL: http://lanbox.local:3100'
assert_contains "${LAN_URL_PORT_COMPOSE_FILE}" '      - "127.0.0.1:3100:3100"'
assert_contains "${LAN_URL_PORT_CADDY_FILE}" 'http://lanbox.local:3100 {'
assert_contains "${LAN_URL_PORT_ENV_FILE}" 'DOLLHOUSE_HOSTED_HOSTNAME=lanbox.local'
assert_contains "${LAN_URL_PORT_ENV_FILE}" 'DOLLHOUSE_HOSTED_HTTP_BIND_PORT=3100'

log "checking explicit LAN public URL default port drives HTTP bind port"
LAN_URL_DEFAULT_PORT_DEPLOY_DIR="${TMP_ROOT}/lan-url-default-port-deploy"
LAN_URL_DEFAULT_PORT_ENV_FILE="${LAN_URL_DEFAULT_PORT_DEPLOY_DIR}/.env.production"
LAN_URL_DEFAULT_PORT_COMPOSE_FILE="${LAN_URL_DEFAULT_PORT_DEPLOY_DIR}/compose.yml"
LAN_URL_DEFAULT_PORT_CADDY_FILE="${LAN_URL_DEFAULT_PORT_DEPLOY_DIR}/Caddyfile"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${LAN_URL_DEFAULT_PORT_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_MODE=lan \
DOLLHOUSE_PUBLIC_BASE_URL=http://lanbox.local \
DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client \
DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret \
  bash "${HOSTED_DEPLOY}" render
assert_contains "${LAN_URL_DEFAULT_PORT_COMPOSE_FILE}" 'DOLLHOUSE_PUBLIC_BASE_URL: http://lanbox.local'
assert_contains "${LAN_URL_DEFAULT_PORT_COMPOSE_FILE}" '      - "127.0.0.1:80:80"'
assert_contains "${LAN_URL_DEFAULT_PORT_CADDY_FILE}" 'http://lanbox.local:80 {'
assert_contains "${LAN_URL_DEFAULT_PORT_ENV_FILE}" 'DOLLHOUSE_HOSTED_HTTP_BIND_PORT=80'

log "checking explicit enterprise public URL port drives HTTPS bind port"
ENTERPRISE_URL_PORT_DEPLOY_DIR="${TMP_ROOT}/enterprise-url-port-deploy"
ENTERPRISE_URL_PORT_ENV_FILE="${ENTERPRISE_URL_PORT_DEPLOY_DIR}/.env.production"
ENTERPRISE_URL_PORT_COMPOSE_FILE="${ENTERPRISE_URL_PORT_DEPLOY_DIR}/compose.yml"
ENTERPRISE_URL_PORT_CADDY_FILE="${ENTERPRISE_URL_PORT_DEPLOY_DIR}/Caddyfile"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${ENTERPRISE_URL_PORT_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_MODE=enterprise \
DOLLHOUSE_PUBLIC_BASE_URL=https://mcp.enterprise.test:8443 \
DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client \
DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret \
  bash "${HOSTED_DEPLOY}" render
assert_contains "${ENTERPRISE_URL_PORT_COMPOSE_FILE}" 'DOLLHOUSE_PUBLIC_BASE_URL: https://mcp.enterprise.test:8443'
assert_contains "${ENTERPRISE_URL_PORT_COMPOSE_FILE}" '      - "0.0.0.0:8443:443"'
assert_contains "${ENTERPRISE_URL_PORT_CADDY_FILE}" 'mcp.enterprise.test {'
assert_contains "${ENTERPRISE_URL_PORT_ENV_FILE}" 'DOLLHOUSE_HOSTED_HOSTNAME=mcp.enterprise.test'
assert_contains "${ENTERPRISE_URL_PORT_ENV_FILE}" 'DOLLHOUSE_HOSTED_HTTPS_BIND_PORT=8443'

log "checking public URL scheme must match proxy mode"
LAN_URL_SCHEME_OUTPUT="${TMP_ROOT}/lan-url-scheme.out"
if DOLLHOUSE_HOSTED_DEPLOY_DIR="${TMP_ROOT}/lan-url-scheme-deploy" \
  DOLLHOUSE_HOSTED_MODE=lan \
  DOLLHOUSE_PUBLIC_BASE_URL=https://lanbox.local \
  DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client \
  DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret \
    bash "${HOSTED_DEPLOY}" --dry-run render > "${LAN_URL_SCHEME_OUTPUT}" 2>&1; then
  fail "LAN render with HTTPS public URL unexpectedly succeeded"
fi
assert_contains "${LAN_URL_SCHEME_OUTPUT}" "DOLLHOUSE_PUBLIC_BASE_URL must use http:// when DOLLHOUSE_HOSTED_PROXY_MODE=caddy-http"

log "checking explicit hostname switch derives public URL and allowed hosts"
LAN_HOST_SWITCH_DEPLOY_DIR="${TMP_ROOT}/lan-host-switch-deploy"
LAN_HOST_SWITCH_ENV_FILE="${LAN_HOST_SWITCH_DEPLOY_DIR}/.env.production"
LAN_HOST_SWITCH_COMPOSE_FILE="${LAN_HOST_SWITCH_DEPLOY_DIR}/compose.yml"
LAN_HOST_SWITCH_CADDY_FILE="${LAN_HOST_SWITCH_DEPLOY_DIR}/Caddyfile"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${LAN_HOST_SWITCH_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_MODE=lan \
DOLLHOUSE_HOSTED_HOSTNAME=oldbox.local \
DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client \
DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret \
  bash "${HOSTED_DEPLOY}" render
DOLLHOUSE_HOSTED_DEPLOY_DIR="${LAN_HOST_SWITCH_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_HOSTNAME=newbox.local \
  bash "${HOSTED_DEPLOY}" render
assert_contains "${LAN_HOST_SWITCH_COMPOSE_FILE}" 'DOLLHOUSE_PUBLIC_BASE_URL: http://newbox.local:3000'
assert_contains "${LAN_HOST_SWITCH_COMPOSE_FILE}" 'DOLLHOUSE_HTTP_ALLOWED_HOSTS: localhost,127.0.0.1,newbox.local'
assert_contains "${LAN_HOST_SWITCH_CADDY_FILE}" 'http://newbox.local:3000 {'
assert_not_contains "${LAN_HOST_SWITCH_CADDY_FILE}" 'http://oldbox.local:3000 {'
assert_contains "${LAN_HOST_SWITCH_ENV_FILE}" 'DOLLHOUSE_HOSTED_HOSTNAME=newbox.local'
assert_contains "${LAN_HOST_SWITCH_ENV_FILE}" 'DOLLHOUSE_PUBLIC_BASE_URL=http://newbox.local:3000'
assert_contains "${LAN_HOST_SWITCH_ENV_FILE}" 'DOLLHOUSE_HTTP_ALLOWED_HOSTS=localhost,127.0.0.1,newbox.local'

log "checking explicit auth provider switch recomputes auth methods"
AUTH_PROVIDER_SWITCH_DEPLOY_DIR="${TMP_ROOT}/auth-provider-switch-deploy"
AUTH_PROVIDER_SWITCH_ENV_FILE="${AUTH_PROVIDER_SWITCH_DEPLOY_DIR}/.env.production"
AUTH_PROVIDER_SWITCH_COMPOSE_FILE="${AUTH_PROVIDER_SWITCH_DEPLOY_DIR}/compose.yml"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${AUTH_PROVIDER_SWITCH_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_MODE=enterprise \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.enterprise.test \
DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client \
DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret \
  bash "${HOSTED_DEPLOY}" render
DOLLHOUSE_HOSTED_DEPLOY_DIR="${AUTH_PROVIDER_SWITCH_DEPLOY_DIR}" \
DOLLHOUSE_AUTH_PROVIDER=oidc \
DOLLHOUSE_AUTH_ISSUER=https://idp.enterprise.test \
DOLLHOUSE_AUTH_AUDIENCE=dollhouse-mcp \
  bash "${HOSTED_DEPLOY}" render
assert_contains "${AUTH_PROVIDER_SWITCH_COMPOSE_FILE}" 'DOLLHOUSE_AUTH_PROVIDER: oidc'
assert_contains "${AUTH_PROVIDER_SWITCH_COMPOSE_FILE}" 'DOLLHOUSE_AUTH_METHODS: ""'
assert_contains "${AUTH_PROVIDER_SWITCH_ENV_FILE}" 'DOLLHOUSE_AUTH_PROVIDER=oidc'
assert_contains "${AUTH_PROVIDER_SWITCH_ENV_FILE}" 'DOLLHOUSE_AUTH_METHODS='
assert_contains "${AUTH_PROVIDER_SWITCH_ENV_FILE}" 'DOLLHOUSE_AUTH_ISSUER=https://idp.enterprise.test'
assert_contains "${AUTH_PROVIDER_SWITCH_ENV_FILE}" 'DOLLHOUSE_AUTH_AUDIENCE=dollhouse-mcp'

log "checking restated mode preserves persisted dependent settings"
RESTATED_MODE_DEPLOY_DIR="${TMP_ROOT}/restated-mode-deploy"
RESTATED_MODE_ENV_FILE="${RESTATED_MODE_DEPLOY_DIR}/.env.production"
RESTATED_MODE_COMPOSE_FILE="${RESTATED_MODE_DEPLOY_DIR}/compose.yml"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${RESTATED_MODE_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_MODE=enterprise \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.enterprise.test \
DOLLHOUSE_HOSTED_BIND_ADDRESS=127.0.0.1 \
DOLLHOUSE_HOSTED_HTTP_BIND_PORT=8080 \
DOLLHOUSE_HOSTED_HTTPS_BIND_PORT=8443 \
DOLLHOUSE_AUTH_PROVIDER=oidc \
DOLLHOUSE_AUTH_METHODS='' \
DOLLHOUSE_AUTH_ISSUER=https://idp.enterprise.test \
DOLLHOUSE_AUTH_AUDIENCE=dollhouse-mcp \
  bash "${HOSTED_DEPLOY}" render
DOLLHOUSE_HOSTED_DEPLOY_DIR="${RESTATED_MODE_DEPLOY_DIR}" \
  bash "${HOSTED_DEPLOY}" --mode enterprise render
assert_contains "${RESTATED_MODE_COMPOSE_FILE}" 'DOLLHOUSE_PUBLIC_BASE_URL: https://mcp.enterprise.test:8443'
assert_contains "${RESTATED_MODE_COMPOSE_FILE}" 'DOLLHOUSE_AUTH_PROVIDER: oidc'
assert_contains "${RESTATED_MODE_COMPOSE_FILE}" 'DOLLHOUSE_AUTH_METHODS: ""'
assert_contains "${RESTATED_MODE_COMPOSE_FILE}" '      - "127.0.0.1:8080:80"'
assert_contains "${RESTATED_MODE_COMPOSE_FILE}" '      - "127.0.0.1:8443:443"'
assert_contains "${RESTATED_MODE_ENV_FILE}" 'DOLLHOUSE_HOSTED_MODE=enterprise'
assert_contains "${RESTATED_MODE_ENV_FILE}" 'DOLLHOUSE_HOSTED_BIND_ADDRESS=127.0.0.1'
assert_contains "${RESTATED_MODE_ENV_FILE}" 'DOLLHOUSE_HOSTED_HTTP_BIND_PORT=8080'
assert_contains "${RESTATED_MODE_ENV_FILE}" 'DOLLHOUSE_HOSTED_HTTPS_BIND_PORT=8443'
assert_contains "${RESTATED_MODE_ENV_FILE}" 'DOLLHOUSE_AUTH_PROVIDER=oidc'
assert_contains "${RESTATED_MODE_ENV_FILE}" 'DOLLHOUSE_AUTH_METHODS='

log "rendering LAN configuration exposed on a network interface"
LAN_EXPOSED_DEPLOY_DIR="${TMP_ROOT}/lan-exposed-deploy"
LAN_EXPOSED_COMPOSE_FILE="${LAN_EXPOSED_DEPLOY_DIR}/compose.yml"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${LAN_EXPOSED_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_MODE=lan \
DOLLHOUSE_HOSTED_HOSTNAME=lanbox.local \
DOLLHOUSE_HOSTED_BIND_ADDRESS=0.0.0.0 \
DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client \
DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret \
  bash "${HOSTED_DEPLOY}" render
assert_contains "${LAN_EXPOSED_COMPOSE_FILE}" '      - "0.0.0.0:3000:3000"'

log "rendering enterprise OIDC configuration"
ENTERPRISE_DEPLOY_DIR="${TMP_ROOT}/enterprise-deploy"
ENTERPRISE_ENV_FILE="${ENTERPRISE_DEPLOY_DIR}/.env.production"
ENTERPRISE_COMPOSE_FILE="${ENTERPRISE_DEPLOY_DIR}/compose.yml"
ENTERPRISE_CADDY_FILE="${ENTERPRISE_DEPLOY_DIR}/Caddyfile"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${ENTERPRISE_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_MODE=enterprise \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.enterprise.test \
DOLLHOUSE_AUTH_PROVIDER=oidc \
DOLLHOUSE_AUTH_METHODS='' \
DOLLHOUSE_AUTH_ISSUER=https://idp.enterprise.test \
DOLLHOUSE_AUTH_AUDIENCE=dollhouse-mcp \
  bash "${HOSTED_DEPLOY}" render
assert_contains "${ENTERPRISE_COMPOSE_FILE}" 'DOLLHOUSE_PUBLIC_BASE_URL: https://mcp.enterprise.test'
assert_contains "${ENTERPRISE_COMPOSE_FILE}" 'DOLLHOUSE_UNSAFE_NO_TLS: "true"'
assert_contains "${ENTERPRISE_COMPOSE_FILE}" 'DOLLHOUSE_AUTH_PROVIDER: oidc'
assert_contains "${ENTERPRISE_COMPOSE_FILE}" 'DOLLHOUSE_AUTH_METHODS: ""'
assert_contains "${ENTERPRISE_COMPOSE_FILE}" 'DOLLHOUSE_AUTH_OPEN_DCR: "false"'
assert_contains "${ENTERPRISE_COMPOSE_FILE}" '      - "0.0.0.0:80:80"'
assert_contains "${ENTERPRISE_COMPOSE_FILE}" '      - "0.0.0.0:443:443"'
assert_contains "${ENTERPRISE_CADDY_FILE}" 'mcp.enterprise.test {'
assert_contains "${ENTERPRISE_CADDY_FILE}" 'header_up X-Forwarded-Proto https'
assert_contains "${ENTERPRISE_ENV_FILE}" 'DOLLHOUSE_HOSTED_MODE=enterprise'
assert_contains "${ENTERPRISE_ENV_FILE}" 'DOLLHOUSE_AUTH_PROVIDER=oidc'
assert_contains "${ENTERPRISE_ENV_FILE}" 'DOLLHOUSE_AUTH_ISSUER=https://idp.enterprise.test'
assert_contains "${ENTERPRISE_ENV_FILE}" 'DOLLHOUSE_AUTH_AUDIENCE=dollhouse-mcp'
assert_not_contains "${ENTERPRISE_ENV_FILE}" 'DOLLHOUSE_AUTH_GITHUB_CLIENT_ID='
assert_not_contains "${ENTERPRISE_ENV_FILE}" 'DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET='

log "checking enterprise OIDC missing issuer rejection"
ENTERPRISE_BAD_OIDC_OUTPUT="${TMP_ROOT}/enterprise-bad-oidc.out"
if DOLLHOUSE_HOSTED_DEPLOY_DIR="${TMP_ROOT}/enterprise-bad-oidc-deploy" \
  DOLLHOUSE_HOSTED_MODE=enterprise \
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.enterprise.test \
  DOLLHOUSE_AUTH_PROVIDER=oidc \
  DOLLHOUSE_AUTH_METHODS='' \
  DOLLHOUSE_AUTH_AUDIENCE=dollhouse-mcp \
    bash "${HOSTED_DEPLOY}" --dry-run render > "${ENTERPRISE_BAD_OIDC_OUTPUT}" 2>&1; then
  fail "enterprise OIDC render without issuer unexpectedly succeeded"
fi
assert_contains "${ENTERPRISE_BAD_OIDC_OUTPUT}" "DOLLHOUSE_AUTH_ISSUER is required when DOLLHOUSE_AUTH_PROVIDER=oidc"

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
LEGACY_IMPORT_OUTPUT="${TMP_ROOT}/legacy-import.out"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${LEGACY_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  bash "${HOSTED_DEPLOY}" render > "${LEGACY_IMPORT_OUTPUT}"
assert_contains "${LEGACY_IMPORT_OUTPUT}" "POSTGRES_ADMIN_PASSWORD"
if grep -Fq "DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET" "${LEGACY_IMPORT_OUTPUT}"; then
  fail "existing .env.production should not import GitHub secret from legacy .env"
fi
if grep -Fq "legacy-secret" "${LEGACY_IMPORT_OUTPUT}"; then
  fail "legacy import log should not expose imported secret values"
fi
[[ "$(env_value POSTGRES_ADMIN_PASSWORD "${LEGACY_DEPLOY_DIR}/.env.production")" == "legacy-admin-password" ]] || \
  fail "legacy POSTGRES_ADMIN_PASSWORD was not imported"
[[ "$(env_value POSTGRES_PASSWORD "${LEGACY_DEPLOY_DIR}/.env.production")" == "legacy-app-password" ]] || \
  fail "legacy POSTGRES_PASSWORD was not imported"
[[ "$(env_value DOLLHOUSE_AUTH_GITHUB_CLIENT_ID "${LEGACY_DEPLOY_DIR}/.env.production")" == "generated-client" ]] || \
  fail "legacy GitHub client ID should not replace existing .env.production"
[[ "$(env_value DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET "${LEGACY_DEPLOY_DIR}/.env.production")" == "generated-secret" ]] || \
  fail "legacy GitHub client secret should not replace existing .env.production"
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

log "checking legacy import only copies allowlisted keys"
ALLOWLIST_DEPLOY_DIR="${TMP_ROOT}/legacy-allowlist-deploy"
mkdir -p "${ALLOWLIST_DEPLOY_DIR}"
cat > "${ALLOWLIST_DEPLOY_DIR}/.env" <<'EOF'
POSTGRES_PASSWORD=allowlisted-app-password
DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=allowlisted-github-secret
UNRELATED_LEGACY_SETTING=should-not-copy
EOF
ALLOWLIST_IMPORT_OUTPUT="${TMP_ROOT}/legacy-allowlist-import.out"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${ALLOWLIST_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  bash "${HOSTED_DEPLOY}" render > "${ALLOWLIST_IMPORT_OUTPUT}"
[[ "$(env_value POSTGRES_PASSWORD "${ALLOWLIST_DEPLOY_DIR}/.env.production")" == "allowlisted-app-password" ]] || \
  fail "allowlisted legacy key was not imported"
[[ "$(env_value DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET "${ALLOWLIST_DEPLOY_DIR}/.env.production")" == "allowlisted-github-secret" ]] || \
  fail "allowlisted GitHub secret should be imported when .env.production is created"
[[ -z "$(env_value UNRELATED_LEGACY_SETTING "${ALLOWLIST_DEPLOY_DIR}/.env.production")" ]] || \
  fail "unrelated legacy key should not be imported"
assert_contains "${ALLOWLIST_IMPORT_OUTPUT}" "POSTGRES_PASSWORD"
assert_contains "${ALLOWLIST_IMPORT_OUTPUT}" "DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET"

log "checking dry-run render does not write files"
DRY_RUN_DEPLOY_DIR="${TMP_ROOT}/dry-run-deploy"
DRY_RUN_OUTPUT="${TMP_ROOT}/dry-run.out"
DOLLHOUSE_HOSTED_DEPLOY_DIR="${DRY_RUN_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  bash "${HOSTED_DEPLOY}" --dry-run render > "${DRY_RUN_OUTPUT}"
[[ ! -e "${DRY_RUN_DEPLOY_DIR}" ]] || fail "dry-run render should not create ${DRY_RUN_DEPLOY_DIR}"
assert_contains "${DRY_RUN_OUTPUT}" "dry-run: would render deployment files"
assert_contains "${DRY_RUN_OUTPUT}" "dry-run: deployment mode=cloud"
assert_contains "${DRY_RUN_OUTPUT}" "dry-run: auth provider=embedded methods=github open_dcr=true allowlist_required=true"

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

log "checking invalid instance name rejection"
BAD_INSTANCE_OUTPUT="${TMP_ROOT}/bad-instance.out"
if DOLLHOUSE_HOSTED_DEPLOY_DIR="${TMP_ROOT}/bad-instance-deploy" \
  DOLLHOUSE_HOSTED_INSTANCE_NAME=Bad_Name \
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
    bash "${HOSTED_DEPLOY}" --dry-run render > "${BAD_INSTANCE_OUTPUT}" 2>&1; then
  fail "dry-run render with invalid instance name unexpectedly succeeded"
fi
assert_contains "${BAD_INSTANCE_OUTPUT}" "DOLLHOUSE_HOSTED_INSTANCE_NAME must be 1-48 lowercase letters"

log "checking invalid deployment mode rejection"
BAD_MODE_OUTPUT="${TMP_ROOT}/bad-mode.out"
if DOLLHOUSE_HOSTED_DEPLOY_DIR="${TMP_ROOT}/bad-mode-deploy" \
  DOLLHOUSE_HOSTED_MODE=spaceship \
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
    bash "${HOSTED_DEPLOY}" --dry-run render > "${BAD_MODE_OUTPUT}" 2>&1; then
  fail "dry-run render with invalid mode unexpectedly succeeded"
fi
assert_contains "${BAD_MODE_OUTPUT}" "DOLLHOUSE_HOSTED_MODE must be cloud, lan, or enterprise"

log "checking bind address rejects hostnames"
BAD_BIND_OUTPUT="${TMP_ROOT}/bad-bind.out"
if DOLLHOUSE_HOSTED_DEPLOY_DIR="${TMP_ROOT}/bad-bind-deploy" \
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  DOLLHOUSE_HOSTED_BIND_ADDRESS=localhost \
    bash "${HOSTED_DEPLOY}" --dry-run render > "${BAD_BIND_OUTPUT}" 2>&1; then
  fail "dry-run render with hostname bind address unexpectedly succeeded"
fi
assert_contains "${BAD_BIND_OUTPUT}" "DOLLHOUSE_HOSTED_BIND_ADDRESS must be an IPv4 address"

log "render behavior passed"
