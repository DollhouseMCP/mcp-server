#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.mixed-version.yml"
TARGET_INJECT_SPEC="${TARGET_INJECT_SPEC:-@dollhousemcp/mcp-server@2.0.24}"

cleanup() {
  docker compose -f "${COMPOSE_FILE}" down >/dev/null 2>&1 || true
}

wait_for_sessions() {
  local description="$1"
  local expected_pattern="$2"
  local output=""

  for _ in $(seq 1 15); do
    output="$("${SCRIPT_DIR}/observe-state.sh" --once)"
    if [[ "${output}" =~ sessions:\ count=([0-9]+) ]] && [[ "${output}" =~ ${expected_pattern} ]]; then
      printf '%s\n' "${output}"
      return 0
    fi
    sleep 2
  done

  echo "Timed out waiting for ${description}" >&2
  printf '%s\n' "${output}" >&2
  return 1
}

trap cleanup EXIT

"${SCRIPT_DIR}/reset-state.sh"
docker compose -f "${COMPOSE_FILE}" up -d --build

wait_for_sessions "initial mixed-version leader election" "count=([2-9]|[1-9][0-9]+)"

"${SCRIPT_DIR}/inject-service.sh" legacy-225 "${TARGET_INJECT_SPEC}"

wait_for_sessions "legacy injection to appear in sessions" "2\\.0\\.24"
