#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
STATE_HOME="${REPO_ROOT}/tmp/mixed-version/home/.dollhouse"
RUN_DIR="${STATE_HOME}/run"
LOCK_FILE="${RUN_DIR}/console-leader.auth.lock"
COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.mixed-version.yml"
INTERNAL_CONSOLE_PORT="${DOLLHOUSE_WEB_CONSOLE_PORT:-41715}"
CONSOLE_URL="${MIXED_VERSION_CONSOLE_URL:-http://127.0.0.1:${MIXED_VERSION_HOST_PORT:-42715}}"
INTERVAL=2
MAX_ITERATIONS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval)
      INTERVAL="${2:?--interval requires a value}"
      if ! [[ "${INTERVAL}" =~ ^[0-9]+$ ]] || (( INTERVAL < 1 )); then
        echo "--interval must be a positive integer" >&2
        exit 1
      fi
      shift 2
      ;;
    --count)
      MAX_ITERATIONS="${2:?--count requires a value}"
      if ! [[ "${MAX_ITERATIONS}" =~ ^[0-9]+$ ]]; then
        echo "--count must be a non-negative integer" >&2
        exit 1
      fi
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
  local fallback_error=""
  if ! response="$(curl -fsS "${CONSOLE_URL}/api/sessions" 2>/dev/null)"; then
    response="$(docker compose -f "${COMPOSE_FILE}" exec -T -e DOLLHOUSE_WEB_CONSOLE_PORT="${INTERNAL_CONSOLE_PORT}" stable-226 node /harness/query-sessions.mjs 2>/tmp/mixed-version-observe.err)" || fallback_error="$(cat /tmp/mixed-version-observe.err 2>/dev/null || true)"
  fi

  if [[ -z "${response}" ]]; then
    if [[ -n "${fallback_error}" ]]; then
      echo "sessions: console unavailable at ${CONSOLE_URL}; fallback query failed: ${fallback_error}"
    else
      echo "sessions: console unavailable at ${CONSOLE_URL} and inside shared namespace"
    fi
    return
  fi

  node - "${response}" <<'NODE'
const payload = JSON.parse(process.argv[2]);
const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
const summary = sessions.map((session) => {
  const role = session.isLeader ? 'leader' : 'follower';
  const version = session.serverVersion ?? 'unknown';
  const name = session.displayName ?? session.sessionId ?? 'unknown';
  const sessionId = session.sessionId ?? 'unknown-session';
  return `${name}[${sessionId}]:${role}:${version}`;
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
