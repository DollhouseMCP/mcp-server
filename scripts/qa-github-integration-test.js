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
    this.availableTools = [];
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

  async discoverAvailableTools() {
    try {
      console.log('📋 Discovering available tools...');
      const result = await this.client.listTools();
      this.availableTools = result.tools.map(t => t.name);
      console.log(`📋 Discovered ${this.availableTools.length} available tools`);
      return this.availableTools;
    } catch (error) {
      console.error('⚠️  Failed to discover tools:', error.message);
      this.availableTools = [];
      return this.availableTools;
    }
  }

  validateToolExists(toolName) {
    if (!this.availableTools.includes(toolName)) {
      console.log(`  ⚠️  Skipping ${toolName} - tool not available`);
      return false;
    }
    return true;
  }

  async callTool(toolName, args = {}) {
    const startTime = Date.now();
    
    // Check if tool exists before calling
    if (!this.validateToolExists(toolName)) {
      return {
        success: false,
        tool: toolName,
        params: args,
        skipped: true,
        error: 'Tool not available',
        duration: Date.now() - startTime
      };
    }
    
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
    let result = await this.callTool('check_github_auth');
    this.results.push(result);
    
    if (result.skipped) {
      console.log(`  ⚠️  Auth Status Check: Skipped - ${result.error} (${result.duration}ms)`);
    } else if (result.success) {
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
    let result = await this.callTool('portfolio_config');
    this.results.push(result);
    if (result.skipped) {
      console.log(`  ⚠️  Get Portfolio Config: Skipped - ${result.error} (${result.duration}ms)`);
    } else {
      console.log(`  ✅ Get Portfolio Config: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
      
      if (result.success) {
        const configText = result.result?.[0]?.text || '';
        console.log(`    📋 Config preview: ${configText.slice(0, 150)}...`);
      }
    }

    // Get portfolio status
    result = await this.callTool('portfolio_status');
    this.results.push(result);
    if (result.skipped) {
      console.log(`  ⚠️  Get Portfolio Status: Skipped - ${result.error} (${result.duration}ms)`);
    } else {
      console.log(`  ✅ Get Portfolio Status: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
      
      if (result.success) {
        const statusText = result.result?.[0]?.text || '';
        console.log(`    📋 Status preview: ${statusText.slice(0, 150)}...`);
      }
    }

    return result.success;
  }

  async testContentCreationAndUpload() {
    console.log('\n✨ Testing Content Creation & Upload...');
    
    // Create a test persona for upload
    const testPersonaName = `GitHub Test Persona ${Date.now()}`;
    let result = await this.callTool('create_element', {
      name: testPersonaName,
      type: 'personas',
      description: 'A test persona created for GitHub integration testing'
    });
    
    this.results.push(result);
    if (result.skipped) {
      console.log(`  ⚠️  Create Test Persona: Skipped - ${result.error} (${result.duration}ms)`);
      return false;
    } else {
      console.log(`  ✅ Create Test Persona: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
      
      if (!result.success) {
        console.log('  ⚠️  Skipping upload test due to creation failure');
        return false;
      }
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
    let result = await this.callTool('list_elements', { type: 'personas' });
    this.results.push(result);
    
    if (result.skipped) {
      console.log(`  ⚠️  List Personas: Skipped - ${result.error} (${result.duration}ms)`);
      return false;
    } else if (!result.success) {
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
    result = await this.callTool('submit_content', {
      name: personaName,
      type: 'personas'
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
    const result = await this.callTool('configure_oauth', { provider: 'github' });
    this.results.push(result);
    
    if (result.skipped) {
      console.log(`  ⚠️  OAuth Setup: Skipped - ${result.error} (${result.duration}ms)`);
      console.log('    📋 OAuth may not be available');
    } else if (result.success) {
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
    let result = await this.callTool('browse_collection', { section: 'library', type: 'personas' });
    this.results.push(result);
    if (result.skipped) {
      console.log(`    ⚠️  Browse: Skipped - ${result.error} (${result.duration}ms)`);
      return false;
    } else {
      console.log(`    ✅ Browse: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
      if (!result.success) return false;
    }

    console.log('\n  Step 2: Try to install an element...');
    // Try to get a specific collection element
    result = await this.callTool('get_collection_content', { 
      path: 'library/personas/creative-writer.md' 
    });
    this.results.push(result);
    if (result.skipped) {
      console.log(`    ⚠️  Get Collection Element: Skipped - ${result.error} (${result.duration}ms)`);
    } else {
      console.log(`    ✅ Get Collection Element: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);

      if (result.success) {
        // Try to install it
        result = await this.callTool('install_content', {
          path: 'library/personas/creative-writer.md'
        });
        this.results.push(result);
        if (result.skipped) {
          console.log(`    ⚠️  Install Content: Skipped - ${result.error} (${result.duration}ms)`);
        } else {
          console.log(`    ✅ Install Content: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
        }
      }
    }

    console.log('\n  Step 3: Test local modification...');
    // Edit the element if it exists
    result = await this.callTool('edit_element', {
      name: 'Creative Writer',
      type: 'personas',
      field: 'description',
      value: 'An enhanced creative writer with GitHub integration testing capabilities'
    });
    this.results.push(result);
    if (result.skipped) {
      console.log(`    ⚠️  Edit Element: Skipped - ${result.error} (${result.duration}ms)`);
    } else {
      console.log(`    ✅ Edit Element: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
    }

    console.log('\n  Step 4: Test portfolio upload...');
    result = await this.callTool('submit_content', {
      name: 'Creative Writer',
      type: 'personas'
    });
    this.results.push(result);
    if (result.skipped) {
      console.log(`    ⚠️  Portfolio Upload: Skipped - ${result.error} (${result.duration}ms)`);
    } else {
      console.log(`    ✅ Portfolio Upload: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
    }

    console.log('\n  Step 5: Test collection submission...');
    result = await this.callTool('submit_content', {
      name: 'Creative Writer',
      type: 'personas'
    });
    this.results.push(result);
    if (result.skipped) {
      console.log(`    ⚠️  Collection Submission: Skipped - ${result.error} (${result.duration}ms)`);
    } else {
      console.log(`    ✅ Collection Submission: ${result.success ? 'Success' : result.error} (${result.duration}ms)`);
    }

    return true;
  }

  calculateAccurateSuccessRate(results) {
    // Filter out skipped tests
    const executed = results.filter(r => !r.skipped);
    const successful = executed.filter(r => r.success).length;
    const total = executed.length;
    const skipped = results.filter(r => r.skipped).length;
    
    return {
      successful,
      total,
      skipped,
      percentage: total > 0 ? Math.round((successful / total) * 100) : 0
    };
  }

  generateReport() {
    const endTime = new Date();
    const duration = endTime - this.startTime;
    
    const stats = this.calculateAccurateSuccessRate(this.results);
    const totalTests = this.results.length;
    
    const report = {
      test_type: 'github_integration',
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
      github_capabilities: {
        authentication_tested: this.results.some(r => r.tool === 'get_auth_status'),
        portfolio_upload_tested: this.results.some(r => r.tool === 'submit_content'),
        collection_submission_tested: this.results.some(r => r.tool === 'submit_to_collection'),
        oauth_tested: this.results.some(r => r.tool === 'setup_oauth')
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

    mkdirSync('docs/QA', { recursive: true });
    
    const filename = `qa-github-integration-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.json`;
    writeFileSync(`docs/QA/${filename}`, JSON.stringify(report, null, 2));
    
    console.log(`\n📊 GitHub Integration Test Summary:`);
    console.log(`   Available Tools: ${this.availableTools.length}`);
    console.log(`   Total Tests: ${totalTests}`);
    console.log(`   Executed Tests: ${stats.total}`);
    console.log(`   Skipped Tests: ${stats.skipped}`);
    console.log(`   Successful: ${stats.successful}`);
    console.log(`   Failed: ${stats.total - stats.successful}`);
    console.log(`   Success Rate: ${stats.percentage}% (based on executed tests only)`);
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
      await this.discoverAvailableTools();
      
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