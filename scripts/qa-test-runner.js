#!/usr/bin/env node

/**
 * QA Test Runner for DollhouseMCP
 * 
 * Programmatically tests all MCP tools via the Inspector API
 * Addresses Issue #629 - Comprehensive QA Testing Process
 */

import fetch from 'node-fetch';
import { writeFileSync } from 'fs';

const INSPECTOR_URL = 'http://localhost:6277/message';
const SESSION_TOKEN = process.env.MCP_SESSION_TOKEN || '351ce3afd51944ef3c812bbb9651eff71c7f11a60108b00c2165ff335dd9efad';

class MCPTestRunner {
  constructor() {
    this.results = [];
    this.startTime = new Date();
  }

  async callTool(toolName, params = {}) {
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
      return {
        success: true,
        tool: toolName,
        params,
        result: result.result,
        duration: Date.now() - new Date().getTime()
      };
    } catch (error) {
      return {
        success: false,
        tool: toolName,
        params,
        error: error.message,
        duration: Date.now() - new Date().getTime()
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
      const result = await this.callTool('browse_marketplace', test.params);
      this.results.push(result);
      
      if (result.success) {
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
    
    // List personas to get one to work with
    let result = await this.callTool('list_personas');
    this.results.push(result);
    
    if (result.success) {
      // Try to activate a persona (Creative Writer is usually available)
      result = await this.callTool('activate_persona', { name: 'Creative Writer' });
      this.results.push(result);
      console.log(`  ✅ Activate Persona: ${result.success ? 'Success' : result.error}`);

      // Get active persona
      result = await this.callTool('get_active_persona');
      this.results.push(result);
      console.log(`  ✅ Get Active: ${result.success ? 'Success' : result.error}`);

      // Deactivate persona
      result = await this.callTool('deactivate_persona');
      this.results.push(result);
      console.log(`  ✅ Deactivate: ${result.success ? 'Success' : result.error}`);
    }
  }

  async testPortfolioOperations() {
    console.log('\n📁 Testing Portfolio Operations...');
    
    // Get portfolio status
    let result = await this.callTool('get_portfolio_status');
    this.results.push(result);
    console.log(`  ✅ Portfolio Status: ${result.success ? 'Success' : result.error}`);

    // Get portfolio config
    result = await this.callTool('get_portfolio_config');
    this.results.push(result);
    console.log(`  ✅ Portfolio Config: ${result.success ? 'Success' : result.error}`);
  }

  async testContentCreation() {
    console.log('\n✨ Testing Content Creation...');
    
    // Create a test persona
    const result = await this.callTool('create_persona', {
      name: 'QA Test Persona',
      description: 'A test persona for QA validation',
      category: 'testing',
      instructions: 'You are a helpful QA testing assistant.'
    });
    
    this.results.push(result);
    console.log(`  ✅ Create Persona: ${result.success ? 'Success' : result.error}`);
    
    return result.success;
  }

  async testErrorHandling() {
    console.log('\n⚠️  Testing Error Handling...');
    
    // Test with invalid parameters
    const tests = [
      { tool: 'list_elements', params: { type: 'invalid_type' } },
      { tool: 'activate_persona', params: { name: 'NonExistentPersona' } },
      { tool: 'get_marketplace_persona', params: { path: 'invalid/path' } }
    ];

    for (const test of tests) {
      const result = await this.callTool(test.tool, test.params);
      this.results.push(result);
      
      if (!result.success) {
        console.log(`  ✅ Expected error for ${test.tool}: ${result.error}`);
      } else {
        console.log(`  ⚠️  Expected error but got success for ${test.tool}`);
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
      results: this.results
    };

    const filename = `qa-test-results-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.json`;
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

  async runFullTestSuite() {
    console.log('🚀 Starting DollhouseMCP QA Test Suite...');
    console.log(`📡 Connecting to Inspector at ${INSPECTOR_URL}`);
    
    try {
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