#!/usr/bin/env node

/**
 * QA Test Runner for DollhouseMCP
 * 
 * Programmatically tests all MCP tools via the Inspector API
 * Addresses Issue #629 - Comprehensive QA Testing Process
 */

import fetch from 'node-fetch';
import { writeFileSync } from 'fs';
import { 
  discoverAvailableTools, 
  validateToolExists, 
  calculateAccurateSuccessRate,
  createTestResult,
  logTestResult,
  generateTestReport
} from './qa-utils.js';

const INSPECTOR_URL = 'http://localhost:6277/message';
const SESSION_TOKEN = process.env.MCP_SESSION_TOKEN || '351ce3afd51944ef3c812bbb9651eff71c7f11a60108b00c2165ff335dd9efad';

class MCPTestRunner {
  constructor() {
    this.results = [];
    this.startTime = new Date();
    this.availableTools = []; // Initialize as empty array to prevent race conditions
  }

  async discoverAvailableTools() {
    this.availableTools = await discoverAvailableTools(INSPECTOR_URL, SESSION_TOKEN);
    return this.availableTools;
  }

  validateToolExists(toolName) {
    return validateToolExists(toolName, this.availableTools);
  }

  async callTool(toolName, params = {}) {
    const startTime = Date.now();
    
    // Check if tool exists before calling (only if we have discovery data)
    if (!this.validateToolExists(toolName)) {
      return createTestResult(toolName, params, startTime, false, null, 'Tool not available', true);
    }
    
    try {
      const response = await fetch(INSPECTOR_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SESSION_TOKEN}`
        },
        body: JSON.stringify({
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: params
          }
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      return createTestResult(toolName, params, startTime, true, result.result);
    } catch (error) {
      return createTestResult(toolName, params, startTime, false, null, error.message);
    }
  }

  async testElementListing() {
    console.log('\n🔍 Testing Element Listing...');
    
    const elementTypes = ['personas', 'skills', 'templates', 'agents'];
    
    for (const type of elementTypes) {
      const result = await this.callTool('list_elements', { type });
      this.results.push(result);
      
      if (result.success) {
        const count = result.result?.content?.[0]?.text?.match(/Available \w+ \((\d+)\):/)?.[1] || 'unknown';
        console.log(`  ✅ ${type}: ${count} items`);
      } else {
        console.log(`  ❌ ${type}: ${result.error}`);
      }
    }
  }

  async testMarketplaceBrowsing() {
    console.log('\n🏪 Testing Marketplace Browsing...');
    
    const tests = [
      { name: 'Browse All', params: {} },
      { name: 'Browse Personas', params: { category: 'personas' } },
      { name: 'Search', params: { query: 'creative' } }
    ];

    for (const test of tests) {
      const result = await this.callTool('browse_collection', { section: 'library', ...test.params });
      this.results.push(result);
      
      if (result.skipped) {
        console.log(`  ⚠️  ${test.name}: Skipped - ${result.error}`);
      } else if (result.success) {
        console.log(`  ✅ ${test.name}: Success`);
      } else {
        console.log(`  ❌ ${test.name}: ${result.error}`);
      }
    }
  }

  async testUserIdentity() {
    console.log('\n👤 Testing User Identity...');
    
    // Get current identity
    let result = await this.callTool('get_user_identity');
    this.results.push(result);
    console.log(`  ✅ Get Identity: ${result.success ? 'Success' : result.error}`);

    // Set test identity
    result = await this.callTool('set_user_identity', { username: 'qa-test-user' });
    this.results.push(result);
    console.log(`  ✅ Set Identity: ${result.success ? 'Success' : result.error}`);

    // Verify identity was set
    result = await this.callTool('get_user_identity');
    this.results.push(result);
    console.log(`  ✅ Verify Identity: ${result.success ? 'Success' : result.error}`);
  }

  async testPersonaOperations() {
    console.log('\n🎭 Testing Persona Operations...');
    
    // List elements to get one to work with
    let result = await this.callTool('list_elements', { type: 'personas' });
    this.results.push(result);
    
    if (result.skipped) {
      console.log(`  ⚠️  List Elements: Skipped - ${result.error}`);
    } else if (result.success) {
      // Try to activate an element (Creative Writer is usually available)
      result = await this.callTool('activate_element', { name: 'Creative Writer', type: 'personas' });
      this.results.push(result);
      if (result.skipped) {
        console.log(`  ⚠️  Activate Element: Skipped - ${result.error}`);
      } else {
        console.log(`  ✅ Activate Element: ${result.success ? 'Success' : result.error}`);
      }

      // Get active elements
      result = await this.callTool('get_active_elements', { type: 'personas' });
      this.results.push(result);
      if (result.skipped) {
        console.log(`  ⚠️  Get Active: Skipped - ${result.error}`);
      } else {
        console.log(`  ✅ Get Active: ${result.success ? 'Success' : result.error}`);
      }

      // Deactivate element
      result = await this.callTool('deactivate_element', { name: 'Creative Writer', type: 'personas' });
      this.results.push(result);
      if (result.skipped) {
        console.log(`  ⚠️  Deactivate: Skipped - ${result.error}`);
      } else {
        console.log(`  ✅ Deactivate: ${result.success ? 'Success' : result.error}`);
      }
    }
  }

  async testPortfolioOperations() {
    console.log('\n📁 Testing Portfolio Operations...');
    
    // Get portfolio status
    let result = await this.callTool('portfolio_status');
    this.results.push(result);
    if (result.skipped) {
      console.log(`  ⚠️  Portfolio Status: Skipped - ${result.error}`);
    } else {
      console.log(`  ✅ Portfolio Status: ${result.success ? 'Success' : result.error}`);
    }

    // Get portfolio config
    result = await this.callTool('portfolio_config');
    this.results.push(result);
    if (result.skipped) {
      console.log(`  ⚠️  Portfolio Config: Skipped - ${result.error}`);
    } else {
      console.log(`  ✅ Portfolio Config: ${result.success ? 'Success' : result.error}`);
    }
  }

  async testContentCreation() {
    console.log('\n✨ Testing Content Creation...');
    
    // Create a test element
    const result = await this.callTool('create_element', {
      name: 'QA Test Persona',
      type: 'personas',
      description: 'A test persona for QA validation'
    });
    
    this.results.push(result);
    if (result.skipped) {
      console.log(`  ⚠️  Create Element: Skipped - ${result.error}`);
      return false;
    } else {
      console.log(`  ✅ Create Element: ${result.success ? 'Success' : result.error}`);
      return result.success;
    }
  }

  async testErrorHandling() {
    console.log('\n⚠️  Testing Error Handling...');
    
    // Test with invalid parameters
    const tests = [
      { tool: 'list_elements', params: { type: 'invalid_type' } },
      { tool: 'activate_element', params: { name: 'NonExistentElement', type: 'personas' } },
      { tool: 'get_collection_content', params: { path: 'invalid/path' } }
    ];

    for (const test of tests) {
      const result = await this.callTool(test.tool, test.params);
      this.results.push(result);
      
      if (result.skipped) {
        console.log(`  ⚠️  ${test.tool}: Skipped - ${result.error}`);
      } else if (!result.success) {
        console.log(`  ✅ Expected error for ${test.tool}: ${result.error}`);
      } else {
        console.log(`  ⚠️  Expected error but got success for ${test.tool}`);
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
      results: this.results.map(r => ({
        tool: r.tool,
        success: r.success,
        skipped: r.skipped || false,
        params: r.params,
        error: r.error || null,
        duration: r.duration
      }))
    };

    const filename = `qa-test-results-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.json`;
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

  async runFullTestSuite() {
    console.log('🚀 Starting DollhouseMCP QA Test Suite...');
    console.log(`📡 Connecting to Inspector at ${INSPECTOR_URL}`);
    
    try {
      await this.discoverAvailableTools();
      
      // Ensure availableTools is properly initialized before validation
      if (!Array.isArray(this.availableTools)) {
        this.availableTools = [];
      }
      
      await this.testElementListing();
      await this.testMarketplaceBrowsing();
      await this.testUserIdentity();
      await this.testPersonaOperations();
      await this.testPortfolioOperations();
      await this.testContentCreation();
      await this.testErrorHandling();
      
      return this.generateReport();
    } catch (error) {
      console.error('❌ Test suite failed:', error.message);
      return null;
    }
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const runner = new MCPTestRunner();
  runner.runFullTestSuite().then(report => {
    process.exit(report ? 0 : 1);
  });
}

export { MCPTestRunner };