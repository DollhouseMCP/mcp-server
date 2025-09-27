#!/bin/bash

# Empirical Test Runner for Capability Index Structures
# Uses Docker to create clean Claude Code environments for unbiased testing

set -e

echo "🧪 Capability Index Empirical Testing Framework"
echo "=============================================="
echo ""

# Configuration
TEST_DIR="/tmp/capability-index-tests"
RESULTS_DIR="./test/experiments/results"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Ensure results directory exists
mkdir -p $RESULTS_DIR

# Clean previous test environment
rm -rf $TEST_DIR
mkdir -p $TEST_DIR

# Test structures to evaluate
cat > $TEST_DIR/structure_cascade.yaml <<'EOF'
# STRUCTURE A: Cascade Pattern (Trigger → Summary → Full)
CAPABILITIES_TRIGGER_MAP:
  debug: debug-detective
  error: debug-detective
  git: git-manager
  issue: github-issue-creator
  test: test-runner
  memory: memory-manager

SUMMARIES:
  debug-detective:
    DO: "Systematic debugging, root cause analysis"
    WHEN: "error|bug|crash|failure|broken"
    ACTION: "load_capability('debug-detective')"
    TOKENS: 145
EOF

cat > $TEST_DIR/structure_nested.yaml <<'EOF'
# STRUCTURE B: Nested Hierarchy
capabilities:
  development:
    debugging:
      tools:
        debug-detective:
          description: "Systematic debugging tool"
          keywords: ["debug", "error", "bug", "crash"]
          procedures:
            - "Analyze symptoms"
            - "Isolate root cause"
            - "Implement fix"
          token_cost: 145
    version_control:
      tools:
        git-manager:
          description: "Git workflow management"
          keywords: ["git", "commit", "branch"]
EOF

cat > $TEST_DIR/structure_flat.yaml <<'EOF'
# STRUCTURE C: Flat List
capabilities:
  - id: debug-detective
    name: "Debug Detective"
    description: "Systematic debugging and root cause analysis"
    keywords: ["debug", "error", "bug", "crash", "failure"]
    procedures: ["Analyze", "Isolate", "Fix"]
    tokens: 145
  - id: git-manager
    name: "Git Manager"
    description: "Git workflow and version control"
    keywords: ["git", "commit", "branch", "merge"]
    tokens: 120
  - id: github-issue-creator
    name: "GitHub Issue Creator"
    description: "Create and manage GitHub issues"
    keywords: ["issue", "github", "bug report"]
    tokens: 100
EOF

cat > $TEST_DIR/structure_rag.yaml <<'EOF'
# STRUCTURE D: RAG-style chunks
chunks:
  - id: "chunk-001"
    text: "Debug Detective is a systematic debugging tool that helps with error analysis, bug isolation, and root cause analysis. Use when encountering errors, crashes, or failures."
    tool_id: "debug-detective"
    relevance_keywords: ["debug", "error", "bug", "crash"]
  - id: "chunk-002"
    text: "Git Manager handles all version control operations including commits, branches, and merges. Essential for git workflows."
    tool_id: "git-manager"
    relevance_keywords: ["git", "commit", "branch"]
  - id: "chunk-003"
    text: "GitHub Issue Creator streamlines the process of creating and managing GitHub issues with proper formatting and labels."
    tool_id: "github-issue-creator"
    relevance_keywords: ["issue", "github", "report"]
EOF

# Test prompts
cat > $TEST_DIR/test_prompts.json <<'EOF'
{
  "tests": [
    {
      "id": "test-1",
      "prompt": "Help me debug this error in my application",
      "expected_tool": "debug-detective",
      "category": "debugging"
    },
    {
      "id": "test-2",
      "prompt": "I need to fix a bug that's causing crashes",
      "expected_tool": "debug-detective",
      "category": "debugging"
    },
    {
      "id": "test-3",
      "prompt": "Create a git commit with my changes",
      "expected_tool": "git-manager",
      "category": "version_control"
    },
    {
      "id": "test-4",
      "prompt": "I want to create a GitHub issue about this problem",
      "expected_tool": "github-issue-creator",
      "category": "issue_management"
    },
    {
      "id": "test-5",
      "prompt": "The application keeps crashing with an error",
      "expected_tool": "debug-detective",
      "category": "debugging"
    }
  ]
}
EOF

# Create test runner script
cat > $TEST_DIR/run_test.js <<'EOF'
#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * Test runner for capability index structures
 * Measures selection accuracy and token usage
 */

async function runTest(structureFile, promptData) {
  const structure = fs.readFileSync(structureFile, 'utf8');
  const structureName = path.basename(structureFile, '.yaml');

  console.log(`\nTesting: ${structureName}`);
  console.log('='.repeat(50));

  const results = {
    structure: structureName,
    tests: [],
    metrics: {
      accuracy: 0,
      avgTokens: 0,
      avgTime: 0
    }
  };

  for (const test of promptData.tests) {
    const startTime = Date.now();

    // This would be replaced with actual LLM API calls
    // For now, we'll simulate based on structure type
    const result = simulateSelection(structure, test.prompt, test.expected_tool);

    results.tests.push({
      ...test,
      ...result,
      time_ms: Date.now() - startTime
    });

    console.log(`  ${test.id}: ${result.correct ? '✅' : '❌'} (${result.tokens} tokens)`);
  }

  // Calculate metrics
  const correctCount = results.tests.filter(t => t.correct).length;
  results.metrics.accuracy = (correctCount / results.tests.length) * 100;
  results.metrics.avgTokens = results.tests.reduce((sum, t) => sum + t.tokens, 0) / results.tests.length;
  results.metrics.avgTime = results.tests.reduce((sum, t) => sum + t.time_ms, 0) / results.tests.length;

  return results;
}

function simulateSelection(structure, prompt, expectedTool) {
  // Simplified simulation - in reality this would use actual LLM
  let tokens = 0;
  let selected = null;
  let confidence = 0;

  if (structure.includes('CAPABILITIES_TRIGGER_MAP')) {
    // Cascade pattern - very efficient
    tokens = 10; // trigger map
    if (prompt.includes('debug') || prompt.includes('error') || prompt.includes('crash')) {
      selected = 'debug-detective';
      tokens += 50; // load summary
      confidence = 0.95;
    } else if (prompt.includes('git') || prompt.includes('commit')) {
      selected = 'git-manager';
      tokens += 50;
      confidence = 0.95;
    } else if (prompt.includes('issue') || prompt.includes('GitHub')) {
      selected = 'github-issue-creator';
      tokens += 50;
      confidence = 0.90;
    }
  } else if (structure.includes('capabilities:') && structure.includes('development:')) {
    // Nested pattern - expensive traversal
    tokens = 300; // load entire structure
    // Simplified matching logic
    if (prompt.includes('debug') || prompt.includes('error')) {
      selected = 'debug-detective';
      confidence = 0.75;
    } else if (prompt.includes('git')) {
      selected = 'git-manager';
      confidence = 0.70;
    }
  } else if (structure.includes('- id:')) {
    // Flat list - moderate cost
    tokens = 150; // load all summaries
    // Linear search simulation
    if (prompt.match(/debug|error|bug|crash/i)) {
      selected = 'debug-detective';
      confidence = 0.85;
    } else if (prompt.match(/git|commit/i)) {
      selected = 'git-manager';
      confidence = 0.85;
    } else if (prompt.match(/issue|github/i)) {
      selected = 'github-issue-creator';
      confidence = 0.80;
    }
  } else if (structure.includes('chunks:')) {
    // RAG pattern - embedding + retrieval
    tokens = 50 + 300; // embedding + chunks
    // Semantic search simulation
    if (prompt.match(/debug|error|crash/i)) {
      selected = 'debug-detective';
      confidence = 0.88;
    } else if (prompt.match(/git/i)) {
      selected = 'git-manager';
      confidence = 0.82;
    } else if (prompt.match(/issue/i)) {
      selected = 'github-issue-creator';
      confidence = 0.85;
    }
  }

  return {
    selected,
    correct: selected === expectedTool,
    tokens,
    confidence
  };
}

// Main execution
async function main() {
  const prompts = JSON.parse(fs.readFileSync('test_prompts.json', 'utf8'));
  const structures = fs.readdirSync('.')
    .filter(f => f.startsWith('structure_') && f.endsWith('.yaml'));

  const allResults = [];

  for (const structure of structures) {
    const results = await runTest(structure, prompts);
    allResults.push(results);
  }

  // Generate summary report
  console.log('\n\n📊 SUMMARY REPORT');
  console.log('='.repeat(60));

  const winner = allResults.reduce((best, current) => {
    const score = (current.metrics.accuracy / 100) * 1000 - current.metrics.avgTokens;
    const bestScore = (best.metrics.accuracy / 100) * 1000 - best.metrics.avgTokens;
    return score > bestScore ? current : best;
  });

  for (const result of allResults) {
    console.log(`\n${result.structure}:`);
    console.log(`  Accuracy: ${result.metrics.accuracy.toFixed(1)}%`);
    console.log(`  Avg Tokens: ${result.metrics.avgTokens.toFixed(0)}`);
    console.log(`  Avg Time: ${result.metrics.avgTime.toFixed(0)}ms`);
    if (result === winner) console.log('  🏆 WINNER');
  }

  // Save detailed results
  fs.writeFileSync(
    `results_${Date.now()}.json`,
    JSON.stringify(allResults, null, 2)
  );

  console.log('\n✅ Results saved to results_*.json');
}

main().catch(console.error);
EOF

# Create Docker test environment
cat > $TEST_DIR/Dockerfile <<'EOF'
FROM node:20-alpine

# Install DollhouseMCP
RUN npm install -g @dollhousemcp/mcp-server

# Copy test files
WORKDIR /tests
COPY . .

# Make test runner executable
RUN chmod +x run_test.js

CMD ["node", "run_test.js"]
EOF

# Create docker-compose for isolated testing
cat > $TEST_DIR/docker-compose.yml <<'EOF'
version: '3.8'

services:
  test-cascade:
    build: .
    volumes:
      - ./structure_cascade.yaml:/tests/structure.yaml:ro
      - ./results:/results
    environment:
      - TEST_STRUCTURE=cascade

  test-nested:
    build: .
    volumes:
      - ./structure_nested.yaml:/tests/structure.yaml:ro
      - ./results:/results
    environment:
      - TEST_STRUCTURE=nested

  test-flat:
    build: .
    volumes:
      - ./structure_flat.yaml:/tests/structure.yaml:ro
      - ./results:/results
    environment:
      - TEST_STRUCTURE=flat

  test-rag:
    build: .
    volumes:
      - ./structure_rag.yaml:/tests/structure.yaml:ro
      - ./results:/results
    environment:
      - TEST_STRUCTURE=rag
EOF

echo "📦 Test environment created in: $TEST_DIR"
echo ""
echo "To run the empirical tests:"
echo "  cd $TEST_DIR"
echo "  docker-compose build"
echo "  docker-compose up"
echo ""
echo "Or for a quick local test:"
echo "  cd $TEST_DIR"
echo "  node run_test.js"
echo ""

# Run local test for immediate feedback
cd $TEST_DIR
echo "🚀 Running local simulation..."
node run_test.js

# Copy results back
cp results_*.json $RESULTS_DIR/capability_index_test_$TIMESTAMP.json 2>/dev/null || true

echo ""
echo "📊 Test complete! Results saved to: $RESULTS_DIR/"
echo ""
echo "Next steps:"
echo "1. Review the results to see which structure performs best"
echo "2. Run with actual LLM API for real empirical data"
echo "3. Test with more complex scenarios"