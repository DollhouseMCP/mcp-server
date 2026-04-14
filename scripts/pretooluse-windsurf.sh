#!/bin/bash
# pretooluse-windsurf.sh — Windsurf hook wrapper for DollhouseMCP
#
# Windsurf pre-hooks are binary: exit 0 to allow, exit 2 to block.
# This wrapper translates Windsurf hook events into Dollhouse permission
# evaluations and then maps the response back to Windsurf exit codes.

PORT_FILE="$HOME/.dollhouse/run/permission-server.port"
MAX_RETRIES=2
INITIAL_TIMEOUT=5
HOOK_PLATFORM="windsurf"

debug() {
  if [[ "${DOLLHOUSE_HOOK_DEBUG:-0}" == "1" ]]; then
    echo "[pretooluse-windsurf] $*" >&2
  fi
  return 0
}

if [[ -f "$PORT_FILE" ]]; then
  PORT=$(cat "$PORT_FILE" 2>/dev/null)
else
  debug "No port file at $PORT_FILE — fail open"
  exit 0
fi

if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  debug "Invalid port value: $PORT — fail open"
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
      {
        command: (
          .tool_info.command_line
          // .toolInfo.commandLine
          // .command_line
          // .commandLine
          // .command
          // .input.command
          // .tool_input.command
          // ""
        )
      }
      + (
        if (.cwd // .working_directory // .workingDirectory // .tool_info.cwd // .toolInfo.cwd // empty) != empty
          then { cwd: (.cwd // .working_directory // .workingDirectory // .tool_info.cwd // .toolInfo.cwd) }
          else {}
        end
      )
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
      (
        .tool_arguments
        // .toolArgs
        // .input.arguments
        // .arguments
        // .tool_input
        // .input
        // {}
      )
      + (
        if (.server_name // .serverName // .mcp_server_name // empty) != empty
          then { server_name: (.server_name // .serverName // .mcp_server_name) }
          else {}
        end
      )
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
