#!/bin/bash

# Script to update GitHub repository settings for DollhouseMCP/mcp-server
# This ensures consistency between package.json and GitHub repository settings

echo "📦 Updating GitHub repository settings for DollhouseMCP/mcp-server..."

# Get the homepage URL from package.json
HOMEPAGE_URL=$(node -p "require('./package.json').homepage" 2>/dev/null)
PACKAGE_NAME=$(node -p "require('./package.json').name" 2>/dev/null)

if [ -z "$HOMEPAGE_URL" ]; then
  echo "❌ No homepage URL found in package.json"
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
  echo "💡 Make sure you have the necessary permissions and gh CLI is authenticated"
  exit 1
fi

# Add topics to help with NPM package discovery
echo ""
echo "📝 Adding repository topics for better discoverability..."
gh repo edit DollhouseMCP/mcp-server --add-topic "npm-package" --add-topic "mcp" --add-topic "model-context-protocol" --add-topic "ai" --add-topic "claude" --add-topic "persona-management"

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
gh repo view DollhouseMCP/mcp-server --json name,description,homepageUrl,repositoryTopics | jq '.'