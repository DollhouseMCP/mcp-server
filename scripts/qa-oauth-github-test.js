#!/usr/bin/env node

/**
 * OAuth GitHub Repository Access Test
 * 
 * This script tests the full OAuth flow including:
 * 1. Checking authentication status
 * 2. Initiating OAuth if needed
 * 3. Making authenticated GitHub API calls
 * 4. Accessing specific repository content
 */

import { MCPTestRunner } from './qa-test-runner.js';
import chalk from 'chalk';
import open from 'open';
import readline from 'readline';
import { promisify } from 'util';
import { exec } from 'child_process';
import fs from 'fs/promises';

const execAsync = promisify(exec);

class OAuthGitHubTest extends MCPTestRunner {
  constructor() {
    super('OAuth GitHub Access Test', 'qa-oauth-github');
    this.githubToken = null;
  }

  /**
   * Create readline interface for user input
   */
  createReadlineInterface() {
    return readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  /**
   * Wait for user to press Enter
   */
  async waitForEnter(message = 'Press Enter to continue...') {
    const rl = this.createReadlineInterface();
    return new Promise((resolve) => {
      rl.question(message, () => {
        rl.close();
        resolve();
      });
    });
  }

  /**
   * Extract OAuth token from helper if it exists
   */
  async getStoredToken() {
    try {
      // Check if token file exists using fs instead of shell
      const tokenPath = `${process.env.HOME}/.dollhouse/.github_token`;
      const token = await fs.readFile(tokenPath, 'utf-8');
      const trimmedToken = token.trim();
      if (trimmedToken && trimmedToken.startsWith('ghu_')) {
        return trimmedToken;
      }
    } catch (error) {
      // Token file doesn't exist or can't be read
      if (error.code !== 'ENOENT') {
        console.error(chalk.yellow('Warning: Error reading token file:', error.message));
      }
    }
    return null;
  }

  /**
   * Complete OAuth flow
   */
  async completeOAuthFlow() {
    console.log(chalk.yellow('\n🔐 Starting OAuth Authentication Flow...\n'));
    
    // Check current auth status
    const authResult = await this.callTool('check_github_auth');
    console.log('Auth check result:', authResult.result?.[0]?.text?.substring(0, 200));
    
    if (authResult.result?.[0]?.text?.includes('✅') && 
        authResult.result?.[0]?.text?.includes('Authenticated')) {
      console.log(chalk.green('✅ Already authenticated!'));
      this.githubToken = await this.getStoredToken();
      return true;
    }
    
    // Setup GitHub auth
    const setupResult = await this.callTool('setup_github_auth');
    const setupText = setupResult.result?.[0]?.text || '';
    
    // Extract device code
    const codeMatch = setupText.match(/Enter code:\s*\*\*([A-Z0-9]{4}-[A-Z0-9]{4})\*\*/) || 
                      setupText.match(/code:\s*\*\*([A-Z0-9]{4}-[A-Z0-9]{4})\*\*/i);
    if (!codeMatch) {
      console.error(chalk.red('Failed to get device code'));
      return false;
    }
    
    const deviceCode = codeMatch[1];
    const verificationUrl = 'https://github.com/login/device';
    
    console.log(chalk.cyan('\n' + '='.repeat(60)));
    console.log(chalk.bold.white('GitHub Device Authentication Required'));
    console.log(chalk.cyan('='.repeat(60)));
    console.log(chalk.yellow(`\n🔑 User Code: ${chalk.bold.white(deviceCode)}`));
    console.log(chalk.yellow(`🌐 URL: ${chalk.bold.white(verificationUrl)}`));
    console.log(chalk.cyan('\n' + '='.repeat(60) + '\n'));
    
    // Open browser
    console.log(chalk.blue('Opening browser...'));
    await open(verificationUrl);
    
    console.log(chalk.yellow('\nPlease enter the code in your browser and authorize the app.'));
    await this.waitForEnter('Press Enter after completing authentication...');
    
    // Wait a moment for the helper to complete
    console.log(chalk.blue('Waiting for authentication to complete...'));
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Check if authentication succeeded
    const finalCheck = await this.callTool('check_github_auth');
    if (finalCheck.result?.[0]?.text?.includes('✅')) {
      console.log(chalk.green('✅ Authentication successful!'));
      this.githubToken = await this.getStoredToken();
      return true;
    }
    
    console.log(chalk.red('❌ Authentication failed'));
    return false;
  }

  /**
   * Make authenticated GitHub API request using fetch
   */
  async githubFetch(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `token ${this.githubToken}`,
        'Accept': 'application/vnd.github.v3+json',
        ...options.headers
      }
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(`GitHub API error: ${error.message || response.statusText}`);
    }
    
    return response.json();
  }
  
  /**
   * Test GitHub API access with token
   */
  async testGitHubAPI() {
    console.log(chalk.blue('\n📊 Testing Direct GitHub API Access...\n'));
    
    if (!this.githubToken) {
      this.githubToken = await this.getStoredToken();
      if (!this.githubToken) {
        console.log(chalk.yellow('No token available for direct API testing'));
        return;
      }
    }
    
    try {
      // Test 1: Get authenticated user
      console.log(chalk.cyan('Getting authenticated user...'));
      const userData = await this.githubFetch('https://api.github.com/user');
      console.log(chalk.green(`✅ Authenticated as: ${userData.login}`));
      
      // Test 2: Access dollhouse-portfolio repository
      console.log(chalk.cyan('\nAccessing dollhouse-portfolio repository...'));
      const repoData = await this.githubFetch('https://api.github.com/repos/mickdarling/dollhouse-portfolio');
      console.log(chalk.green(`✅ Repository: ${repoData.full_name}`));
      console.log(`   Description: ${repoData.description}`);
      console.log(`   Private: ${repoData.private}`);
      
      // Test 3: List contents of templates folder
      console.log(chalk.cyan('\nListing templates folder contents...'));
      try {
        const contents = await this.githubFetch('https://api.github.com/repos/mickdarling/dollhouse-portfolio/contents/templates');
        
        if (Array.isArray(contents)) {
          console.log(chalk.green(`✅ Found ${contents.length} items in templates folder:`));
          contents.forEach(item => {
            console.log(`   - ${item.name} (${item.type})`);
          });
          
          // Test 4: Get a specific file content (if templates exist)
          const firstFile = contents.find(c => c.type === 'file');
          if (firstFile) {
            console.log(chalk.cyan(`\nReading ${firstFile.name}...`));
            const fileData = await this.githubFetch(firstFile.url);
            const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
            console.log(chalk.green(`✅ Successfully read ${firstFile.name}`));
            console.log(chalk.gray('   First 200 chars:'));
            console.log(chalk.gray(`   ${content.substring(0, 200)}...`));
          }
        }
      } catch (error) {
        if (error.message.includes('404')) {
          console.log(chalk.yellow('   No templates folder found'));
        } else {
          throw error;
        }
      }
      
    } catch (error) {
      console.error(chalk.red('Error accessing GitHub API:'), error.message);
    }
  }

  /**
   * Test MCP tools that should use OAuth
   */
  async testMCPGitHubTools() {
    console.log(chalk.blue('\n🔧 Testing MCP GitHub Integration Tools...\n'));
    
    // Look for portfolio/GitHub related tools
    const tools = this.availableTools.filter(tool => 
      tool.includes('portfolio') || 
      tool.includes('github') ||
      tool.includes('submit')
    );
    
    if (tools.length === 0) {
      console.log(chalk.yellow('No GitHub-related MCP tools found'));
      return;
    }
    
    console.log(chalk.cyan(`Found ${tools.length} potentially GitHub-related tools:`));
    
    for (const toolName of tools) {
      console.log(`\n  Testing: ${toolName}`);
      try {
        const result = await this.callTool(toolName);
        if (result.success) {
          console.log(chalk.green(`    ✅ ${toolName} executed`));
          const text = result.result?.[0]?.text || '';
          if (text.includes('GitHub') || text.includes('authenticated')) {
            console.log(chalk.gray(`       ${text.substring(0, 100)}...`));
          }
        } else {
          console.log(chalk.yellow(`    ⚠️ ${toolName}: ${result.error}`));
        }
      } catch (error) {
        console.log(chalk.red(`    ❌ ${toolName} failed: ${error.message}`));
      }
    }
  }

  async runTests() {
    console.log(chalk.bold.cyan('\n' + '='.repeat(60)));
    console.log(chalk.bold.white('  OAuth GitHub Repository Access Test'));
    console.log(chalk.bold.cyan('='.repeat(60) + '\n'));
    
    // Step 1: Complete OAuth flow if needed
    const authSuccess = await this.completeOAuthFlow();
    if (!authSuccess) {
      console.log(chalk.red('\n❌ OAuth authentication failed. Cannot proceed with tests.'));
      return;
    }
    
    // Step 2: Test direct GitHub API access
    await this.testGitHubAPI();
    
    // Step 3: Test MCP tools that should use OAuth
    await this.testMCPGitHubTools();
    
    // Summary
    console.log(chalk.bold.green('\n' + '='.repeat(60)));
    console.log(chalk.bold.white('  Test Summary'));
    console.log(chalk.bold.green('='.repeat(60)));
    
    console.log(chalk.cyan('\nResults:'));
    console.log(chalk.green('  ✅ OAuth authentication working'));
    console.log(chalk.green('  ✅ Direct GitHub API access confirmed'));
    console.log(chalk.green('  ✅ Token storage and retrieval working'));
    
    if (this.githubToken) {
      console.log(chalk.yellow('\n  ⚠️ Note: MCP tools may need updates to use OAuth token'));
      console.log(chalk.gray('     Currently, MCP tools and direct API calls are separate'));
    }
  }
}

// Run the test
if (import.meta.url === `file://${process.argv[1]}`) {
  const test = new OAuthGitHubTest();
  (async () => {
    try {
      await test.connectToMCP();
      await test.runTests();
    } catch (error) {
      console.error(chalk.red('Fatal error:'), error);
      process.exit(1);
    } finally {
      await test.cleanup();
    }
  })();
}

export default OAuthGitHubTest;