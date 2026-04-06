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
# auto-dollhouse#5

PORT_FILE="$HOME/.dollhouse/run/permission-server.port"

# Discover the port from the port file
if [ -f "$PORT_FILE" ]; then
  PORT=$(cat "$PORT_FILE" 2>/dev/null)
else
  # No port file — server not running, fail open
  exit 0
fi

# Validate port is a number
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  exit 0
fi

ENDPOINT="http://127.0.0.1:${PORT}/api/evaluate_permission"

# Read the hook input from stdin
INPUT=$(cat)

# Extract tool_name and tool_input from the hook payload
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}' 2>/dev/null)

# If we can't parse the input, fail open
if [ -z "$TOOL_NAME" ]; then
  exit 0
fi

# Call the DollhouseMCP permission evaluation endpoint
# Timeout is 35s to allow Drawing Room confirmation (30s server timeout + 5s buffer)
RESPONSE=$(curl -s --max-time 35 -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -d "{\"tool_name\": \"$TOOL_NAME\", \"input\": $TOOL_INPUT, \"platform\": \"claude_code\"}" \
  2>/dev/null)

# If curl failed or returned empty, fail open
if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  exit 0
fi

# Output the response directly — it's already in Claude Code hook format
echo "$RESPONSE"
