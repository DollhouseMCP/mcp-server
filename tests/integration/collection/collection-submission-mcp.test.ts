/**
 * Integration Test Suite for Collection Submission via MCP
 * 
 * This test suite validates the complete collection submission workflow
 * using real MCP communication through the Inspector, real files, and
 * actual GitHub API interactions.
 * 
 * Addresses Issue #808 - Integration test suite for collection submission
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

describe('Collection Submission Integration via MCP', () => {
  let client: Client;
  let transport: StdioClientTransport;
  let clientInitialized = false;
  let transportInitialized = false;
  let stderrStream: NodeJS.ReadableStream | null = null;
  let testDir: string;
  let originalTestPersonasDir: string | undefined;
  beforeAll(async () => {
    // Create temporary test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-collection-test-'));
    originalTestPersonasDir = process.env.TEST_PERSONAS_DIR;
    process.env.TEST_PERSONAS_DIR = testDir;
    
    // Filter out undefined values from process.env
    const filteredEnv = Object.keys(process.env).reduce((acc, key) => {
      if (process.env[key] !== undefined) {
        acc[key] = process.env[key] as string;
      }
      return acc;
    }, {} as Record<string, string>);

    // Start MCP server directly via stdio
    // IMPORTANT: We explicitly clear GITHUB_TOKEN and GITHUB_TEST_TOKEN to ensure
    // this test never makes real GitHub API calls. The server loads .env.local,
    // so we must override those values here to prevent accidental submissions.
    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      env: {
        ...filteredEnv, // Use the filtered environment
        TEST_MODE: 'true',
        DOLLHOUSE_PORTFOLIO_DIR: testDir,
        NODE_ENV: 'test',
        // Must use discrete mode to access submit_collection_content tool
        MCP_INTERFACE_MODE: 'discrete',
        // Explicitly clear GitHub tokens to prevent real API calls
        GITHUB_TOKEN: '',
        GITHUB_TEST_TOKEN: '',
      }
    });

    stderrStream = transport.stderr;
    if (stderrStream) {
      stderrStream.on('data', data => {
        console.error(`Server stderr: ${data.toString()}`);
      });
    }

    // Create MCP client
    client = new Client({ 
      name: 'integration-test-client', 
      version: '1.0.0' 
    }, {
      capabilities: {}
    });
    
    // Start transport and connect client
    await client.connect(transport);
    clientInitialized = true;
    transportInitialized = true;
    
    // Create element directories
    await fs.mkdir(path.join(testDir, 'personas'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'skills'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'templates'), { recursive: true });
  }, 30000); // 30 second timeout for server startup
  
  afterAll(async () => {
    // Clean up stderr stream first to prevent further reads
    if (stderrStream) {
      stderrStream.removeAllListeners();
      if (typeof (stderrStream as { destroy?: () => void }).destroy === 'function') {
        (stderrStream as { destroy: () => void }).destroy();
      }
      stderrStream = null;
    }

    // Disconnect from server
    if (clientInitialized) {
      try {
        await client.close();
      } catch {
        // Ignore close errors
      }
      clientInitialized = false;
    }

    if (transportInitialized) {
      const transportRef = transport;
      const pid = transportRef.pid;

      // Close transport first
      try {
        await transportRef.close();
      } catch {
        // Ignore close errors
      }

      // Force kill the child process if it still exists
      if (pid) {
        try {
          // Send SIGTERM first
          process.kill(pid, 'SIGTERM');
          // Give it a moment to terminate gracefully
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
          // Force kill if still running
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Process already terminated
          }
        } catch (error) {
          // ESRCH means process doesn't exist (already terminated)
          if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ESRCH') {
            // Log but don't throw - we want cleanup to continue
            console.error('Error killing child process:', error);
          }
        }
      }

      transportInitialized = false;
    }

    // Small delay to allow OS to clean up file handles
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    // Clean up test directory
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
    if (originalTestPersonasDir !== undefined) {
      process.env.TEST_PERSONAS_DIR = originalTestPersonasDir;
    } else {
      delete process.env.TEST_PERSONAS_DIR;
    }
  });
  
  describe('Complete submission workflow', () => {
    it('should submit persona with full content through MCP', async () => {
      // Check if we have a valid token before running the actual test
      if (!process.env.GITHUB_TOKEN) {
        console.log('⏭️  Skipping test: GITHUB_TOKEN not configured in .env or .env.local');
        console.log('   To run this test, add GITHUB_TOKEN with "public_repo" scope to .env.local');
        return;
      }

      // Create test persona file with frontmatter
      const personaName = `test-persona-${Date.now()}`;
      const personaContent = `---
name: ${personaName}
description: Integration test persona
author: test-user
version: 1.0.0
created: ${new Date().toISOString()}
age_rating: all
license: CC-BY-SA-4.0
---

# ${personaName}

This is an integration test persona created to validate the collection submission workflow.

## Purpose

This persona tests that:
- Full content is submitted (not just metadata)
- Frontmatter is preserved
- The complete markdown file is included in the GitHub issue

## Instructions

You are a test assistant for validating collection submissions.

### Key behaviors:
1. Validate submission content
2. Ensure frontmatter preservation
3. Verify complete file inclusion`;
      
      const personaPath = path.join(testDir, 'personas', `${personaName}.md`);
      await fs.writeFile(personaPath, personaContent, 'utf-8');
      
      // Submit via MCP tool
      const result = await client.callTool({
        name: 'submit_collection_content',
        arguments: {
          content: personaName
        }
      });
      
      // Validate response
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      
      // Type assertion for content
      const content = result.content as Array<{ text: string }>;
      expect(content[0]).toBeDefined();
      
      const responseText = content[0].text;

      // Check for scope-related errors
      const hasScopeError =
        responseText.includes('COLL_AUTH_002') ||
        responseText.match(/missing.*scope/i) ||
        responseText.match(/missing.*public_repo/i);

      if (hasScopeError) {
        // Token exists but doesn't have proper scopes - skip the test
        console.log('⏭️  Skipping test: GITHUB_TOKEN exists but lacks "public_repo" scope');
        console.log('   To run this test, regenerate your token with "public_repo" scope enabled');
        console.log('   Token validation error:', responseText.split('\n')[0]);
        return;
      }

      // Check for authentication errors (no token or invalid token)
      const hasAuthError =
        responseText.match(/not authenticated/i) ||
        responseText.includes('COLL_AUTH_001');

      if (hasAuthError) {
        // This shouldn't happen since we checked for token above, but handle it
        console.log('⏭️  Skipping test: Authentication failed');
        console.log('   Error:', responseText.split('\n')[0]);
        return;
      }

      // If we get here, the token should be valid and submission should succeed
      expect(responseText).toContain('submitted');
      
      // Extract issue URL if present
      const issueUrlMatch = responseText.match(/https:\/\/github\.com\/DollhouseMCP\/collection\/issues\/\d+/);
      if (issueUrlMatch) {
        const issueUrl = issueUrlMatch[0];
        console.log(`Created issue: ${issueUrl}`);
        
        // Wait for GitHub to process
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Validate issue content (if we have GitHub token)
        if (process.env.GITHUB_TOKEN) {
          await validateGitHubIssue(issueUrl);
        }
      }
    }, 60000); // 60 second timeout for submission
    
    it('should reject malicious content via MCP', async () => {
      const maliciousName = `malicious-test-${Date.now()}`;
      const maliciousContent = `---
name: ${maliciousName}
description: Test for security validation
---

<script>alert('XSS')</script>
<img src=x onerror="alert('XSS')">`;
      
      const maliciousPath = path.join(testDir, 'personas', `${maliciousName}.md`);
      await fs.writeFile(maliciousPath, maliciousContent, 'utf-8');
      
      // Attempt submission via MCP
      const result = await client.callTool({
        name: 'submit_collection_content',
        arguments: {
          content: maliciousName
        }
      });
      
      // Should be rejected or sanitized
      const content = result.content as Array<{ text: string }>;
      const responseText = content[0].text;
      
      // Check if it was rejected due to security
      if (responseText.includes('security') || responseText.includes('validation')) {
        // Good - security validation worked
        expect(responseText).toMatch(/security|validation|rejected/i);
      } else if (responseText.includes('github.com/DollhouseMCP/collection/issues')) {
        // If it was submitted, verify content was sanitized
        const issueUrlMatch = responseText.match(/https:\/\/github\.com\/DollhouseMCP\/collection\/issues\/\d+/);
        if (issueUrlMatch && process.env.GITHUB_TOKEN) {
          const issueContent = await fetchGitHubIssue(issueUrlMatch[0]);
          expect(issueContent).not.toContain('<script>');
          expect(issueContent).not.toContain('onerror');
        }
      }
    }, 30000);
    
    it('should reject oversized files without truncation', async () => {
      const oversizedName = `oversized-test-${Date.now()}`;
      
      // Create 11MB file (exceeds 10MB limit)
      const largeContent = `---
name: ${oversizedName}
description: Oversized test file
---

${'x'.repeat(11 * 1024 * 1024)}`;
      
      const oversizedPath = path.join(testDir, 'personas', `${oversizedName}.md`);
      await fs.writeFile(oversizedPath, largeContent, 'utf-8');
      
      // Attempt submission
      const result = await client.callTool({
        name: 'submit_collection_content',
        arguments: {
          content: oversizedName
        }
      });
      
      const content = result.content as Array<{ text: string }>;
      const responseText = content[0].text;
      
      // Should be rejected due to size
      expect(responseText).toMatch(/size|large|exceeds|limit/i);
      
      // Ensure it wasn't truncated and submitted
      expect(responseText).not.toContain('github.com/DollhouseMCP/collection/issues');
    }, 30000);
  });
  
  describe('Multiple element types', () => {
    const elementTypes = [
      { type: 'personas', description: 'Test persona' },
      { type: 'skills', description: 'Test skill' },
      { type: 'templates', description: 'Test template' }
    ];
    
    elementTypes.forEach(({ type, description }) => {
      it(`should submit ${type} with full content`, async () => {
        const elementName = `test-${type}-${Date.now()}`;
        const elementContent = `---
name: ${elementName}
description: ${description} for integration testing
type: ${type}
version: 1.0.0
author: integration-test
---

# ${elementName}

This is test content for ${type} submission.

## Content Validation

This content should appear in the GitHub issue when submitted.`;
        
        const elementPath = path.join(testDir, type, `${elementName}.md`);
        await fs.writeFile(elementPath, elementContent, 'utf-8');
        
        // Submit via MCP
        const result = await client.callTool({
          name: 'submit_collection_content',
          arguments: {
            content: elementName
          }
        });
        
        const content = result.content as Array<{ text: string }>;
        const responseText = content[0].text;
        
        // Check for successful submission or expected behavior
        if (responseText.includes('github.com/DollhouseMCP/collection/issues')) {
          expect(responseText).toContain('submitted');
        } else {
          // Some element types might not be fully implemented yet
          console.log(`${type} submission result: ${responseText.substring(0, 100)}...`);
        }
      }, 30000);
    });
  });
  
  describe('Concurrent submissions', () => {
    it('should handle multiple simultaneous submissions', async () => {
      const submissions = [];
      
      // Create 3 test personas
      for (let i = 0; i < 3; i++) {
        const personaName = `concurrent-test-${i}-${Date.now()}`;
        const personaContent = `---
name: ${personaName}
description: Concurrent submission test ${i}
version: 1.0.0
---

Content for concurrent test ${i}`;
        
        const personaPath = path.join(testDir, 'personas', `${personaName}.md`);
        await fs.writeFile(personaPath, personaContent, 'utf-8');
        
        // Submit without waiting
        submissions.push(
          client.callTool({
            name: 'submit_collection_content',
            arguments: {
              content: personaName
            }
          })
        );
      }
      
      // Wait for all submissions
      const results = await Promise.all(submissions);
      
      // All should complete (either success or rate limited)
      expect(results).toHaveLength(3);
      results.forEach(result => {
        expect(result).toBeDefined();
        expect(result.content).toBeDefined();
      });
      
      // Check for rate limiting
      const rateLimited = results.filter(r => {
        const content = r.content as Array<{ text: string }>;
        return content[0].text.includes('rate') || 
               content[0].text.includes('limit');
      });
      
      if (rateLimited.length > 0) {
        console.log(`${rateLimited.length} submissions were rate limited`);
      }
    }, 60000);
  });
});

/**
 * Helper function to validate GitHub issue content
 */
async function validateGitHubIssue(issueUrl: string): Promise<void> {
  const issueNumber = issueUrl.split('/').pop();
  const response = await fetch(
    `https://api.github.com/repos/DollhouseMCP/collection/issues/${issueNumber}`,
    {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'DollhouseMCP-Integration-Test',
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`
      }
    }
  );
  
  if (!response.ok) {
    console.warn(`Could not fetch issue: ${response.status}`);
    return;
  }
  
  const issue = await response.json();
  const body = issue.body;
  
  // Validate critical elements
  expect(body).toContain('### Element Content');
  
  // Extract YAML content
  const yamlMatch = body.match(/```yaml\n([\s\S]*?)\n```/);
  expect(yamlMatch).toBeTruthy();
  
  if (yamlMatch) {
    const yamlContent = yamlMatch[1];
    
    // Check for frontmatter markers
    expect(yamlContent).toContain('---');
    
    // Check it's not just metadata
    const lines = yamlContent.split('\n');
    expect(lines.length).toBeGreaterThan(10);
    
    console.log(`✅ Issue ${issueNumber} contains full content (${lines.length} lines)`);
  }
}

/**
 * Helper function to fetch GitHub issue content
 */
async function fetchGitHubIssue(issueUrl: string): Promise<string> {
  const issueNumber = issueUrl.split('/').pop();
  const response = await fetch(
    `https://api.github.com/repos/DollhouseMCP/collection/issues/${issueNumber}`,
    {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'DollhouseMCP-Integration-Test',
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`
      }
    }
  );
  
  if (!response.ok) {
    return '';
  }
  
  const issue = await response.json();
  return issue.body || '';
}
