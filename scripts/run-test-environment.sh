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
docker build -f Dockerfile.claude-testing -t claude-mcp-test-env:1.0.0 . || {
    echo "❌ Failed to build Docker image"
    exit 1
}

# Validate GitHub token format if provided
if [ -n "$GITHUB_TOKEN" ]; then
    # GitHub tokens should start with ghp_ (personal) or ghs_ (server) or github_pat_ (fine-grained)
    if [[ ! "$GITHUB_TOKEN" =~ ^(ghp_|ghs_|github_pat_)[a-zA-Z0-9]{36,251}$ ]]; then
        echo "⚠️  Warning: GITHUB_TOKEN format appears invalid."
        echo "   GitHub tokens should start with 'ghp_', 'ghs_', or 'github_pat_'"
        echo "   Please check your token and try again."
        echo ""
    else
        echo "✅ GitHub token format validated"
    fi
else
    echo "⚠️  No GITHUB_TOKEN found. You'll need to authenticate inside the container."
    echo "   Use: setup_github_auth"
    echo ""
fi

# Configuration from environment or defaults
TEST_GITHUB_REPO=${TEST_GITHUB_REPO:-dollhouse-test-portfolio}
TEST_GITHUB_USER=${TEST_GITHUB_USER:-mickdarling}

# Validate repository name format
if [[ ! "$TEST_GITHUB_REPO" =~ ^[a-zA-Z0-9._-]+$ ]]; then
    echo "❌ Invalid repository name: $TEST_GITHUB_REPO"
    echo "   Repository names can only contain letters, numbers, dots, underscores, and hyphens."
    exit 1
fi

# Validate username format
if [[ ! "$TEST_GITHUB_USER" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]*$ ]]; then
    echo "❌ Invalid GitHub username: $TEST_GITHUB_USER"
    echo "   GitHub usernames must start with a letter or number and can contain hyphens."
    exit 1
fi

# Run options
MODE=${1:-interactive}

case "$MODE" in
    interactive|shell)
        echo "🚀 Starting interactive test environment..."
        echo "   Repository: github.com/${TEST_GITHUB_USER}/${TEST_GITHUB_REPO}"
        echo ""
        docker run --rm -it \
            --env-file docker/test-environment.env \
            -e GITHUB_TOKEN="${GITHUB_TOKEN}" \
            -e GITHUB_CLIENT_ID="${GITHUB_CLIENT_ID}" \
            -e TEST_GITHUB_REPO="${TEST_GITHUB_REPO}" \
            -v "$(pwd)/test/fixtures:/app/test-data:ro" \
            claude-mcp-test-env:1.0.0 \
            bash
        ;;
    
    mcp)
        echo "🔧 Starting MCP server test..."
        docker run --rm -i \
            --env-file docker/test-environment.env \
            -e GITHUB_TOKEN="${GITHUB_TOKEN}" \
            -e TEST_GITHUB_REPO="${TEST_GITHUB_REPO}" \
            claude-mcp-test-env:1.0.0 \
            node /app/dollhousemcp/dist/index.js
        ;;
    
    tools)
        echo "📋 Listing available MCP tools..."
        node test-tools-list.js
        ;;
    
    sync-test)
        echo "🔄 Testing sync_portfolio with test repository..."
        echo "   This will sync with github.com/${TEST_GITHUB_USER}/${TEST_GITHUB_REPO}"
        echo ""
        # Run sync test script
        docker run --rm -i \
            --env-file docker/test-environment.env \
            -e GITHUB_TOKEN="${GITHUB_TOKEN}" \
            -e TEST_GITHUB_REPO="${TEST_GITHUB_REPO}" \
            claude-mcp-test-env:1.0.0 \
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