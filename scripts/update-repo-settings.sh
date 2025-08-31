#!/bin/bash

# Script to update GitHub repository settings for DollhouseMCP/mcp-server
# This ensures consistency between package.json and GitHub repository settings

echo "📦 Updating GitHub repository settings for DollhouseMCP/mcp-server..."

# Get the homepage URL from package.json
HOMEPAGE_URL=$(node -p "require('./package.json').homepage" 2>/dev/null)

if [ -z "$HOMEPAGE_URL" ]; then
  echo "❌ No homepage URL found in package.json"
  exit 1
fi

echo "🌐 Setting homepage URL to: $HOMEPAGE_URL"

# Update the GitHub repository settings
gh repo edit DollhouseMCP/mcp-server --homepage "$HOMEPAGE_URL"

if [ $? -eq 0 ]; then
  echo "✅ Successfully updated repository homepage URL"
  echo "🔗 The website link should now appear on the GitHub repository page"
else
  echo "❌ Failed to update repository settings"
  echo "💡 Make sure you have the necessary permissions and gh CLI is authenticated"
  exit 1
fi

# Verify the update
echo ""
echo "📊 Current repository settings:"
gh repo view DollhouseMCP/mcp-server --json name,description,homepageUrl | jq '.'