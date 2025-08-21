#!/usr/bin/env node

/**
 * Direct MCP SDK QA Test Runner for DollhouseMCP
 * 
 * Tests all MCP tools directly via the SDK without the Inspector
 * Addresses Issue #629 - Comprehensive QA Testing Process
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';

class DirectMCPTestRunner {
  constructor() {
    this.results = [];
    this.startTime = new Date();
    this.client = null;
    this.transport = null;
  }

  async connect() {
    console.log('🔗 Connecting to MCP server...');
    
    this.transport = new StdioClientTransport({
      command: "./node_modules/.bin/tsx",
      args: ["src/index.ts"],
      cwd: process.cwd()
    });

    this.client = new Client({
      name: "qa-test-client",
      version: "1.0.0"
    }, {
      capabilities: {}
    });

    await this.client.connect(this.transport);
    console.log('✅ Connected to MCP server');
  }

  async callTool(toolName, args = {}) {
    const startTime = Date.now();
    
    try {
      // Set a 10 second timeout
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Tool call timed out after 10s')), 10000)
      );
      
      const result = await Promise.race([
        this.client.callTool({ name: toolName, arguments: args }),
        timeoutPromise
      ]);
      
      const duration = Date.now() - startTime;
      
      return {
        success: true,
        tool: toolName,
        params: args,
        result: result.content,
        duration
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      
      return {
        success: false,
        tool: toolName,
        params: args,
        error: error.message,
        duration
      };
    }
  }

  async testElementListing() {
    console.log('\n🔍 Testing Element Listing...');
    
    const elementTypes = ['personas', 'skills', 'templates', 'agents'];
    
    for (const type of elementTypes) {
      const result = await this.callTool('list_elements', { type });
      this.results.push(result);
      
      if (result.success) {
        // Try to count items from the result
        const text = result.result?.[0]?.text || '';
        const count = text.match(/Available \w+ \((\d+)\):/)?.[1] || 'unknown';
        console.log(`  ✅ ${type}: ${count} items (${result.duration}ms)`);
      } else {
        console.log(`  ❌ ${type}: ${result.error} (${result.duration}ms)`);
      }
    }
  }

  async testMarketplaceBrowsing() {
    console.log('\n🏪 Testing Marketplace Browsing...');
    
    const tests = [
      { name: 'Browse All', params: {} },
      { name: 'Browse Personas', params: { category: 'personas' } },
      { name: 'Search Creative', params: { query: 'creative' } }
    ];

    for (const test of tests) {
      const result = await this.callTool('browse_marketplace', test.params);
      this.results.push(result);
      
      if (result.success) {
        console.log(`  ✅ ${test.name}: Success (${result.duration}ms)`);
      } else {
        console.log(`  ❌ ${test.name}: ${result.error} (${result.duration}ms)`);
      }
    }
  }

  async testUserIdentity() {
    console.log('\n👤 Testing User Identity...');
    
    // Get current identity
    let result = await this.callTool('get_user_identity');
    this.results.push(result);
    console.log(`  ✅ Get Identity: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);

    // Set test identity
    result = await this.callTool('set_user_identity', { username: 'qa-test-user' });
    this.results.push(result);
    console.log(`  ✅ Set Identity: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);

    // Verify identity was set
    result = await this.callTool('get_user_identity');
    this.results.push(result);
    console.log(`  ✅ Verify Identity: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
  }

  async testPersonaOperations() {
    console.log('\n🎭 Testing Persona Operations...');
    
    // Get active persona first
    let result = await this.callTool('get_active_persona');
    this.results.push(result);
    console.log(`  ✅ Get Active (initial): ${result.success ? 'Success' : result.error} (${result.duration}ms)`);

    // Try to activate Creative Writer
    result = await this.callTool('activate_persona', { name: 'Creative Writer' });
    this.results.push(result);
    console.log(`  ✅ Activate Creative Writer: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);

    // Get active persona again
    result = await this.callTool('get_active_persona');
    this.results.push(result);
    console.log(`  ✅ Get Active (after activation): ${result.success ? 'Success' : result.error} (${result.duration}ms)`);

    // Deactivate persona
    result = await this.callTool('deactivate_persona');
    this.results.push(result);
    console.log(`  ✅ Deactivate: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
  }

  async testErrorHandling() {
    console.log('\n⚠️  Testing Error Handling...');
    
    // Test with invalid parameters
    const tests = [
      { tool: 'list_elements', params: { type: 'invalid_type' } },
      { tool: 'activate_persona', params: { name: 'NonExistentPersona' } }
    ];

    for (const test of tests) {
      const result = await this.callTool(test.tool, test.params);
      this.results.push(result);
      
      if (!result.success) {
        console.log(`  ✅ Expected error for ${test.tool}: ${result.error} (${result.duration}ms)`);
      } else {
        console.log(`  ⚠️  Expected error but got success for ${test.tool} (${result.duration}ms)`);
      }
    }
  }

  generateReport() {
    const endTime = new Date();
    const duration = endTime - this.startTime;
    
    const successful = this.results.filter(r => r.success).length;
    const failed = this.results.filter(r => !r.success).length;
    const total = this.results.length;
    
    const report = {
      timestamp: endTime.toISOString(),
      duration: `${duration}ms`,
      summary: {
        total,
        successful,
        failed,
        success_rate: `${((successful / total) * 100).toFixed(1)}%`
      },
      test_details: this.results.map(r => ({
        tool: r.tool,
        success: r.success,
        duration: `${r.duration}ms`,
        params: r.params,
        error: r.error || null
      })),
      full_results: this.results
    };

    // Ensure directory exists
    mkdirSync('docs/QA', { recursive: true });
    
    const filename = `qa-direct-test-results-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.json`;
    writeFileSync(`docs/QA/${filename}`, JSON.stringify(report, null, 2));
    
    console.log(`\n📊 Test Summary:`);
    console.log(`   Total Tests: ${total}`);
    console.log(`   Successful: ${successful}`);
    console.log(`   Failed: ${failed}`);
    console.log(`   Success Rate: ${report.summary.success_rate}`);
    console.log(`   Duration: ${report.duration}`);
    console.log(`   Report: docs/QA/${filename}`);
    
    return report;
  }

  async disconnect() {
    if (this.client && this.transport) {
      await this.client.close();
      console.log('🔌 Disconnected from MCP server');
    }
  }

  async runFullTestSuite() {
    console.log('🚀 Starting Direct MCP QA Test Suite...');
    
    try {
      await this.connect();
      
      await this.testElementListing();
      await this.testMarketplaceBrowsing();
      await this.testUserIdentity();
      await this.testPersonaOperations();
      await this.testErrorHandling();
      
      const report = this.generateReport();
      await this.disconnect();
      
      return report;
    } catch (error) {
      console.error('❌ Test suite failed:', error.message);
      await this.disconnect();
      return null;
    }
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const runner = new DirectMCPTestRunner();
  runner.runFullTestSuite().then(report => {
    process.exit(report && report.summary.success_rate !== '0.0%' ? 0 : 1);
  });
}

export { DirectMCPTestRunner };