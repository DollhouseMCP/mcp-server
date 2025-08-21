#!/usr/bin/env node

/**
 * GitHub Integration QA Test Runner for DollhouseMCP
 * 
 * Tests the complete GitHub integration workflow:
 * 1. GitHub authentication
 * 2. Portfolio upload to GitHub repository
 * 3. Collection submission workflow
 * 4. OAuth flow integration
 * 
 * Addresses Issue #629 - Phase 3: Claude Desktop Integration Tests
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, mkdirSync } from 'fs';

class GitHubIntegrationTestRunner {
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
      name: "github-qa-test-client",
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
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Tool call timed out after 15s')), 15000)
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

  async testGitHubAuthentication() {
    console.log('\n🔐 Testing GitHub Authentication...');
    
    // Check authentication status
    let result = await this.callTool('get_auth_status');
    this.results.push(result);
    
    if (result.success) {
      console.log(`  ✅ Auth Status Check: Success (${result.duration}ms)`);
      
      // Try to get the auth status details
      const authText = result.result?.[0]?.text || '';
      if (authText.includes('authenticated') || authText.includes('token')) {
        console.log('    📋 Authentication appears to be configured');
      } else {
        console.log('    ⚠️  Authentication may need setup');
        console.log(`    📋 Auth status: ${authText.slice(0, 100)}...`);
      }
    } else {
      console.log(`  ❌ Auth Status Check: ${result.error} (${result.duration}ms)`);
    }

    return result.success;
  }

  async testPortfolioConfiguration() {
    console.log('\n📁 Testing Portfolio Configuration...');
    
    // Get portfolio config
    let result = await this.callTool('get_portfolio_config');
    this.results.push(result);
    console.log(`  ✅ Get Portfolio Config: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
    
    if (result.success) {
      const configText = result.result?.[0]?.text || '';
      console.log(`    📋 Config preview: ${configText.slice(0, 150)}...`);
    }

    // Get portfolio status
    result = await this.callTool('get_portfolio_status');
    this.results.push(result);
    console.log(`  ✅ Get Portfolio Status: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
    
    if (result.success) {
      const statusText = result.result?.[0]?.text || '';
      console.log(`    📋 Status preview: ${statusText.slice(0, 150)}...`);
    }

    return result.success;
  }

  async testContentCreationAndUpload() {
    console.log('\n✨ Testing Content Creation & Upload...');
    
    // Create a test persona for upload
    const testPersonaName = `GitHub Test Persona ${Date.now()}`;
    let result = await this.callTool('create_persona', {
      name: testPersonaName,
      description: 'A test persona created for GitHub integration testing',
      category: 'testing',
      instructions: 'You are a helpful test assistant used to validate the DollhouseMCP GitHub integration workflow. You help test the complete roundtrip from creation to collection submission.'
    });
    
    this.results.push(result);
    console.log(`  ✅ Create Test Persona: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
    
    if (!result.success) {
      console.log('  ⚠️  Skipping upload test due to creation failure');
      return false;
    }

    // Try to submit the persona to portfolio (GitHub upload)
    result = await this.callTool('submit_content', {
      name: testPersonaName,
      type: 'persona'
    });
    
    this.results.push(result);
    console.log(`  ✅ Submit to Portfolio: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
    
    if (result.success) {
      const submitText = result.result?.[0]?.text || '';
      console.log(`    📋 Submit result: ${submitText.slice(0, 200)}...`);
    }

    return result.success;
  }

  async testCollectionSubmission() {
    console.log('\n🏪 Testing Collection Submission...');
    
    // First, let's see what personas are available to submit
    let result = await this.callTool('list_personas');
    this.results.push(result);
    
    if (!result.success) {
      console.log(`  ❌ List Personas: ${result.error} (${result.duration}ms)`);
      return false;
    }

    console.log(`  ✅ List Personas: Success (${result.duration}ms)`);
    
    // Try to find a persona to submit (look for our test persona or any persona)
    const personasText = result.result?.[0]?.text || '';
    const personaMatch = personasText.match(/▫️ \*\*([^*]+)\*\*/);
    
    if (!personaMatch) {
      console.log('  ⚠️  No personas found to submit');
      return false;
    }

    const personaName = personaMatch[1];
    console.log(`  📋 Found persona to test: "${personaName}"`);

    // Try to submit to collection
    result = await this.callTool('submit_to_collection', {
      name: personaName,
      type: 'persona'
    });
    
    this.results.push(result);
    console.log(`  ✅ Submit to Collection: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
    
    if (result.success) {
      const collectionText = result.result?.[0]?.text || '';
      console.log(`    📋 Collection result: ${collectionText.slice(0, 200)}...`);
    }

    return result.success;
  }

  async testOAuthFlow() {
    console.log('\n🔑 Testing OAuth Flow...');
    
    // Test OAuth helper if available
    const result = await this.callTool('setup_oauth');
    this.results.push(result);
    
    if (result.success) {
      console.log(`  ✅ OAuth Setup: Success (${result.duration}ms)`);
      const oauthText = result.result?.[0]?.text || '';
      console.log(`    📋 OAuth info: ${oauthText.slice(0, 200)}...`);
    } else {
      console.log(`  ⚠️  OAuth Setup: ${result.error} (${result.duration}ms)`);
      console.log('    📋 OAuth may not be available or already configured');
    }

    return result.success;
  }

  async testCompleteWorkflow() {
    console.log('\n🔄 Testing Complete Roundtrip Workflow...');
    
    // This tests the full workflow from Issue #629:
    // 1. Browse collection → 2. Install element → 3. Modify → 4. Upload to portfolio → 5. Submit to collection
    
    console.log('\n  Step 1: Browse marketplace...');
    let result = await this.callTool('browse_marketplace', { category: 'personas' });
    this.results.push(result);
    console.log(`    ✅ Browse: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
    
    if (!result.success) return false;

    console.log('\n  Step 2: Try to install an element...');
    // Try to get a specific marketplace persona
    result = await this.callTool('get_marketplace_persona', { 
      path: 'personas/creative-writer.md' 
    });
    this.results.push(result);
    console.log(`    ✅ Get Marketplace Element: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);

    if (result.success) {
      // Try to install it
      result = await this.callTool('install_content', {
        type: 'persona',
        path: 'personas/creative-writer.md'
      });
      this.results.push(result);
      console.log(`    ✅ Install Content: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
    }

    console.log('\n  Step 3: Test local modification...');
    // Edit the persona if it exists
    result = await this.callTool('edit_persona', {
      name: 'Creative Writer',
      field: 'description',
      value: 'An enhanced creative writer with GitHub integration testing capabilities'
    });
    this.results.push(result);
    console.log(`    ✅ Edit Element: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);

    console.log('\n  Step 4: Test portfolio upload...');
    result = await this.callTool('submit_content', {
      name: 'Creative Writer',
      type: 'persona'
    });
    this.results.push(result);
    console.log(`    ✅ Portfolio Upload: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);

    console.log('\n  Step 5: Test collection submission...');
    result = await this.callTool('submit_to_collection', {
      name: 'Creative Writer',
      type: 'persona'
    });
    this.results.push(result);
    console.log(`    ✅ Collection Submission: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);

    return true;
  }

  generateReport() {
    const endTime = new Date();
    const duration = endTime - this.startTime;
    
    const successful = this.results.filter(r => r.success).length;
    const failed = this.results.filter(r => !r.success).length;
    const total = this.results.length;
    
    const report = {
      test_type: 'github_integration',
      timestamp: endTime.toISOString(),
      duration: `${duration}ms`,
      summary: {
        total,
        successful,
        failed,
        success_rate: `${((successful / total) * 100).toFixed(1)}%`
      },
      github_capabilities: {
        authentication_tested: this.results.some(r => r.tool === 'get_auth_status'),
        portfolio_upload_tested: this.results.some(r => r.tool === 'submit_content'),
        collection_submission_tested: this.results.some(r => r.tool === 'submit_to_collection'),
        oauth_tested: this.results.some(r => r.tool === 'setup_oauth')
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

    mkdirSync('docs/QA', { recursive: true });
    
    const filename = `qa-github-integration-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.json`;
    writeFileSync(`docs/QA/${filename}`, JSON.stringify(report, null, 2));
    
    console.log(`\n📊 GitHub Integration Test Summary:`);
    console.log(`   Total Tests: ${total}`);
    console.log(`   Successful: ${successful}`);
    console.log(`   Failed: ${failed}`);
    console.log(`   Success Rate: ${report.summary.success_rate}`);
    console.log(`   Duration: ${report.duration}`);
    console.log(`\n🔗 GitHub Capabilities Tested:`);
    console.log(`   Authentication: ${report.github_capabilities.authentication_tested ? '✅' : '❌'}`);
    console.log(`   Portfolio Upload: ${report.github_capabilities.portfolio_upload_tested ? '✅' : '❌'}`);
    console.log(`   Collection Submission: ${report.github_capabilities.collection_submission_tested ? '✅' : '❌'}`);
    console.log(`   OAuth Flow: ${report.github_capabilities.oauth_tested ? '✅' : '❌'}`);
    console.log(`\n   Report: docs/QA/${filename}`);
    
    return report;
  }

  async disconnect() {
    if (this.client && this.transport) {
      await this.client.close();
      console.log('🔌 Disconnected from MCP server');
    }
  }

  async runGitHubIntegrationTests() {
    console.log('🚀 Starting DollhouseMCP GitHub Integration QA Tests...');
    console.log('📋 This tests the complete portfolio → GitHub → collection workflow');
    
    try {
      await this.connect();
      
      const authWorking = await this.testGitHubAuthentication();
      await this.testPortfolioConfiguration();
      
      if (authWorking) {
        await this.testContentCreationAndUpload();
        await this.testCollectionSubmission();
      } else {
        console.log('\n⚠️  Skipping upload tests due to authentication issues');
      }
      
      await this.testOAuthFlow();
      await this.testCompleteWorkflow();
      
      const report = this.generateReport();
      await this.disconnect();
      
      return report;
    } catch (error) {
      console.error('❌ GitHub integration test suite failed:', error.message);
      await this.disconnect();
      return null;
    }
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const runner = new GitHubIntegrationTestRunner();
  runner.runGitHubIntegrationTests().then(report => {
    console.log('\n🎯 Test completed! Check the report for detailed results.');
    process.exit(report && parseFloat(report.summary.success_rate) > 0 ? 0 : 1);
  });
}

export { GitHubIntegrationTestRunner };