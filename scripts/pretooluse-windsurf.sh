#!/bin/bash
# pretooluse-windsurf.sh — Windsurf hook wrapper for DollhouseMCP
#
# Windsurf pre-hooks are binary: exit 0 to allow, exit 2 to block.
# This wrapper translates Windsurf hook events into Dollhouse permission
# evaluations and then maps the response back to Windsurf exit codes.

RUN_DIR="$HOME/.dollhouse/run"
PORT_FILE="$RUN_DIR/permission-server.port"
MAX_RETRIES=2
INITIAL_TIMEOUT=5
HOOK_PLATFORM="windsurf"

debug() {
  if [[ "${DOLLHOUSE_HOOK_DEBUG:-0}" == "1" ]]; then
    echo "[pretooluse-windsurf] $*" >&2
  fi
  return 0
}

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

  while IFS= read -r candidate; do
    [[ -e "$candidate" ]] || continue
    file_name="${candidate##*/}"
    pid="${file_name#permission-server-}"
    pid="${pid%.port}"

    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done < <(ls -1t "$RUN_DIR"/permission-server-*.port 2>/dev/null || true)

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
  port_value=$(read_port_from_file "$candidate_file") || return 1
  debug "Shared port file missing — using fallback PID port file: $candidate_file"
  restore_latest_port_file "$port_value" || debug "Could not restore shared port file from fallback"
  printf '%s\n' "$port_value"
}

if ! PORT=$(resolve_permission_port); then
  debug "No usable permission server port file found — fail open"
  exit 0
fi

ENDPOINT="http://127.0.0.1:${PORT}/api/evaluate_permission"
INPUT=$(cat)

EVENT_NAME=$(echo "$INPUT" | jq -r '
  .hook_event_name
  // .hookEventName
  // .event_name
  // .eventName
  // .event
  // empty
' 2>/dev/null)

TOOL_NAME=''
TOOL_INPUT='{}'

case "$EVENT_NAME" in
  pre_run_command)
    TOOL_NAME='Bash'
    TOOL_INPUT=$(echo "$INPUT" | jq -c '
      . as $root
      | {
        command: (
          $root.tool_info.command_line
          // $root.toolInfo.commandLine
          // $root.command_line
          // $root.commandLine
          // $root.command
          // $root.input.command
          // $root.tool_input.command
          // ""
        )
      }
      | if ($root.cwd // $root.working_directory // $root.workingDirectory // $root.tool_info.cwd // $root.toolInfo.cwd) != null
          then . + { cwd: ($root.cwd // $root.working_directory // $root.workingDirectory // $root.tool_info.cwd // $root.toolInfo.cwd) }
          else .
        end
    ' 2>/dev/null)
    ;;
  pre_mcp_tool_use)
    TOOL_NAME=$(echo "$INPUT" | jq -r '
      .tool_name
      // .toolName
      // .tool.name
      // .tool_info.name
      // .toolInfo.name
      // .name
      // .mcp_tool_name
      // empty
    ' 2>/dev/null)
    TOOL_INPUT=$(echo "$INPUT" | jq -c '
      . as $root
      | (
          $root.tool_arguments
          // $root.toolArgs
          // $root.input.arguments
          // $root.arguments
          // $root.tool_input
          // $root.input
          // {}
        )
      | if ($root.server_name // $root.serverName // $root.mcp_server_name) != null
          then . + { server_name: ($root.server_name // $root.serverName // $root.mcp_server_name) }
          else .
        end
    ' 2>/dev/null)
    ;;
  *)
    TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // .toolName // .tool // .name // empty' 2>/dev/null)
    TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // .toolInput // .input // {}' 2>/dev/null)
    ;;
esac

if [[ -z "$TOOL_NAME" ]]; then
  debug "Could not parse Windsurf tool name — fail open"
  exit 0
fi

PAYLOAD=$(jq -cn \
  --arg tool_name "$TOOL_NAME" \
  --arg platform "$HOOK_PLATFORM" \
  --arg session_id "${DOLLHOUSE_SESSION_ID:-}" \
  --argjson input "$TOOL_INPUT" \
  '{
    tool_name: $tool_name,
    input: $input,
    platform: $platform
  } + (if ($session_id | length) > 0 then { session_id: $session_id } else {} end)')

ATTEMPT=0
TIMEOUT=$INITIAL_TIMEOUT

while [[ $ATTEMPT -le $MAX_RETRIES ]]; do
  RESPONSE=$(curl -s --max-time "$TIMEOUT" -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    2>/dev/null)
  CURL_EXIT=$?

  if [[ $CURL_EXIT -eq 0 ]] && [[ -n "$RESPONSE" ]]; then
    ALLOWED=$(echo "$RESPONSE" | jq -r '
      if .allowed == true then "true"
      elif .allowed == false then "false"
      elif .decision == "allow" then "true"
      elif .decision == "deny" or .decision == "ask" then "false"
      elif .hookSpecificOutput.permissionDecision == "allow" then "true"
      elif .hookSpecificOutput.permissionDecision == "deny" or .hookSpecificOutput.permissionDecision == "ask" then "false"
      else "unknown"
      end
    ' 2>/dev/null)

    if [[ "$ALLOWED" == "true" ]]; then
      exit 0
    fi

    if [[ "$ALLOWED" == "false" ]]; then
      REASON=$(echo "$RESPONSE" | jq -r '
        .reason
        // .hookSpecificOutput.reason
        // .hookSpecificOutput.permissionDecisionReason
        // empty
      ' 2>/dev/null)
      if [[ -n "$REASON" ]]; then
        echo "$REASON" >&2
      fi
      exit 2
    fi
  fi

  ATTEMPT=$((ATTEMPT + 1))
  if [[ $ATTEMPT -le $MAX_RETRIES ]]; then
    sleep $((TIMEOUT * ATTEMPT))
    TIMEOUT=$((TIMEOUT * 2))
  fi
done

debug "Permission evaluation failed — fail open"
exit 0
