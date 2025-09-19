#!/bin/bash

echo "🧪 Simple Sync Test - Using OAuth in Container"
echo "================================================"
echo ""

# Run Docker with simple test commands
docker run --rm -i \
  --env-file docker/test-environment.env \
  -e TEST_GITHUB_USER=mickdarling \
  -e TEST_GITHUB_REPO=dollhouse-test-portfolio \
  -e DOLLHOUSE_GITHUB_CLIENT_ID=Ov23li9gyNZP6m9aJ2EP \
  claude-mcp-test-env:develop \
  node /app/dist/index.js << 'EOF'
{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}},"id":1}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"check_github_auth","arguments":{}},"id":2}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"dollhouse_config","arguments":{"action":"set","setting":"sync.enabled","value":true}},"id":3}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_elements","arguments":{"type":"personas"}},"id":4}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"init_portfolio","arguments":{"repository_name":"dollhouse-test-portfolio"}},"id":5}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"sync_portfolio","arguments":{"direction":"push"}},"id":6}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"delete_element","arguments":{"name":"debug-detective","type":"personas","deleteData":true}},"id":7}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"sync_portfolio","arguments":{"direction":"pull"}},"id":8}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_element_details","arguments":{"name":"Debug Detective","type":"personas"}},"id":9}
EOF

echo ""
echo "Test complete!"