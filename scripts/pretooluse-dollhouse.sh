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
LEGACY_DIAGNOSTICS_LOG="$RUN_DIR/permission-hook-diagnostics.jsonl"
DIAGNOSTICS_LOG="${DOLLHOUSE_HOOK_DIAGNOSTICS_LOG:-$RUN_DIR/permission-hook-diagnostics/permission-hook-diagnostics.jsonl}"
OUTAGE_WARNING_MARKER="$RUN_DIR/permission-hook-outage-warning"

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
  local stage="$1"
  local outcome="$2"
  local diagnostic_tool=""
  local tool_pattern='^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$'

  if [[ "$DIAGNOSTICS_LOG" == "$LEGACY_DIAGNOSTICS_LOG" || "$DIAGNOSTICS_LOG" -ef "$LEGACY_DIAGNOSTICS_LOG" ]]; then
    return 0
  fi
  if [[ "$TOOL_NAME" =~ $tool_pattern ]]; then
    diagnostic_tool="$TOOL_NAME"
  fi
  node "$SCRIPT_DIR/permission-hook-diagnostics.mjs" "$DIAGNOSTICS_LOG" \
    "$HOOK_PLATFORM" "$stage" "$outcome" "$diagnostic_tool" \
    "$((SECONDS * 1000))" "$LAST_ATTEMPT" "$CURRENT_TIMEOUT" "$LAST_CURL_EXIT" \
    >/dev/null 2>&1 || true
}

emit_response() {
  local response="$1"

  EMITTED_RESPONSE="$response"
  if [[ -n "$response" ]]; then
    printf '%s\n' "$response"
  fi

  return 0
}

is_read_only_mcp_name() {
  local tool="$1"
  local separated expanded word
  local -a words camel_words
  [[ "$tool" =~ ^[A-Za-z0-9][A-Za-z0-9_.:/-]*$ ]] || return 1
  separated="${tool//[_.:\/-]/ }"
  expanded=$(LC_ALL=C sed -E \
    -e 's/([a-z0-9])([A-Z])/\1 \2/g' \
    -e 's/([A-Z])([A-Z][a-z])/\1 \2/g' <<< "$separated") || return 1
  read -r -a words <<< "$separated"
  read -r -a camel_words <<< "$expanded"

  # Check both forms so mixed-case delimited words such as dElEtE still match.
  for word in "${words[@]}" "${camel_words[@]}"; do
    [[ " $OUTAGE_MCP_BLOCKING_WORDS " == *" $word "* ]] && return 1
  done
  [[ "${words[0]}" != "query" && "${camel_words[0]}" != "query" ]] || return 1
  if [[ "${words[0]}" == "fetch" || "${camel_words[0]}" == "fetch" ]]; then
    [[ "${words[*]}" == "fetch without side effects" ||
       "${camel_words[*]}" == "fetch without side effects" ]] || return 1
  fi
  [[ "${words[0]}" =~ $OUTAGE_MCP_READ_ONLY_PATTERN ||
     "${camel_words[0]}" =~ $OUTAGE_MCP_READ_ONLY_PATTERN ]]
}

is_outage_high_risk() (
  local name configured_tool mcp_name match_status
  local -a high_risk_tools
  # Scope case-insensitive matching to this check, including user-supplied EREs.
  shopt -s nocasematch
  # A payload with no usable tool name cannot be shown to be low-risk.
  [[ -n "${TOOL_NAME//[[:space:]]/}" ]] || return 0
  name="$TOOL_NAME"
  case "$HOOK_PLATFORM:$name" in
    cursor:shell|codex:exec_command|codex:shell_command|gemini:run_shell_command) name="bash" ;;
    cursor:delete|gemini:write_file) name="write" ;;
    gemini:replace) name="edit" ;;
    gemini:web_fetch) name="webfetch" ;;
    *) ;;
  esac
  read -r -a high_risk_tools <<< "$OUTAGE_HIGH_RISK_TOOLS"
  for configured_tool in "${high_risk_tools[@]}"; do
    [[ "$name" == "$configured_tool" ]] && return 0
  done

  case "$name" in
    mcp__?*__*)
      mcp_name="${name:5}"
      mcp_name="${mcp_name#*__}"
      ;;
    mcp:*) mcp_name="${name:4}" ;;
    # These spellings identify MCP, but do not reliably delimit the tool name.
    mcp_*|mcp/*) return 0 ;;
    *)
      [[ "$MCP_TOOL" == "true" ]] || return 1
      mcp_name="$name"
      ;;
  esac
  [[ -n "$mcp_name" ]] || return 0
  if [[ -n "$OUTAGE_MCP_HIGH_RISK_PATTERN" ]]; then
    [[ "$name" =~ $OUTAGE_MCP_HIGH_RISK_PATTERN ]]
    match_status=$?
    [[ "$match_status" == "1" ]] || return 0
  fi
  # A nonmatch or an invalid read-only expression both keep the call high-risk.
  ! is_read_only_mcp_name "$mcp_name"
)

handle_outage() {
  local stage="$1"
  local failure="$2"
  local advice="${3:-Restart the DollhouseMCP server and check the port file at $PORT_FILE.}"
  local reason="DollhouseMCP Gatekeeper unavailable: $failure."
  local decision="ask"
  debug "$reason"

  if ! is_outage_high_risk; then
    append_diagnostic_record "$stage" "outage_deferred"
    return 0
  fi

  if [[ "$stage" == "parse_tool_name_failed" ]]; then
    reason="$reason Check the client's hook configuration and see diagnostics at $DIAGNOSTICS_LOG."
  # An atomic mkdir elects one full warning until a valid evaluation returns.
  elif mkdir -p "$RUN_DIR" 2>/dev/null &&
       (umask 077; mkdir "$OUTAGE_WARNING_MARKER") 2>/dev/null; then
    reason="$reason $advice See diagnostics at $DIAGNOSTICS_LOG."
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
    *) ;;
  esac

  if [[ "$HOOK_PLATFORM" == "windsurf" ]]; then
    append_diagnostic_record "$stage" "outage_$decision"
    printf '%s\n' "$reason" >&2
    return 2
  fi

  if ! EMITTED_RESPONSE=$(format_host_decision "$decision" "$reason" 2>/dev/null); then
    printf '%s\n' "$reason" >&2
    return 2
  fi
  append_diagnostic_record "$stage" "outage_$decision"
  emit_response "$EMITTED_RESPONSE"
}

handle_server_outage() {
  local code="$1"
  local failure advice
  case "$code" in
    rate_limited)
      failure="permission evaluation is rate-limited"
      advice="Wait before retrying the action."
      ;;
    invalid_request)
      failure="the permission server requires a valid tool name"
      advice="Check the client's permission hook configuration."
      ;;
    evaluation_failed)
      failure="permission evaluation could not complete"
      advice="Check the server logs and restart the DollhouseMCP server if evaluation keeps failing."
      ;;
    invalid_decision)
      failure="permission evaluation returned an invalid decision"
      advice="Check that the hook and the DollhouseMCP server are on compatible versions."
      ;;
    session_unavailable)
      failure="the hook connection has no verified policy session"
      advice="Check the hook's session authentication setup. The outage policy applies until the hook can supply verified session credentials."
      ;;
    *)
      handle_outage "server_outage" "the permission server reported that evaluation is unavailable"
      return $?
      ;;
  esac
  handle_outage "server_outage" "$failure ($code)" "$advice"
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
      {status: "outage", code: (.code | strings // "")}
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
  append_diagnostic_record "authority_off" "no_decision"
  exit 0
fi

if ! read_hook_input 2>/dev/null; then
  handle_outage "parse_tool_name_failed" "could not parse the hook tool name or input"
  exit $?
fi

if ! PORT=$(resolve_permission_port); then
  handle_outage "port_discovery_failed" "the permission server may not be running (no usable permission server port file was found)"
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
REQUEST_DEADLINE=$((SECONDS + REQUEST_BUDGET_SECONDS))

while [[ $ATTEMPT -le $MAX_RETRIES ]]; do
  REMAINING=$((REQUEST_DEADLINE - SECONDS))
  (( REMAINING > 0 )) || break
  LAST_ATTEMPT="$ATTEMPT"
  CURRENT_TIMEOUT=$((TIMEOUT < REMAINING ? TIMEOUT : REMAINING))
  CURL_OUTPUT=$(curl -s --max-time "$CURRENT_TIMEOUT" --write-out '\n%{http_code}' -X POST "$ENDPOINT" \
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
      handle_server_outage "$(jq -r '.code' <<< "$result")"
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
      append_diagnostic_record "response_normalized" "success"
    else
      append_diagnostic_record "response_allowed_without_output" "success"
    fi
    emit_response "$NORMALIZED_RESPONSE"
    exit 0
  fi

  ATTEMPT=$((ATTEMPT + 1))
  if [[ $ATTEMPT -le $MAX_RETRIES ]]; then
    BACKOFF=$((1 << (ATTEMPT - 1)))
    (( BACKOFF < REQUEST_DEADLINE - SECONDS )) || break
    RETRY_MESSAGE="Attempt $ATTEMPT failed (curl exit $CURL_EXIT) — retrying in ${BACKOFF}s"
    debug "$RETRY_MESSAGE"
    append_diagnostic_record "curl_retry" "retrying"
    sleep "$BACKOFF"
    TIMEOUT=$((TIMEOUT * 2))
  fi
done

case "$LAST_CURL_EXIT" in
  7) transport_failure="the permission server is not running or is refusing connections" ;;
  28) transport_failure="the permission server is not responding (timed out)" ;;
  0) transport_failure="the permission server returned an empty response" ;;
  *) transport_failure="the permission server could not be reached" ;;
esac
handle_outage "curl_attempts_exhausted" "$transport_failure. No policy decision arrived within the hook's request budget"
exit $?
