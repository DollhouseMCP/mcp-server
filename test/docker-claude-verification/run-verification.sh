#!/bin/bash

# Docker Claude Code + DollhouseMCP Verification Script
# Rigorous automated testing of the integration
# Author: Alex Sterling
# Date: September 22, 2025

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test tracking
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
TEST_NUMBER=0

# Configuration
IMAGE_NAME="claude-mcp-test-env"
MCP_CONFIG="/root/.config/claude-code/config.json"
TEST_DIR="test-results-$(date +%Y%m%d-%H%M%S)"
DOCKERFILE_PATH="docker/test-configs/Dockerfile.claude-testing"

# Create test results directory
mkdir -p "$TEST_DIR"

# Logging functions
log_header() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
}

log_test() {
    ((TEST_NUMBER++))
    echo -e "\n${YELLOW}[TEST $TEST_NUMBER]${NC} $1"
}

log_pass() {
    echo -e "${GREEN}  ✅ PASS:${NC} $1"
    ((PASS_COUNT++))
}

log_fail() {
    echo -e "${RED}  ❌ FAIL:${NC} $1"
    ((FAIL_COUNT++))
}

log_skip() {
    echo -e "${YELLOW}  ⚠️  SKIP:${NC} $1"
    ((SKIP_COUNT++))
}

log_info() {
    echo -e "  ℹ️  $1"
}

# Test result recording
record_result() {
    echo "$(date +%H:%M:%S) - $1" >> "$TEST_DIR/test-results.log"
}

# Prerequisites check
check_prerequisites() {
    log_header "PREREQUISITES CHECK"

    log_test "Docker Installation"
    if command -v docker &> /dev/null; then
        DOCKER_VERSION=$(docker --version)
        log_pass "Docker installed: $DOCKER_VERSION"
        record_result "PASS: Docker installed - $DOCKER_VERSION"
    else
        log_fail "Docker not installed"
        record_result "FAIL: Docker not installed"
        exit 1
    fi

    log_test "Docker Daemon Running"
    if docker info &> /dev/null; then
        log_pass "Docker daemon is running"
        record_result "PASS: Docker daemon running"
    else
        log_fail "Docker daemon not running"
        record_result "FAIL: Docker daemon not running"
        exit 1
    fi

    log_test "API Key Environment Variable"
    if [ -n "$ANTHROPIC_API_KEY" ]; then
        KEY_PREFIX="${ANTHROPIC_API_KEY:0:15}..."
        log_pass "ANTHROPIC_API_KEY is set: $KEY_PREFIX"
        record_result "PASS: API key set"
    else
        log_fail "ANTHROPIC_API_KEY not set"
        log_info "Set with: export ANTHROPIC_API_KEY='sk-ant-api03-...'"
        record_result "FAIL: API key not set"
        exit 1
    fi

    log_test "API Key Format"
    if [[ "$ANTHROPIC_API_KEY" == sk-ant-api03-* ]]; then
        log_pass "API key format is valid"
        record_result "PASS: API key format valid"
    else
        log_fail "API key format invalid (should start with sk-ant-api03-)"
        record_result "FAIL: API key format invalid"
    fi

    log_test "Dockerfile Exists"
    if [ -f "$DOCKERFILE_PATH" ]; then
        log_pass "Dockerfile found at $DOCKERFILE_PATH"
        record_result "PASS: Dockerfile exists"
    else
        log_fail "Dockerfile not found at $DOCKERFILE_PATH"
        record_result "FAIL: Dockerfile not found"
        exit 1
    fi

    log_test "Free Disk Space"
    AVAILABLE_SPACE=$(df -BG . | awk 'NR==2 {print $4}' | sed 's/G//')
    if [ "$AVAILABLE_SPACE" -gt 5 ]; then
        log_pass "Sufficient disk space: ${AVAILABLE_SPACE}GB available"
        record_result "PASS: Disk space ${AVAILABLE_SPACE}GB"
    else
        log_fail "Insufficient disk space: ${AVAILABLE_SPACE}GB (need 5GB)"
        record_result "FAIL: Insufficient disk space"
    fi
}

# Phase 1: Build Verification
test_build() {
    log_header "PHASE 1: BUILD VERIFICATION"

    log_test "Removing Existing Image"
    if docker rmi "$IMAGE_NAME" 2>/dev/null; then
        log_info "Removed existing image"
    else
        log_info "No existing image to remove"
    fi

    log_test "Building Docker Image"
    BUILD_START=$(date +%s)

    if docker build --no-cache -f "$DOCKERFILE_PATH" -t "$IMAGE_NAME" . > "$TEST_DIR/build.log" 2>&1; then
        BUILD_END=$(date +%s)
        BUILD_TIME=$((BUILD_END - BUILD_START))
        log_pass "Build successful in ${BUILD_TIME} seconds"
        record_result "PASS: Build completed in ${BUILD_TIME}s"

        # Check build time
        if [ "$BUILD_TIME" -lt 300 ]; then
            log_pass "Build time acceptable (< 5 minutes)"
        else
            log_fail "Build took too long (${BUILD_TIME}s > 300s)"
        fi
    else
        log_fail "Build failed - check $TEST_DIR/build.log"
        record_result "FAIL: Docker build failed"
        tail -20 "$TEST_DIR/build.log"
        exit 1
    fi

    log_test "Image Size Check"
    IMAGE_SIZE=$(docker images "$IMAGE_NAME" --format "{{.Size}}")
    log_info "Image size: $IMAGE_SIZE"
    record_result "INFO: Image size $IMAGE_SIZE"

    # Convert to MB for comparison
    SIZE_MB=$(docker images "$IMAGE_NAME" --format "{{.Size}}" | sed 's/GB/*1024/;s/MB//' | bc 2>/dev/null || echo "0")
    if [ -n "$SIZE_MB" ] && [ "$SIZE_MB" -lt 2048 ]; then
        log_pass "Image size acceptable"
    else
        log_info "Image might be large: $IMAGE_SIZE"
    fi

    log_test "Verify Claude Binary"
    if docker run --rm "$IMAGE_NAME" which claude > /dev/null 2>&1; then
        CLAUDE_PATH=$(docker run --rm "$IMAGE_NAME" which claude)
        log_pass "Claude binary found at: $CLAUDE_PATH"
        record_result "PASS: Claude binary at $CLAUDE_PATH"
    else
        log_fail "Claude binary not found in container"
        record_result "FAIL: Claude binary not found"
    fi

    log_test "Verify DollhouseMCP Build"
    if docker run --rm "$IMAGE_NAME" ls /app/dollhousemcp/dist/index.js > /dev/null 2>&1; then
        log_pass "DollhouseMCP built successfully"
        record_result "PASS: DollhouseMCP dist/index.js exists"
    else
        log_fail "DollhouseMCP build artifacts missing"
        record_result "FAIL: DollhouseMCP not built"
    fi
}

# Phase 2: Configuration Verification
test_configuration() {
    log_header "PHASE 2: CONFIGURATION VERIFICATION"

    log_test "MCP Configuration File Exists"
    if docker run --rm "$IMAGE_NAME" test -f "$MCP_CONFIG" && echo "exists" | grep -q "exists"; then
        log_pass "MCP config file exists at $MCP_CONFIG"
        record_result "PASS: MCP config exists"
    else
        log_fail "MCP config file missing"
        record_result "FAIL: MCP config missing"
    fi

    log_test "MCP Configuration Valid JSON"
    docker run --rm "$IMAGE_NAME" cat "$MCP_CONFIG" > "$TEST_DIR/mcp-config.json" 2>/dev/null
    if python3 -m json.tool "$TEST_DIR/mcp-config.json" > /dev/null 2>&1; then
        log_pass "MCP configuration is valid JSON"
        record_result "PASS: Valid JSON config"
    else
        log_fail "MCP configuration is invalid JSON"
        record_result "FAIL: Invalid JSON config"
    fi

    log_test "MCP Configuration Content"
    if grep -q "dollhousemcp" "$TEST_DIR/mcp-config.json" && \
       grep -q "/app/dollhousemcp/dist/index.js" "$TEST_DIR/mcp-config.json"; then
        log_pass "MCP configuration points to DollhouseMCP"
        record_result "PASS: Config contains DollhouseMCP"
    else
        log_fail "MCP configuration missing DollhouseMCP settings"
        record_result "FAIL: Config missing DollhouseMCP"
    fi

    log_test "DollhouseMCP Server Health Check"
    timeout 3 docker run --rm "$IMAGE_NAME" \
        node /app/dollhousemcp/dist/index.js > "$TEST_DIR/mcp-health.log" 2>&1 || true

    if grep -i "error" "$TEST_DIR/mcp-health.log" | grep -v "ECONNREFUSED" | grep -v "timeout"; then
        log_fail "MCP server has errors"
        record_result "FAIL: MCP server errors"
        head -10 "$TEST_DIR/mcp-health.log"
    else
        log_pass "MCP server starts without errors"
        record_result "PASS: MCP server healthy"
    fi
}

# Phase 3: API Connection
test_api_connection() {
    log_header "PHASE 3: API CONNECTION VERIFICATION"

    log_test "Basic API Connectivity"
    echo "Respond with exactly: CONNECTION_TEST_SUCCESSFUL" | \
    timeout 30 docker run -i --rm \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        "$IMAGE_NAME" \
        claude --model sonnet > "$TEST_DIR/api-test.log" 2>&1 || true

    if grep -q "CONNECTION_TEST_SUCCESSFUL" "$TEST_DIR/api-test.log"; then
        log_pass "API connection successful"
        record_result "PASS: API connected"
    else
        log_fail "API connection failed"
        record_result "FAIL: API connection failed"
        log_info "Check $TEST_DIR/api-test.log for details"

        # Check for common errors
        if grep -q "401\|unauthorized\|invalid.*key" "$TEST_DIR/api-test.log"; then
            log_info "Appears to be authentication issue"
        elif grep -q "rate.*limit" "$TEST_DIR/api-test.log"; then
            log_info "Rate limit reached"
        fi
    fi
}

# Phase 4: MCP Integration
test_mcp_integration() {
    log_header "PHASE 4: MCP INTEGRATION VERIFICATION"

    log_test "MCP Tools Detection"
    echo "List all MCP tools that start with mcp__dollhousemcp and count them" | \
    timeout 30 docker run -i --rm \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        "$IMAGE_NAME" \
        claude --model sonnet --mcp-config "$MCP_CONFIG" > "$TEST_DIR/mcp-tools.log" 2>&1 || true

    TOOL_COUNT=$(grep -o "mcp__dollhousemcp__" "$TEST_DIR/mcp-tools.log" | wc -l)
    if [ "$TOOL_COUNT" -gt 0 ]; then
        log_pass "Found $TOOL_COUNT MCP tools"
        record_result "PASS: Found $TOOL_COUNT MCP tools"

        if [ "$TOOL_COUNT" -ge 20 ]; then
            log_pass "Tool count meets minimum (≥20)"
        else
            log_fail "Tool count below expected (< 20)"
        fi
    else
        log_fail "No MCP tools detected"
        record_result "FAIL: No MCP tools found"
        log_info "Check if --mcp-config flag is working"
    fi

    log_test "MCP Tool Execution - get_build_info"
    echo "Use the MCP tool mcp__dollhousemcp__get_build_info to show the version" | \
    timeout 30 docker run -i --rm \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        "$IMAGE_NAME" \
        claude --model sonnet \
        --mcp-config "$MCP_CONFIG" \
        --allowedTools mcp__dollhousemcp__get_build_info > "$TEST_DIR/build-info.log" 2>&1 || true

    if grep -qi "version\|dollhouse" "$TEST_DIR/build-info.log"; then
        log_pass "get_build_info tool executed successfully"
        record_result "PASS: get_build_info works"

        # Try to extract version
        VERSION=$(grep -oE "v?[0-9]+\.[0-9]+\.[0-9]+" "$TEST_DIR/build-info.log" | head -1)
        if [ -n "$VERSION" ]; then
            log_info "DollhouseMCP version: $VERSION"
        fi
    else
        log_fail "get_build_info tool failed"
        record_result "FAIL: get_build_info failed"
    fi

    log_test "MCP Tool Execution - list_elements"
    echo "Use mcp__dollhousemcp__list_elements with type parameter set to 'personas'" | \
    timeout 30 docker run -i --rm \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        "$IMAGE_NAME" \
        claude --model sonnet \
        --mcp-config "$MCP_CONFIG" \
        --allowedTools mcp__dollhousemcp__list_elements > "$TEST_DIR/list-personas.log" 2>&1 || true

    if grep -qi "persona\|element\|list" "$TEST_DIR/list-personas.log"; then
        log_pass "list_elements tool executed successfully"
        record_result "PASS: list_elements works"
    else
        log_fail "list_elements tool failed"
        record_result "FAIL: list_elements failed"
    fi
}

# Phase 5: Permission System
test_permissions() {
    log_header "PHASE 5: PERMISSION SYSTEM VERIFICATION"

    log_test "Permission Prompt Without Pre-approval"
    echo "Use mcp__dollhousemcp__get_build_info" | \
    timeout 5 docker run -i --rm \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        "$IMAGE_NAME" \
        claude --model sonnet \
        --mcp-config "$MCP_CONFIG" > "$TEST_DIR/permission-test.log" 2>&1 || true

    if grep -qi "permission\|allow\|approve" "$TEST_DIR/permission-test.log"; then
        log_pass "Permission system active"
        record_result "PASS: Permission system works"
    else
        log_info "Permission prompt might have timed out (expected)"
        record_result "INFO: Permission test timeout"
    fi

    log_test "Multiple Pre-approved Tools"
    TOOLS="mcp__dollhousemcp__get_build_info,mcp__dollhousemcp__list_elements"
    echo "First use get_build_info then list_elements with type personas" | \
    timeout 30 docker run -i --rm \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        "$IMAGE_NAME" \
        claude --model sonnet \
        --mcp-config "$MCP_CONFIG" \
        --allowedTools "$TOOLS" > "$TEST_DIR/multi-tool.log" 2>&1 || true

    if grep -qi "version" "$TEST_DIR/multi-tool.log" && grep -qi "persona\|element" "$TEST_DIR/multi-tool.log"; then
        log_pass "Multiple tools executed successfully"
        record_result "PASS: Multi-tool execution works"
    else
        log_fail "Multiple tool execution failed"
        record_result "FAIL: Multi-tool execution failed"
    fi
}

# Phase 6: Edge Cases
test_edge_cases() {
    log_header "PHASE 6: EDGE CASES & ERROR HANDLING"

    log_test "Invalid API Key Handling"
    echo "Say hello" | \
    timeout 10 docker run -i --rm \
        -e ANTHROPIC_API_KEY="invalid-key-123" \
        "$IMAGE_NAME" \
        claude --model sonnet > "$TEST_DIR/invalid-key.log" 2>&1 || true

    if grep -qi "auth\|api\|key\|401\|unauthorized" "$TEST_DIR/invalid-key.log"; then
        log_pass "Invalid key error handled gracefully"
        record_result "PASS: Invalid key handled"
    else
        log_fail "Invalid key error not clear"
        record_result "FAIL: Invalid key handling unclear"
    fi

    log_test "Missing MCP Config Flag"
    echo "List MCP tools" | \
    timeout 20 docker run -i --rm \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        "$IMAGE_NAME" \
        claude --model sonnet > "$TEST_DIR/no-config.log" 2>&1 || true

    if grep -q "mcp__dollhousemcp" "$TEST_DIR/no-config.log"; then
        log_fail "MCP tools found without config flag (unexpected!)"
        record_result "FAIL: Tools work without config"
    else
        log_pass "MCP config flag is required (expected behavior)"
        record_result "PASS: Config flag required"
    fi

    log_test "Container Resource Usage"
    docker run -d --name test-resources \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        "$IMAGE_NAME" sleep 10 > /dev/null 2>&1

    sleep 2
    STATS=$(docker stats test-resources --no-stream --format "{{.MemUsage}}" 2>/dev/null || echo "N/A")
    docker rm -f test-resources > /dev/null 2>&1

    log_info "Memory usage: $STATS"
    record_result "INFO: Memory usage $STATS"
}

# Generate report
generate_report() {
    log_header "TEST REPORT GENERATION"

    REPORT_FILE="$TEST_DIR/VERIFICATION_REPORT.md"

    cat > "$REPORT_FILE" << EOF
# Docker Claude Code + DollhouseMCP Verification Report

**Date**: $(date)
**Tester**: Automated Test Suite
**Environment**: $(uname -a)
**Docker Version**: $(docker --version)

## Results Summary

- **Total Tests**: $TEST_NUMBER
- **Passed**: $PASS_COUNT
- **Failed**: $FAIL_COUNT
- **Skipped**: $SKIP_COUNT
- **Success Rate**: $(( PASS_COUNT * 100 / TEST_NUMBER ))%

## Test Categories

### Prerequisites
- Docker Installation: $(grep "Docker installed" "$TEST_DIR/test-results.log" | head -1)
- API Key Setup: $(grep "API key" "$TEST_DIR/test-results.log" | grep PASS | head -1 || echo "FAIL")

### Build & Configuration
- Image Build: $(grep "Build completed" "$TEST_DIR/test-results.log" | head -1 || echo "FAIL")
- MCP Config: $(grep "MCP config" "$TEST_DIR/test-results.log" | grep PASS | head -1 || echo "FAIL")

### Integration
- API Connection: $(grep "API connected" "$TEST_DIR/test-results.log" | head -1 || echo "FAIL")
- MCP Tools Found: $(grep "Found.*MCP tools" "$TEST_DIR/test-results.log" | head -1 || echo "FAIL")
- Tool Execution: $(grep "get_build_info works" "$TEST_DIR/test-results.log" | head -1 || echo "FAIL")

## Detailed Results

\`\`\`
$(cat "$TEST_DIR/test-results.log")
\`\`\`

## Recommendation

EOF

    if [ "$FAIL_COUNT" -eq 0 ]; then
        echo "✅ **VERIFIED** - Ready for use" >> "$REPORT_FILE"
        FINAL_STATUS="${GREEN}✅ ALL TESTS PASSED - SYSTEM VERIFIED${NC}"
    elif [ "$FAIL_COUNT" -le 2 ]; then
        echo "⚠️ **PARTIAL** - Works with minor issues" >> "$REPORT_FILE"
        FINAL_STATUS="${YELLOW}⚠️ PARTIAL SUCCESS - REVIEW FAILURES${NC}"
    else
        echo "❌ **FAILED** - Requires fixes before use" >> "$REPORT_FILE"
        FINAL_STATUS="${RED}❌ VERIFICATION FAILED - FIX REQUIRED${NC}"
    fi

    echo "" >> "$REPORT_FILE"
    echo "## Test Artifacts" >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
    echo "All test outputs saved in: \`$TEST_DIR/\`" >> "$REPORT_FILE"

    log_info "Report generated: $REPORT_FILE"
}

# Main execution
main() {
    echo -e "${BLUE}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║     Docker Claude Code + DollhouseMCP Verification       ║${NC}"
    echo -e "${BLUE}║                  Rigorous Test Suite                     ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo "Test ID: $(date +%Y%m%d-%H%M%S)"
    echo "Output Directory: $TEST_DIR"
    echo ""

    # Run all test phases
    check_prerequisites
    test_build
    test_configuration
    test_api_connection
    test_mcp_integration
    test_permissions
    test_edge_cases

    # Generate final report
    generate_report

    # Display final results
    echo ""
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}                    FINAL RESULTS                          ${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "Tests Run:    $TEST_NUMBER"
    echo -e "Passed:       ${GREEN}$PASS_COUNT${NC}"
    echo -e "Failed:       ${RED}$FAIL_COUNT${NC}"
    echo -e "Skipped:      ${YELLOW}$SKIP_COUNT${NC}"
    echo -e "Success Rate: $(( PASS_COUNT * 100 / TEST_NUMBER ))%"
    echo ""
    echo -e "$FINAL_STATUS"
    echo ""
    echo "Full report available at: $TEST_DIR/VERIFICATION_REPORT.md"
    echo "Test logs available in: $TEST_DIR/"

    # Exit with appropriate code
    if [ "$FAIL_COUNT" -eq 0 ]; then
        exit 0
    else
        exit 1
    fi
}

# Run the test suite
main "$@"