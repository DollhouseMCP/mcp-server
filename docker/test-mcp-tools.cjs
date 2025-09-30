#!/usr/bin/env node

// Test script to verify Enhanced Index MCP tools
// This simulates what Claude would do when calling these tools

// FIX (SonarCloud S7772): Use node: prefix for built-in modules
const http = require('node:http');

// MCP request helper
function sendMCPRequest(method, params) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      jsonrpc: "2.0",
      method: method,
      params: params,
      id: Date.now()
    });

    const options = {
      hostname: 'localhost',
      port: 3333,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          // FIX (SonarCloud S2486): Handle parse error by returning raw data
          // This is intentional - if JSON parsing fails, return the raw response
          console.error('Failed to parse JSON response:', e.message);
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function testEnhancedIndex() {
  console.log("Testing Enhanced Index MCP Tools");
  console.log("=================================\n");

  // Note: MCP server expects stdio communication, not HTTP
  // We need to interact with it differently
  console.log("NOTE: MCP server runs on stdio, not HTTP.");
  console.log("To properly test, we need to communicate via stdio.\n");

  // Instead, let's check if the index was built
  // FIX (SonarCloud S7772): Use node: prefix for built-in modules
  const { exec } = require('node:child_process');
  const util = require('node:util');
  const execPromise = util.promisify(exec);

  try {
    console.log("1. Checking Enhanced Index status...");
    const { stdout: indexCheck } = await execPromise(
      'docker exec dollhouse-test cat /home/testuser/.dollhouse/portfolio/.index/enhanced-capability-index.yaml 2>/dev/null | head -20'
    );

    if (indexCheck) {
      console.log("✅ Enhanced Index file exists!");
      console.log("First 20 lines of index:");
      console.log(indexCheck);
    } else {
      console.log("❌ No Enhanced Index file found");
      console.log("The index may not have been built yet.\n");

      // Try to trigger index build
      console.log("2. Checking server logs for index activity...");
      // FIX (SonarCloud S7780): Use String.raw to avoid escaping backslashes
      const { stdout: logs } = await execPromise(
        String.raw`docker logs dollhouse-test 2>&1 | grep -i "index\|enhanced" | tail -10`
      );
      console.log("Recent index-related logs:");
      console.log(logs || "No index logs found");
    }

    console.log("\n3. Checking loaded elements...");
    const { stdout: elements } = await execPromise(
      'docker exec dollhouse-test find /home/testuser/.dollhouse/portfolio -name "*.md" -type f'
    );
    console.log("Found elements:");
    console.log(elements);

    console.log("\n4. Verifying MCP tools are registered...");
    // Since we can't directly query MCP tools via HTTP, check server logs
    // FIX (SonarCloud S7780): Use String.raw to avoid escaping backslashes
    const { stdout: toolLogs } = await execPromise(
      String.raw`docker logs dollhouse-test 2>&1 | grep -i "tool.*registered\|enhanced.*tool" | head -5`
    );

    if (toolLogs) {
      console.log("Tool registration logs:");
      console.log(toolLogs);
    } else {
      console.log("No tool registration logs found (tools may be registered silently)");
    }

  } catch (error) {
    console.error("Error during testing:", error.message);
  }
}

// Run the test
testEnhancedIndex().then(() => {
  console.log("\nTest complete!");
  console.log("\nTo properly test MCP tools with Claude:");
  console.log("1. The MCP server needs to be connected via stdio (not HTTP)");
  console.log("2. Claude Desktop or Claude CLI would connect to this server");
  console.log("3. The Enhanced Index tools would then be available:");
  console.log("   - find_similar_elements");
  console.log("   - search_by_verb");
  console.log("   - get_element_relationships");
  console.log("   - get_relationship_stats");
}).catch(console.error);