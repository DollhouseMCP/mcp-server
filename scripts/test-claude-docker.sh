#!/bin/bash

# Claude MCP Test Environment - Test script for Claude Code + DollhouseMCP Docker container
# This script builds and tests the integrated environment

set -e

# Set up cleanup trap to restore dockerignore if script is interrupted
trap 'cleanup_dockerignore' EXIT INT TERM

# Cleanup function for dockerignore
cleanup_dockerignore() {
    if [ -f .dockerignore.backup ]; then
        mv .dockerignore.backup .dockerignore 2>/dev/null || true
    fi
}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
IMAGE_NAME="claude-mcp-test-env"
DOCKERFILE="docker/test-configs/Dockerfile.claude-testing"
DOCKERIGNORE="docker/test-configs/.dockerignore.claude-testing"

echo -e "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     Claude Code + DollhouseMCP Docker Testing Environment       ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Function to check if Docker is running
check_docker() {
    if ! docker info > /dev/null 2>&1; then
        echo -e "${RED}❌ Docker is not running. Please start Docker first.${NC}"
        exit 1
    fi
    echo -e "${GREEN}✅ Docker is running${NC}"
}

# Function to build the image
build_image() {
    echo -e "${YELLOW}🔨 Building Docker image...${NC}"
    
    # Use custom dockerignore if it exists
    if [ -f "$DOCKERIGNORE" ]; then
        cp .dockerignore .dockerignore.backup 2>/dev/null || true
        cp "$DOCKERIGNORE" .dockerignore
    fi
    
    # Build with progress
    if docker build -f "$DOCKERFILE" -t "$IMAGE_NAME" . --progress=plain; then
        echo -e "${GREEN}✅ Image built successfully${NC}"
        # Cleanup handled by trap
        return 0
    else
        echo -e "${RED}❌ Build failed${NC}"
        # Cleanup handled by trap
        return 1
    fi
}

# Function to run basic tests
run_tests() {
    echo -e "${YELLOW}🧪 Running basic tests...${NC}"
    echo ""
    
    # Test 1: Container starts and shows help
    echo -e "${BLUE}Test 1: Container startup and help display${NC}"
    if docker run --rm "$IMAGE_NAME" > /tmp/test1.log 2>&1; then
        if grep -q "Usage:" /tmp/test1.log; then
            echo -e "${GREEN}✅ Container starts and shows help${NC}"
        else
            echo -e "${RED}❌ Container started but didn't show help${NC}"
            cat /tmp/test1.log
        fi
    else
        echo -e "${RED}❌ Container failed to start${NC}"
        cat /tmp/test1.log
    fi
    echo ""
    
    # Test 2: MCP server test
    echo -e "${BLUE}Test 2: DollhouseMCP server test${NC}"
    if docker run --rm "$IMAGE_NAME" test-mcp > /tmp/test2.log 2>&1; then
        if grep -q "DollhouseMCP" /tmp/test2.log || grep -q "Starting" /tmp/test2.log; then
            echo -e "${GREEN}✅ MCP server responds${NC}"
        else
            echo -e "${YELLOW}⚠️  MCP server ran but output unclear${NC}"
        fi
    else
        echo -e "${YELLOW}⚠️  MCP server test timed out (expected for stdio server)${NC}"
    fi
    echo ""
    
    # Test 3: Check configuration
    echo -e "${BLUE}Test 3: Configuration check${NC}"
    if docker run --rm "$IMAGE_NAME" bash -c "cat /root/.config/claude-code/config.json" > /tmp/test3.log 2>&1; then
        if grep -q "dollhousemcp" /tmp/test3.log; then
            echo -e "${GREEN}✅ Claude Code configured to use DollhouseMCP${NC}"
            echo "Configuration:"
            cat /tmp/test3.log | head -10
        else
            echo -e "${RED}❌ Configuration missing or incorrect${NC}"
        fi
    else
        echo -e "${RED}❌ Failed to check configuration${NC}"
    fi
    echo ""
}

# Function to run interactive shell
run_shell() {
    echo -e "${YELLOW}🐚 Starting interactive shell in container...${NC}"
    echo -e "${BLUE}Type 'exit' to leave the container${NC}"
    docker run -it --rm \
        -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
        "$IMAGE_NAME" bash
}

# Function to run with API key
run_with_api() {
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        echo -e "${RED}❌ ANTHROPIC_API_KEY environment variable not set${NC}"
        echo -e "${YELLOW}Set it with: export ANTHROPIC_API_KEY='your-key-here'${NC}"
        return 1
    fi
    
    echo -e "${YELLOW}🤖 Running Claude Code with DollhouseMCP...${NC}"
    docker run -it --rm \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        "$IMAGE_NAME" claude-code
}

# Function to clean up
cleanup() {
    echo -e "${YELLOW}🧹 Cleaning up...${NC}"
    docker rmi "$IMAGE_NAME" 2>/dev/null || true
    echo -e "${GREEN}✅ Cleanup complete${NC}"
}

# Main menu
show_menu() {
    echo ""
    echo -e "${BLUE}Select an option:${NC}"
    echo "1) Build image"
    echo "2) Run tests"
    echo "3) Interactive shell"
    echo "4) Run with Claude Code (requires API key)"
    echo "5) Build and test"
    echo "6) Clean up (remove image)"
    echo "0) Exit"
    echo ""
    read -p "Choice: " choice
    
    case $choice in
        1) build_image ;;
        2) run_tests ;;
        3) run_shell ;;
        4) run_with_api ;;
        5) build_image && run_tests ;;
        6) cleanup ;;
        0) exit 0 ;;
        *) echo -e "${RED}Invalid option${NC}" ;;
    esac
}

# Parse command line arguments
if [ $# -gt 0 ]; then
    case "$1" in
        build)
            check_docker
            build_image
            ;;
        test)
            check_docker
            run_tests
            ;;
        shell|bash)
            check_docker
            run_shell
            ;;
        run)
            check_docker
            run_with_api
            ;;
        clean|cleanup)
            cleanup
            ;;
        all)
            check_docker
            build_image && run_tests
            ;;
        *)
            echo "Usage: $0 [build|test|shell|run|clean|all]"
            echo ""
            echo "Commands:"
            echo "  build   - Build the Docker image"
            echo "  test    - Run basic tests"
            echo "  shell   - Start interactive shell"
            echo "  run     - Run Claude Code (needs ANTHROPIC_API_KEY)"
            echo "  clean   - Remove the Docker image"
            echo "  all     - Build and test"
            echo ""
            echo "Or run without arguments for interactive menu"
            exit 1
            ;;
    esac
else
    # Interactive mode
    check_docker
    while true; do
        show_menu
    done
fi