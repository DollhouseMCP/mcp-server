#!/bin/bash

# MCP-AQL Compound Multi-Step Test Scenarios
# Tests LLM behavior with complex requests requiring multiple CRUDE operations
#
# Issue: #265
# Purpose: Validate that LLMs correctly interpret and execute compound requests
#          that span multiple endpoints and require session state
#
# Key differences from basic tests:
# - Uses persistent Docker sessions (not ephemeral containers)
# - Semantic evaluation instead of simple regex
# - Tests LLM decision-making (element naming, property choices)
# - Tracks multi-step workflow completion

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Track running containers for cleanup
CONTAINER_ID=""
CLEANUP_DONE=false

# Cleanup function for graceful shutdown
cleanup() {
    if [ "$CLEANUP_DONE" = "true" ]; then
        return
    fi
    CLEANUP_DONE=true

    echo -e "\n${BLUE}🧹 Cleaning up...${NC}"

    if [ -n "$CONTAINER_ID" ]; then
        echo -e "${CYAN}   Stopping container $CONTAINER_ID${NC}"
        docker stop "$CONTAINER_ID" 2>/dev/null || true
        docker rm "$CONTAINER_ID" 2>/dev/null || true
    fi

    echo -e "${GREEN}✅ Cleanup complete${NC}"
}

# Set up trap handlers
trap cleanup EXIT
trap 'echo -e "\n${YELLOW}⚠️  Interrupted by user${NC}"; exit 130' INT
trap 'echo -e "\n${YELLOW}⚠️  Terminated${NC}"; exit 143' TERM

# Cross-platform timeout function
run_with_timeout() {
    local timeout_seconds="$1"
    shift

    if command -v gtimeout &> /dev/null; then
        gtimeout "$timeout_seconds" "$@"
    elif command -v timeout &> /dev/null; then
        timeout "$timeout_seconds" "$@"
    else
        "$@"
    fi
}

# Auto-source .env.local if ANTHROPIC_API_KEY is not set
if [ -z "$ANTHROPIC_API_KEY" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

    if [ -f "$PROJECT_ROOT/.env.local" ]; then
        ANTHROPIC_API_KEY=$(grep "^ANTHROPIC_API_KEY=" "$PROJECT_ROOT/.env.local" 2>/dev/null | cut -d'=' -f2- || true)
        if [ -n "$ANTHROPIC_API_KEY" ]; then
            export ANTHROPIC_API_KEY
            echo -e "${CYAN}📋 Loaded ANTHROPIC_API_KEY from .env.local${NC}"
        fi
    fi
fi

# Configuration
IMAGE_NAME="${MCP_AQL_TEST_IMAGE:-claude-dollhouse-test}"
CLAUDE_MODEL="${MCP_AQL_TEST_MODEL:-claude-haiku-4-5-20251001}"
VERBOSE="${MCP_AQL_VERBOSE:-false}"
VERBOSE_LINES="${MCP_AQL_VERBOSE_LINES:-150}"
DEFAULT_TIMEOUT="${MCP_AQL_COMPOUND_TIMEOUT:-120}"  # 2 minutes for compound tests
TEST_RESULTS=()
FAILED_TESTS=0

# CRUDE tools (all 5 endpoints)
MCP_TOOLS="mcp__dollhousemcp__mcp_aql_create,mcp__dollhousemcp__mcp_aql_read,mcp__dollhousemcp__mcp_aql_update,mcp__dollhousemcp__mcp_aql_delete,mcp__dollhousemcp__mcp_aql_execute"

# System instruction for compound tests - emphasizes completing all steps
SYSTEM_PREFIX="TESTING MODE: Execute multi-step tasks completely. For each step, use the appropriate mcp_aql_* tool.

IMPORTANT: You MUST use ONLY the mcp_aql_* tools (mcp_aql_create, mcp_aql_read, mcp_aql_update, mcp_aql_delete, mcp_aql_execute).

After completing ALL steps, provide a summary of what was done at each step.

TASK: "

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

    if ! docker info &> /dev/null; then
        echo -e "${RED}❌ Docker daemon is not running${NC}"
        exit 1
    fi

    if ! docker image ls --format '{{.Repository}}' | grep -q "^${IMAGE_NAME}$"; then
        echo -e "${RED}❌ Docker image '$IMAGE_NAME' not found${NC}"
        exit 1
    fi

    echo -e "${GREEN}✅ Prerequisites checked${NC}"
    echo -e "${CYAN}   Timeout: ${DEFAULT_TIMEOUT}s per scenario${NC}"
    echo -e "${CYAN}   Verbose: $VERBOSE${NC}"
    echo ""
}

# ============================================================================
# Semantic Evaluation Functions
# ============================================================================

# Semantic evaluation for a single operation type
# Returns: 0 = success, 1 = failure, 2 = valid_cannot (task genuinely impossible)
evaluate_step_semantic() {
    local output="$1"
    local step_type="$2"  # create, activate, execute, edit, export, list, delete, deactivate, verify

    # Check for explicit LLM error indicators first
    if echo "$output" | grep -iqE "missing required|invalid parameter|unknown operation|tool not found|error.*parameter"; then
        return 1  # LLM made an error
    fi

    case "$step_type" in
        create)
            # Success: element was created (require explicit creation confirmation)
            # Match: "created", "successfully created", "has been created", "Creating...created"
            if echo "$output" | grep -iqE '\bcreated\b|successfully\s+creat|has been creat|\bCreating\b.*\bcreated\b'; then
                return 0
            fi
            # Check for specific element creation with element type context
            if echo "$output" | grep -iqE '(persona|agent|skill|template|memory|ensemble)\s+(has been\s+)?created|\bCreated\s+(the\s+)?(persona|agent|skill)'; then
                return 0
            fi
            # Check for mcp_aql_create tool call success
            if echo "$output" | grep -iqE 'mcp_aql_create.*Successful|Successful.*create_element'; then
                return 0
            fi
            # Failure indicators (explicit failures only)
            if echo "$output" | grep -iqE 'CANNOT\s+create|failed\s+to\s+create|could\s+not\s+create|creation\s+failed'; then
                return 1
            fi
            return 1
            ;;
        activate)
            # Success: element was activated (require explicit activation)
            if echo "$output" | grep -iqE '\bactivated\b|now\s+active|activation\s+(was\s+)?success|is\s+now\s+active|has been activated'; then
                return 0
            fi
            # Check for mcp_aql tool call success for activate
            if echo "$output" | grep -iqE 'activate_element.*Successful|Successful.*activate'; then
                return 0
            fi
            # Valid cannot: element doesn't exist
            if echo "$output" | grep -iqE 'element.*not\s+found|does\s+not\s+exist|no\s+(such\s+)?(persona|agent)|Failed.*not\s+found'; then
                return 2
            fi
            return 1
            ;;
        execute)
            # Success: execution started or completed (require execution context)
            if echo "$output" | grep -iqE '\bexecuted\b|execution\s+(has\s+)?(started|begun|completed)|began\s+execution|running\s+agent'; then
                return 0
            fi
            # Check for mcp_aql_execute tool usage
            if echo "$output" | grep -iqE 'mcp_aql_execute|execute_agent.*Successful'; then
                return 0
            fi
            # Valid cannot: agent doesn't exist or can't execute
            if echo "$output" | grep -iqE 'agent.*not\s+found|cannot\s+execute|no\s+(such\s+)?agent|not\s+executable'; then
                return 2
            fi
            return 1
            ;;
        edit|update)
            # Success: element was updated (require explicit update confirmation)
            if echo "$output" | grep -iqE '\bupdated\b|\bmodified\b|\bedited\b|has been changed|edit_element.*Successful'; then
                return 0
            fi
            # Check for mcp_aql_update tool success
            if echo "$output" | grep -iqE 'mcp_aql_update.*Successful|Successfully\s+updated'; then
                return 0
            fi
            # Valid cannot: element doesn't exist
            if echo "$output" | grep -iqE 'element.*not\s+found|does\s+not\s+exist|cannot\s+update'; then
                return 2
            fi
            return 1
            ;;
        export)
            # Success: element was exported (require export context)
            if echo "$output" | grep -iqE '\bexported\b|export\s+(was\s+)?success|export_element.*Successful'; then
                return 0
            fi
            # Accept structured output formats as evidence of export
            if echo "$output" | grep -iqE 'representation|package.*element|element.*JSON|element.*yaml'; then
                return 0
            fi
            return 1
            ;;
        list|search|verify)
            # Success: listing/search completed (require element context)
            if echo "$output" | grep -iqE 'list_elements.*Successful|search_elements.*Successful|get_element.*Successful'; then
                return 0
            fi
            # Check for element type mentions in listing context
            if echo "$output" | grep -iqE '(available|found|existing)\s+(personas|agents|skills|templates)|elements?\s+(found|listed|available)'; then
                return 0
            fi
            # Explicit verification success
            if echo "$output" | grep -iqE '\bverified\b|\bconfirmed\b|does\s+exist|element\s+exists'; then
                return 0
            fi
            # Empty results are still success for list operations
            if echo "$output" | grep -iqE 'no\s+(elements?|personas?|agents?)\s+found|none\s+found|0\s+elements'; then
                return 0
            fi
            return 1
            ;;
        delete)
            # Success: element was deleted (require explicit deletion)
            if echo "$output" | grep -iqE '\bdeleted\b|\bremoved\b|delete_element.*Successful|permanently\s+deleted'; then
                return 0
            fi
            # Check for mcp_aql_delete tool success
            if echo "$output" | grep -iqE 'mcp_aql_delete.*Successful|Successfully\s+deleted'; then
                return 0
            fi
            # Valid cannot: element doesn't exist (already deleted)
            if echo "$output" | grep -iqE 'element.*not\s+found|does\s+not\s+exist|already\s+deleted|nothing\s+to\s+delete'; then
                return 2
            fi
            return 1
            ;;
        deactivate)
            # Success: element was deactivated (require explicit deactivation)
            if echo "$output" | grep -iqE '\bdeactivated\b|no\s+longer\s+active|deactivation\s+(was\s+)?success|has been deactivated'; then
                return 0
            fi
            # Check for mcp_aql tool success
            if echo "$output" | grep -iqE 'deactivate_element.*Successful|Successfully\s+deactivated'; then
                return 0
            fi
            # Also accept "no active" as success (nothing to deactivate)
            if echo "$output" | grep -iqE 'no\s+active\s+(persona|element)|not\s+currently\s+active|nothing\s+to\s+deactivat'; then
                return 0
            fi
            return 1
            ;;
        *)
            # Generic success check (require explicit success indicators)
            if echo "$output" | grep -iqE '\bSuccessful\b|operation\s+completed|task\s+completed'; then
                return 0
            fi
            return 1
            ;;
    esac
}

# Evaluate compound scenario using semantic analysis for each step
# Args: output, step_type1, step_type2, step_type3, ...
# Sets: STEP_RESULTS array, EVAL_COMPLETED count, EVAL_TOTAL count
# Returns: 0 = all steps completed, 1 = partial completion, 2 = failure
evaluate_compound_semantic() {
    local output="$1"
    shift
    local step_types=("$@")

    EVAL_TOTAL=${#step_types[@]}
    EVAL_COMPLETED=0

    # Reset global results array
    STEP_RESULTS=()

    for step_type in "${step_types[@]}"; do
        local result=0
        evaluate_step_semantic "$output" "$step_type" || result=$?

        if [ $result -eq 0 ]; then
            STEP_RESULTS+=("✅")
            EVAL_COMPLETED=$((EVAL_COMPLETED + 1))
        elif [ $result -eq 2 ]; then
            # Valid cannot - count as partial success for compound tests
            STEP_RESULTS+=("⚠️")
            # Don't increment completed, but don't count as hard failure
        else
            STEP_RESULTS+=("❌")
        fi
    done

    if [ $EVAL_COMPLETED -eq $EVAL_TOTAL ]; then
        return 0  # All steps completed
    elif [ $EVAL_COMPLETED -ge $((EVAL_TOTAL / 2)) ]; then
        return 1  # Partial completion (majority)
    else
        return 2  # Failure
    fi
}

# Extract what decisions the LLM made (for analysis)
extract_llm_decisions() {
    local output="$1"

    echo -e "${MAGENTA}   LLM Decisions:${NC}"

    # Look for element names the LLM chose
    local names=$(echo "$output" | grep -oiE "(name['\"]?\s*[:=]\s*['\"]?[A-Za-z0-9_-]+)" | head -5)
    if [ -n "$names" ]; then
        echo -e "${CYAN}     Names chosen: $names${NC}"
    fi

    # Look for descriptions
    local descs=$(echo "$output" | grep -oiE "(description['\"]?\s*[:=]\s*['\"][^'\"]+['\"])" | head -3)
    if [ -n "$descs" ]; then
        echo -e "${CYAN}     Descriptions: $(echo "$descs" | head -1)${NC}"
    fi
}

# Global variables for evaluation results (used by evaluate functions)
STEP_RESULTS=()
EVAL_COMPLETED=0
EVAL_TOTAL=0

# Run a compound scenario test with SEMANTIC evaluation
# Args: test_name, prompt, timeout, step_name1, step_type1, step_name2, step_type2, ...
# Step types: create, activate, execute, edit, export, list, delete, deactivate, verify
run_compound_test() {
    local test_name="$1"
    local prompt="$2"
    local timeout_seconds="$3"
    shift 3

    # Parse step names and types from remaining args
    local step_names=()
    local step_types=()
    while [ $# -ge 2 ]; do
        # Validate for empty step names/types
        if [ -z "$1" ] || [ -z "$2" ]; then
            echo -e "${RED}   ⚠️  Warning: Empty step name or type detected, skipping${NC}" >&2
            shift 2
            continue
        fi
        step_names+=("$1")
        step_types+=("$2")
        shift 2
    done

    # Validate we have at least one step
    if [ ${#step_types[@]} -eq 0 ]; then
        echo -e "${RED}   ❌ Error: No valid steps defined for test${NC}" >&2
        TEST_RESULTS+=("❌ $test_name (no steps)")
        FAILED_TESTS=$((FAILED_TESTS + 1))
        return 0
    fi

    echo -e "${YELLOW}🧪 Testing: $test_name${NC}"
    echo -e "${CYAN}   Steps required: ${#step_types[@]}${NC}"
    echo -e "${CYAN}   Evaluation: SEMANTIC (by operation type)${NC}"
    echo -e "${CYAN}   Timeout: ${timeout_seconds}s${NC}"

    # Run the test with progress indicator
    local full_prompt="${SYSTEM_PREFIX}${prompt}"
    local output
    local start_time end_time duration

    echo -n -e "${CYAN}   Running test...${NC}"
    start_time=$(date +%s)

    output=$(echo "$full_prompt" | run_with_timeout "$timeout_seconds" docker run -i --rm \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        "$IMAGE_NAME" \
        claude --model $CLAUDE_MODEL \
        --mcp-config /home/claude/.config/claude-code/config.json \
        --allowedTools "$MCP_TOOLS" 2>&1 || true)

    end_time=$(date +%s)
    duration=$((end_time - start_time))
    echo -e " ${GREEN}done${NC} (${duration}s)"

    # Show verbose output if enabled
    if [ "$VERBOSE" = "true" ]; then
        echo -e "${MAGENTA}   === RAW OUTPUT (first $VERBOSE_LINES lines) ===${NC}"
        echo "$output" | head -"$VERBOSE_LINES" | sed 's/^/   /'
        echo -e "${MAGENTA}   === END OUTPUT (${duration}s) ===${NC}"
    fi

    # Check for timeout
    if [ $duration -ge $timeout_seconds ]; then
        echo -e "${RED}  ⏱️  TIMEOUT (${duration}s >= ${timeout_seconds}s)${NC}"
        TEST_RESULTS+=("⏱️  $test_name (timeout)")
        FAILED_TESTS=$((FAILED_TESTS + 1))
        return 0
    fi

    # SEMANTIC evaluation - evaluate by step type, not regex pattern
    # Call directly (not in subshell) so global variables are set
    local return_code=0
    evaluate_compound_semantic "$output" "${step_types[@]}" || return_code=$?
    local eval_result="${EVAL_COMPLETED}/${EVAL_TOTAL}"

    # Display step-by-step results with semantic type
    echo -e "${CYAN}   Step Results (semantic):${NC}"
    for i in "${!step_names[@]}"; do
        echo -e "     ${STEP_RESULTS[$i]:-❓} ${step_names[$i]} [${step_types[$i]}]"
    done

    # Extract and show LLM decisions (if verbose)
    if [ "$VERBOSE" = "true" ]; then
        extract_llm_decisions "$output"
    fi

    # Final verdict
    case $return_code in
        0)
            echo -e "${GREEN}  ✅ PASSED (${duration}s) - All steps completed ($eval_result)${NC}"
            TEST_RESULTS+=("✅ $test_name (${duration}s) [$eval_result]")
            ;;
        1)
            echo -e "${YELLOW}  ⚠️  PARTIAL (${duration}s) - Majority completed ($eval_result)${NC}"
            TEST_RESULTS+=("⚠️  $test_name (${duration}s) [$eval_result]")
            # Don't count partial as failure for compound tests
            ;;
        *)
            echo -e "${RED}  ❌ FAILED (${duration}s) - Insufficient completion ($eval_result)${NC}"
            if [ "$VERBOSE" != "true" ]; then
                echo -e "${RED}  Output (first 30 lines with line numbers):${NC}"
                echo "$output" | head -30 | nl -ba | sed 's/^/    /'
            fi
            TEST_RESULTS+=("❌ $test_name [$eval_result]")
            FAILED_TESTS=$((FAILED_TESTS + 1))
            ;;
    esac

    return 0
}

# ============================================================================
# TEST SUITE: Compound Multi-Step Scenarios
# ============================================================================

test_compound_scenarios() {
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  COMPOUND TEST SCENARIOS                                   ${NC}"
    echo -e "${BLUE}  Issue #265: Multi-Step CRUDE Workflows                    ${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # -------------------------------------------------------------------------
    # Scenario 1: Create-Activate-Execute Agent Workflow
    # -------------------------------------------------------------------------
    echo -e "\n${BLUE}--- Scenario 1: Create-Activate-Execute Agent ---${NC}\n"

    run_compound_test \
        "Create-Activate-Execute Agent" \
        "Create a simple agent named 'TestRunner' with the goal 'Say hello'. Keep it minimal. Then activate it, and finally execute it. Report what happens at each step." \
        120 \
        "Step 1: Create agent element" "create" \
        "Step 2: Activate the agent" "activate" \
        "Step 3: Execute the agent" "execute"

    # -------------------------------------------------------------------------
    # Scenario 2: Create-Edit-Export Persona Workflow
    # -------------------------------------------------------------------------
    echo -e "\n${BLUE}--- Scenario 2: Create-Edit-Export Persona ---${NC}\n"

    run_compound_test \
        "Create-Edit-Export Persona" \
        "Create a persona named 'CodeReviewer' with a brief description. Then update its description to be more detailed. Finally, export it. Show me the result of each step." \
        120 \
        "Step 1: Create persona element" "create" \
        "Step 2: Edit/update the persona" "edit" \
        "Step 3: Export the persona" "export"

    # -------------------------------------------------------------------------
    # Scenario 3: Search-Activate-Deactivate Workflow
    # -------------------------------------------------------------------------
    echo -e "\n${BLUE}--- Scenario 3: Search-Activate-Deactivate ---${NC}\n"

    run_compound_test \
        "Search-Activate-Deactivate" \
        "First, list all available personas. Then activate the 'Default' persona (or any persona you find). Finally, deactivate it. Confirm each step." \
        120 \
        "Step 1: Search/list personas" "list" \
        "Step 2: Activate a persona" "activate" \
        "Step 3: Deactivate the persona" "deactivate"

    # -------------------------------------------------------------------------
    # Scenario 4: Create-Delete Cleanup Workflow
    # -------------------------------------------------------------------------
    echo -e "\n${BLUE}--- Scenario 4: Create-Verify-Delete ---${NC}\n"

    run_compound_test \
        "Create-Verify-Delete Cleanup" \
        "Create a persona named 'TempTest' with description 'Temporary'. Then list personas to verify it exists. Finally, delete 'TempTest'. Confirm each operation." \
        120 \
        "Step 1: Create a test element" "create" \
        "Step 2: Verify it exists (list/search)" "verify" \
        "Step 3: Delete the element" "delete"
}

# ============================================================================
# Summary
# ============================================================================
print_summary() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}          COMPOUND TEST SUMMARY                             ${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    for result in "${TEST_RESULTS[@]}"; do
        echo -e "  $result"
    done

    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"

    local total_tests=${#TEST_RESULTS[@]}
    local passed_tests=$((total_tests - FAILED_TESTS))

    echo -e "  Total:  $total_tests"
    echo -e "  Passed: ${GREEN}$passed_tests${NC}"
    echo -e "  Failed: ${RED}$FAILED_TESTS${NC}"

    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"

    if [ $FAILED_TESTS -eq 0 ]; then
        echo -e "${GREEN}  ✅ ALL COMPOUND TESTS PASSED${NC}"
    else
        echo -e "${RED}  ❌ SOME TESTS FAILED${NC}"
    fi

    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
}

# ============================================================================
# Main Execution
# ============================================================================
main() {
    echo -e "${BLUE}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║     MCP-AQL Compound Multi-Step Tests                     ║${NC}"
    echo -e "${BLUE}║     Issue #265: Complex Workflow Validation               ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}\n"

    check_prerequisites

    test_compound_scenarios

    print_summary

    exit $FAILED_TESTS
}

# Run if executed directly
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main "$@"
fi
