#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
chmod 700 "${work}"
exec 8>"${work}/.caddy-deploy.lock"
chmod 600 "${work}/.caddy-deploy.lock"
flock --nonblock 8
attempt() {
  bash -c '
    source "$1"
    DEPLOY_DIR="$2"
    need_command() { command -v "$1" >/dev/null; }
    die() { printf "%s\n" "$*" >&2; exit 1; }
    acquire_caddy_deployment_lock
    touch "$DEPLOY_DIR/unexpected-success"
  ' _ "${root}/scripts/hosted-deploy/runtime.sh" "${work}" 8>&-
}
if attempt >"${work}/out" 2>"${work}/err"; then
  printf 'contended lock unexpectedly succeeded\n' >&2; exit 1
fi
grep -Fq 'another Caddy deployment operation holds the lock' "${work}/err"
[[ ! -e "${work}/unexpected-success" ]]
flock --unlock 8
printf 'unknown\n' >"${work}/.caddy-offline-stop-issued"
if attempt >"${work}/out" 2>"${work}/err"; then
  printf 'unknown stop unexpectedly succeeded\n' >&2; exit 1
fi
grep -Fq 'earlier Caddy stop has an unknown outcome' "${work}/err"
[[ ! -e "${work}/unexpected-success" ]]
printf 'real flock contention and stop-fence refusal passed\n'
