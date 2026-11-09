#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOSTED_DEPLOY="${REPO_ROOT}/scripts/hosted-deploy.sh"
export DOLLHOUSE_HOSTED_CADDY_IMAGE="${DOLLHOUSE_HOSTED_CADDY_IMAGE:-registry.example.test/team/caddy@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
export DOLLHOUSE_HOSTED_CADDY_DATA_VOLUME="${DOLLHOUSE_HOSTED_CADDY_DATA_VOLUME:-fixture_data}"
export DOLLHOUSE_HOSTED_CADDY_CONFIG_VOLUME="${DOLLHOUSE_HOSTED_CADDY_CONFIG_VOLUME:-fixture_config}"
# The fake delegates non-mocked Python calls to this explicit real interpreter.
DOLLHOUSE_FAKE_PYTHON="${DOLLHOUSE_FAKE_PYTHON:-$(command -v python3)}"
"${DOLLHOUSE_FAKE_PYTHON}" -c 'import sys; sys.exit("Python 3.11 or newer required" if sys.version_info < (3, 11) else 0)'
export DOLLHOUSE_FAKE_PYTHON
TMP_ROOT="$(mktemp -d)"
TMP_ROOT="$(cd "${TMP_ROOT}" && pwd -P)"
FAKE_BIN="${TMP_ROOT}/bin"
DOCKER_LOG="${TMP_ROOT}/docker.log"
CURL_LOG="${TMP_ROOT}/curl.log"

cleanup() {
  if [[ -n "${TMP_ROOT:-}" && -d "${TMP_ROOT}" && "${TMP_ROOT}" == "$(cd "${TMPDIR:-/tmp}" && pwd -P)"/* ]]; then
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

log "checking commented and active Caddy environment fields"
COMMENT_ENV="${TMP_ROOT}/commented.env"
printf '  # DOLLHOUSE_HOSTED_CADDY_IMAGE=example\n\t# CADDY_IMAGE=example\n  \n' > "${COMMENT_ENV}"
bash -c 'source "$1"; ENV_FILE="$2"; die() { exit 1; }; validate_persisted_caddy_fields' \
  _ "${REPO_ROOT}/scripts/hosted-deploy/validation.sh" "${COMMENT_ENV}" || fail "comments should be ignored"
printf 'export DOLLHOUSE_HOSTED_CADDY_IMAGE=unsafe\n' >> "${COMMENT_ENV}"
if bash -c 'source "$1"; ENV_FILE="$2"; die() { exit 1; }; validate_persisted_caddy_fields' \
  _ "${REPO_ROOT}/scripts/hosted-deploy/validation.sh" "${COMMENT_ENV}"; then
  fail "active unsafe Caddy assignment should be refused"
fi

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

if [[ "${1:-}" == inspect && "${3:-}" == '{{.Config.User}}|{{.State.Running}}' ]]; then
  printf '1001:1001|true\n'
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

  cat > "${FAKE_BIN}/python3" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  */caddy_image_admission.py) printf '{}\n' ;;
  */caddy_transition_action.py)
    cat >/dev/null
    case "${2:-}" in
      status) printf 'none\n' ;;
      begin-fresh|begin-update|begin-rollback) printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' ;;
      select-rollback|select-proxy) printf '%s/server.prev-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' "${DOLLHOUSE_HOSTED_DEPLOY_DIR:?}" ;;
      stage|finish|bind-admission) printf 'ok\n' ;;
      *) exit 1 ;;
    esac
    ;;
  */caddy_recover_action.py) cat >/dev/null; printf '{"restored_id":"%064d","preserved_replacement_id":"%064d"}\n' 1 2 ;;
  */caddy_fresh_action.py|*/caddy_fresh_recheck.py|*/caddy_prestart_action.py|*/caddy_verify_noop_action.py) cat >/dev/null; printf '{}\n' ;;
  */caddy_unchanged_action.py)
    cat >/dev/null
    printf '%s/server.prev-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' "${DOLLHOUSE_HOSTED_DEPLOY_DIR:?}"
    ;;
  *) exec "${DOLLHOUSE_FAKE_PYTHON:?}" "$@" ;;
esac
EOF

  cat > "${FAKE_BIN}/flock" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  chmod +x "${FAKE_BIN}/docker" "${FAKE_BIN}/curl" "${FAKE_BIN}/python3" "${FAKE_BIN}/flock"
}

create_source_repo() {
  SOURCE_REPO="${TMP_ROOT}/source"
  mkdir -p "${SOURCE_REPO}/docker" "${SOURCE_REPO}/src/cli"
  git -C "${SOURCE_REPO}" init -q
  git -C "${SOURCE_REPO}" config user.email "test@example.com"
  git -C "${SOURCE_REPO}" config user.name "Hosted Deploy Test"
  printf 'FROM scratch\nFROM production AS migration\n' > "${SOURCE_REPO}/docker/Dockerfile"
  : > "${SOURCE_REPO}/src/cli/migrate-database.ts"
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
assert_contains "${DRY_RUN_OUTPUT}" "would retain a verified unchanged hardened caddy proxy; otherwise pull and admit"
assert_contains "${DRY_RUN_OUTPUT}" "retaining an unchanged qualified caddy proxy when applicable"
assert_contains "${DRY_RUN_OUTPUT}" "dry-run: would apply post-migration database grants"
assert_contains "${DRY_RUN_OUTPUT}" "dry-run: would write ${DRY_RUN_DEPLOY_DIR}/apply-post-migration-grants.sh to pass grant passwords through container environment"
assert_contains "${DRY_RUN_OUTPUT}" "dry-run: hosted bootstrap requires the administrator database URL inside the maintenance container"
assert_contains "${DRY_RUN_OUTPUT}" "dry-run: would verify https://mcp.example.com/healthz"
assert_contains "${DRY_RUN_OUTPUT}" "dry-run: would warn, not fail, if /readyz reports bootstrap_required"
PATH="${FAKE_BIN}:${PATH}" \
DOLLHOUSE_FAKE_DOCKER_LOG="${DOCKER_LOG}" \
DOLLHOUSE_FAKE_CURL_LOG="${CURL_LOG}" \
DOLLHOUSE_HOSTED_DEPLOY_DIR="${DRY_RUN_DEPLOY_DIR}" \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
DOLLHOUSE_HOSTED_SOURCE_DIR="${SOURCE_REPO}" \
  bash "${HOSTED_DEPLOY}" --dry-run update > "${DRY_RUN_OUTPUT}"
assert_contains "${DRY_RUN_OUTPUT}" "retain an unchanged qualified caddy proxy or refresh it after admission"
[[ ! -s "${DOCKER_LOG}" && ! -s "${CURL_LOG}" ]] || fail "dry-run update must not call docker or curl"

log "checking digest render and persisted selectors"
REGISTRY_DIR="${TMP_ROOT}/registry-render"
REG_RUNTIME="registry.example.test/team/runtime@sha256:$(printf 'c%.0s' {1..64})"
REG_MIGRATION="registry.example.test/team/migration@sha256:$(printf 'd%.0s' {1..64})"
PATH="${FAKE_BIN}:${PATH}" DOLLHOUSE_HOSTED_DEPLOY_DIR="${REGISTRY_DIR}" \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com DOLLHOUSE_HOSTED_IMAGE_MODE=registry \
DOLLHOUSE_HOSTED_RUNTIME_IMAGE="${REG_RUNTIME}" DOLLHOUSE_HOSTED_MIGRATION_IMAGE="${REG_MIGRATION}" \
  bash "${HOSTED_DEPLOY}" render > "${TMP_ROOT}/registry-render.out"
assert_contains "${REGISTRY_DIR}/compose.yml" "image: ${REG_RUNTIME}"
assert_contains "${REGISTRY_DIR}/compose.yml" "image: ${REG_MIGRATION}"
if grep -q '^    build:' "${REGISTRY_DIR}/compose.yml"; then fail "registry render retained a build section"; fi
PATH="${FAKE_BIN}:${PATH}" DOLLHOUSE_HOSTED_DEPLOY_DIR="${REGISTRY_DIR}" \
  bash "${HOSTED_DEPLOY}" render > "${TMP_ROOT}/registry-rerender.out"
assert_contains "${REGISTRY_DIR}/compose.yml" "image: ${REG_RUNTIME}"
assert_contains "${REGISTRY_DIR}/compose.yml" "image: ${REG_MIGRATION}"
REGISTRY_ROLLBACK_LOG="${TMP_ROOT}/registry-rollback-docker.log"
: > "${REGISTRY_ROLLBACK_LOG}"
if PATH="${FAKE_BIN}:${PATH}" DOLLHOUSE_FAKE_DOCKER_LOG="${REGISTRY_ROLLBACK_LOG}" \
  DOLLHOUSE_HOSTED_DEPLOY_DIR="${REGISTRY_DIR}" DOLLHOUSE_HOSTED_IMAGE_MODE=build \
  bash "${HOSTED_DEPLOY}" rollback > "${TMP_ROOT}/registry-rollback.out" 2>&1; then
  fail "build override bypassed persisted registry rollback refusal"
fi
assert_contains "${TMP_ROOT}/registry-rollback.out" 'cannot switch an existing registry deployment to build mode in place'
if grep -Ev '^docker compose version$' "${REGISTRY_ROLLBACK_LOG}" | grep -q .; then fail "registry rollback override invoked Docker mutation"; fi
BAD_BUILD_DIR="${TMP_ROOT}/registry-malformed-build"
mkdir -p "${BAD_BUILD_DIR}"
sed 's/^DOLLHOUSE_HOSTED_IMAGE_MODE=registry$/DOLLHOUSE_HOSTED_IMAGE_MODE=build/' "${REGISTRY_DIR}/.env.production" > "${BAD_BUILD_DIR}/.env.production"
: > "${REGISTRY_ROLLBACK_LOG}"
if PATH="${FAKE_BIN}:${PATH}" DOLLHOUSE_FAKE_DOCKER_LOG="${REGISTRY_ROLLBACK_LOG}" \
  DOLLHOUSE_HOSTED_DEPLOY_DIR="${BAD_BUILD_DIR}" bash "${HOSTED_DEPLOY}" rollback > "${TMP_ROOT}/registry-malformed-rollback.out" 2>&1; then
  fail "build mode with registry selectors allowed rollback"
fi
assert_contains "${TMP_ROOT}/registry-malformed-rollback.out" 'build mode cannot use registry image selectors'
if grep -Ev '^docker compose version$' "${REGISTRY_ROLLBACK_LOG}" | grep -q .; then fail "malformed rollback invoked Docker mutation"; fi
printf 'export DOLLHOUSE_HOSTED_RUNTIME_IMAGE=unsafe\n' >> "${REGISTRY_DIR}/.env.production"
if PATH="${FAKE_BIN}:${PATH}" DOLLHOUSE_HOSTED_DEPLOY_DIR="${REGISTRY_DIR}" \
  bash "${HOSTED_DEPLOY}" render > "${TMP_ROOT}/registry-unsafe.out" 2>&1; then
  fail "unsafe persisted registry selector was accepted"
fi

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
  bash "${HOSTED_DEPLOY}" install > "${BOOTSTRAP_OUTPUT}" 2>&1 || { cat "${BOOTSTRAP_OUTPUT}" >&2; fail "bootstrap-required install failed"; }
assert_contains "${BOOTSTRAP_OUTPUT}" "/readyz reports bootstrap_required"

log "running install workflow"
DOCKER_LOG="${TMP_ROOT}/docker-install.log"
run_hosted install
assert_file_equals "${DEPLOY_DIR}/server/version.txt" "v1"
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} build dollhousemcp dollhousemcp-migrate"
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} run --rm --pull never --no-deps dollhousemcp-migrate"
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} exec -T postgres /usr/local/bin/apply-post-migration-grants"
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} pull caddy"
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} up -d"
assert_contains "${CURL_LOG}" "https://mcp.example.com/healthz"

log "running update workflow"
DOCKER_LOG="${TMP_ROOT}/docker-update.log"
commit_source_version "v2"
run_hosted update
assert_file_equals "${DEPLOY_DIR}/server/version.txt" "v2"
previous_bundle="$(latest_dir 'server.prev-*')"
[[ -n "${previous_bundle}" ]] || fail "expected update to retain a previous server bundle"
assert_file_equals "${previous_bundle}/version.txt" "v1"
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} up -d --pull never --no-build --no-deps --force-recreate dollhousemcp"
if grep -Fq "${COMPOSE_CMD} pull caddy" "${DOCKER_LOG}"; then fail "unchanged proxy was unexpectedly pulled during update"; fi

log "running bootstrap-admin workflow"
DOCKER_LOG="${TMP_ROOT}/docker-bootstrap.log"
run_hosted_with_bootstrap bootstrap-admin octocat
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} run --rm --pull never --no-deps dollhousemcp-migrate node dist/cli/admin-bootstrap.js --require-admin-url --method github --github-username octocat"
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} exec -T postgres /usr/local/bin/apply-post-migration-grants"

log "running rollback workflow"
DOCKER_LOG="${TMP_ROOT}/docker-rollback.log"
run_hosted rollback
assert_file_equals "${DEPLOY_DIR}/server/version.txt" "v1"
rollback_bundle="$(latest_dir 'server.rollback-from-*')"
[[ -n "${rollback_bundle}" ]] || fail "expected rollback to retain the rolled-back current bundle"
assert_file_equals "${rollback_bundle}/version.txt" "v2"
if grep -Fq "${COMPOSE_CMD} pull caddy" "${DOCKER_LOG}"; then fail "proxy recovery unexpectedly pulled caddy during rollback"; fi
assert_contains "${DOCKER_LOG}" "${COMPOSE_CMD} up -d --pull never --no-build --no-deps --force-recreate dollhousemcp"

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

bash "${SCRIPT_DIR}/hosted-deploy-rollback-order.test.sh"
bash "${SCRIPT_DIR}/hosted-deploy-preparation-order.test.sh"

log "workflow behavior passed"
