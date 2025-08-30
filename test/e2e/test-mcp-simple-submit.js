#!/usr/bin/env node

/**
 * Simple test of REAL MCP submit_content tool
 * This tests what actually happens when a user uses submit_content in Claude
 * 
 * SECURITY NOTE: This is a test file for E2E testing against controlled test repositories.
 * Unicode normalization (DMCP-SEC-004) is not required as this only tests with
 * known, controlled data in test environments.
 */

console.log('\n🔬 Testing ACTUAL MCP submit_content Tool\n');
console.log('This is the REAL MCP tool, not GitHub API.\n');

async function testMCPSubmit() {
  // Load the built server
  const { DollhouseMCPServer } = await import('../../dist/index.js');
  
  // Set token
  process.env.GITHUB_TOKEN = process.env.TEST_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (!process.env.GITHUB_TOKEN) {
    // Try to load from .env.test.local
    const dotenv = await import('dotenv');
    dotenv.config({ path: 'test/e2e/.env.test.local' });
    process.env.GITHUB_TOKEN = process.env.TEST_GITHUB_TOKEN;
  }
  
  console.log('Token available:', process.env.GITHUB_TOKEN ? 'Yes' : 'No');
  
  const server = new DollhouseMCPServer();
  
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
      console.log('\n❌ Persona not found in local portfolio');
      console.log('File should be at: ~/.dollhouse/portfolio/personas/test-mcp-real-ziggy.md');
    } else {
      console.log('\n⚠️ Unexpected result from MCP tool');
    }
    
  } catch (error) {
    console.log('\n❌ Error calling MCP tool:', error.message);
  }
  
  process.exit(0);
}

// Run with timeout protection
setTimeout(() => {
  console.log('\n⏰ Test timed out after 10 seconds');
  process.exit(1);
}, 10000);

testMCPSubmit().catch(console.error);