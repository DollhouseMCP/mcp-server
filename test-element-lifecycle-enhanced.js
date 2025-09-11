#!/usr/bin/env node

/**
 * ENHANCED Element Lifecycle Test for Docker MCP Environment
 * Tests: Browse -> Install -> Modify -> INDIVIDUAL & BULK Upload/Download -> Verify
 * 
 * FEATURES:
 * - Tests both individual element operations AND bulk sync operations
 * - Includes fallback mechanisms when bulk operations fail
 * - Uses portfolio_element_manager for individual file operations
 * - Lists remote files to verify what exists on GitHub
 * - Comprehensive file existence verification
 * 
 * USAGE:
 *   GITHUB_TEST_TOKEN=ghp_xxx ./test-element-lifecycle-enhanced.js
 *   GITHUB_TEST_TOKEN=ghp_xxx VERBOSE=true CONTINUE_ON_ERROR=true ./test-element-lifecycle-enhanced.js
 * 
 * NEW TEST PHASES:
 *   1-6: Same as original (Initialize, Auth, Browse, Install, List, Edit)
 *   7: Initialize GitHub Portfolio
 *   8: List Remote Portfolio (what's on GitHub)
 *   9: Individual Upload Test (primary test of individual operations)
 *   10: List Remote Portfolio (verify upload worked)
 *   11: Bulk Push Test (test bulk operations)
 *   12: Delete Local Copy
 *   13: Verify Deletion
 *   14: Individual Download Test (primary test of individual download)
 *   15: Verify Individual Download Success
 *   16: Delete Local Copy Again
 *   17: Bulk Pull Test (with fallback to individual if fails)
 *   18: Final Verification (persona lookup test)
 */

import { spawn } from 'child_process';
import { writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// Timestamp function
function getTimestamp() {
  return `[${new Date().toISOString()}]`;
}

// Create results directory
const resultsDir = 'test-results';
if (!existsSync(resultsDir)) {
  mkdirSync(resultsDir, { recursive: true });
}

// Results file
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
const resultsFile = join(resultsDir, `test-element-lifecycle-enhanced-${timestamp}.md`);

// Initialize results file
writeFileSync(resultsFile, `# Enhanced Element Lifecycle Test Results\n\nStarted: ${new Date().toISOString()}\n\n`);

function logResult(message, isError = false) {
  if (isError) {
    console.error(message);
  } else {
    console.log(message);
  }
  appendFileSync(resultsFile, message + '\n');
}

// Enhanced test phases with individual element operations
const testPhases = [
  {
    name: "Initialize",
    request: {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "0.1.0",
        capabilities: {},
        clientInfo: { name: "enhanced-lifecycle-test", version: "1.0.0" }
      },
      id: 1
    }
  },
  {
    name: "Check GitHub Auth",
    request: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "check_github_auth",
        arguments: {}
      },
      id: 2
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
      id: 3
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
      id: 4
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
      id: 5
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
          name: "Debug Detective",
          type: "personas",
          field: "description",
          value: "MODIFIED: Enhanced debugging expert with integration test modifications"
        }
      },
      id: 6
    }
  },
  {
    name: "Initialize GitHub Portfolio",
    request: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "init_portfolio",
        arguments: {
          repository_name: "dollhouse-test-portfolio",
          private: false,
          description: "Test portfolio for DollhouseMCP integration testing"
        }
      },
      id: 7
    }
  },
  {
    name: "List Remote Portfolio (Before Upload)",
    request: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "portfolio_element_manager",
        arguments: {
          operation: "list-remote"
        }
      },
      id: 8
    }
  },
  {
    name: "Individual Upload Test",
    request: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "portfolio_element_manager",
        arguments: {
          operation: "upload",
          element_name: "debug-detective",
          element_type: "personas"
        }
      },
      id: 9
    }
  },
  {
    name: "List Remote Portfolio (After Upload)",
    request: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "portfolio_element_manager",
        arguments: {
          operation: "list-remote"
        }
      },
      id: 10
    }
  },
  {
    name: "Bulk Push Test",
    request: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "sync_portfolio",
        arguments: {
          direction: "push",
          dryRun: false
        }
      },
      id: 11
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
      id: 12
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
      id: 13
    }
  },
  {
    name: "Individual Download Test",
    request: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "portfolio_element_manager",
        arguments: {
          operation: "download",
          element_name: "debug-detective",
          element_type: "personas"
        }
      },
      id: 14
    }
  },
  {
    name: "Verify Individual Download Success",
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
      id: 15
    }
  },
  {
    name: "Delete Local Copy Again",
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
      id: 16
    }
  },
  {
    name: "Bulk Pull Test (with Fallback)",
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
      id: 17,
      fallback: {
        name: "portfolio_element_manager",
        arguments: {
          operation: "download",
          element_name: "debug-detective", 
          element_type: "personas"
        }
      }
    }
  },
  {
    name: "Final Verification (Persona Lookup Test)",
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
      id: 18
    }
  }
];

// Configuration options
const CONFIG = {
  maxRetries: 3,
  baseDelay: 5000,
  verbose: process.env.VERBOSE === 'true',
  skipPhases: process.env.SKIP_PHASES ? process.env.SKIP_PHASES.split(',').map(p => parseInt(p)) : [],
  continueOnError: process.env.CONTINUE_ON_ERROR === 'true'
};

logResult(`${getTimestamp()} 🧪 Starting Enhanced Element Lifecycle Test`);
logResult('━'.repeat(60));
logResult(`Results will be saved to: ${resultsFile}`);
logResult('');

// Check for GitHub token
const ghToken = process.env.GITHUB_TEST_TOKEN || process.env.TEST_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
if (!ghToken) {
  logResult(`${getTimestamp()} ❌ GITHUB_TEST_TOKEN environment variable not set`, true);
  logResult(`${getTimestamp()} ℹ️  Set it with: export GITHUB_TEST_TOKEN=your-personal-access-token`, true);
  logResult(`${getTimestamp()} ℹ️  Or use: GITHUB_TEST_TOKEN=ghp_xxx node test-element-lifecycle-enhanced.js`, true);
  process.exit(1);
}

logResult(`${getTimestamp()} ✅ GitHub token detected`);

// Configuration display
if (CONFIG.verbose) {
  logResult(`${getTimestamp()} 📋 Configuration:`);
  logResult(`${getTimestamp()}    Max retries: ${CONFIG.maxRetries}`);
  logResult(`${getTimestamp()}    Base delay: ${CONFIG.baseDelay}ms`);
  logResult(`${getTimestamp()}    Skip phases: ${CONFIG.skipPhases.length ? CONFIG.skipPhases.join(', ') : 'none'}`);
  logResult(`${getTimestamp()}    Continue on error: ${CONFIG.continueOnError}`);
}

// Start Docker container with fix branch image
const docker = spawn('docker', [
  'run',
  '--rm',
  '-i',
  '--env-file', 'docker/test-environment.env',
  '-e', `GITHUB_TOKEN=${ghToken}`,
  '-e', `TEST_GITHUB_USER=mickdarling`,
  '-e', `TEST_GITHUB_REPO=dollhouse-test-portfolio`,
  'claude-mcp-test-env:fix-branch',
  'node',
  '/app/dist/index.js'
]);

let responseBuffer = '';
let currentPhase = 0;
let testResults = {};
let startTime = Date.now();

// Handle Docker output
docker.stdout.on('data', (data) => {
  const chunk = data.toString();
  if (CONFIG.verbose) {
    process.stderr.write(chunk);
  }
  responseBuffer += chunk;
  
  // Process complete JSON responses
  let lines = responseBuffer.split('\n');
  responseBuffer = lines.pop() || ''; // Keep incomplete line
  
  for (const line of lines) {
    if (line.trim()) {
      try {
        const response = JSON.parse(line);
        if (response.id && testPhases[currentPhase]) {
          handlePhaseResponse(response);
        }
      } catch (e) {
        // Not a JSON response, continue
      }
    }
  }
});

docker.stderr.on('data', (data) => {
  if (CONFIG.verbose) {
    process.stderr.write(`❌ Error: ${data}`);
  }
});

docker.on('close', (code) => {
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  logResult(`${getTimestamp()} 📊 Test completed in ${duration}s (exit code: ${code})`);
  
  // Summary
  const phases = Object.keys(testResults);
  const passed = phases.filter(p => testResults[p].success).length;
  const failed = phases.length - passed;
  
  logResult('');
  logResult('📊 Test Summary:');
  for (const phase of phases) {
    const result = testResults[phase];
    const icon = result.success ? '✅' : '❌';
    const error = result.error ? `: ${result.error}` : '';
    logResult(`${getTimestamp()}    ${icon} ${phase}${error}`);
  }
  logResult(`${getTimestamp()} 📈 Success rate: ${passed}/${phases.length} (${Math.round(passed/phases.length*100)}%)`);
  
  logResult('');
  logResult(`📄 Results saved to: ${resultsFile}`);
});

// Handle phase responses with fallback mechanism
async function handlePhaseResponse(response) {
  const phase = testPhases[currentPhase];
  if (!phase) return;
  
  const phaseStartTime = Date.now();
  const duration = ((phaseStartTime - startTime) / 1000).toFixed(2);
  
  logResult(`${getTimestamp()} 📥 ${phase.name} Response: ${JSON.stringify(response, null, 2)}`);
  logResult(`${getTimestamp()} ⏱️  Phase took ${duration}s`);
  
  // Check if phase failed and has fallback
  if (response.error && phase.fallback) {
    logResult(`${getTimestamp()} 🔄 Primary operation failed, trying fallback...`);
    
    // Send fallback request
    const fallbackRequest = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: phase.fallback,
      id: response.id + 100 // Different ID for fallback
    };
    
    docker.stdin.write(JSON.stringify(fallbackRequest) + '\n');
    testResults[phase.name] = { success: false, error: `Primary failed, fallback attempted: ${response.error?.message || 'Unknown error'}` };
  } else {
    // Record result
    const success = !response.error;
    testResults[phase.name] = { 
      success, 
      error: response.error?.message,
      duration: duration
    };
    
    if (success) {
      logResult(`${getTimestamp()} ✅ ${phase.name} completed`);
    } else {
      logResult(`${getTimestamp()} ❌ ${phase.name} failed: ${response.error?.message}`);
      if (!CONFIG.continueOnError) {
        logResult(`${getTimestamp()} 🛑 Stopping test due to error`);
        logResult(`${getTimestamp()} 💡 Tip: Set CONTINUE_ON_ERROR=true to continue past errors`);
        docker.kill();
        return;
      } else {
        logResult(`${getTimestamp()} ⏭️  Continuing despite error (CONTINUE_ON_ERROR=true)`);
      }
    }
  }
  
  logResult('');
  
  // Move to next phase
  currentPhase++;
  if (currentPhase < testPhases.length && !CONFIG.skipPhases.includes(currentPhase + 1)) {
    // Send next request
    setTimeout(() => {
      const nextPhase = testPhases[currentPhase];
      logResult(`${getTimestamp()} 📤 Phase ${currentPhase + 1}: ${nextPhase.name}`);
      docker.stdin.write(JSON.stringify(nextPhase.request) + '\n');
    }, 100);
  } else {
    // All phases complete
    logResult(`${getTimestamp()} ✅ All test phases completed`);
    docker.stdin.end();
  }
}

// Start first phase
setTimeout(() => {
  const firstPhase = testPhases[0];
  logResult(`${getTimestamp()} 📤 Phase 1: ${firstPhase.name}`);
  docker.stdin.write(JSON.stringify(firstPhase.request) + '\n');
}, 1000);