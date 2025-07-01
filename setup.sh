#!/bin/bash

# DollhouseMCP Setup Script
# Automatically configures and provides Claude Desktop integration instructions

set -e

echo "🎭 DollhouseMCP Setup Script"
echo "=========================="
echo

# Get the absolute path of the current directory
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_PATH="${INSTALL_DIR}/dist/index.js"

echo "📍 Installation detected at:"
echo "   ${INSTALL_DIR}"
echo

# Install dependencies and build
echo "📦 Installing dependencies..."
npm install --silent

echo "🔨 Building TypeScript..."
npm run build

echo

# Verify build was successful
if [[ ! -f "${DIST_PATH}" ]]; then
    echo "❌ Build failed - dist/index.js not found"
    exit 1
fi

echo "✅ DollhouseMCP successfully installed and built!"
echo

# Generate Claude Desktop configuration
echo "🔧 Claude Desktop Configuration:"
echo "================================"
echo
echo "Add this to your Claude Desktop configuration file:"
echo
echo "📁 Location (macOS): ~/Library/Application Support/Claude/claude_desktop_config.json"
echo "📁 Location (Windows): %APPDATA%/Claude/claude_desktop_config.json"
echo
echo "Configuration to add:"
echo
cat << EOF
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": ["${DIST_PATH}"]
    }
  }
}
EOF
echo
echo "📝 If you already have other MCP servers configured, add just the dollhousemcp section"
echo "   to your existing mcpServers object."
echo
echo "🔄 After updating the configuration:"
echo "   1. Save the configuration file"
echo "   2. Restart Claude Desktop completely"
echo "   3. All 17 DollhouseMCP tools will be available in your next conversation"
echo
echo "🎯 Quick Test:"
echo "   Try using 'list_personas' tool in Claude to verify the installation works"
echo
echo "📚 Documentation:"
echo "   Repository: https://github.com/mickdarling/DollhouseMCP"
echo "   Marketplace: https://github.com/mickdarling/DollhouseMCP-Personas"
echo
echo "🎭 Happy persona management!"