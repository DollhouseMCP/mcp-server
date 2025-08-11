#!/bin/bash
# Script to clean test personas from portfolio
# Use this if you have old test personas from before the safety mechanism

PORTFOLIO_DIR="$HOME/.dollhouse/portfolio/personas"

echo "⚠️  Test Persona Cleanup Script"
echo "================================"
echo ""
echo "This will help identify and remove test personas from your portfolio."
echo "These may have been copied before the test data safety mechanism was implemented."
echo ""
echo "Portfolio directory: $PORTFOLIO_DIR"
echo ""

if [ ! -d "$PORTFOLIO_DIR" ]; then
    echo "✅ Portfolio directory doesn't exist. Nothing to clean."
    exit 0
fi

# Count total personas
TOTAL=$(ls -1 "$PORTFOLIO_DIR"/*.md 2>/dev/null | wc -l)
echo "Found $TOTAL total personas in portfolio"
echo ""

# Look for common test persona patterns
echo "Checking for test personas with common patterns..."
echo "(security-test, penetration-test, xss-, sql-injection, etc.)"
echo ""

TEST_PATTERNS=(
    "*security-test*"
    "*penetration-test*"
    "*xss-*"
    "*sql-injection*"
    "*command-injection*"
    "*path-traversal*"
    "*test-persona-*"
    "*malicious-*"
    "*exploit-*"
    "*vulnerability-*"
)

TEST_FILES=()
for pattern in "${TEST_PATTERNS[@]}"; do
    matches=$(find "$PORTFOLIO_DIR" -name "$pattern.md" 2>/dev/null)
    if [ ! -z "$matches" ]; then
        while IFS= read -r file; do
            TEST_FILES+=("$file")
        done <<< "$matches"
    fi
done

# Remove duplicates
TEST_FILES=($(printf "%s\n" "${TEST_FILES[@]}" | sort -u))

if [ ${#TEST_FILES[@]} -eq 0 ]; then
    echo "✅ No obvious test personas found!"
    echo ""
    echo "If you still see test personas in Claude Desktop:"
    echo "1. They may have different names"
    echo "2. You can manually review: ls -la $PORTFOLIO_DIR"
    echo "3. Remove suspicious ones: rm $PORTFOLIO_DIR/<filename>"
    exit 0
fi

echo "⚠️  Found ${#TEST_FILES[@]} potential test personas:"
echo ""
for file in "${TEST_FILES[@]}"; do
    basename "$file"
done
echo ""

read -p "Do you want to DELETE these test personas? (y/N): " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Deleting test personas..."
    for file in "${TEST_FILES[@]}"; do
        rm "$file"
        echo "  ✅ Deleted: $(basename "$file")"
    done
    echo ""
    echo "✨ Cleanup complete! Removed ${#TEST_FILES[@]} test personas."
    echo ""
    echo "Please restart Claude Desktop to see the changes."
else
    echo ""
    echo "❌ Cleanup cancelled. No files were deleted."
    echo ""
    echo "You can manually review and delete files:"
    echo "  cd $PORTFOLIO_DIR"
    echo "  ls -la"
    echo "  rm <filename>"
fi