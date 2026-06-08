#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REMOTE_DEPLOY="${REPO_ROOT}/scripts/hosted-remote-deploy.sh"
TMP_ROOT="$(mktemp -d)"
FAKE_BIN="${TMP_ROOT}/bin"
DEPLOY_DIR="${TMP_ROOT}/remote-deploy"
REMOTE_LOG="${TMP_ROOT}/remote.log"
SSH_LOG="${TMP_ROOT}/ssh.log"
CURL_LOG="${TMP_ROOT}/curl.log"
KNOWN_HOSTS_FILE="${TMP_ROOT}/known_hosts"
FAKE_STATE_DIR="${TMP_ROOT}/state"
EXPECTED_HOSTED_ACTION="hosted action=update ref=codex/test-ref"

cleanup() {
  if [[ -n "${TMP_ROOT:-}" && -d "${TMP_ROOT}" && "${TMP_ROOT}" == "${TMPDIR:-/tmp}"* ]]; then
    rm -R "${TMP_ROOT}"
  fi
}
trap cleanup EXIT

log() {
  printf '[hosted-remote-deploy-test] %s\n' "$*"
}

fail() {
  printf '[hosted-remote-deploy-test] error: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  if ! grep -Fq "${expected}" "${file}"; then
    printf '[hosted-remote-deploy-test] %s contents:\n' "${file}" >&2
    sed 's/^/[hosted-remote-deploy-test]   /' "${file}" >&2 || true
    fail "expected ${file} to contain: ${expected}"
  fi
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -Fq "${unexpected}" "${file}"; then
    fail "expected ${file} not to contain: ${unexpected}"
  fi
}

reset_fake_state() {
  rm -R "${FAKE_STATE_DIR}" 2>/dev/null || true
  mkdir -p "${FAKE_STATE_DIR}"
  : > "${REMOTE_LOG}"

  return 0
}

write_fake_commands() {
  mkdir -p "${FAKE_BIN}"
  : > "${REMOTE_LOG}"
  : > "${SSH_LOG}"
  : > "${CURL_LOG}"

  cat > "${FAKE_BIN}/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

args=("$@")
printf 'ssh %s\n' "$*" >> "${DOLLHOUSE_FAKE_SSH_LOG:?}"

index=0
while (( index < ${#args[@]} )); do
  case "${args[$index]}" in
    -i|-o|-p)
      index=$((index + 2))
      ;;
    -*)
      index=$((index + 1))
      ;;
    *)
      break
      ;;
  esac
done

target="${args[$index]}"
index=$((index + 1))
printf 'target=%s\n' "${target}" >> "${DOLLHOUSE_FAKE_SSH_LOG:?}"
command_args=("${args[@]:$index}")
remote_command="${command_args[*]}"
bash -c "${remote_command}"
EOF

  cat > "${FAKE_BIN}/ssh-keyscan" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'ssh-keyscan %s\n' "$*" >> "${DOLLHOUSE_FAKE_SSH_LOG:?}"

port=""
while (( $# > 0 )); do
  case "${1}" in
    -T|-p)
      if [[ "${1}" == "-p" ]]; then
        port="${2:?}"
      fi
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      host="${1}"
      shift
      ;;
  esac
done

if [[ "${DOLLHOUSE_FAKE_KEYSCAN_EMPTY:-false}" == "true" ]]; then
  exit 0
fi

if [[ -n "${port}" && "${port}" != "22" ]]; then
  printf '[%s]:%s ssh-ed25519 AAAATESTKEY\n' "${host:?}" "${port}"
else
  printf '%s ssh-ed25519 AAAATESTKEY\n' "${host:?}"
fi
EOF

  cat > "${FAKE_BIN}/ssh-keygen" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'ssh-keygen %s\n' "$*" >> "${DOLLHOUSE_FAKE_SSH_LOG:?}"

case "${1:-}" in
  -lf)
    printf '256 SHA256:fakefingerprint %s (ED25519)\n' "${2:?}"
    ;;
  -F)
    lookup="${2:?}"
    shift 2
    file=""
    while (( $# > 0 )); do
      case "${1}" in
        -f)
          file="${2:?}"
          shift 2
          ;;
        *)
          shift
          ;;
      esac
    done
    if [[ -n "${file}" && -f "${file}" ]] && grep -Fq "${lookup} " "${file}"; then
      grep -F "${lookup} " "${file}"
      exit 0
    fi
    exit 1
    ;;
esac
EOF

  cat > "${FAKE_BIN}/sleep" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'sleep %s\n' "$*" >> "${DOLLHOUSE_FAKE_REMOTE_LOG:?}"
EOF

  cat > "${FAKE_BIN}/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'git %s\n' "$*" >> "${DOLLHOUSE_FAKE_REMOTE_LOG:?}"

if [[ "${1:-}" == "clone" ]]; then
  ref=""
  dest=""
  while (( $# > 0 )); do
    case "${1}" in
      --branch)
        ref="${2:?}"
        shift 2
        ;;
      -*)
        shift
        ;;
      *)
        dest="${1}"
        shift
        ;;
    esac
  done
  if [[ -n "${DOLLHOUSE_FAKE_GIT_FAIL_REF:-}" && "${ref}" == "${DOLLHOUSE_FAKE_GIT_FAIL_REF}" ]]; then
    printf 'clone failed for ref=%s\n' "${ref}" >> "${DOLLHOUSE_FAKE_REMOTE_LOG:?}"
    exit 42
  fi
  mkdir -p "${dest}/scripts"
  cat > "${dest}/scripts/hosted-deploy.sh" <<'HELPER'
#!/usr/bin/env bash
set -euo pipefail

{
  printf 'hosted action=%s ref=%s source=%s deploy=%s ' \
    "${1:-}" "${DOLLHOUSE_HOSTED_GIT_REF:-}" "${DOLLHOUSE_HOSTED_SOURCE_DIR:-}" "${DOLLHOUSE_HOSTED_DEPLOY_DIR:-}"
  printf 'hostname_set=%s hostname=%s public_url_set=%s public_url=%s ' \
    "${DOLLHOUSE_HOSTED_HOSTNAME+x}" "${DOLLHOUSE_HOSTED_HOSTNAME:-}" "${DOLLHOUSE_PUBLIC_BASE_URL+x}" "${DOLLHOUSE_PUBLIC_BASE_URL:-}"
  printf 'instance_set=%s instance=%s mode_set=%s mode=%s http_port_set=%s http_port=%s ' \
    "${DOLLHOUSE_HOSTED_INSTANCE_NAME+x}" "${DOLLHOUSE_HOSTED_INSTANCE_NAME:-}" \
    "${DOLLHOUSE_HOSTED_MODE+x}" "${DOLLHOUSE_HOSTED_MODE:-}" \
    "${DOLLHOUSE_HOSTED_HTTP_BIND_PORT+x}" "${DOLLHOUSE_HOSTED_HTTP_BIND_PORT:-}"
  printf 'mcp_port_set=%s mcp_port=%s image_tag_set=%s image_tag=%s mem_set=%s mem=%s cpus_set=%s cpus=%s ' \
    "${DOLLHOUSE_HTTP_PORT+x}" "${DOLLHOUSE_HTTP_PORT:-}" \
    "${DOLLHOUSE_HOSTED_IMAGE_TAG+x}" "${DOLLHOUSE_HOSTED_IMAGE_TAG:-}" \
    "${DOLLHOUSE_HOSTED_MEM_LIMIT+x}" "${DOLLHOUSE_HOSTED_MEM_LIMIT:-}" \
    "${DOLLHOUSE_HOSTED_CPUS+x}" "${DOLLHOUSE_HOSTED_CPUS:-}"
  printf 'import_legacy_set=%s import_legacy=%s postgres_timeout_set=%s postgres_timeout=%s verify_timeout_set=%s verify_timeout=%s ' \
    "${DOLLHOUSE_HOSTED_IMPORT_LEGACY_ENV+x}" "${DOLLHOUSE_HOSTED_IMPORT_LEGACY_ENV:-}" \
    "${DOLLHOUSE_HOSTED_POSTGRES_READY_TIMEOUT+x}" "${DOLLHOUSE_HOSTED_POSTGRES_READY_TIMEOUT:-}" \
    "${DOLLHOUSE_HOSTED_VERIFY_READY_TIMEOUT+x}" "${DOLLHOUSE_HOSTED_VERIFY_READY_TIMEOUT:-}"
  printf 'allowed_hosts_set=%s allowed_hosts=%s trusted_proxies_set=%s trusted_proxies=%s ' \
    "${DOLLHOUSE_HTTP_ALLOWED_HOSTS+x}" "${DOLLHOUSE_HTTP_ALLOWED_HOSTS:-}" "${DOLLHOUSE_TRUSTED_PROXIES+x}" "${DOLLHOUSE_TRUSTED_PROXIES:-}"
  printf 'caddy_access_log_set=%s caddy_access_log=%s caddy_trusted_proxies_set=%s caddy_trusted_proxies=%s ' \
    "${DOLLHOUSE_HOSTED_CADDY_ACCESS_LOG+x}" "${DOLLHOUSE_HOSTED_CADDY_ACCESS_LOG:-}" \
    "${DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES+x}" "${DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES:-}"
  printf 'bootstrap_username_set=%s bootstrap_username=%s bootstrap_id_set=%s bootstrap_id=%s ' \
    "${DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME+x}" "${DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME:-}" "${DOLLHOUSE_BOOTSTRAP_GITHUB_ID+x}" "${DOLLHOUSE_BOOTSTRAP_GITHUB_ID:-}"
  printf 'auth_provider_set=%s auth_provider=%s auth_issuer_set=%s auth_issuer=%s auth_audience_set=%s auth_audience=%s ' \
    "${DOLLHOUSE_AUTH_PROVIDER+x}" "${DOLLHOUSE_AUTH_PROVIDER:-}" \
    "${DOLLHOUSE_AUTH_ISSUER+x}" "${DOLLHOUSE_AUTH_ISSUER:-}" \
    "${DOLLHOUSE_AUTH_AUDIENCE+x}" "${DOLLHOUSE_AUTH_AUDIENCE:-}"
  printf 'open_dcr_set=%s open_dcr=%s allowlist_required_set=%s allowlist_required=%s oidc_typ_set=%s oidc_typ=%s\n' \
    "${DOLLHOUSE_AUTH_OPEN_DCR+x}" "${DOLLHOUSE_AUTH_OPEN_DCR:-}" \
    "${DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED+x}" "${DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED:-}" \
    "${DOLLHOUSE_AUTH_OIDC_REQUIRE_TYP+x}" "${DOLLHOUSE_AUTH_OIDC_REQUIRE_TYP:-}"
} >> "${DOLLHOUSE_FAKE_REMOTE_LOG:?}"
mkdir -p "${DOLLHOUSE_HOSTED_DEPLOY_DIR}/portfolio/personas"
printf '%s\n' "${DOLLHOUSE_HOSTED_GIT_REF:-unknown-ref}" > "${DOLLHOUSE_HOSTED_DEPLOY_DIR}/DEPLOYED_REVISION"
date -u +%Y-%m-%dT%H:%M:%SZ > "${DOLLHOUSE_HOSTED_DEPLOY_DIR}/DEPLOYED_AT"
HELPER
  chmod +x "${dest}/scripts/hosted-deploy.sh"
  printf 'cloned-ref=%s\n' "${ref}" >> "${DOLLHOUSE_FAKE_REMOTE_LOG:?}"
  exit 0
fi

exit 0
EOF

  cat > "${FAKE_BIN}/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'docker %s\n' "$*" >> "${DOLLHOUSE_FAKE_REMOTE_LOG:?}"

if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then
  printf 'Docker Compose version fake\n'
  exit 0
fi

increment_counter() {
  local name="$1"
  local file count

  mkdir -p "${DOLLHOUSE_FAKE_STATE_DIR:?}"
  file="${DOLLHOUSE_FAKE_STATE_DIR}/${name}"
  count="0"
  if [[ -f "${file}" ]]; then
    count="$(cat "${file}")"
  fi
  count=$((count + 1))
  printf '%s\n' "${count}" > "${file}"
  printf '%s\n' "${count}"
}

if [[ "$*" == *"pg_isready"* ]]; then
  attempt="$(increment_counter pg_isready)"
  if [[ "${attempt}" -le "${DOLLHOUSE_FAKE_PG_ISREADY_FAILS:-0}" ]]; then
    exit 1
  fi
  exit 0
fi
if [[ "$*" == *"pg_dump"* ]]; then
  attempt="$(increment_counter pg_dump)"
  cat >/dev/null || true
  if [[ "${attempt}" -le "${DOLLHOUSE_FAKE_PG_DUMP_FAILS:-0}" ]]; then
    printf 'partial sql backup attempt %s\n' "${attempt}"
    exit 42
  fi
  printf 'fake sql backup\n'
  exit 0
fi
if [[ "${1:-}" == "ps" ]]; then
  printf '[hosted-remote] container: dollhousemcp Up 1 minute (healthy)\n'
  printf '[hosted-remote] container: dollhousemcp-postgres Up 1 minute (healthy)\n'
  exit 0
fi

exit 0
EOF

  cat > "${FAKE_BIN}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'curl %s\n' "$*" >> "${DOLLHOUSE_FAKE_CURL_LOG:?}"

for arg in "$@"; do
  if [[ "${arg}" == "-w" ]]; then
    printf '%s' "${DOLLHOUSE_FAKE_CURL_MCP_STATUS:-401}"
    exit 0
  fi
done

exit 0
EOF

  chmod +x "${FAKE_BIN}/ssh" "${FAKE_BIN}/ssh-keyscan" "${FAKE_BIN}/ssh-keygen" "${FAKE_BIN}/sleep" "${FAKE_BIN}/git" "${FAKE_BIN}/docker" "${FAKE_BIN}/curl"
}

prepare_existing_deploy() {
  mkdir -p "${DEPLOY_DIR}/portfolio/personas"
  printf 'persona' > "${DEPLOY_DIR}/portfolio/personas/example.md"
  printf 'compose' > "${DEPLOY_DIR}/compose.yml"
  printf 'POSTGRES_PASSWORD=existing\n' > "${DEPLOY_DIR}/.env.production"
  printf 'POSTGRES_PASSWORD=legacy\n' > "${DEPLOY_DIR}/.env"
  : > "${KNOWN_HOSTS_FILE}"

  return 0
}

run_remote() {
  PATH="${FAKE_BIN}:${PATH}" \
  DOLLHOUSE_FAKE_REMOTE_LOG="${REMOTE_LOG}" \
  DOLLHOUSE_FAKE_SSH_LOG="${SSH_LOG}" \
  DOLLHOUSE_FAKE_CURL_LOG="${CURL_LOG}" \
  DOLLHOUSE_FAKE_CURL_MCP_STATUS="${DOLLHOUSE_FAKE_CURL_MCP_STATUS:-401}" \
  DOLLHOUSE_FAKE_GIT_FAIL_REF="${DOLLHOUSE_FAKE_GIT_FAIL_REF:-}" \
  DOLLHOUSE_FAKE_KEYSCAN_EMPTY="${DOLLHOUSE_FAKE_KEYSCAN_EMPTY:-false}" \
  DOLLHOUSE_FAKE_STATE_DIR="${FAKE_STATE_DIR}" \
  DOLLHOUSE_FAKE_PG_ISREADY_FAILS="${DOLLHOUSE_FAKE_PG_ISREADY_FAILS:-0}" \
  DOLLHOUSE_FAKE_PG_DUMP_FAILS="${DOLLHOUSE_FAKE_PG_DUMP_FAILS:-0}" \
  DOLLHOUSE_REMOTE_SSH_TARGET=root@example.test \
  DOLLHOUSE_REMOTE_KNOWN_HOSTS_FILE="${DOLLHOUSE_TEST_KNOWN_HOSTS_FILE:-${KNOWN_HOSTS_FILE}}" \
  DOLLHOUSE_REMOTE_BACKUP_RETRIES="${DOLLHOUSE_TEST_BACKUP_RETRIES:-3}" \
  DOLLHOUSE_REMOTE_BACKUP_RETRY_DELAY="${DOLLHOUSE_TEST_BACKUP_RETRY_DELAY:-0}" \
  DOLLHOUSE_HOSTED_DEPLOY_DIR="${DOLLHOUSE_TEST_DEPLOY_DIR:-${DEPLOY_DIR}}" \
  DOLLHOUSE_HOSTED_INSTANCE_NAME="${DOLLHOUSE_TEST_INSTANCE_NAME:-${DOLLHOUSE_HOSTED_INSTANCE_NAME:-}}" \
  DOLLHOUSE_HOSTED_MODE="${DOLLHOUSE_TEST_HOSTED_MODE:-${DOLLHOUSE_HOSTED_MODE:-}}" \
  DOLLHOUSE_HOSTED_PROXY_MODE="${DOLLHOUSE_TEST_PROXY_MODE:-${DOLLHOUSE_HOSTED_PROXY_MODE:-}}" \
  DOLLHOUSE_HOSTED_BIND_ADDRESS="${DOLLHOUSE_TEST_BIND_ADDRESS:-${DOLLHOUSE_HOSTED_BIND_ADDRESS:-}}" \
  DOLLHOUSE_HOSTED_HTTP_BIND_PORT="${DOLLHOUSE_TEST_HTTP_BIND_PORT:-${DOLLHOUSE_HOSTED_HTTP_BIND_PORT:-}}" \
  DOLLHOUSE_HOSTED_HTTPS_BIND_PORT="${DOLLHOUSE_TEST_HTTPS_BIND_PORT:-${DOLLHOUSE_HOSTED_HTTPS_BIND_PORT:-}}" \
  DOLLHOUSE_AUTH_PROVIDER="${DOLLHOUSE_TEST_AUTH_PROVIDER:-${DOLLHOUSE_AUTH_PROVIDER:-}}" \
  DOLLHOUSE_AUTH_METHODS="${DOLLHOUSE_TEST_AUTH_METHODS:-${DOLLHOUSE_AUTH_METHODS:-}}" \
  DOLLHOUSE_AUTH_OPEN_DCR="${DOLLHOUSE_TEST_AUTH_OPEN_DCR:-${DOLLHOUSE_AUTH_OPEN_DCR:-}}" \
  DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED="${DOLLHOUSE_TEST_AUTH_ALLOWLIST_REQUIRED:-${DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED:-}}" \
  DOLLHOUSE_AUTH_ISSUER="${DOLLHOUSE_TEST_AUTH_ISSUER:-${DOLLHOUSE_AUTH_ISSUER:-}}" \
  DOLLHOUSE_AUTH_AUDIENCE="${DOLLHOUSE_TEST_AUTH_AUDIENCE:-${DOLLHOUSE_AUTH_AUDIENCE:-}}" \
  DOLLHOUSE_AUTH_JWKS_URI="${DOLLHOUSE_TEST_AUTH_JWKS_URI:-${DOLLHOUSE_AUTH_JWKS_URI:-}}" \
  DOLLHOUSE_AUTH_OIDC_REQUIRE_TYP="${DOLLHOUSE_TEST_AUTH_OIDC_REQUIRE_TYP:-${DOLLHOUSE_AUTH_OIDC_REQUIRE_TYP:-}}" \
  DOLLHOUSE_AUTH_ALLOWLIST_SEED_FILE="${DOLLHOUSE_TEST_AUTH_ALLOWLIST_SEED_FILE:-${DOLLHOUSE_AUTH_ALLOWLIST_SEED_FILE:-}}" \
  DOLLHOUSE_HTTP_PORT="${DOLLHOUSE_TEST_MCP_PORT:-${DOLLHOUSE_HTTP_PORT:-}}" \
  DOLLHOUSE_HOSTED_IMAGE_TAG="${DOLLHOUSE_TEST_IMAGE_TAG:-${DOLLHOUSE_HOSTED_IMAGE_TAG:-}}" \
  DOLLHOUSE_HOSTED_MEM_LIMIT="${DOLLHOUSE_TEST_MEM_LIMIT:-${DOLLHOUSE_HOSTED_MEM_LIMIT:-}}" \
  DOLLHOUSE_HOSTED_CPUS="${DOLLHOUSE_TEST_CPUS:-${DOLLHOUSE_HOSTED_CPUS:-}}" \
  DOLLHOUSE_HOSTED_IMPORT_LEGACY_ENV="${DOLLHOUSE_TEST_IMPORT_LEGACY_ENV:-${DOLLHOUSE_HOSTED_IMPORT_LEGACY_ENV:-}}" \
  DOLLHOUSE_HOSTED_POSTGRES_READY_TIMEOUT="${DOLLHOUSE_TEST_POSTGRES_READY_TIMEOUT:-${DOLLHOUSE_HOSTED_POSTGRES_READY_TIMEOUT:-}}" \
  DOLLHOUSE_HOSTED_VERIFY_READY_TIMEOUT="${DOLLHOUSE_TEST_VERIFY_READY_TIMEOUT:-${DOLLHOUSE_HOSTED_VERIFY_READY_TIMEOUT:-}}" \
  DOLLHOUSE_HTTP_ALLOWED_HOSTS="${DOLLHOUSE_TEST_ALLOWED_HOSTS:-${DOLLHOUSE_HTTP_ALLOWED_HOSTS:-}}" \
  DOLLHOUSE_TRUSTED_PROXIES="${DOLLHOUSE_TEST_TRUSTED_PROXIES:-${DOLLHOUSE_TRUSTED_PROXIES:-}}" \
  DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME="${DOLLHOUSE_TEST_BOOTSTRAP_GITHUB_USERNAME:-${DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME:-}}" \
  DOLLHOUSE_BOOTSTRAP_GITHUB_ID="${DOLLHOUSE_TEST_BOOTSTRAP_GITHUB_ID:-${DOLLHOUSE_BOOTSTRAP_GITHUB_ID:-}}" \
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  DOLLHOUSE_HOSTED_GIT_URL="${DOLLHOUSE_TEST_GIT_URL:-https://github.com/DollhouseMCP/mcp-server.git}" \
  DOLLHOUSE_HOSTED_GIT_REF="${DOLLHOUSE_TEST_GIT_REF:-codex/test-ref}" \
    bash "${REMOTE_DEPLOY}" "$@"
}

write_fake_commands
prepare_existing_deploy

log "checking dry-run does not open ssh"
DRY_OUTPUT="${TMP_ROOT}/dry-run.out"
run_remote --dry-run update > "${DRY_OUTPUT}"
assert_contains "${DRY_OUTPUT}" "dry-run: would connect to root@example.test"
assert_contains "${DRY_OUTPUT}" "instance=remote-deploy"
[[ ! -s "${SSH_LOG}" ]] || fail "dry-run should not call ssh"

log "checking remote canary derives instance from deploy dir"
CANARY_DRY_OUTPUT="${TMP_ROOT}/canary-dry-run.out"
DOLLHOUSE_TEST_DEPLOY_DIR="${TMP_ROOT}/dollhousemcp-canary" \
DOLLHOUSE_TEST_HOSTED_MODE=lan \
DOLLHOUSE_TEST_HTTP_BIND_PORT=3100 \
  run_remote --dry-run update > "${CANARY_DRY_OUTPUT}"
assert_contains "${CANARY_DRY_OUTPUT}" "deploy_dir=${TMP_ROOT}/dollhousemcp-canary"
assert_contains "${CANARY_DRY_OUTPUT}" "instance=dollhousemcp-canary"
assert_contains "${CANARY_DRY_OUTPUT}" "hosted overrides mode=lan"
assert_contains "${CANARY_DRY_OUTPUT}" "would check http://mcp.example.com:3100/healthz"

log "checking host key enrollment dry-run"
ENROLL_DRY_OUTPUT="${TMP_ROOT}/enroll-dry-run.out"
run_remote --dry-run enroll-host > "${ENROLL_DRY_OUTPUT}"
assert_contains "${ENROLL_DRY_OUTPUT}" "dry-run: would scan SSH host keys for example.test"
assert_contains "${ENROLL_DRY_OUTPUT}" "dry-run: would not write without --accept-host-key"

log "checking host key enrollment preview"
: > "${SSH_LOG}"
: > "${KNOWN_HOSTS_FILE}"
ENROLL_PREVIEW_OUTPUT="${TMP_ROOT}/enroll-preview.out"
run_remote enroll-host > "${ENROLL_PREVIEW_OUTPUT}"
assert_contains "${SSH_LOG}" "ssh-keyscan -T 10 example.test"
assert_contains "${ENROLL_PREVIEW_OUTPUT}" "host key fingerprint(s) for example.test"
assert_contains "${ENROLL_PREVIEW_OUTPUT}" "not writing host key"
[[ ! -s "${KNOWN_HOSTS_FILE}" ]] || fail "enroll-host preview should not write known_hosts"

log "checking host key enrollment write"
: > "${SSH_LOG}"
ENROLL_WRITE_OUTPUT="${TMP_ROOT}/enroll-write.out"
run_remote --accept-host-key enroll-host > "${ENROLL_WRITE_OUTPUT}"
assert_contains "${ENROLL_WRITE_OUTPUT}" "wrote example.test to ${KNOWN_HOSTS_FILE}"
assert_contains "${KNOWN_HOSTS_FILE}" "example.test ssh-ed25519 AAAATESTKEY"

log "checking empty host key scan failure"
KEYSCAN_EMPTY_OUTPUT="${TMP_ROOT}/keyscan-empty.out"
if DOLLHOUSE_TEST_KNOWN_HOSTS_FILE="${TMP_ROOT}/empty-known-hosts" DOLLHOUSE_FAKE_KEYSCAN_EMPTY=true run_remote enroll-host > "${KEYSCAN_EMPTY_OUTPUT}" 2>&1; then
  fail "empty host key scan unexpectedly succeeded"
fi
assert_contains "${KEYSCAN_EMPTY_OUTPUT}" "ssh-keyscan returned no host keys for example.test"

log "checking host key enrollment with custom port"
PORT_KNOWN_HOSTS="${TMP_ROOT}/port-known-hosts"
PORT_ENROLL_OUTPUT="${TMP_ROOT}/port-enroll.out"
: > "${SSH_LOG}"
DOLLHOUSE_REMOTE_SSH_PORT=2222 DOLLHOUSE_TEST_KNOWN_HOSTS_FILE="${PORT_KNOWN_HOSTS}" run_remote --accept-host-key enroll-host > "${PORT_ENROLL_OUTPUT}"
assert_contains "${SSH_LOG}" "ssh-keyscan -T 10 -p 2222 example.test"
assert_contains "${PORT_ENROLL_OUTPUT}" "wrote [example.test]:2222 to ${PORT_KNOWN_HOSTS}"
assert_contains "${PORT_KNOWN_HOSTS}" "[example.test]:2222 ssh-ed25519 AAAATESTKEY"

log "checking remote update wrapper"
reset_fake_state
OUTPUT="${TMP_ROOT}/update.out"
run_remote update > "${OUTPUT}"
assert_contains "${SSH_LOG}" "target=root@example.test"
assert_contains "${SSH_LOG}" "StrictHostKeyChecking=yes"
assert_contains "${SSH_LOG}" "UserKnownHostsFile=${KNOWN_HOSTS_FILE}"
assert_not_contains "${SSH_LOG}" "StrictHostKeyChecking=accept-new"
assert_contains "${REMOTE_LOG}" "git clone --depth 1 --branch codex/test-ref"
assert_contains "${REMOTE_LOG}" "${EXPECTED_HOSTED_ACTION}"
assert_contains "${REMOTE_LOG}" "hostname_set=x hostname=mcp.example.com public_url_set= public_url= instance_set= instance= mode_set= mode= http_port_set= http_port="
assert_contains "${REMOTE_LOG}" "pg_dump"
assert_contains "${OUTPUT}" "backed up .env.production"
assert_contains "${OUTPUT}" "creating database backup"
assert_contains "${OUTPUT}" "remote deployment wrapper verification passed"
assert_contains "${CURL_LOG}" "https://mcp.example.com/healthz"
assert_contains "${CURL_LOG}" "https://mcp.example.com/readyz"
assert_contains "${CURL_LOG}" "https://mcp.example.com/mcp"
assert_contains "${DEPLOY_DIR}/DEPLOYED_REVISION" "codex/test-ref"

latest_db_backup="$(find "${DEPLOY_DIR}/backups" -name 'pre-remote-update-*.sql' -print | head -n 1)"
[[ -n "${latest_db_backup}" ]] || fail "expected database backup"
assert_contains "${latest_db_backup}" "fake sql backup"

log "checking remote effective public URL drives local verification"
reset_fake_state
: > "${CURL_LOG}"
cat > "${DEPLOY_DIR}/.env.production" <<'EOF'
POSTGRES_PASSWORD=existing
DOLLHOUSE_HOSTED_MODE=lan
DOLLHOUSE_HOSTED_HTTP_BIND_PORT=3000
DOLLHOUSE_PUBLIC_BASE_URL=http://mcp.example.com:3000
EOF
PERSISTED_URL_OUTPUT="${TMP_ROOT}/persisted-url.out"
run_remote --skip-backup update > "${PERSISTED_URL_OUTPUT}"
assert_contains "${PERSISTED_URL_OUTPUT}" "effective public URL: http://mcp.example.com:3000"
assert_contains "${PERSISTED_URL_OUTPUT}" "using remote effective public URL for verification: http://mcp.example.com:3000"
assert_contains "${CURL_LOG}" "http://mcp.example.com:3000/healthz"
assert_contains "${CURL_LOG}" "http://mcp.example.com:3000/readyz"
assert_contains "${CURL_LOG}" "http://mcp.example.com:3000/mcp"
assert_not_contains "${CURL_LOG}" "https://mcp.example.com/healthz"

log "checking remote canary overrides reach hosted helper"
reset_fake_state
CANARY_UPDATE_OUTPUT="${TMP_ROOT}/canary-update.out"
DOLLHOUSE_TEST_DEPLOY_DIR="${TMP_ROOT}/dollhousemcp-canary" \
DOLLHOUSE_TEST_HOSTED_MODE=lan \
DOLLHOUSE_TEST_HTTP_BIND_PORT=3100 \
  run_remote --skip-backup update > "${CANARY_UPDATE_OUTPUT}"
assert_contains "${REMOTE_LOG}" "deploy=${TMP_ROOT}/dollhousemcp-canary"
assert_contains "${REMOTE_LOG}" "instance_set= instance="
assert_contains "${REMOTE_LOG}" "mode_set=x mode=lan"
assert_contains "${REMOTE_LOG}" "http_port_set=x http_port=3100"
assert_contains "${CURL_LOG}" "http://mcp.example.com:3100/healthz"

log "checking remote host allowlist and proxy overrides reach hosted helper"
reset_fake_state
HOST_PROXY_OUTPUT="${TMP_ROOT}/host-proxy-overrides.out"
DOLLHOUSE_TEST_ALLOWED_HOSTS=localhost,127.0.0.1,mcp.example.com,alt.example.com \
DOLLHOUSE_TEST_TRUSTED_PROXIES=10.0.0.0/8,172.16.0.0/12 \
  DOLLHOUSE_HOSTED_CADDY_ACCESS_LOG=true \
  DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES=173.245.48.0/20,2606:4700::/32 \
  run_remote --skip-backup update > "${HOST_PROXY_OUTPUT}"
assert_contains "${REMOTE_LOG}" "allowed_hosts_set=x allowed_hosts=localhost,127.0.0.1,mcp.example.com,alt.example.com"
assert_contains "${REMOTE_LOG}" "trusted_proxies_set=x trusted_proxies=10.0.0.0/8,172.16.0.0/12"
assert_contains "${REMOTE_LOG}" "caddy_access_log_set=x caddy_access_log=true"
assert_contains "${REMOTE_LOG}" "caddy_trusted_proxies_set=x caddy_trusted_proxies=173.245.48.0/20,2606:4700::/32"

log "checking remote runtime overrides reach hosted helper"
reset_fake_state
RUNTIME_OVERRIDE_OUTPUT="${TMP_ROOT}/runtime-overrides.out"
DOLLHOUSE_TEST_MCP_PORT=3333 \
DOLLHOUSE_TEST_IMAGE_TAG=dollhousemcp/custom:alpha \
DOLLHOUSE_TEST_MEM_LIMIT=4g \
DOLLHOUSE_TEST_CPUS=1.5 \
DOLLHOUSE_TEST_IMPORT_LEGACY_ENV=false \
DOLLHOUSE_TEST_POSTGRES_READY_TIMEOUT=120 \
DOLLHOUSE_TEST_VERIFY_READY_TIMEOUT=90 \
  run_remote --skip-backup update > "${RUNTIME_OVERRIDE_OUTPUT}"
assert_contains "${REMOTE_LOG}" "mcp_port_set=x mcp_port=3333"
assert_contains "${REMOTE_LOG}" "image_tag_set=x image_tag=dollhousemcp/custom:alpha"
assert_contains "${REMOTE_LOG}" "mem_set=x mem=4g"
assert_contains "${REMOTE_LOG}" "cpus_set=x cpus=1.5"
assert_contains "${REMOTE_LOG}" "import_legacy_set=x import_legacy=false"
assert_contains "${REMOTE_LOG}" "postgres_timeout_set=x postgres_timeout=120"
assert_contains "${REMOTE_LOG}" "verify_timeout_set=x verify_timeout=90"

log "checking explicit remote instance override reaches hosted helper"
reset_fake_state
EXPLICIT_INSTANCE_OUTPUT="${TMP_ROOT}/explicit-instance.out"
DOLLHOUSE_TEST_INSTANCE_NAME=dollhousemcp-canary \
  run_remote --skip-backup update > "${EXPLICIT_INSTANCE_OUTPUT}"
assert_contains "${REMOTE_LOG}" "instance_set=x instance=dollhousemcp-canary"

log "checking remote bootstrap overrides reach hosted helper"
reset_fake_state
BOOTSTRAP_OUTPUT="${TMP_ROOT}/bootstrap-admin.out"
DOLLHOUSE_TEST_BOOTSTRAP_GITHUB_USERNAME=octocat \
DOLLHOUSE_TEST_BOOTSTRAP_GITHUB_ID=184286 \
  run_remote --skip-backup bootstrap-admin > "${BOOTSTRAP_OUTPUT}"
assert_contains "${REMOTE_LOG}" "hosted action=bootstrap-admin"
assert_contains "${REMOTE_LOG}" "bootstrap_username_set=x bootstrap_username=octocat"
assert_contains "${REMOTE_LOG}" "bootstrap_id_set=x bootstrap_id=184286"

log "checking remote enterprise OIDC auth overrides reach hosted helper"
reset_fake_state
OIDC_REMOTE_OUTPUT="${TMP_ROOT}/oidc-remote.out"
DOLLHOUSE_TEST_DEPLOY_DIR="${TMP_ROOT}/remote-oidc-deploy" \
DOLLHOUSE_TEST_HOSTED_MODE=enterprise \
DOLLHOUSE_TEST_AUTH_PROVIDER=oidc \
DOLLHOUSE_TEST_AUTH_ISSUER=https://login.example.test \
DOLLHOUSE_TEST_AUTH_AUDIENCE=dollhouse-enterprise \
DOLLHOUSE_TEST_AUTH_JWKS_URI=https://login.example.test/.well-known/jwks.json \
DOLLHOUSE_TEST_AUTH_OIDC_REQUIRE_TYP=true \
DOLLHOUSE_TEST_AUTH_OPEN_DCR=false \
DOLLHOUSE_TEST_AUTH_ALLOWLIST_REQUIRED=true \
  run_remote --skip-backup update > "${OIDC_REMOTE_OUTPUT}"
assert_contains "${REMOTE_LOG}" "deploy=${TMP_ROOT}/remote-oidc-deploy"
assert_contains "${REMOTE_LOG}" "mode_set=x mode=enterprise"
assert_contains "${REMOTE_LOG}" "auth_provider_set=x auth_provider=oidc"
assert_contains "${REMOTE_LOG}" "auth_issuer_set=x auth_issuer=https://login.example.test"
assert_contains "${REMOTE_LOG}" "auth_audience_set=x auth_audience=dollhouse-enterprise"
assert_contains "${REMOTE_LOG}" "open_dcr_set=x open_dcr=false"
assert_contains "${REMOTE_LOG}" "allowlist_required_set=x allowlist_required=true"
assert_contains "${REMOTE_LOG}" "oidc_typ_set=x oidc_typ=true"

log "checking postgres readiness retry"
reset_fake_state
READINESS_RETRY_OUTPUT="${TMP_ROOT}/readiness-retry.out"
DOLLHOUSE_FAKE_PG_ISREADY_FAILS=1
DOLLHOUSE_TEST_BACKUP_RETRIES=2
run_remote update > "${READINESS_RETRY_OUTPUT}" 2>&1
unset DOLLHOUSE_FAKE_PG_ISREADY_FAILS DOLLHOUSE_TEST_BACKUP_RETRIES
assert_contains "${READINESS_RETRY_OUTPUT}" "postgres not ready for backup attempt 1/2"
assert_contains "${READINESS_RETRY_OUTPUT}" "postgres ready for backup on attempt 2/2"
assert_contains "${REMOTE_LOG}" "${EXPECTED_HOSTED_ACTION}"

log "checking postgres readiness exponential backoff"
reset_fake_state
READINESS_BACKOFF_OUTPUT="${TMP_ROOT}/readiness-backoff.out"
DOLLHOUSE_FAKE_PG_ISREADY_FAILS=2
DOLLHOUSE_TEST_BACKUP_RETRIES=3
DOLLHOUSE_TEST_BACKUP_RETRY_DELAY=2
run_remote update > "${READINESS_BACKOFF_OUTPUT}" 2>&1
unset DOLLHOUSE_FAKE_PG_ISREADY_FAILS DOLLHOUSE_TEST_BACKUP_RETRIES DOLLHOUSE_TEST_BACKUP_RETRY_DELAY
assert_contains "${READINESS_BACKOFF_OUTPUT}" "postgres not ready for backup attempt 1/3; retrying in 2s"
assert_contains "${READINESS_BACKOFF_OUTPUT}" "postgres not ready for backup attempt 2/3; retrying in 4s"
assert_contains "${READINESS_BACKOFF_OUTPUT}" "postgres ready for backup on attempt 3/3"
assert_contains "${REMOTE_LOG}" "sleep 2"
assert_contains "${REMOTE_LOG}" "sleep 4"
assert_contains "${REMOTE_LOG}" "${EXPECTED_HOSTED_ACTION}"

log "checking pg_dump retry quarantines partial backup"
reset_fake_state
rm -R "${DEPLOY_DIR}/backups" 2>/dev/null || true
DUMP_RETRY_OUTPUT="${TMP_ROOT}/dump-retry.out"
DOLLHOUSE_FAKE_PG_DUMP_FAILS=1
DOLLHOUSE_TEST_BACKUP_RETRIES=2
run_remote update > "${DUMP_RETRY_OUTPUT}" 2>&1
unset DOLLHOUSE_FAKE_PG_DUMP_FAILS DOLLHOUSE_TEST_BACKUP_RETRIES
assert_contains "${DUMP_RETRY_OUTPUT}" "partial database backup from attempt 1 moved"
assert_contains "${DUMP_RETRY_OUTPUT}" "database backup attempt 1/2 failed"
assert_contains "${REMOTE_LOG}" "${EXPECTED_HOSTED_ACTION}"
partial_backup="$(find "${DEPLOY_DIR}/backups" -name 'pre-remote-update-*.sql.failed-attempt-1' -print | head -n 1)"
[[ -n "${partial_backup}" ]] || fail "expected quarantined partial backup"
assert_contains "${partial_backup}" "partial sql backup attempt 1"
successful_retry_backup="$(find "${DEPLOY_DIR}/backups" -name 'pre-remote-update-*.sql' -print | head -n 1)"
[[ -n "${successful_retry_backup}" ]] || fail "expected successful retry backup"
assert_contains "${successful_retry_backup}" "fake sql backup"

log "checking permanent postgres readiness failure"
reset_fake_state
rm -R "${DEPLOY_DIR}/backups" 2>/dev/null || true
READINESS_FAIL_OUTPUT="${TMP_ROOT}/readiness-fail.out"
DOLLHOUSE_FAKE_PG_ISREADY_FAILS=9
DOLLHOUSE_TEST_BACKUP_RETRIES=2
if run_remote update > "${READINESS_FAIL_OUTPUT}" 2>&1; then
  fail "permanent postgres readiness failure unexpectedly succeeded"
fi
unset DOLLHOUSE_FAKE_PG_ISREADY_FAILS DOLLHOUSE_TEST_BACKUP_RETRIES
assert_contains "${READINESS_FAIL_OUTPUT}" "postgres is not ready for pre-update backup after 2 attempt(s)"
assert_not_contains "${REMOTE_LOG}" "pg_dump"
assert_not_contains "${REMOTE_LOG}" "hosted action=update"

log "checking permanent pg_dump failure blocks update"
reset_fake_state
rm -R "${DEPLOY_DIR}/backups" 2>/dev/null || true
DUMP_FAIL_OUTPUT="${TMP_ROOT}/dump-fail.out"
DOLLHOUSE_FAKE_PG_DUMP_FAILS=9
DOLLHOUSE_TEST_BACKUP_RETRIES=2
if run_remote update > "${DUMP_FAIL_OUTPUT}" 2>&1; then
  fail "permanent pg_dump failure unexpectedly succeeded"
fi
unset DOLLHOUSE_FAKE_PG_DUMP_FAILS DOLLHOUSE_TEST_BACKUP_RETRIES
assert_contains "${DUMP_FAIL_OUTPUT}" "failed to create database backup"
assert_contains "${DUMP_FAIL_OUTPUT}" "after 2 attempt(s)"
assert_not_contains "${REMOTE_LOG}" "hosted action=update"
partial_count="$(
  find "${DEPLOY_DIR}/backups" -name 'pre-remote-update-*.sql.failed-attempt-*' -print |
    wc -l |
    tr -d ' '
)"
[[ "${partial_count}" == "2" ]] || fail "expected 2 quarantined partial backups, got ${partial_count}"
success_count="$(
  find "${DEPLOY_DIR}/backups" -name 'pre-remote-update-*.sql' -print |
    wc -l |
    tr -d ' '
)"
if [[ "${success_count}" != "0" ]]; then
  fail "expected no finalized backup after permanent pg_dump failure, got ${success_count}"
fi

log "checking missing target error"
MISSING_TARGET_OUTPUT="${TMP_ROOT}/missing-target.out"
if PATH="${FAKE_BIN}:${PATH}" \
  DOLLHOUSE_FAKE_REMOTE_LOG="${REMOTE_LOG}" \
  DOLLHOUSE_FAKE_SSH_LOG="${SSH_LOG}" \
  DOLLHOUSE_FAKE_CURL_LOG="${CURL_LOG}" \
  DOLLHOUSE_HOSTED_DEPLOY_DIR="${DEPLOY_DIR}" \
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
    bash "${REMOTE_DEPLOY}" --dry-run update > "${MISSING_TARGET_OUTPUT}" 2>&1; then
  fail "missing target unexpectedly succeeded"
fi
assert_contains "${MISSING_TARGET_OUTPUT}" "set --target or DOLLHOUSE_REMOTE_SSH_TARGET"

log "checking remote invalid instance name rejection"
BAD_REMOTE_INSTANCE_OUTPUT="${TMP_ROOT}/bad-remote-instance.out"
if DOLLHOUSE_HOSTED_INSTANCE_NAME=Bad_Name run_remote --dry-run update > "${BAD_REMOTE_INSTANCE_OUTPUT}" 2>&1; then
  fail "remote dry-run with invalid instance name unexpectedly succeeded"
fi
assert_contains "${BAD_REMOTE_INSTANCE_OUTPUT}" "DOLLHOUSE_HOSTED_INSTANCE_NAME must be 1-48 lowercase letters"

log "checking remote bind address rejects hostnames"
BAD_REMOTE_BIND_OUTPUT="${TMP_ROOT}/bad-remote-bind.out"
if DOLLHOUSE_HOSTED_BIND_ADDRESS=localhost run_remote --dry-run update > "${BAD_REMOTE_BIND_OUTPUT}" 2>&1; then
  fail "remote dry-run with hostname bind address unexpectedly succeeded"
fi
assert_contains "${BAD_REMOTE_BIND_OUTPUT}" "DOLLHOUSE_HOSTED_BIND_ADDRESS must be an IPv4 address"

log "checking credential-bearing git URL rejection"
: > "${SSH_LOG}"
CREDENTIAL_URL_OUTPUT="${TMP_ROOT}/credential-url.out"
if DOLLHOUSE_TEST_GIT_URL=https://token@example.com/DollhouseMCP/mcp-server.git run_remote --dry-run update > "${CREDENTIAL_URL_OUTPUT}" 2>&1; then
  fail "credential-bearing git URL unexpectedly succeeded"
fi
assert_contains "${CREDENTIAL_URL_OUTPUT}" "DOLLHOUSE_HOSTED_GIT_URL must not embed credentials"
[[ ! -s "${SSH_LOG}" ]] || fail "credential URL rejection should happen before ssh"

log "checking remote clone failure handling"
CLONE_FAIL_OUTPUT="${TMP_ROOT}/clone-fail.out"
if DOLLHOUSE_TEST_GIT_REF=fail-clone DOLLHOUSE_FAKE_GIT_FAIL_REF=fail-clone run_remote --skip-backup update > "${CLONE_FAIL_OUTPUT}" 2>&1; then
  fail "clone failure unexpectedly succeeded"
fi
assert_contains "${CLONE_FAIL_OUTPUT}" "failed to clone https://github.com/DollhouseMCP/mcp-server.git at fail-clone"

log "checking public mcp verification failure"
VERIFY_FAIL_OUTPUT="${TMP_ROOT}/verify-fail.out"
if DOLLHOUSE_FAKE_CURL_MCP_STATUS=200 run_remote --skip-backup update > "${VERIFY_FAIL_OUTPUT}" 2>&1; then
  fail "public verification failure unexpectedly succeeded"
fi
assert_contains "${VERIFY_FAIL_OUTPUT}" "expected /mcp to return 401 without a bearer token, got 200"

log "remote wrapper behavior passed"
