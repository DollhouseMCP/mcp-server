#!/bin/bash
# permission-port-discovery.sh — shared port discovery helpers for permission hooks

RUN_DIR="${RUN_DIR:-$HOME/.dollhouse/run}"
PORT_FILE="${PORT_FILE:-$RUN_DIR/permission-server.port}"

read_port_from_file() {
  local file_path="$1"
  local port_value

  [[ -f "$file_path" ]] || return 1

  port_value=$(cat "$file_path" 2>/dev/null)
  [[ "$port_value" =~ ^[0-9]+$ ]] || return 1

  printf '%s\n' "$port_value"
}

restore_latest_port_file() {
  local port_value="$1"

  [[ "$port_value" =~ ^[0-9]+$ ]] || return 1
  mkdir -p "$RUN_DIR" 2>/dev/null || return 1
  printf '%s' "$port_value" > "$PORT_FILE" 2>/dev/null || return 1
  debug "Restored shared port file at $PORT_FILE"
}

find_latest_live_pid_port_file() {
  local candidate
  local file_name
  local pid

  if ! compgen -G "$RUN_DIR/permission-server-*.port" > /dev/null; then
    debug "No PID port files found in $RUN_DIR"
    return 1
  fi

  while IFS= read -r candidate; do
    [[ -e "$candidate" ]] || continue
    file_name="${candidate##*/}"
    pid="${file_name#permission-server-}"
    pid="${pid%.port}"

    if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
      debug "Skipping malformed PID port file: $candidate"
      continue
    fi

    if kill -0 "$pid" 2>/dev/null; then
      printf '%s\n' "$candidate"
      return 0
    fi

    debug "Skipping stale PID port file for dead process $pid: $candidate"
  done < <(ls -1t "$RUN_DIR"/permission-server-*.port 2>/dev/null || true)

  debug "Found PID port files in $RUN_DIR, but none belonged to a live process"
  return 1
}

resolve_permission_port() {
  local candidate_file
  local port_value

  if port_value=$(read_port_from_file "$PORT_FILE"); then
    debug "Shared port file found: $port_value"
    printf '%s\n' "$port_value"
    return 0
  fi

  candidate_file=$(find_latest_live_pid_port_file) || return 1
  port_value=$(read_port_from_file "$candidate_file") || {
    debug "Fallback PID port file did not contain a valid port: $candidate_file"
    return 1
  }
  debug "Shared port file missing — using fallback PID port file: $candidate_file"
  restore_latest_port_file "$port_value" || debug "Could not restore shared port file from fallback"
  printf '%s\n' "$port_value"
}
