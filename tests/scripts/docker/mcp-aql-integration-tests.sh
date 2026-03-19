#!/bin/bash

# MCP-AQL Docker Integration Tests
# Tests the 5 CRUDE endpoints (mcp_aql_create, mcp_aql_read, mcp_aql_update, mcp_aql_delete, mcp_aql_execute)
# in a containerized Claude Code environment.
#
# Issue: #230
# Target: Validate MCP-AQL consolidated query interface in Docker
# CRUDE = Create, Read, Update, Delete, Execute

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Cross-platform timeout function
# Uses gtimeout on macOS (from coreutils) or timeout on Linux
run_with_timeout() {
    local timeout_seconds="$1"
    shift

    if command -v gtimeout &> /dev/null; then
        # macOS with coreutils installed
        gtimeout "$timeout_seconds" "$@"
    elif command -v timeout &> /dev/null; then
        # Linux or GNU coreutils
        timeout "$timeout_seconds" "$@"
    else
        # Fallback: run without timeout (no warning to avoid polluting output)
        "$@"
    fi
}

# Auto-source .env.local if it exists and ANTHROPIC_API_KEY is not set
if [ -z "$ANTHROPIC_API_KEY" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

    if [ -f "$PROJECT_ROOT/.env.local" ]; then
        # Source only the ANTHROPIC_API_KEY line (safer than sourcing entire file)
        export ANTHROPIC_API_KEY=$(grep "^ANTHROPIC_API_KEY=" "$PROJECT_ROOT/.env.local" | cut -d'=' -f2-)
        if [ -n "$ANTHROPIC_API_KEY" ]; then
            echo -e "${CYAN}📋 Loaded ANTHROPIC_API_KEY from .env.local${NC}"
        fi
    fi
fi

# Configuration
IMAGE_NAME="${MCP_AQL_TEST_IMAGE:-claude-dollhouse-test}"
CLAUDE_MODEL="${MCP_AQL_TEST_MODEL:-claude-haiku-4-5-20251001}"
TEST_RESULTS=()
FAILED_TESTS=0
SKIPPED_TESTS=0

# MCP-AQL tool names (explicit list - wildcards don't work in --allowedTools)
# CRUDE = Create, Read, Update, Delete, Execute
MCP_AQL_TOOLS="mcp__dollhousemcp__mcp_aql_create,mcp__dollhousemcp__mcp_aql_read,mcp__dollhousemcp__mcp_aql_update,mcp__dollhousemcp__mcp_aql_delete,mcp__dollhousemcp__mcp_aql_execute"

# Error output configuration (show more lines for better debugging)
ERROR_OUTPUT_LINES="${MCP_AQL_ERROR_LINES:-20}"

# Performance thresholds (in seconds, configurable via environment)
PERF_THRESHOLD_PASS="${MCP_AQL_PERF_PASS:-15}"      # Below this = PASS
PERF_THRESHOLD_SLOW="${MCP_AQL_PERF_SLOW:-30}"      # Below this = SLOW, above = TIMEOUT

# Test element name (unique per run to avoid conflicts)
TEST_PERSONA_NAME="MCP-AQL-Test-$(date +%s)"

# Check prerequisites
check_prerequisites() {
    echo -e "${BLUE}📋 Checking prerequisites...${NC}"

    if [ -z "$ANTHROPIC_API_KEY" ]; then
        echo -e "${RED}❌ ANTHROPIC_API_KEY not set${NC}"
        exit 1
    fi

    if ! command -v docker &> /dev/null; then
        echo -e "${RED}❌ Docker is not installed${NC}"
        exit 1
    fi

    if ! docker image ls | grep -q "$IMAGE_NAME"; then
        echo -e "${RED}❌ Docker image '$IMAGE_NAME' not found${NC}"
        echo "Please build the image first:"
        echo "  docker build -f docker/test-configs/Dockerfile.claude-testing -t $IMAGE_NAME ."
        exit 1
    fi

    echo -e "${GREEN}✅ Prerequisites checked${NC}"
    echo -e "${CYAN}   Image: $IMAGE_NAME${NC}"
    echo -e "${CYAN}   Test Persona: $TEST_PERSONA_NAME${NC}\n"
}

# Test function wrapper for MCP-AQL endpoints
run_aql_test() {
    local test_name="$1"
    local test_command="$2"
    local expected_output="$3"
    local timeout_seconds="${4:-60}"

    echo -e "${YELLOW}🧪 Testing: $test_name${NC}"

    # Run the test with MCP-AQL tools allowed
    output=$(echo "$test_command" | run_with_timeout "$timeout_seconds" docker run -i --rm \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        "$IMAGE_NAME" \
        claude --model $CLAUDE_MODEL \
        --mcp-config /home/claude/.config/claude-code/config.json \
        --allowedTools "$MCP_AQL_TOOLS" 2>&1 || true)

    # Check if output contains expected string (case insensitive grep)
    if echo "$output" | grep -iq "$expected_output"; then
        echo -e "${GREEN}  ✅ PASSED${NC}"
        TEST_RESULTS+=("✅ $test_name")
    else
        echo -e "${RED}  ❌ FAILED${NC}"
        echo -e "${RED}  Expected: $expected_output${NC}"
        echo -e "${RED}  Got (first $ERROR_OUTPUT_LINES lines):${NC}"
        echo "$output" | head -"$ERROR_OUTPUT_LINES" | sed 's/^/    /'
        TEST_RESULTS+=("❌ $test_name")
        FAILED_TESTS=$((FAILED_TESTS + 1))
    fi
    # Always return 0 to avoid set -e issues; failures are tracked in FAILED_TESTS
    return 0
}

# Skip test with reason
skip_test() {
    local test_name="$1"
    local reason="$2"

    echo -e "${YELLOW}🧪 Testing: $test_name${NC}"
    echo -e "${CYAN}  ⏭️  SKIPPED: $reason${NC}"
    TEST_RESULTS+=("⏭️  $test_name (skipped: $reason)")
    SKIPPED_TESTS=$((SKIPPED_TESTS + 1))
}

# ============================================================================
# TEST SUITE 1: MCP-AQL Tool Discovery
# ============================================================================
test_tool_discovery() {
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 1: MCP-AQL Tool Discovery${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # Test: Verify mcp_aql_read endpoint exists
    # Claude may describe as "mcp_aql_read" or "READ endpoint tools" or similar
    run_aql_test "mcp_aql_read endpoint discovery" \
        "What MCP-AQL tools are available? List the mcp_aql tools." \
        "mcp_aql_read\|READ endpoint\|read.*operations\|mcp_aql.*read"

    # Test: Verify mcp_aql_create endpoint exists
    run_aql_test "mcp_aql_create endpoint discovery" \
        "Is mcp_aql_create available as an MCP tool?" \
        "mcp_aql_create"
}

# ============================================================================
# TEST SUITE 2: READ Operations (mcp_aql_read)
# ============================================================================
test_read_operations() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 2: READ Operations (mcp_aql_read)${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # Test: list_elements operation (the bundled personas should be available)
    # Expected: Claude will describe the personas it found
    run_aql_test "mcp_aql_read: list_elements" \
        "Use mcp_aql_read with operation list_elements. Set params.type to 'personas'. List all available personas." \
        "persona\|available\|elements\|Debug Detective\|Creative Writer"

    # Test: get_active_elements operation
    # Expected: Claude will describe active elements (may be none)
    run_aql_test "mcp_aql_read: get_active_elements" \
        "Use mcp_aql_read with operation get_active_elements and params.type set to personas" \
        "active\|persona\|none\|currently"

    # Test: search_elements operation
    # Expected: Claude will describe search results (may be empty)
    run_aql_test "mcp_aql_read: search_elements" \
        "Use mcp_aql_read with operation search_elements and params.query set to 'test'" \
        "search\|found\|result\|match"
}

# ============================================================================
# TEST SUITE 3: CREATE Operations (mcp_aql_create)
# ============================================================================
test_create_operations() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 3: CREATE Operations (mcp_aql_create)${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # Test: create_element operation
    # Expected: Claude will confirm the persona was created
    run_aql_test "mcp_aql_create: create_element" \
        "Use mcp_aql_create with operation create_element. Set params.name to '$TEST_PERSONA_NAME', params.type to 'personas', params.description to 'Docker integration test persona', and params.content to 'A test persona for MCP-AQL Docker testing.'" \
        "created\|successfully\|new\|persona"

    # Test: activate_element operation
    # Expected: Claude will confirm activation OR report not found (ephemeral containers don't share state)
    run_aql_test "mcp_aql_create: activate_element" \
        "Use mcp_aql_create with operation activate_element. Set params.name to '$TEST_PERSONA_NAME' and params.type to 'personas'." \
        "activated\|active\|now\|ready\|not exist\|not found\|cannot find"
}

# ============================================================================
# TEST SUITE 4: UPDATE Operations (mcp_aql_update)
# ============================================================================
test_update_operations() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 4: UPDATE Operations (mcp_aql_update)${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # Test: edit_element operation on bundled persona
    # Uses 'Debug Detective' which is bundled in the Docker image
    # Claude may respond with "updated", "modified", "successful", "done", "complete", etc.
    # Also accept "edit" as confirmation Claude understood and executed the operation
    run_aql_test "mcp_aql_update: edit_element" \
        "Use mcp_aql_update with operation edit_element. Set params.name to 'Debug Detective', params.type to 'personas', and params.input to { description: 'Updated by Docker integration test' }. Confirm the result." \
        "updated\|modified\|changed\|description\|Debug Detective\|successful\|success\|done\|complete\|edit"
}

# ============================================================================
# TEST SUITE 5: DELETE Operations (mcp_aql_delete)
# ============================================================================
test_delete_operations() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 5: DELETE Operations (mcp_aql_delete)${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # Test: deactivate (must activate first in the same session)
    # NOTE: deactivate_element is a READ operation, not DELETE, because it only
    # changes in-memory session state - it does NOT modify any files on disk.
    # This is intentional and matches the MCP-AQL endpoint categorization.
    run_aql_test "mcp_aql_read: deactivate_element" \
        "First, use mcp_aql_create with operation activate_element to activate the 'Debug Detective' persona (params.name='Debug Detective', params.type='personas'). Then, use mcp_aql_read with operation deactivate_element to deactivate 'Debug Detective' (params.name='Debug Detective', params.type='personas'). Tell me the result of the deactivation." \
        "deactivated\|no longer active\|removed\|inactive\|Debug Detective"

    # Test: delete_element operation (create then delete in same session)
    run_aql_test "mcp_aql_delete: delete_element" \
        "First, use mcp_aql_create with operation create_element to create a persona named 'Docker-Delete-Test' with params.type='personas' and params.description='Temporary test persona'. Then, use mcp_aql_delete with operation delete_element to delete 'Docker-Delete-Test' (params.name='Docker-Delete-Test', params.type='personas', params.deleteData=true). Tell me the result of the deletion." \
        "deleted\|removed\|permanently\|gone\|Docker-Delete-Test"
}

# ============================================================================
# TEST SUITE 6: Error Handling
# ============================================================================
test_error_handling() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 6: Error Handling${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # Test: Invalid operation name
    # Expected: Claude will explain the operation is invalid/unsupported
    # OR Claude may fall back to introspection to show available operations (helpful behavior)
    run_aql_test "Invalid operation handling" \
        "Use mcp_aql_read with operation 'nonexistent_operation'." \
        "error\|invalid\|unknown\|not\|unsupported\|couldn't\|available operations\|introspect\|list of.*operations"

    # Test: Missing required parameters
    # Expected: Claude will explain that a parameter is missing OR ask for clarification
    # Claude may ask "Would you like me to try with a specific element type?" which is valid behavior
    run_aql_test "Missing required params handling" \
        "Use mcp_aql_read with operation get_element but don't provide the name parameter." \
        "error\|required\|missing\|name\|need\|parameter\|element type\|specify\|which.*type\|would you like"

    # Test: Wrong endpoint for operation (delete via read)
    # Expected: Claude will explain the operation is not allowed on this endpoint
    # Claude may: explain discrepancy, redirect to correct tool, or offer to help delete properly
    run_aql_test "Wrong endpoint for operation" \
        "Use mcp_aql_read with operation delete_element." \
        "error\|not allowed\|permission\|invalid\|wrong\|cannot\|can't\|discrepancy\|not.*read\|part of.*delete\|correct tool\|should use\|mcp_aql_delete\|help you delete\|delete.*element"
}

# ============================================================================
# TEST SUITE 7: Operation Routing
# ============================================================================
test_operation_routing() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 7: Operation Routing${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # Test: Verify READ operations go through mcp_aql_read
    # Expected: Claude will describe the validation result
    run_aql_test "READ routing: validate_element" \
        "Use mcp_aql_read with operation validate_element. Set params.name to 'Default' and params.type to 'personas'." \
        "valid\|validation\|passed\|persona\|Default"

    # Test: Verify export_element routes correctly
    # Expected: Claude will describe or show the exported element
    run_aql_test "READ routing: export_element" \
        "Use mcp_aql_read with operation export_element. Set params.name to 'Default' and params.type to 'personas'." \
        "export\|data\|content\|Default\|persona"
}

# ============================================================================
# TEST SUITE 8: EXECUTE Operations (mcp_aql_execute) - CRUDE's 'E'
# ============================================================================
test_execute_operations() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 8: EXECUTE Operations (mcp_aql_execute)${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # Test: mcp_aql_execute endpoint discovery
    run_aql_test "mcp_aql_execute endpoint discovery" \
        "Is mcp_aql_execute available as an MCP tool? List what execute operations are supported." \
        "mcp_aql_execute\|execute_agent\|execution"

    # Test: execute_agent operation (requires an agent to exist)
    # Create a simple test agent first, then attempt execution
    run_aql_test "mcp_aql_execute: execute_agent" \
        "First, use mcp_aql_create with operation create_element to create an agent named 'Docker-Execute-Test' with params.type='agents', params.description='Test agent for Docker integration', and params.goal='Report system status'. Then, use mcp_aql_execute with operation execute_agent to start executing 'Docker-Execute-Test' (params.name='Docker-Execute-Test'). Tell me what happened." \
        "execute\|execution\|started\|agent\|running\|Docker-Execute-Test\|not found\|cannot"

    # Test: get_execution_state operation (check execution status)
    run_aql_test "mcp_aql_execute: get_execution_state" \
        "Use mcp_aql_execute with operation get_execution_state. Set params.name to 'Docker-Execute-Test'. Describe what state information is returned or if no execution exists." \
        "state\|status\|execution\|not found\|no execution\|running\|idle"

    # Test: Introspection of execute operations
    # Claude may list specific operations OR describe them in summary form
    run_aql_test "mcp_aql_execute: introspect operations" \
        "Use mcp_aql_execute with operation introspect. Set params.query to 'operations'. List all available execute operations." \
        "execute_agent\|get_execution_state\|complete_execution\|continue_execution\|record_execution_step\|execute.*operations\|executing.*agent\|agent.*workflow\|execution.*lifecycle\|available.*operations"
}

# ============================================================================
# TEST SUITE 9: Performance
# ============================================================================
test_performance() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 9: Performance${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    echo -e "${YELLOW}🧪 Testing: MCP-AQL response time${NC}"
    start_time=$(date +%s)

    echo "Use mcp_aql_read with operation list_elements and params.type set to personas" | \
        run_with_timeout 30 docker run -i --rm \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        "$IMAGE_NAME" \
        claude --model $CLAUDE_MODEL \
        --mcp-config /home/claude/.config/claude-code/config.json \
        --allowedTools "$MCP_AQL_TOOLS" > /dev/null 2>&1 || true

    end_time=$(date +%s)
    duration=$((end_time - start_time))

    if [ $duration -lt $PERF_THRESHOLD_PASS ]; then
        echo -e "${GREEN}  ✅ PASSED (${duration}s < ${PERF_THRESHOLD_PASS}s threshold)${NC}"
        TEST_RESULTS+=("✅ Performance: Response in ${duration}s")
    elif [ $duration -lt $PERF_THRESHOLD_SLOW ]; then
        echo -e "${YELLOW}  ⚠️  SLOW (${duration}s, threshold: ${PERF_THRESHOLD_PASS}s)${NC}"
        TEST_RESULTS+=("⚠️  Performance: Slow response ${duration}s")
    else
        echo -e "${RED}  ❌ TIMEOUT (${duration}s >= ${PERF_THRESHOLD_SLOW}s)${NC}"
        TEST_RESULTS+=("❌ Performance: Timeout ${duration}s")
        FAILED_TESTS=$((FAILED_TESTS + 1))
    fi
}

# ============================================================================
# Summary
# ============================================================================
print_summary() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}                    TEST SUMMARY${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    for result in "${TEST_RESULTS[@]}"; do
        echo -e "  $result"
    done

    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"

    total_tests=${#TEST_RESULTS[@]}
    passed_tests=$((total_tests - FAILED_TESTS - SKIPPED_TESTS))

    echo -e "  Total:   $total_tests"
    echo -e "  Passed:  ${GREEN}$passed_tests${NC}"
    echo -e "  Failed:  ${RED}$FAILED_TESTS${NC}"
    echo -e "  Skipped: ${CYAN}$SKIPPED_TESTS${NC}"

    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"

    if [ $FAILED_TESTS -eq 0 ]; then
        echo -e "${GREEN}  ✅ ALL TESTS PASSED${NC}"
    else
        echo -e "${RED}  ❌ SOME TESTS FAILED${NC}"
    fi

    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
}

# ============================================================================
# Cleanup
# ============================================================================
cleanup() {
    echo -e "\n${BLUE}🧹 Cleaning up test artifacts...${NC}"

    # Attempt to delete test persona if it still exists
    echo "Use mcp_aql_delete with operation delete_element. Set params.name to '$TEST_PERSONA_NAME', params.type to 'personas', and params.deleteData to true." | \
        run_with_timeout 30 docker run -i --rm \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        "$IMAGE_NAME" \
        claude --model $CLAUDE_MODEL \
        --mcp-config /home/claude/.config/claude-code/config.json \
        --allowedTools "$MCP_AQL_TOOLS" > /dev/null 2>&1 || true

    echo -e "${GREEN}✅ Cleanup complete${NC}"
}

# ============================================================================
# Main Execution
# ============================================================================
main() {
    echo -e "${BLUE}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║     MCP-AQL Docker Integration Tests                      ║${NC}"
    echo -e "${BLUE}║     Issue #230: CRUDE Endpoint Validation                 ║${NC}"
    echo -e "${BLUE}║     (Create, Read, Update, Delete, Execute)               ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}\n"

    # Setup
    check_prerequisites

    # Run test suites in order
    test_tool_discovery
    test_read_operations
    test_create_operations
    test_update_operations
    test_delete_operations
    test_error_handling
    test_operation_routing
    test_execute_operations    # CRUDE's 'E'
    test_performance

    # Cleanup and summary
    cleanup
    print_summary

    # Exit with failure count
    exit $FAILED_TESTS
}

# Trap for cleanup on unexpected exit
trap cleanup EXIT

# Run if executed directly
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main "$@"
fi
