#!/usr/bin/env node

/**
 * Standalone OAuth Setup Script for DollhouseMCP
 * 
 * This script provides an interactive wizard to configure GitHub OAuth
 * for the DollhouseMCP server without needing the MCP server running.
 * 
 * Usage: node scripts/setup-oauth.js
 */

import { promises as fs } from 'fs';
import path from 'path';
import { homedir } from 'os';
import readline from 'readline';

const CONFIG_DIR = path.join(homedir(), '.dollhouse');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

class OAuthSetup {
  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  // Prompt user for input
  async prompt(question) {
    return new Promise((resolve) => {
      this.rl.question(question, (answer) => {
        resolve(answer.trim());
      });
    });
  }

  // Validate GitHub OAuth client ID format
  validateClientId(clientId) {
    const pattern = /^Ov23li[A-Za-z0-9]{14,}$/;
    return pattern.test(clientId);
  }

  // Load existing configuration
  async loadConfig() {
    try {
      const content = await fs.readFile(CONFIG_FILE, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { version: '1.0.0' };
      }
      throw error;
    }
  }

  // Save configuration with proper permissions
  async saveConfig(config) {
    // Ensure directory exists with proper permissions
    try {
      await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }

    // Write config file with proper permissions
    const tempFile = `${CONFIG_FILE}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    await fs.rename(tempFile, CONFIG_FILE);
  }

  // Display welcome message
  showWelcome() {
    console.log('\n' + colors.bright + colors.cyan + '╔══════════════════════════════════════════════════════════════╗' + colors.reset);
    console.log(colors.bright + colors.cyan + '║           DollhouseMCP OAuth Configuration Setup             ║' + colors.reset);
    console.log(colors.bright + colors.cyan + '╚══════════════════════════════════════════════════════════════╝' + colors.reset);
    console.log('\nThis wizard will help you configure GitHub OAuth for DollhouseMCP.\n');
  }

  // Display instructions for creating GitHub OAuth app
  showInstructions() {
    console.log(colors.bright + colors.yellow + '\n📋 Instructions for Creating a GitHub OAuth App:' + colors.reset);
    console.log('\n1. Go to GitHub Settings:');
    console.log('   ' + colors.cyan + 'https://github.com/settings/developers' + colors.reset);
    
    console.log('\n2. Click "New OAuth App" and fill in:');
    console.log('   • ' + colors.bright + 'Application name:' + colors.reset + ' DollhouseMCP');
    console.log('   • ' + colors.bright + 'Homepage URL:' + colors.reset + ' https://github.com/DollhouseMCP/mcp-server');
    console.log('   • ' + colors.bright + 'Authorization callback URL:' + colors.reset + ' http://localhost:3000/callback');
    console.log('   • ' + colors.bright + 'Description:' + colors.reset + ' (optional)');
    
    console.log('\n3. After creating the app:');
    console.log('   • Copy the ' + colors.bright + 'Client ID' + colors.reset + ' (starts with "Ov23li")');
    console.log('   • ' + colors.red + 'IMPORTANT:' + colors.reset + ' Enable "Device Flow" in the app settings');
    
    console.log('\n4. Keep the Client ID ready - you\'ll enter it next.\n');
  }

  // Check current configuration
  async checkCurrentConfig() {
    try {
      const config = await this.loadConfig();
      const clientId = config.oauth?.githubClientId;
      
      if (clientId) {
        console.log(colors.green + '\n✅ OAuth is already configured!' + colors.reset);
        console.log(`Current Client ID: ${colors.cyan}${clientId.substring(0, 10)}...${colors.reset}\n`);
        
        const answer = await this.prompt('Do you want to update it? (y/n): ');
        return answer.toLowerCase() === 'y';
      }
      
      return true; // No existing config, proceed with setup
    } catch (error) {
      console.log(colors.yellow + '\n⚠️  Could not read existing configuration.' + colors.reset);
      return true; // Proceed with setup
    }
  }

  // Main setup flow
  async run() {
    this.showWelcome();
    
    // Check if already configured
    const shouldContinue = await this.checkCurrentConfig();
    if (!shouldContinue) {
      console.log(colors.green + '\n✨ OAuth configuration is ready to use!' + colors.reset);
      console.log('You can now use ' + colors.cyan + 'setup_github_auth' + colors.reset + ' in Claude Desktop.\n');
      this.rl.close();
      return;
    }
    
    // Show instructions
    const answer = await this.prompt('Do you need instructions for creating a GitHub OAuth app? (y/n): ');
    if (answer.toLowerCase() === 'y') {
      this.showInstructions();
    }
    
    // Get client ID from user
    console.log(colors.bright + '\n🔑 Enter your GitHub OAuth Client ID' + colors.reset);
    console.log(colors.yellow + '   (starts with "Ov23li", followed by at least 14 characters)' + colors.reset);
    
    let clientId;
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      clientId = await this.prompt('\nClient ID: ');
      
      if (this.validateClientId(clientId)) {
        break;
      }
      
      attempts++;
      if (attempts < maxAttempts) {
        console.log(colors.red + '\n❌ Invalid format. Client IDs start with "Ov23li" followed by 14+ alphanumeric characters.' + colors.reset);
        console.log(`Example: ${colors.cyan}Ov23liABCDEFGHIJKLMN123456${colors.reset}`);
        console.log(`Attempts remaining: ${maxAttempts - attempts}`);
      } else {
        console.log(colors.red + '\n❌ Too many invalid attempts. Please check your Client ID and try again.' + colors.reset);
        this.rl.close();
        process.exit(1);
      }
    }
    
    // Save configuration
    try {
      const config = await this.loadConfig();
      config.oauth = config.oauth || {};
      config.oauth.githubClientId = clientId;
      
      await this.saveConfig(config);
      
      console.log(colors.green + '\n✅ OAuth configuration saved successfully!' + colors.reset);
      console.log(`\nConfiguration file: ${colors.cyan}${CONFIG_FILE}${colors.reset}`);
      console.log(`Client ID: ${colors.cyan}${clientId.substring(0, 10)}...${colors.reset} (masked for security)\n`);
      
      console.log(colors.bright + colors.green + '🎉 Setup Complete!' + colors.reset);
      console.log('\nYou can now:');
      console.log('1. Use ' + colors.cyan + 'setup_github_auth' + colors.reset + ' in Claude Desktop to authenticate');
      console.log('2. Or set the environment variable:');
      console.log('   ' + colors.cyan + `export DOLLHOUSE_GITHUB_CLIENT_ID="${clientId}"` + colors.reset);
      console.log('\n' + colors.magenta + 'Happy coding with DollhouseMCP! 🎭' + colors.reset + '\n');
      
    } catch (error) {
      console.log(colors.red + '\n❌ Failed to save configuration:' + colors.reset, error.message);
      
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        console.log(colors.yellow + '\nTip: Check file permissions or run with appropriate privileges.' + colors.reset);
      }
      
      this.rl.close();
      process.exit(1);
    }
    
    this.rl.close();
  }
}

// Check if running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const setup = new OAuthSetup();
  setup.run().catch((error) => {
    console.error(colors.red + '\n❌ Setup failed:' + colors.reset, error.message);
    process.exit(1);
  });
}

export { OAuthSetup };