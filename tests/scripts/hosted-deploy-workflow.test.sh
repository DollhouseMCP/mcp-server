#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOSTED_DEPLOY="${REPO_ROOT}/scripts/hosted-deploy.sh"
TMP_ROOT="$(mktemp -d)"
FAKE_BIN="${TMP_ROOT}/bin"
DOCKER_LOG="${TMP_ROOT}/docker.log"
CURL_LOG="${TMP_ROOT}/curl.log"

cleanup() {
  if [[ -n "${TMP_ROOT:-}" && -d "${TMP_ROOT}" && "${TMP_ROOT}" == "${TMPDIR:-/tmp}"* ]]; then
    rm -R "${TMP_ROOT}"
  fi
}
trap cleanup EXIT

log() {
  printf '[hosted-deploy-workflow-test] %s\n' "$*"
}

fail() {
  printf '[hosted-deploy-workflow-test] error: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  grep -Fq "${expected}" "${file}" || fail "expected ${file} to contain: ${expected}"
}

assert_file_equals() {
  local file="$1"
  local expected="$2"
  local actual
  actual="$(cat "${file}")"
  [[ "${actual}" == "${expected}" ]] || fail "expected ${file} to be '${expected}', got '${actual}'"
}

latest_dir() {
  local pattern="$1"
  find "${DEPLOY_DIR}" -maxdepth 1 -type d -name "${pattern}" -print | sort | tail -n 1
}

write_fake_commands() {
  mkdir -p "${FAKE_BIN}"
  : > "${DOCKER_LOG}"
  : > "${CURL_LOG}"

  cat > "${FAKE_BIN}/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'docker %s\n' "$*" >> "${DOLLHOUSE_FAKE_DOCKER_LOG:?}"

if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then
  printf 'Docker Compose version fake\n'
  exit 0
fi

if [[ "${1:-}" == "compose" ]]; then
  shift
  if [[ "${1:-}" == "-f" ]]; then
    shift 2
  fi
  case "${1:-}" in
    build|exec|ps|run|up)
      exit 0
      ;;
  esac
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

  chmod +x "${FAKE_BIN}/docker" "${FAKE_BIN}/curl"
}

create_source_repo() {
  SOURCE_REPO="${TMP_ROOT}/source"
  mkdir -p "${SOURCE_REPO}/docker"
  git -C "${SOURCE_REPO}" init -q
  git -C "${SOURCE_REPO}" config user.email "test@example.com"
  git -C "${SOURCE_REPO}" config user.name "Hosted Deploy Test"
  printf 'FROM scratch\n' > "${SOURCE_REPO}/docker/Dockerfile"
  printf '{"scripts":{"db:migrate":"echo migrate"}}\n' > "${SOURCE_REPO}/package.json"
  printf 'v1' > "${SOURCE_REPO}/version.txt"
  git -C "${SOURCE_REPO}" add .
  git -C "${SOURCE_REPO}" commit -q -m "version 1"
}

commit_source_version() {
  local version="$1"
  printf '%s' "${version}" > "${SOURCE_REPO}/version.txt"
  git -C "${SOURCE_REPO}" add version.txt
  git -C "${SOURCE_REPO}" commit -q -m "version ${version}"
}

run_hosted() {
  local action="$1"
  PATH="${FAKE_BIN}:${PATH}" \
  DOLLHOUSE_FAKE_DOCKER_LOG="${DOCKER_LOG}" \
  DOLLHOUSE_FAKE_CURL_LOG="${CURL_LOG}" \
  DOLLHOUSE_HOSTED_DEPLOY_DIR="${DEPLOY_DIR}" \
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  DOLLHOUSE_HOSTED_SOURCE_DIR="${SOURCE_REPO}" \
  DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client \
  DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret \
    bash "${HOSTED_DEPLOY}" "${action}"
}

write_fake_commands
create_source_repo

DEPLOY_DIR="${TMP_ROOT}/deploy"

log "running install workflow"
run_hosted install
assert_file_equals "${DEPLOY_DIR}/server/version.txt" "v1"
assert_contains "${DOCKER_LOG}" "docker compose -f ${DEPLOY_DIR}/compose.yml build dollhousemcp"
assert_contains "${DOCKER_LOG}" "docker compose -f ${DEPLOY_DIR}/compose.yml run --rm dollhousemcp npm run db:migrate"
assert_contains "${DOCKER_LOG}" "docker compose -f ${DEPLOY_DIR}/compose.yml up -d"
assert_contains "${CURL_LOG}" "curl -fsS https://mcp.example.com/healthz"

log "running update workflow"
commit_source_version "v2"
run_hosted update
assert_file_equals "${DEPLOY_DIR}/server/version.txt" "v2"
previous_bundle="$(latest_dir 'server.prev-*')"
[[ -n "${previous_bundle}" ]] || fail "expected update to retain a previous server bundle"
assert_file_equals "${previous_bundle}/version.txt" "v1"
assert_contains "${DOCKER_LOG}" "docker compose -f ${DEPLOY_DIR}/compose.yml up -d dollhousemcp"

log "running rollback workflow"
run_hosted rollback
assert_file_equals "${DEPLOY_DIR}/server/version.txt" "v1"
rollback_bundle="$(latest_dir 'server.rollback-from-*')"
[[ -n "${rollback_bundle}" ]] || fail "expected rollback to retain the rolled-back current bundle"
assert_file_equals "${rollback_bundle}/version.txt" "v2"
assert_contains "${DOCKER_LOG}" "docker compose -f ${DEPLOY_DIR}/compose.yml up -d dollhousemcp caddy"

log "checking invalid source error"
bad_output="${TMP_ROOT}/bad-source.out"
if PATH="${FAKE_BIN}:${PATH}" \
  DOLLHOUSE_FAKE_DOCKER_LOG="${DOCKER_LOG}" \
  DOLLHOUSE_FAKE_CURL_LOG="${CURL_LOG}" \
  DOLLHOUSE_HOSTED_DEPLOY_DIR="${TMP_ROOT}/bad-deploy" \
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  DOLLHOUSE_HOSTED_SOURCE_DIR="${TMP_ROOT}/missing-source" \
  DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client \
  DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret \
    bash "${HOSTED_DEPLOY}" install > "${bad_output}" 2>&1; then
  fail "install with missing source unexpectedly succeeded"
fi
assert_contains "${bad_output}" "DOLLHOUSE_HOSTED_SOURCE_DIR does not exist"

log "workflow behavior passed"
