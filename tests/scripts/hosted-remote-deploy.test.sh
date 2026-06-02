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
  grep -Fq "${expected}" "${file}" || fail "expected ${file} to contain: ${expected}"
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -Fq "${unexpected}" "${file}"; then
    fail "expected ${file} not to contain: ${unexpected}"
  fi
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
"${args[@]:$index}"
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

printf 'hosted action=%s ref=%s source=%s deploy=%s\n' "${1:-}" "${DOLLHOUSE_HOSTED_GIT_REF:-}" "${DOLLHOUSE_HOSTED_SOURCE_DIR:-}" "${DOLLHOUSE_HOSTED_DEPLOY_DIR:-}" >> "${DOLLHOUSE_FAKE_REMOTE_LOG:?}"
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

if [[ "$*" == *"pg_isready"* ]]; then
  exit 0
fi
if [[ "$*" == *"pg_dump"* ]]; then
  cat >/dev/null || true
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

  chmod +x "${FAKE_BIN}/ssh" "${FAKE_BIN}/ssh-keyscan" "${FAKE_BIN}/ssh-keygen" "${FAKE_BIN}/git" "${FAKE_BIN}/docker" "${FAKE_BIN}/curl"
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
  DOLLHOUSE_REMOTE_SSH_TARGET=root@example.test \
  DOLLHOUSE_REMOTE_KNOWN_HOSTS_FILE="${DOLLHOUSE_TEST_KNOWN_HOSTS_FILE:-${KNOWN_HOSTS_FILE}}" \
  DOLLHOUSE_HOSTED_DEPLOY_DIR="${DEPLOY_DIR}" \
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
[[ ! -s "${SSH_LOG}" ]] || fail "dry-run should not call ssh"

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
OUTPUT="${TMP_ROOT}/update.out"
run_remote update > "${OUTPUT}"
assert_contains "${SSH_LOG}" "target=root@example.test"
assert_contains "${SSH_LOG}" "StrictHostKeyChecking=yes"
assert_contains "${SSH_LOG}" "UserKnownHostsFile=${KNOWN_HOSTS_FILE}"
assert_not_contains "${SSH_LOG}" "StrictHostKeyChecking=accept-new"
assert_contains "${REMOTE_LOG}" "git clone --depth 1 --branch codex/test-ref"
assert_contains "${REMOTE_LOG}" "hosted action=update ref=codex/test-ref"
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
