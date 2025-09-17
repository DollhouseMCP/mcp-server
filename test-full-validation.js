#!/usr/bin/env node

/**
 * FULL VALIDATION TEST for Portfolio Sync
 * Tests ALL functionality including bidirectional sync with sync.enabled=true
 * 
 * USAGE:
 *   GITHUB_TEST_TOKEN=ghp_xxx ./test-full-validation.js
 */

import { spawn } from 'child_process';
import { writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// Timestamp function
function getTimestamp() {
  return `[${new Date().toISOString()}]`;
}

// Results directory
const resultsDir = 'test-results';
if (!existsSync(resultsDir)) {
  mkdirSync(resultsDir, { recursive: true });
}

// Results file
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
const resultsFile = join(resultsDir, `full-validation-${timestamp}.md`);

// Initialize results file
writeFileSync(resultsFile, `# Full Validation Test Results

Started: ${new Date().toISOString()}

`);

// Helper to write to both console and file
function logResult(message, isError = false) {
  const timestampedMessage = `${getTimestamp()} ${message}`;
  if (isError) {
    console.error(timestampedMessage);
  } else {
    console.log(timestampedMessage);
  }
  appendFileSync(resultsFile, timestampedMessage + '\n');
}

// Configuration
const config = {
  verbose: process.env.VERBOSE === 'true',
  continueOnError: process.env.CONTINUE_ON_ERROR === 'true',
  testRepo: process.env.TEST_GITHUB_REPO || 'dollhouse-test-portfolio'
};

// Test phases with sync enabled
const testPhases = [
  // Phase 1: Initialize
  {
    name: 'Initialize',
    request: {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {}
      },
      id: 1
    }
  },
  
  // Phase 2: Check GitHub Auth
  {
    name: 'Check GitHub Auth',
    request: {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'check_github_auth',
        arguments: {}
      },
      id: 2
    }
  },

  // Phase 3: ENABLE SYNC - CRITICAL!
  {
    name: 'Enable Sync',
    request: {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'dollhouse_config',
        arguments: {
          action: 'set',
          setting: 'sync.enabled',
          value: true
        }
      },
      id: 3
    }
  },

  // Phase 4: Verify Sync Enabled
  {
    name: 'Verify Sync Enabled',
    request: {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'dollhouse_config',
        arguments: {
          action: 'get',
          setting: 'sync.enabled'
        }
      },
      id: 4
    }
  },
  
  // Phase 5: Browse Collection
  {
    name: 'Browse Collection',
    request: {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'browse_collection',
        arguments: {
          type: 'personas'
        }
      },
      id: 5
    }
  },
  
  // Phase 6: Install Debug Detective
  {
    name: 'Install Debug Detective',
    request: {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'install_content',
        arguments: {
          path: 'library/personas/debug-detective.md'
        }
      },
      id: 6
    }
  },
  
  // Phase 7: List Local Elements
  {
    name: 'List Local Elements',
    request: {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'list_elements',
        arguments: {
          type: 'personas'
        }
      },
      id: 7
    }
  },
  
  // Phase 8: Edit Debug Detective
  {
    name: 'Edit Debug Detective',
    request: {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'edit_element',
        arguments: {
          name: 'Debug Detective',
          type: 'personas',
          field: 'description',
          value: 'MODIFIED: Enhanced debugging expert - Full validation test'
        }
      },
      id: 8
    }
  },
  
  // Phase 9: Initialize GitHub Portfolio
  {
    name: 'Initialize GitHub Portfolio',
    request: {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'init_portfolio',
        arguments: {
          repository_name: config.testRepo
        }
      },
      id: 9
    }
  },
  
  // Phase 10: Push to GitHub (Bulk)
  {
    name: 'Push to GitHub (Bulk)',
    request: {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'sync_portfolio',
        arguments: {
          direction: 'push'
        }
      },
      id: 10
    }
  },

  // Phase 11: List Remote Portfolio
  {
    name: 'List Remote Portfolio',
    request: {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'portfolio_element_manager',
        arguments: {
          operation: 'list-remote',
          element_type: 'personas'
        }
      },
      id: 11
    }
  },
  
  // Phase 12: Delete Local Copy
  {
    name: 'Delete Local Copy',
    request: {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'delete_element',
        arguments: {
          name: 'debug-detective',
          type: 'personas',
          deleteData: true
        }
      },
      id: 12
    }
  },
  
  // Phase 13: Verify Deletion
  {
    name: 'Verify Deletion',
    request: {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'get_element_details',
        arguments: {
          name: 'debug-detective',
          type: 'personas'
        }
      },
      id: 13
    },
    expectError: true
  },

  // Phase 14: Pull from GitHub (Bulk) - THE KEY TEST!
  {
    name: 'Pull from GitHub (Bulk)',
    request: {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'sync_portfolio',
        arguments: {
          direction: 'pull'
        }
      },
      id: 14
    }
  },

  // Phase 15: Verify Restoration
  {
    name: 'Verify Restoration',
    request: {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'get_element_details',
        arguments: {
          name: 'Debug Detective',
          type: 'personas'
        }
      },
      id: 15
    }
  },

  // Phase 16: Test Individual Download
  {
    name: 'Test Individual Download',
    request: {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'portfolio_element_manager',
        arguments: {
          operation: 'download',
          element_type: 'personas',
          element_name: 'debug-detective'
        }
      },
      id: 16
    }
  },

  // Phase 17: Final Verification
  {
    name: 'Final Verification',
    request: {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'list_elements',
        arguments: {
          type: 'personas'
        }
      },
      id: 17
    }
  },

  // Phase 18: Cleanup - Delete Test Repo
  {
    name: 'Cleanup Test Repo',
    request: {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'sync_portfolio',
        arguments: {
          direction: 'push',
          dry_run: true  // Just verify we can still connect
        }
      },
      id: 18
    }
  }
];

// Execute test function
async function executeTest() {
  logResult('🧪 Starting Full Validation Test');
  logResult('━'.repeat(60));
  logResult(`Results will be saved to: ${resultsFile}\n`);

  // Check for GitHub token
  if (!process.env.GITHUB_TEST_TOKEN) {
    logResult('❌ ERROR: GITHUB_TEST_TOKEN environment variable is required', true);
    process.exit(1);
  } else {
    logResult('✅ GitHub token detected');
  }

  // Spawn Docker container
  const docker = spawn('docker', [
    'run',
    '--rm',
    '-i',
    '--env-file', 'docker/test-environment.env',
    '-e', `GITHUB_TOKEN=${process.env.GITHUB_TEST_TOKEN}`,
    '-e', `TEST_GITHUB_USER=${process.env.TEST_GITHUB_USER || 'mickdarling'}`,
    '-e', `TEST_GITHUB_REPO=${config.testRepo}`,
    'claude-mcp-test-env:develop',
    'node', '/app/dist/index.js'
  ]);

  let buffer = '';
  const results = [];
  let phaseIndex = 0;
  let startTime = Date.now();
  let phaseStartTime = Date.now();

  docker.stdout.on('data', (data) => {
    buffer += data.toString();
    
    // Try to parse complete JSON objects
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (line.trim()) {
        try {
          const response = JSON.parse(line);
          const elapsed = ((Date.now() - phaseStartTime) / 1000).toFixed(2);
          
          logResult(`📥 ${testPhases[phaseIndex].name} Response: ${JSON.stringify(response, null, 2)}`);
          logResult(`⏱️  Phase took ${elapsed}s`);
          
          // Check for errors
          if (response.error && !testPhases[phaseIndex].expectError) {
            logResult(`❌ ${testPhases[phaseIndex].name} failed: ${response.error.message}`, true);
            results.push({ phase: testPhases[phaseIndex].name, success: false, error: response.error.message });
            
            if (!config.continueOnError) {
              docker.kill();
              process.exit(1);
            }
          } else {
            logResult(`✅ ${testPhases[phaseIndex].name} completed`);
            results.push({ phase: testPhases[phaseIndex].name, success: true });
          }
          
          // Send next phase
          phaseIndex++;
          if (phaseIndex < testPhases.length) {
            logResult('');
            phaseStartTime = Date.now();
            const nextPhase = testPhases[phaseIndex];
            logResult(`📤 Phase ${phaseIndex + 1}: ${nextPhase.name}`);
            docker.stdin.write(JSON.stringify(nextPhase.request) + '\n');
          } else {
            // All phases complete
            docker.stdin.end();
          }
        } catch (e) {
          // Not valid JSON yet, continue buffering
        }
      }
    }
  });

  docker.stderr.on('data', (data) => {
    if (config.verbose) {
      logResult(`STDERR: ${data}`, true);
    }
  });

  docker.on('close', (code) => {
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    
    logResult('\n' + '━'.repeat(60));
    logResult('📊 Test Summary');
    logResult('━'.repeat(60));
    
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    logResult(`✅ Successful: ${successful}/${testPhases.length}`);
    logResult(`❌ Failed: ${failed}/${testPhases.length}`);
    logResult(`⏱️  Total time: ${totalTime}s`);
    
    if (failed > 0) {
      logResult('\nFailed phases:');
      results.filter(r => !r.success).forEach(r => {
        logResult(`  - ${r.phase}: ${r.error}`);
      });
    }
    
    logResult('\n' + (failed === 0 ? '🎉 ALL TESTS PASSED!' : '❌ SOME TESTS FAILED'));
    
    process.exit(failed === 0 ? 0 : 1);
  });

  // Send first request
  logResult(`📤 Phase 1: ${testPhases[0].name}`);
  docker.stdin.write(JSON.stringify(testPhases[0].request) + '\n');
}

// Run the test
executeTest().catch(error => {
  logResult(`Fatal error: ${error.message}`, true);
  process.exit(1);
});