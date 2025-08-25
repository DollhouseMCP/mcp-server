#!/usr/bin/env node

/**
 * Minimal debugging test to isolate tool timeout root cause
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function debugToolTimeout() {
  console.log('Starting minimal tool timeout debug...');
  
  const transport = new StdioClientTransport({
    command: "./node_modules/.bin/tsx",
    args: ["src/index.ts"],
    cwd: process.cwd()
  });

  const client = new Client({
    name: "debug-client",
    version: "1.0.0"
  }, {
    capabilities: {}
  });

  try {
    console.log('Connecting...');
    await client.connect(transport);
    console.log('✅ Connected successfully');
    
    // Test the simplest possible tool call
    console.log('Testing get_user_identity...');
    const startTime = Date.now();
    
    const result = await Promise.race([
      client.callTool({ name: 'get_user_identity', arguments: {} }),
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

const startTime = Date.now();
debugToolTimeout().catch(console.error);