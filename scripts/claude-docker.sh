#!/bin/bash

# Claude Docker - Run Claude Code with DollhouseMCP in Docker
# This script provides an easy interface for testing with auto-approved permissions

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Configuration
IMAGE_NAME="claude-dollhouse-test"
MCP_CONFIG="/home/claude/.config/claude-code/config.json"

# Check if API key is set
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo -e "${RED}❌ ANTHROPIC_API_KEY not set${NC}"
    echo "Please export your API key first:"
    echo "  export ANTHROPIC_API_KEY='sk-ant-api03-...'"
    exit 1
fi

# Function to show usage
show_usage() {
    echo "Usage: $0 [OPTIONS] [PROMPT]"
    echo ""
    echo "Options:"
    echo "  -b, --build           Build the Docker image first"
    echo "  -i, --interactive     Run in interactive mode"
    echo "  -a, --allow-all       Allow ALL DollhouseMCP tools (recommended)"
    echo "  -t, --allow TOOLS     Allow specific tools (comma-separated)"
    echo "  -d, --dangerous       Use --dangerously-skip-permissions (not recommended)"
    echo "  -m, --model MODEL     Use specific model (default: sonnet)"
    echo "  -h, --help            Show this help message"
    echo ""
    echo "Permission Modes:"
    echo "  Default:    Asks for permission for each tool"
    echo "  --allow-all: Pre-approves all DollhouseMCP tools (safe)"
    echo "  --allow:    Pre-approves specific tools only"
    echo "  --dangerous: Bypasses ALL permissions (risky)"
    echo ""
    echo "Examples:"
    echo "  $0 --allow-all 'List all personas'"
    echo "  $0 --allow mcp__dollhousemcp__list_elements 'Show personas'"
    echo "  $0 --interactive --allow-all"
    echo ""
    echo "MCP Tool Examples:"
    echo "  'Use mcp__dollhousemcp__list_elements to list personas'"
    echo "  'Use mcp__dollhousemcp__get_build_info to show version'"
    echo "  'Use mcp__dollhousemcp__browse_collection to browse'"
}

# Parse arguments
BUILD=false
INTERACTIVE=false
PERMISSION_MODE=""
ALLOWED_TOOLS=""
MODEL="sonnet"
PROMPT=""

while [[ $# -gt 0 ]]; do
    case $1 in
        -b|--build)
            BUILD=true
            shift
            ;;
        -i|--interactive)
            INTERACTIVE=true
            shift
            ;;
        -a|--allow-all)
            PERMISSION_MODE="allow"
            ALLOWED_TOOLS="mcp__dollhousemcp__*"
            shift
            ;;
        -t|--allow)
            PERMISSION_MODE="allow"
            ALLOWED_TOOLS="$2"
            shift 2
            ;;
        -d|--dangerous)
            PERMISSION_MODE="dangerous"
            shift
            ;;
        -m|--model)
            MODEL="$2"
            shift 2
            ;;
        -h|--help)
            show_usage
            exit 0
            ;;
        *)
            PROMPT="$*"
            break
            ;;
    esac
done

# Build if requested
if [ "$BUILD" = true ]; then
    echo -e "${YELLOW}🔨 Building Docker image...${NC}"
    docker build -f Dockerfile.claude-testing -t "$IMAGE_NAME" .
    echo -e "${GREEN}✅ Build complete${NC}"
fi

# Construct base command
BASE_CMD="docker run --rm -e ANTHROPIC_API_KEY=\"\$ANTHROPIC_API_KEY\""

# Add interactive flags if needed
if [ "$INTERACTIVE" = true ]; then
    BASE_CMD="$BASE_CMD -it"
else
    BASE_CMD="$BASE_CMD -i"
fi

# Add the image and claude command
BASE_CMD="$BASE_CMD $IMAGE_NAME claude --model $MODEL --mcp-config $MCP_CONFIG"

# Add permission handling based on mode
case "$PERMISSION_MODE" in
    "allow")
        BASE_CMD="$BASE_CMD --allowedTools \"$ALLOWED_TOOLS\""
        if [ "$ALLOWED_TOOLS" = "mcp__dollhousemcp__*" ]; then
            echo -e "${GREEN}✅ Pre-approving all DollhouseMCP tools (safe)${NC}"
        else
            echo -e "${GREEN}✅ Pre-approving specific tools: $ALLOWED_TOOLS${NC}"
        fi
        ;;
    "dangerous")
        BASE_CMD="$BASE_CMD --dangerously-skip-permissions"
        echo -e "${YELLOW}⚠️  Running with ALL permissions bypassed (use with caution)${NC}"
        ;;
    *)
        echo -e "${YELLOW}🔒 Running in default mode (will ask for permissions)${NC}"
        ;;
esac

# Execute based on mode
if [ "$INTERACTIVE" = true ]; then
    echo -e "${GREEN}🚀 Starting interactive Claude Code session...${NC}"
    eval "$BASE_CMD"
elif [ -n "$PROMPT" ]; then
    echo -e "${GREEN}📝 Sending prompt: $PROMPT${NC}"
    echo "$PROMPT" | eval "$BASE_CMD"
else
    echo -e "${RED}❌ No prompt provided and not in interactive mode${NC}"
    echo "Use -i for interactive or provide a prompt"
    show_usage
    exit 1
fi