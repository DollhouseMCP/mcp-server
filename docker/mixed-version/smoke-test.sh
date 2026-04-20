#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.mixed-version.yml"
TARGET_INJECT_SPEC="${TARGET_INJECT_SPEC:-@dollhousemcp/mcp-server@2.0.24}"
SESSION_WAIT_RETRIES="${SESSION_WAIT_RETRIES:-30}"
SESSION_WAIT_SLEEP_SECONDS="${SESSION_WAIT_SLEEP_SECONDS:-2}"

cleanup() {
  docker compose -f "${COMPOSE_FILE}" down >/dev/null 2>&1 || true
  return 0
}

wait_for_sessions() {
  local description="$1"
  shift
  local output=""
  local pattern=""

  for _ in $(seq 1 "${SESSION_WAIT_RETRIES}"); do
    output="$("${SCRIPT_DIR}/observe-state.sh" --once)"
    local matched_all=true
    for pattern in "$@"; do
      if ! printf '%s\n' "${output}" | grep -Eq "${pattern}"; then
        matched_all=false
        break
      fi
    done

    if [[ "${output}" =~ sessions:\ count=([0-9]+) ]] && [[ "${matched_all}" == "true" ]]; then
      printf '%s\n' "${output}"
      return 0
    fi
    sleep "${SESSION_WAIT_SLEEP_SECONDS}"
  done

  echo "Timed out waiting for ${description}" >&2
  printf '%s\n' "${output}" >&2
  echo "Recent container logs:" >&2
  docker compose -f "${COMPOSE_FILE}" logs --tail=40 current-local stable-226 legacy-225 legacy-219 >&2 || true
  return 1
}

trap cleanup EXIT

"${SCRIPT_DIR}/reset-state.sh"
docker compose -f "${COMPOSE_FILE}" up -d --build

wait_for_sessions \
  "initial mixed-version leader election" \
  "count=([2-9]|[1-9][0-9]+)" \
  "\\[current-local\\]"

"${SCRIPT_DIR}/inject-service.sh" legacy-225 "${TARGET_INJECT_SPEC}"

wait_for_sessions \
  "legacy injection to appear in sessions" \
  "\\[legacy-225\\]" \
  "2\\.0\\.24"
