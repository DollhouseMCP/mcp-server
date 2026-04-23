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
# Fail-open: if the server is unreachable or returns an error, the hook allows
# the action rather than blocking the user.
#
# Set DOLLHOUSE_HOOK_DEBUG=1 for debug logging to stderr.
# Set DOLLHOUSE_HOOK_PLATFORM to override the platform sent to the server.

RUN_DIR="$HOME/.dollhouse/run"
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

INPUT=""
TOOL_NAME=""
TOOL_INPUT=""
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

build_allow_response() {
  case "$HOOK_PLATFORM" in
    claude_code|vscode)
      printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
      ;;
    codex)
      printf '%s' ''
      ;;
    cursor)
      printf '%s' '{"permission":"allow"}'
      ;;
    gemini)
      printf '%s' '{"decision":"allow"}'
      ;;
    *)
      printf '%s' '{}'
      ;;
  esac

  return 0
}

fail_open() {
  local stage="$1"
  local message="$2"
  debug "$message"
  EMITTED_RESPONSE=$(build_allow_response)
  append_diagnostic_record "complete" "$stage" "fail_open" "$message"
  emit_response "$EMITTED_RESPONSE"
  return 0
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

normalize_response() {
  local response="$1"

  case "$HOOK_PLATFORM" in
    claude_code)
      echo "$response" | jq -c '
        if (.hookSpecificOutput.permissionDecision? | type) == "string" then
          .
        elif (.decision? | type) == "string" and (.decision | IN("allow", "deny", "ask")) then
          {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: .decision,
              permissionDecisionReason: (.reason // .message // "")
            }
          }
        else
          empty
        end
      ' 2>/dev/null
      ;;
    codex)
      echo "$response" | jq -c '
        if type == "object" and (keys | length) == 0 then
          empty
        elif (.hookSpecificOutput.permissionDecision? | type) == "string" and .hookSpecificOutput.permissionDecision == "deny" then
          {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: (.hookSpecificOutput.permissionDecisionReason // .hookSpecificOutput.reason // .reason // .message // "")
            }
          }
        elif (.hookSpecificOutput.permissionDecision? | type) == "string" then
          empty
        elif (.decision? | type) == "string" and (.decision | IN("allow", "deny", "ask")) then
          if .decision == "deny"
            then {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: (.reason // .message // "")
              }
            }
            else empty
          end
        else
          empty
        end
      ' 2>/dev/null
      ;;
    *)
      echo "$response"
      ;;
  esac

  return 0
}

# shellcheck disable=SC1091 # Resolved at runtime via SCRIPT_DIR.
source "$SCRIPT_DIR/permission-port-discovery.sh"

# Read the hook input from stdin
INPUT=$(cat)
append_diagnostic_record "received_input" "received_input"

# Extract tool_name and tool_input from the hook payload
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // .toolName // .tool // .name // empty' 2>/dev/null)
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // .toolInput // .input // {}' 2>/dev/null)
HOOK_SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // .sessionId // empty' 2>/dev/null)
TURN_ID=$(echo "$INPUT" | jq -r '.turn_id // .turnId // empty' 2>/dev/null)
TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // .toolUseId // empty' 2>/dev/null)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // .transcriptPath // empty' 2>/dev/null)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
MODEL=$(echo "$INPUT" | jq -r '.model // empty' 2>/dev/null)

# If we can't parse the input, fail open
if [[ -z "$TOOL_NAME" ]]; then
  fail_open "parse_tool_name_failed" "Could not parse tool_name from input — fail open"
  exit 0
fi

# Discover the port from the shared file or the newest live PID-keyed file
if ! PORT=$(resolve_permission_port); then
  fail_open "port_discovery_failed" "No usable permission server port file found — fail open"
  exit 0
fi

ENDPOINT="http://127.0.0.1:${PORT}/api/evaluate_permission"
debug "Endpoint: $ENDPOINT"

debug "Evaluating: $TOOL_NAME"
debug "Platform: $HOOK_PLATFORM"

AUTHORITY_HOST=$(authority_host_for_platform)
AUTHORITY_MODE=$(resolve_authority_mode "$AUTHORITY_HOST")
debug "Authority mode for ${AUTHORITY_HOST:-unknown}: $AUTHORITY_MODE"

if [[ "$AUTHORITY_MODE" == "off" ]]; then
  fail_open "authority_off" "Authority mode is off — hook no-op"
  exit 0
fi

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

# Call the DollhouseMCP permission evaluation endpoint with exponential backoff.
# Retry on transient failures (connection refused, timeout) but not on HTTP errors.
ATTEMPT=0
TIMEOUT=$INITIAL_TIMEOUT

while [[ $ATTEMPT -le $MAX_RETRIES ]]; do
  LAST_ATTEMPT="$ATTEMPT"
  CURRENT_TIMEOUT="$TIMEOUT"
  RESPONSE=$(curl -s --max-time "$TIMEOUT" -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    2>/dev/null)
  CURL_EXIT=$?
  LAST_CURL_EXIT="$CURL_EXIT"

  if [[ $CURL_EXIT -eq 0 ]] && [[ -n "$RESPONSE" ]]; then
    debug "Response (attempt $((ATTEMPT+1))): $RESPONSE"
    if ! echo "$RESPONSE" | jq -e . >/dev/null 2>&1; then
      fail_open "response_not_json" "Non-JSON response for platform $HOOK_PLATFORM — fail open"
      exit 0
    fi
    NORMALIZED_RESPONSE=$(normalize_response "$RESPONSE")
    if [[ -n "$NORMALIZED_RESPONSE" ]]; then
      EMITTED_RESPONSE="$NORMALIZED_RESPONSE"
      append_diagnostic_record "complete" "response_normalized" "success"
      emit_response "$NORMALIZED_RESPONSE"
    elif [[ "$HOOK_PLATFORM" == "codex" ]]; then
      EMITTED_RESPONSE=""
      append_diagnostic_record "complete" "response_allowed_without_output" "success"
    else
      fail_open "response_malformed" "Malformed response for platform $HOOK_PLATFORM — fail open"
      exit 0
    fi
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

# All retries exhausted — fail open
fail_open "curl_attempts_exhausted" "All $((MAX_RETRIES + 1)) attempts failed — fail open"
exit 0
