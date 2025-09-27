#!/bin/bash

echo "🧪 Running Sync Test with Personal Access Token"
echo "================================================"

# Use environment variable for PAT - never hardcode tokens!
# Export GITHUB_TEST_TOKEN before running this script
PAT="${GITHUB_TEST_TOKEN:-}"

if [ -z "$PAT" ]; then
  echo "❌ Error: GITHUB_TEST_TOKEN environment variable not set"
  echo "Usage: GITHUB_TEST_TOKEN=ghp_your_token_here ./run-sync-test-with-pat.sh"
  exit 1
fi

docker run --rm -i \
  --env-file docker/test-environment.env \
  -e GITHUB_TOKEN=$PAT \
  -e TEST_GITHUB_USER=mickdarling \
  -e TEST_GITHUB_REPO=dollhouse-test-portfolio \
  claude-mcp-test-env:develop \
  node /app/dist/index.js << 'ENDTEST'
{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}},"id":1}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"check_github_auth","arguments":{}},"id":2}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"dollhouse_config","arguments":{"action":"set","setting":"sync.enabled","value":true}},"id":3}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"sync_portfolio","arguments":{"direction":"push"}},"id":4}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"delete_element","arguments":{"name":"debug-detective","type":"personas","deleteData":true}},"id":5}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"sync_portfolio","arguments":{"direction":"pull"}},"id":6}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_element_details","arguments":{"name":"Debug Detective","type":"personas"}},"id":7}
ENDTEST

echo "Test complete!"
