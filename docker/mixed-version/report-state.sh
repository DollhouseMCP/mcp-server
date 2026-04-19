#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.mixed-version.yml"
STATE_ROOT="${REPO_ROOT}/tmp/mixed-version"
RUN_DIR="${STATE_ROOT}/home/.dollhouse/run"
REPORT_DIR="${STATE_ROOT}/reports"
TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"
REPORT_PATH="${REPORT_DIR}/mixed-version-report-${TIMESTAMP}.md"

mkdir -p "${REPORT_DIR}"

{
  echo "# Mixed-Version Harness Report"
  echo
  echo "- Generated: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "- Worktree: ${REPO_ROOT}"
  echo "- Host port: ${MIXED_VERSION_HOST_PORT:-42715}"
  echo
  echo "## Compose Status"
  echo
  echo '```text'
  docker compose -f "${COMPOSE_FILE}" ps
  echo '```'
  echo
  echo "## Live Observer Snapshot"
  echo
  echo '```text'
  "${SCRIPT_DIR}/observe-state.sh" --once
  echo '```'
  echo
  echo "## Lock File"
  echo
  if [[ -f "${RUN_DIR}/console-leader.auth.lock" ]]; then
    echo '```json'
    cat "${RUN_DIR}/console-leader.auth.lock"
    echo '```'
  else
    echo "_No lock file present_"
  fi
  echo
  echo "## Port Files"
  echo
  echo '```text'
  if [[ -d "${RUN_DIR}" ]]; then
    find "${RUN_DIR}" -maxdepth 1 \( -name 'permission-server*.port' -o -name 'console-leader*.lock' \) | sort
  else
    echo "Run directory missing: ${RUN_DIR}"
  fi
  echo '```'
  echo
  echo "## Recent Container Logs"
  echo
  echo '```text'
  docker compose -f "${COMPOSE_FILE}" logs --tail=80 current-local stable-226 legacy-225 legacy-219
  echo '```'
} > "${REPORT_PATH}"

echo "${REPORT_PATH}"
