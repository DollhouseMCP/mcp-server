#!/bin/bash
# pretooluse-vscode.sh — VS Code / Copilot hook wrapper for DollhouseMCP
#
# VS Code supports Claude-compatible PreToolUse hooks, but its tool names and
# tool_input field names differ from Claude Code. This adapter normalizes the
# most relevant built-in tool names into Dollhouse's existing permission model.

RUN_DIR="$HOME/.dollhouse/run"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091 # Resolved at runtime via SCRIPT_DIR.
source "$SCRIPT_DIR/permission-hook-config.sh"
# shellcheck disable=SC2034 # Consumed by permission-port-discovery.sh after sourcing.
PORT_FILE="$RUN_DIR/permission-server.port"
HOOK_PLATFORM="vscode"
permission_hook_load_runtime_config

debug() {
  if [[ "${DOLLHOUSE_HOOK_DEBUG:-0}" == "1" ]]; then
    echo "[pretooluse-vscode] $*" >&2
  fi
  return 0
}

emit_allow_response() {
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
  return 0
}

fail_open() {
  local message="$1"
  debug "$message"
  emit_allow_response
  return 0
}

# shellcheck disable=SC1091 # Resolved at runtime via SCRIPT_DIR.
source "$SCRIPT_DIR/permission-port-discovery.sh"

if ! PORT=$(resolve_permission_port); then
  fail_open "No usable permission server port file found — fail open"
  exit 0
fi

ENDPOINT="http://127.0.0.1:${PORT}/api/evaluate_permission"
INPUT=$(cat)

RAW_TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // .toolName // .tool // .name // empty' 2>/dev/null)
TOOL_NAME="$RAW_TOOL_NAME"
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // .toolInput // .input // {}' 2>/dev/null)

case "$RAW_TOOL_NAME" in
  runTerminalCommand|run_terminal_command|run_in_terminal|terminal_command)
    TOOL_NAME='Bash'
    TOOL_INPUT=$(echo "$INPUT" | jq -c '
      . as $root
      | {
        command: (
          $root.tool_input.command
          // $root.tool_input.commandLine
          // $root.toolInput.command
          // $root.toolInput.commandLine
          // $root.input.command
          // $root.input.commandLine
          // ""
        )
      }
      | if ($root.cwd // $root.working_directory // $root.workingDirectory) != null
          then . + { cwd: ($root.cwd // $root.working_directory // $root.workingDirectory) }
          else .
        end
    ' 2>/dev/null)
    ;;
  createFile|create_file|writeFile|write_file)
    TOOL_NAME='Write'
    ;;
  editFile|edit_file|editFiles|replace_string_in_file|multi_edit)
    TOOL_NAME='Edit'
    ;;
  readFile|read_file|openFile|open_file)
    TOOL_NAME='Read'
    ;;
  findFiles|find_files|glob_search)
    TOOL_NAME='Glob'
    ;;
  searchWorkspace|search_workspace|searchInFiles|grep_search)
    TOOL_NAME='Grep'
    ;;
  fetchWebPage|fetch_web_page|fetch_webpage)
    TOOL_NAME='WebFetch'
    ;;
  searchWeb|search_web)
    TOOL_NAME='WebSearch'
    ;;
  *)
    ;;
esac

if [[ -z "$TOOL_NAME" ]]; then
  fail_open "Could not parse VS Code tool name — fail open"
  exit 0
fi

if [[ -z "$TOOL_INPUT" ]]; then
  TOOL_INPUT='{}'
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
    HOOK_RESPONSE=$(echo "$RESPONSE" | jq -c '
      def decision_from_response:
        if (.hookSpecificOutput.permissionDecision? | type) == "string" then .hookSpecificOutput.permissionDecision
        elif (.decision? | type) == "string" then .decision
        elif (.allowed? == true) then "allow"
        elif (.allowed? == false) then "deny"
        else empty
        end;
      def reason_from_response:
        .hookSpecificOutput.permissionDecisionReason
        // .reason
        // .hookSpecificOutput.reason
        // empty;

      (decision_from_response) as $decision
      | if ($decision | type) == "string" and ($decision | length) > 0 then
          {
            hookSpecificOutput:
              ({
                hookEventName: "PreToolUse",
                permissionDecision: $decision
              } + (if (reason_from_response | type) == "string" and (reason_from_response | length) > 0
                    then { permissionDecisionReason: reason_from_response }
                    else {}
                    end))
          }
        else empty
        end
    ' 2>/dev/null)

    if [[ -n "$HOOK_RESPONSE" ]]; then
      echo "$HOOK_RESPONSE"
    else
      fail_open "Permission evaluation returned an unrecognized response — fail open"
      exit 0
    fi
    exit 0
  fi

  ATTEMPT=$((ATTEMPT + 1))
  if [[ $ATTEMPT -le $MAX_RETRIES ]]; then
    sleep $((TIMEOUT * ATTEMPT))
    TIMEOUT=$((TIMEOUT * 2))
  fi
done

fail_open "Permission evaluation failed — fail open"
exit 0
