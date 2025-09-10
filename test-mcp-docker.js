#!/usr/bin/env node

/**
 * Test script for MCP server in Docker
 * Tests the renamed tools and new safety features
 */

import { spawn } from 'child_process';

// Test messages to send to MCP server
const testMessages = [
  // 1. Initialize connection
  {
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: "0.1.0",
      capabilities: {},
      clientInfo: {
        name: "test-client",
        version: "1.0.0"
      }
    },
    id: 1
  },
  
  // 2. List available tools (should see renamed tools)
  {
    jsonrpc: "2.0",
    method: "tools/list",
    params: {},
    id: 2
  },
  
  // 3. Test install_collection_content (renamed from install_content)
  {
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      name: "install_collection_content",
      arguments: {
        path: "library/personas/creative-writer.md"
      }
    },
    id: 3
  },
  
  // 4. Test sync_portfolio with new safety parameters
  {
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      name: "sync_portfolio",
      arguments: {
        direction: "push",
        mode: "additive",
        dry_run: true,
        confirm_deletions: true
      }
    },
    id: 4
  },
  
  // 5. Test portfolio_element_manager (new tool)
  {
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      name: "portfolio_element_manager",
      arguments: {
        operation: "list"
      }
    },
    id: 5
  }
];

console.log('🧪 Testing MCP Server in Docker Container');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Run Docker container with MCP server
const docker = spawn('docker', [
  'run',
  '--rm',
  '-i',
  'claude-mcp-test-env:latest',
  'node',
  '/app/dollhousemcp/dist/index.js'
]);

let responseBuffer = '';
let testIndex = 0;
let initComplete = false;

docker.stdout.on('data', (data) => {
  responseBuffer += data.toString();
  
  // Try to parse complete JSON-RPC messages
  const lines = responseBuffer.split('\n');
  responseBuffer = lines.pop() || ''; // Keep incomplete line in buffer
  
  for (const line of lines) {
    if (line.trim()) {
      try {
        const response = JSON.parse(line);
        handleResponse(response);
      } catch (e) {
        // Not valid JSON, might be partial message
        responseBuffer = line + '\n' + responseBuffer;
      }
    }
  }
});

docker.stderr.on('data', (data) => {
  console.error('❌ Server Error:', data.toString());
});

docker.on('close', (code) => {
  console.log(`\n✅ Test completed with code: ${code}`);
  process.exit(code);
});

function handleResponse(response) {
  console.log(`📥 Response ${response.id}:`, JSON.stringify(response, null, 2).substring(0, 500));
  
  if (response.id === 1 && response.result) {
    console.log('✅ Server initialized successfully\n');
    initComplete = true;
    sendNextTest();
  } else if (response.id === 2 && response.result) {
    // Check for renamed tools
    const tools = response.result.tools || [];
    const hasNewTools = tools.some(t => 
      t.name === 'install_collection_content' || 
      t.name === 'submit_collection_content' ||
      t.name === 'portfolio_element_manager'
    );
    const hasOldTools = tools.some(t => 
      t.name === 'install_content' || 
      t.name === 'submit_content'
    );
    
    console.log(`✅ Found ${tools.length} tools`);
    console.log(`✅ New tool names present: ${hasNewTools}`);
    console.log(`✅ Old tool names removed: ${!hasOldTools}\n`);
    
    sendNextTest();
  } else if (response.result || response.error) {
    sendNextTest();
  }
}

function sendNextTest() {
  if (testIndex < testMessages.length) {
    const message = testMessages[testIndex];
    console.log(`\n📤 Test ${testIndex + 1}: ${message.method} ${message.params?.name || ''}`);
    docker.stdin.write(JSON.stringify(message) + '\n');
    testIndex++;
  } else {
    console.log('\n✅ All tests sent. Closing connection...');
    setTimeout(() => {
      docker.kill();
    }, 1000);
  }
}

// Start by sending initialization
console.log('📤 Sending initialization...');
docker.stdin.write(JSON.stringify(testMessages[0]) + '\n');
testIndex = 1;

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n⚠️ Test interrupted');
  docker.kill();
  process.exit(1);
});