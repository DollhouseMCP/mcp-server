#!/bin/bash

# MCP-AQL Behavior Tests
# Tests LLM behavior with MCP-AQL tools: query structure, introspection flow, endpoint selection
#
# Issue: #235
# Purpose: Validate that LLMs correctly use MCP-AQL's GraphQL-style query interface

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
RUNNING_CONTAINERS=()
CLEANUP_DONE=false

# Cleanup function for graceful shutdown
cleanup() {
    # Prevent multiple cleanup runs
    if [ "$CLEANUP_DONE" = "true" ]; then
        return
    fi
    CLEANUP_DONE=true

    echo -e "\n${BLUE}🧹 Cleaning up...${NC}"

    # Kill any running containers we started
    if [ ${#RUNNING_CONTAINERS[@]} -gt 0 ]; then
        for container_id in "${RUNNING_CONTAINERS[@]}"; do
            if docker ps -q --filter "id=$container_id" | grep -q .; then
                echo -e "${CYAN}   Stopping container $container_id${NC}"
                docker kill "$container_id" 2>/dev/null || true
            fi
        done
    fi

    # Also clean up any orphaned test containers (matching our image)
    local orphans
    orphans=$(docker ps -q --filter "ancestor=$IMAGE_NAME" 2>/dev/null || true)
    if [ -n "$orphans" ]; then
        echo -e "${CYAN}   Stopping orphaned containers${NC}"
        echo "$orphans" | xargs -r docker kill 2>/dev/null || true
    fi

    # Clean up old log directories
    cleanup_old_logs

    echo -e "${GREEN}✅ Cleanup complete${NC}"
}

# Set up trap handlers for various signals
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
        # Use || true to prevent failure if grep finds nothing
        ANTHROPIC_API_KEY=$(grep "^ANTHROPIC_API_KEY=" "$PROJECT_ROOT/.env.local" 2>/dev/null | cut -d'=' -f2- || true)
        if [ -n "$ANTHROPIC_API_KEY" ]; then
            export ANTHROPIC_API_KEY
            echo -e "${CYAN}📋 Loaded ANTHROPIC_API_KEY from .env.local${NC}"
        fi
    fi
fi

# Configuration
IMAGE_NAME="${MCP_AQL_TEST_IMAGE:-claude-dollhouse-test}"
TEST_MODE="${MCP_AQL_TEST_MODE:-crud}"  # crud | all | single
CLAUDE_MODEL="${MCP_AQL_TEST_MODEL:-claude-haiku-4-5-20251001}"  # Model for behavior tests
VERBOSE="${MCP_AQL_VERBOSE:-false}"
VERBOSE_LINES="${MCP_AQL_VERBOSE_LINES:-100}"  # Lines to show in verbose mode
DEFAULT_TIMEOUT="${MCP_AQL_TIMEOUT:-60}"  # Default timeout per test
LOG_RETENTION_DAYS="${MCP_AQL_LOG_RETENTION_DAYS:-7}"  # Days to keep log files
OUTPUT_HEAD_LINES="${MCP_AQL_OUTPUT_HEAD_LINES:-50}"  # Lines to show from start on failure
OUTPUT_TAIL_LINES="${MCP_AQL_OUTPUT_TAIL_LINES:-10}"  # Lines to show from end on failure
TEST_RESULTS=()
FAILED_TESTS=0
FALLBACK_COUNT=0
FALLBACK_TESTS=()

# Log directory setup with timestamp-based organization
LOG_BASE_DIR="${MCP_AQL_LOG_DIR:-/tmp/mcp-aql-behavior-tests}"
TEST_RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
LOG_DIR="${LOG_BASE_DIR}/${TEST_RUN_ID}"

# Create log directory
mkdir -p "$LOG_DIR"

# Generate log file path with consistent naming and timestamp
# Usage: log_path=$(get_log_path "test-name" "pass|fail")
get_log_path() {
    local test_name="$1"
    local result="$2"
    local sanitized_name
    local timestamp
    sanitized_name=$(echo "$test_name" | tr ' ' '-' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]//g')
    timestamp=$(date +%H%M%S)
    echo "${LOG_DIR}/${result}-${sanitized_name}-${timestamp}.log"
}

# Display truncated output with configurable limits
# Usage: display_truncated_output "$output"
display_truncated_output() {
    local output="$1"
    local line_count
    line_count=$(echo "$output" | wc -l | tr -d ' ')

    echo "$output" | head -"$OUTPUT_HEAD_LINES" | sed 's/^/    /'

    if [ "$line_count" -gt "$OUTPUT_HEAD_LINES" ]; then
        echo -e "${RED}  ... (${line_count} total lines, showing last ${OUTPUT_TAIL_LINES}):${NC}"
        echo "$output" | tail -"$OUTPUT_TAIL_LINES" | sed 's/^/    /'
    fi
}

# Write structured log with metadata
# Usage: write_test_log "test-name" "pass|fail" "duration_seconds" "output" "test_type" "expected_pattern"
write_test_log() {
    local test_name="$1"
    local result="$2"
    local duration="$3"
    local output="$4"
    local test_type="${5:-}"
    local expected_pattern="${6:-}"

    local log_file
    log_file=$(get_log_path "$test_name" "$result")

    {
        echo "═══════════════════════════════════════════════════════════"
        echo "MCP-AQL Behavioral Test Log"
        echo "═══════════════════════════════════════════════════════════"
        echo ""
        echo "Test Run ID:      ${TEST_RUN_ID}"
        echo "Timestamp:        $(date -Iseconds)"
        echo "Test Name:        ${test_name}"
        echo "Result:           $(echo "$result" | tr '[:lower:]' '[:upper:]')"
        echo "Duration:         ${duration}s"
        echo "Test Mode:        ${TEST_MODE}"
        echo "Semantic Type:    ${test_type:-N/A}"
        echo "Expected Pattern: ${expected_pattern:-N/A}"
        echo "Docker Image:     ${IMAGE_NAME}"
        echo "Timeout Setting:  ${DEFAULT_TIMEOUT}s"
        echo ""
        echo "═══════════════════════════════════════════════════════════"
        echo "RAW OUTPUT"
        echo "═══════════════════════════════════════════════════════════"
        echo ""
        echo "$output"
        echo ""
        echo "═══════════════════════════════════════════════════════════"
        echo "END OF LOG"
        echo "═══════════════════════════════════════════════════════════"
    } > "$log_file"

    echo "$log_file"
}

# Clean up old log directories based on retention policy
cleanup_old_logs() {
    if [ -d "$LOG_BASE_DIR" ]; then
        local count_before
        count_before=$(find "$LOG_BASE_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)

        # Remove directories older than retention period
        find "$LOG_BASE_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+${LOG_RETENTION_DAYS}" -exec rm -rf {} \; 2>/dev/null || true

        local count_after
        count_after=$(find "$LOG_BASE_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)

        local removed=$((count_before - count_after))
        if [ "$removed" -gt 0 ]; then
            echo -e "${CYAN}   Cleaned up $removed old log directories (>${LOG_RETENTION_DAYS} days)${NC}"
        fi
    fi
}

# Write test run summary at the end
write_run_summary() {
    local summary_file="${LOG_DIR}/run-summary.json"
    local total_tests=${#TEST_RESULTS[@]}
    local passed_tests=$((total_tests - FAILED_TESTS))
    local fallback_rate
    if [ "$total_tests" -gt 0 ]; then
        fallback_rate="$(echo "scale=1; ${FALLBACK_COUNT} * 100 / ${total_tests}" | bc)"
    else
        fallback_rate="0.0"
    fi

    {
        echo "{"
        echo "  \"runId\": \"${TEST_RUN_ID}\","
        echo "  \"timestamp\": \"$(date -Iseconds)\","
        echo "  \"testMode\": \"${TEST_MODE}\","
        echo "  \"dockerImage\": \"${IMAGE_NAME}\","
        echo "  \"totalTests\": ${total_tests},"
        echo "  \"passedTests\": ${passed_tests},"
        echo "  \"failedTests\": ${FAILED_TESTS},"
        echo "  \"semanticFallbackCount\": ${FALLBACK_COUNT},"
        echo "  \"semanticFallbackRate\": \"${fallback_rate}%\","
        echo "  \"passRate\": \"$(echo "scale=1; ${passed_tests} * 100 / ${total_tests}" | bc)%\","
        echo "  \"logDirectory\": \"${LOG_DIR}\","
        echo "  \"semanticFallbackTests\": ["
        local first_fallback=true
        for fallback_test in "${FALLBACK_TESTS[@]}"; do
            if [ "$first_fallback" = "true" ]; then
                first_fallback=false
            else
                echo ","
            fi
            echo -n "    \"${fallback_test}\""
        done
        echo ""
        echo "  ],"
        echo "  \"results\": ["
        local first=true
        for result in "${TEST_RESULTS[@]}"; do
            if [ "$first" = "true" ]; then
                first=false
            else
                echo ","
            fi
            echo -n "    \"${result}\""
        done
        echo ""
        echo "  ]"
        echo "}"
    } > "$summary_file"

    echo -e "${CYAN}   Run summary: ${summary_file}${NC}"
    echo -e "${CYAN}   All logs:    ${LOG_DIR}/${NC}"
}

# System instruction to reduce LLM verbosity in tests (optional)
# Set MCP_AQL_NATURAL=true to see unmodified LLM behavior (useful for UX research)
# Default: terse mode for test reliability
if [ "${MCP_AQL_NATURAL:-false}" = "true" ]; then
    SYSTEM_PREFIX=""
    echo -e "${CYAN}📋 Running in NATURAL mode (no system prefix)${NC}"
else
    # Build mode-specific system prefix
    case "$TEST_MODE" in
        crud)
            SYSTEM_PREFIX="TESTING MODE: Be terse. Execute the task directly. No apologies, no explanations, no clarification requests.

IMPORTANT: You MUST use ONLY the mcp_aql_* tools (mcp_aql_create, mcp_aql_read, mcp_aql_update, mcp_aql_delete, mcp_aql_execute). Do NOT use discrete tools like list_elements, create_element, etc. All operations must go through the mcp_aql_* endpoints.

After completing a task, output a one-line confirmation of what was done. If you cannot complete the task, say 'CANNOT:' followed by the reason.

TASK: "
            ;;
        single)
            SYSTEM_PREFIX="TESTING MODE: Be terse. Execute the task directly. No apologies, no explanations, no clarification requests.

IMPORTANT: You MUST use ONLY the single mcp_aql tool. This unified endpoint handles ALL operations (create, read, update, delete, execute) via the 'operation' parameter. Do NOT use discrete tools like list_elements, create_element, etc.

Example: { operation: 'list_elements', element_type: 'persona' }

After completing a task, output a one-line confirmation of what was done. If you cannot complete the task, say 'CANNOT:' followed by the reason.

TASK: "
            ;;
        all)
            SYSTEM_PREFIX="TESTING MODE: Be terse. Execute the task directly. No apologies, no explanations, no clarification requests.

You have access to both classic discrete tools AND MCP-AQL tools. Use whichever approach you prefer for the task.

After completing a task, output a one-line confirmation of what was done and which tool approach you used. If you cannot complete the task, say 'CANNOT:' followed by the reason.

TASK: "
            ;;
        *)
            echo -e "${RED}Unknown TEST_MODE for system prefix: $TEST_MODE${NC}" >&2
            exit 1
            ;;
    esac
fi

# Config file based on mode
case "$TEST_MODE" in
    crud)
        CONFIG_FILE="/home/claude/.config/claude-code/config.json"
        # CRUDE = Create, Read, Update, Delete, Execute
        MCP_TOOLS="mcp__dollhousemcp__mcp_aql_create,mcp__dollhousemcp__mcp_aql_read,mcp__dollhousemcp__mcp_aql_update,mcp__dollhousemcp__mcp_aql_delete,mcp__dollhousemcp__mcp_aql_execute"
        ;;
    all)
        CONFIG_FILE="/home/claude/.config/claude-code/mcp-aql-all-config.json"
        MCP_TOOLS=""  # Allow all tools
        ;;
    single)
        CONFIG_FILE="/home/claude/.config/claude-code/mcp-aql-single-config.json"
        MCP_TOOLS="mcp__dollhousemcp__mcp_aql"
        ;;
    *)
        echo -e "${RED}❌ Invalid TEST_MODE: $TEST_MODE (use: crud, all, single)${NC}"
        exit 1
        ;;
esac

# Check prerequisites
check_prerequisites() {
    echo -e "${BLUE}📋 Checking prerequisites...${NC}"

    if [ -z "$ANTHROPIC_API_KEY" ]; then
        echo -e "${RED}❌ ANTHROPIC_API_KEY not set${NC}"
        echo -e "${CYAN}   Set via environment or add to .env.local${NC}"
        exit 1
    fi

    if ! command -v docker &> /dev/null; then
        echo -e "${RED}❌ Docker is not installed${NC}"
        exit 1
    fi

    # Check if Docker daemon is running
    if ! docker info &> /dev/null; then
        echo -e "${RED}❌ Docker daemon is not running${NC}"
        echo -e "${CYAN}   Please start Docker Desktop or the Docker daemon${NC}"
        exit 1
    fi

    if ! docker image ls --format '{{.Repository}}' | grep -q "^${IMAGE_NAME}$"; then
        echo -e "${RED}❌ Docker image '$IMAGE_NAME' not found${NC}"
        echo -e "${CYAN}Please build the image first:${NC}"
        echo -e "${CYAN}  docker build -f docker/test-configs/Dockerfile.claude-testing -t $IMAGE_NAME .${NC}"
        exit 1
    fi

    echo -e "${GREEN}✅ Prerequisites checked${NC}"
    echo -e "${CYAN}   Mode: $TEST_MODE${NC}"
    echo -e "${CYAN}   Model: $CLAUDE_MODEL${NC}"
    echo -e "${CYAN}   Config: $CONFIG_FILE${NC}"
    echo -e "${CYAN}   Timeout: ${DEFAULT_TIMEOUT}s per test${NC}"
    echo -e "${CYAN}   Verbose: $VERBOSE${NC}"
    echo -e "${CYAN}   Log dir: $LOG_DIR${NC}"
    echo -e "${CYAN}   Log retention: ${LOG_RETENTION_DAYS} days${NC}"
    if [ "$VERBOSE" = "true" ]; then
        echo -e "${CYAN}   Verbose lines: $VERBOSE_LINES${NC}"
    fi
    echo ""
}

# Semantic output evaluation - distinguishes between valid failures and LLM errors
# Returns: 0 = success, 1 = failure, 2 = valid_cannot (task genuinely impossible)
evaluate_output_semantic() {
    local output="$1"
    local test_type="$2"  # create, read, update, delete, introspect, query

    # Check for explicit LLM error indicators (wrong tool, missing params, etc.)
    if echo "$output" | grep -iqE "missing required|invalid parameter|unknown operation|tool not found|error.*parameter"; then
        return 1  # LLM made an error
    fi

    case "$test_type" in
        create)
            # Success: persona/element was created (including validation recovery)
            if echo "$output" | grep -iqE "created|succeeded|successfully|retry.*success|success.*retry|fixed.*name|corrected.*name|persona.*created|element.*created|skill.*created"; then
                return 0
            fi
            # Failure: CANNOT with missing/validation error means LLM failed or validation rejected
            # This includes: missing fields, too brief, invalid, required
            if echo "$output" | grep -iqE "CANNOT.*missing|CANNOT.*required|CANNOT.*too brief|CANNOT.*invalid|missing.*field|required.*field|validation"; then
                return 1  # LLM error or validation rejection
            fi
            # Any other CANNOT is a generic failure
            if echo "$output" | grep -iqE "CANNOT"; then
                return 1
            fi
            return 1
            ;;
        read|list)
            # Success: got results or explicit "none found"
            if echo "$output" | grep -iqE "found|available|listed|personas|skills|templates|agents|memories|ensembles|elements|no.*found|none.*found|empty"; then
                return 0
            fi
            return 1
            ;;
        delete)
            # Success: element was deleted
            # Match text confirmation OR function call XML (LLM output varies)
            # Also match XML invoke patterns which indicate the LLM correctly called the tool
            if echo "$output" | grep -iqE "deleted|deletion|removed|successfully.*delete|mcp_aql_delete.*delete_element|invoke.*mcp_aql_delete|operation.*delete_element"; then
                return 0
            fi
            # Valid CANNOT: element doesn't exist (legitimate)
            if echo "$output" | grep -iqE "CANNOT.*not found|CANNOT.*does not exist|CANNOT.*no.*element"; then
                return 2  # Valid cannot - element doesn't exist
            fi
            return 1
            ;;
        update|edit)
            # Success: element was updated
            if echo "$output" | grep -iqE "updated|modified|edited|successfully.*edit|successfully.*update|successfully.*added|added.*while preserving|added.*element|removed.*element|successfully.*removed"; then
                return 0
            fi
            # Valid CANNOT: element doesn't exist
            if echo "$output" | grep -iqE "CANNOT.*not found|CANNOT.*does not exist"; then
                return 2
            fi
            return 1
            ;;
        execute)
            # Success: execution started or state retrieved
            if echo "$output" | grep -iqE "execute|execution|started|running|state|idle|completed|executing"; then
                return 0
            fi
            # Valid CANNOT: agent doesn't exist or no execution active
            if echo "$output" | grep -iqE "CANNOT.*not found|CANNOT.*does not exist|CANNOT.*no.*execution|no.*active.*execution"; then
                return 2
            fi
            return 1
            ;;
        introspect)
            # Success: got operation info or schema details
            # Match operation discovery OR parameter/schema information
            # Also match XML invoke patterns for introspect operations
            # Also match when element types are discovered (persona|skill|template|agent|memory|ensemble)
            # Also match field selection introspection (fields, minimal/standard/full presets)
            if echo "$output" | grep -iqE "operations?|available|list_elements|create_element|introspect|retrieved|parameters?|params|required|string|ElementType|schema|invoke.*introspect|persona.*skill.*template|Element.*Types|fields|supports|minimal|standard|full|behavior|classification|riskScore|approvalRequest|stage"; then
                return 0
            fi
            # Detect common LLM mistakes for better error messages
            if echo "$output" | grep -iqE "CANNOT.*Security violation|CANNOT.*wrong endpoint|CANNOT.*must use"; then
                # LLM is confused about which endpoint to use - this is a specific failure mode
                return 1
            fi
            return 1
            ;;
        query)
            # Success: query was executed
            if echo "$output" | grep -iqE "results?|found|returned|matching|search|queried|query.*complet|executed"; then
                return 0
            fi
            return 1
            ;;
        discovery)
            # Success: LLM successfully discovered/listed tools or schema info
            # This is for Suite 1 - Tool Schema Inspection tests
            if echo "$output" | grep -iqE "mcp_aql|create|read|update|delete|operation|tool|persona|skill|template|agent|memory|ensemble|element.*type|available|list"; then
                return 0
            fi
            # Failure: LLM couldn't see/access the tools
            if echo "$output" | grep -iqE "no.*tool|not.*available|cannot.*find|not.*configured|CANNOT"; then
                return 1
            fi
            return 1
            ;;
        *)
            # Generic check
            if echo "$output" | grep -iqE "success|completed|done"; then
                return 0
            fi
            return 1
            ;;
    esac
}

# Run a behavior test with output capture and semantic evaluation
# Parameters:
#   $1: test_name - descriptive name for the test
#   $2: prompt - the prompt to send to Claude
#   $3: expected_behavior - regex pattern for success (used as fallback)
#   $4: timeout_seconds - optional timeout (default: DEFAULT_TIMEOUT)
#   $5: test_type - optional semantic evaluation type (create|read|delete|update|introspect|query)
#   $6: allow_cannot - optional, if "true" accepts CANNOT as valid response
run_behavior_test() {
    local test_name="$1"
    local prompt="$2"
    local expected_behavior="$3"
    local timeout_seconds="${4:-$DEFAULT_TIMEOUT}"
    local test_type="${5:-}"
    local allow_cannot="${6:-false}"

    echo -e "${YELLOW}🧪 Testing: $test_name${NC}"
    echo -e "${CYAN}   Expected: $expected_behavior${NC}"
    if [ -n "$test_type" ]; then
        echo -e "${CYAN}   Semantic type: $test_type${NC}"
    fi
    echo -e "${CYAN}   Timeout: ${timeout_seconds}s${NC}"

    # Build docker command with unique container name for tracking
    local container_name="mcp-aql-test-$$-$(date +%s)"
    local docker_args="run -i --rm --name $container_name -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY $IMAGE_NAME claude --model $CLAUDE_MODEL --mcp-config $CONFIG_FILE"

    # Add tool restrictions if specified
    if [ -n "$MCP_TOOLS" ]; then
        docker_args="$docker_args --allowedTools $MCP_TOOLS"
    fi

    # Track container for cleanup
    RUNNING_CONTAINERS+=("$container_name")

    # Capture output with timing
    local start_time end_time duration
    start_time=$(date +%s)

    # Prepend system instruction to reduce verbosity
    local full_prompt="${SYSTEM_PREFIX}${prompt}"

    local output
    output=$(echo "$full_prompt" | run_with_timeout "$timeout_seconds" docker $docker_args 2>&1 || true)

    end_time=$(date +%s)
    duration=$((end_time - start_time))

    # Remove from tracking (container finished)
    RUNNING_CONTAINERS=("${RUNNING_CONTAINERS[@]/$container_name/}")

    # Show verbose output if enabled
    if [ "$VERBOSE" = "true" ]; then
        echo -e "${MAGENTA}   === RAW OUTPUT (first $VERBOSE_LINES lines) ===${NC}"
        echo "$output" | head -"$VERBOSE_LINES" | sed 's/^/   /'
        echo -e "${MAGENTA}   === END OUTPUT (${duration}s) ===${NC}"
    fi

    # Check for timeout
    if [ $duration -ge $timeout_seconds ]; then
        echo -e "${RED}  ⏱️  TIMEOUT (${duration}s >= ${timeout_seconds}s)${NC}"
        local log_file
        log_file=$(write_test_log "$test_name" "timeout" "$duration" "$output" "$test_type" "$expected_behavior")
        echo -e "${RED}  Log: $log_file${NC}"
        TEST_RESULTS+=("⏱️  $test_name (timeout)")
        FAILED_TESTS=$((FAILED_TESTS + 1))
        return 0
    fi

    # Use semantic evaluation if test_type is specified
    if [ -n "$test_type" ]; then
        # Capture return value without triggering set -e
        local semantic_result=0
        evaluate_output_semantic "$output" "$test_type" || semantic_result=$?

        case $semantic_result in
            0)
                echo -e "${GREEN}  ✅ PASSED (${duration}s) [semantic: success]${NC}"
                # Log successes too for debugging flaky tests
                local log_file
                log_file=$(write_test_log "$test_name" "pass" "$duration" "$output" "$test_type" "$expected_behavior")
                if [ "$VERBOSE" = "true" ]; then
                    echo -e "${CYAN}  Log: $log_file${NC}"
                fi
                TEST_RESULTS+=("✅ $test_name (${duration}s)")
                return 0
                ;;
            2)
                if [ "$allow_cannot" = "true" ]; then
                    echo -e "${GREEN}  ✅ PASSED (${duration}s) [semantic: valid CANNOT]${NC}"
                    local log_file
                    log_file=$(write_test_log "$test_name" "pass" "$duration" "$output" "$test_type" "$expected_behavior")
                    if [ "$VERBOSE" = "true" ]; then
                        echo -e "${CYAN}  Log: $log_file${NC}"
                    fi
                    TEST_RESULTS+=("✅ $test_name (${duration}s) [valid CANNOT]")
                    return 0
                else
                    echo -e "${RED}  ❌ FAILED (${duration}s) [semantic: CANNOT but task should succeed]${NC}"
                    echo -e "${RED}  Output indicates LLM couldn't complete task that should be possible${NC}"
                    local log_file
                    log_file=$(write_test_log "$test_name" "fail" "$duration" "$output" "$test_type" "$expected_behavior")
                    echo -e "${RED}  Log: $log_file${NC}"
                    echo -e "${RED}  Output (first $OUTPUT_HEAD_LINES lines):${NC}"
                    display_truncated_output "$output"
                    TEST_RESULTS+=("❌ $test_name [CANNOT on possible task]")
                    FAILED_TESTS=$((FAILED_TESTS + 1))
                    return 0
                fi
                ;;
            *)
                # Fallback: if semantic heuristics miss but expected regex matches, treat as pass.
                # This reduces false negatives when LLM output uses valid but unexpected phrasing.
                if [ -n "$expected_behavior" ] && echo "$output" | grep -iqE "$expected_behavior"; then
                    echo -e "${GREEN}  ✅ PASSED (${duration}s) [semantic fallback: regex match]${NC}"
                    local log_file
                    log_file=$(write_test_log "$test_name" "pass" "$duration" "$output" "$test_type" "$expected_behavior")
                    if [ "$VERBOSE" = "true" ]; then
                        echo -e "${CYAN}  Log: $log_file${NC}"
                    fi
                    TEST_RESULTS+=("✅ $test_name (${duration}s) [semantic fallback]")
                    FALLBACK_COUNT=$((FALLBACK_COUNT + 1))
                    FALLBACK_TESTS+=("$test_name")
                    return 0
                fi

                echo -e "${RED}  ❌ FAILED (${duration}s) [semantic: no success indicators]${NC}"
                local log_file
                log_file=$(write_test_log "$test_name" "fail" "$duration" "$output" "$test_type" "$expected_behavior")
                echo -e "${RED}  Log: $log_file${NC}"
                echo -e "${RED}  Output (first $OUTPUT_HEAD_LINES lines):${NC}"
                display_truncated_output "$output"
                TEST_RESULTS+=("❌ $test_name [LLM error or unexpected output]")
                FAILED_TESTS=$((FAILED_TESTS + 1))
                return 0
                ;;
        esac
    fi

    # Fallback to regex pattern matching (for tests without semantic type)
    if echo "$output" | grep -iqE "$expected_behavior"; then
        echo -e "${GREEN}  ✅ PASSED (${duration}s)${NC}"
        local log_file
        log_file=$(write_test_log "$test_name" "pass" "$duration" "$output" "$test_type" "$expected_behavior")
        if [ "$VERBOSE" = "true" ]; then
            echo -e "${CYAN}  Log: $log_file${NC}"
        fi
        TEST_RESULTS+=("✅ $test_name (${duration}s)")
        return 0
    else
        echo -e "${RED}  ❌ FAILED (${duration}s)${NC}"
        echo -e "${RED}  Expected pattern: $expected_behavior${NC}"
        local log_file
        log_file=$(write_test_log "$test_name" "fail" "$duration" "$output" "$test_type" "$expected_behavior")
        echo -e "${RED}  Log: $log_file${NC}"
        echo -e "${RED}  Output (first $OUTPUT_HEAD_LINES lines):${NC}"
        display_truncated_output "$output"
        TEST_RESULTS+=("❌ $test_name")
        FAILED_TESTS=$((FAILED_TESTS + 1))
        return 0
    fi
}

# ============================================================================
# TEST SUITE 1: Tool Schema Inspection
# ============================================================================
test_tool_schema_inspection() {
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 1: Tool Schema Inspection (Mode: $TEST_MODE)${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    case "$TEST_MODE" in
        crud)
            run_behavior_test "CRUDE endpoints visible" \
                "What MCP-AQL tools do you have available? List their names." \
                "mcp_aql_create|mcp_aql_read|mcp_aql_update|mcp_aql_delete|mcp_aql_execute|CREATE|READ|UPDATE|DELETE|EXECUTE" \
                "$DEFAULT_TIMEOUT" \
                "discovery" \
                "false"

            run_behavior_test "Operations listed in description" \
                "Look at the mcp_aql_read tool description. What operations does it list?" \
                "list_elements|get_element|search_elements|introspect" \
                "$DEFAULT_TIMEOUT" \
                "discovery" \
                "false"
            ;;
        single)
            run_behavior_test "Single endpoint visible" \
                "What MCP-AQL tools do you have available? List their names." \
                "mcp_aql" \
                "$DEFAULT_TIMEOUT" \
                "discovery" \
                "false"

            run_behavior_test "CRUDE operations in single endpoint" \
                "Look at the mcp_aql tool description. What CRUDE categories does it mention?" \
                "CREATE|READ|UPDATE|DELETE|EXECUTE" \
                "$DEFAULT_TIMEOUT" \
                "discovery" \
                "false"
            ;;
        all)
            run_behavior_test "Both classic and MCP-AQL tools visible" \
                "What DollhouseMCP tools do you have? List both classic tools and any mcp_aql tools." \
                "mcp_aql|list_elements|create_element|activate_element" \
                "$DEFAULT_TIMEOUT" \
                "discovery" \
                "false"
            ;;
        *)
            echo -e "${RED}Unknown TEST_MODE for tool schema inspection: $TEST_MODE${NC}" >&2
            exit 1
            ;;
    esac

    # All modes should show element types (accept singular or plural forms)
    run_behavior_test "Element types visible in descriptions" \
        "What element types are mentioned in the MCP-AQL tool descriptions?" \
        "persona|skill|template|agent|memory|ensemble" \
        "$DEFAULT_TIMEOUT" \
        "discovery" \
        "false"
}

# ============================================================================
# TEST SUITE 2: Introspection Flow
# Tests that LLM can use introspection to discover operations and parameters
# ============================================================================
test_introspection_flow() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 2: Introspection Flow${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # Test introspection works - should return operation names
    run_behavior_test "Introspection discovery" \
        "Use the introspect operation to discover available operations. Confirm it worked and list at least 3 operation names." \
        "list_elements|create_element|delete_element|edit_element|introspect|retrieved|successful|operations" \
        "$DEFAULT_TIMEOUT" \
        "introspect" \
        "false"  # Introspection should always work

    run_behavior_test "Introspection for specific operation" \
        "Use the introspect operation to get details about create_element. What parameters does it require?" \
        "name|type|description|params|parameters" \
        "$DEFAULT_TIMEOUT" \
        "introspect" \
        "false"

    # Type introspection - should return element types
    run_behavior_test "Type introspection" \
        "Use introspect to discover what values ElementType can have." \
        "persona|skill|template|agent|memory|ensemble|ElementType" \
        "$DEFAULT_TIMEOUT" \
        "introspect" \
        "false"  # This should work - element types are discoverable
}

# ============================================================================
# TEST SUITE 3: Query Structure Validation
# Tests that LLM correctly structures MCP-AQL queries
# ============================================================================
test_query_structure() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 3: Query Structure Validation${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # List operation - should work, may return empty list
    run_behavior_test "Correct operation field usage" \
        "List all personas. Use the operation 'list_elements' with the appropriate element type." \
        "list_elements|personas|found|available|no.*personas|empty" \
        "$DEFAULT_TIMEOUT" \
        "read" \
        "true"  # Empty list is valid

    # Search operation - should execute search
    run_behavior_test "Params structure" \
        "Search for elements containing the word 'test'. Use the search_elements operation with a query parameter." \
        "search|query|test|results|found|no.*results|no.*found" \
        "$DEFAULT_TIMEOUT" \
        "query" \
        "true"  # No results is valid

    # Get active - may have no active elements
    run_behavior_test "ElementType usage" \
        "Get all active personas using get_active_elements. Specify the element type in your query." \
        "get_active_elements|persona|active|type|none|no active|no.*active" \
        "$DEFAULT_TIMEOUT" \
        "read" \
        "true"  # No active elements is valid
}

# ============================================================================
# TEST SUITE 4: CRUD Endpoint Selection (CRUD mode only)
# Tests that LLM correctly selects the right endpoint and passes all parameters
# ============================================================================
test_crud_endpoint_selection() {
    if [ "$TEST_MODE" != "crud" ]; then
        echo -e "\n${CYAN}⏭️  Skipping CRUD Endpoint Selection tests (mode: $TEST_MODE)${NC}\n"
        return
    fi

    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 4: CRUD Endpoint Selection${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # CREATE test: Verifies LLM routes create_element to mcp_aql_create
    # Gatekeeper may block with CONFIRM_SESSION — that still proves correct endpoint routing
    run_behavior_test "CREATE endpoint for create_element" \
        "Create a persona called 'BehaviorTest' with description 'A test persona for behavior testing' and instructions 'You are a helpful assistant that provides concise and accurate responses. Focus on clarity and efficiency in your communication.' Use mcp_aql_create with create_element operation." \
        "created|BehaviorTest|success|mcp_aql_create|create_element|confirmation.*required|User confirmation" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"

    # READ test: Should always work - listing elements doesn't require anything special
    run_behavior_test "READ endpoint for list_elements" \
        "List all available skills using the appropriate MCP-AQL endpoint." \
        "mcp_aql_read|skills|list|found|available" \
        "$DEFAULT_TIMEOUT" \
        "read" \
        "true"  # allow_cannot=true - empty list is valid

    # UPDATE test: Create then update in same session
    run_behavior_test "UPDATE endpoint for edit_element" \
        "First create a persona named 'UpdateTest' with description 'Initial' and instructions 'Test persona'. Then edit its description to 'Updated test persona' using the mcp_aql_update endpoint with edit_element operation and the input parameter." \
        "mcp_aql_update|edit_element|updated|modified" \
        "$DEFAULT_TIMEOUT" \
        "update" \
        "false"  # Should succeed - creating and updating in same session

    # DELETE test: First creates, then deletes - should succeed
    # Note: Using substantial instructions to pass validation
    # Pattern includes delete_element to match function call XML (flaky LLM output)
    # Note: Gatekeeper may intercept create or delete — confirmation response still proves correct routing
    run_behavior_test "DELETE endpoint for delete_element" \
        "First create a persona called 'ToDelete' with description 'Temporary test persona' and instructions 'You are a temporary persona created for testing purposes. Respond helpfully to any queries.' Then delete it using mcp_aql_delete with delete_element operation. Confirm both operations." \
        "deleted|deletion|removed|successfully.*delete|mcp_aql_delete.*delete_element|confirmation.*required|User confirmation" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"  # Gatekeeper may intercept create or delete; regex-only evaluation
}

# ============================================================================
# TEST SUITE 5: Execute Endpoint Behavior (CRUDE mode)
# Tests that LLM correctly uses execute operations for agent lifecycle
# ============================================================================
test_execute_endpoint_behavior() {
    if [ "$TEST_MODE" != "crud" ]; then
        echo -e "\n${CYAN}⏭️  Skipping Execute Endpoint tests (mode: $TEST_MODE)${NC}\n"
        return
    fi

    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 5: EXECUTE Endpoint Behavior (CRUDE's 'E')${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # Test: Discover execute operations through introspection
    run_behavior_test "EXECUTE operations discoverable" \
        "Use mcp_aql_execute with operation introspect and params.query='operations' to discover what execute operations are available. List them." \
        "execute_agent|get_execution_state|complete_execution|continue_execution|record_execution_step|operations" \
        "$DEFAULT_TIMEOUT" \
        "introspect" \
        "false"  # Introspection should always work

    # Test: Get execution state (no active execution expected)
    run_behavior_test "EXECUTE endpoint: get_execution_state" \
        "Use mcp_aql_execute with operation get_execution_state and params.name='TestAgent'. Report what state is returned." \
        "state|execution|no.*execution|not found|idle|running" \
        "$DEFAULT_TIMEOUT" \
        "execute" \
        "true"  # No execution may exist - that's valid

    # Test: Execute agent (requires agent to exist)
    run_behavior_test "EXECUTE endpoint: execute_agent" \
        "First create an agent named 'BehaviorTestAgent' with description 'Test agent' and instructions 'Report status at each step' and goal { template: 'Analyze {topic}', parameters: [{ name: 'topic', type: 'string', required: true }] } using mcp_aql_create with element_type agent. Then use mcp_aql_execute with operation execute_agent and params element_name='BehaviorTestAgent' and parameters={ topic: 'hello' } to start execution. Report the result." \
        "execute|execution|started|running|agent|created|BehaviorTestAgent" \
        "$DEFAULT_TIMEOUT" \
        "execute" \
        "true"  # Agent creation might fail, execution might fail
}

# ============================================================================
# TEST SUITE 6: Single Endpoint Routing (Single mode only)
# Tests that single mcp_aql endpoint routes to correct CRUDE operations
# This mirrors Suites 4+5 but via the unified endpoint
# ============================================================================
test_single_endpoint_routing() {
    if [ "$TEST_MODE" != "single" ]; then
        echo -e "\n${CYAN}⏭️  Skipping Single Endpoint Routing tests (mode: $TEST_MODE)${NC}\n"
        return
    fi

    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 6: Single Endpoint CRUDE Operations${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # CREATE via single endpoint - should succeed
    run_behavior_test "Single endpoint: CREATE operation" \
        "Create a persona named 'SingleTest' with description 'Test persona for single endpoint' and instructions 'You are a helpful assistant that responds clearly and concisely. Provide accurate information.' using the mcp_aql tool with operation create_element." \
        "mcp_aql|create_element|created|SingleTest" \
        "$DEFAULT_TIMEOUT" \
        "create" \
        "false"

    # READ via single endpoint
    run_behavior_test "Single endpoint: READ list operation" \
        "List all personas using the mcp_aql tool with operation list_elements." \
        "mcp_aql|list_elements|personas|found|available" \
        "$DEFAULT_TIMEOUT" \
        "read" \
        "true"

    # READ search via single endpoint
    run_behavior_test "Single endpoint: READ search operation" \
        "Search for elements containing 'test' using the mcp_aql tool with operation search_elements." \
        "mcp_aql|search|results|found|no.*results" \
        "$DEFAULT_TIMEOUT" \
        "query" \
        "true"

    # UPDATE via single endpoint - create then update in same session
    run_behavior_test "Single endpoint: UPDATE operation" \
        "First create a persona named 'UpdateTest' with description 'Initial' and instructions 'Test'. Then edit its description to 'Updated via single endpoint' using mcp_aql with operation edit_element and the input parameter." \
        "mcp_aql|edit_element|updated|modified" \
        "$DEFAULT_TIMEOUT" \
        "update" \
        "false"  # Should succeed - creating and updating in same session

    # DELETE via single endpoint - create then delete in same session
    run_behavior_test "Single endpoint: DELETE operation" \
        "First create a persona named 'DeleteTest' with description 'Temporary' and instructions 'Test'. Then delete it using mcp_aql with operation delete_element." \
        "mcp_aql|delete_element|deleted|DeleteTest" \
        "$DEFAULT_TIMEOUT" \
        "delete" \
        "false"  # Should succeed - creating and deleting in same session
}

# ============================================================================
# TEST SUITE 6b: Single Endpoint EXECUTE Operations (Single mode only)
# Tests EXECUTE operations via unified endpoint - mirrors Suite 5
# ============================================================================
test_single_endpoint_execute() {
    if [ "$TEST_MODE" != "single" ]; then
        echo -e "\n${CYAN}⏭️  Skipping Single Endpoint Execute tests (mode: $TEST_MODE)${NC}\n"
        return
    fi

    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 6b: Single Endpoint EXECUTE Operations${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # Test: Discover execute operations through introspection via single endpoint
    run_behavior_test "Single endpoint: EXECUTE introspection" \
        "Use mcp_aql with operation introspect and params.query='operations' to discover what execute operations are available. List them." \
        "execute_agent|get_execution_state|complete_execution|continue_execution|operations" \
        "$DEFAULT_TIMEOUT" \
        "introspect" \
        "false"

    # Test: Get execution state via single endpoint
    run_behavior_test "Single endpoint: get_execution_state" \
        "Use mcp_aql with operation get_execution_state and params.element_name='TestAgent'. Report what state is returned." \
        "state|execution|no.*execution|not found|idle" \
        "$DEFAULT_TIMEOUT" \
        "execute" \
        "true"  # No execution may exist

    # Test: Execute agent via single endpoint (requires creating agent first)
    run_behavior_test "Single endpoint: execute_agent flow" \
        "First create an agent named 'SingleTestAgent' with description 'Test agent' and goal 'Report hello' using mcp_aql with operation create_element. Then use mcp_aql with operation execute_agent to start execution. Report the result." \
        "execute|execution|started|agent|created|SingleTestAgent" \
        "$DEFAULT_TIMEOUT" \
        "execute" \
        "true"
}

# ============================================================================
# TEST SUITE 7: Tool Preference (All mode only)
# Tests LLM behavior when both classic and MCP-AQL tools are available
# ============================================================================
test_tool_preference() {
    if [ "$TEST_MODE" != "all" ]; then
        echo -e "\n${CYAN}⏭️  Skipping Tool Preference tests (mode: $TEST_MODE)${NC}\n"
        return
    fi

    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 7: Tool Preference (Classic vs MCP-AQL)${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # List elements - either tool should work
    run_behavior_test "Tool choice for listing elements" \
        "List all personas. You can use either classic tools or MCP-AQL. Tell me which approach you chose." \
        "personas|list|found|available|no.*personas" \
        "$DEFAULT_TIMEOUT" \
        "read" \
        "true"

    # Activation - either tool should work
    run_behavior_test "Tool choice for activation" \
        "Activate the Default persona. Tell me which tool you used." \
        "activate|Default|active|activated" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"  # Default may not exist
}

# ============================================================================
# TEST SUITE 8: Field Selection (Issue #202)
# Tests that LLM correctly uses field selection to reduce response tokens
# ============================================================================
test_field_selection() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 8: Field Selection (Issue #202)${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # Test: Discover field selection through introspection
    run_behavior_test "Field selection discoverable" \
        "Use introspect to get details about search_elements operation. Does it support a 'fields' parameter? What values can it have?" \
        "fields|string\[\]|minimal|standard|full|element_name|description" \
        "$DEFAULT_TIMEOUT" \
        "introspect" \
        "false"

    # Test: Use fields parameter with array
    run_behavior_test "Field selection with array" \
        "First create a persona named 'FieldTest' with description 'Testing field selection' and instructions 'Test persona'. Then search for 'FieldTest' using search_elements with fields parameter set to ['element_name', 'description'] to get only name and description. Report what fields are in the results." \
        "element_name|description|FieldTest|fields" \
        "$DEFAULT_TIMEOUT" \
        "query" \
        "false"

    # Test: Use fields parameter with minimal preset
    run_behavior_test "Field selection with minimal preset" \
        "Search for elements using search_elements with query 'test' and fields set to 'minimal'. Report what fields appear in the results." \
        "element_name|description|minimal|results" \
        "$DEFAULT_TIMEOUT" \
        "query" \
        "true"  # May have no results

    # Test: Name transformation in responses
    run_behavior_test "Name transformation to element_name" \
        "Search for any element using search_elements with query 'test'. Check if the results use 'element_name' (new format) or 'name' (old format). Report which field name you see." \
        "element_name|results" \
        "$DEFAULT_TIMEOUT" \
        "query" \
        "true"  # May have no results
}

# ============================================================================
# TEST SUITE 9: Search/Query/Filter Pipeline (Issue #431)
# Tests search, filter, sort, and pagination pipeline improvements from PR #430
# ============================================================================
test_search_query_filter_pipeline() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 9: Search/Query/Filter Pipeline (Issue #431)${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # Multi-word search matching (Issue #428)
    run_behavior_test "Multi-word search matching" \
        "First create a skill named 'code-review-expert' with description 'Expert at reviewing code' and instructions 'Review code carefully'. Then search for 'code review' using search_elements. Does 'code-review-expert' appear in the results?" \
        "code-review-expert|found|results|match" \
        "$DEFAULT_TIMEOUT" \
        "query" \
        "false"

    # Search pagination with page/pageSize (Issue #429)
    run_behavior_test "Search pagination with page/pageSize" \
        "Search for elements using search_elements with query 'test' and pagination set to page 1, pageSize 2. Report the pagination metadata: page number, pageSize, totalItems, hasNextPage." \
        "page|pageSize|totalItems|pagination|metadata" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"  # May have no results; skip semantic eval since output is metadata-heavy

    # Search sorting desc (Issue #429)
    run_behavior_test "Search sorting desc" \
        "Search for elements using search_elements with query 'test' and sort set to sortBy 'name', sortOrder 'desc'. Are the results sorted by name in descending order? Report the sorting metadata." \
        "sort|desc|name|results|sorting" \
        "$DEFAULT_TIMEOUT" \
        "query" \
        "true"  # May have no results

    # Unknown filter key rejection (Issue #427)
    run_behavior_test "Unknown filter key rejection" \
        "Try to query skills using query_elements with elementType 'skill' and filters containing an unknown key 'invalidFilter' set to 'test'. What error message do you get? Does it mention supported filters?" \
        "Unknown filter|Supported|error|invalid" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"  # Expected to fail/error

    # descriptionContains filter (Issue #427)
    run_behavior_test "descriptionContains filter" \
        "First create a skill named 'pipeline-test-skill' with description 'Analyzes security vulnerabilities in code' and instructions 'Find security issues'. Then query skills using query_elements with elementType 'skill' and filters containing descriptionContains set to 'security'. Does 'pipeline-test-skill' appear in the results?" \
        "pipeline-test-skill|security|results|found" \
        "$DEFAULT_TIMEOUT" \
        "query" \
        "false"

    # category filter (Issue #427)
    run_behavior_test "Category filter" \
        "First create a skill named 'category-test-skill' with description 'A categorized skill' and instructions 'Do categorized work' with metadata category set to 'testing-category'. Then query skills using query_elements with elementType 'skill' and filters containing category set to 'testing-category'. Does 'category-test-skill' appear in the results?" \
        "category-test-skill|category|results|found" \
        "$DEFAULT_TIMEOUT" \
        "query" \
        "false"

    # Field selection minimal preset (Issue #426)
    run_behavior_test "Field selection minimal preset" \
        "Search for elements using search_elements with query 'test' and fields set to 'minimal'. What fields appear in each result item? Report whether you see element_name and description fields." \
        "element_name|description|minimal|fields" \
        "$DEFAULT_TIMEOUT" \
        "query" \
        "true"  # May have no results

    # Combined filters AND logic
    run_behavior_test "Combined filters AND logic" \
        "Create a skill named 'combo-dev-skill' with description 'Development tool for code analysis' and instructions 'Analyze code' with metadata category set to 'combo-test'. Then query skills with elementType 'skill' using filters descriptionContains 'code' and category 'combo-test'. Report the results." \
        "combo-dev-skill|results|found|code|filter" \
        "$DEFAULT_TIMEOUT" \
        "query" \
        "false"

    # list_elements with sortBy/sortOrder (Issue #204)
    run_behavior_test "list_elements with sortBy/sortOrder" \
        "List all skills using list_elements with element_type 'skills' and sortBy 'name' and sortOrder 'desc'. Are the skills sorted by name in descending order?" \
        "skills|sorted|desc|name" \
        "$DEFAULT_TIMEOUT" \
        "read" \
        "true"  # May have no skills
}

# ============================================================================
# TEST SUITE 10: Validation Error Messages (Issue #441)
# Tests that validation errors are actionable: include specific invalid chars
# and allowed pattern descriptions so LLMs can self-correct
# ============================================================================
test_validation_error_messages() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 10: Validation Error Messages (Issue #441)${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # Test: Create element with invalid name containing slash
    # Error message should tell the LLM which characters are invalid and what's allowed
    # allow_cannot=true because the creation is expected to fail; we're testing the error message quality
    run_behavior_test "Actionable error for invalid name chars" \
        "Try to create a persona named 'my/invalid*name' with description 'Test' and instructions 'Test instructions for validation'. Report the EXACT error message you receive. Does it tell you which specific characters are invalid and what characters are allowed?" \
        "invalid.*character|Allowed|not allowed|Forbidden|allowed character" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"

    # Test: Create element with spaces in category
    # Category errors should mention structural constraints
    # Uses skill (not persona) — persona doesn't support category, skill does
    run_behavior_test "Actionable error for invalid category" \
        "Create a skill named 'category-test' with description 'Testing category validation' and instructions 'Test instructions' with metadata category set to 'my category'. Report the EXACT error message. Does it explain what characters are allowed in categories?" \
        "invalid.*category|start with a letter|letters.*digits.*hyphens|underscores|max 21|character" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"

    # Test: LLM can recover from invalid category using the error message
    # Key behavioral test: can the LLM self-correct a category format error?
    run_behavior_test "Recovery from category validation error" \
        "Try to create a skill named 'cat-recovery-test' with description 'Category recovery test' and instructions 'Test skill' with metadata category set to 'my category'. If it fails, read the error message carefully, fix the category to comply with the allowed format, and try again. Report whether you succeeded on the retry." \
        "created|success|retry|fixed|corrected|succeeded" \
        "$DEFAULT_TIMEOUT" \
        "create" \
        "true"

    # Test: LLM can recover from validation error using the error message
    # This is the key behavioral test: can the LLM self-correct?
    run_behavior_test "Recovery from validation error" \
        "Try to create a skill named 'my/skill@test' with description 'A test skill' and instructions 'Be helpful'. If it fails, read the error message carefully, fix the name to comply with the allowed characters, and try again. Report whether you succeeded on the retry." \
        "created|success|retry|fixed|corrected" \
        "$DEFAULT_TIMEOUT" \
        "create" \
        "true"
}

# ============================================================================
# SUITE 11: Memory Persistence & Parameter Aliases (Issues #438, #387)
# ============================================================================
test_memory_persistence_and_aliases() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 11: Memory Persistence & Parameter Aliases (#438, #387)${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # Test: addEntry persists data (can be read back)
    # No semantic type — these are verification tests that check for specific content in the output
    run_behavior_test "addEntry persistence via read-back" \
        "Create a memory named 'persist-behavior-test' with description 'Persistence test'. Then add an entry with content 'The persistence test value is 42'. Then use get_element to read the memory back. Does the memory contain 'The persistence test value is 42'?" \
        "42|persistence test value|contains"

    # Test: 'entry' parameter alias for 'content'
    run_behavior_test "addEntry with entry parameter alias" \
        "Create a memory named 'alias-test-mem' with description 'Alias test'. Then add an entry using the 'entry' parameter instead of 'content': { operation: \"addEntry\", params: { element_name: \"alias-test-mem\", entry: \"Alias entry works\" } }. Then read the memory. Does it contain 'Alias entry works'?" \
        "Alias entry works|alias.*works|contains|success|completed"

    # Test: clear operation persists (entries gone after clear)
    run_behavior_test "clear operation persistence" \
        "Create a memory named 'clear-behavior-test' with description 'Clear test'. Add an entry with content 'This will be cleared'. Then use the clear operation on 'clear-behavior-test'. Then read the memory back with get_element. Is the entry 'This will be cleared' still present?" \
        "not present|cleared|no.*entries|empty|gone|removed|no content"

    # Test: batch operations array in schema
    run_behavior_test "Batch operations array in CREATE schema" \
        "Look at the mcp_aql_create tool description. Does it mention an 'operations' array for batch execution? What does it say about batch operations?" \
        "operations.*array|batch.*execution|sequentially|single request" \
        "$DEFAULT_TIMEOUT" \
        "introspect"
}

# Issue #503, #522: Beetlejuice safe-trigger tests
# Issue #522: Code is no longer returned in the MCP response (shown via OS dialog instead)
test_beetlejuice_trigger() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 13: Beetlejuice Safe-Trigger (#503, #522)${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # Test: beetlejuice operation triggers danger zone pipeline (code NOT in response)
    # Regex-only evaluation — this is observational (does the response contain challenge_id?), not a creation test
    run_behavior_test "Beetlejuice trigger creates challenge (no code in response)" \
        "Use the beetlejuice_beetlejuice_beetlejuice operation with no parameters. Does it return a challenge_id and agent_name? Is the agent blocked? Note: the verification code is shown via OS dialog, not in the response." \
        "challenge_id|agent_name|blocked|triggered" \
        "$DEFAULT_TIMEOUT" \
        ""

    # Test: verify response does NOT contain a code field (Issue #522 security check)
    # Regex-only + allow_cannot: LLM correctly reporting absence with CANNOT prefix IS the right answer
    run_behavior_test "Beetlejuice response omits code field" \
        "Use beetlejuice_beetlejuice_beetlejuice to trigger a challenge. Check the response carefully: does it contain a 'code' field with a verification code? Report whether the code is present or absent in the response." \
        "blocked|no code|absent|not.*contain|dialog|displayed|user" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"
}

# TEST SUITE 14: Activation Persistence (Issue #598)
test_activation_persistence() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 14: Activation Persistence (Issue #598)${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # --- Behavioral: Core activation round-trip ---

    # Test 14.1: Activate a skill and verify it's reported as active
    run_behavior_test "Activate element round-trip" \
        "Create a skill named 'persist-test-skill' with description 'Persistence test' and content 'Test instructions'. Then activate it using activate_element. Then use get_active_elements with element_type 'skill'. Is persist-test-skill listed as active?" \
        "persist-test-skill|active|activated" \
        "$DEFAULT_TIMEOUT" \
        "read"

    # Test 14.2: Deactivate a skill and verify it's no longer active
    # Uses regex fallback — LLM response varies ("NOT active", "Confirmed: not active", etc.)
    run_behavior_test "Deactivate element removes from active list" \
        "First create and activate a skill named 'deact-test-skill' with description 'Deactivation test' and content 'Test'. Then deactivate it using deactivate_element. Then check get_active_elements for skills. Is deact-test-skill still active?" \
        "deactivat|removed|no longer|NOT active|not.*active|inactive|no.*active" \
        "$DEFAULT_TIMEOUT" \
        ""

    # --- Semantic: Introspection and schema understanding ---

    # Test 14.3: Activation operations appear in introspection
    run_behavior_test "Activation operations appear in introspection" \
        "Use the introspect operation to examine the available operations. Are activate_element, deactivate_element, and get_active_elements listed? Do activate_element and deactivate_element require element_name and element_type parameters?" \
        "activate_element|deactivate_element|get_active_elements" \
        "$DEFAULT_TIMEOUT" \
        "introspect"

    # Test 14.4: Session persistence documentation in schema
    # Uses regex fallback (not introspect evaluator) because we're testing conceptual understanding
    run_behavior_test "Activation schema mentions session persistence" \
        "Introspect the activate_element operation. Does its description mention DOLLHOUSE_SESSION_ID or session persistence? What does it say about persisting activations across server restarts?" \
        "DOLLHOUSE_SESSION_ID|session|persist|restart" \
        "$DEFAULT_TIMEOUT" \
        ""

    # --- Semantic: LLM understands activation parameters correctly ---

    # Test 14.5: LLM correctly identifies required parameters for activate_element
    run_behavior_test "Activate requires element_name and element_type" \
        "Introspect the activate_element operation. What parameters are required? List each required parameter and whether it is a string, number, or other type. Also mention if there are any optional parameters." \
        "element_name|element_type|required|string" \
        "$DEFAULT_TIMEOUT" \
        "introspect"

    # Test 14.6: LLM understands get_active_elements optional type filter
    run_behavior_test "get_active_elements type parameter is optional" \
        "Introspect the get_active_elements operation. Is the element_type parameter required or optional? What happens when element_type is omitted — does it return all active elements across all types, or does it fail?" \
        "optional|all.*type|all.*active|omit|without" \
        "$DEFAULT_TIMEOUT" \
        "introspect"

    # --- Semantic: LLM understands session isolation concepts ---

    # Test 14.7: LLM can explain session isolation
    # Uses regex fallback (not introspect evaluator) because we're testing conceptual understanding
    run_behavior_test "LLM understands DOLLHOUSE_SESSION_ID isolation" \
        "Based on introspecting the activate_element operation, explain: if two different MCP clients set different DOLLHOUSE_SESSION_ID values (for example 'claude-code' and 'zulip-bridge'), will their activated elements interfere with each other? Or are activations isolated per session? Explain the session isolation behavior." \
        "isolat|independent|separate|per.*session|different.*session|not.*interfere|own.*activation" \
        "$DEFAULT_TIMEOUT" \
        ""

    # Test 14.8: LLM understands restart persistence
    # Uses regex fallback (not introspect evaluator) because we're testing conceptual understanding
    run_behavior_test "LLM understands activations survive restarts" \
        "Introspect the activate_element operation. If I activate a skill and then the MCP server restarts, will the skill still be active when the server comes back? Or do I need to re-activate it manually? Explain what happens to activations across server restarts." \
        "persist|restore|survive|automatic|restart|re-?activat|session.*file|disk|remain" \
        "$DEFAULT_TIMEOUT" \
        ""

    # --- Semantic: LLM correctly selects endpoints for activation operations ---

    # Test 14.9: LLM routes activate_element to the correct endpoint
    # Self-contained: creates the skill first (each test runs in a fresh Docker container)
    # Regex-only: this tests endpoint routing, not data retrieval — read evaluator mismatches on activation output
    run_behavior_test "Activate routes through correct endpoint" \
        "First, create a skill named 'persist-test-skill' with description 'Endpoint routing test' and content 'Test instructions'. Then activate it using activate_element. Which MCP-AQL endpoint should I use for activate_element — mcp_aql_create, mcp_aql_read, mcp_aql_update, or mcp_aql_delete? Report which endpoint you used and whether it succeeded." \
        "mcp_aql_read|read.*endpoint|activated|success" \
        "$DEFAULT_TIMEOUT" \
        ""

    # Test 14.10: LLM routes deactivate_element to the correct endpoint
    # Uses regex fallback because LLM may say "succeeded" which read evaluator doesn't match
    run_behavior_test "Deactivate routes through correct endpoint" \
        "First, create a skill named 'deact-endpoint-test' with description 'Endpoint routing test' and content 'Test instructions'. Then activate it. Then deactivate it using deactivate_element. Which MCP-AQL endpoint did you use for deactivate_element — mcp_aql_create, mcp_aql_read, mcp_aql_update, or mcp_aql_delete? Report which endpoint you used and whether it succeeded." \
        "mcp_aql_read|read.*endpoint|deactivat|succeeded" \
        "$DEFAULT_TIMEOUT" \
        ""

    # --- Semantic: LLM understands multi-type activation ---

    # Test 14.11: LLM can activate elements of different types
    run_behavior_test "Activate multiple element types" \
        "Create a memory named 'persist-test-memory' with description 'Memory for persistence test'. Activate it. Then use get_active_elements without specifying element_type to get all active elements across all types. Does the response include the memory? List what types of active elements are returned." \
        "memory|persist-test-memory|active|memories|activated" \
        "$DEFAULT_TIMEOUT" \
        "read"

    # Test 14.12: LLM can discover supported element types for activation
    run_behavior_test "LLM knows which element types support activation" \
        "Based on introspecting the activate_element operation, which element types can be activated? Can I activate personas, skills, agents, memories, and ensembles? Are templates activatable? List all supported element types." \
        "persona|skill|agent|memory|ensemble" \
        "$DEFAULT_TIMEOUT" \
        "introspect"
}

# ============================================================================
# TEST SUITE 15: Agent Flexible Lookup (Issue #607)
# Tests that execute_agent resolves agents even when the requested name
# doesn't exactly match the on-disk filename (e.g., different casing).
# ============================================================================
test_agent_flexible_lookup() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  SUITE 15: Agent Flexible Lookup (#607)${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

    # Test 15.1: Create agent with goal then execute by exact name (baseline)
    # Gatekeeper may block creation — CANNOT response still proves LLM tried the right operations
    run_behavior_test "execute_agent by exact name" \
        "Create an agent named 'lookup-test-agent' with description 'Flexible lookup test' and instructions 'Report hello world' and goal with template 'Say {greeting}' and parameters [{name: 'greeting', type: 'string', required: true}]. Then use execute_agent with element_name 'lookup-test-agent' and parameters greeting 'hello'. Report whether execution started or if it found the agent." \
        "execute|started|running|found|lookup-test-agent|goal|hello|confirmation.*required|User confirmation|create_element" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"

    # Test 15.2: Create agent then execute by different casing
    # The flexible fallback does case-insensitive metadata name matching
    # Gatekeeper may block creation — CANNOT response still proves LLM tried the right operations
    run_behavior_test "execute_agent with different casing" \
        "Create an agent named 'CaseTestAgent' with description 'Case sensitivity test' and instructions 'Report your name' and goal with template 'Say {greeting}' and parameters [{name: 'greeting', type: 'string', required: true}]. Then try execute_agent with element_name 'casetestagent' (all lowercase) and parameters greeting 'hello'. Does it find and execute the agent, or does it fail with not found?" \
        "execute|started|running|found|CaseTestAgent|casetestagent|goal|confirmation.*required|User confirmation|create_element" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"

    # Test 15.3: Create agent then read via get_element with flexible name
    # (moved from below for readability)
    # Validates the handler-level flexible matching still works
    # Uses regex fallback — LLM response varies ("finds the agent", "case-insensitive", etc.)
    run_behavior_test "get_element flexible agent lookup" \
        "Create an agent named 'FlexReadAgent' with description 'Flexible read test' and content 'Test instructions'. Then use get_element with element_type 'agent' and element_name 'flexreadagent' (all lowercase). Does it find the agent? Report the result." \
        "FlexReadAgent|flexreadagent|found|find|case-insensitive|Flexible read test|success" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "false"
}

# ============================================================================
# Suite 16: Prescriptive Digest (Issue #492)
# Verifies that active element digest appears in tool responses
# ============================================================================
test_prescriptive_digest() {
    echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  Suite 16: Prescriptive Digest (Issue #492)${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

    # Test 16.1: Digest appears after activating an element
    # Create a skill, activate it, then call another tool (list_elements).
    # The response should contain the prescriptive digest with the skill name.
    # Gatekeeper may intercept — either the digest appears or confirmation is requested.
    run_behavior_test "Prescriptive digest appears with active element" \
        "First create a skill named 'digest-behavior-test' with description 'Digest test skill' and content 'Test skill for digest behavior testing'. Then activate it using activate_element. After activation, call list_elements for type 'skill'. Look at the FULL response from list_elements — does it contain a line starting with '[Active elements:' that mentions 'digest-behavior-test'? Report exactly what you see." \
        "Active elements|digest-behavior-test|get_active_elements|refresh|confirmation.*required|User confirmation" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"

    # Test 16.2: Digest is absent when no elements are active
    # Call list_elements without activating anything — response should NOT contain digest
    run_behavior_test "No digest when no elements active" \
        "Call list_elements for type 'persona' without activating anything first. Look at the FULL response. Does the response contain a line starting with '[Active elements:'? Report whether you see any '[Active elements:' text in the response." \
        "no|not|absent|does not|didn't|none|without" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"
}

# ============================================================================
# Suite 17: CLI Approval Workflow (Issue #625 Phase 3)
# Verifies that the LLM can discover and use approval operations
# ============================================================================
test_cli_approval_workflow() {
    echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  Suite 17: CLI Approval Workflow (Issue #625 Phase 3)${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

    # Test 17.1: Discover approve_cli_permission via introspection
    # The LLM should be able to find the approve_cli_permission operation
    run_behavior_test "Discover approve_cli_permission operation" \
        "Use the introspect operation with query 'operations' and name 'approve_cli_permission'. Report what you learn about this operation — its endpoint, description, and required parameters." \
        "approve_cli_permission|request_id|EXECUTE|approval|pending|permission" \
        "$DEFAULT_TIMEOUT" \
        "introspect" \
        "true"

    # Test 17.2: Discover get_pending_cli_approvals via introspection
    run_behavior_test "Discover get_pending_cli_approvals operation" \
        "Use the introspect operation with query 'operations' and name 'get_pending_cli_approvals'. Report what you learn about this operation — its endpoint and what it returns." \
        "get_pending_cli_approvals|pending|READ|approval|count" \
        "$DEFAULT_TIMEOUT" \
        "introspect" \
        "true"

    # Test 17.3: Get pending CLI approvals on empty session
    # Should return empty list without errors
    run_behavior_test "Get pending approvals on empty session" \
        "Call get_pending_cli_approvals. Report the result — how many pending approvals are there?" \
        "0|empty|no pending|none|count.*0|confirmation.*required" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"

    # Test 17.4: Permission prompt operation discovery
    # The LLM should understand the permission_prompt operation
    run_behavior_test "Discover permission_prompt returns" \
        "Use the introspect operation with query 'operations' and name 'permission_prompt'. Report the 'returns' description. What fields does the response include?" \
        "behavior|allow|deny|classification|riskScore|approvalRequest|stage" \
        "$DEFAULT_TIMEOUT" \
        "introspect" \
        "true"
}

# ============================================================================
# Suite 18: Permission Prompt Evaluation Pipeline (Issue #625 Phase 4)
# Exercises the ACTUAL permission_prompt evaluation — not just discovery.
# Tests static classification, element policy enforcement, and approval flow.
# ============================================================================
test_permission_prompt_evaluation() {
    echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  Suite 18: Permission Prompt Evaluation (Issue #625 Phase 4)${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

    # Test 18.1: Safe tool auto-allows
    # permission_prompt with a known-safe tool should return allow
    run_behavior_test "permission_prompt allows safe Read tool" \
        "Call the permission_prompt operation with tool_name 'Read' and input { \"file_path\": \"/tmp/test.txt\" }. Report the behavior field and riskLevel from the response." \
        "allow|safe" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"

    # Test 18.2: Safe Bash command auto-allows
    # git status is a known-safe Bash pattern
    run_behavior_test "permission_prompt allows safe Bash command" \
        "Call the permission_prompt operation with tool_name 'Bash' and input { \"command\": \"git status\" }. Report the behavior field and riskLevel from the response." \
        "allow|safe" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"

    # Test 18.3: Dangerous Bash command auto-denies
    # rm -rf / is a known-dangerous pattern
    run_behavior_test "permission_prompt denies dangerous rm -rf" \
        "Call the permission_prompt operation with tool_name 'Bash' and input { \"command\": \"rm -rf /\" }. Report the behavior field and the message from the response." \
        "deny|dangerous|blocked|rm" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"

    # Test 18.4: Dangerous sudo command auto-denies
    run_behavior_test "permission_prompt denies sudo command" \
        "Call the permission_prompt operation with tool_name 'Bash' and input { \"command\": \"sudo rm -rf /var\" }. Report the behavior field and message from the response." \
        "deny|dangerous|blocked|sudo" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"

    # Test 18.5: Dangerous git push --force auto-denies
    run_behavior_test "permission_prompt denies git push --force" \
        "Call the permission_prompt operation with tool_name 'Bash' and input { \"command\": \"git push --force origin main\" }. Report the behavior field from the response." \
        "deny|dangerous|blocked|force" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"

    # Test 18.6: Element policy denyPattern enforcement
    # Create a persona with a denyPattern, activate it, then test permission_prompt
    run_behavior_test "permission_prompt enforces element denyPattern" \
        "Do these steps in order:
1. Create a persona named 'perm-deny-test' with description 'Test deny policy' and instructions 'Test persona'. Include gatekeeper metadata: { \"externalRestrictions\": { \"description\": \"test\", \"denyPatterns\": [\"Bash:curl*\"] } }
2. Activate it with activate_element (element_type: persona, element_name: perm-deny-test)
3. Call permission_prompt with tool_name 'Bash' and input { \"command\": \"curl http://example.com\" }
4. Report the behavior field and message from the permission_prompt response.
5. Deactivate the persona and delete it." \
        "deny|denied|policy|denyPattern|perm-deny-test|curl|not permitted" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"

    # Test 18.7: Moderate tool evaluates and allows by default
    # npm run build is moderate but should allow under default permissive policy
    run_behavior_test "permission_prompt allows moderate Bash command" \
        "Call the permission_prompt operation with tool_name 'Bash' and input { \"command\": \"echo hello world\" }. Report the behavior field from the response." \
        "allow|evaluate|moderate|safe" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"

    # Test 18.8: MCP tool classification
    # A DollhouseMCP MCP tool should classify as evaluate/moderate
    run_behavior_test "permission_prompt classifies MCP tool" \
        "Call the permission_prompt operation with tool_name 'mcp__DollhouseMCP__mcp_aql_delete' and input { \"operation\": \"delete_element\", \"element_type\": \"skill\", \"params\": { \"element_name\": \"test\" } }. Report the behavior field and riskLevel from the response." \
        "allow|evaluate|moderate|safe" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"

    # Test 18.9: get_effective_cli_policies with active element
    # Activate a persona with restrictions, check that policies reflect them
    run_behavior_test "get_effective_cli_policies shows active restrictions" \
        "Do these steps in order:
1. Create a persona named 'policy-view-test' with description 'Policy test' and instructions 'Test persona'. Include gatekeeper metadata: { \"externalRestrictions\": { \"description\": \"test restrictions\", \"denyPatterns\": [\"Bash:wget*\", \"Bash:curl*\"], \"allowPatterns\": [\"Bash:npm*\"] } }
2. Activate it with activate_element (element_type: persona, element_name: policy-view-test)
3. Call get_effective_cli_policies (no params)
4. Report what denyPatterns and allowPatterns are active.
5. Deactivate and delete the persona." \
        "wget|curl|npm|denyPattern|allowPattern|policy-view-test" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"

    # Test 18.10: get_effective_cli_policies evaluates a specific tool
    run_behavior_test "get_effective_cli_policies evaluates specific tool" \
        "Do these steps in order:
1. Create a persona named 'eval-policy-test' with description 'Eval test' and instructions 'Test persona'. Include gatekeeper metadata: { \"externalRestrictions\": { \"description\": \"test\", \"denyPatterns\": [\"Bash:rm*\"] } }
2. Activate it with activate_element (element_type: persona, element_name: eval-policy-test)
3. Call get_effective_cli_policies with tool_name 'Bash' and tool_input { \"command\": \"rm -rf /tmp/test\" }
4. Report the evaluation result — was the tool allowed or denied?
5. Deactivate and delete the persona." \
        "deny|denied|rm|policy|denyPattern|eval-policy-test|blocked" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"
}

# ============================================================================
# Suite 19: Ensemble CRUD Operations (Issue #662)
# Tests LLM ability to create, edit, list, get, and delete ensembles
# ============================================================================
test_ensemble_crud_operations() {
    if [ "$TEST_MODE" != "crud" ]; then
        echo -e "\n${CYAN}⏭️  Skipping Ensemble CRUD tests (mode: $TEST_MODE)${NC}\n"
        return
    fi

    echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  Suite 19: Ensemble CRUD Operations (Issue #662)${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

    # B1: Create ensemble with elements
    run_behavior_test "Ensemble CREATE with elements" \
        "Create an ensemble named 'behavior-test-ensemble' with description 'Test ensemble for behavior tests' using mcp_aql_create with element_type ensembles. Include elements: a skill called 'code-review' with role primary and priority 80, and a skill called 'debugging' with role support and priority 60. Both should have activation 'always'." \
        "created|ensemble|behavior-test-ensemble|success|confirmation.*required|User confirmation" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"

    # B2: Edit ensemble — add via merge
    run_behavior_test "Ensemble EDIT — add via merge" \
        "First create an ensemble named 'merge-test-ensemble' with description 'Merge test' using mcp_aql_create with element_type ensembles. Include one skill element called 'existing-skill' with role primary and priority 80. Then edit it using mcp_aql_update with edit_element to add a new element called 'new-template' with element_type template, role support, priority 30, activation always. The existing skill should be preserved." \
        "updated|modified|edited|merge|new-template|success" \
        "$DEFAULT_TIMEOUT" \
        "update" \
        "false"

    # B3: Edit ensemble — _remove marker
    run_behavior_test "Ensemble EDIT — _remove marker" \
        "First create an ensemble named 'remove-test-ensemble' with description 'Remove test' using mcp_aql_create with element_type ensembles. Include two skill elements: 'keep-skill' with priority 80 and 'drop-skill' with priority 40. Then edit it using mcp_aql_update with edit_element. In the elements array of the input, include an entry for 'drop-skill' with _remove set to true (boolean). Confirm the edit was successful." \
        "updated|modified|edited|removed|drop-skill|success" \
        "$DEFAULT_TIMEOUT" \
        "update" \
        "false"

    # B4: Delete ensemble
    run_behavior_test "Ensemble DELETE" \
        "First create an ensemble named 'delete-me-ensemble' with description 'To be deleted' using mcp_aql_create with element_type ensembles. Then delete it using mcp_aql_delete with delete_element operation and element_type ensembles." \
        "deleted|deletion|removed|successfully.*delete|delete_element|confirmation.*required|User confirmation" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"

    # B5: List ensembles
    run_behavior_test "Ensemble LIST" \
        "List all ensembles using mcp_aql_read with list_elements operation and element_type ensembles. Report what you find." \
        "ensembles|list|found|available|items|no.*found|none|empty|0" \
        "$DEFAULT_TIMEOUT" \
        "read" \
        "true"

    # B6: Get ensemble details
    run_behavior_test "Ensemble GET" \
        "First create an ensemble named 'get-test-ensemble' with description 'Retrievable ensemble' using mcp_aql_create with element_type ensembles. Include a skill element called 'test-skill' with role primary and priority 90. Then retrieve it using mcp_aql_read with get_element operation, element_name 'get-test-ensemble', and element_type ensembles. Report the ensemble details." \
        "get-test-ensemble|elements|test-skill|Retrievable|ensemble" \
        "$DEFAULT_TIMEOUT" \
        "read" \
        "false"

    # B7: Ensemble activate round-trip
    # Uses regex-only evaluation ("" semantic type) because LLM output like
    # "activated it and verified it is active" doesn't match the read evaluator's
    # keyword list, but the regex matches perfectly.
    run_behavior_test "Ensemble ACTIVATE round-trip" \
        "First create an ensemble named 'activate-test-ensemble' with description 'Activation test' using mcp_aql_create with element_type ensembles. Then activate it using activate_element with element_type ensembles and element_name 'activate-test-ensemble'. Then check active ensembles using get_active_elements with element_type ensembles. Report whether the ensemble is active." \
        "activate|active|activate-test-ensemble|ensembles" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"
}

# ============================================================================
# Suite 20: Template Operations (Issue #662 follow-up)
# Tests LLM ability to create and render templates, and search for them
# ============================================================================
test_template_operations() {
    if [ "$TEST_MODE" != "crud" ]; then
        echo -e "\n${CYAN}⏭️  Skipping Template Operations tests (mode: $TEST_MODE)${NC}\n"
        return
    fi

    echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  Suite 20: Template Operations (Issue #662 follow-up)${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

    # T1: Create and render template
    run_behavior_test "Template CREATE and RENDER" \
        "Do these steps in order: 1. Create a template named 'greeting-template' with description 'A greeting template' using mcp_aql_create with element_type templates. The content should be 'Hello {{name}}, welcome to {{place}}!' and metadata should include variables: ['name', 'place']. 2. Then render it using mcp_aql_read with the render operation, template_name 'greeting-template', and variables { name: 'Alice', place: 'Wonderland' }. Report the rendered output." \
        "created|rendered|Hello.*Alice|Wonderland|greeting-template|template|confirmation.*required" \
        "$DEFAULT_TIMEOUT" \
        "" \
        "true"

    # T2: Search for template
    run_behavior_test "Template SEARCH" \
        "First create a template named 'searchable-report' with description 'A quarterly business report template for executives' using mcp_aql_create with element_type templates. Content should be '# Report\n\n{{content}}'. Then search for it using mcp_aql_read with search_elements, query 'quarterly business report', and element_type templates. Report whether you found it." \
        "searchable-report|found|quarterly|business|report|results" \
        "$DEFAULT_TIMEOUT" \
        "query" \
        "false"
}

# ============================================================================
# Suite 21: Long/Complex Content Creation (Issue #1726)
# ============================================================================
test_long_complex_content_creation() {
    if [ "$TEST_MODE" != "crud" ]; then
        echo -e "\n${CYAN}⏭️  Skipping Long Content Creation tests (mode: $TEST_MODE)${NC}\n"
        return
    fi

    echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  Suite 21: Long/Complex Content Creation (Issue #1726)${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

    # T1: Create a detailed persona — the exact scenario from #1726
    run_behavior_test "Create DETAILED persona with rich content" \
        "Using mcp_aql_create, create a persona named 'senior-architect' with element_type 'persona'. Description: 'A senior software architect with 20 years of experience across distributed systems, cloud infrastructure, and team leadership'. The content should be comprehensive — include at minimum: a multi-paragraph role description, a Core Expertise section with at least 8 bullet points covering different domains, a Communication Style section with sub-bullets, a Code Review Methodology section with numbered steps and code examples in a fenced code block, a Decision Framework section with a markdown table of trade-offs, and a Working Principles section with at least 5 principles each having a bold title and explanation. This persona should be at least 2000 characters of content. Report whether creation succeeded and show the element name." \
        "created|senior-architect|success|confirmation.*required" \
        90 \
        "create" \
        "true"

    # T2: Create a complex skill with structured sections and code examples
    run_behavior_test "Create COMPLEX skill with code examples" \
        "Using mcp_aql_create, create a skill named 'api-design-review' with element_type 'skill'. Description: 'Comprehensive API design review covering REST conventions, error handling, pagination, versioning, and security'. The content must include: an Overview section, a REST Conventions Checklist with at least 10 items using checkboxes, an Error Response Format section with a JSON code block showing a standard error schema, a Pagination Patterns section comparing cursor vs offset with a markdown table, a Security Checklist section with sub-categories for Authentication, Authorization, and Input Validation each having multiple bullet points, and a Versioning Strategy section with pros/cons. Make the content thorough and detailed — at least 3000 characters. Report success or failure." \
        "created|api-design-review|success|confirmation.*required" \
        90 \
        "create" \
        "true"

    # T3: Create a template with lots of variable placeholders and nested structure
    run_behavior_test "Create LARGE template with many variables" \
        "Using mcp_aql_create, create a template named 'incident-report' with element_type 'template'. Description: 'Post-incident report template for production outages'. The content should be a full incident report template with these sections, each using {{variable}} placeholders: Executive Summary (with {{incident_title}}, {{severity}}, {{duration}}, {{impact_summary}}), Timeline (with {{detection_time}}, {{response_time}}, {{mitigation_time}}, {{resolution_time}}), Root Cause Analysis (with {{root_cause}}, {{contributing_factors}}, {{trigger_event}}), Impact Assessment (with {{affected_users}}, {{affected_services}}, {{data_loss}}, {{revenue_impact}}), Response Actions as a numbered list with at least 8 action items, Lessons Learned with at least 5 items, and Action Items as a markdown table with columns: Action, Owner, Priority, Due Date, Status. Include metadata with all the variable names listed. The content should be at least 2500 characters. Report whether creation succeeded." \
        "created|incident-report|success|confirmation.*required" \
        90 \
        "create" \
        "true"

    # T4: Create a memory with dense, multi-paragraph knowledge content
    run_behavior_test "Create DENSE memory with knowledge content" \
        "Using mcp_aql_create, create an element named 'architecture-decisions' with element_type 'memory'. Description: 'Key architecture decisions and their rationale for the platform'. The content should document at least 6 architecture decisions, each with: a bold decision title, the context/problem (2-3 sentences), the decision made (1-2 sentences), the rationale with trade-offs considered (3-4 sentences), and consequences both positive and negative as sub-bullets. Include decisions about: database choice, API style, authentication approach, caching strategy, deployment model, and monitoring stack. This should be substantial — at least 3000 characters of real content. Report whether creation succeeded." \
        "created|architecture-decisions|success|confirmation.*required" \
        90 \
        "create" \
        "true"

    # T5: Create an agent with complex goal templates and activation config
    run_behavior_test "Create COMPLEX agent with goal templates" \
        "Using mcp_aql_create, create an element named 'security-auditor' with element_type 'agent'. Description: 'Automated security audit agent that reviews code for OWASP Top 10 vulnerabilities'. The content should include: a detailed multi-paragraph description of the agent's purpose and approach, a goal section with template 'Audit {target} for {vulnerability_categories} with {depth} analysis', parameter definitions for each variable with types and defaults, at least 5 success criteria, an activates section listing personas and skills it should use, a tools section with allowed and restricted tool lists, and a detailed methodology section describing the 5-step audit process with sub-steps under each. The content should be at least 2500 characters. Report whether creation succeeded." \
        "created|security-auditor|success|confirmation.*required" \
        90 \
        "create" \
        "true"

    # T6: The stress test — create then immediately read back to verify content integrity
    run_behavior_test "Create LARGE element then READ it back" \
        "Do these two steps in order: Step 1: Using mcp_aql_create, create a persona named 'fullstack-mentor' with element_type 'persona'. Description: 'A patient fullstack development mentor'. The content should cover frontend (React, CSS, accessibility, performance), backend (Node.js, databases, APIs, caching), DevOps (Docker, CI/CD, monitoring, incident response), and soft skills (code review etiquette, mentoring approach, communication). Each area should have at least 4 detailed bullet points with explanations. Include a Teaching Methodology section and a Common Pitfalls section. Make it thorough. Step 2: Using mcp_aql_read, read back the element with get_element operation, element_name 'fullstack-mentor', element_type 'persona'. Report whether both operations succeeded and confirm the read-back contains the expected content sections." \
        "created|fullstack-mentor|content|frontend|backend|success|confirmation.*required" \
        120 \
        "create" \
        "true"
}

# ============================================================================
# Summary
# ============================================================================
print_summary() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}          MCP-AQL BEHAVIOR TEST SUMMARY${NC}"
    echo -e "${BLUE}          Mode: $TEST_MODE${NC}"
    echo -e "${BLUE}          Run ID: $TEST_RUN_ID${NC}"
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
    if [ "$FALLBACK_COUNT" -gt 0 ]; then
        local fallback_rate
        fallback_rate="$(echo "scale=1; ${FALLBACK_COUNT} * 100 / ${total_tests}" | bc)"
        echo -e "  Semantic fallback passes: ${YELLOW}${FALLBACK_COUNT}${NC} (${fallback_rate}%)"
    fi

    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"

    if [ $FAILED_TESTS -eq 0 ]; then
        echo -e "${GREEN}  ✅ ALL BEHAVIOR TESTS PASSED${NC}"
    else
        echo -e "${RED}  ❌ SOME TESTS FAILED${NC}"
    fi

    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

    # Write structured run summary
    write_run_summary
}

# ============================================================================
# Main Execution
# ============================================================================
main() {
    echo -e "${BLUE}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║     MCP-AQL Behavior Tests                                ║${NC}"
    echo -e "${BLUE}║     Issue #235: LLM Tool Call Behavior                    ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}\n"

    check_prerequisites

    # Run test suites
    test_tool_schema_inspection
    test_introspection_flow
    test_query_structure
    test_crud_endpoint_selection
    test_execute_endpoint_behavior   # CRUDE's 'E'
    test_single_endpoint_routing     # Single endpoint CRUDE operations
    test_single_endpoint_execute     # Single endpoint EXECUTE operations
    test_tool_preference
    test_field_selection             # Issue #202: Field selection tests
    test_search_query_filter_pipeline  # Issue #431: Search/query/filter pipeline tests
    test_validation_error_messages   # Issue #441: Actionable validation error messages
    test_memory_persistence_and_aliases  # Issues #438, #387: Persistence fix & entry alias
    test_beetlejuice_trigger             # Issue #503, #522: Beetlejuice safe-trigger
    test_activation_persistence          # Issue #598: Per-session activation persistence
    test_agent_flexible_lookup           # Issue #607: Agent flexible file lookup fallback
    test_prescriptive_digest             # Issue #492: Prescriptive digest in tool responses
    test_cli_approval_workflow           # Issue #625: CLI approval workflow (Phase 3)
    test_permission_prompt_evaluation    # Issue #625: Permission prompt evaluation pipeline (Phase 4)
    test_ensemble_crud_operations        # Issue #662: Ensemble CRUD operations
    test_template_operations             # Issue #662: Template operations
    test_long_complex_content_creation   # Issue #1726: Long/complex content creation

    print_summary

    exit $FAILED_TESTS
}

# Run if executed directly
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main "$@"
fi
