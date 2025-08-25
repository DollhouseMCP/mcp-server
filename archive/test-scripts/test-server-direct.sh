#!/bin/bash

echo "=== Testing DollhouseMCP Server Directly ==="
echo ""
echo "This will run the server and capture ALL output..."
echo ""

# Find the global npm installation
NPM_GLOBAL=$(npm root -g)
SERVER_PATH="$NPM_GLOBAL/@dollhousemcp/mcp-server/dist/index.js"

echo "Server path: $SERVER_PATH"
echo ""

if [ ! -f "$SERVER_PATH" ]; then
    echo "ERROR: Server not found at expected path!"
    echo "Try running: npm list -g @dollhousemcp/mcp-server"
    exit 1
fi

echo "Running server for 5 seconds..."
echo "========================================="

# Run with timeout and capture all output
timeout 5s node "$SERVER_PATH" 2>&1 || true

echo "========================================="
echo ""
echo "If you see errors above, they should help identify the issue."
echo ""
echo "Common fixes:"
echo "1. Missing dependencies: npm install -g jsdom dompurify"
echo "2. Permission issues: Check ~/.dollhouse directory permissions"
echo "3. Corrupted install: npm uninstall -g @dollhousemcp/mcp-server && npm install -g @dollhousemcp/mcp-server@latest"