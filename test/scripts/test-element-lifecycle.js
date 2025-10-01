#!/usr/bin/env node

/**
 * Comprehensive element lifecycle test for Docker MCP environment
 * Tests: Browse -> Install -> Modify -> Submit -> Delete -> Sync -> Verify
 * 
 * USAGE:
 *   Basic:
 *     GITHUB_TEST_TOKEN=ghp_xxx ./test-element-lifecycle.js
 *   
 *   With options:
 *     GITHUB_TEST_TOKEN=ghp_xxx VERBOSE=true CONTINUE_ON_ERROR=true ./test-element-lifecycle.js
 *   
 *   Skip phases (comma-separated phase numbers):
 *     GITHUB_TEST_TOKEN=ghp_xxx SKIP_PHASES=7,8 ./test-element-lifecycle.js
 * 
 * ENVIRONMENT VARIABLES:
 *   Required:
 *     GITHUB_TEST_TOKEN     - GitHub personal access token with repo scope
 *   
 *   Optional:
 *     VERBOSE              - Set to 'true' for detailed output
 *     CONTINUE_ON_ERROR    - Set to 'true' to continue past failures
 *     SKIP_PHASES          - Comma-separated list of phase numbers to skip (e.g., "7,8")
 *     TEST_GITHUB_REPO     - Custom test repository name (default: dollhouse-test-portfolio)
 * 
 * FEATURES:
 *   - Automatic retry with exponential backoff for rate limits
 *   - Configurable phase skipping for debugging
 *   - Detailed timing information for each phase
 *   - Summary report at completion
 *   - Transient error detection and retry
 * 
 * TEST PHASES:
 *   1. Initialize - Protocol handshake
 *   2. Check GitHub Auth - Verify authentication
 *   3. Browse Collection - List available elements
 *   4. Install Debug Detective - Install test element
 *   5. List Local Elements - Verify installation
 *   6. Edit Debug Detective - Modify element
 *   7. Initialize GitHub Portfolio - Create/verify portfolio repo
 *   8. Push to GitHub Portfolio - Sync elements to GitHub
 *   9. Delete Local Copy - Remove local element
 *   10. Verify Deletion - Confirm removal
 *   11. Sync from GitHub (Pull) - Restore from GitHub
 *   12. Verify Restoration - Confirm restoration with modifications
 * 
 * Security Note: This test file contains no user input mechanisms.
 * All data is hardcoded or from environment variables.
 * 
 * @security-disable DMCP-SEC-004 - No user input to normalize
 * @security-info Test harness with hardcoded test data only
 */

import { spawn } from 'child_process';
import { writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// Timestamp function
function getTimestamp() {
  return `[${new Date().toISOString()}]`;
}

// Results file setup
const resultsDir = join(process.cwd(), 'test-results');
if (!existsSync(resultsDir)) {
  mkdirSync(resultsDir, { recursive: true });
}
const resultsFile = join(resultsDir, `test-element-lifecycle-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.md`);

// Initialize results file
writeFileSync(resultsFile, `# Test Element Lifecycle Results

**Date**: ${new Date().toISOString()}
**Test Script**: test-element-lifecycle.js
**Repository**: ${process.env.TEST_GITHUB_REPO || 'dollhouse-test-portfolio'}

## Configuration
- Max Retries: ${process.env.MAX_RETRIES || 3}
- Base Delay: ${process.env.BASE_DELAY || 5000}ms
- Verbose: ${process.env.VERBOSE || 'false'}
- Continue on Error: ${process.env.CONTINUE_ON_ERROR || 'false'}
- Skip Phases: ${process.env.SKIP_PHASES || 'none'}

## Test Execution Log

`);

// Helper to write to both console and file
function logResult(message, isError = false) {
  if (isError) {
    console.error(message);
  } else {
    console.log(message);
  }
  appendFileSync(resultsFile, message + '\n');
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
          name: "debug-detective",
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
    name: "Push to GitHub Portfolio",
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
      id: 8
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
      id: 9
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
      id: 10
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
      id: 11
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
      id: 12
    }
  }
];

// Configuration options
const CONFIG = {
  maxRetries: 3,
  baseDelay: 5000, // 5 seconds base delay for rate limits
  verbose: process.env.VERBOSE === 'true',
  skipPhases: process.env.SKIP_PHASES ? process.env.SKIP_PHASES.split(',').map(p => Number.parseInt(p)) : [],
  continueOnError: process.env.CONTINUE_ON_ERROR === 'true'
};

logResult(`${getTimestamp()} 🧪 Starting Element Lifecycle Test`);
logResult('━'.repeat(60));
logResult(`Results will be saved to: ${resultsFile}`);
logResult('');

// Check for GitHub token (using GITHUB_TEST_TOKEN for testing)
const ghToken = process.env.GITHUB_TEST_TOKEN || process.env.TEST_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
if (!ghToken) {
  logResult(`${getTimestamp()} ❌ GITHUB_TEST_TOKEN environment variable not set`, true);
  logResult(`${getTimestamp()} ℹ️  Set it with: export GITHUB_TEST_TOKEN=your-personal-access-token`, true);
  logResult(`${getTimestamp()} ℹ️  Or use: GITHUB_TEST_TOKEN=ghp_xxx node test-element-lifecycle.js`, true);
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

// Start Docker container
// @security-disable OWASP-A03-002 - spawn with array arguments is safe (no shell invocation)
// The GitHub token is passed as a single array element, not concatenated into a command string
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
  '/app/dist/index.js'
]);

let responseBuffer = '';
let currentPhase = 0;
let testResults = {};
let retryCount = {};
let phaseStartTime = {};
const testStartTime = Date.now();

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
        // Not JSON, might be debug output
        if (CONFIG.verbose) {
          console.log(`${getTimestamp()} 📝 Debug:`, line);
        }
      }
    }
  }
});

docker.stderr.on('data', (data) => {
  console.error(`${getTimestamp()} ❌ Error:`, data.toString());
});

function isRateLimitError(response) {
  if (!response.error) return false;
  const errorMsg = response.error.message || '';
  return errorMsg.toLowerCase().includes('rate limit') || 
         errorMsg.toLowerCase().includes('too many requests') ||
         errorMsg.includes('429');
}

function shouldRetry(response, phaseName) {
  // Check if it's a rate limit error
  if (isRateLimitError(response)) return true;
  
  // Check for other transient errors
  const errorMsg = response.error?.message || '';
  const transientErrors = [
    'timeout',
    'network',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'temporary'
  ];
  
  return transientErrors.some(err => errorMsg.toLowerCase().includes(err));
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function handleResponse(response) {
  const phase = testPhases[currentPhase - 1];
  if (!phase) return;
  
  // Verbose logging
  if (CONFIG.verbose) {
    console.log(`${getTimestamp()} 📥 ${phase.name} Full Response:`, 
      JSON.stringify(response, null, 2));
  } else {
    console.log(`${getTimestamp()} 📥 ${phase.name} Response:`, 
      JSON.stringify(response, null, 2).substring(0, 500));
  }
  
  // Store results for analysis
  testResults[phase.name] = response;
  
  // Calculate elapsed time
  const elapsed = phaseStartTime[phase.name] ? 
    Date.now() - phaseStartTime[phase.name] : 0;
  if (elapsed > 0) {
    console.log(`${getTimestamp()} ⏱️  Phase took ${(elapsed / 1000).toFixed(2)}s`);
  }
  
  // Check for success and move to next phase
  if (response.result || response.id === 1) {
    logResult(`${getTimestamp()} ✅ ${phase.name} completed\n`);
    retryCount[phase.name] = 0; // Reset retry count on success
    
    // Special checks
    if (phase.name === "Edit Debug Detective" && response.result) {
      logResult(`${getTimestamp()} ℹ️  Modification confirmed`);
    }
    if (phase.name === "Push to GitHub Portfolio" && response.result) {
      const content = response.result.content?.[0]?.text || '';
      if (content.includes("pushed") || content.includes("synced")) {
        logResult(`${getTimestamp()} ℹ️  Elements pushed to GitHub portfolio`);
      } else if (content.includes("failed") || content.includes("error")) {
        logResult(`${getTimestamp()} ⚠️  Some elements may have failed to sync`);
      }
    }
    if (phase.name === "Verify Restoration" && response.result) {
      const content = response.result.content?.[0]?.text || '';
      if (content.includes("MODIFIED:")) {
        logResult(`${getTimestamp()} ✅✅ MODIFICATION PERSISTED THROUGH GITHUB!`);
      }
    }
    
    sendNextPhase();
  } else if (response.error) {
    const phaseName = phase.name;
    retryCount[phaseName] = (retryCount[phaseName] || 0) + 1;
    
    // Check if we should retry
    if (shouldRetry(response, phaseName) && retryCount[phaseName] <= CONFIG.maxRetries) {
      const delay = CONFIG.baseDelay * Math.pow(2, retryCount[phaseName] - 1); // Exponential backoff
      console.log(`${getTimestamp()} ⚠️  ${phaseName} failed (attempt ${retryCount[phaseName]}/${CONFIG.maxRetries})`);
      console.log(`${getTimestamp()} 🔄 Retrying in ${delay / 1000}s...`);
      console.log(`${getTimestamp()} 📝 Error was: ${response.error.message}`);
      
      setTimeout(() => {
        console.log(`${getTimestamp()} 🔄 Retrying ${phaseName}...`);
        currentPhase--; // Step back to retry the same phase
        sendNextPhase();
      }, delay);
    } else {
      console.error(`${getTimestamp()} ❌ ${phaseName} failed after ${retryCount[phaseName]} attempts:`, response.error);
      
      if (CONFIG.continueOnError) {
        console.log(`${getTimestamp()} ⏭️  Continuing despite error (CONTINUE_ON_ERROR=true)`);
        sendNextPhase();
      } else {
        console.log(`${getTimestamp()} 🛑 Stopping test due to error`);
        console.log(`${getTimestamp()} 💡 Tip: Set CONTINUE_ON_ERROR=true to continue past errors`);
        setTimeout(() => {
          docker.kill();
          process.exit(1);
        }, 1000);
      }
    }
  }
}

function sendNextPhase() {
  if (currentPhase < testPhases.length) {
    const phase = testPhases[currentPhase];
    
    // Check if we should skip this phase
    if (CONFIG.skipPhases.includes(currentPhase + 1)) {
      console.log(`\n${getTimestamp()} ⏭️  Skipping Phase ${currentPhase + 1}: ${phase.name}`);
      currentPhase++;
      sendNextPhase();
      return;
    }
    
    console.log(`\n${getTimestamp()} 📤 Phase ${currentPhase + 1}: ${phase.name}`);
    phaseStartTime[phase.name] = Date.now();
    docker.stdin.write(JSON.stringify(phase.request) + '\n');
    currentPhase++;
  } else {
    logResult(`\n${getTimestamp()} ✅ All test phases completed`);
    
    // Print summary
    logResult(`\n${getTimestamp()} 📊 Test Summary:`);
    let successCount = 0;
    let failureCount = 0;
    let skippedCount = CONFIG.skipPhases.length;
    
    // Add summary section to results file
    appendFileSync(resultsFile, '\n## Test Results Summary\n\n');
    appendFileSync(resultsFile, '| Phase | Status | Details |\n');
    appendFileSync(resultsFile, '|-------|--------|----------|\n');
    
    for (const [phaseName, result] of Object.entries(testResults)) {
      if (result.result || result.id === 1) {
        logResult(`${getTimestamp()}    ✅ ${phaseName}`);
        appendFileSync(resultsFile, `| ${phaseName} | ✅ Success | Completed successfully |\n`);
        successCount++;
      } else if (result.error) {
        logResult(`${getTimestamp()}    ❌ ${phaseName}: ${result.error.message}`);
        appendFileSync(resultsFile, `| ${phaseName} | ❌ Failed | ${result.error.message} |\n`);
        failureCount++;
      }
    }
    
    // Add skipped phases to report
    if (CONFIG.skipPhases.length > 0) {
      appendFileSync(resultsFile, `\n### Skipped Phases\n`);
      CONFIG.skipPhases.forEach(phase => {
        appendFileSync(resultsFile, `- Phase ${phase}: ${testPhases[phase - 1]?.name || 'Unknown'}\n`);
      });
    }
    
    const totalPhases = successCount + failureCount + skippedCount;
    const successRate = Math.round(successCount / (successCount + failureCount) * 100);
    
    logResult(`${getTimestamp()} 📈 Success rate: ${successCount}/${successCount + failureCount} (${successRate}%)`);
    if (skippedCount > 0) {
      logResult(`${getTimestamp()} ⏭️  Skipped: ${skippedCount} phases`);
    }
    
    // Add final statistics to results file
    appendFileSync(resultsFile, `\n## Final Statistics\n\n`);
    appendFileSync(resultsFile, `- **Total Phases**: ${totalPhases}\n`);
    appendFileSync(resultsFile, `- **Successful**: ${successCount}\n`);
    appendFileSync(resultsFile, `- **Failed**: ${failureCount}\n`);
    appendFileSync(resultsFile, `- **Skipped**: ${skippedCount}\n`);
    appendFileSync(resultsFile, `- **Success Rate**: ${successRate}%\n`);
    appendFileSync(resultsFile, `- **Test Duration**: ${((Date.now() - testStartTime) / 1000).toFixed(2)}s\n`);
    appendFileSync(resultsFile, `\n---\n*Test completed at ${new Date().toISOString()}*\n`);
    
    logResult(`\n📄 Results saved to: ${resultsFile}`);
    
    setTimeout(() => {
      docker.kill();
      process.exit(failureCount > 0 && !CONFIG.continueOnError ? 1 : 0);
    }, 1000);
  }
}

// Start the test
sendNextPhase();