#!/bin/bash

# Roundtrip Workflow Test Script
# Enhanced version with comprehensive testing capabilities
# Tests: Collection → Local → Modified → Portfolio → Collection

set -e  # Exit on error

# Version of this test script
TEST_SCRIPT_VERSION="2.0.0"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
PORTFOLIO_DIR="$HOME/.dollhouse/portfolio/skills"
SKILL_NAME="roundtrip-test-skill.md"
COLLECTION_URL="https://raw.githubusercontent.com/DollhouseMCP/collection/main/library/skills/roundtrip-test-skill.md"
TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")
TEST_ID=$(date +"%s")

echo -e "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║           🔄 DollhouseMCP Roundtrip Workflow Test              ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Step 1: Download from Collection
echo -e "${YELLOW}Step 1: Downloading skill from collection...${NC}"
echo "  URL: $COLLECTION_URL"

# Create portfolio directory if it doesn't exist
mkdir -p "$PORTFOLIO_DIR"

# Download the skill
if curl -s -o "$PORTFOLIO_DIR/$SKILL_NAME" "$COLLECTION_URL"; then
    echo -e "${GREEN}  ✅ Downloaded successfully${NC}"
else
    echo -e "${RED}  ❌ Failed to download${NC}"
    exit 1
fi

# Step 2: Read current version
echo -e "\n${YELLOW}Step 2: Reading current metadata...${NC}"
CURRENT_VERSION=$(grep "^version:" "$PORTFOLIO_DIR/$SKILL_NAME" | cut -d' ' -f2)
echo "  Current version: $CURRENT_VERSION"

# Calculate new version (increment patch)
IFS='.' read -ra VERSION_PARTS <<< "$CURRENT_VERSION"
MAJOR="${VERSION_PARTS[0]}"
MINOR="${VERSION_PARTS[1]}"
PATCH="${VERSION_PARTS[2]}"
NEW_PATCH=$((PATCH + 1))
NEW_VERSION="$MAJOR.$MINOR.$NEW_PATCH"
echo "  New version: $NEW_VERSION"

# Step 3: Modify the skill
echo -e "\n${YELLOW}Step 3: Modifying skill locally...${NC}"

# Create a temporary file
TEMP_FILE=$(mktemp)

# Process the file
while IFS= read -r line; do
    # Update version
    if [[ "$line" == version:* ]]; then
        echo "version: $NEW_VERSION" >> "$TEMP_FILE"
        echo -e "${GREEN}  ✅ Updated version to $NEW_VERSION${NC}"
    # Update the updated date
    elif [[ "$line" == updated:* ]]; then
        echo "updated: $(date +%Y-%m-%d)" >> "$TEMP_FILE"
        echo -e "${GREEN}  ✅ Updated date${NC}"
    else
        echo "$line" >> "$TEMP_FILE"
    fi
done < "$PORTFOLIO_DIR/$SKILL_NAME"

# Add modification note at the end
echo "" >> "$TEMP_FILE"
echo "---" >> "$TEMP_FILE"
echo "" >> "$TEMP_FILE"
echo "## Test Modification Log" >> "$TEMP_FILE"
echo "" >> "$TEMP_FILE"
echo "- **Test ID**: $TEST_ID" >> "$TEMP_FILE"
echo "- **Modified**: $TIMESTAMP" >> "$TEMP_FILE"
echo "- **User**: ${USER}@$(hostname)" >> "$TEMP_FILE"
echo "- **Version**: $CURRENT_VERSION → $NEW_VERSION" >> "$TEMP_FILE"
echo "- **Purpose**: Automated roundtrip workflow test" >> "$TEMP_FILE"

# Replace the original file
mv "$TEMP_FILE" "$PORTFOLIO_DIR/$SKILL_NAME"
echo -e "${GREEN}  ✅ Added modification log${NC}"

# Step 4: Display the changes
echo -e "\n${YELLOW}Step 4: Verification...${NC}"
echo "  File location: $PORTFOLIO_DIR/$SKILL_NAME"
echo "  File size: $(wc -c < "$PORTFOLIO_DIR/$SKILL_NAME") bytes"
echo ""
echo "  Changes made:"
echo "    - Version: $CURRENT_VERSION → $NEW_VERSION"
echo "    - Updated date to today"
echo "    - Added test modification log"

# Step 5: Instructions for Claude Desktop
echo -e "\n${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                    📋 Next Steps in Claude Desktop              ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "The skill has been downloaded and modified. Now use Claude Desktop to:"
echo ""
echo -e "${GREEN}1. Verify the skill is in your portfolio:${NC}"
echo "   list_elements --type skills"
echo ""
echo -e "${GREEN}2. Test submission WITHOUT auto-submit:${NC}"
echo "   configure_collection_submission autoSubmit: false"
echo "   submit_content \"Roundtrip Test Skill\""
echo "   (Should upload to your GitHub portfolio only)"
echo ""
echo -e "${GREEN}3. Test submission WITH auto-submit:${NC}"
echo "   configure_collection_submission autoSubmit: true"
echo "   submit_content \"Roundtrip Test Skill\""
echo "   (Should create issue in DollhouseMCP/collection)"
echo ""
echo -e "${GREEN}4. Verify results:${NC}"
echo "   - Portfolio: https://github.com/\${YOUR_USERNAME}/dollhouse-portfolio"
echo "   - Collection: https://github.com/DollhouseMCP/collection/issues"
echo ""

# Step 6: Create verification script
VERIFY_SCRIPT="$HOME/.dollhouse/verify-roundtrip.sh"
cat > "$VERIFY_SCRIPT" << 'EOF'
#!/bin/bash
# Verification script for roundtrip test

PORTFOLIO_DIR="$HOME/.dollhouse/portfolio/skills"
SKILL_FILE="$PORTFOLIO_DIR/roundtrip-test-skill.md"

echo "🔍 Roundtrip Test Verification"
echo "=============================="
echo ""

if [ -f "$SKILL_FILE" ]; then
    echo "✅ Skill file exists"
    echo ""
    echo "Metadata:"
    grep "^name:" "$SKILL_FILE"
    grep "^version:" "$SKILL_FILE"
    grep "^updated:" "$SKILL_FILE"
    grep "^author:" "$SKILL_FILE"
    echo ""
    echo "Modification log:"
    tail -n 6 "$SKILL_FILE"
else
    echo "❌ Skill file not found at: $SKILL_FILE"
fi
EOF

chmod +x "$VERIFY_SCRIPT"

echo -e "${YELLOW}Verification script created:${NC} $VERIFY_SCRIPT"
echo "Run it anytime with: $VERIFY_SCRIPT"
echo ""

echo -e "${GREEN}✨ Setup complete! The skill is ready for roundtrip testing.${NC}"
echo ""
echo "Test ID for tracking: $TEST_ID"