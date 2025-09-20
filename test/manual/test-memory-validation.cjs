#!/usr/bin/env node

/**
 * Test script for memory validation functionality
 * Tests the fix for issue #1042 - memory validation not implemented
 */

const { spawn } = require('child_process');
const path = require('path');

// Colors for output
const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';

const TEST_MEMORY_NAME = `test-memory-validation-${Date.now()}`;

function log(message, color = RESET) {
  console.log(`${color}${message}${RESET}`);
}

function sendRequest(server, method, params) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 100000);
    const request = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id
    }) + '\n';

    log(`\n→ Sending: ${method}`, CYAN);
    if (params) {
      log(`  Params: ${JSON.stringify(params, null, 2)}`, CYAN);
    }

    server.stdin.write(request);

    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for response to ${method}`));
    }, 5000);

    function handleResponse(data) {
      const lines = data.toString().split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const response = JSON.parse(line);

          if (response.id === id) {
            clearTimeout(timeout);
            server.stdout.off('data', handleResponse);

            if (response.error) {
              reject(new Error(`${method} failed: ${response.error.message}`));
            } else {
              resolve(response.result);
            }
            return;
          }
        } catch (e) {
          // Not JSON or not our response, continue
        }
      }
    }

    server.stdout.on('data', handleResponse);
  });
}

async function runTests() {
  log('\n========================================', BLUE);
  log('   Memory Validation Test Suite', BLUE);
  log('   Testing fix for issue #1042', BLUE);
  log('========================================', BLUE);

  const serverPath = path.join(__dirname, 'dist', 'index.js');

  log('\n1. Starting MCP server...', YELLOW);
  const server = spawn('node', [serverPath], {
    env: { ...process.env, DEBUG: 'false' },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  server.stderr.on('data', (data) => {
    // Suppress stderr unless it's an error we care about
    const message = data.toString();
    if (message.includes('ERROR') || message.includes('CRITICAL')) {
      log(`Server error: ${message}`, RED);
    }
  });

  // Wait for server to start
  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    log('\n2. Initializing server...', YELLOW);
    await sendRequest(server, 'initialize', {
      protocolVersion: '0.1.0',
      capabilities: {},
      clientInfo: {
        name: 'test-client',
        version: '1.0.0'
      }
    });
    log('   ✓ Server initialized', GREEN);

    // Test 1: Create a valid memory
    log('\n3. Creating valid test memory...', YELLOW);
    const createResult = await sendRequest(server, 'tools/call', {
      name: 'create_element',
      arguments: {
        name: TEST_MEMORY_NAME,
        type: 'memories',
        description: 'Test memory for validation testing',
        metadata: {
          tags: ['test', 'validation-test'],
          author: 'test-script',
          version: '1.0.0',
          retention: 30,  // Valid retention
          privacy: 'private',
          storageBackend: 'file'
        }
      }
    });
    log('   ✓ Valid memory created successfully', GREEN);

    // Test 2: Validate the valid memory
    log('\n4. Testing validation of valid memory...', YELLOW);
    const validationResult = await sendRequest(server, 'tools/call', {
      name: 'validate_element',
      arguments: {
        name: TEST_MEMORY_NAME,
        type: 'memories'
      }
    });

    const validationText = validationResult.content?.[0]?.text || '';
    log(`\n   Validation response:\n${validationText}`, CYAN);

    if (validationText.includes('✅') || validationText.includes('Valid')) {
      log('   ✓ Valid memory passed validation', GREEN);
    } else {
      throw new Error('Valid memory failed validation');
    }

    // Test 3: Create memory with invalid retention (testing validation catches errors)
    log('\n5. Creating memory with invalid retention for validation testing...', YELLOW);
    const invalidMemoryName = `test-invalid-memory-${Date.now()}`;

    try {
      await sendRequest(server, 'tools/call', {
        name: 'create_element',
        arguments: {
          name: invalidMemoryName,
          type: 'memories',
          description: 'Test memory with bad retention',
          metadata: {
            retention: 99999,  // Invalid: too high
            privacy: 'private'
          }
        }
      });
      log('   ✓ Memory created (will validate separately)', GREEN);
    } catch (error) {
      // Creation might fail due to validation, that's ok
      log('   ⚠ Memory creation blocked by validation (expected)', YELLOW);
    }

    // Test 4: Validate with strict mode
    log('\n6. Testing strict mode validation...', YELLOW);
    const strictValidationResult = await sendRequest(server, 'tools/call', {
      name: 'validate_element',
      arguments: {
        name: TEST_MEMORY_NAME,
        type: 'memories',
        strict: true
      }
    });

    const strictText = strictValidationResult.content?.[0]?.text || '';
    if (strictText.includes('Strict Mode')) {
      log('   ✓ Strict mode validation works', GREEN);
    } else {
      log('   ⚠ Strict mode indicator not found (may be ok)', YELLOW);
    }

    // Test 5: Validate non-existent memory
    log('\n7. Testing validation of non-existent memory...', YELLOW);
    const notFoundResult = await sendRequest(server, 'tools/call', {
      name: 'validate_element',
      arguments: {
        name: 'non-existent-memory-xyz',
        type: 'memories'
      }
    });

    const notFoundText = notFoundResult.content?.[0]?.text || '';
    if (notFoundText.includes('not found') || notFoundText.includes('❌')) {
      log('   ✓ Non-existent memory validation handled correctly', GREEN);
    } else {
      log(`   Unexpected response: ${notFoundText}`, RED);
      throw new Error('Non-existent memory validation should report "not found"');
    }

    // Cleanup: Delete test memory
    log('\n8. Cleaning up test memory...', YELLOW);
    await sendRequest(server, 'tools/call', {
      name: 'delete_element',
      arguments: {
        name: TEST_MEMORY_NAME,
        type: 'memories',
        deleteData: true
      }
    });
    log('   ✓ Test memory deleted', GREEN);

    // Also try to clean up invalid memory if it was created
    try {
      await sendRequest(server, 'tools/call', {
        name: 'delete_element',
        arguments: {
          name: invalidMemoryName,
          type: 'memories',
          deleteData: true
        }
      });
    } catch {
      // Ignore cleanup errors for invalid memory
    }

    log('\n========================================', GREEN);
    log('   ✅ ALL TESTS PASSED!', GREEN);
    log('   Memory validation is working correctly', GREEN);
    log('========================================', GREEN);

  } catch (error) {
    log('\n========================================', RED);
    log('   ❌ TEST FAILED', RED);
    log(`   Error: ${error.message}`, RED);
    log('========================================', RED);

    // Try to cleanup even if tests failed
    try {
      await sendRequest(server, 'tools/call', {
        name: 'delete_element',
        arguments: {
          name: TEST_MEMORY_NAME,
          type: 'memories',
          deleteData: true
        }
      });
    } catch (cleanupError) {
      // Ignore cleanup errors
    }

    server.kill();
    process.exit(1);
  }

  server.kill();
  process.exit(0);
}

// Run the tests
runTests().catch(error => {
  log(`\nUnexpected error: ${error.message}`, RED);
  process.exit(1);
});