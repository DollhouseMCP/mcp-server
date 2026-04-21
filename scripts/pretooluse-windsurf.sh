#!/bin/bash
# pretooluse-windsurf.sh — Windsurf hook wrapper for DollhouseMCP
#
# Windsurf pre-hooks are binary: exit 0 to allow, exit 2 to block.
# This wrapper translates Windsurf hook events into Dollhouse permission
# evaluations and then maps the response back to Windsurf exit codes.

RUN_DIR="$HOME/.dollhouse/run"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091 # Resolved at runtime via SCRIPT_DIR.
source "$SCRIPT_DIR/permission-hook-config.sh"
# shellcheck disable=SC2034 # Consumed by permission-port-discovery.sh after sourcing.
PORT_FILE="$RUN_DIR/permission-server.port"
HOOK_PLATFORM="windsurf"
permission_hook_load_runtime_config

debug() {
  if [[ "${DOLLHOUSE_HOOK_DEBUG:-0}" == "1" ]]; then
    echo "[pretooluse-windsurf] $*" >&2
  fi
  return 0
}

# shellcheck disable=SC1091 # Resolved at runtime via SCRIPT_DIR.
source "$SCRIPT_DIR/permission-port-discovery.sh"

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
