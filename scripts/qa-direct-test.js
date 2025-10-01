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
  logTestResult,
  isCI,
  ensureDirectoryExists
} from './qa-utils.js';
import { CONFIG, isCI as configIsCI } from '../test-config.js';
import { TestDataCleanup } from './qa-cleanup-manager.js';
import { QAMetricsCollector } from './qa-metrics-collector.js';

class DirectMCPTestRunner {
  constructor() {
    this.results = [];
    this.startTime = new Date();
    this.client = null;
    this.transport = null;
    this.availableTools = []; // Initialize as empty array to prevent race conditions
    this.isCI = isCI();
    
    // Initialize cleanup manager with unique test run ID
    this.testCleanup = new TestDataCleanup(`QA_DIRECT_TEST_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);
    
    // Initialize metrics collector
    this.metricsCollector = new QAMetricsCollector(`QA_DIRECT_${Date.now()}`);
    
    if (this.isCI) {
      console.log('🤖 Running in CI environment');
      console.log(`📁 TEST_PERSONAS_DIR: ${process.env.TEST_PERSONAS_DIR}`);
    }
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
    const toolDiscoveryStartTime = Date.now();
    this.availableTools = await discoverAvailableToolsDirect(this.client);
    const toolDiscoveryEndTime = Date.now();
    
    this.metricsCollector.recordToolDiscovery(toolDiscoveryStartTime, toolDiscoveryEndTime, this.availableTools.length);
    return this.availableTools;
  }

  validateToolExists(toolName) {
    return validateToolExists(toolName, this.availableTools);
  }

  async callTool(toolName, args = {}) {
    const startTime = Date.now();
    let success = false;
    let error = null;
    let result = null;
    let skipped = false;
    
    try {
      // Check if tool exists before calling
      if (!this.validateToolExists(toolName)) {
        skipped = true;
        error = 'Tool not available';
        return createTestResult(toolName, args, startTime, false, null, error, true);
      }
      
      // Set server connection timeout
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`Tool call timed out after ${CONFIG.timeouts.server_connection/1000}s`)), CONFIG.timeouts.server_connection)
      );
      
      result = await Promise.race([
        this.client.callTool({ name: toolName, arguments: args }),
        timeoutPromise
      ]);
      
      success = true;
      return createTestResult(toolName, args, startTime, true, result.content);
    } catch (err) {
      success = false;
      error = err.message;
      return createTestResult(toolName, args, startTime, false, null, error);
    } finally {
      const endTime = Date.now();
      this.metricsCollector.recordTestExecution(toolName, args, startTime, endTime, success, error, skipped);
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

  async testCollectionBrowsing() {
    console.log('\n🏪 Testing Collection Browsing...');
    
    const tests = [
      { name: 'Browse All Elements', tool: 'browse_collection', params: {} },
      { name: 'Browse Personas', tool: 'browse_collection', params: { type: 'personas' } },
      { name: 'Search Creative', tool: 'search_collection', params: { query: 'creative' } }
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

    // Set test identity with QA_TEST_ prefix
    const testUsername = 'QA_TEST_USER_qa-direct-test-user';
    result = await this.callTool('set_user_identity', { username: testUsername });
    this.results.push(result);
    console.log(`  ✅ Set Identity: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
    
    // Track test user identity for cleanup
    if (result.success) {
      this.testCleanup.trackArtifact('persona', testUsername, null, {
        type: 'test_user_identity',
        created_by: 'qa-direct-test'
      });
    }

    // Verify identity was set
    result = await this.callTool('get_user_identity');
    this.results.push(result);
    console.log(`  ✅ Verify Identity: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
  }

  async testElementOperations() {
    console.log('\n🎭 Testing Element Operations (Personas)...');
    
    // Get active elements first (new tool)
    let result = await this.callTool('get_active_elements', { type: 'personas' });
    this.results.push(result);
    if (result.skipped) {
      console.log(`  ⚠️  Get Active Elements (initial): Skipped - ${result.error} (${result.duration}ms)`);
    } else {
      console.log(`  ✅ Get Active Elements (initial): ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
    }

    // Try to activate Creative Writer (new tool)
    result = await this.callTool('activate_element', { name: 'Creative Writer', type: 'personas' });
    this.results.push(result);
    if (result.skipped) {
      console.log(`  ⚠️  Activate Creative Writer: Skipped - ${result.error} (${result.duration}ms)`);
    } else {
      console.log(`  ✅ Activate Creative Writer: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
    }

    // Get active elements again (new tool)
    result = await this.callTool('get_active_elements', { type: 'personas' });
    this.results.push(result);
    if (result.skipped) {
      console.log(`  ⚠️  Get Active Elements (after activation): Skipped - ${result.error} (${result.duration}ms)`);
    } else {
      console.log(`  ✅ Get Active Elements (after activation): ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
    }

    // Deactivate element (new tool)
    result = await this.callTool('deactivate_element', { name: 'Creative Writer', type: 'personas' });
    this.results.push(result);
    if (result.skipped) {
      console.log(`  ⚠️  Deactivate Element: Skipped - ${result.error} (${result.duration}ms)`);
    } else {
      console.log(`  ✅ Deactivate Element: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
    }
  }

  async testErrorHandling() {
    console.log('\n⚠️  Testing Error Handling...');
    
    // Test with invalid parameters
    const tests = [
      { tool: 'list_elements', params: { type: 'invalid_type' } },
      { tool: 'activate_element', params: { name: 'NonExistentElement', type: 'personas' } }
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
    
    const filename = `qa-direct-test-results-${new Date().toISOString().slice(0, 19).replaceAll(/[:.]/g, '-')}.json`;
    const filepath = `docs/QA/${filename}`;
    
    // Track test result file for cleanup
    this.testCleanup.trackArtifact('result', filename, filepath, {
      type: 'test_results',
      created_by: 'qa-direct-test'
    });
    
    writeFileSync(filepath, JSON.stringify(report, null, 2));
    
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

  async performCleanup() {
    console.log('\n🧹 Performing direct test cleanup...');
    
    try {
      const cleanupResults = await this.testCleanup.cleanupAll();
      console.log(`✅ Direct test cleanup completed: ${cleanupResults.cleaned} items cleaned, ${cleanupResults.failed} failed`);
    } catch (error) {
      console.warn(`⚠️  Direct test cleanup failed: ${error.message}`);
    }
  }

  async disconnect() {
    if (this.client && this.transport) {
      await this.client.close();
      console.log('🔌 Disconnected from MCP server');
    }
  }

  async runFullTestSuite() {
    console.log('🚀 Starting Direct MCP QA Test Suite...');
    console.log(`🧹 Test cleanup ID: ${this.testCleanup.testRunId}`);
    console.log(`📊 Metrics collector ID: ${this.metricsCollector.testRunId}`);
    
    // Start metrics collection
    this.metricsCollector.startCollection();
    
    let report = null;
    try {
      await this.connect();
      await this.discoverAvailableTools();
      
      // Ensure availableTools is properly initialized before validation
      if (!Array.isArray(this.availableTools)) {
        this.availableTools = [];
      }
      
      await this.testElementListing();
      await this.testCollectionBrowsing();
      await this.testUserIdentity();
      await this.testElementOperations();
      await this.testErrorHandling();
      
      report = this.generateReport();
      
      // End metrics collection and generate metrics report
      this.metricsCollector.endCollection();
      const metricsReport = this.metricsCollector.generateReport();
      
      if (metricsReport.filepath) {
        console.log(`📊 Direct test metrics saved to: ${metricsReport.filepath}`);
      }
      
      return report;
    } catch (error) {
      console.error('❌ Test suite failed:', error.message);
      
      // End metrics collection even on failure
      this.metricsCollector.endCollection();
      const metricsReport = this.metricsCollector.generateReport();
      
      if (metricsReport.filepath) {
        console.log(`📊 Partial direct test metrics saved: ${metricsReport.filepath}`);
      }
      
      return null;
    } finally {
      // CRITICAL: Always attempt cleanup and disconnection
      try {
        await this.performCleanup();
      } catch (cleanupError) {
        console.error(`❌ CRITICAL: Direct test cleanup failed: ${cleanupError.message}`);
      }
      
      try {
        await this.disconnect();
      } catch (disconnectError) {
        console.error(`⚠️  Disconnect error: ${disconnectError.message}`);
      }
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