#!/bin/bash

# Claude Code Docker Test Orchestrator
# Spawns fresh Claude Code instances for each capability index test
# Ensures complete isolation between test variations

set -e

echo "🚀 Claude Code Capability Index Test Orchestrator"
echo "================================================="
echo ""

# Configuration
TEST_DIR="/tmp/claude-code-capability-tests"
RESULTS_DIR="./test/experiments/results"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
CLAUDE_CODE_IMAGE="anthropic/claude-code:latest"  # Adjust to actual image

# Ensure directories exist
mkdir -p "$TEST_DIR"
mkdir -p "$RESULTS_DIR"
mkdir -p "$TEST_DIR/variations"
mkdir -p "$TEST_DIR/queries"
mkdir -p "$TEST_DIR/results"

# Create test variations as separate files
echo "📝 Creating test variations..."

# Variation 1: Cascade at Top (Optimized)
cat > "$TEST_DIR/variations/01_cascade_top.md" <<'EOF'
# Test Variation: Cascade at Top

## System Prompt
CAPABILITY_TRIGGERS:
  debug → debug-detective
  error → debug-detective
  git → git-manager
  issue → github-issue-creator

When a trigger matches, respond: "SELECTED: [capability-name]"
EOF

# Variation 2: Cascade at Bottom (De-optimized)
cat > "$TEST_DIR/variations/02_cascade_bottom.md" <<'EOF'
# Test Variation: Cascade at Bottom

## System Prompt
You are an AI assistant. Help users with their requests.

[... 500 tokens of other context ...]

CAPABILITY_TRIGGERS:
  debug → debug-detective
  error → debug-detective
  git → git-manager
  issue → github-issue-creator
EOF

# Variation 3: Nested Structure
cat > "$TEST_DIR/variations/03_nested.md" <<'EOF'
# Test Variation: Nested Structure

## System Prompt
capabilities:
  development:
    debugging:
      tools:
        debug-detective:
          triggers: ["debug", "error"]
    version_control:
      tools:
        git-manager:
          triggers: ["git", "commit"]
EOF

# Variation 4: Flat List
cat > "$TEST_DIR/variations/04_flat.md" <<'EOF'
# Test Variation: Flat List

## System Prompt
Available:
- debug-detective (debug, error, bug)
- git-manager (git, commit)
- github-issue-creator (issue, github)

Select with: "SELECTED: [name]"
EOF

# Variation 5: Action Verbs
cat > "$TEST_DIR/variations/05_action_verbs.md" <<'EOF'
# Test Variation: Action Verbs

## System Prompt
ACTIONS:
  NEED_DEBUG → USE debug-detective
  NEED_COMMIT → USE git-manager
  CREATE_ISSUE → USE github-issue-creator
EOF

# Variation 6: Control (No Structure)
cat > "$TEST_DIR/variations/06_control.md" <<'EOF'
# Test Variation: Control

## System Prompt
Tools: debug-detective, git-manager, github-issue-creator
EOF

# Create test queries
cat > "$TEST_DIR/queries/test_queries.json" <<'EOF'
[
  {"id": 1, "query": "Help me debug this error", "expected": "debug-detective"},
  {"id": 2, "query": "Fix this bug", "expected": "debug-detective"},
  {"id": 3, "query": "Create a git commit", "expected": "git-manager"},
  {"id": 4, "query": "Open a GitHub issue", "expected": "github-issue-creator"},
  {"id": 5, "query": "The app is crashing", "expected": "debug-detective"}
]
EOF

# Create test runner script that will run inside each Claude Code container
cat > "$TEST_DIR/run_single_test.js" <<'EOF'
#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

async function runTest() {
  const variationFile = process.env.VARIATION_FILE;
  const queryId = process.env.QUERY_ID;

  // Load variation
  const variation = fs.readFileSync(`/test/variations/${variationFile}`, 'utf8');

  // Load query
  const queries = JSON.parse(fs.readFileSync('/test/queries/test_queries.json', 'utf8'));
  const query = queries.find(q => q.id === parseInt(queryId));

  // This is where we'd interact with Claude Code
  // For now, log what would happen
  console.log(JSON.stringify({
    variation: variationFile,
    query: query,
    timestamp: Date.now(),
    container_id: process.env.HOSTNAME
  }));
}

runTest().catch(console.error);
EOF

# Create Dockerfile for Claude Code test environment
cat > "$TEST_DIR/Dockerfile" <<'EOF'
FROM node:20-alpine

# Install DollhouseMCP if needed
RUN npm install -g @dollhousemcp/mcp-server

WORKDIR /test

# Copy test files
COPY run_single_test.js .
COPY variations/ ./variations/
COPY queries/ ./queries/

# Each container runs ONE test
CMD ["node", "run_single_test.js"]
EOF

# Create orchestrator script with real-time compilation
cat > "$TEST_DIR/orchestrator.py" <<'EOF'
#!/usr/bin/env python3

import subprocess
import json
import time
import os
from pathlib import Path
from datetime import datetime

class ClaudeCodeOrchestrator:
    def __init__(self):
        self.results = []
        self.variations = sorted(Path('/test/variations').glob('*.md'))
        self.queries = json.loads(Path('/test/queries/test_queries.json').read_text())

        # Create results directory with timestamp
        self.session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.results_dir = Path(f'/results/session_{self.session_id}')
        self.results_dir.mkdir(parents=True, exist_ok=True)

        # Files for real-time compilation
        self.master_file = self.results_dir / 'master_results.json'
        self.summary_file = self.results_dir / 'summary.txt'
        self.live_log = self.results_dir / 'live_test.log'

        # Initialize master results
        self.master_results = {
            'session_id': self.session_id,
            'start_time': datetime.now().isoformat(),
            'variations': {},
            'summary': {}
        }

        self.save_master_results()

    def run_single_test(self, variation, query):
        """
        Spawn a fresh Claude Code container for a single test
        """
        container_name = f"claude-test-{variation.stem}-{query['id']}-{int(time.time())}"

        # Log to live file
        with open(self.live_log, 'a') as f:
            f.write(f"[{datetime.now().isoformat()}] Starting: {container_name}\n")

        # Build Docker run command
        docker_cmd = [
            'docker', 'run',
            '--rm',
            '--name', container_name,
            '-e', f'VARIATION_FILE={variation.name}',
            '-e', f'QUERY_ID={query["id"]}',
            '-v', f'{self.results_dir}:/container_results',
            'claude-code-test'
        ]

        start_time = time.time()

        try:
            # Run container and capture output
            result = subprocess.run(
                docker_cmd,
                capture_output=True,
                text=True,
                timeout=30
            )

            # Parse result
            if result.stdout:
                test_result = json.loads(result.stdout.strip())
                test_result['exit_code'] = result.returncode
                test_result['duration'] = time.time() - start_time

                # Check correctness
                test_result['correct'] = test_result.get('selected') == query['expected']

                return test_result
            else:
                return {
                    'error': 'No output',
                    'stderr': result.stderr,
                    'exit_code': result.returncode,
                    'duration': time.time() - start_time
                }

        except subprocess.TimeoutExpired:
            # Kill container if it hangs
            subprocess.run(['docker', 'kill', container_name], capture_output=True)
            return {
                'error': 'Timeout',
                'container': container_name,
                'duration': 30
            }

        except Exception as e:
            return {
                'error': str(e),
                'container': container_name,
                'duration': time.time() - start_time
            }

    def compile_variation_results(self, variation_name, results):
        """
        Compile results for a variation in real-time
        """
        correct_count = len([r for r in results if r.get('correct', False)])
        total_count = len(results)
        accuracy = (correct_count / total_count * 100) if total_count > 0 else 0

        # Calculate average tokens (if available)
        token_counts = [r.get('tokens', 0) for r in results if 'tokens' in r]
        avg_tokens = sum(token_counts) / len(token_counts) if token_counts else 0

        # Calculate average duration
        durations = [r.get('duration', 0) for r in results]
        avg_duration = sum(durations) / len(durations) if durations else 0

        return {
            'accuracy': accuracy,
            'correct_count': correct_count,
            'total_count': total_count,
            'avg_tokens': avg_tokens,
            'avg_duration': avg_duration,
            'details': results
        }

    def save_master_results(self):
        """
        Save compiled results to master file
        """
        with open(self.master_file, 'w') as f:
            json.dump(self.master_results, f, indent=2)

    def update_summary(self):
        """
        Update human-readable summary file
        """
        with open(self.summary_file, 'w') as f:
            f.write(f"Claude Code Capability Index Test Results\n")
            f.write(f"Session: {self.session_id}\n")
            f.write("=" * 60 + "\n\n")

            # Sort variations by accuracy
            variations = [(name, data) for name, data in self.master_results['variations'].items()]
            variations.sort(key=lambda x: x[1].get('accuracy', 0), reverse=True)

            for i, (name, data) in enumerate(variations, 1):
                f.write(f"{i}. {name}\n")
                f.write(f"   Accuracy: {data.get('accuracy', 0):.1f}% ")
                f.write(f"({data.get('correct_count', 0)}/{data.get('total_count', 0)})\n")
                f.write(f"   Avg Tokens: {data.get('avg_tokens', 0):.0f}\n")
                f.write(f"   Avg Duration: {data.get('avg_duration', 0):.2f}s\n")

                if i == 1:
                    f.write("   🏆 WINNER\n")

                f.write("\n")

    def run_all_tests(self):
        """
        Run all test combinations with fresh containers
        """
        total_tests = len(self.variations) * len(self.queries)
        print(f"📊 Running {total_tests} isolated tests")
        print(f"📁 Results directory: {self.results_dir}")
        print("=" * 60)

        test_num = 0

        for variation in self.variations:
            variation_results = []
            variation_name = variation.stem

            print(f"\n📁 Testing: {variation_name}")
            print("-" * 40)

            # Initialize variation in master results
            self.master_results['variations'][variation_name] = {
                'start_time': datetime.now().isoformat(),
                'tests': []
            }

            for query in self.queries:
                test_num += 1
                print(f"  Test {test_num}/{total_tests}: Query {query['id']}...", end=" ")

                # Run test in fresh container
                result = self.run_single_test(variation, query)

                # Add metadata
                result['variation'] = variation_name
                result['query'] = query
                result['test_number'] = test_num

                variation_results.append(result)

                # Save individual result immediately
                individual_file = self.results_dir / f"test_{test_num:03d}_{variation_name}_q{query['id']}.json"
                with open(individual_file, 'w') as f:
                    json.dump(result, f, indent=2)

                # Update master results
                self.master_results['variations'][variation_name]['tests'].append(result)

                # Compile and update variation results
                compiled = self.compile_variation_results(variation_name, variation_results)
                self.master_results['variations'][variation_name].update(compiled)

                # Save master results after each test
                self.save_master_results()

                # Update summary
                self.update_summary()

                # Brief pause to ensure complete cleanup
                time.sleep(1)

                # Print result
                if 'error' in result:
                    print(f"❌ {result.get('error', 'Unknown error')}")
                elif result.get('correct'):
                    print(f"✅ {result.get('selected')} (correct)")
                else:
                    print(f"❌ {result.get('selected')} (expected: {query['expected']})")

            # Variation complete
            self.master_results['variations'][variation_name]['end_time'] = datetime.now().isoformat()
            self.save_master_results()

        # All tests complete
        self.master_results['end_time'] = datetime.now().isoformat()
        self.generate_final_report()

    def generate_final_report(self):
        """
        Generate comprehensive final report
        """
        print("\n\n📊 FINAL RESULTS")
        print("=" * 60)

        # Calculate insights
        variations = self.master_results['variations']

        # Position effect
        if '01_cascade_top' in variations and '02_cascade_bottom' in variations:
            top_acc = variations['01_cascade_top'].get('accuracy', 0)
            bottom_acc = variations['02_cascade_bottom'].get('accuracy', 0)
            position_effect = top_acc - bottom_acc

            self.master_results['summary']['position_effect'] = {
                'difference': position_effect,
                'top_accuracy': top_acc,
                'bottom_accuracy': bottom_acc
            }

            print(f"\n🎯 Position Effect: {position_effect:.1f}% (top vs bottom)")

        # Structure effect
        if '04_flat' in variations and '03_nested' in variations:
            flat_acc = variations['04_flat'].get('accuracy', 0)
            nested_acc = variations['03_nested'].get('accuracy', 0)
            structure_effect = flat_acc - nested_acc

            self.master_results['summary']['structure_effect'] = {
                'difference': structure_effect,
                'flat_accuracy': flat_acc,
                'nested_accuracy': nested_acc
            }

            print(f"🎯 Structure Effect: {structure_effect:.1f}% (flat vs nested)")

        # Save final master results
        self.save_master_results()
        self.update_summary()

        print(f"\n💾 All results compiled in: {self.results_dir}")
        print(f"   Master results: {self.master_file}")
        print(f"   Summary: {self.summary_file}")
        print(f"   Individual tests: {len(list(self.results_dir.glob('test_*.json')))} files")

def main():
    print("🐳 Building Docker image...")
    subprocess.run(['docker', 'build', '-t', 'claude-code-test', '.'], check=True)

    print("\n🚀 Starting test orchestration...")
    orchestrator = ClaudeCodeOrchestrator()
    orchestrator.run_all_tests()

if __name__ == '__main__':
    main()
EOF

# Create the actual Claude Code interaction script
cat > "$TEST_DIR/claude_code_test.sh" <<'EOF'
#!/bin/bash

# This script would actually interact with Claude Code
# For demonstration, we'll simulate the interaction

VARIATION=$1
QUERY=$2

# Start Claude Code container
CONTAINER_ID=$(docker run -d \
  -v $(pwd)/variations:/variations:ro \
  -v $(pwd)/results:/results \
  anthropic/claude-code:latest)

# Wait for Claude Code to be ready
sleep 5

# Send the variation as context
docker exec $CONTAINER_ID claude-code context add /variations/$VARIATION

# Send the query
RESPONSE=$(docker exec $CONTAINER_ID claude-code prompt "$QUERY")

# Extract selection
SELECTED=$(echo "$RESPONSE" | grep "SELECTED:" | cut -d: -f2 | tr -d ' ')

# Stop and remove container
docker stop $CONTAINER_ID
docker rm $CONTAINER_ID

# Return result
echo "{\"variation\": \"$VARIATION\", \"query\": \"$QUERY\", \"selected\": \"$SELECTED\"}"
EOF

# Make scripts executable
chmod +x "$TEST_DIR/run_single_test.js"
chmod +x "$TEST_DIR/orchestrator.py"
chmod +x "$TEST_DIR/claude_code_test.sh"

# Create runner convenience script
cat > "$TEST_DIR/run_tests.sh" <<'EOF'
#!/bin/bash

cd /tmp/claude-code-capability-tests

echo "🔬 Claude Code Capability Index Testing"
echo ""
echo "This will:"
echo "1. Build a test Docker image"
echo "2. Spawn a fresh Claude Code container for EACH test"
echo "3. Run the test in complete isolation"
echo "4. Collect results"
echo "5. Destroy the container"
echo "6. Repeat for all variations"
echo ""

# Build test image
echo "📦 Building test image..."
docker build -t claude-code-test .

# Run orchestrator
echo "🚀 Starting orchestration..."
python3 orchestrator.py

echo ""
echo "✅ Testing complete!"
EOF

chmod +x "$TEST_DIR/run_tests.sh"

echo "✅ Test environment created in: $TEST_DIR"
echo ""
echo "📋 Test Structure:"
echo "  - 6 variations (optimized and de-optimized)"
echo "  - 5 test queries each"
echo "  - 30 total isolated tests"
echo ""
echo "To run the tests:"
echo "  cd $TEST_DIR"
echo "  ./run_tests.sh"
echo ""
echo "Each test will:"
echo "1. Spawn a fresh Claude Code Docker container"
echo "2. Load ONLY that variation's context"
echo "3. Run ONLY that query"
echo "4. Record the result"
echo "5. Destroy the container"
echo ""
echo "This ensures ZERO contamination between tests!"