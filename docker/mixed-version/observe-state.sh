#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
STATE_HOME="${REPO_ROOT}/tmp/mixed-version/home/.dollhouse"
RUN_DIR="${STATE_HOME}/run"
LOCK_FILE="${RUN_DIR}/console-leader.auth.lock"
COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.mixed-version.yml"
CONSOLE_URL="${MIXED_VERSION_CONSOLE_URL:-http://127.0.0.1:${MIXED_VERSION_HOST_PORT:-42715}}"
INTERVAL=2
MAX_ITERATIONS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval)
      INTERVAL="${2:?--interval requires a value}"
      shift 2
      ;;
    --count)
      MAX_ITERATIONS="${2:?--count requires a value}"
      shift 2
      ;;
    --once)
      MAX_ITERATIONS=1
      shift
      ;;
    *)
      # Backwards-compatible shorthand: first positional argument is the interval.
      if [[ "${INTERVAL}" == "2" ]]; then
        INTERVAL="$1"
        shift
      else
        echo "Unknown argument: $1" >&2
        exit 1
      fi
      ;;
  esac
done

print_lock_summary() {
  if [[ ! -f "${LOCK_FILE}" ]]; then
    echo "lock: missing (${LOCK_FILE})"
    return
  fi

  node - "${LOCK_FILE}" <<'NODE'
const fs = require('node:fs');
const lockPath = process.argv[2];
const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const version = raw.serverVersion ?? 'unknown';
console.log(`lock: pid=${raw.pid} version=${version} heartbeat=${raw.heartbeat} session=${raw.sessionId}`);
NODE
}

print_port_files() {
  if [[ ! -d "${RUN_DIR}" ]]; then
    echo "port files: run dir missing (${RUN_DIR})"
    return
  fi

  local count
  count="$(find "${RUN_DIR}" -maxdepth 1 -name 'permission-server-*.port' | wc -l | tr -d ' ')"
  echo "port files: ${count} pid-specific files"
}

print_sessions_summary() {
  local response
  if ! response="$(curl -fsS "${CONSOLE_URL}/api/sessions" 2>/dev/null)"; then
    response="$(
      docker compose -f "${COMPOSE_FILE}" exec -T stable-226 node - <<'NODE'
const http = require('node:http');

const request = http.get('http://127.0.0.1:41715/api/sessions', (response) => {
  let body = '';
  response.setEncoding('utf8');
  response.on('data', (chunk) => { body += chunk; });
  response.on('end', () => {
    process.stdout.write(body);
  });
});

request.on('error', (error) => {
  process.stderr.write(String(error));
  process.exit(1);
});
NODE
    )" || true
  fi

  if [[ -z "${response}" ]]; then
    echo "sessions: console unavailable at ${CONSOLE_URL} and inside shared namespace"
    return
  fi

  node - "${response}" <<'NODE'
const payload = JSON.parse(process.argv[2]);
const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
const summary = sessions.map((session) => {
  const role = session.isLeader ? 'leader' : 'follower';
  const version = session.serverVersion ?? 'unknown';
  const name = session.displayName ?? session.sessionId ?? 'unknown';
  return `${name}:${role}:${version}`;
}).join(', ');
console.log(`sessions: count=${sessions.length}${summary ? ` -> ${summary}` : ''}`);
NODE
}

iteration=0
while true; do
  printf '\n[%s]\n' "$(date '+%Y-%m-%d %H:%M:%S')"
  print_lock_summary
  print_port_files
  print_sessions_summary

  iteration=$((iteration + 1))
  if (( MAX_ITERATIONS > 0 && iteration >= MAX_ITERATIONS )); then
    break
  fi

  sleep "${INTERVAL}"
done
