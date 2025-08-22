#!/usr/bin/env node

/**
 * MCP Inspector CLI Test Runner
 * 
 * CRITICAL: This tests our MCP server using the Inspector as an EXTERNAL client.
 * This validates that our server works correctly with real MCP clients, not just
 * our own SDK. This is essential for ensuring protocol compliance.
 * 
 * Uses the Inspector's CLI mode for programmatic testing without the HTTP proxy complexity.
 */

import { spawn } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { 
  createTestResult,
  calculateAccurateSuccessRate,
  isCI,
  ensureDirectoryExists
} from './qa-utils.js';
import { TestDataCleanup } from './qa-cleanup-manager.js';
import { QAMetricsCollector } from './qa-metrics-collector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class InspectorCLITestRunner {
  constructor() {
    this.results = [];
    this.startTime = new Date();
    this.isCI = isCI();
    
    // Initialize cleanup manager
    this.testCleanup = new TestDataCleanup(`QA_INSPECTOR_CLI_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);
    
    // Initialize metrics collector
    this.metricsCollector = new QAMetricsCollector(`QA_INSPECTOR_${Date.now()}`);
    
    if (this.isCI) {
      console.log('🤖 Running in CI environment');
    }
  }

  /**
   * Execute an Inspector CLI command
   * @param {string} method - MCP method to call (e.g., 'tools/list')
   * @param {Object} params - Parameters for the method
   * @returns {Promise<Object>} Result from Inspector
   */
  async executeInspectorCLI(method, params = {}) {
    return new Promise((resolve, reject) => {
      const args = [
        '@modelcontextprotocol/inspector',
        '--cli',
        'node',
        'dist/index.js',
        '--method',
        method
      ];

      // Add tool-specific arguments
      if (params.toolName) {
        args.push('--tool-name', params.toolName);
      }
      
      // Add tool arguments
      if (params.toolArgs) {
        Object.entries(params.toolArgs).forEach(([key, value]) => {
          args.push('--tool-arg', `${key}=${value}`);
        });
      }

      console.log(`🔧 Executing: npx ${args.join(' ')}`);
      
      const inspectorProcess = spawn('npx', args, {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: 'test' }
      });

      let stdout = '';
      let stderr = '';

      inspectorProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      inspectorProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      inspectorProcess.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Inspector CLI exited with code ${code}: ${stderr}`));
        } else {
          try {
            // Parse JSON output from Inspector
            const result = JSON.parse(stdout);
            resolve(result);
          } catch (parseError) {
            // If not JSON, return raw output
            resolve({ output: stdout, stderr });
          }
        }
      });

      inspectorProcess.on('error', (error) => {
        reject(error);
      });

      // Set timeout for long-running operations
      setTimeout(() => {
        inspectorProcess.kill();
        reject(new Error('Inspector CLI command timed out after 30 seconds'));
      }, 30000);
    });
  }

  async testToolsList() {
    console.log('\n📋 Testing tools/list via Inspector CLI...');
    const startTime = Date.now();
    
    try {
      const result = await this.executeInspectorCLI('tools/list');
      
      const tools = result.tools || [];
      console.log(`✅ Discovered ${tools.length} tools via Inspector CLI`);
      
      // Show first few tools
      if (tools.length > 0) {
        console.log('   Sample tools:');
        tools.slice(0, 3).forEach(tool => {
          console.log(`   - ${tool.name}: ${tool.description?.substring(0, 50)}...`);
        });
      }
      
      const testResult = createTestResult('tools/list', {}, startTime, true, result);
      this.results.push(testResult);
      this.metricsCollector.recordTestExecution('tools/list', {}, startTime, Date.now(), true);
      
      return tools;
    } catch (error) {
      console.error(`❌ tools/list failed: ${error.message}`);
      const testResult = createTestResult('tools/list', {}, startTime, false, null, error.message);
      this.results.push(testResult);
      this.metricsCollector.recordTestExecution('tools/list', {}, startTime, Date.now(), false, error.message);
      return [];
    }
  }

  async testListElements() {
    console.log('\n🔍 Testing list_elements via Inspector CLI...');
    const startTime = Date.now();
    
    try {
      const result = await this.executeInspectorCLI('tools/call', {
        toolName: 'list_elements',
        toolArgs: { type: 'personas' }
      });
      
      console.log(`✅ list_elements succeeded`);
      
      const testResult = createTestResult('list_elements', { type: 'personas' }, startTime, true, result);
      this.results.push(testResult);
      this.metricsCollector.recordTestExecution('list_elements', { type: 'personas' }, startTime, Date.now(), true);
      
      return result;
    } catch (error) {
      console.error(`❌ list_elements failed: ${error.message}`);
      const testResult = createTestResult('list_elements', { type: 'personas' }, startTime, false, null, error.message);
      this.results.push(testResult);
      this.metricsCollector.recordTestExecution('list_elements', { type: 'personas' }, startTime, Date.now(), false, error.message);
      return null;
    }
  }

  async testActivateElement() {
    console.log('\n🎭 Testing activate_element via Inspector CLI...');
    const startTime = Date.now();
    
    try {
      const result = await this.executeInspectorCLI('tools/call', {
        toolName: 'activate_element',
        toolArgs: { 
          name: 'Creative Writer',
          type: 'personas'
        }
      });
      
      console.log(`✅ activate_element succeeded`);
      
      const testResult = createTestResult('activate_element', { name: 'Creative Writer', type: 'personas' }, startTime, true, result);
      this.results.push(testResult);
      this.metricsCollector.recordTestExecution('activate_element', { name: 'Creative Writer', type: 'personas' }, startTime, Date.now(), true);
      
      return result;
    } catch (error) {
      console.error(`❌ activate_element failed: ${error.message}`);
      const testResult = createTestResult('activate_element', { name: 'Creative Writer', type: 'personas' }, startTime, false, null, error.message);
      this.results.push(testResult);
      this.metricsCollector.recordTestExecution('activate_element', { name: 'Creative Writer', type: 'personas' }, startTime, Date.now(), false, error.message);
      return null;
    }
  }

  async testGetUserIdentity() {
    console.log('\n👤 Testing get_user_identity via Inspector CLI...');
    const startTime = Date.now();
    
    try {
      const result = await this.executeInspectorCLI('tools/call', {
        toolName: 'get_user_identity',
        toolArgs: {}
      });
      
      console.log(`✅ get_user_identity succeeded`);
      
      const testResult = createTestResult('get_user_identity', {}, startTime, true, result);
      this.results.push(testResult);
      this.metricsCollector.recordTestExecution('get_user_identity', {}, startTime, Date.now(), true);
      
      return result;
    } catch (error) {
      console.error(`❌ get_user_identity failed: ${error.message}`);
      const testResult = createTestResult('get_user_identity', {}, startTime, false, null, error.message);
      this.results.push(testResult);
      this.metricsCollector.recordTestExecution('get_user_identity', {}, startTime, Date.now(), false, error.message);
      return null;
    }
  }

  async testBrowseCollection() {
    console.log('\n🏪 Testing browse_collection via Inspector CLI...');
    const startTime = Date.now();
    
    try {
      const result = await this.executeInspectorCLI('tools/call', {
        toolName: 'browse_collection',
        toolArgs: { type: 'personas' }
      });
      
      console.log(`✅ browse_collection succeeded`);
      
      const testResult = createTestResult('browse_collection', { type: 'personas' }, startTime, true, result);
      this.results.push(testResult);
      this.metricsCollector.recordTestExecution('browse_collection', { type: 'personas' }, startTime, Date.now(), true);
      
      return result;
    } catch (error) {
      console.error(`❌ browse_collection failed: ${error.message}`);
      const testResult = createTestResult('browse_collection', { type: 'personas' }, startTime, false, null, error.message);
      this.results.push(testResult);
      this.metricsCollector.recordTestExecution('browse_collection', { type: 'personas' }, startTime, Date.now(), false, error.message);
      return null;
    }
  }

  async runAllTests() {
    console.log('🚀 Starting MCP Inspector CLI Test Suite...');
    console.log('📌 CRITICAL: Testing as an EXTERNAL client to validate protocol compliance\n');
    
    // Start metrics collection
    this.metricsCollector.startCollection();
    
    try {
      // Test tool discovery
      const tools = await this.testToolsList();
      this.metricsCollector.recordToolDiscovery(Date.now() - 1000, Date.now(), tools.length);
      
      // Only run tool tests if we discovered tools
      if (tools.length > 0) {
        // Test various tools
        await this.testListElements();
        await this.testActivateElement();
        await this.testGetUserIdentity();
        await this.testBrowseCollection();
      } else {
        console.warn('⚠️  No tools discovered - skipping tool tests');
      }
      
    } catch (error) {
      console.error('❌ Test suite error:', error.message);
    } finally {
      // End metrics collection
      this.metricsCollector.endCollection();
      
      // Generate report
      this.generateReport();
      
      // Save metrics
      this.metricsCollector.saveMetrics();
      
      // Cleanup
      await this.performCleanup();
    }
  }

  generateReport() {
    const endTime = new Date();
    const duration = endTime - this.startTime;
    
    const stats = calculateAccurateSuccessRate(this.results);
    
    const report = {
      test_type: 'Inspector CLI External Validation',
      critical_note: 'Tests MCP server as an EXTERNAL client for protocol compliance',
      timestamp: endTime.toISOString(),
      duration: `${duration}ms`,
      environment: {
        ci: this.isCI,
        inspector_mode: 'CLI'
      },
      summary: {
        total_tests: this.results.length,
        executed: stats.executedCount,
        successful: stats.successCount,
        failed: stats.failureCount,
        skipped: stats.skippedCount,
        success_rate: stats.successRate
      },
      results: this.results
    };

    // Save report
    ensureDirectoryExists('docs/QA');
    const reportPath = `docs/QA/qa-inspector-cli-results-${endTime.toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(reportPath, JSON.stringify(report, null, 2));

    // Console output
    console.log('\n' + '='.repeat(60));
    console.log('📊 Inspector CLI Test Summary:');
    console.log('   Test Type: EXTERNAL CLIENT VALIDATION');
    console.log(`   Total Tests: ${stats.total}`);
    console.log(`   Executed: ${stats.executedCount}`);
    console.log(`   Successful: ${stats.successCount}`);
    console.log(`   Failed: ${stats.failureCount}`);
    console.log(`   Success Rate: ${stats.successRate}%`);
    console.log(`   Duration: ${duration}ms`);
    console.log(`   Report: ${reportPath}`);
    console.log('='.repeat(60));
  }

  async performCleanup() {
    console.log('\n🧹 Performing cleanup...');
    
    try {
      const cleanupResults = await this.testCleanup.cleanupAll();
      console.log(`✅ Cleanup completed: ${cleanupResults.cleaned} items cleaned, ${cleanupResults.failed} failed`);
    } catch (error) {
      console.warn(`⚠️  Cleanup failed: ${error.message}`);
    }
  }
}

// Run the tests
async function main() {
  const runner = new InspectorCLITestRunner();
  await runner.runAllTests();
  
  // Exit with appropriate code
  const hasFailures = runner.results.some(r => !r.success && !r.skipped);
  process.exit(hasFailures ? 1 : 0);
}

// Only run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { InspectorCLITestRunner };