#!/usr/bin/env node

/**
 * OAuth Helper Process - Standalone OAuth polling script
 * 
 * This script runs independently of the MCP server to handle OAuth device flow polling.
 * It's spawned as a detached process when authentication is initiated, polls GitHub
 * for the OAuth token, stores it securely, and then exits.
 * 
 * Usage: node oauth-helper.mjs <device_code> <interval> <expires_in> <client_id>
 * 
 * This solves the MCP server lifecycle issue where the server may shut down
 * between tool calls, breaking background OAuth polling.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import { homedir } from 'os';

// Get the directory of this script
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length < 4) {
  console.error('Usage: oauth-helper.mjs <device_code> <interval> <expires_in> <client_id>');
  process.exit(1);
}

const [deviceCode, intervalStr, expiresInStr, clientId] = args;
const pollInterval = parseInt(intervalStr, 10) || 5;
const expiresIn = parseInt(expiresInStr, 10) || 900; // Default 15 minutes

// Log file for debugging (optional, can be disabled in production)
const LOG_FILE = join(homedir(), '.dollhouse', 'oauth-helper.log');
const LOG_ENABLED = process.env.DOLLHOUSE_OAUTH_DEBUG === 'true';

async function log(message) {
  if (!LOG_ENABLED) return;
  
  try {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    
    // Ensure directory exists
    const logDir = dirname(LOG_FILE);
    await fs.mkdir(logDir, { recursive: true }).catch(() => {});
    
    // Append to log file
    await fs.appendFile(LOG_FILE, logMessage);
  } catch (error) {
    // Silently fail if logging doesn't work
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollGitHub(deviceCode, clientId) {
  const TOKEN_URL = 'https://github.com/login/oauth/access_token';
  
  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    });
    
    const data = await response.json();
    return data;
  } catch (error) {
    await log(`Network error polling GitHub: ${error.message}`);
    throw error;
  }
}

async function storeToken(token) {
  try {
    // Import the compiled TokenManager
    const { TokenManager } = await import('./dist/security/tokenManager.js');
    
    // Store the token using the secure storage mechanism
    await TokenManager.storeGitHubToken(token);
    await log('Token stored successfully using TokenManager');
    return true;
  } catch (error) {
    await log(`Failed to store token using TokenManager: ${error.message}`);
    
    // Fallback: Write to a temporary file for the MCP server to pick up
    try {
      const tempTokenFile = join(homedir(), '.dollhouse', '.auth', 'pending_token.txt');
      const tempDir = dirname(tempTokenFile);
      
      await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(tempTokenFile, token, { mode: 0o600 });
      await log(`Token written to fallback file: ${tempTokenFile}`);
      return true;
    } catch (fallbackError) {
      await log(`Fallback storage also failed: ${fallbackError.message}`);
      throw fallbackError;
    }
  }
}

async function cleanupPidFile() {
  try {
    const pidFile = join(homedir(), '.dollhouse', '.auth', 'oauth-helper.pid');
    await fs.unlink(pidFile).catch(() => {});
    await log('PID file cleaned up');
  } catch (error) {
    // Ignore cleanup errors
  }
}

async function writePidFile() {
  try {
    const pidFile = join(homedir(), '.dollhouse', '.auth', 'oauth-helper.pid');
    const pidDir = dirname(pidFile);
    
    await fs.mkdir(pidDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(pidFile, process.pid.toString(), { mode: 0o600 });
    await log(`PID file written: ${pidFile}`);
  } catch (error) {
    await log(`Failed to write PID file: ${error.message}`);
  }
}

async function main() {
  await log(`OAuth helper started - PID: ${process.pid}`);
  await log(`Device code: ${deviceCode.substring(0, 4)}...`);
  await log(`Poll interval: ${pollInterval}s, Expires in: ${expiresIn}s`);
  await log(`Client ID: ${clientId}`);
  
  // Write PID file for tracking
  await writePidFile();
  
  const startTime = Date.now();
  const timeout = startTime + (expiresIn * 1000);
  let attempts = 0;
  
  // Set up cleanup on exit
  process.on('exit', async () => {
    await cleanupPidFile();
    await log('OAuth helper exiting');
  });
  
  process.on('SIGINT', async () => {
    await log('OAuth helper interrupted by SIGINT');
    await cleanupPidFile();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    await log('OAuth helper terminated by SIGTERM');
    await cleanupPidFile();
    process.exit(0);
  });
  
  while (Date.now() < timeout) {
    attempts++;
    await log(`Polling attempt ${attempts}...`);
    
    try {
      const response = await pollGitHub(deviceCode, clientId);
      
      if (response.error) {
        switch (response.error) {
          case 'authorization_pending':
            // User hasn't authorized yet, keep polling
            await log('Authorization pending, continuing to poll...');
            break;
            
          case 'slow_down':
            // GitHub is asking us to slow down
            await log(`Slowing down polling interval to ${pollInterval * 1.5}s`);
            await sleep(pollInterval * 1500);
            continue;
            
          case 'expired_token':
            await log('Device code expired');
            await cleanupPidFile();
            process.exit(1);
            
          case 'access_denied':
            await log('User denied authorization');
            await cleanupPidFile();
            process.exit(1);
            
          default:
            await log(`Unknown error from GitHub: ${response.error}`);
            await log(`Error description: ${response.error_description}`);
        }
      } else if (response.access_token) {
        // Success! We got the token
        await log('✅ Token received from GitHub!');
        
        // Store the token
        const stored = await storeToken(response.access_token);
        
        if (stored) {
          await log('✅ OAuth authentication completed successfully');
          console.log('✅ GitHub authentication successful! Token has been stored.');
          await cleanupPidFile();
          process.exit(0);
        } else {
          await log('❌ Failed to store token');
          console.error('❌ Failed to store authentication token');
          await cleanupPidFile();
          process.exit(1);
        }
      }
    } catch (error) {
      await log(`Error during polling: ${error.message}`);
      // Don't exit on network errors, just continue polling
    }
    
    // Wait before next poll
    await sleep(pollInterval * 1000);
  }
  
  // Timeout reached
  await log('⏱️ OAuth authorization timed out');
  console.error('⏱️ GitHub authorization timed out. Please try again.');
  await cleanupPidFile();
  process.exit(1);
}

// Run the main function
main().catch(async (error) => {
  await log(`Fatal error: ${error.message}`);
  console.error('Fatal error in OAuth helper:', error);
  await cleanupPidFile();
  process.exit(1);
});