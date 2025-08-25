#!/bin/bash
# Test MCP server with proper protocol sequence

echo "Testing MCP server with proper initialization sequence..."

# First send initialize
echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"1.0.0","capabilities":{}},"id":1}' | node dist/index.js 2>&1 &
MCP_PID=$!

# Give it a moment to process
sleep 1

# Then send tools/list
echo '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":2}' | node dist/index.js 2>&1

# Clean up
kill $MCP_PID 2>/dev/null
