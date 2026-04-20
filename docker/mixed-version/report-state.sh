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
TEXT_CODE_FENCE='```text'
REPORT_LABEL="manual"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label)
      REPORT_LABEL="${2:-manual}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

mkdir -p "${REPORT_DIR}"

compose_status="$(docker compose -f "${COMPOSE_FILE}" ps || true)"
running_services="$(docker compose -f "${COMPOSE_FILE}" ps --status running --services || true)"
stack_state="inactive"
if [[ -n "${running_services}" ]]; then
  stack_state="active"
fi

observer_output="$("${SCRIPT_DIR}/observe-state.sh" --once || true)"

{
  echo "# Mixed-Version Harness Report"
  echo
  echo "- Generated: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "- Worktree: ${REPO_ROOT}"
  echo "- Host port: ${MIXED_VERSION_HOST_PORT:-42715}"
  echo "- Label: ${REPORT_LABEL}"
  echo "- Stack state: ${stack_state}"
  if [[ "${stack_state}" != "active" ]]; then
    echo "- Warning: this report was captured after the mixed-version stack had already stopped, so compose status and observer output may reflect teardown instead of live convergence"
  fi
  echo
  echo "## Compose Status"
  echo
  echo "${TEXT_CODE_FENCE}"
  printf '%s\n' "${compose_status}"
  echo '```'
  echo
  echo "## Live Observer Snapshot"
  echo
  echo "${TEXT_CODE_FENCE}"
  printf '%s\n' "${observer_output}"
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
  echo "${TEXT_CODE_FENCE}"
  if [[ -d "${RUN_DIR}" ]]; then
    find "${RUN_DIR}" -maxdepth 1 \( -name 'permission-server*.port' -o -name 'console-leader*.lock' \) | sort
  else
    echo "Run directory missing: ${RUN_DIR}"
  fi
  echo '```'
  echo
  echo "## Recent Container Logs"
  echo
  echo "${TEXT_CODE_FENCE}"
  docker compose -f "${COMPOSE_FILE}" logs --tail=80 current-local stable-226 legacy-225 legacy-219
  echo '```'
} > "${REPORT_PATH}"

echo "${REPORT_PATH}"
