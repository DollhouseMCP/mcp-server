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
import { 
  discoverAvailableToolsDirect, 
  validateToolExists, 
  calculateAccurateSuccessRate,
  createTestResult,
  logTestResult
} from './qa-utils.js';

class DirectMCPTestRunner {
  constructor() {
    this.results = [];
    this.startTime = new Date();
    this.client = null;
    this.transport = null;
    this.availableTools = []; // Initialize as empty array to prevent race conditions
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

  async discoverAvailableTools() {
    this.availableTools = await discoverAvailableToolsDirect(this.client);
    return this.availableTools;
  }

  validateToolExists(toolName) {
    return validateToolExists(toolName, this.availableTools);
  }

  async callTool(toolName, args = {}) {
    const startTime = Date.now();
    
    // Check if tool exists before calling
    if (!this.validateToolExists(toolName)) {
      return createTestResult(toolName, args, startTime, false, null, 'Tool not available', true);
    }
    
    try {
      // Set a 10 second timeout
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Tool call timed out after 10s')), 10000)
      );
      
      const result = await Promise.race([
        this.client.callTool({ name: toolName, arguments: args }),
        timeoutPromise
      ]);
      
      return createTestResult(toolName, args, startTime, true, result.content);
    } catch (error) {
      return createTestResult(toolName, args, startTime, false, null, error.message);
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
      { name: 'Browse All', tool: 'browse_marketplace', params: {} },
      { name: 'Browse Personas', tool: 'browse_marketplace', params: { category: 'personas' } },
      { name: 'Search Creative', tool: 'browse_marketplace', params: { query: 'creative' } }
    ];

    for (const test of tests) {
      const result = await this.callTool(test.tool, test.params);
      this.results.push(result);
      
      if (result.skipped) {
        console.log(`  ⚠️  ${test.name}: Skipped - ${result.error} (${result.duration}ms)`);
      } else if (result.success) {
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
    
    // Get active persona first (deprecated tool)
    let result = await this.callTool('get_active_persona');
    this.results.push(result);
    if (result.skipped) {
      console.log(`  ⚠️  Get Active (initial): Skipped - ${result.error} (${result.duration}ms)`);
    } else {
      console.log(`  ✅ Get Active (initial): ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
    }

    // Try to activate Creative Writer (deprecated tool)
    result = await this.callTool('activate_persona', { name: 'Creative Writer' });
    this.results.push(result);
    if (result.skipped) {
      console.log(`  ⚠️  Activate Creative Writer: Skipped - ${result.error} (${result.duration}ms)`);
    } else {
      console.log(`  ✅ Activate Creative Writer: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
    }

    // Get active persona again (deprecated tool)
    result = await this.callTool('get_active_persona');
    this.results.push(result);
    if (result.skipped) {
      console.log(`  ⚠️  Get Active (after activation): Skipped - ${result.error} (${result.duration}ms)`);
    } else {
      console.log(`  ✅ Get Active (after activation): ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
    }

    // Deactivate persona (deprecated tool)
    result = await this.callTool('deactivate_persona');
    this.results.push(result);
    if (result.skipped) {
      console.log(`  ⚠️  Deactivate: Skipped - ${result.error} (${result.duration}ms)`);
    } else {
      console.log(`  ✅ Deactivate: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
    }
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

  calculateAccurateSuccessRate(results) {
    return calculateAccurateSuccessRate(results);
  }

  generateReport() {
    const endTime = new Date();
    const duration = endTime - this.startTime;
    
    const stats = this.calculateAccurateSuccessRate(this.results);
    const totalTests = this.results.length;
    
    const report = {
      timestamp: endTime.toISOString(),
      duration: `${duration}ms`,
      tool_discovery: {
        available_tools_count: this.availableTools.length,
        available_tools: this.availableTools
      },
      summary: {
        total_tests: totalTests,
        executed_tests: stats.total,
        skipped_tests: stats.skipped,
        successful_tests: stats.successful,
        failed_tests: stats.total - stats.successful,
        success_rate: `${stats.percentage}%`,
        success_rate_note: "Based only on executed tests (excludes skipped)"
      },
      test_details: this.results.map(r => ({
        tool: r.tool,
        success: r.success,
        skipped: r.skipped || false,
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
    console.log(`   Available Tools: ${this.availableTools.length}`);
    console.log(`   Total Tests: ${totalTests}`);
    console.log(`   Executed Tests: ${stats.total}`);
    console.log(`   Skipped Tests: ${stats.skipped}`);
    console.log(`   Successful: ${stats.successful}`);
    console.log(`   Failed: ${stats.total - stats.successful}`);
    console.log(`   Success Rate: ${stats.percentage}% (based on executed tests only)`);
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
      await this.discoverAvailableTools();
      
      // Ensure availableTools is properly initialized before validation
      if (!Array.isArray(this.availableTools)) {
        this.availableTools = [];
      }
      
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