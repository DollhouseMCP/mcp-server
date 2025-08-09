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
import fsSync from 'fs';
import { homedir } from 'os';

// Get the directory of this script
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Constants
const DEFAULT_POLL_INTERVAL = 5;
const DEFAULT_EXPIRES_IN = 900; // 15 minutes
const MAX_TOKEN_SIZE = 10000; // Maximum reasonable token size

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length < 4) {
  console.error('Usage: oauth-helper.mjs <device_code> <interval> <expires_in> <client_id>');
  process.exit(1);
}

const [deviceCode, intervalStr, expiresInStr, clientId] = args;
const pollInterval = parseInt(intervalStr, 10) || DEFAULT_POLL_INTERVAL;
const expiresIn = parseInt(expiresInStr, 10) || DEFAULT_EXPIRES_IN;

// Validate client ID is provided (no hardcoded fallback)
if (!clientId || clientId === 'undefined') {
  console.error('⚠️  GitHub OAuth Configuration Missing\n');
  console.error('The server administrator needs to configure GitHub OAuth.');
  console.error('Please contact your administrator to set up the DOLLHOUSE_GITHUB_CLIENT_ID.');
  console.error('\nFor administrators: Set the environment variable before starting the server.');
  process.exit(1);
}

// Log file for debugging (optional, can be disabled in production)
const LOG_FILE = join(homedir(), '.dollhouse', 'oauth-helper.log');
const LOG_ENABLED = process.env.DOLLHOUSE_OAUTH_DEBUG === 'true';

async function log(message) {
  if (!LOG_ENABLED) return;
  
  try {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    
    // Ensure directory exists with secure permissions
    const logDir = dirname(LOG_FILE);
    await fs.mkdir(logDir, { recursive: true, mode: 0o700 }).catch(() => {});
    
    // Check if log file exists
    let fileExists = false;
    try {
      await fs.access(LOG_FILE);
      fileExists = true;
    } catch {
      fileExists = false;
    }
    
    // Append to log file
    await fs.appendFile(LOG_FILE, logMessage);
    
    // Set secure permissions on first write
    if (!fileExists) {
      await fs.chmod(LOG_FILE, 0o600);
    }
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
  // Validate token size to prevent DoS
  if (!token || token.length > MAX_TOKEN_SIZE) {
    await log('Invalid token size');
    throw new Error('Invalid token received');
  }
  
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
      
      // Create directory with secure permissions
      await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });
      
      // Verify directory permissions
      const dirStats = await fs.stat(tempDir);
      const dirMode = dirStats.mode & parseInt('777', 8);
      if (dirMode !== parseInt('700', 8)) {
        await fs.chmod(tempDir, 0o700);
      }
      
      // Write token with secure permissions
      await fs.writeFile(tempTokenFile, token, { mode: 0o600 });
      
      // Verify file permissions
      await fs.chmod(tempTokenFile, 0o600);
      
      await log(`Token written to fallback file with secure permissions`);
      return true;
    } catch (fallbackError) {
      await log(`Fallback storage also failed: ${fallbackError.message}`);
      throw fallbackError;
    }
  }
}

function cleanupPidFileSync() {
  try {
    const pidFile = join(homedir(), '.dollhouse', '.auth', 'oauth-helper.pid');
    if (fsSync.existsSync(pidFile)) {
      fsSync.unlinkSync(pidFile);
    }
  } catch (error) {
    // Ignore cleanup errors
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
  await log(`Device code: ${deviceCode.substring(0, 2)}****`); // More aggressive truncation
  await log(`Poll interval: ${pollInterval}s, Expires in: ${expiresIn}s`);
  // Never log client ID
  
  // Write PID file for tracking
  await writePidFile();
  
  const startTime = Date.now();
  const timeout = startTime + (expiresIn * 1000);
  let attempts = 0;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5;
  
  // Set up cleanup on exit - use synchronous cleanup for exit event
  process.on('exit', () => {
    cleanupPidFileSync();
  });
  
  // Use beforeExit for async cleanup when possible
  process.on('beforeExit', async () => {
    await log('OAuth helper completing cleanup');
    await cleanupPidFile();
  });
  
  process.on('SIGINT', () => {
    cleanupPidFileSync();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    cleanupPidFileSync();
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
        consecutiveErrors = 0; // Reset error counter
        
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
      } else {
        // Reset error counter on successful communication
        consecutiveErrors = 0;
      }
    } catch (error) {
      await log(`Error during polling: ${error.message}`);
      
      // Classify error types
      const isNetworkError = error.message && (
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('ETIMEDOUT') ||
        error.message.includes('ENOTFOUND') ||
        error.message.includes('EAI_AGAIN') ||
        error.message.includes('fetch failed')
      );
      
      if (isNetworkError) {
        consecutiveErrors++;
        await log(`Network error ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}`);
        
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          await log('Too many consecutive network errors, exiting');
          await cleanupPidFile();
          process.exit(1);
        }
      } else {
        // Non-network error, likely fatal
        await log(`Fatal error: ${error.message}`);
        await cleanupPidFile();
        process.exit(1);
      }
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