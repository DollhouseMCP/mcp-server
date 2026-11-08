#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ "${1:-}" == --case ]]; then
  ACTION="$2"
  MODE="$3"
  EVENTS="$4"
  source "${REPO_ROOT}/scripts/hosted-deploy/actions.sh"
  start_or_update() { printf 'replace\n' >> "${EVENTS}"; }
  rollback_server() { printf 'replace\n' >> "${EVENTS}"; }
  verify_deploy() { printf 'public-verify\n' >> "${EVENTS}"; [[ "${MODE}" == success ]]; }
  finish_caddy_transition() { printf 'state-complete\n' >> "${EVENTS}"; }
  die() { printf '%s\n' "$*" >&2; exit 1; }
  run_action
  exit 0
fi

ROOT="$(mktemp -d)"
trap 'rm -rf -- "${ROOT}"' EXIT
for action in install update rollback; do
  for mode in success verify-failure; do
    events="${ROOT}/${action}-${mode}"
    : > "${events}"
    status=0
    bash "$0" --case "${action}" "${mode}" "${events}" || status=$?
    if [[ "${mode}" == success ]]; then
      [[ "${status}" == 0 && "$(cat "${events}")" == $'replace\npublic-verify\nstate-complete' ]] || exit 1
    else
      [[ "${status}" != 0 && "$(cat "${events}")" == $'replace\npublic-verify' ]] || exit 1
    fi
  done
done
printf 'transition-order PASS 6 cases\n'
