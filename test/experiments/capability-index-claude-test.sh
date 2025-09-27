#!/bin/bash

# Capability Index Test Using Real Claude Code in Docker
# Tests different capability index structures with actual Claude Code + DollhouseMCP

set -e

# Check for API key
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "Error: ANTHROPIC_API_KEY not set"
    exit 1
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test directory (use absolute path)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_DIR="$SCRIPT_DIR/docker-test-runs/claude-$(date +%s)"
mkdir -p "$TEST_DIR"

echo "=========================================="
echo "Capability Index Claude Code Testing"
echo "Test Directory: $TEST_DIR"
echo "=========================================="

# Build the Docker image if needed
echo "Building Docker test environment..."
docker build -f ../../docker/test-configs/Dockerfile.claude-testing -t claude-mcp-test-env ../.. > "$TEST_DIR/build.log" 2>&1 || {
    echo "Docker build failed. Trying with existing image..."
}

# ============= CAPABILITY INDEX VARIANTS =============

create_variant_minimal() {
    cat << 'EOF'
# DollhouseMCP Capability Index

ELEMENT_SEARCH_HIERARCHY:
  DEFAULT ORDER (when location unspecified):
    1. Active (already loaded) - 0 tokens
    2. Local (~/.dollhouse/portfolio) - 50 tokens
    3. GitHub (user's portfolio) - 100 tokens
    4. Collection (community library) - 150 tokens

TOOL_CAPABILITIES:
  search_portfolio: FINDS elements in local storage
  search_collection: FINDS elements in community library
  get_active_elements: CHECKS what's currently loaded
  activate_element: LOADS element into context
EOF
}

create_variant_with_hints() {
    cat << 'EOF'
# DollhouseMCP Capability Index

ALWAYS check this index FIRST before using tools.

ELEMENT_SEARCH_HIERARCHY:
  DEFAULT ORDER (when location unspecified):
    1. Active (already loaded) - 0 tokens
    2. Local (~/.dollhouse/portfolio) - 50 tokens
    3. GitHub (user's portfolio) - 100 tokens
    4. Collection (community library) - 150 tokens

  OVERRIDE: Explicit location in query overrides default order

TOOL_CAPABILITIES:
  search_portfolio: FINDS elements in local storage
  search_collection: FINDS elements in community library
  portfolio_element_manager: MANAGES GitHub portfolio
  get_active_elements: CHECKS what's currently loaded
  activate_element: LOADS element into context
  create_element: CREATES new element
  edit_element: MODIFIES existing element

WORKFLOW_HINTS:
  For debugging: Check active, then search local, then collection
  For memories: Check if exists first, then edit or create
  For security: Stay local only, never search collection
EOF
}

create_variant_explicit() {
    cat << 'EOF'
# DollhouseMCP Capability Index

YOU MUST FOLLOW THIS PROCESS:

1. Read the ELEMENT_SEARCH_HIERARCHY
2. Check capabilities in order: Active → Local → GitHub → Collection
3. Use the appropriate TOOL_CAPABILITIES

ELEMENT_SEARCH_HIERARCHY:
  MANDATORY ORDER (unless user specifies location):
    1. Active (get_active_elements) - 0 tokens
    2. Local (search_portfolio) - 50 tokens
    3. GitHub (portfolio_element_manager) - 100 tokens
    4. Collection (search_collection) - 150 tokens

TOOL_CAPABILITIES:
  search_portfolio: SEARCHES local ~/.dollhouse/portfolio
  search_collection: SEARCHES community library
  portfolio_element_manager: SEARCHES GitHub portfolio
  get_active_elements: LISTS currently active elements
  activate_element: ACTIVATES found element
  create_element: CREATES if not found
  edit_element: UPDATES existing element

INTENT_MAPPING:
  "debug" → search for debug skills/personas
  "memory" → check/create/edit memories
  "security" → local search only
  "git" → search collection for best practices
EOF
}

create_variant_control() {
    cat << 'EOF'
# DollhouseMCP

You have access to DollhouseMCP tools for AI customization.
EOF
}

# ============= TEST QUERIES =============

TEST_QUERIES=(
    "I need help debugging an error in my code"
    "Search the collection for a creative writing persona"
    "Remember that our API endpoint changed to /v2/users"
    "Check my local portfolio for security tools"
    "What personas are currently active?"
)

# ============= RUN TESTS =============

run_test() {
    local variant_name="$1"
    local variant_content="$2"
    local query="$3"
    local test_id="${variant_name}_$(date +%s)_$$"

    echo -e "\n${YELLOW}Testing: ${variant_name}${NC}"
    echo "Query: \"$query\""

    # Create test directory
    local test_path="$TEST_DIR/$test_id"
    mkdir -p "$test_path"

    # Save variant
    echo "$variant_content" > "$test_path/CLAUDE.md"
    echo "$query" > "$test_path/query.txt"

    # Run Claude Code with the query
    local start_time=$(date +%s)

    # Create a modified config that includes CLAUDE.md
    cat << EOF > "$test_path/config.json"
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": ["/app/dollhousemcp/dist/index.js"],
      "env": {
        "DOLLHOUSE_PORTFOLIO_DIR": "/app/portfolio",
        "DOLLHOUSE_CACHE_DIR": "/app/cache",
        "CLAUDE_MD_PATH": "/test/CLAUDE.md",
        "NODE_ENV": "development",
        "LOG_LEVEL": "info"
      }
    }
  },
  "defaultMcpServer": "dollhousemcp"
}
EOF

    # Run Claude Code with capability index (use absolute path)
    local abs_test_path="$(cd "$test_path" && pwd)"
    echo "$query" | docker run -i --rm \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        -v "$abs_test_path:/test:ro" \
        claude-mcp-test-env \
        bash -c "
            # Copy CLAUDE.md to where DollhouseMCP expects it
            mkdir -p /root/.dollhouse
            cp /test/CLAUDE.md /root/.dollhouse/CLAUDE.md 2>/dev/null || true

            # Run Claude with MCP
            claude --model sonnet --mcp-config /root/.config/claude-code/config.json 2>&1
        " > "$test_path/output.txt" 2>&1

    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    # Analyze output
    local output=$(cat "$test_path/output.txt")

    # Check if Claude mentioned the capability index
    if echo "$output" | grep -qi "capability\|index\|hierarchy\|search.*order"; then
        echo -e "  ${GREEN}✓${NC} Mentioned capability index"
        echo "mentioned_index=true" >> "$test_path/results.txt"
    else
        echo -e "  ${RED}✗${NC} Did not mention capability index"
        echo "mentioned_index=false" >> "$test_path/results.txt"
    fi

    # Check which tools were used
    if echo "$output" | grep -q "search_portfolio"; then
        echo -e "  ${GREEN}✓${NC} Used search_portfolio"
        echo "used_search_portfolio=true" >> "$test_path/results.txt"
    fi

    if echo "$output" | grep -q "search_collection"; then
        echo -e "  ${GREEN}✓${NC} Used search_collection"
        echo "used_search_collection=true" >> "$test_path/results.txt"
    fi

    if echo "$output" | grep -q "get_active_elements"; then
        echo -e "  ${GREEN}✓${NC} Used get_active_elements"
        echo "used_get_active=true" >> "$test_path/results.txt"
    fi

    echo "  Duration: ${duration}s"
    echo "duration=$duration" >> "$test_path/results.txt"

    # Save first 500 chars of output for review
    echo "$output" | head -c 500 > "$test_path/output_snippet.txt"
}

# ============= MAIN TEST EXECUTION =============

echo -e "\n${YELLOW}=== Starting Capability Index Tests ===${NC}\n"

# Test each variant with each query
for query in "${TEST_QUERIES[@]}"; do
    echo "================================================"
    echo "Query: \"$query\""
    echo "================================================"

    # Minimal variant
    run_test "minimal" "$(create_variant_minimal)" "$query"
    sleep 2  # Rate limiting

    # With hints variant
    run_test "with_hints" "$(create_variant_with_hints)" "$query"
    sleep 2

    # Explicit variant
    run_test "explicit" "$(create_variant_explicit)" "$query"
    sleep 2

    # Control (no index)
    run_test "control" "$(create_variant_control)" "$query"
    sleep 2
done

# ============= ANALYZE RESULTS =============

echo -e "\n${YELLOW}=== Test Results Summary ===${NC}\n"

# Count successes for each variant
for variant in minimal with_hints explicit control; do
    echo "Variant: $variant"
    mentioned_count=$(grep -l "mentioned_index=true" "$TEST_DIR"/*${variant}*/results.txt 2>/dev/null | wc -l)
    total_count=$(ls "$TEST_DIR"/*${variant}*/results.txt 2>/dev/null | wc -l)

    if [ "$total_count" -gt 0 ]; then
        percentage=$((mentioned_count * 100 / total_count))
        echo "  Mentioned index: $mentioned_count/$total_count (${percentage}%)"

        # Average duration
        avg_duration=$(grep "duration=" "$TEST_DIR"/*${variant}*/results.txt 2>/dev/null |
                      awk -F= '{sum+=$2; count++} END {if(count>0) printf "%.1f", sum/count; else print "0"}')
        echo "  Average duration: ${avg_duration}s"
    else
        echo "  No results found"
    fi
    echo
done

echo "Full results saved in: $TEST_DIR"
echo "To review outputs: ls -la $TEST_DIR/"