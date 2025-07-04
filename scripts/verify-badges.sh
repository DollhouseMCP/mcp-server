#!/bin/bash

echo "🔍 Verifying Platform Badges..."
echo "================================"

# Check if badges display correctly
echo -e "\n📋 Badge URLs to verify:"
echo "1. Windows: https://github.com/mickdarling/DollhouseMCP/actions/workflows/core-build-test.yml?query=branch:main"
echo "2. macOS: https://github.com/mickdarling/DollhouseMCP/actions/workflows/core-build-test.yml?query=branch:main"
echo "3. Linux: https://github.com/mickdarling/DollhouseMCP/actions/workflows/core-build-test.yml?query=branch:main"

# Extract badge URLs from README
echo -e "\n🔗 Extracting badge links from README..."
grep -E "Platform|Windows|macOS|Linux" README.md | grep -oE "https://[^)]*" | head -4

# Check if the workflow exists
echo -e "\n✅ Checking workflow existence..."
if [ -f ".github/workflows/core-build-test.yml" ]; then
    echo "Core Build & Test workflow exists"
else
    echo "❌ Core Build & Test workflow not found!"
fi

# Verify badge image URLs
echo -e "\n🖼️  Badge Image URLs:"
grep -oE "https://img.shields.io/badge/[^?]*" README.md | grep -E "Windows|macOS|Linux"

echo -e "\n📊 Platform CI Status:"
# Use GitHub CLI to check recent workflow runs
if command -v gh &> /dev/null; then
    echo "Checking recent Core Build & Test runs..."
    gh run list --workflow=core-build-test.yml --limit=1 --json status,conclusion,name | jq -r '.[] | "Status: \(.status), Conclusion: \(.conclusion)"'
else
    echo "GitHub CLI not found. Install with: brew install gh"
fi

echo -e "\n✨ Verification complete!"
echo "Please manually verify:"
echo "1. Click each badge link in the README"
echo "2. Confirm badges display correctly in light/dark themes"
echo "3. Test with a screen reader if possible"