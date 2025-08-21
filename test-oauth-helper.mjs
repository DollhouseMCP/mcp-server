#!/usr/bin/env node

/**
 * Test the OAuth helper process approach
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function testOAuthHelper() {
  console.log('🧪 Testing OAuth Helper Process\n');
  
  // Import required modules
  const { GitHubAuthManager } = await import('./dist/auth/GitHubAuthManager.js');
  const { APICache } = await import('./dist/cache/APICache.js');
  const { TokenManager } = await import('./src/security/tokenManager.js');
  
  try {
    // Check current token status
    const currentToken = await TokenManager.getGitHubTokenAsync();
    console.log('Current token exists:', !!currentToken);
    
    if (currentToken) {
      console.log('✅ Already authenticated! Clear auth first if you want to test.');
      return;
    }
    
    // Create auth manager
    const apiCache = new APICache();
    const authManager = new GitHubAuthManager(apiCache);
    
    // Start device flow
    console.log('Starting device flow...');
    const deviceResponse = await authManager.initiateDeviceFlow();
    
    console.log('\n📋 Device flow initiated:');
    console.log('User code:', deviceResponse.user_code);
    console.log('Verification URL:', deviceResponse.verification_uri);
    console.log('Expires in:', deviceResponse.expires_in, 'seconds');
    console.log('Poll interval:', deviceResponse.interval || 5, 'seconds');
    
    // Get client ID
    const clientId = process.env.DOLLHOUSE_GITHUB_CLIENT_ID || 'Ov23liOrPRXkNN7PMCBt';
    
    // Spawn the OAuth helper
    console.log('\n🚀 Spawning OAuth helper process...');
    const helperPath = join(__dirname, 'oauth-helper.mjs');
    
    const helper = spawn('node', [
      helperPath,
      deviceResponse.device_code,
      (deviceResponse.interval || 5).toString(),
      deviceResponse.expires_in.toString(),
      clientId
    ], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DOLLHOUSE_OAUTH_DEBUG: 'true' }
    });
    
    helper.unref();
    console.log('✅ Helper process spawned with PID:', helper.pid);
    
    // Write state file
    const stateFile = join(homedir(), '.dollhouse', '.auth', 'oauth-helper-state.json');
    const state = {
      pid: helper.pid,
      deviceCode: deviceResponse.device_code,
      userCode: deviceResponse.user_code,
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (deviceResponse.expires_in * 1000)).toISOString()
    };
    
    await fs.mkdir(dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
    console.log('✅ State file written');
    
    console.log('\n' + '='.repeat(60));
    console.log('📌 INSTRUCTIONS:');
    console.log('='.repeat(60));
    console.log('1. Visit:', deviceResponse.verification_uri);
    console.log('2. Enter code:', deviceResponse.user_code);
    console.log('3. Authorize "DollhouseMCP Collection"');
    console.log('\nThe helper process is running in the background and will');
    console.log('automatically store the token when you complete authorization.');
    console.log('='.repeat(60));
    
    console.log('\n📝 To check status, run:');
    console.log('  cat ~/.dollhouse/oauth-helper.log');
    console.log('\n📝 To check if authenticated, run:');
    console.log('  node -c "const {TokenManager} = require(\'./src/security/tokenManager.js\'); TokenManager.getGitHubTokenAsync().then(t => console.log(\'Authenticated:\', !!t))"');
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error('Full error:', error);
    process.exit(1);
  }
}

// Run the test
testOAuthHelper().catch(console.error);