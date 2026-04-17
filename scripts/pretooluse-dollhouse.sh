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
PORT_FILE="$RUN_DIR/permission-server.port"
AUTHORITY_FILE="$RUN_DIR/permission-authority.json"
AUTHORITY_CACHE_TTL_SECONDS=2
MAX_RETRIES=2
INITIAL_TIMEOUT=5
HOOK_PLATFORM="${DOLLHOUSE_HOOK_PLATFORM:-claude_code}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Debug logging helper — writes to stderr so it doesn't pollute stdout
debug() {
  if [[ "${DOLLHOUSE_HOOK_DEBUG:-0}" == "1" ]]; then
    echo "[pretooluse] $*" >&2
  fi
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
    *)
      echo "$response"
      ;;
  esac

  return 0
}

source "$SCRIPT_DIR/permission-port-discovery.sh"

# Discover the port from the shared file or the newest live PID-keyed file
if ! PORT=$(resolve_permission_port); then
  debug "No usable permission server port file found — fail open"
  exit 0
fi

ENDPOINT="http://127.0.0.1:${PORT}/api/evaluate_permission"
debug "Endpoint: $ENDPOINT"

# Read the hook input from stdin
INPUT=$(cat)

# Extract tool_name and tool_input from the hook payload
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // .toolName // .tool // .name // empty' 2>/dev/null)
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // .toolInput // .input // {}' 2>/dev/null)

# If we can't parse the input, fail open
if [[ -z "$TOOL_NAME" ]]; then
  debug "Could not parse tool_name from input — fail open"
  exit 0
fi

debug "Evaluating: $TOOL_NAME"
debug "Platform: $HOOK_PLATFORM"

AUTHORITY_HOST=$(authority_host_for_platform)
AUTHORITY_MODE=$(resolve_authority_mode "$AUTHORITY_HOST")
debug "Authority mode for ${AUTHORITY_HOST:-unknown}: $AUTHORITY_MODE"

if [[ "$AUTHORITY_MODE" == "off" ]]; then
  debug "Authority mode is off — hook no-op"
  exit 0
fi

if [[ -n "${DOLLHOUSE_SESSION_ID:-}" ]]; then
  debug "Using DOLLHOUSE_SESSION_ID=${DOLLHOUSE_SESSION_ID}"
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

# Call the DollhouseMCP permission evaluation endpoint with exponential backoff.
# Retry on transient failures (connection refused, timeout) but not on HTTP errors.
ATTEMPT=0
TIMEOUT=$INITIAL_TIMEOUT

while [[ $ATTEMPT -le $MAX_RETRIES ]]; do
  RESPONSE=$(curl -s --max-time "$TIMEOUT" -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    2>/dev/null)
  CURL_EXIT=$?

  if [[ $CURL_EXIT -eq 0 ]] && [[ -n "$RESPONSE" ]]; then
    debug "Response (attempt $((ATTEMPT+1))): $RESPONSE"
    if ! echo "$RESPONSE" | jq -e . >/dev/null 2>&1; then
      debug "Non-JSON response for platform $HOOK_PLATFORM — fail open"
      exit 0
    fi
    NORMALIZED_RESPONSE=$(normalize_response "$RESPONSE")
    if [[ -n "$NORMALIZED_RESPONSE" ]]; then
      echo "$NORMALIZED_RESPONSE"
    else
      debug "Malformed response for platform $HOOK_PLATFORM — fail open"
    fi
    exit 0
  fi

  ATTEMPT=$((ATTEMPT + 1))
  if [[ $ATTEMPT -le $MAX_RETRIES ]]; then
    BACKOFF=$((TIMEOUT * ATTEMPT))
    debug "Attempt $ATTEMPT failed (curl exit $CURL_EXIT) — retrying in ${BACKOFF}s (timeout ${TIMEOUT}s → $((TIMEOUT * 2))s)"
    sleep "$BACKOFF"
    TIMEOUT=$((TIMEOUT * 2))
  fi
done

# All retries exhausted — fail open
debug "All $((MAX_RETRIES + 1)) attempts failed — fail open"
exit 0
