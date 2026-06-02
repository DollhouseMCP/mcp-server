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
    -i|-o)
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
    printf '401'
    exit 0
  fi
done

exit 0
EOF

  chmod +x "${FAKE_BIN}/ssh" "${FAKE_BIN}/git" "${FAKE_BIN}/docker" "${FAKE_BIN}/curl"
}

prepare_existing_deploy() {
  mkdir -p "${DEPLOY_DIR}/portfolio/personas"
  printf 'persona' > "${DEPLOY_DIR}/portfolio/personas/example.md"
  printf 'compose' > "${DEPLOY_DIR}/compose.yml"
  printf 'POSTGRES_PASSWORD=existing\n' > "${DEPLOY_DIR}/.env.production"
  printf 'POSTGRES_PASSWORD=legacy\n' > "${DEPLOY_DIR}/.env"

  return 0
}

run_remote() {
  PATH="${FAKE_BIN}:${PATH}" \
  DOLLHOUSE_FAKE_REMOTE_LOG="${REMOTE_LOG}" \
  DOLLHOUSE_FAKE_SSH_LOG="${SSH_LOG}" \
  DOLLHOUSE_FAKE_CURL_LOG="${CURL_LOG}" \
  DOLLHOUSE_REMOTE_SSH_TARGET=root@example.test \
  DOLLHOUSE_HOSTED_DEPLOY_DIR="${DEPLOY_DIR}" \
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  DOLLHOUSE_HOSTED_GIT_REF=codex/test-ref \
    bash "${REMOTE_DEPLOY}" "$@"
}

write_fake_commands
prepare_existing_deploy

log "checking dry-run does not open ssh"
DRY_OUTPUT="${TMP_ROOT}/dry-run.out"
run_remote --dry-run update > "${DRY_OUTPUT}"
assert_contains "${DRY_OUTPUT}" "dry-run: would connect to root@example.test"
[[ ! -s "${SSH_LOG}" ]] || fail "dry-run should not call ssh"

log "checking remote update wrapper"
OUTPUT="${TMP_ROOT}/update.out"
run_remote update > "${OUTPUT}"
assert_contains "${SSH_LOG}" "target=root@example.test"
assert_contains "${REMOTE_LOG}" "git clone --depth 1 --branch codex/test-ref"
assert_contains "${REMOTE_LOG}" "hosted action=update ref=codex/test-ref"
assert_contains "${REMOTE_LOG}" "pg_dump"
assert_contains "${OUTPUT}" "backed up .env.production"
assert_contains "${OUTPUT}" "creating database backup"
assert_contains "${OUTPUT}" "remote deployment wrapper verification passed"
assert_contains "${CURL_LOG}" "https://mcp.example.com/healthz"
assert_contains "${CURL_LOG}" "https://mcp.example.com/readyz"
assert_contains "${CURL_LOG}" "https://mcp.example.com/mcp"

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

log "remote wrapper behavior passed"
