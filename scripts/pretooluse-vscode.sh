#!/bin/bash
# pretooluse-vscode.sh — VS Code / Copilot hook wrapper for DollhouseMCP
#
# VS Code supports Claude-compatible PreToolUse hooks, but its tool names and
# tool_input field names differ from Claude Code. This adapter normalizes the
# most relevant built-in tool names into Dollhouse's existing permission model.

PORT_FILE="$HOME/.dollhouse/run/permission-server.port"
MAX_RETRIES=2
INITIAL_TIMEOUT=5
HOOK_PLATFORM="vscode"

debug() {
  if [[ "${DOLLHOUSE_HOOK_DEBUG:-0}" == "1" ]]; then
    echo "[pretooluse-vscode] $*" >&2
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
  debug "Could not parse VS Code tool name — fail open"
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
    echo "$RESPONSE"
    exit 0
  fi

  ATTEMPT=$((ATTEMPT + 1))
  if [[ $ATTEMPT -le $MAX_RETRIES ]]; then
    sleep $((TIMEOUT * ATTEMPT))
    TIMEOUT=$((TIMEOUT * 2))
  fi
done

debug "Permission evaluation failed — fail open"
exit 0
