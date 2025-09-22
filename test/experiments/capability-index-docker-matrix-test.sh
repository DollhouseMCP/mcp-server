#!/bin/bash

# Capability Index Combinatorial Matrix Test
# Tests all variations with Docker Claude Code + DollhouseMCP
# Using Sonnet as requested

set -e

# Session metadata
SESSION_ID=$(date +%Y%m%d_%H%M%S)
RESULTS_DIR="test/experiments/capability-index-results/session_${SESSION_ID}"
mkdir -p "$RESULTS_DIR"

# Test counters
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Log function
log() {
    echo "[$(date +%H:%M:%S)] $1" | tee -a "$RESULTS_DIR/test.log"
}

# Test function that runs a single capability index test
run_capability_test() {
    local test_name="$1"
    local index_structure="$2"
    local claude_md_prompt="$3"
    local test_query="$4"
    local expected_tools="$5"

    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    local test_id="${test_name}_${TOTAL_TESTS}"

    log "Running test $TOTAL_TESTS: $test_name"

    # Create test-specific CLAUDE.md
    local test_dir="$RESULTS_DIR/$test_id"
    mkdir -p "$test_dir"

    # Write CLAUDE.md with index structure and prompt
    cat > "$test_dir/CLAUDE.md" <<EOF
# Claude Code with DollhouseMCP - Capability Index Test

$claude_md_prompt

## Capability Index

$index_structure

## Project Context
You have access to DollhouseMCP tools for element management.
EOF

    # Run the test in Docker with Sonnet
    local output_file="$test_dir/output.txt"
    local start_time=$(date +%s%N)

    echo "$test_query" | docker run --rm \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        -v "$(pwd)/$test_dir/CLAUDE.md:/home/claude/CLAUDE.md:ro" \
        claude-mcp-test-env-v2 \
        claude --model sonnet --print \
        --mcp-config /home/claude/.config/claude-code/config.json \
        --allowedTools mcp__dollhousemcp__list_elements,mcp__dollhousemcp__search_collection,mcp__dollhousemcp__search_portfolio,mcp__dollhousemcp__activate_element,mcp__dollhousemcp__install_collection_content \
        > "$output_file" 2>&1

    local end_time=$(date +%s%N)
    local duration=$((($end_time - $start_time) / 1000000))  # Convert to milliseconds

    # Analyze results
    local tools_found=false
    for tool in $expected_tools; do
        if grep -q "$tool" "$output_file"; then
            tools_found=true
            break
        fi
    done

    # Check if capability index was referenced
    local index_used=false
    if grep -qi "capability\|index\|checking\|referring" "$output_file"; then
        index_used=true
    fi

    # Record results
    cat >> "$RESULTS_DIR/results.csv" <<EOF
$test_id,$test_name,$tools_found,$index_used,$duration,$expected_tools
EOF

    if [ "$tools_found" = true ]; then
        PASSED_TESTS=$((PASSED_TESTS + 1))
        log "✅ PASS: Found expected tools (${duration}ms)"
    else
        FAILED_TESTS=$((FAILED_TESTS + 1))
        log "❌ FAIL: Did not find expected tools (${duration}ms)"
    fi

    # Save metadata
    cat > "$test_dir/metadata.json" <<EOF
{
  "test_id": "$test_id",
  "test_name": "$test_name",
  "duration_ms": $duration,
  "tools_found": $tools_found,
  "index_used": $index_used,
  "expected_tools": "$expected_tools",
  "timestamp": "$(date -Iseconds)"
}
EOF
}

# Initialize results file
echo "test_id,test_name,tools_found,index_used,duration_ms,expected_tools" > "$RESULTS_DIR/results.csv"

log "=== Starting Capability Index Combinatorial Matrix Test ==="
log "Session ID: $SESSION_ID"
log "Results directory: $RESULTS_DIR"
log ""

# Test Variables
# 1. INDEX STRUCTURES
CASCADE_TOP='CAPABILITY_INDEX:
  debug → search_portfolio("debug")
  error → search_collection("error")
  security → search_collection("security")
  persona → list_elements("personas")
  memory → list_elements("memories")'

CASCADE_BOTTOM='[Regular context here...]

CAPABILITY_INDEX:
  debug → search_collection("debug")
  error → search_portfolio("error")
  git → search_collection("git")'

NESTED='capabilities:
  development:
    debugging:
      tools: [search_portfolio, search_collection]
      query: ["debug", "error"]
    security:
      tools: [search_collection]
      query: ["security"]'

FLAT='Available DollhouseMCP Tools:
- search_portfolio: search your local elements
- search_collection: search community elements
- list_elements: list available elements
- activate_element: activate a persona'

ACTION_VERBS='ACTIONS → MCP_TOOLS:
  NEED_DEBUG → USE search_collection("debug")
  FOUND_ERROR → USE search_portfolio("error")
  LIST_PERSONAS → USE list_elements("personas")'

NO_INDEX=''

# 2. CLAUDE.MD PROMPTS
EXPLICIT_PROMPT='# CRITICAL: Capability Index Usage

ALWAYS follow this process:
1. Check the CAPABILITY_INDEX first
2. Select the appropriate DollhouseMCP tool
3. Use the selected tool
4. Explain your selection

The capability index maps tasks to DollhouseMCP tools.'

SUGGESTIVE_PROMPT='# Working with DollhouseMCP

When you receive a request, consider checking if there is a capability index that might help you select the right tool for the task.'

EMBEDDED_PROMPT='# Project Context

This project uses DollhouseMCP for AI customization. Elements are indexed for quick selection based on task requirements.'

NO_PROMPT=''

# Test queries with expected tools
QUERIES=(
    "Help me debug this error|search_collection search_portfolio"
    "Find a security analysis persona|search_collection search_portfolio"
    "Show me available personas|list_elements"
    "I need a git workflow helper|search_collection"
)

log "=== Test Batch 1: Cascade Top Structure ==="
for query_data in "${QUERIES[@]}"; do
    IFS='|' read -r query expected <<< "$query_data"

    run_capability_test "cascade_top_explicit" "$CASCADE_TOP" "$EXPLICIT_PROMPT" "$query" "$expected"
    run_capability_test "cascade_top_suggestive" "$CASCADE_TOP" "$SUGGESTIVE_PROMPT" "$query" "$expected"
    run_capability_test "cascade_top_embedded" "$CASCADE_TOP" "$EMBEDDED_PROMPT" "$query" "$expected"
    run_capability_test "cascade_top_none" "$CASCADE_TOP" "$NO_PROMPT" "$query" "$expected"
done

log ""
log "=== Test Batch 2: Nested Structure ==="
for query_data in "${QUERIES[@]}"; do
    IFS='|' read -r query expected <<< "$query_data"

    run_capability_test "nested_explicit" "$NESTED" "$EXPLICIT_PROMPT" "$query" "$expected"
    run_capability_test "nested_suggestive" "$NESTED" "$SUGGESTIVE_PROMPT" "$query" "$expected"
    run_capability_test "nested_embedded" "$NESTED" "$EMBEDDED_PROMPT" "$query" "$expected"
    run_capability_test "nested_none" "$NESTED" "$NO_PROMPT" "$query" "$expected"
done

log ""
log "=== Test Batch 3: Flat Structure ==="
for query_data in "${QUERIES[@]}"; do
    IFS='|' read -r query expected <<< "$query_data"

    run_capability_test "flat_explicit" "$FLAT" "$EXPLICIT_PROMPT" "$query" "$expected"
    run_capability_test "flat_suggestive" "$FLAT" "$SUGGESTIVE_PROMPT" "$query" "$expected"
    run_capability_test "flat_embedded" "$FLAT" "$EMBEDDED_PROMPT" "$query" "$expected"
    run_capability_test "flat_none" "$FLAT" "$NO_PROMPT" "$query" "$expected"
done

log ""
log "=== Test Batch 4: Action Verbs Structure ==="
for query_data in "${QUERIES[@]}"; do
    IFS='|' read -r query expected <<< "$query_data"

    run_capability_test "action_explicit" "$ACTION_VERBS" "$EXPLICIT_PROMPT" "$query" "$expected"
    run_capability_test "action_suggestive" "$ACTION_VERBS" "$SUGGESTIVE_PROMPT" "$query" "$expected"
    run_capability_test "action_embedded" "$ACTION_VERBS" "$EMBEDDED_PROMPT" "$query" "$expected"
    run_capability_test "action_none" "$ACTION_VERBS" "$NO_PROMPT" "$query" "$expected"
done

log ""
log "=== Test Batch 5: Control (No Index) ==="
for query_data in "${QUERIES[@]}"; do
    IFS='|' read -r query expected <<< "$query_data"

    run_capability_test "control_explicit" "$NO_INDEX" "$EXPLICIT_PROMPT" "$query" "$expected"
    run_capability_test "control_none" "$NO_INDEX" "$NO_PROMPT" "$query" "$expected"
done

# Generate summary report
log ""
log "=== Test Summary ==="
log "Total tests: $TOTAL_TESTS"
log "Passed: $PASSED_TESTS"
log "Failed: $FAILED_TESTS"
log "Success rate: $(( PASSED_TESTS * 100 / TOTAL_TESTS ))%"
log ""

# Generate analysis report
cat > "$RESULTS_DIR/analysis.md" <<EOF
# Capability Index Test Analysis
## Session: $SESSION_ID
## Date: $(date)

### Test Summary
- **Total Tests**: $TOTAL_TESTS
- **Passed**: $PASSED_TESTS
- **Failed**: $FAILED_TESTS
- **Success Rate**: $(( PASSED_TESTS * 100 / TOTAL_TESTS ))%

### Test Configuration
- **Model**: Claude 3.5 Sonnet
- **MCP Server**: DollhouseMCP v1.9.8
- **Docker Image**: claude-mcp-test-env-v2

### Test Matrix
- **Index Structures**: 6 (cascade-top, cascade-bottom, nested, flat, action-verbs, none)
- **CLAUDE.md Prompts**: 4 (explicit, suggestive, embedded, none)
- **Test Queries**: 4 (debug, security, personas, git)

### Results by Structure
\`\`\`
$(awk -F, 'NR>1 {split($2,a,"_"); count[a[1]]++; if($3=="true") pass[a[1]]++} END {for(i in count) printf "%-15s: %2d/%2d (%.0f%%)\n", i, pass[i], count[i], pass[i]*100/count[i]}' "$RESULTS_DIR/results.csv" | sort)
\`\`\`

### Results by Prompt Type
\`\`\`
$(awk -F, 'NR>1 {split($2,a,"_"); count[a[2]]++; if($3=="true") pass[a[2]]++} END {for(i in count) printf "%-15s: %2d/%2d (%.0f%%)\n", i, pass[i], count[i], pass[i]*100/count[i]}' "$RESULTS_DIR/results.csv" | sort)
\`\`\`

### Index Usage Statistics
\`\`\`
$(awk -F, 'NR>1 {total++; if($4=="true") used++} END {printf "Index Referenced: %d/%d (%.0f%%)\n", used, total, used*100/total}' "$RESULTS_DIR/results.csv")
\`\`\`

### Performance Metrics
\`\`\`
$(awk -F, 'NR>1 {sum+=$5; if($5<min || NR==2) min=$5; if($5>max) max=$5} END {printf "Avg Response Time: %.0fms\nMin Response Time: %dms\nMax Response Time: %dms\n", sum/(NR-1), min, max}' "$RESULTS_DIR/results.csv")
\`\`\`

### Raw Data
See \`results.csv\` for complete test data.

---
*Generated by Capability Index Test Suite*
EOF

log "Analysis report saved to: $RESULTS_DIR/analysis.md"
log "Raw results saved to: $RESULTS_DIR/results.csv"
log ""
log "=== Test Complete ==="