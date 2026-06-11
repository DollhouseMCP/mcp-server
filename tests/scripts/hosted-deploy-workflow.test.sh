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
  while [[ "${1:-}" == "--project-name" || "${1:-}" == "--env-file" || "${1:-}" == "-f" ]]; do
    shift 2
  done
  case "${1:-}" in
    build|exec|ps|pull|run|up)
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

next_status() {
  local name="$1"
  local default_status="$2"
  local sequence_var="DOLLHOUSE_FAKE_${name}_STATUS_SEQUENCE"
  local sequence="${!sequence_var:-}"
  local state_dir="${DOLLHOUSE_FAKE_CURL_STATE_DIR:-}"
  local count_file count index

  if [[ -z "${sequence}" ]]; then
    printf '%s\n' "${default_status}"
    return 0
  fi
  [[ -n "${state_dir}" ]] || {
    printf '%s\n' "${default_status}"
    return 0
  }

  mkdir -p "${state_dir}"
  count_file="${state_dir}/${name}.count"
  count=0
  if [[ -f "${count_file}" ]]; then
    count="$(cat "${count_file}")"
  fi
  count=$((count + 1))
  printf '%s\n' "${count}" > "${count_file}"

  IFS=',' read -r -a statuses <<< "${sequence}"
  index=$((count - 1))
  if (( index >= ${#statuses[@]} )); then
    index=$((${#statuses[@]} - 1))
  fi
  printf '%s\n' "${statuses[${index}]}"

  return 0
}

output_file=""
write_format=""
url=""

while (( $# > 0 )); do
  case "${1}" in
    -o)
      output_file="${2:?}"
      shift 2
      ;;
    -w)
      write_format="${2:?}"
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="${1}"
      shift
      ;;
  esac
done

status="200"
body=""
case "${url}" in
  */healthz)
    status="$(next_status HEALTHZ 200)"
    ;;
  */readyz)
    status="$(next_status READYZ "${DOLLHOUSE_FAKE_READYZ_STATUS:-200}")"
    body="${DOLLHOUSE_FAKE_READYZ_BODY:-}"
    ;;
  */mcp)
    status="$(next_status MCP 401)"
    ;;
esac

if [[ -n "${output_file}" ]]; then
  printf '%s' "${body}" > "${output_file}"
fi
if [[ -n "${write_format}" ]]; then
  printf '%s' "${status}"
fi

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

run_hosted_with_bootstrap() {
  local action="$1"
  local username="$2"
  PATH="${FAKE_BIN}:${PATH}" \
  DOLLHOUSE_FAKE_DOCKER_LOG="${DOCKER_LOG}" \
  DOLLHOUSE_FAKE_CURL_LOG="${CURL_LOG}" \
  DOLLHOUSE_HOSTED_DEPLOY_DIR="${DEPLOY_DIR}" \
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  DOLLHOUSE_HOSTED_SOURCE_DIR="${SOURCE_REPO}" \
  DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client \
  DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret \
  DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME="${username}" \
    bash "${HOSTED_DEPLOY}" "${action}"
}

write_fake_commands
create_source_repo

DEPLOY_DIR="${TMP_ROOT}/deploy"
COMPOSE_CMD="docker compose --project-name deploy --env-file ${DEPLOY_DIR}/.env.production -f ${DEPLOY_DIR}/compose.yml"

log "checking dry-run install workflow"
DRY_RUN_DEPLOY_DIR="${TMP_ROOT}/dry-run-deploy"
DRY_RUN_OUTPUT="${TMP_ROOT}/dry-run-install.out"
: > "${DOCKER_LOG}"
: > "${CURL_LOG}"
PATH="${FAKE_BIN}:${PATH}" \
DOLLHOUSE_FAKE_DOCKER_LOG="${DOCKER_LOG}" \
DOLLHOUSE_FAKE_CURL_LOG="${CURL_LOG}" \
DOLLHOUSE_HOSTED_DEPLOY_DIR="${DRY_RUN_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
DOLLHOUSE_HOSTED_SOURCE_DIR="${SOURCE_REPO}" \
  bash "${HOSTED_DEPLOY}" --dry-run install > "${DRY_RUN_OUTPUT}"
[[ ! -e "${DRY_RUN_DEPLOY_DIR}" ]] || fail "dry-run install should not create ${DRY_RUN_DEPLOY_DIR}"
[[ ! -s "${DOCKER_LOG}" ]] || fail "dry-run install should not call docker"
[[ ! -s "${CURL_LOG}" ]] || fail "dry-run install should not call curl"
assert_contains "${DRY_RUN_OUTPUT}" "dry-run: would run database migrations"
assert_contains "${DRY_RUN_OUTPUT}" "dry-run: would apply post-migration database grants"
assert_contains "${DRY_RUN_OUTPUT}" "dry-run: would write ${DRY_RUN_DEPLOY_DIR}/apply-post-migration-grants.sh to pass grant passwords through container environment"
assert_contains "${DRY_RUN_OUTPUT}" "dry-run: would write ${DRY_RUN_DEPLOY_DIR}/bootstrap-admin.sh to use the admin database URL inside the maintenance container"
assert_contains "${DRY_RUN_OUTPUT}" "dry-run: would verify https://mcp.example.com/healthz"
assert_contains "${DRY_RUN_OUTPUT}" "dry-run: would warn, not fail, if /readyz reports bootstrap_required"

log "checking HTTP verification retries"
: > "${CURL_LOG}"
RETRY_OUTPUT="${TMP_ROOT}/retry-verify.out"
PATH="${FAKE_BIN}:${PATH}" \
DOLLHOUSE_FAKE_CURL_LOG="${CURL_LOG}" \
DOLLHOUSE_FAKE_CURL_STATE_DIR="${TMP_ROOT}/retry-curl-state" \
DOLLHOUSE_FAKE_HEALTHZ_STATUS_SEQUENCE=502,200 \
DOLLHOUSE_FAKE_READYZ_STATUS_SEQUENCE=502,200 \
DOLLHOUSE_FAKE_MCP_STATUS_SEQUENCE=502,401 \
DOLLHOUSE_HOSTED_VERIFY_READY_TIMEOUT=3 \
DOLLHOUSE_PUBLIC_BASE_URL=https://mcp.example.com \
  bash "${HOSTED_DEPLOY}" verify > "${RETRY_OUTPUT}"
assert_contains "${RETRY_OUTPUT}" "verification passed"
healthz_attempts="$(grep -Fc 'https://mcp.example.com/healthz' "${CURL_LOG}")"
readyz_attempts="$(grep -Fc 'https://mcp.example.com/readyz' "${CURL_LOG}")"
mcp_attempts="$(grep -Fc 'https://mcp.example.com/mcp' "${CURL_LOG}")"
(( healthz_attempts >= 2 )) || fail "expected /healthz verification to retry"
(( readyz_attempts >= 2 )) || fail "expected /readyz verification to retry"
(( mcp_attempts >= 2 )) || fail "expected /mcp verification to retry"

log "checking credential-bearing git URL rejection"
CREDENTIAL_URL_OUTPUT="${TMP_ROOT}/credential-url.out"
if PATH="${FAKE_BIN}:${PATH}" \
  DOLLHOUSE_FAKE_DOCKER_LOG="${DOCKER_LOG}" \
  DOLLHOUSE_FAKE_CURL_LOG="${CURL_LOG}" \
  DOLLHOUSE_HOSTED_DEPLOY_DIR="${TMP_ROOT}/credential-url-deploy" \
  DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  DOLLHOUSE_HOSTED_SOURCE_DIR="${SOURCE_REPO}" \
  DOLLHOUSE_HOSTED_GIT_URL=https://token@example.com/DollhouseMCP/mcp-server.git \
    bash "${HOSTED_DEPLOY}" --dry-run install > "${CREDENTIAL_URL_OUTPUT}" 2>&1; then
  fail "credential-bearing git URL unexpectedly succeeded"
fi
assert_contains "${CREDENTIAL_URL_OUTPUT}" "DOLLHOUSE_HOSTED_GIT_URL must not embed credentials"

log "checking bootstrap_required readiness warning"
BOOTSTRAP_OUTPUT="${TMP_ROOT}/bootstrap-required.out"
PATH="${FAKE_BIN}:${PATH}" \
DOLLHOUSE_FAKE_DOCKER_LOG="${DOCKER_LOG}" \
DOLLHOUSE_FAKE_CURL_LOG="${CURL_LOG}" \
DOLLHOUSE_FAKE_READYZ_STATUS=503 \
DOLLHOUSE_FAKE_READYZ_BODY='{"reason":"bootstrap_required"}' \
DOLLHOUSE_HOSTED_DEPLOY_DIR="${TMP_ROOT}/bootstrap-required-deploy" \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
DOLLHOUSE_HOSTED_SOURCE_DIR="${SOURCE_REPO}" \
DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=dummy-client \
DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=dummy-secret \
  bash "${HOSTED_DEPLOY}" install > "${BOOTSTRAP_OUTPUT}" 2>&1
assert_contains "${BOOTSTRAP_OUTPUT}" "/readyz reports bootstrap_required"

log "running install workflow"
run_hosted install
assert_file_equals "${DEPLOY_DIR}/server/version.txt" "v1"
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} build dollhousemcp dollhousemcp-migrate"
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} run --rm dollhousemcp-migrate"
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} exec -T postgres /usr/local/bin/apply-post-migration-grants"
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} pull caddy"
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} up -d"
assert_contains "${CURL_LOG}" "https://mcp.example.com/healthz"

log "running update workflow"
commit_source_version "v2"
run_hosted update
assert_file_equals "${DEPLOY_DIR}/server/version.txt" "v2"
previous_bundle="$(latest_dir 'server.prev-*')"
[[ -n "${previous_bundle}" ]] || fail "expected update to retain a previous server bundle"
assert_file_equals "${previous_bundle}/version.txt" "v1"
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} up -d dollhousemcp"
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} pull caddy"
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} up -d --no-deps --force-recreate caddy"

log "running bootstrap-admin workflow"
run_hosted_with_bootstrap bootstrap-admin octocat
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} run --rm dollhousemcp-migrate /usr/local/bin/dollhouse-bootstrap-admin --method github --github-username octocat"
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} exec -T postgres /usr/local/bin/apply-post-migration-grants"

log "running rollback workflow"
run_hosted rollback
assert_file_equals "${DEPLOY_DIR}/server/version.txt" "v1"
rollback_bundle="$(latest_dir 'server.rollback-from-*')"
[[ -n "${rollback_bundle}" ]] || fail "expected rollback to retain the rolled-back current bundle"
assert_file_equals "${rollback_bundle}/version.txt" "v2"
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} pull caddy"
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} up -d dollhousemcp caddy"

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
