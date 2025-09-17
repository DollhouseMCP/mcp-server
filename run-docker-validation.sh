#!/bin/bash

# Full Validation Test Runner
# This script runs the complete validation test in Docker

echo "🐳 Starting Docker validation test..."
echo "This will test bidirectional sync with sync.enabled=true"
echo ""

# Check if we need to use OAuth or PAT
if [ -z "$GITHUB_TOKEN" ]; then
    echo "⚠️  No GITHUB_TOKEN found. The test will need to authenticate inside the container."
    echo "You'll need to use the setup_github_auth tool when prompted."
    GITHUB_AUTH=""
else
    echo "✅ Using provided GITHUB_TOKEN"
    GITHUB_AUTH="-e GITHUB_TOKEN=$GITHUB_TOKEN"
fi

# Create a simple inline test script
cat > /tmp/docker-test.js << 'EOF'
// Inline test script for Docker
const readline = require('readline');
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

let phaseCount = 0;
const startTime = Date.now();

console.error('🧪 Docker Validation Test Started');

// Test phases
const phases = [
  { id: 1, name: 'Initialize', request: { jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} }, id: 1 }},
  { id: 2, name: 'Check Auth', request: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'check_github_auth', arguments: {} }, id: 2 }},
  { id: 3, name: 'Enable Sync', request: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'dollhouse_config', arguments: { action: 'set', setting: 'sync.enabled', value: true }}, id: 3 }},
  { id: 4, name: 'Verify Sync', request: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'dollhouse_config', arguments: { action: 'get', setting: 'sync.enabled' }}, id: 4 }},
  { id: 5, name: 'Install Persona', request: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'install_content', arguments: { path: 'library/personas/debug-detective.md' }}, id: 5 }},
  { id: 6, name: 'List Local', request: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'list_elements', arguments: { type: 'personas' }}, id: 6 }},
  { id: 7, name: 'Init Portfolio', request: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'init_portfolio', arguments: { repository_name: 'dollhouse-test-portfolio' }}, id: 7 }},
  { id: 8, name: 'Push to GitHub', request: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'sync_portfolio', arguments: { direction: 'push' }}, id: 8 }},
  { id: 9, name: 'Delete Local', request: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'delete_element', arguments: { name: 'debug-detective', type: 'personas', deleteData: true }}, id: 9 }},
  { id: 10, name: 'Pull from GitHub', request: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'sync_portfolio', arguments: { direction: 'pull' }}, id: 10 }},
  { id: 11, name: 'Verify Restored', request: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'get_element_details', arguments: { name: 'Debug Detective', type: 'personas' }}, id: 11 }},
  { id: 12, name: 'Final Check', request: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'list_elements', arguments: { type: 'personas' }}, id: 12 }}
];

let currentPhase = 0;
const results = [];

function sendNextPhase() {
  if (currentPhase < phases.length) {
    const phase = phases[currentPhase];
    console.error(`📤 Phase ${phase.id}: ${phase.name}`);
    console.log(JSON.stringify(phase.request));
    currentPhase++;
  } else {
    // All done
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.error('');
    console.error('═'.repeat(60));
    console.error('📊 Test Complete');
    console.error(`✅ Successful: ${results.filter(r => r.success).length}/${phases.length}`);
    console.error(`❌ Failed: ${results.filter(r => !r.success).length}/${phases.length}`);
    console.error(`⏱️  Total time: ${elapsed}s`);
    
    if (results.filter(r => !r.success).length === 0) {
      console.error('🎉 ALL TESTS PASSED! Bidirectional sync verified!');
      process.exit(0);
    } else {
      console.error('❌ Some tests failed:');
      results.filter(r => !r.success).forEach(r => {
        console.error(`  - ${r.phase}: ${r.error}`);
      });
      process.exit(1);
    }
  }
}

rl.on('line', (line) => {
  try {
    const response = JSON.parse(line);
    const phaseName = phases[phaseCount]?.name || 'Unknown';
    
    if (response.error) {
      console.error(`❌ ${phaseName}: ${response.error.message}`);
      results.push({ phase: phaseName, success: false, error: response.error.message });
    } else {
      console.error(`✅ ${phaseName}: Success`);
      results.push({ phase: phaseName, success: true });
    }
    
    phaseCount++;
    sendNextPhase();
  } catch (e) {
    console.error(`Parse error: ${e.message}`);
  }
});

// Start the test
sendNextPhase();
EOF

# Run the Docker container with the test
echo "🚀 Launching Docker container..."
echo ""

docker run --rm -it \
  --env-file docker/test-environment.env \
  $GITHUB_AUTH \
  -e TEST_GITHUB_USER=mickdarling \
  -e TEST_GITHUB_REPO=dollhouse-test-portfolio \
  claude-mcp-test-env:develop \
  sh -c "node /app/dist/index.js < <(node -e '$(cat /tmp/docker-test.js)')"

# Capture exit code
EXIT_CODE=$?

# Cleanup
rm -f /tmp/docker-test.js

if [ $EXIT_CODE -eq 0 ]; then
    echo ""
    echo "✅ Validation successful!"
else
    echo ""
    echo "❌ Validation failed with exit code: $EXIT_CODE"
fi

exit $EXIT_CODE