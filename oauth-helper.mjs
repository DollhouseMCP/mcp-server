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
const DOLLHOUSE_HOME_DIR = process.env.DOLLHOUSE_HOME_DIR || homedir();
const AUTH_DIR = join(DOLLHOUSE_HOME_DIR, '.dollhouse', '.auth');
const PID_FILE = join(AUTH_DIR, 'oauth-helper.pid');
const STATE_FILE = join(AUTH_DIR, 'oauth-helper-state.json');
const RESULT_FILE = join(AUTH_DIR, 'oauth-helper-result.json');

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
  console.error('OAUTH_HELPER_43: Missing or undefined client ID');
  console.error('⚠️  GitHub OAuth Configuration Missing\n');
  console.error('The server administrator needs to configure GitHub OAuth.');
  console.error('Please contact your administrator to set up the DOLLHOUSE_GITHUB_CLIENT_ID.');
  console.error('\nFor administrators: Set the environment variable before starting the server.');
  await log('OAUTH_HELPER_43: Process exiting - missing client ID');
  process.exit(1);
}

// Log file for debugging (optional, can be disabled in production)
const LOG_FILE = join(DOLLHOUSE_HOME_DIR, '.dollhouse', 'oauth-helper.log');
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
    await log('Network error polling GitHub');
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
    const tokenManager = new TokenManager(createHelperFileOperations());
    await tokenManager.storeGitHubToken(token);
    await log('Token stored successfully using TokenManager');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await log(`Failed to store token using TokenManager: ${message}`);
    console.error(`OAUTH_TOKEN_STORAGE_FAILED: ${message}`);
    throw error;
  }
}

function createHelperFileOperations() {
  return {
    async createDirectory(directoryPath) {
      await fs.mkdir(directoryPath, { recursive: true });
    },
    async writeFile(filePath, content) {
      await fs.writeFile(filePath, content, { encoding: 'utf8' });
    },
    async chmod(filePath, mode) {
      await fs.chmod(filePath, mode);
    }
  };
}

function cleanupPidFileSync() {
  try {
    if (fsSync.existsSync(PID_FILE)) {
      fsSync.unlinkSync(PID_FILE);
    }
  } catch (error) {
    // Ignore cleanup errors
  }
}

function cleanupStateFileSync() {
  try {
    if (fsSync.existsSync(STATE_FILE)) {
      fsSync.unlinkSync(STATE_FILE);
    }
  } catch (error) {
    // Ignore cleanup errors
  }
}

async function cleanupPidFile() {
  try {
    await fs.unlink(PID_FILE).catch(() => {});
    await log('PID file cleaned up');
  } catch (error) {
    // Ignore cleanup errors
  }
}

async function cleanupStateFile() {
  try {
    await fs.unlink(STATE_FILE).catch(() => {});
    await log('OAuth helper state file cleaned up');
  } catch (error) {
    // Ignore cleanup errors
  }
}

async function writeTerminalResult(status, attempts, error) {
  try {
    await fs.mkdir(AUTH_DIR, { recursive: true, mode: 0o700 });
    const result = {
      status,
      attempts,
      completedAt: new Date().toISOString()
    };

    if (error) {
      result.error = error;
    }

    await fs.writeFile(RESULT_FILE, JSON.stringify(result, null, 2), { mode: 0o600 });
    await fs.chmod(RESULT_FILE, 0o600).catch(() => {});
    await log(`Terminal result written: ${status}`);
  } catch (resultError) {
    await log('Failed to write terminal result');
  }
}

async function writePidFile() {
  try {
    await fs.mkdir(AUTH_DIR, { recursive: true, mode: 0o700 });
    await fs.writeFile(PID_FILE, process.pid.toString(), { mode: 0o600 });
    await log(`PID file written: ${PID_FILE}`);
  } catch {
    await log('Failed to write PID file');
  }
}

async function main() {
  await log(`[START] OAuth helper started - PID: ${process.pid}`);
  await log('[CONFIG] Device code received');
  await log(`[CONFIG] Poll interval: ${pollInterval}s, Expires in: ${expiresIn}s`);
  await log(`[CONFIG] Node version: ${process.version}`);
  await log(`[CONFIG] Platform: ${process.platform}`);
  // Never log client ID
  
  // Write PID file for tracking
  await writePidFile();
  
  // Write initial heartbeat
  let lastHeartbeat = Date.now();
  const heartbeatInterval = setInterval(async () => {
    await log(`[HEARTBEAT] Process alive - Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
    lastHeartbeat = Date.now();
  }, 30000); // Every 30 seconds
  
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
    cleanupStateFileSync();
    cleanupPidFileSync();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    cleanupStateFileSync();
    cleanupPidFileSync();
    process.exit(0);
  });

  async function finish(status, error, exitCode) {
    clearInterval(heartbeatInterval);
    await writeTerminalResult(status, attempts, error);
    await cleanupStateFile();
    await cleanupPidFile();
    process.exit(exitCode);
  }
  
  while (Date.now() < timeout) {
    attempts++;
    const timeElapsed = Math.round((Date.now() - startTime) / 1000);
    await log(`[POLL] Attempt ${attempts} at ${timeElapsed}s elapsed...`);
    
    try {
      const response = await pollGitHub(deviceCode, clientId);
      
      if (response.error) {
        switch (response.error) {
          case 'authorization_pending':
            // User hasn't authorized yet, keep polling
            await log('[STATUS] Authorization pending, user has not authorized yet...');
            break;
            
          case 'slow_down':
            // GitHub is asking us to slow down
            await log(`[RATE_LIMIT] GitHub requested slower polling - increasing interval to ${pollInterval * 1.5}s`);
            await sleep(pollInterval * 1500);
            continue;
            
          case 'expired_token':
            await log('OAUTH_HELPER_264: Device code expired - authentication window closed');
            console.error('OAUTH_EXPIRED: Device code expired at line 264 - authentication window closed');
            await finish('expired', 'Device code expired - authentication window closed', 1);
            
          case 'access_denied':
            await log('OAUTH_HELPER_270: User denied authorization request');
            console.error('OAUTH_ACCESS_DENIED: User denied authorization at line 270');
            await finish('denied', 'User denied authorization', 1);
            
          default:
            await log('OAUTH_HELPER_276: Unknown error from GitHub during device flow polling');
            await log('[ERROR] GitHub returned an unrecognized OAuth polling response');
            console.error('OAUTH_UNKNOWN_RESPONSE: Unknown GitHub OAuth response at line 276');
        }
      } else if (response.access_token) {
        // Success! We got the token
        await log('[SUCCESS] ✅ Token received from GitHub!');
        consecutiveErrors = 0; // Reset error counter
        
        // Store the token
        const stored = await storeToken(response.access_token);
        
        if (stored) {
          await log('[SUCCESS] ✅ OAuth authentication completed successfully');
          await log(`[STATS] Total attempts: ${attempts}, Time elapsed: ${Math.round((Date.now() - startTime) / 1000)}s`);
          console.log('✅ GitHub authentication successful! Token has been stored.');
          await finish('success', '', 0);
        } else {
          await log('[ERROR] ❌ Failed to store token');
          console.error('❌ Failed to store authentication token');
          await finish('failed', 'Failed to store authentication token', 1);
        }
      } else {
        // Reset error counter on successful communication
        consecutiveErrors = 0;
      }
    } catch (error) {
      await log('[ERROR] Polling error');
      
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
        await log(`OAUTH_HELPER_319: Network error ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}`);
        
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          await log('OAUTH_HELPER_323: Too many consecutive network errors, exiting');
          console.error(`OAUTH_NETWORK_FAILURE: Too many network errors (${MAX_CONSECUTIVE_ERRORS}) at line 323 - check internet connection`);
          await finish('failed', `Too many network errors (${MAX_CONSECUTIVE_ERRORS}) - check internet connection`, 1);
        }
      } else {
        // Non-network error, likely fatal
        await log('OAUTH_HELPER_330: Non-recoverable error');
        console.error('OAUTH_FATAL_ERROR: Non-recoverable error at line 330');
        const message = error instanceof Error ? error.message : 'Unknown error';
        await finish('failed', `Non-recoverable error: ${message}`, 1);
      }
    }
    
    // Wait before next poll
    await sleep(pollInterval * 1000);
  }
  
  // Timeout reached
  await log('OAUTH_HELPER_342: OAuth authorization timed out');
  await log(`[STATS] Total attempts: ${attempts}, Time elapsed: ${Math.round((Date.now() - startTime) / 1000)}s`);
  console.error(`OAUTH_TIMEOUT: Authorization timed out at line 342 after ${Math.round((Date.now() - startTime) / 1000)}s - user did not authorize in time`);
  await finish('timeout', 'Authorization timed out - user did not authorize in time', 1);
}

// Run the main function
main().catch(async () => {
  await log('Fatal error');
  console.error('Fatal error in OAuth helper');
  await writeTerminalResult('failed', 0, 'Fatal error in OAuth helper');
  await cleanupStateFile();
  await cleanupPidFile();
  process.exit(1);
});
