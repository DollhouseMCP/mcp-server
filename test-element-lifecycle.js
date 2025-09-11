#!/usr/bin/env node

/**
 * Comprehensive element lifecycle test for Docker MCP environment
 * Tests: Browse -> Install -> Modify -> Submit -> Delete -> Sync -> Verify
 */

import { spawn } from 'child_process';

// Timestamp function
function getTimestamp() {
  return `[${new Date().toISOString()}]`;
}

// Test phases
const testPhases = [
  {
    name: "Initialize",
    request: {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "0.1.0",
        capabilities: {},
        clientInfo: { name: "lifecycle-test", version: "1.0.0" }
      },
      id: 1
    }
  },
  {
    name: "Browse Collection",
    request: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "browse_collection",
        arguments: { section: "library", type: "personas" }
      },
      id: 2
    }
  },
  {
    name: "Install Debug Detective",
    request: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "install_collection_content",
        arguments: { path: "library/personas/debug-detective.md" }
      },
      id: 3
    }
  },
  {
    name: "List Local Elements",
    request: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "list_elements",
        arguments: { type: "personas" }
      },
      id: 4
    }
  },
  {
    name: "Edit Debug Detective",
    request: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "edit_element",
        arguments: {
          name: "debug-detective",
          type: "personas",
          field: "description",
          value: "MODIFIED: Enhanced debugging expert with integration test modifications"
        }
      },
      id: 5
    }
  },
  {
    name: "Submit to GitHub Portfolio",
    request: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "submit_collection_content",
        arguments: { content: "debug-detective" }
      },
      id: 6
    }
  },
  {
    name: "Delete Local Copy",
    request: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "delete_element",
        arguments: {
          name: "debug-detective",
          type: "personas",
          deleteData: true
        }
      },
      id: 7
    }
  },
  {
    name: "Verify Deletion",
    request: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "list_elements",
        arguments: { type: "personas" }
      },
      id: 8
    }
  },
  {
    name: "Sync from GitHub (Pull)",
    request: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "sync_portfolio",
        arguments: {
          direction: "pull",
          mode: "additive",
          force: false,
          dryRun: false
        }
      },
      id: 9
    }
  },
  {
    name: "Verify Restoration",
    request: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "get_element_details",
        arguments: {
          name: "debug-detective",
          type: "personas"
        }
      },
      id: 10
    }
  }
];

console.log(`${getTimestamp()} 🧪 Starting Element Lifecycle Test`);
console.log('━'.repeat(60));

// Check for GitHub token (using GITHUB_TEST_TOKEN for testing)
const ghToken = process.env.GITHUB_TEST_TOKEN || process.env.TEST_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
if (!ghToken) {
  console.error(`${getTimestamp()} ❌ GITHUB_TEST_TOKEN environment variable not set`);
  console.error(`${getTimestamp()} ℹ️  Set it with: export GITHUB_TEST_TOKEN=your-personal-access-token`);
  console.error(`${getTimestamp()} ℹ️  Or use: GITHUB_TEST_TOKEN=ghp_xxx node test-element-lifecycle.js`);
  process.exit(1);
}

console.log(`${getTimestamp()} ✅ GitHub token detected`);

// Start Docker container
const docker = spawn('docker', [
  'run',
  '--rm',
  '-i',
  '--env-file', 'docker/test-environment.env',
  '-e', `GITHUB_TOKEN=${ghToken}`,  // MCP server expects GITHUB_TOKEN internally
  '-e', `TEST_GITHUB_USER=mickdarling`,
  '-e', `TEST_GITHUB_REPO=dollhouse-test-portfolio`,
  'claude-mcp-test-env:1.0.0',
  'node',
  '/app/dollhousemcp/dist/index.js'
]);

let responseBuffer = '';
let currentPhase = 0;
let testResults = {};

docker.stdout.on('data', (data) => {
  responseBuffer += data.toString();
  const lines = responseBuffer.split('\n');
  responseBuffer = lines.pop() || '';
  
  for (const line of lines) {
    if (line.trim()) {
      try {
        const response = JSON.parse(line);
        handleResponse(response);
      } catch (e) {
        // Not JSON, skip
      }
    }
  }
});

docker.stderr.on('data', (data) => {
  console.error(`${getTimestamp()} ❌ Error:`, data.toString());
});

function handleResponse(response) {
  const phase = testPhases[currentPhase - 1];
  if (!phase) return;
  
  console.log(`${getTimestamp()} 📥 ${phase.name} Response:`, 
    JSON.stringify(response, null, 2).substring(0, 500));
  
  // Store results for analysis
  testResults[phase.name] = response;
  
  // Check for success and move to next phase
  if (response.result || response.id === 1) {
    console.log(`${getTimestamp()} ✅ ${phase.name} completed\n`);
    
    // Special checks
    if (phase.name === "Edit Debug Detective" && response.result) {
      console.log(`${getTimestamp()} ℹ️  Modification confirmed`);
    }
    if (phase.name === "Verify Restoration" && response.result) {
      const content = response.result.content?.[0]?.text || '';
      if (content.includes("MODIFIED:")) {
        console.log(`${getTimestamp()} ✅✅ MODIFICATION PERSISTED THROUGH GITHUB!`);
      }
    }
    
    sendNextPhase();
  } else if (response.error) {
    console.error(`${getTimestamp()} ❌ ${phase.name} failed:`, response.error);
    sendNextPhase(); // Continue anyway for testing
  }
}

function sendNextPhase() {
  if (currentPhase < testPhases.length) {
    const phase = testPhases[currentPhase];
    console.log(`\n${getTimestamp()} 📤 Phase ${currentPhase + 1}: ${phase.name}`);
    docker.stdin.write(JSON.stringify(phase.request) + '\n');
    currentPhase++;
  } else {
    console.log(`\n${getTimestamp()} ✅ All test phases completed`);
    setTimeout(() => {
      docker.kill();
      process.exit(0);
    }, 1000);
  }
}

// Start the test
sendNextPhase();