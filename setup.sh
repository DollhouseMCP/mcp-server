#!/bin/bash

echo "🎭 Setting up Persona MCP Server..."

# Get current directory
CURRENT_DIR=$(pwd)

# Check Node.js version
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js version 18+ required. Current version: $(node --version)"
    exit 1
fi

echo "✅ Node.js $(node --version) detected"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ Failed to install dependencies"
    exit 1
fi

# Build TypeScript
echo "🔨 Building TypeScript..."
npm run build

if [ $? -ne 0 ]; then
    echo "❌ Failed to build TypeScript"
    exit 1
fi

# Create personas directory if it doesn't exist
PERSONAS_DIR="$CURRENT_DIR/personas"
if [ ! -d "$PERSONAS_DIR" ]; then
    echo "📁 Creating personas directory at $PERSONAS_DIR..."
    mkdir -p "$PERSONAS_DIR"
fi

# Make the script executable
chmod +x dist/index.js

echo "✅ Setup complete!"
echo ""
echo "📁 Installation directory: $CURRENT_DIR"
echo "📁 Personas directory: $PERSONAS_DIR"
echo ""
echo "🚀 To start the server:"
echo "   npm start"
echo ""
echo "🔧 To run in development mode:"
echo "   npm run dev"
echo ""
echo "📝 Add this to your Claude Desktop configuration:"
echo "   File: ~/Library/Application Support/Claude/claude_desktop_config.json"
echo ""
echo "{"
echo "  \"mcpServers\": {"
echo "    \"persona-mcp-server\": {"
echo "      \"command\": \"node\","
echo "      \"args\": [\"$CURRENT_DIR/dist/index.js\"]"
echo "    }"
echo "  }"
echo "}"
echo ""
echo "🎭 Available personas:"
if [ -d "$PERSONAS_DIR" ] && [ "$(ls -A $PERSONAS_DIR/*.md 2>/dev/null)" ]; then
    for file in $PERSONAS_DIR/*.md; do
        if [ -f "$file" ]; then
            name=$(grep -m1 "^name:" "$file" | cut -d'"' -f2)
            desc=$(grep -m1 "^description:" "$file" | cut -d'"' -f2)
            echo "   • $name - $desc"
        fi
    done
else
    echo "   (No persona files found in $PERSONAS_DIR)"
    echo "   The example persona files should be placed in this directory."
fi