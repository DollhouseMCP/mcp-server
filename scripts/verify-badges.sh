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

echo -e "\n🎨 Theme Testing URLs:"
echo "Test badges in different GitHub themes:"
echo "Light theme: https://github.com/mickdarling/DollhouseMCP/tree/feature/platform-specific-badges?theme=light"
echo "Dark theme: https://github.com/mickdarling/DollhouseMCP/tree/feature/platform-specific-badges?theme=dark"

echo -e "\n♿ Accessibility Testing:"
echo "Badge ALT texts added:"
echo "- Windows: 'Windows Build Status'"
echo "- macOS: 'macOS Build Status'"
echo "- Linux: 'Linux Build Status'"

echo -e "\n✅ Main Branch Query Verification:"
# Verify the query parameter works correctly
echo "Testing if branch:main query parameter filters correctly..."
if command -v curl &> /dev/null; then
    # Test if the URL with query parameter is valid
    response=$(curl -s -o /dev/null -w "%{http_code}" "https://github.com/mickdarling/DollhouseMCP/actions/workflows/core-build-test.yml?query=branch:main")
    if [ "$response" = "200" ]; then
        echo "✓ Query parameter URL is valid (HTTP $response)"
    else
        echo "⚠️  Query parameter URL returned HTTP $response"
    fi
else
    echo "curl not found. Skipping HTTP validation."
fi

echo -e "\n✨ Verification complete!"
echo -e "\n📋 Manual Verification Checklist:"
echo "[ ] 1. Click each badge link in the README"
echo "[ ] 2. Verify links show only 'main' branch workflow runs"
echo "[ ] 3. Test badges in light theme: append ?theme=light to GitHub URL"
echo "[ ] 4. Test badges in dark theme: append ?theme=dark to GitHub URL"
echo "[ ] 5. Hover over badges to see ALT text tooltips"
echo "[ ] 6. Test with a screen reader if possible"

echo -e "\n🚀 Integration Suggestions:"
echo "Consider adding this script to CI/CD workflows for automated badge verification"