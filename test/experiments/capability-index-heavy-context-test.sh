#!/bin/bash

# Capability Index Test with Heavy Context Load
# Tests both MCP tools AND element activation (personas, memories)
# Simulates realistic scenario with 25,000+ tokens of context

set -e

SESSION_ID=$(date +%Y%m%d_%H%M%S)
RESULTS_DIR="test/experiments/capability-index-results/heavy_context_${SESSION_ID}"
mkdir -p "$RESULTS_DIR"

echo "=== Capability Index Heavy Context Test ==="
echo "Testing with 25,000+ tokens of pre-loaded context"
echo "Testing BOTH tools AND element activation"
echo ""

# Generate 25,000 tokens of context (approximately 100,000 characters)
generate_heavy_context() {
    cat << 'EOF'
# Project Documentation - Large Context Load

## Section 1: Background Information
Lorem ipsum dolor sit amet, consectetur adipiscing elit. This is a large documentation file that simulates a real project context with extensive documentation, code samples, and technical specifications. The purpose is to fill the context window with realistic content before testing capability index effectiveness.

[Repeating this pattern to reach ~25,000 tokens...]
EOF

    # Generate ~25,000 tokens worth of text
    for i in {1..500}; do
        echo "
## Technical Specification Section $i

This section contains detailed technical information about component $i of the system. It includes architecture decisions, implementation details, API specifications, data models, and various other technical considerations that would typically be found in a large software project.

### Subsection $i.1: Architecture Overview
The architecture for this component follows a microservices pattern with event-driven communication. Key services include authentication, authorization, data processing, and external integrations. Each service maintains its own database and communicates through a message queue.

### Subsection $i.2: Implementation Details
Implementation uses modern frameworks and follows best practices for scalability, maintainability, and security. Code is organized in a modular fashion with clear separation of concerns. Testing coverage exceeds 80% with both unit and integration tests.

### Subsection $i.3: API Specifications
RESTful API endpoints follow OpenAPI 3.0 specification. All endpoints require authentication via JWT tokens. Rate limiting is implemented at 100 requests per minute per user. Response formats support both JSON and XML.

### Subsection $i.4: Data Models
Data is stored in PostgreSQL with Redis caching layer. Schema migrations are managed through versioned scripts. All sensitive data is encrypted at rest and in transit. Backup procedures run daily with 30-day retention.
"
    done
}

# Test 1: Heavy context WITHOUT capability index
run_test_without_index() {
    local test_name="$1"
    local query="$2"
    local test_dir="$RESULTS_DIR/${test_name}_no_index"
    mkdir -p "$test_dir"

    echo -n "Test: $test_name (NO INDEX) ... "

    # Create CLAUDE.md with heavy context but NO index
    {
        generate_heavy_context
        echo "
## Available Resources
You have access to DollhouseMCP for managing personas, memories, skills, and other elements.
"
    } > "$test_dir/CLAUDE.md"

    # Measure tokens and time
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
            --allowedTools mcp__dollhousemcp__list_elements,mcp__dollhousemcp__search_collection,mcp__dollhousemcp__activate_element,mcp__dollhousemcp__create_element
    " > "$test_dir/output.txt" 2>&1

    local end_time=$(date +%s%N)
    local duration=$((($end_time - $start_time) / 1000000))

    echo "${duration}ms"

    # Estimate token count
    local char_count=$(wc -c < "$test_dir/CLAUDE.md")
    local token_estimate=$((char_count / 4))
    echo "  Input tokens (estimate): $token_estimate"
}

# Test 2: Heavy context WITH capability index
run_test_with_index() {
    local test_name="$1"
    local query="$2"
    local index_type="$3"
    local test_dir="$RESULTS_DIR/${test_name}_${index_type}"
    mkdir -p "$test_dir"

    echo -n "Test: $test_name ($index_type INDEX) ... "

    # Create CLAUDE.md with heavy context AND index
    {
        echo "# CAPABILITY INDEX - CHECK THIS FIRST

## Quick Navigation Map
CAPABILITY_INDEX:
  # Personas (behavioral profiles)
  creative → activate_element('creative-writer')
  technical → activate_element('technical-analyst')
  debug → activate_element('debug-detective')
  explain → activate_element('eli5-explainer')
  security → activate_element('security-analyst')
  business → activate_element('business-consultant')

  # Memories (context storage)
  save_context → create_element(type='memories', content=context)
  recall_session → search_portfolio('session-2025')
  docker_solution → search_portfolio('docker-authentication')

  # Tools (MCP operations)
  list_personas → list_elements('personas')
  find_skills → search_collection('skills')
  search_local → search_portfolio(query)
  install_new → install_collection_content(path)

  # Common Workflows
  'help debug' → activate_element('debug-detective') + search_collection('debug')
  'explain simply' → activate_element('eli5-explainer')
  'analyze security' → activate_element('security-analyst') + search_collection('security')
  'creative writing' → activate_element('creative-writer')

When you see these triggers, use the mapped capability immediately.
"

        generate_heavy_context

        echo "
## Available Resources
You have access to DollhouseMCP for managing personas, memories, skills, and other elements.
The capability index above provides quick access patterns.
"
    } > "$test_dir/CLAUDE.md"

    # Measure tokens and time
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
            --allowedTools mcp__dollhousemcp__list_elements,mcp__dollhousemcp__search_collection,mcp__dollhousemcp__activate_element,mcp__dollhousemcp__create_element
    " > "$test_dir/output.txt" 2>&1

    local end_time=$(date +%s%N)
    local duration=$((($end_time - $start_time) / 1000000))

    echo "${duration}ms"

    # Estimate token count
    local char_count=$(wc -c < "$test_dir/CLAUDE.md")
    local token_estimate=$((char_count / 4))
    echo "  Input tokens (estimate): $token_estimate"
}

# Test 3: Capability index at BOTTOM of heavy context
run_test_index_bottom() {
    local test_name="$1"
    local query="$2"
    local test_dir="$RESULTS_DIR/${test_name}_bottom_index"
    mkdir -p "$test_dir"

    echo -n "Test: $test_name (BOTTOM INDEX) ... "

    # Create CLAUDE.md with index at BOTTOM
    {
        generate_heavy_context

        echo "
## CAPABILITY INDEX - QUICK REFERENCE

### Element Activation Shortcuts
- 'debug' → activate_element('debug-detective')
- 'creative' → activate_element('creative-writer')
- 'explain' → activate_element('eli5-explainer')

### Memory Operations
- 'save this' → create_element(type='memories')
- 'recall' → search_portfolio('session')

### Tool Shortcuts
- 'list personas' → list_elements('personas')
- 'find skills' → search_collection('skills')
"
    } > "$test_dir/CLAUDE.md"

    # Run test (same as above)
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
            --allowedTools mcp__dollhousemcp__list_elements,mcp__dollhousemcp__search_collection,mcp__dollhousemcp__activate_element,mcp__dollhousemcp__create_element
    " > "$test_dir/output.txt" 2>&1

    local end_time=$(date +%s%N)
    local duration=$((($end_time - $start_time) / 1000000))

    echo "${duration}ms"
}

echo "=== Running Heavy Context Tests ==="
echo ""

# Test queries that should trigger different behaviors
echo "Test Set 1: Persona Activation"
run_test_without_index "persona_activation" "I need help debugging an error"
run_test_with_index "persona_activation" "I need help debugging an error" "full"
run_test_index_bottom "persona_activation" "I need help debugging an error"

echo ""
echo "Test Set 2: Memory Creation"
run_test_without_index "memory_creation" "Save this conversation for later"
run_test_with_index "memory_creation" "Save this conversation for later" "full"
run_test_index_bottom "memory_creation" "Save this conversation for later"

echo ""
echo "Test Set 3: Tool Usage"
run_test_without_index "tool_usage" "Show me available personas"
run_test_with_index "tool_usage" "Show me available personas" "full"
run_test_index_bottom "tool_usage" "Show me available personas"

echo ""
echo "Test Set 4: Combined Workflow"
run_test_without_index "workflow" "Help me explain this simply to a child"
run_test_with_index "workflow" "Help me explain this simply to a child" "full"
run_test_index_bottom "workflow" "Help me explain this simply to a child"

# Analysis
echo ""
echo "=== Generating Analysis ==="

cat > "$RESULTS_DIR/analysis.md" << EOF
# Heavy Context Capability Index Test Results
## Session: $SESSION_ID
## Date: $(date)

### Test Configuration
- **Context Size**: ~25,000 tokens
- **Model**: Claude 3.5 Sonnet
- **Testing**: Tools AND element activation (personas, memories)

### Key Questions
1. Does capability index help when context is already heavy?
2. Does index position matter (top vs bottom)?
3. Are personas/memories activated more efficiently with index?
4. What's the token cost vs benefit?

### Results Summary
[Timing and token data from tests]

### Observations
- Compare response times with/without index
- Check if correct elements were activated
- Analyze token usage differences
- Note any behavioral changes

EOF

echo "Results saved to: $RESULTS_DIR/"
echo "Analysis at: $RESULTS_DIR/analysis.md"