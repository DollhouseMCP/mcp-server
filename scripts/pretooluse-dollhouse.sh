#!/bin/bash
# pretooluse-dollhouse.sh — PreToolUse hook for DollhouseMCP permission evaluation
#
# Routes permission checks through DollhouseMCP's evaluate_permission endpoint.
# The DollhouseMCP web server runs alongside the MCP stdio server on a dynamic port.
# Port discovery via ~/.dollhouse/run/permission-server.port
#
# Input:  JSON on stdin { tool_name, tool_input }
# Output: JSON on stdout { decision: "allow"|"deny"|"ask", reason? }
#
# Fail-open: if the server is unreachable or returns an error, the hook allows
# the action rather than blocking the user.
#
# Set DOLLHOUSE_HOOK_DEBUG=1 for debug logging to stderr.

PORT_FILE="$HOME/.dollhouse/run/permission-server.port"
MAX_RETRIES=2
INITIAL_TIMEOUT=5

# Debug logging helper — writes to stderr so it doesn't pollute stdout
debug() {
  if [[ "${DOLLHOUSE_HOOK_DEBUG:-0}" == "1" ]]; then
    echo "[pretooluse] $*" >&2
  fi
  return 0
}

# Discover the port from the port file
if [[ -f "$PORT_FILE" ]]; then
  PORT=$(cat "$PORT_FILE" 2>/dev/null)
  debug "Port file found: $PORT"
else
  debug "No port file at $PORT_FILE — fail open"
  exit 0
fi

# Validate port is a number
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  debug "Invalid port value: $PORT — fail open"
  exit 0
fi

ENDPOINT="http://127.0.0.1:${PORT}/api/evaluate_permission"
debug "Endpoint: $ENDPOINT"

# Read the hook input from stdin
INPUT=$(cat)

# Extract tool_name and tool_input from the hook payload
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}' 2>/dev/null)

# If we can't parse the input, fail open
if [[ -z "$TOOL_NAME" ]]; then
  debug "Could not parse tool_name from input — fail open"
  exit 0
fi

debug "Evaluating: $TOOL_NAME"

# Call the DollhouseMCP permission evaluation endpoint with exponential backoff.
# Retry on transient failures (connection refused, timeout) but not on HTTP errors.
ATTEMPT=0
TIMEOUT=$INITIAL_TIMEOUT

while [[ $ATTEMPT -le $MAX_RETRIES ]]; do
  RESPONSE=$(curl -s --max-time "$TIMEOUT" -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "{\"tool_name\": \"$TOOL_NAME\", \"input\": $TOOL_INPUT, \"platform\": \"claude_code\"}" \
    2>/dev/null)
  CURL_EXIT=$?

  if [[ $CURL_EXIT -eq 0 ]] && [[ -n "$RESPONSE" ]]; then
    debug "Response (attempt $((ATTEMPT+1))): $RESPONSE"
    echo "$RESPONSE"
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
