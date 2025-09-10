#!/bin/bash

# Run DollhouseMCP in isolated test environment
# Uses dollhouse-test-portfolio repository for safe testing

set -e

echo "🧪 DollhouseMCP Test Environment Launcher"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker Desktop."
    exit 1
fi

# Build the test image if needed
echo "📦 Building test environment..."
docker build -f Dockerfile.claude-testing -t claude-mcp-test-env:latest . || {
    echo "❌ Failed to build Docker image"
    exit 1
}

# Check for GitHub token
if [ -z "$GITHUB_TOKEN" ]; then
    echo "⚠️  No GITHUB_TOKEN found. You'll need to authenticate inside the container."
    echo "   Use: setup_github_auth"
    echo ""
fi

# Run options
MODE=${1:-interactive}

case "$MODE" in
    interactive|shell)
        echo "🚀 Starting interactive test environment..."
        echo "   Repository: github.com/mickdarling/dollhouse-test-portfolio"
        echo ""
        docker run --rm -it \
            --env-file docker/test-environment.env \
            -e GITHUB_TOKEN="${GITHUB_TOKEN}" \
            -e GITHUB_CLIENT_ID="${GITHUB_CLIENT_ID}" \
            -e TEST_GITHUB_REPO=dollhouse-test-portfolio \
            -v "$(pwd)/test/fixtures:/app/test-data:ro" \
            claude-mcp-test-env:latest \
            bash
        ;;
    
    mcp)
        echo "🔧 Starting MCP server test..."
        docker run --rm -i \
            --env-file docker/test-environment.env \
            -e GITHUB_TOKEN="${GITHUB_TOKEN}" \
            -e TEST_GITHUB_REPO=dollhouse-test-portfolio \
            claude-mcp-test-env:latest \
            node /app/dollhousemcp/dist/index.js
        ;;
    
    tools)
        echo "📋 Listing available MCP tools..."
        node test-tools-list.js
        ;;
    
    sync-test)
        echo "🔄 Testing sync_portfolio with test repository..."
        echo "   This will sync with github.com/mickdarling/dollhouse-test-portfolio"
        echo ""
        # Run sync test script
        docker run --rm -i \
            --env-file docker/test-environment.env \
            -e GITHUB_TOKEN="${GITHUB_TOKEN}" \
            -e TEST_GITHUB_REPO=dollhouse-test-portfolio \
            claude-mcp-test-env:latest \
            node -e "
                console.log('Testing sync_portfolio...');
                // Add sync test logic here
            "
        ;;
    
    *)
        echo "Usage: $0 [interactive|mcp|tools|sync-test]"
        echo ""
        echo "Modes:"
        echo "  interactive  - Start bash shell in test environment (default)"
        echo "  mcp          - Run MCP server for stdio testing"
        echo "  tools        - List all available MCP tools"
        echo "  sync-test    - Test sync_portfolio with test repository"
        exit 1
        ;;
esac