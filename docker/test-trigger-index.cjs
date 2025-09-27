#!/usr/bin/env node

// Test script to trigger Enhanced Index creation via MCP tool call
const { spawn } = require('child_process');

async function triggerIndexCreation() {
  console.log("Triggering Enhanced Index Creation");
  console.log("===================================\n");

  // First, restart the container to ensure clean state
  console.log("1. Starting fresh container...");
  const { exec } = require('child_process');
  const util = require('util');
  const execPromise = util.promisify(exec);

  try {
    // Stop any existing container
    await execPromise('docker stop dollhouse-test 2>/dev/null').catch(() => {});

    // Start fresh container
    await execPromise('docker run -d --rm --name dollhouse-test -p 3333:3000 dollhouse-enhanced-test:latest');

    // Wait for startup
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log("✅ Container started\n");

    // Check initial state
    console.log("2. Checking initial state (should be no index)...");
    const { stdout: initialCheck } = await execPromise(
      'docker exec dollhouse-test ls -la /home/testuser/.dollhouse/portfolio/.index 2>/dev/null || echo "No .index directory"'
    );
    console.log(initialCheck);

    console.log("\n3. Sending MCP tool request to trigger index...");

    // Create an MCP request to list_elements (simple tool that should trigger index)
    const mcpRequest = JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "list_elements",
        arguments: {
          type: "personas"
        }
      },
      id: 1
    }) + '\n';

    // Send request via stdin to the container
    const dockerExec = spawn('docker', ['exec', '-i', 'dollhouse-test', 'node', '/app/dist/index.js']);

    let output = '';
    let error = '';

    dockerExec.stdout.on('data', (data) => {
      output += data.toString();
    });

    dockerExec.stderr.on('data', (data) => {
      error += data.toString();
    });

    // Send the MCP request
    dockerExec.stdin.write(mcpRequest);
    dockerExec.stdin.end();

    // Wait for response
    await new Promise((resolve) => {
      dockerExec.on('close', resolve);
      setTimeout(resolve, 5000); // Timeout after 5 seconds
    });

    console.log("MCP Response:", output.substring(0, 500) || "No response");
    if (error) console.log("Errors:", error.substring(0, 200));

    console.log("\n4. Checking if Enhanced Index was created...");
    const { stdout: indexCheck } = await execPromise(
      'docker exec dollhouse-test ls -la /home/testuser/.dollhouse/portfolio/.index 2>/dev/null || echo "No .index directory"'
    );
    console.log("Index directory contents:");
    console.log(indexCheck);

    // Check for the actual index file
    const { stdout: fileCheck } = await execPromise(
      'docker exec dollhouse-test cat /home/testuser/.dollhouse/portfolio/.index/enhanced-capability-index.yaml 2>/dev/null | head -20 || echo "No index file found"'
    );

    if (fileCheck.includes("No index file found")) {
      console.log("❌ Enhanced Index file not created");

      // Check logs for any index-related activity
      console.log("\n5. Checking server logs for index activity...");
      const { stdout: logs } = await execPromise(
        'docker logs dollhouse-test 2>&1 | grep -i "index\\|enhanced" | tail -10'
      );
      console.log("Recent index logs:");
      console.log(logs);
    } else {
      console.log("✅ Enhanced Index file created!");
      console.log("\nFirst 20 lines of index:");
      console.log(fileCheck);
    }

    // Try another approach - call a tool that definitely uses the index
    console.log("\n6. Trying find_similar_elements tool (Enhanced Index specific)...");
    const enhancedRequest = JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "find_similar_elements",
        arguments: {
          reference_text: "creative writing",
          element_type: "personas",
          limit: 5
        }
      },
      id: 2
    }) + '\n';

    const dockerExec2 = spawn('docker', ['exec', '-i', 'dollhouse-test', 'node', '/app/dist/index.js']);

    let output2 = '';
    dockerExec2.stdout.on('data', (data) => {
      output2 += data.toString();
    });

    dockerExec2.stdin.write(enhancedRequest);
    dockerExec2.stdin.end();

    await new Promise((resolve) => {
      dockerExec2.on('close', resolve);
      setTimeout(resolve, 5000);
    });

    console.log("Enhanced tool response:", output2.substring(0, 500) || "No response");

    // Final check
    console.log("\n7. Final check for Enhanced Index...");
    const { stdout: finalCheck } = await execPromise(
      'docker exec dollhouse-test ls -la /home/testuser/.dollhouse/portfolio/.index 2>/dev/null || echo "Still no .index directory"'
    );
    console.log(finalCheck);

  } catch (error) {
    console.error("Error:", error.message);
  } finally {
    // Clean up
    console.log("\n8. Cleaning up...");
    await execPromise('docker stop dollhouse-test 2>/dev/null').catch(() => {});
  }
}

triggerIndexCreation().then(() => {
  console.log("\nTest complete!");
}).catch(console.error);