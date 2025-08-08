#!/bin/bash

# Setup script for GitFlow Guardian hooks
# This configures Git to use our custom hooks directory

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║              🛡️  GitFlow Guardian Setup                          ║${NC}"
echo -e "${BLUE}╠════════════════════════════════════════════════════════════════╣${NC}"
echo -e "${BLUE}║                                                                  ║${NC}"
echo -e "${BLUE}║  This will install Git hooks to enforce GitFlow practices:      ║${NC}"
echo -e "${BLUE}║                                                                  ║${NC}"
echo -e "${BLUE}║  • Prevent direct commits to main/develop                       ║${NC}"
echo -e "${BLUE}║  • Enforce branch naming conventions                            ║${NC}"
echo -e "${BLUE}║  • Provide helpful reminders when switching branches            ║${NC}"
echo -e "${BLUE}║                                                                  ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo -e "${YELLOW}❌ Error: Not in a git repository${NC}"
    exit 1
fi

# Get the repository root
REPO_ROOT=$(git rev-parse --show-toplevel)

# Check if hooks directory exists
if [ ! -d "$REPO_ROOT/.githooks" ]; then
    echo -e "${YELLOW}❌ Error: .githooks directory not found${NC}"
    echo -e "${YELLOW}   Please run this from the mcp-server repository root${NC}"
    exit 1
fi

# Configure git to use our hooks directory
echo -e "${GREEN}→ Configuring Git to use .githooks directory...${NC}"
git config core.hooksPath .githooks

# Verify configuration
HOOKS_PATH=$(git config core.hooksPath)
if [ "$HOOKS_PATH" = ".githooks" ]; then
    echo -e "${GREEN}✅ Git hooks configured successfully!${NC}"
else
    echo -e "${YELLOW}⚠️  Warning: Git hooks path may not be set correctly${NC}"
    echo -e "${YELLOW}   Current path: $HOOKS_PATH${NC}"
fi

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                    ✅ Setup Complete!                           ║${NC}"
echo -e "${GREEN}╠════════════════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║                                                                  ║${NC}"
echo -e "${GREEN}║  GitFlow Guardian is now active!                                ║${NC}"
echo -e "${GREEN}║                                                                  ║${NC}"
echo -e "${GREEN}║  The hooks will:                                                ║${NC}"
echo -e "${GREEN}║  • Block commits to main/develop branches                       ║${NC}"
echo -e "${GREEN}║  • Remind you about GitFlow when switching branches             ║${NC}"
echo -e "${GREEN}║  • Suggest proper branch naming                                 ║${NC}"
echo -e "${GREEN}║                                                                  ║${NC}"
echo -e "${GREEN}║  To disable temporarily:                                        ║${NC}"
echo -e "${GREEN}║    git commit --no-verify                                       ║${NC}"
echo -e "${GREEN}║                                                                  ║${NC}"
echo -e "${GREEN}║  To disable permanently:                                        ║${NC}"
echo -e "${GREEN}║    git config --unset core.hooksPath                            ║${NC}"
echo -e "${GREEN}║                                                                  ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════════╝${NC}"

# Show current branch as a test
echo ""
echo -e "${BLUE}Current branch: $(git branch --show-current)${NC}"