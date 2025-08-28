#!/usr/bin/env node

/**
 * QA Test for Collection Submission with Full Content
 * 
 * Tests that the submit_content tool correctly includes full element content
 * with frontmatter in GitHub issues, not just metadata.
 * 
 * Addresses Issue #801 - Collection submissions missing content
 * Tests fix from PR #802
 * 
 * This test uses MCP Inspector to communicate with the server via the actual
 * MCP protocol, ensuring we're testing real tool behavior.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { rm, mkdir, writeFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import fetch from 'node-fetch';
import { CONFIG } from '../test-config.js';
import { TestDataCleanup } from './qa-cleanup-manager.js';
import { QAMetricsCollector } from './qa-metrics-collector.js';

class CollectionSubmissionTestRunner {
  constructor() {
    this.results = [];
    this.startTime = new Date();
    this.client = null;
    this.transport = null;
    this.testDir = null;
    this.availableTools = [];
    
    // Initialize cleanup manager with unique test run ID
    this.testCleanup = new TestDataCleanup(`QA_COLLECTION_SUBMISSION_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);
    
    // Initialize metrics collector
    this.metricsCollector = new QAMetricsCollector(`QA_COLLECTION_${Date.now()}`);
  }

  async connect() {
    console.log('🔗 Connecting to MCP server via Inspector...');
    
    this.transport = new StdioClientTransport({
      command: "./node_modules/.bin/tsx",
      args: ["src/index.ts"],
      cwd: process.cwd()
    });

    this.client = new Client({
      name: "collection-qa-test-client",
      version: "1.0.0"
    }, {
      capabilities: {}
    });

    await this.client.connect(this.transport);
    console.log('✅ Connected to MCP server');
  }

  async disconnect() {
    if (this.client) {
      await this.client.disconnect();
      console.log('🔌 Disconnected from MCP server');
    }
  }

  async discoverAvailableTools() {
    try {
      console.log('📋 Discovering available tools...');
      const result = await this.client.listTools();
      this.availableTools = result.tools.map(t => t.name);
      console.log(`📋 Discovered ${this.availableTools.length} available tools`);
      
      // Check for required tools
      const requiredTools = ['submit_content', 'list_elements', 'create_element'];
      const missingTools = requiredTools.filter(t => !this.availableTools.includes(t));
      
      if (missingTools.length > 0) {
        console.error(`❌ Missing required tools: ${missingTools.join(', ')}`);
        return false;
      }
      
      return true;
    } catch (error) {
      console.error('⚠️  Failed to discover tools:', error.message);
      return false;
    }
  }

  async setupTestEnvironment() {
    console.log('\n📁 Setting up test environment...');
    
    // Create temporary test directory
    this.testDir = await this.testCleanup.createTempDir('collection-test');
    console.log(`  ✅ Created test directory: ${this.testDir}`);
    
    // Create subdirectories for different element types
    const dirs = ['personas', 'skills', 'templates'];
    for (const dir of dirs) {
      const fullPath = path.join(this.testDir, dir);
      await mkdir(fullPath, { recursive: true });
      console.log(`  ✅ Created ${dir} directory`);
    }
    
    return true;
  }

  async createTestPersona(name, includeFullContent = true) {
    const personaName = name || `test-persona-${Date.now()}`;
    const personaPath = path.join(this.testDir, 'personas', `${personaName}.md`);
    
    let content;
    if (includeFullContent) {
      // Create persona with full frontmatter and content
      content = `---
name: ${personaName}
description: Test persona for collection submission validation
author: qa-test-user
version: 1.0.0
created: ${new Date().toISOString()}
updated: ${new Date().toISOString()}
age_rating: all
ai_generated: false
generation_method: manual
license: CC-BY-SA-4.0
triggers:
  - test
  - validation
  - collection
category: testing
---

# ${personaName}

This is a test persona created specifically to validate that collection submissions include full content with frontmatter markers.

## Purpose

This persona tests:
- Full content submission (not just metadata)
- Frontmatter preservation
- YAML structure integrity
- Collection workflow validation

## Instructions

You are a helpful test assistant designed to validate the collection submission process.

### Key Behaviors
1. Always be helpful and accurate
2. Provide clear test feedback
3. Validate submission content

## Test Verification

This content should appear in the GitHub issue when submitted to the collection repository.

The frontmatter markers (---) should be preserved.

All metadata fields should be included.

---

*Generated for QA testing of collection submission workflow*`;
    } else {
      // Create minimal persona (for testing edge cases)
      content = `---
name: ${personaName}
description: Minimal test persona
---

Minimal content`;
    }
    
    await writeFile(personaPath, content, 'utf-8');
    console.log(`  ✅ Created test persona: ${personaName}`);
    
    // Track for cleanup
    this.testCleanup.addFile(personaPath);
    
    return { name: personaName, path: personaPath, content };
  }

  async createMaliciousPersona() {
    const personaName = `malicious-test-${Date.now()}`;
    const personaPath = path.join(this.testDir, 'personas', `${personaName}.md`);
    
    const content = `---
name: ${personaName}
description: <script>alert('XSS')</script>
author: evil-user
version: 1.0.0
---

# Malicious Content Test

<script>alert('XSS Attack')</script>
<img src=x onerror="alert('XSS')">
javascript:alert('XSS')

This content should be rejected by security validation.`;
    
    await writeFile(personaPath, content, 'utf-8');
    console.log(`  ⚠️  Created malicious test persona: ${personaName}`);
    
    this.testCleanup.addFile(personaPath);
    
    return { name: personaName, path: personaPath, content };
  }

  async createOversizedPersona() {
    const personaName = `oversized-test-${Date.now()}`;
    const personaPath = path.join(this.testDir, 'personas', `${personaName}.md`);
    
    // Create content larger than 10MB
    const largeContent = 'x'.repeat(11 * 1024 * 1024);
    const content = `---
name: ${personaName}
description: Oversized test persona
---

${largeContent}`;
    
    await writeFile(personaPath, content, 'utf-8');
    console.log(`  ⚠️  Created oversized test persona: ${personaName} (11MB)`);
    
    this.testCleanup.addFile(personaPath);
    
    return { name: personaName, path: personaPath };
  }

  async callTool(toolName, args = {}) {
    const startTime = Date.now();
    let success = false;
    let error = null;
    let result = null;
    
    try {
      if (!this.availableTools.includes(toolName)) {
        throw new Error(`Tool ${toolName} not available`);
      }
      
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`Tool call timed out`)), 30000)
      );
      
      result = await Promise.race([
        this.client.callTool({ name: toolName, arguments: args }),
        timeoutPromise
      ]);
      
      success = true;
      const duration = Date.now() - startTime;
      
      return {
        success: true,
        tool: toolName,
        params: args,
        result: result.content,
        duration
      };
    } catch (err) {
      const duration = Date.now() - startTime;
      
      return {
        success: false,
        tool: toolName,
        params: args,
        error: err.message,
        duration
      };
    } finally {
      this.metricsCollector.recordTestExecution(
        toolName, args, startTime, Date.now(), success, error, false
      );
    }
  }

  async testFullContentSubmission() {
    console.log('\n📝 Testing Full Content Submission...');
    
    // Create a test persona with full content
    const persona = await this.createTestPersona();
    
    // Submit via MCP tool
    console.log(`  🚀 Submitting ${persona.name} to collection...`);
    const submitResult = await this.callTool('submit_content', {
      name: persona.name,
      type: 'personas'
    });
    
    this.results.push(submitResult);
    
    if (!submitResult.success) {
      console.log(`  ❌ Submission failed: ${submitResult.error}`);
      return false;
    }
    
    console.log(`  ✅ Submission completed (${submitResult.duration}ms)`);
    
    // Extract issue URL from result
    const resultText = submitResult.result?.[0]?.text || '';
    const issueUrlMatch = resultText.match(/https:\/\/github\.com\/DollhouseMCP\/collection\/issues\/\d+/);
    
    if (!issueUrlMatch) {
      console.log('  ⚠️  Could not extract issue URL from submission result');
      return false;
    }
    
    const issueUrl = issueUrlMatch[0];
    console.log(`  📋 Created issue: ${issueUrl}`);
    
    // Wait a bit for GitHub to process
    console.log('  ⏳ Waiting for GitHub to process...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Validate the issue content
    const validated = await this.validateIssueContent(issueUrl, persona);
    
    return validated;
  }

  async validateIssueContent(issueUrl, expectedPersona) {
    console.log('\n🔍 Validating Issue Content...');
    
    try {
      // Extract issue number from URL
      const issueNumber = issueUrl.split('/').pop();
      const apiUrl = `https://api.github.com/repos/DollhouseMCP/collection/issues/${issueNumber}`;
      
      console.log(`  🌐 Fetching issue #${issueNumber} from GitHub API...`);
      const response = await fetch(apiUrl, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'DollhouseMCP-QA-Test',
          ...(process.env.GITHUB_TOKEN ? {
            'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`
          } : {})
        }
      });
      
      if (!response.ok) {
        console.log(`  ❌ Failed to fetch issue: ${response.status} ${response.statusText}`);
        return false;
      }
      
      const issue = await response.json();
      const issueBody = issue.body;
      
      // Check for Element Content section
      if (!issueBody.includes('### Element Content')) {
        console.log('  ❌ Issue missing "Element Content" section');
        console.log('     This indicates the fix is not working - only metadata is being sent');
        return false;
      }
      console.log('  ✅ Found "Element Content" section');
      
      // Extract YAML content from issue
      const yamlMatch = issueBody.match(/### Element Content\s*```yaml\n([\s\S]*?)\n```/);
      
      if (!yamlMatch) {
        console.log('  ❌ Could not extract YAML content from issue');
        return false;
      }
      
      const yamlContent = yamlMatch[1];
      console.log(`  ✅ Extracted YAML content (${yamlContent.split('\n').length} lines)`);
      
      // Critical: Check for frontmatter markers
      if (!yamlContent.includes('---')) {
        console.log('  ❌ YAML content missing frontmatter markers (---)')
        console.log('     This means only metadata is being sent, not full file content');
        return false;
      }
      console.log('  ✅ Frontmatter markers present');
      
      // Check that it's not just metadata (should have actual content after frontmatter)
      const lines = yamlContent.split('\n');
      const secondDashIndex = lines.slice(1).findIndex(line => line === '---');
      
      if (secondDashIndex === -1) {
        console.log('  ❌ Missing closing frontmatter marker');
        return false;
      }
      
      // Content should exist after the second ---
      const contentAfterFrontmatter = lines.slice(secondDashIndex + 2).join('\n').trim();
      if (contentAfterFrontmatter.length < 50) {
        console.log('  ❌ Content after frontmatter is too short (likely metadata only)');
        console.log(`     Found only ${contentAfterFrontmatter.length} characters`);
        return false;
      }
      console.log(`  ✅ Full content present (${contentAfterFrontmatter.length} characters after frontmatter)`);
      
      // Verify specific content markers from our test persona
      const expectedMarkers = [
        'This is a test persona created specifically',
        '## Purpose',
        '## Instructions',
        '## Test Verification'
      ];
      
      let markersFound = 0;
      for (const marker of expectedMarkers) {
        if (yamlContent.includes(marker)) {
          markersFound++;
        }
      }
      
      console.log(`  ✅ Found ${markersFound}/${expectedMarkers.length} expected content markers`);
      
      if (markersFound < 2) {
        console.log('  ⚠️  Missing most expected content - possible truncation');
        return false;
      }
      
      // Check footer for version identifier
      if (issueBody.includes('v1.6.9-beta1-collection-fix')) {
        console.log('  ✅ Version identifier found in footer');
      } else {
        console.log('  ⚠️  Version identifier not found (may be different version)');
      }
      
      console.log('\n  ✅ Issue content validation PASSED - full content included!');
      return true;
      
    } catch (error) {
      console.log(`  ❌ Error validating issue: ${error.message}`);
      return false;
    }
  }

  async testSecurityValidation() {
    console.log('\n🔒 Testing Security Validation...');
    
    // Create a malicious persona
    const maliciousPersona = await this.createMaliciousPersona();
    
    // Attempt submission
    console.log(`  🚀 Attempting to submit malicious content...`);
    const submitResult = await this.callTool('submit_content', {
      name: maliciousPersona.name,
      type: 'personas'
    });
    
    this.results.push(submitResult);
    
    if (submitResult.success) {
      // Check if it was actually submitted (it shouldn't be)
      const resultText = submitResult.result?.[0]?.text || '';
      if (resultText.includes('github.com/DollhouseMCP/collection/issues')) {
        console.log('  ❌ SECURITY FAILURE: Malicious content was accepted!');
        return false;
      }
    }
    
    console.log('  ✅ Security validation working - malicious content rejected');
    console.log(`     Rejection reason: ${submitResult.error || 'Security validation'}`);
    
    return true;
  }

  async testFileSizeLimit() {
    console.log('\n📏 Testing File Size Limit...');
    
    // Create oversized persona
    const oversizedPersona = await this.createOversizedPersona();
    
    // Attempt submission
    console.log(`  🚀 Attempting to submit 11MB file...`);
    const submitResult = await this.callTool('submit_content', {
      name: oversizedPersona.name,
      type: 'personas'
    });
    
    this.results.push(submitResult);
    
    if (submitResult.success) {
      const resultText = submitResult.result?.[0]?.text || '';
      if (resultText.includes('github.com/DollhouseMCP/collection/issues')) {
        console.log('  ❌ File size limit not enforced - oversized file accepted');
        return false;
      }
    }
    
    console.log('  ✅ File size limit enforced - oversized file rejected');
    console.log(`     Rejection: ${submitResult.error || 'File too large'}`);
    
    // Important: Verify NO truncation occurred
    if (submitResult.error && submitResult.error.includes('truncat')) {
      console.log('  ❌ WARNING: File was truncated instead of rejected!');
      return false;
    }
    
    console.log('  ✅ Confirmed: File rejected without truncation');
    
    return true;
  }

  async testMultipleElementTypes() {
    console.log('\n🎯 Testing Multiple Element Types...');
    
    const elementTypes = [
      { type: 'personas', name: 'test-persona-multi' },
      { type: 'skills', name: 'test-skill-multi' },
      { type: 'templates', name: 'test-template-multi' }
    ];
    
    let allPassed = true;
    
    for (const element of elementTypes) {
      console.log(`\n  Testing ${element.type}...`);
      
      // Create test file
      const filePath = path.join(this.testDir, element.type, `${element.name}.md`);
      const content = `---
name: ${element.name}
description: Test ${element.type} for validation
type: ${element.type}
version: 1.0.0
---

# Test ${element.type}

This is test content for ${element.type} submission.`;
      
      await writeFile(filePath, content, 'utf-8');
      this.testCleanup.addFile(filePath);
      
      // Submit
      const result = await this.callTool('submit_content', {
        name: element.name,
        type: element.type
      });
      
      this.results.push(result);
      
      if (!result.success) {
        console.log(`    ❌ Failed to submit ${element.type}: ${result.error}`);
        allPassed = false;
      } else {
        console.log(`    ✅ Successfully submitted ${element.type}`);
      }
    }
    
    return allPassed;
  }

  generateReport() {
    const endTime = new Date();
    const duration = endTime - this.startTime;
    
    const successCount = this.results.filter(r => r.success).length;
    const failureCount = this.results.filter(r => !r.success).length;
    const successRate = this.results.length > 0 
      ? ((successCount / this.results.length) * 100).toFixed(1)
      : 0;
    
    const report = {
      summary: {
        startTime: this.startTime.toISOString(),
        endTime: endTime.toISOString(),
        duration: `${(duration / 1000).toFixed(2)}s`,
        totalTests: this.results.length,
        passed: successCount,
        failed: failureCount,
        successRate: `${successRate}%`
      },
      results: this.results,
      recommendations: []
    };
    
    // Add recommendations based on results
    if (failureCount > 0) {
      const authFailures = this.results.filter(r => 
        !r.success && r.error?.includes('auth')
      ).length;
      
      if (authFailures > 0) {
        report.recommendations.push('Check GitHub authentication and token permissions');
      }
      
      const validationFailures = this.results.filter(r => 
        !r.success && r.error?.includes('validation')
      ).length;
      
      if (validationFailures > 0) {
        report.recommendations.push('Review content validation rules');
      }
    }
    
    return report;
  }

  async performCleanup() {
    console.log('\n🧹 Performing cleanup...');
    await this.testCleanup.cleanup();
    console.log('  ✅ Cleanup completed');
  }

  async run() {
    console.log('='.repeat(60));
    console.log('🧪 Collection Submission QA Test');
    console.log('Testing full content inclusion in GitHub issues');
    console.log('='.repeat(60));
    
    let report = null;
    
    try {
      // Connect to MCP server
      await this.connect();
      
      // Discover tools
      const toolsAvailable = await this.discoverAvailableTools();
      if (!toolsAvailable) {
        throw new Error('Required tools not available');
      }
      
      // Setup test environment
      await this.setupTestEnvironment();
      
      // Run test scenarios
      console.log('\n🎯 Running Test Scenarios...');
      
      // Test 1: Full content submission
      const fullContentPassed = await this.testFullContentSubmission();
      console.log(`\n📊 Full Content Test: ${fullContentPassed ? '✅ PASSED' : '❌ FAILED'}`);
      
      // Test 2: Security validation
      const securityPassed = await this.testSecurityValidation();
      console.log(`📊 Security Test: ${securityPassed ? '✅ PASSED' : '❌ FAILED'}`);
      
      // Test 3: File size limit
      const sizeLimitPassed = await this.testFileSizeLimit();
      console.log(`📊 Size Limit Test: ${sizeLimitPassed ? '✅ PASSED' : '❌ FAILED'}`);
      
      // Test 4: Multiple element types
      const multiTypePassed = await this.testMultipleElementTypes();
      console.log(`📊 Multi-Type Test: ${multiTypePassed ? '✅ PASSED' : '❌ FAILED'}`);
      
      // Generate report
      report = this.generateReport();
      
      // Save report
      const reportPath = `qa-reports/collection-submission-${Date.now()}.json`;
      if (!existsSync('qa-reports')) {
        mkdirSync('qa-reports');
      }
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(`\n📄 Report saved to: ${reportPath}`);
      
      // End metrics collection
      this.metricsCollector.endCollection();
      const metricsReport = this.metricsCollector.generateReport();
      
      if (metricsReport.filepath) {
        console.log(`📊 Metrics saved to: ${metricsReport.filepath}`);
      }
      
      // Display summary
      console.log('\n' + '='.repeat(60));
      console.log('📊 TEST SUMMARY');
      console.log('='.repeat(60));
      console.log(`Total Tests: ${report.summary.totalTests}`);
      console.log(`Passed: ${report.summary.passed}`);
      console.log(`Failed: ${report.summary.failed}`);
      console.log(`Success Rate: ${report.summary.successRate}`);
      console.log(`Duration: ${report.summary.duration}`);
      
      if (report.recommendations.length > 0) {
        console.log('\n💡 Recommendations:');
        report.recommendations.forEach(rec => console.log(`  - ${rec}`));
      }
      
      // Overall result
      const allPassed = fullContentPassed && securityPassed && sizeLimitPassed && multiTypePassed;
      console.log('\n' + '='.repeat(60));
      if (allPassed) {
        console.log('✅ ALL TESTS PASSED - Collection submission working correctly!');
      } else {
        console.log('❌ SOME TESTS FAILED - Collection submission needs attention');
      }
      console.log('='.repeat(60));
      
      // Exit with appropriate code
      process.exit(allPassed ? 0 : 1);
      
    } catch (error) {
      console.error('❌ Test suite failed:', error.message);
      console.error(error.stack);
      process.exit(1);
    } finally {
      // Always cleanup
      await this.performCleanup();
      await this.disconnect();
    }
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const runner = new CollectionSubmissionTestRunner();
  runner.run();
}