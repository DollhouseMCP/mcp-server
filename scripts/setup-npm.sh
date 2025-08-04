#!/bin/bash

# DollhouseMCP NPM Setup Script
# Automatically configures Claude Desktop for NPM-installed DollhouseMCP

set -e

echo "🎭 DollhouseMCP NPM Setup Script"
echo "================================"
echo

# Check if DollhouseMCP is installed globally
if ! command -v dollhousemcp &> /dev/null && ! npm list -g @dollhousemcp/mcp-server &> /dev/null; then
    echo "📦 Installing DollhouseMCP globally..."
    npm install -g @dollhousemcp/mcp-server
else
    echo "✅ DollhouseMCP is already installed"
fi

echo

# Detect platform and set config file path
if [[ "$OSTYPE" == "darwin"* ]]; then
    CONFIG_FILE="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
    PLATFORM="macOS"
elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
    CONFIG_FILE="$APPDATA/Claude/claude_desktop_config.json"
    PLATFORM="Windows"
else
    CONFIG_FILE="$HOME/.config/Claude/claude_desktop_config.json"
    PLATFORM="Linux"
fi

echo "🔧 Claude Desktop Configuration"
echo "=============================="
echo "📁 Platform: $PLATFORM"
echo "📁 Config file: $CONFIG_FILE"
echo

# Ensure directory exists
CONFIG_DIR=$(dirname "$CONFIG_FILE")
mkdir -p "$CONFIG_DIR"

# Check if config file exists and read it
if [[ -f "$CONFIG_FILE" ]]; then
    echo "✅ Found existing Claude Desktop configuration"
    
    # Check if it has valid JSON
    if python3 -m json.tool "$CONFIG_FILE" > /dev/null 2>&1; then
        echo "📖 Merging with existing configuration..."
        
        # Backup existing config
        cp "$CONFIG_FILE" "$CONFIG_FILE.backup.$(date +%Y%m%d_%H%M%S)"
        echo "💾 Backup saved to: $CONFIG_FILE.backup.*"
        
        # Use Python to merge the configurations
        python3 << EOF > "$CONFIG_FILE.tmp"
import json
import sys

# Read existing config
with open("$CONFIG_FILE", 'r') as f:
    config = json.load(f)

# Ensure mcpServers exists
if 'mcpServers' not in config:
    config['mcpServers'] = {}

# Add or update dollhousemcp server for NPM installation
config['mcpServers']['dollhousemcp'] = {
    "command": "npx",
    "args": ["@dollhousemcp/mcp-server"]
}

# Pretty print the result
print(json.dumps(config, indent=2))
EOF
        
        # Move temp file to actual config
        mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
        echo "✅ Configuration updated successfully!"
        
    else
        echo "⚠️  Existing config file has invalid JSON."
        echo "Creating backup and starting fresh..."
        mv "$CONFIG_FILE" "$CONFIG_FILE.invalid.$(date +%Y%m%d_%H%M%S)"
        
        # Create fresh config
        cat > "$CONFIG_FILE" << EOF
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "npx",
      "args": ["@dollhousemcp/mcp-server"]
    }
  }
}
EOF
        echo "✅ Fresh configuration created!"
    fi
else
    echo "📝 Creating new configuration..."
    cat > "$CONFIG_FILE" << EOF
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "npx",
      "args": ["@dollhousemcp/mcp-server"]
    }
  }
}
EOF
    echo "✅ Configuration created successfully!"
fi

echo
echo "🎉 Setup Complete!"
echo "=================="
echo
echo "Next steps:"
echo "1. ⚠️  Restart Claude Desktop completely (quit and reopen)"
echo "2. 🎭 Test with: list_personas"
echo "3. 🏪 Browse collection: browse_collection"
echo "4. 🔄 Check for updates: check_for_updates"
echo
echo "📚 Documentation: https://github.com/DollhouseMCP/mcp-server"
echo "📦 NPM Package: https://www.npmjs.com/package/@dollhousemcp/mcp-server"
echo
echo "Happy persona management! 🎭"