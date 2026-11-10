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
  caddy_release() {
    local action="$1"
    printf '%s\n' "${action}" >> "${EVENTS}"
    [[ "${MODE}" != "${action}-failure" ]]
  }
  finish_caddy_transition() { printf 'state-complete\n' >> "${EVENTS}"; [[ "${MODE}" != finish-failure ]]; }
  write_deployed_markers() { printf 'markers\n' >> "${EVENTS}"; }
  die() { printf '%s\n' "$*" >&2; exit 1; }
  run_action
  exit 0
fi

ROOT="$(mktemp -d)"
trap 'rm -rf -- "${ROOT}"' EXIT
expected_failure() {
  local mode="$1"
  case "${mode}" in
    accept-failure) printf 'replace\naccept\n' ;;
    release-failure) printf 'replace\naccept\nrelease\n' ;;
    finish-failure) printf 'replace\naccept\nrelease\nstate-complete\n' ;;
    *) return 1 ;;
  esac
}
if expected_failure unexpected >/dev/null; then
  printf 'unexpected transition fixture mode was accepted\n' >&2
  exit 1
fi
for action in install update rollback; do
  for mode in success accept-failure release-failure finish-failure; do
    events="${ROOT}/${action}-${mode}"
    : > "${events}"
    status=0
    bash "$0" --case "${action}" "${mode}" "${events}" || status=$?
    if [[ "${mode}" == success ]]; then
      [[ "${status}" == 0 && "$(cat "${events}")" == $'replace\naccept\nrelease\nstate-complete\nmarkers' ]] || exit 1
    else
      expected="$(expected_failure "${mode}")"
      [[ "${status}" != 0 && "$(cat "${events}")" == "${expected}" ]] || exit 1
    fi
  done
done
printf 'transition-order PASS 12 cases\n'
