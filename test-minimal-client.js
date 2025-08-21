#!/usr/bin/env node

/**
 * Test client for the minimal MCP server
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function testMinimalServer() {
  console.log('Testing minimal MCP server...');
  
  const transport = new StdioClientTransport({
    command: "node",
    args: ["minimal-mcp-test.js"],
    cwd: process.cwd()
  });

  const client = new Client({
    name: "minimal-test-client",
    version: "1.0.0"
  }, {
    capabilities: {}
  });

  try {
    console.log('Connecting to minimal server...');
    await client.connect(transport);
    console.log('✅ Connected to minimal server');
    
    console.log('Calling test tool...');
    const startTime = Date.now();
    
    const result = await Promise.race([
      client.callTool({ name: 'test_tool', arguments: {} }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout after 5s')), 5000)
      )
    ]);
    
    const duration = Date.now() - startTime;
    console.log(`✅ Tool call successful in ${duration}ms`);
    console.log('Result:', JSON.stringify(result, null, 2));
    
  } catch (error) {
    const duration = Date.now() - startTime;
    console.log(`❌ Tool call failed after ${duration}ms: ${error.message}`);
  } finally {
    try {
      await client.close();
    } catch (e) {
      // Ignore close errors
    }
  }
}

const startTime = Date.now();
testMinimalServer().catch(console.error);