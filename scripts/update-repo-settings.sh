#!/bin/bash

# Script to update GitHub repository settings for DollhouseMCP/mcp-server
# This ensures consistency between package.json and GitHub repository settings

echo "📦 Updating GitHub repository settings for DollhouseMCP/mcp-server..."

# Check for required dependencies
echo "🔍 Checking dependencies..."

# Check for gh CLI
if ! command -v gh &> /dev/null; then
  echo "❌ GitHub CLI (gh) is not installed"
  echo "   Please install it from: https://cli.github.com/"
  echo "   Or via Homebrew: brew install gh"
  exit 1
fi

# Check for jq
if ! command -v jq &> /dev/null; then
  echo "⚠️  jq is not installed (optional but recommended for formatted output)"
  echo "   Install via Homebrew: brew install jq"
  echo "   Or download from: https://stedolan.github.io/jq/"
  JQ_AVAILABLE=false
else
  JQ_AVAILABLE=true
fi

# Check for Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js is not installed"
  echo "   This script requires Node.js to read package.json"
  echo "   Please install from: https://nodejs.org/"
  exit 1
fi

echo "✅ All required dependencies found"
echo ""

# Get the homepage URL from package.json
HOMEPAGE_URL=$(node -p "require('./package.json').homepage" 2>/dev/null)
PACKAGE_NAME=$(node -p "require('./package.json').name" 2>/dev/null)

if [ -z "$HOMEPAGE_URL" ]; then
  echo "❌ No homepage URL found in package.json"
  echo "   Please add a 'homepage' field to package.json"
  echo "   Example: \"homepage\": \"https://dollhousemcp.com\""
  exit 1
fi

echo "🌐 Setting homepage URL to: $HOMEPAGE_URL"

# Update the GitHub repository settings with homepage
gh repo edit DollhouseMCP/mcp-server --homepage "$HOMEPAGE_URL"

if [ $? -eq 0 ]; then
  echo "✅ Successfully updated repository homepage URL"
  echo "🔗 The website link should now appear on the GitHub repository page"
else
  echo "❌ Failed to update repository settings"
  echo ""
  echo "   Possible reasons:"
  echo "   1. You don't have write permissions to the repository"
  echo "   2. GitHub CLI is not authenticated (run: gh auth login)"
  echo "   3. Network connection issues"
  echo "   4. Repository name or organization has changed"
  echo ""
  echo "   To check your authentication status, run: gh auth status"
  exit 1
fi

# Add topics to help with NPM package discovery
echo ""
echo "📝 Adding repository topics for better discoverability..."
gh repo edit DollhouseMCP/mcp-server --add-topic "npm-package" --add-topic "mcp" --add-topic "model-context-protocol" --add-topic "ai" --add-topic "claude" --add-topic "persona-management"

if [ $? -eq 0 ]; then
  echo "✅ Successfully added repository topics"
else
  echo "⚠️  Failed to add some topics (they may already exist)"
fi

# Note about NPM package link
echo ""
echo "📦 NPM Package Information:"
echo "   Package: $PACKAGE_NAME"
echo "   URL: https://www.npmjs.com/package/$PACKAGE_NAME"
echo ""
echo "ℹ️  Note: GitHub automatically detects and displays NPM package links"
echo "   in the About section when:"
echo "   1. The repository has a package.json file"
echo "   2. The package is published to NPM"
echo "   3. The package.json 'repository' field points to this GitHub repo"
echo ""
echo "   Our package.json correctly has:"
echo "   - name: $PACKAGE_NAME"
echo "   - repository.url: git+https://github.com/DollhouseMCP/mcp-server.git"

# Verify the update
echo ""
echo "📊 Current repository settings:"

if [ "$JQ_AVAILABLE" = true ]; then
  gh repo view DollhouseMCP/mcp-server --json name,description,homepageUrl,repositoryTopics | jq '.'
else
  echo "   (Install jq for formatted output)"
  gh repo view DollhouseMCP/mcp-server --json name,description,homepageUrl,repositoryTopics
fi

echo ""
echo "✨ Repository metadata update complete!"