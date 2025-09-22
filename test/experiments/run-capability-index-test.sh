#!/bin/bash

# Capability Index Test using separate Claude instances
# Each test runs in a fresh Docker container with isolated context
# This ensures no contamination between tests

set -e

# Session metadata
SESSION_ID=$(date +%Y%m%d_%H%M%S)
RESULTS_DIR="test/experiments/capability-index-results/session_${SESSION_ID}"
mkdir -p "$RESULTS_DIR"

echo "=== Capability Index Combinatorial Test Suite ==="
echo "Session: $SESSION_ID"
echo "Each test runs in a SEPARATE Claude instance (fresh Docker container)"
echo ""

# Simple validation test first
echo "Running validation test..."
docker run --rm \
    -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
    --entrypoint bash \
    claude-mcp-test-env-v2 -c '
    mkdir -p ~/.claude
    echo "#!/bin/bash" > ~/.claude/anthropic_key_helper.sh
    echo "echo \${ANTHROPIC_API_KEY}" >> ~/.claude/anthropic_key_helper.sh
    chmod +x ~/.claude/anthropic_key_helper.sh
    claude config set --global apiKeyHelper ~/.claude/anthropic_key_helper.sh >/dev/null 2>&1
    echo "Show me available personas" | claude --model sonnet --print \
        --mcp-config /home/claude/.config/claude-code/config.json \
        --allowedTools mcp__dollhousemcp__list_elements
' > "$RESULTS_DIR/validation.txt" 2>&1

if grep -q "personas" "$RESULTS_DIR/validation.txt"; then
    echo "✅ Validation passed - MCP tools working"
else
    echo "❌ Validation failed - check Docker setup"
    cat "$RESULTS_DIR/validation.txt"
    exit 1
fi

echo ""
echo "Starting combinatorial tests..."
echo ""

# Test counter
TEST_NUM=0

# Function to run a single isolated test
run_isolated_test() {
    local structure_name="$1"
    local structure_content="$2"
    local prompt_name="$3"
    local prompt_content="$4"
    local query="$5"

    TEST_NUM=$((TEST_NUM + 1))
    local test_id="${structure_name}_${prompt_name}_${TEST_NUM}"

    echo -n "Test $TEST_NUM: ${structure_name} + ${prompt_name} ... "

    # Create test directory
    local test_dir="$RESULTS_DIR/test_${TEST_NUM}"
    mkdir -p "$test_dir"

    # Create CLAUDE.md for this specific test
    cat > "$test_dir/CLAUDE.md" <<EOF
$prompt_content

## Capability Index

$structure_content

## Context
You have DollhouseMCP tools available for element management.
EOF

    # Run in ISOLATED Docker container (fresh Claude instance)
    local start_time=$(date +%s%N)

    docker run --rm \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        -v "$(pwd)/$test_dir/CLAUDE.md:/home/claude/CLAUDE.md:ro" \
        --entrypoint bash \
        claude-mcp-test-env-v2 -c "
        mkdir -p ~/.claude
        echo '#!/bin/bash' > ~/.claude/anthropic_key_helper.sh
        echo 'echo \\\${ANTHROPIC_API_KEY}' >> ~/.claude/anthropic_key_helper.sh
        chmod +x ~/.claude/anthropic_key_helper.sh
        claude config set --global apiKeyHelper ~/.claude/anthropic_key_helper.sh >/dev/null 2>&1
        echo '$query' | claude --model sonnet --print \
            --mcp-config /home/claude/.config/claude-code/config.json \
            --allowedTools mcp__dollhousemcp__list_elements,mcp__dollhousemcp__search_collection,mcp__dollhousemcp__search_portfolio
    " > "$test_dir/output.txt" 2>&1

    local end_time=$(date +%s%N)
    local duration=$((($end_time - $start_time) / 1000000))

    # Check if index was used
    local index_referenced="no"
    if grep -qi "capability\|index" "$test_dir/output.txt"; then
        index_referenced="yes"
    fi

    # Check if correct tool was called
    local tool_used="no"
    if grep -q "mcp__dollhousemcp" "$test_dir/output.txt"; then
        tool_used="yes"
    fi

    echo "${duration}ms (index:$index_referenced, tool:$tool_used)"

    # Save results
    echo "$TEST_NUM,$structure_name,$prompt_name,$index_referenced,$tool_used,$duration" >> "$RESULTS_DIR/results.csv"
}

# Initialize results
echo "test_num,structure,prompt,index_referenced,tool_used,duration_ms" > "$RESULTS_DIR/results.csv"

# Test structures
declare -A structures=(
    ["cascade"]='CAPABILITY_INDEX:
  debug → search_collection("debug")
  personas → list_elements("personas")
  security → search_portfolio("security")'

    ["flat"]='Available tools:
- search_collection: search community
- list_elements: list by type
- search_portfolio: search local'

    ["action"]='ACTIONS:
  NEED_DEBUG → USE search_collection
  LIST_PERSONAS → USE list_elements
  FIND_LOCAL → USE search_portfolio'

    ["none"]=''
)

# Test prompts
declare -A prompts=(
    ["explicit"]='# CRITICAL: Always check the Capability Index FIRST
The capability index below maps tasks to tools. You MUST consult it before any action.'

    ["suggestive"]='# Working with DollhouseMCP
Consider checking the capability index for guidance on tool selection.'

    ["none"]=''
)

# Test queries
queries=(
    "Show me available personas"
    "Help me debug an error"
    "Find security analysis tools"
)

# Run all combinations
for struct_name in "${!structures[@]}"; do
    for prompt_name in "${!prompts[@]}"; do
        for query in "${queries[@]}"; do
            run_isolated_test \
                "$struct_name" \
                "${structures[$struct_name]}" \
                "$prompt_name" \
                "${prompts[$prompt_name]}" \
                "$query"
        done
    done
done

echo ""
echo "=== Test Complete ==="
echo "Total tests run: $TEST_NUM"
echo "Each test ran in a SEPARATE Claude instance (no context contamination)"
echo ""

# Generate analysis
echo "Analyzing results..."

cat > "$RESULTS_DIR/analysis.md" <<EOF
# Capability Index Test Results
## Session: $SESSION_ID

### Test Configuration
- **Total Tests**: $TEST_NUM
- **Each test**: Run in isolated Docker container (fresh Claude instance)
- **Model**: Claude 3.5 Sonnet
- **No context contamination**: Each test is independent

### Results by Structure Type
\`\`\`
$(awk -F, 'NR>1 {s[$2]++; if($4=="yes") si[$2]++; if($5=="yes") st[$2]++}
END {for(i in s) printf "%-10s: %2d tests, %2d used index (%.0f%%), %2d used tool (%.0f%%)\n",
i, s[i], si[i], si[i]*100/s[i], st[i], st[i]*100/s[i]}' "$RESULTS_DIR/results.csv" | sort)
\`\`\`

### Results by Prompt Type
\`\`\`
$(awk -F, 'NR>1 {p[$3]++; if($4=="yes") pi[$3]++; if($5=="yes") pt[$3]++}
END {for(i in p) printf "%-10s: %2d tests, %2d used index (%.0f%%), %2d used tool (%.0f%%)\n",
i, p[i], pi[i], pi[i]*100/p[i], pt[i], pt[i]*100/p[i]}' "$RESULTS_DIR/results.csv" | sort)
\`\`\`

### Performance
\`\`\`
$(awk -F, 'NR>1 {sum+=$6; n++; if($6<min || NR==2) min=$6; if($6>max) max=$6}
END {printf "Average: %.0fms\nMin: %dms\nMax: %dms\n", sum/n, min, max}' "$RESULTS_DIR/results.csv")
\`\`\`

### Key Findings
Based on empirical data from isolated tests:
1. Structure effectiveness ranking
2. Prompt effectiveness ranking
3. Optimal combinations identified

EOF

echo ""
echo "Results saved to: $RESULTS_DIR/"
echo "- results.csv: Raw data"
echo "- analysis.md: Analysis report"
echo "- test_*/: Individual test outputs"