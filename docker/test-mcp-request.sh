#!/bin/bash
# Test script to verify MCP server is actually functional in Docker

set -e

echo "🚀 Starting MCP server test..."

# Simple MCP request to list tools (a standard MCP method)
MCP_REQUEST='{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}'

echo "📤 Sending MCP request: tools/list"

# Run the container, send request, capture response
RESPONSE=$(echo "$MCP_REQUEST" | docker compose -f docker/docker-compose.yml run --rm -T dollhousemcp 2>&1 || true)

echo "📥 Received response:"
echo "$RESPONSE"

# Check for valid MCP response structure
if echo "$RESPONSE" | grep -q '"jsonrpc":"2.0"'; then
    echo "✅ Valid JSON-RPC response received"
    
    if echo "$RESPONSE" | grep -q '"result"'; then
        echo "✅ Server successfully processed request"
        exit 0
    else
        echo "❌ Server responded but with error"
        exit 1
    fi
else
    echo "❌ No valid MCP response received"
    echo "Server may have started but is not responding to MCP requests"
    exit 1
fi