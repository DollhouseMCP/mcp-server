#!/bin/bash

# Integration tests for Claude Code + DollhouseMCP Docker container
# Tests specific MCP tool functionality

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
IMAGE_NAME="claude-dollhouse-test"
TEST_RESULTS=()
FAILED_TESTS=0

# Check prerequisites
check_prerequisites() {
    echo -e "${BLUE}📋 Checking prerequisites...${NC}"
    
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        echo -e "${RED}❌ ANTHROPIC_API_KEY not set${NC}"
        exit 1
    fi
    
    if ! docker image ls | grep -q "$IMAGE_NAME"; then
        echo -e "${RED}❌ Docker image '$IMAGE_NAME' not found${NC}"
        echo "Please build the image first: docker build -f Dockerfile.claude-testing -t $IMAGE_NAME ."
        exit 1
    fi
    
    echo -e "${GREEN}✅ Prerequisites checked${NC}\n"
}

# Test function wrapper
run_test() {
    local test_name="$1"
    local test_command="$2"
    local expected_output="$3"
    
    echo -e "${YELLOW}🧪 Testing: $test_name${NC}"
    
    # Run the test
    output=$(echo "$test_command" | docker run -i --rm \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        "$IMAGE_NAME" \
        claude --model haiku \
        --mcp-config /home/claude/.config/claude-code/config.json \
        --allowedTools "mcp__dollhousemcp__*" 2>&1 || true)
    
    # Check if output contains expected string
    if echo "$output" | grep -q "$expected_output"; then
        echo -e "${GREEN}  ✅ PASSED${NC}"
        TEST_RESULTS+=("✅ $test_name")
        return 0
    else
        echo -e "${RED}  ❌ FAILED${NC}"
        echo -e "${RED}  Expected: $expected_output${NC}"
        echo -e "${RED}  Got: $(echo "$output" | head -3)...${NC}"
        TEST_RESULTS+=("❌ $test_name")
        ((FAILED_TESTS++))
        return 1
    fi
}

# Test Suite 1: Basic MCP Tool Tests
test_basic_tools() {
    echo -e "${BLUE}═══════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 1: Basic MCP Tool Tests${NC}"
    echo -e "${BLUE}═══════════════════════════════════════${NC}\n"
    
    # Test 1: List elements
    run_test "list_elements tool" \
        "Use the list_elements tool to show all personas" \
        "mcp__dollhousemcp__list_elements"
    
    # Test 2: Get build info
    run_test "get_build_info tool" \
        "Use get_build_info to show the server version" \
        "mcp__dollhousemcp__get_build_info"
    
    # Test 3: Get user identity
    run_test "get_user_identity tool" \
        "Use get_user_identity to check who I am" \
        "mcp__dollhousemcp__get_user_identity"
}

# Test Suite 2: Element Management Tests
test_element_management() {
    echo -e "\n${BLUE}═══════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 2: Element Management Tests${NC}"
    echo -e "${BLUE}═══════════════════════════════════════${NC}\n"
    
    # Test 4: Create element
    run_test "create_element tool" \
        "Use create_element to make a new test persona called TestBot" \
        "mcp__dollhousemcp__create_element"
    
    # Test 5: Validate element
    run_test "validate_element tool" \
        "Use validate_element to check if TestBot is valid" \
        "mcp__dollhousemcp__validate_element"
    
    # Test 6: Get element details
    run_test "get_element_details tool" \
        "Use get_element_details to show information about personas" \
        "mcp__dollhousemcp__get_element_details"
}

# Test Suite 3: Collection Tests
test_collection_tools() {
    echo -e "\n${BLUE}═══════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 3: Collection Tools Tests${NC}"
    echo -e "${BLUE}═══════════════════════════════════════${NC}\n"
    
    # Test 7: Browse collection
    run_test "browse_collection tool" \
        "Use browse_collection to see what's available" \
        "mcp__dollhousemcp__browse_collection"
    
    # Test 8: Search collection
    run_test "search_collection tool" \
        "Use search_collection to find creative personas" \
        "mcp__dollhousemcp__search_collection"
    
    # Test 9: Get cache health
    run_test "get_collection_cache_health tool" \
        "Use get_collection_cache_health to check the cache status" \
        "mcp__dollhousemcp__get_collection_cache_health"
}

# Test Suite 4: Configuration Tests
test_configuration_tools() {
    echo -e "\n${BLUE}═══════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 4: Configuration Tools Tests${NC}"
    echo -e "${BLUE}═══════════════════════════════════════${NC}\n"
    
    # Test 10: Get indicator config
    run_test "get_indicator_config tool" \
        "Use get_indicator_config to see current settings" \
        "mcp__dollhousemcp__get_indicator_config"
    
    # Test 11: Configure indicator
    run_test "configure_indicator tool" \
        "Use configure_indicator to set style to minimal" \
        "mcp__dollhousemcp__configure_indicator"
}

# Test Suite 5: Error Handling Tests
test_error_handling() {
    echo -e "\n${BLUE}═══════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 5: Error Handling Tests${NC}"
    echo -e "${BLUE}═══════════════════════════════════════${NC}\n"
    
    # Test 12: Invalid tool name
    run_test "Invalid tool handling" \
        "Use mcp__dollhousemcp__nonexistent_tool" \
        "not found\|does not exist\|invalid"
    
    # Test 13: Missing parameters
    run_test "Missing parameters handling" \
        "Use activate_element without any parameters" \
        "required\|missing\|parameter"
}

# Performance test
test_performance() {
    echo -e "\n${BLUE}═══════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 6: Performance Tests${NC}"
    echo -e "${BLUE}═══════════════════════════════════════${NC}\n"
    
    echo -e "${YELLOW}🧪 Testing: Response time for simple query${NC}"
    start_time=$(date +%s)
    
    echo "List one persona" | timeout 30 docker run -i --rm \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        "$IMAGE_NAME" \
        claude --model haiku \
        --mcp-config /home/claude/.config/claude-code/config.json \
        --allowedTools "mcp__dollhousemcp__list_elements" > /dev/null 2>&1
    
    end_time=$(date +%s)
    duration=$((end_time - start_time))
    
    if [ $duration -lt 10 ]; then
        echo -e "${GREEN}  ✅ PASSED (${duration}s)${NC}"
        TEST_RESULTS+=("✅ Performance: Response in ${duration}s")
    else
        echo -e "${YELLOW}  ⚠️  SLOW (${duration}s)${NC}"
        TEST_RESULTS+=("⚠️  Performance: Slow response ${duration}s")
    fi
}

# Print summary
print_summary() {
    echo -e "\n${BLUE}═══════════════════════════════════════${NC}"
    echo -e "${BLUE}         TEST SUMMARY${NC}"
    echo -e "${BLUE}═══════════════════════════════════════${NC}\n"
    
    for result in "${TEST_RESULTS[@]}"; do
        echo -e "  $result"
    done
    
    echo -e "\n${BLUE}═══════════════════════════════════════${NC}"
    
    total_tests=${#TEST_RESULTS[@]}
    passed_tests=$((total_tests - FAILED_TESTS))
    
    if [ $FAILED_TESTS -eq 0 ]; then
        echo -e "${GREEN}  ✅ ALL TESTS PASSED ($passed_tests/$total_tests)${NC}"
    else
        echo -e "${RED}  ❌ TESTS FAILED ($FAILED_TESTS/$total_tests)${NC}"
    fi
    
    echo -e "${BLUE}═══════════════════════════════════════${NC}"
}

# Main execution
main() {
    echo -e "${BLUE}🚀 DollhouseMCP Docker Integration Tests${NC}"
    echo -e "${BLUE}==========================================${NC}\n"
    
    check_prerequisites
    
    # Run test suites
    test_basic_tools
    test_element_management
    test_collection_tools
    test_configuration_tools
    test_error_handling
    test_performance
    
    # Print summary
    print_summary
    
    # Exit with appropriate code
    exit $FAILED_TESTS
}

# Run if executed directly
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main "$@"
fi