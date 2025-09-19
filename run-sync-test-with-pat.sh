#!/bin/bash

echo "🧪 Running Sync Test with Personal Access Token"
echo "================================================"

# The PAT from earlier in the session - it was working!
PAT="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"

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
