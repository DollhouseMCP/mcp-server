#!/usr/bin/env node

/**
 * Simple MCP Test for SONNET-1 QA Testing
 * Attempts direct tool testing without authentication complexity
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, mkdirSync } from 'fs';
import { CONFIG, isCI } from '../test-config.js';
import { ensureDirectoryExists } from './qa-utils.js';

class SimpleMCPTest {
  constructor() {
    this.results = [];
    this.startTime = new Date();
  }

  async testDirectConnection() {
    console.log('🔧 Testing Direct MCP Connection...');
    
    try {
      // Create a simple transport with minimal options
      const transport = new StdioClientTransport({
        command: "node",
        args: ["-e", "const { DollhouseMCPServer } = require('./dist/index.js'); new DollhouseMCPServer().run();"],
        cwd: process.cwd()
      });

      const client = new Client({
        name: "simple-test-client",
        version: "1.0.0"
      }, {
        capabilities: {}
      });

      console.log('Attempting connection...');
      await client.connect(transport);
      console.log('✅ Connected successfully');

      // Test a simple tool call with tool call timeout
      const result = await Promise.race([
        client.callTool({ name: 'get_user_identity', arguments: {} }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${CONFIG.timeouts.tool_call/1000}s`)), CONFIG.timeouts.tool_call))
      ]);

      console.log('✅ Tool call successful:', result.content?.[0]?.text?.substring(0, 100) || 'No text content');
      
      await client.close();
      return { success: true, result };
      
    } catch (error) {
      console.log('❌ Connection failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  async testToolsAvailability() {
    console.log('🛠️  Testing Tool Availability...');
    
    try {
      const transport = new StdioClientTransport({
        command: "./node_modules/.bin/tsx",
        args: ["src/index.ts"],
        cwd: process.cwd()
      });

      const client = new Client({
        name: "tools-test-client",
        version: "1.0.0"
      }, {
        capabilities: {}
      });

      await client.connect(transport);
      
      // Get list of available tools
      const result = await Promise.race([
        client.listTools(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${CONFIG.timeouts.benchmark_timeout/1000}s`)), CONFIG.timeouts.benchmark_timeout))
      ]);

      console.log('✅ Tools available:', result.tools?.length || 0);
      
      // Log first few tool names
      if (result.tools) {
        result.tools.slice(0, 5).forEach(tool => {
          console.log(`  - ${tool.name}: ${tool.description?.substring(0, 50)}...`);
        });
      }

      await client.close();
      return { success: true, toolCount: result.tools?.length || 0, tools: result.tools };
      
    } catch (error) {
      console.log('❌ Tools test failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  async runTests() {
    console.log('🚀 Starting Simple MCP Tests...');
    
    const connectionTest = await this.testDirectConnection();
    this.results.push({ test: 'connection', ...connectionTest });
    
    const toolsTest = await this.testToolsAvailability();
    this.results.push({ test: 'tools_availability', ...toolsTest });
    
    this.generateReport();
    return this.results;
  }

  generateReport() {
    const endTime = new Date();
    const duration = endTime - this.startTime;
    
    const report = {
      timestamp: endTime.toISOString(),
      duration: `${duration}ms`,
      environment: {
        ci: isCI(),
        test_personas_dir: process.env.TEST_PERSONAS_DIR,
        github_token_available: !!process.env.GITHUB_TEST_TOKEN
      },
      tests: this.results
    };

    // Ensure output directory exists using CI-aware utility
    ensureDirectoryExists('docs/QA');
    
    const filename = `simple-test-results-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.json`;
    
    try {
      writeFileSync(`docs/QA/${filename}`, JSON.stringify(report, null, 2));
      
      console.log(`\n📊 Simple Test Summary:`);
      console.log(`   Environment: ${isCI() ? 'CI' : 'Local'}`);
      console.log(`   Duration: ${report.duration}`);
      console.log(`   Report: docs/QA/${filename}`);
    } catch (error) {
      console.error(`❌ Failed to write report: ${error.message}`);
      console.log(`\n📊 Simple Test Summary (report save failed):`);
      console.log(`   Environment: ${isCI() ? 'CI' : 'Local'}`);
      console.log(`   Duration: ${report.duration}`);
    }
    
    return report;
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const tester = new SimpleMCPTest();
  tester.runTests().then(() => process.exit(0));
}

export { SimpleMCPTest };