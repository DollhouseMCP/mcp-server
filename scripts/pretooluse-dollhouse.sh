#!/bin/bash
# pretooluse-dollhouse.sh — PreToolUse hook for DollhouseMCP permission evaluation
#
# Routes permission checks through DollhouseMCP's evaluate_permission endpoint.
# The DollhouseMCP web server runs alongside the MCP stdio server on a dynamic port.
# Port discovery via ~/.dollhouse/run/permission-server.port
#
# Input:  JSON on stdin. Claude Code uses { tool_name, tool_input }.
#         Other clients may expose { toolName, toolInput } or { tool, input }.
# Output: JSON on stdout (platform-specific hook response; Claude Code expects
# hookSpecificOutput.permissionDecision for PreToolUse)
#
# If permission evaluation is unavailable, the hook asks for high-risk calls
# where the host supports it, and defers low-risk calls to the host.
#
# Set DOLLHOUSE_HOOK_DEBUG=1 for debug logging to stderr.
# Set DOLLHOUSE_HOOK_PLATFORM to override the platform sent to the server.
# Set DOLLHOUSE_RUN_DIR to override the runtime-state directory (used by tests
# to isolate port-file writes from the shared ~/.dollhouse/run/ location).

RUN_DIR="${DOLLHOUSE_RUN_DIR:-$HOME/.dollhouse/run}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091 # Resolved at runtime via SCRIPT_DIR.
source "$SCRIPT_DIR/permission-hook-config.sh"
# shellcheck disable=SC2034 # Consumed by permission-port-discovery.sh after sourcing.
PORT_FILE="$RUN_DIR/permission-server.port"
AUTHORITY_FILE="$RUN_DIR/permission-authority.json"
HOOK_PLATFORM="${DOLLHOUSE_HOOK_PLATFORM:-claude_code}"
permission_hook_load_runtime_config
DIAGNOSTICS_LOG="${DOLLHOUSE_HOOK_DIAGNOSTICS_LOG:-$RUN_DIR/permission-hook-diagnostics.jsonl}"
INVOCATION_ID="$(date +%s)-$$-${RANDOM:-0}"
OUTAGE_WARNING_MARKER="$RUN_DIR/permission-hook-outage-warning"
readonly COMPLETE_EVENT="complete"

INPUT=""
TOOL_NAME=""
TOOL_INPUT=""
MCP_TOOL=""
HOOK_EVENT=""
AUTHORITY_HOST=""
AUTHORITY_MODE=""
PAYLOAD=""
RESPONSE=""
NORMALIZED_RESPONSE=""
EMITTED_RESPONSE=""
PORT=""
ENDPOINT=""
LAST_ATTEMPT="0"
LAST_CURL_EXIT=""
CURRENT_TIMEOUT="$INITIAL_TIMEOUT"

# Debug logging helper — writes to stderr so it doesn't pollute stdout
debug() {
  if [[ "${DOLLHOUSE_HOOK_DEBUG:-0}" == "1" ]]; then
    echo "[pretooluse] $*" >&2
  fi
  return 0
}

append_diagnostic_record() {
  local event="$1"
  local stage="$2"
  local outcome="${3:-}"
  local reason="${4:-}"
  local diagnostic_json

  # These adapters did not record detailed invocation diagnostics before
  # sharing this bridge. Keep that behavior until the safe schema is in use.
  case "$HOOK_PLATFORM" in
    vscode|windsurf) return 0 ;;
    *) ;;
  esac

  mkdir -p "$(dirname "$DIAGNOSTICS_LOG")" 2>/dev/null || return 0

  diagnostic_json=$(
    jq -cn \
      --arg timestamp "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
      --arg invocationId "$INVOCATION_ID" \
      --arg event "$event" \
      --arg platform "$HOOK_PLATFORM" \
      --arg stage "$stage" \
      --arg outcome "$outcome" \
      --arg reason "$reason" \
      --arg hookPath "$0" \
      --arg diagnosticsLogPath "$DIAGNOSTICS_LOG" \
      --arg sessionId "${DOLLHOUSE_SESSION_ID:-}" \
      --arg toolName "${TOOL_NAME:-}" \
      --arg toolInput "${TOOL_INPUT:-}" \
      --arg rawInput "${INPUT:-}" \
      --arg authorityHost "${AUTHORITY_HOST:-}" \
      --arg authorityMode "${AUTHORITY_MODE:-}" \
      --arg endpoint "${ENDPOINT:-}" \
      --arg port "${PORT:-}" \
      --arg payload "${PAYLOAD:-}" \
      --arg response "${RESPONSE:-}" \
      --arg normalizedResponse "${NORMALIZED_RESPONSE:-}" \
      --arg emittedResponse "${EMITTED_RESPONSE:-}" \
      --arg attempt "${LAST_ATTEMPT:-}" \
      --arg maxRetries "${MAX_RETRIES:-}" \
      --arg timeoutSeconds "${CURRENT_TIMEOUT:-}" \
      --arg curlExit "${LAST_CURL_EXIT:-}" \
      --argjson rawInputLength "${#INPUT}" \
      --argjson normalizedResponseLength "${#NORMALIZED_RESPONSE}" \
      --argjson emittedResponseLength "${#EMITTED_RESPONSE}" \
      --argjson responseLength "${#RESPONSE}" \
      '{
        timestamp: $timestamp,
        invocationId: $invocationId,
        event: $event,
        platform: $platform,
        stage: $stage,
        rawInputLength: $rawInputLength,
        normalizedResponseLength: $normalizedResponseLength,
        emittedResponseLength: $emittedResponseLength,
        responseLength: $responseLength
      }
      + (if $outcome != "" then { outcome: $outcome } else {} end)
      + (if $reason != "" then { reason: $reason } else {} end)
      + (if $hookPath != "" then { hookPath: $hookPath } else {} end)
      + (if $diagnosticsLogPath != "" then { diagnosticsLogPath: $diagnosticsLogPath } else {} end)
      + (if $sessionId != "" then { sessionId: $sessionId } else {} end)
      + (if $toolName != "" then { toolName: $toolName } else {} end)
      + (if $toolInput != "" then { toolInput: $toolInput } else {} end)
      + (if $rawInput != "" then { rawInput: $rawInput } else {} end)
      + (if $authorityHost != "" then { authorityHost: $authorityHost } else {} end)
      + (if $authorityMode != "" then { authorityMode: $authorityMode } else {} end)
      + (if $endpoint != "" then { endpoint: $endpoint } else {} end)
      + (if $port != "" then { port: $port } else {} end)
      + (if $payload != "" then { payload: $payload } else {} end)
      + (if $response != "" then { response: $response } else {} end)
      + (if $normalizedResponse != "" then { normalizedResponse: $normalizedResponse } else {} end)
      + (if $emittedResponse != "" then { emittedResponse: $emittedResponse } else {} end)
      + (if $attempt != "" then { attempt: $attempt } else {} end)
      + (if $maxRetries != "" then { maxRetries: $maxRetries } else {} end)
      + (if $timeoutSeconds != "" then { timeoutSeconds: $timeoutSeconds } else {} end)
      + (if $curlExit != "" then { curlExit: $curlExit } else {} end)'
  ) || return 0

  printf '%s\n' "$diagnostic_json" >> "$DIAGNOSTICS_LOG" 2>/dev/null || true
  return 0
}

emit_response() {
  local response="$1"

  EMITTED_RESPONSE="$response"
  if [[ -n "$response" ]]; then
    printf '%s\n' "$response"
  fi

  return 0
}

is_outage_high_risk() {
  local name configured_tool
  local -a high_risk_tools
  # A payload with no usable tool name cannot be shown to be low-risk.
  [[ -n "${TOOL_NAME//[[:space:]]/}" ]] || return 0
  name=$(printf '%s' "$TOOL_NAME" | LC_ALL=C tr '[:upper:]' '[:lower:]')
  case "$HOOK_PLATFORM:$name" in
    cursor:shell|codex:exec_command|codex:shell_command|gemini:run_shell_command) name="bash" ;;
    gemini:write_file) name="write" ;;
    gemini:replace) name="edit" ;;
    gemini:web_fetch) name="webfetch" ;;
    *) ;;
  esac
  read -r -a high_risk_tools <<< "$OUTAGE_HIGH_RISK_TOOLS"
  for configured_tool in "${high_risk_tools[@]}"; do
    [[ "$name" == "$configured_tool" ]] && return 0
  done

  case "$name" in
    mcp__*|mcp_*|mcp:*|mcp/*) ;;
    *) [[ "$MCP_TOOL" == "true" ]] || return 1 ;;
  esac
  [[ -n "$OUTAGE_MCP_HIGH_RISK_PATTERN" && "$name" =~ $OUTAGE_MCP_HIGH_RISK_PATTERN ]]
}

handle_outage() {
  local stage="$1"
  local failure="$2"
  local reason="DollhouseMCP permission check unavailable: $failure."
  local decision="ask"
  debug "$reason"

  if ! is_outage_high_risk; then
    append_diagnostic_record "$COMPLETE_EVENT" "$stage" "outage_deferred" "$failure"
    return 0
  fi

  # An atomic mkdir elects one full warning until a valid evaluation returns.
  if mkdir -p "$RUN_DIR" 2>/dev/null &&
     (umask 077; mkdir "$OUTAGE_WARNING_MARKER") 2>/dev/null; then
    reason="$reason Restart the DollhouseMCP server, check the port file at $PORT_FILE, and see diagnostics at $DIAGNOSTICS_LOG."
  fi

  # These installed hooks cannot request a native prompt.
  case "$HOOK_PLATFORM" in
    codex|gemini|windsurf) decision="deny" ;;
    cursor)
      case "$HOOK_EVENT" in
        beforeShellExecution|beforeMCPExecution) ;;
        *) decision="deny" ;;
      esac
      ;;
  esac

  if [[ "$HOOK_PLATFORM" == "windsurf" ]]; then
    append_diagnostic_record "$COMPLETE_EVENT" "$stage" "outage_$decision" "$failure"
    printf '%s\n' "$reason" >&2
    return 2
  fi

  if ! EMITTED_RESPONSE=$(format_host_decision "$decision" "$reason" 2>/dev/null); then
    printf '%s\n' "$reason" >&2
    return 2
  fi
  append_diagnostic_record "$COMPLETE_EVENT" "$stage" "outage_$decision" "$failure"
  emit_response "$EMITTED_RESPONSE"
}

authority_host_for_platform() {
  case "$HOOK_PLATFORM" in
    claude_code) echo "claude-code" ;;
    codex) echo "codex" ;;
    cursor) echo "cursor" ;;
    vscode) echo "vscode" ;;
    windsurf) echo "windsurf" ;;
    gemini) echo "gemini-cli" ;;
    *) echo "" ;;
  esac

  return 0
}

resolve_authority_mode() {
  local authority_host="$1"
  local cache_file="$RUN_DIR/permission-authority-${HOOK_PLATFORM}.cache"
  local resolved

  if [[ -z "$authority_host" || ! -f "$AUTHORITY_FILE" ]]; then
    echo "shared"
    return 0
  fi

  if [[ -f "$cache_file" ]]; then
    local cache_age
    cache_age=$(cache_file_age_seconds "$cache_file")
    if [[ -n "$cache_age" && "$cache_age" -lt "$AUTHORITY_CACHE_TTL_SECONDS" ]]; then
      resolved=$(tr -d '\r\n' < "$cache_file" 2>/dev/null)
      if [[ -n "$resolved" ]]; then
        debug "Authority cache hit for ${authority_host}: $resolved"
        echo "$resolved"
        return 0
      fi
    fi
  fi

  resolved=$(jq -r --arg host "$authority_host" '.hosts[$host].mode // .defaultMode // "shared"' "$AUTHORITY_FILE" 2>/dev/null)
  if [[ -z "$resolved" || "$resolved" == "null" ]]; then
    resolved="shared"
  fi

  printf '%s' "$resolved" > "$cache_file" 2>/dev/null || true
  echo "$resolved"
  return 0
}

cache_file_age_seconds() {
  local file_path="$1"
  local modified_epoch

  modified_epoch=$(stat -f %m "$file_path" 2>/dev/null || stat -c %Y "$file_path" 2>/dev/null)
  if [[ -z "$modified_epoch" ]]; then
    return 1
  fi

  echo $(( $(date +%s) - modified_epoch ))
  return 0
}

format_host_decision() {
  local decision="$1"
  local reason="$2"
  jq -cn --arg platform "$HOOK_PLATFORM" --arg decision "$decision" --arg reason "$reason" '
    if $platform == "cursor" then {permission: $decision, user_message: $reason}
    elif $platform == "gemini" then {decision: $decision, reason: $reason}
    else {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: $decision,
        permissionDecisionReason: $reason
      }
    }
    end
  '
}

# Validate the response before treating no output as intentional. The Codex
# adapter uses an empty object for evaluated allows.
normalize_response() {
  local response="$1"
  jq -ce --arg platform "$HOOK_PLATFORM" '
    def valid_decision: IN("allow", "deny", "ask");
    def optional_reason: . == null or type == "string";
    if type != "object" then
      empty
    elif .status == "outage" then
      {status: "outage"}
    elif $platform == "codex" and length == 0 then
      {status: "success"}
    else
      (if has("hookSpecificOutput") then
         .hookSpecificOutput
         | objects
         | select(.hookEventName == null or .hookEventName == "PreToolUse")
         | .permissionDecision
       elif $platform == "cursor" then .permission // .decision
       elif $platform == "windsurf" or $platform == "vscode" then
         .decision // (if (.allowed | type) == "boolean" then (if .allowed then "allow" else "deny" end) else null end)
       else .decision
       end) as $decision
      | (.hookSpecificOutput.permissionDecisionReason // .hookSpecificOutput.reason // .reason // .message) as $reason
      | select(($decision | valid_decision) and ($reason | optional_reason))
      | if $platform == "windsurf" then
          {status: "success", blocked: ($decision != "allow"), reason: $reason}
        elif $platform == "codex" and $decision == "allow" then
          {status: "success"}
        elif $platform == "codex" and $decision == "ask" then
          empty
        elif $platform == "cursor" and has("permission") then
          {status: "success", output: .}
        elif $platform == "cursor" then
          {status: "success", output: ({permission: $decision} + (if $reason then {reason: $reason} else {} end))}
        elif $platform == "gemini" then
          select(has("decision") and $decision != "ask") | {status: "success", output: .}
        elif $platform == "claude_code" and .hookSpecificOutput.hookEventName == "PreToolUse" then
          {status: "success", output: .}
        else
          {status: "success", output: {
            hookSpecificOutput: ({
              hookEventName: "PreToolUse",
              permissionDecision: $decision
            }
            + (if $platform == "claude_code" or $platform == "codex" or $reason
               then {permissionDecisionReason: ($reason // "")}
               else {} end))
          }}
        end
    end
  ' 2>/dev/null <<< "$response"
}

normalize_tool_input() {
  local name="$1"
  case "$HOOK_PLATFORM:$name" in
    vscode:runTerminalCommand|vscode:run_terminal_command|vscode:run_in_terminal|vscode:terminal_command)
      TOOL_NAME="Bash"
      TOOL_INPUT=$(jq -c '
        (.tool_input // .toolInput // .toolArgs // .input // {}) as $args
        | {command: ($args.command // $args.commandLine // "")}
        + (if (.cwd // .working_directory // .workingDirectory) == null then {}
           else {cwd: (.cwd // .working_directory // .workingDirectory)} end)
      ' <<< "$INPUT")
      ;;
    vscode:createFile|vscode:create_file|vscode:writeFile|vscode:write_file) TOOL_NAME="Write" ;;
    vscode:editFile|vscode:edit_file|vscode:editFiles|vscode:replace_string_in_file|vscode:multi_edit) TOOL_NAME="Edit" ;;
    vscode:readFile|vscode:read_file|vscode:openFile|vscode:open_file) TOOL_NAME="Read" ;;
    vscode:findFiles|vscode:find_files|vscode:glob_search) TOOL_NAME="Glob" ;;
    vscode:searchWorkspace|vscode:search_workspace|vscode:searchInFiles|vscode:grep_search) TOOL_NAME="Grep" ;;
    vscode:fetchWebPage|vscode:fetch_web_page|vscode:fetch_webpage) TOOL_NAME="WebFetch" ;;
    vscode:searchWeb|vscode:search_web) TOOL_NAME="WebSearch" ;;
    *) ;;
  esac
}

read_hook_input() {
  local parsed
  parsed=$(jq -ces 'select(length == 1) | .[0] | objects' 2>/dev/null <<< "$INPUT") || return 1
  HOOK_EVENT=$(jq -r '.hook_event_name // .hookEventName // .agent_action_name // .event_name // .eventName // .event // empty' <<< "$parsed")
  MCP_TOOL=$(jq -r 'has("mcp_server_name") or has("mcpServerName") or has("server_name")' <<< "$parsed")

  case "$HOOK_PLATFORM:$HOOK_EVENT" in
    cursor:beforeShellExecution)
      TOOL_NAME="Bash"
      TOOL_INPUT=$(jq -c '{command} + (if .cwd then {cwd} else {} end)' <<< "$parsed")
      ;;
    windsurf:pre_run_command)
      TOOL_NAME="Bash"
      TOOL_INPUT=$(jq -c '
        {command: (.tool_info.command_line // .toolInfo.commandLine // .command_line // .commandLine // .command // .input.command // .tool_input.command // "")}
        + (if (.cwd // .working_directory // .workingDirectory // .tool_info.cwd // .toolInfo.cwd) == null then {}
           else {cwd: (.cwd // .working_directory // .workingDirectory // .tool_info.cwd // .toolInfo.cwd)} end)
      ' <<< "$parsed")
      ;;
    windsurf:pre_mcp_tool_use)
      MCP_TOOL="true"
      TOOL_NAME=$(jq -r '
        .tool_info.mcp_tool_name // .tool_name // .toolName // (.tool | objects | .name)
        // .tool_info.name // .toolInfo.name // .name // .mcp_tool_name // empty | strings
      ' <<< "$parsed")
      TOOL_INPUT=$(jq -c '
        (.tool_info.mcp_tool_arguments // .tool_arguments // .toolArgs // .input.arguments // .arguments // .tool_input // .input // {})
        + ((.tool_info.mcp_server_name // .server_name // .serverName // .mcp_server_name) as $server
           | if $server == null then {} else {server_name: $server} end)
      ' <<< "$parsed")
      ;;
    *)
      TOOL_NAME=$(jq -r '.tool_name // .toolName // .tool // .name // empty | strings' <<< "$parsed")
      TOOL_INPUT=$(jq -c '[.tool_input, .toolInput, .toolArgs, .input] | map(select(. != null)) | if length == 0 then {} else first end' <<< "$parsed")
      [[ "$HOOK_EVENT" != "beforeMCPExecution" ]] || MCP_TOOL="true"
      if [[ "$HOOK_PLATFORM" == "cursor" && "$MCP_TOOL" == "true" ]]; then
        TOOL_INPUT=$(jq -c 'if type == "string" then fromjson else . end' <<< "$TOOL_INPUT")
      fi
      normalize_tool_input "$TOOL_NAME"
      ;;
  esac

  [[ -n "${TOOL_NAME//[[:space:]]/}" && -n "$TOOL_INPUT" ]] || return 1
  jq -e 'type == "object"' >/dev/null <<< "$TOOL_INPUT"
}

# shellcheck disable=SC1091 # Resolved at runtime via SCRIPT_DIR.
source "$SCRIPT_DIR/permission-port-discovery.sh"

INPUT=$(cat)
AUTHORITY_HOST=$(authority_host_for_platform)
AUTHORITY_MODE=$(resolve_authority_mode "$AUTHORITY_HOST")
debug "Authority mode for ${AUTHORITY_HOST:-unknown}: $AUTHORITY_MODE"

if [[ "$AUTHORITY_MODE" == "off" ]]; then
  append_diagnostic_record "$COMPLETE_EVENT" "authority_off" "no_decision"
  exit 0
fi

append_diagnostic_record "received_input" "received_input"
if ! read_hook_input 2>/dev/null; then
  handle_outage "parse_tool_name_failed" "could not parse the hook tool name or input"
  exit $?
fi

if ! PORT=$(resolve_permission_port); then
  handle_outage "port_discovery_failed" "no usable permission server port file was found"
  exit $?
fi

ENDPOINT="http://127.0.0.1:${PORT}/api/evaluate_permission"
debug "Endpoint: $ENDPOINT"
debug "Evaluating: $TOOL_NAME"
debug "Platform: $HOOK_PLATFORM"

# VS Code and Windsurf historically only pass the session from the environment.
case "$HOOK_PLATFORM" in
  vscode|windsurf)
    HOOK_SESSION_ID=""
    TURN_ID=""
    TOOL_USE_ID=""
    TRANSCRIPT_PATH=""
    CWD=""
    MODEL=""
    ;;
  *)
    HOOK_SESSION_ID=$(jq -r '.session_id // .sessionId // empty' <<< "$INPUT")
    TURN_ID=$(jq -r '.turn_id // .turnId // empty' <<< "$INPUT")
    TOOL_USE_ID=$(jq -r '.tool_use_id // .toolUseId // empty' <<< "$INPUT")
    TRANSCRIPT_PATH=$(jq -r '.transcript_path // .transcriptPath // empty' <<< "$INPUT")
    CWD=$(jq -r '.cwd // empty' <<< "$INPUT")
    MODEL=$(jq -r '.model // empty' <<< "$INPUT")
    ;;
esac

SESSION_ID="${DOLLHOUSE_SESSION_ID:-$HOOK_SESSION_ID}"

if [[ -n "$SESSION_ID" ]]; then
  debug "Using DOLLHOUSE_SESSION_ID=$SESSION_ID"
fi

PAYLOAD=$(jq -cn \
  --arg tool_name "$TOOL_NAME" \
  --arg platform "$HOOK_PLATFORM" \
  --arg session_id "$SESSION_ID" \
  --arg turn_id "$TURN_ID" \
  --arg tool_use_id "$TOOL_USE_ID" \
  --arg transcript_path "$TRANSCRIPT_PATH" \
  --arg cwd "$CWD" \
  --arg model "$MODEL" \
  --argjson input "$TOOL_INPUT" \
  '{
    tool_name: $tool_name,
    input: $input,
    platform: $platform
  }
  + (if ($session_id | length) > 0 then { session_id: $session_id } else {} end)
  + (if ($turn_id | length) > 0 then { turn_id: $turn_id } else {} end)
  + (if ($tool_use_id | length) > 0 then { tool_use_id: $tool_use_id } else {} end)
  + (if ($transcript_path | length) > 0 then { transcript_path: $transcript_path } else {} end)
  + (if ($cwd | length) > 0 then { cwd: $cwd } else {} end)
  + (if ($model | length) > 0 then { model: $model } else {} end)')
if [[ -z "$PAYLOAD" ]]; then
  handle_outage "parse_tool_name_failed" "could not prepare the hook request"
  exit $?
fi

# Call the DollhouseMCP permission evaluation endpoint with exponential backoff.
# Retry on transient failures (connection refused, timeout) but not on HTTP errors.
ATTEMPT=0
TIMEOUT=$INITIAL_TIMEOUT

while [[ $ATTEMPT -le $MAX_RETRIES ]]; do
  LAST_ATTEMPT="$ATTEMPT"
  CURRENT_TIMEOUT="$TIMEOUT"
  CURL_OUTPUT=$(curl -s --max-time "$TIMEOUT" --write-out '\n%{http_code}' -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    2>/dev/null)
  CURL_EXIT=$?
  LAST_CURL_EXIT="$CURL_EXIT"
  HTTP_STATUS="${CURL_OUTPUT##*$'\n'}"
  RESPONSE="${CURL_OUTPUT%$'\n'*}"

  if [[ $CURL_EXIT -eq 0 && -n "$RESPONSE" ]]; then
    if ! response_json=$(jq -cs 'if length == 1 then .[0] else null end' 2>/dev/null <<< "$RESPONSE"); then
      handle_outage "response_not_json" "the permission server returned non-JSON"
      exit $?
    fi
    if ! result=$(normalize_response "$response_json"); then
      handle_outage "response_malformed" "the permission server returned a malformed decision"
      exit $?
    fi
    if [[ $(jq -r '.status' <<< "$result") == "outage" ]]; then
      handle_outage "server_outage" "the permission server reported that evaluation is unavailable"
      exit $?
    fi
    if [[ "$HTTP_STATUS" != 2[0-9][0-9] ]]; then
      handle_outage "response_http_error" "the permission server returned an HTTP error"
      exit $?
    fi

    rmdir "$OUTAGE_WARNING_MARKER" 2>/dev/null || true
    if [[ $(jq -r '.blocked // false' <<< "$result") == "true" ]]; then
      reason=$(jq -r '.reason // empty' <<< "$result")
      [[ -z "$reason" ]] || printf '%s\n' "$reason" >&2
      exit 2
    fi

    NORMALIZED_RESPONSE=$(jq -c '.output // empty' <<< "$result")
    EMITTED_RESPONSE="$NORMALIZED_RESPONSE"
    if [[ -n "$NORMALIZED_RESPONSE" ]]; then
      append_diagnostic_record "$COMPLETE_EVENT" "response_normalized" "success"
    else
      append_diagnostic_record "$COMPLETE_EVENT" "response_allowed_without_output" "success"
    fi
    emit_response "$NORMALIZED_RESPONSE"
    exit 0
  fi

  ATTEMPT=$((ATTEMPT + 1))
  if [[ $ATTEMPT -le $MAX_RETRIES ]]; then
    BACKOFF=$((TIMEOUT * ATTEMPT))
    RETRY_MESSAGE="Attempt $ATTEMPT failed (curl exit $CURL_EXIT) — retrying in ${BACKOFF}s (timeout ${TIMEOUT}s → $((TIMEOUT * 2))s)"
    debug "$RETRY_MESSAGE"
    append_diagnostic_record "retry" "curl_retry" "retrying" "$RETRY_MESSAGE"
    sleep "$BACKOFF"
    TIMEOUT=$((TIMEOUT * 2))
  fi
done

handle_outage "curl_attempts_exhausted" "all $((MAX_RETRIES + 1)) attempts to reach the permission server failed"
exit $?
