#!/usr/bin/env node

/**
 * Test client for the minimal isolated MCP server
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function testMinimalServer() {
  console.log('Testing ultra-minimal MCP server...');
  
  const transport = new StdioClientTransport({
    command: "node",
    args: ["test-mcp-sdk-isolated.js"],
    cwd: process.cwd()
  });

  const client = new Client({
    name: "minimal-test-client",
    version: "1.0.0"
  }, {
    capabilities: {}
  });

  let startTime = Date.now();

  try {
    console.log('1. Connecting to minimal server...');
    await client.connect(transport);
    console.log(`✅ Connected successfully in ${Date.now() - startTime}ms`);
    
    console.log('2. Testing tool list...');
    startTime = Date.now();
    const tools = await client.listTools();
    console.log(`✅ Tool list successful in ${Date.now() - startTime}ms:`, tools.tools.map(t => t.name));
    
    console.log('3. Testing instant tool call...');
    startTime = Date.now();
    
    const result = await Promise.race([
      client.callTool({ name: 'instant_test', arguments: {} }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout after 5s')), 5000)
      )
    ]);
    
    const duration = Date.now() - startTime;
    console.log(`✅ Tool call successful in ${duration}ms`);
    console.log('Result:', result);
    
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

testMinimalServer().catch(console.error);