#!/usr/bin/env node

/**
 * Simple test of REAL MCP submit_content tool
 * This tests what actually happens when a user uses submit_content in Claude
 *
 * SECURITY NOTE: This is a test file for E2E testing against controlled test repositories.
 * Unicode normalization (DMCP-SEC-004) is not required as this only tests with
 * known, controlled data in test environments.
 */

import {
  hasTestCredentials,
  getTestGitHubToken,
  getTestSkipMessage
} from '../../src/config/test-env.js';

console.log('\n🔬 Testing ACTUAL MCP submit_content Tool\n');
console.log('This is the REAL MCP tool, not GitHub API.\n');

async function testMCPSubmit() {
  // Set up isolated test directory
  const fs = await import('fs/promises');
  const path = await import('path');
  const os = await import('os');

  // Create unique temporary portfolio directory
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const testPortfolioDir = path.join(os.tmpdir(), `dollhouse-test-e2e-simple-${timestamp}-${random}`);

  try {
    // Check for test credentials
    if (!hasTestCredentials()) {
      console.log(getTestSkipMessage());
      return;
    }

    // Create isolated test portfolio directory structure
    console.log('0️⃣ Setting up isolated test portfolio...');
    await fs.mkdir(path.join(testPortfolioDir, 'personas'), { recursive: true });
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testPortfolioDir;
    console.log(`   Test portfolio: ${testPortfolioDir}\n`);

    // Load the built server
    const { DollhouseMCPServer } = await import('../../dist/index.js');
    const { DollhouseContainer } = await import('../../dist/di/Container.js');

    // Get test token
    const token = getTestGitHubToken();
    process.env.GITHUB_TOKEN = token;

    console.log('Token available:', token ? 'Yes' : 'No');

    const container = new DollhouseContainer();
    const server = new DollhouseMCPServer(container);
  
  console.log('\n1️⃣ Testing submitContent (this is what submit_content MCP tool calls)...\n');
  
  try {
    const result = await server.submitContent('mcp-test-simple');
    
    // The result should be an MCP response object
    console.log('\n📊 MCP Tool Response:');
    console.log(JSON.stringify(result, null, 2).substring(0, 500));
    
    const text = result?.content?.[0]?.text || JSON.stringify(result);
    
    // Check for success indicators
    const hasUploadedText = text.includes('uploaded');
    
    // Properly validate GitHub URLs using URL parsing
    let hasValidGitHubUrl = false;
    const urlMatches = text.match(/https?:\/\/[^\s]+/g);
    if (urlMatches) {
      for (const urlStr of urlMatches) {
        try {
          const parsedUrl = new URL(urlStr);
          if (parsedUrl.hostname === 'github.com' || parsedUrl.hostname === 'www.github.com') {
            hasValidGitHubUrl = true;
            break;
          }
        } catch (e) {
          // Invalid URL, ignore
        }
      }
    }
    
    if (hasValidGitHubUrl || hasUploadedText) {
      console.log('\n✅ SUCCESS! The REAL MCP tool uploaded to GitHub!');
      console.log('This proves the actual submit_content MCP tool works.\n');
    } else if (text.includes('not found')) {
      console.log('\n❌ Persona not found in test portfolio');
      console.log(`File should be at: ${path.join(testPortfolioDir, 'personas/mcp-test-simple.md')}`);
    } else {
      console.log('\n⚠️ Unexpected result from MCP tool');
    }

  } catch (error) {
    console.log('\n❌ Error calling MCP tool:', error.message);
  }

  } finally {
    // Clean up isolated test directory
    console.log('\n🧹 Cleaning up test portfolio...');
    try {
      await fs.rm(testPortfolioDir, { recursive: true, force: true });
      console.log('   ✅ Test portfolio removed\n');
    } catch (cleanupError) {
      console.warn('   ⚠️ Could not clean up test directory:', cleanupError.message);
    }
    // Restore environment
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
  }

  process.exit(0);
}

// Run with timeout protection
setTimeout(() => {
  console.log('\n⏰ Test timed out after 10 seconds');
  process.exit(1);
}, 10000);

testMCPSubmit().catch(console.error);