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

# Detect platform and set config file path
if [[ "$OSTYPE" == "darwin"* ]]; then
    CONFIG_FILE="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
    PLATFORM="macOS"
elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
    CONFIG_FILE="$APPDATA/Claude/claude_desktop_config.json"
    PLATFORM="Windows"
else
    CONFIG_FILE="$HOME/.config/claude/claude_desktop_config.json"
    PLATFORM="Linux"
fi

echo "🔧 Claude Desktop Configuration:"
echo "================================"
echo "📁 Platform: $PLATFORM"
echo "📁 Config file: $CONFIG_FILE"
echo

# Check if config file exists and read it
if [[ -f "$CONFIG_FILE" ]]; then
    echo "✅ Found existing Claude Desktop configuration"
    
    # Check if it has valid JSON
    if python3 -m json.tool "$CONFIG_FILE" > /dev/null 2>&1; then
        echo "📖 Reading existing configuration..."
        
        # Use Python to merge the configurations
        MERGED_CONFIG=$(python3 << EOF
import json
import sys

# Read existing config
with open("$CONFIG_FILE", 'r') as f:
    config = json.load(f)

# Ensure mcpServers exists
if 'mcpServers' not in config:
    config['mcpServers'] = {}

# Add or update dollhousemcp server
config['mcpServers']['dollhousemcp'] = {
    "command": "node",
    "args": ["$DIST_PATH"]
}

# Pretty print the result
print(json.dumps(config, indent=2))
EOF
)
        
        echo "🔄 Updated configuration (copy this entire content to your config file):"
        echo
        echo "$MERGED_CONFIG"
        echo
        echo "🎯 The dollhousemcp server has been added to your existing configuration."
        
    else
        echo "⚠️  Existing config file has invalid JSON. Here's a fresh configuration:"
        echo
        cat << EOF
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": ["$DIST_PATH"]
    }
  }
}
EOF
    fi
else
    echo "📝 No existing configuration found. Here's a fresh configuration:"
    echo
    cat << EOF
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": ["$DIST_PATH"]
    }
  }
}
EOF
    echo
    echo "💡 Create the config file at: $CONFIG_FILE"
fi
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