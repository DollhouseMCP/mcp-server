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

import { dirname, join } from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { homedir } from 'os';
import {
  withOAuthStateLockSync,
  writeFileAtomicallySync
} from './oauth-state-coordinator.mjs';

// Constants
const DEFAULT_POLL_INTERVAL = 5;
const DEFAULT_EXPIRES_IN = 900; // 15 minutes
const MAX_TOKEN_SIZE = 10000; // Maximum reasonable token size

// User-scoped runtime files. The parent process passes these when the helper
// is launched from a per-user session; standalone legacy launches keep the
// historical operator-home locations.
const DOLLHOUSE_HOME_DIR = process.env.DOLLHOUSE_HOME_DIR || homedir();
const AUTH_DIR = process.env.DOLLHOUSE_OAUTH_HELPER_AUTH_DIR || join(DOLLHOUSE_HOME_DIR, '.dollhouse', '.auth');
const PID_FILE = join(AUTH_DIR, 'oauth-helper.pid');
const STATE_FILE = join(AUTH_DIR, 'oauth-helper-state.json');
const RESULT_FILE = join(AUTH_DIR, 'oauth-helper-result.json');
const LOG_FILE = process.env.DOLLHOUSE_OAUTH_HELPER_LOG_FILE || join(DOLLHOUSE_HOME_DIR, '.dollhouse', 'oauth-helper.log');
const FLOW_ID = process.env.DOLLHOUSE_OAUTH_HELPER_FLOW_ID || '';
const TOKEN_URL = process.env.DOLLHOUSE_OAUTH_TOKEN_URL || 'https://github.com/login/oauth/access_token';
const LOG_ENABLED = process.env.DOLLHOUSE_OAUTH_DEBUG === 'true';
const PRE_READY_TEST_DELAY_MS = process.env.NODE_ENV === 'test'
  ? Number.parseInt(process.env.DOLLHOUSE_OAUTH_HELPER_TEST_PRE_READY_DELAY_MS || '0', 10)
  : 0;
const POST_RESULT_TEST_DELAY_MS = process.env.NODE_ENV === 'test'
  ? Number.parseInt(process.env.DOLLHOUSE_OAUTH_HELPER_TEST_POST_RESULT_DELAY_MS || '0', 10)
  : 0;

const RESULT_MESSAGES = {
  success: 'OAuth helper completed successfully.',
  expired_token: 'Device code expired before authorization completed.',
  access_denied: 'User denied the GitHub authorization request.',
  timeout: 'Authorization timed out before the user completed GitHub authorization.',
  token_storage_failed: 'OAuth token could not be stored securely.',
  network_failure: 'Too many network errors while contacting the OAuth token endpoint.',
  fatal_error: 'OAuth helper stopped after an unrecoverable error.',
  interrupted: 'OAuth helper was interrupted before authentication completed.',
  unknown_response: 'OAuth token endpoint returned an unrecognized response.',
};

const ALLOWED_RESULT_ERROR_CODES = new Set(Object.keys(RESULT_MESSAGES));

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length < 4) {
  console.error('Usage: oauth-helper.mjs <device_code> <interval> <expires_in> <client_id>');
  process.exit(1);
}

const [deviceCode, intervalStr, expiresInStr, clientId] = args;
const pollIntervalSeconds = Number.parseInt(intervalStr, 10) || DEFAULT_POLL_INTERVAL;
const expiresIn = Number.parseInt(expiresInStr, 10) || DEFAULT_EXPIRES_IN;
let attempts = 0;
let terminalWriteAttempted = false;
let terminalResultWritten = false;
let terminalOutcome = null;

installTerminationHandlers();
if (!claimPreparedStateSync()) {
  // A failed lock/identity claim can outlive the parent process that prepared
  // the generation. Retry one flow-checked transaction so a PID-less state
  // cannot remain indefinitely; a superseding flow is never removed.
  cleanupStateFileSync();
  console.error('OAUTH_HELPER_44: Unable to claim prepared OAuth flow state');
  process.exit(1);
}

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

function sanitizeDiagnostic(value) {
  return String(value ?? '')
    .replace(/\bgithub_pat_\w+\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bgh[a-z]_\w+\b/gi, '[REDACTED_GITHUB_TOKEN]')
    .replaceAll(deviceCode, '[REDACTED_DEVICE_CODE]');
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollGitHub(deviceCode, clientId) {
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
    const { TokenManager } = await import(new URL('./dist/security/tokenManager.js', import.meta.url).href);
    
    // Passing file operations selects TokenManager's file-backed secure storage overload.
    const tokenManager = new TokenManager(createHelperFileOperations(), AUTH_DIR);
    await tokenManager.storeGitHubToken(token);
    await log('Token stored successfully using TokenManager');
    return true;
  } catch (error) {
    await log(`Failed to store token using TokenManager: ${sanitizeDiagnostic(error instanceof Error ? error.message : 'Unknown error')}`);
    throw error;
  }
}

function createHelperFileOperations() {
  // Paths are fixed by AUTH_DIR constants/env, so this standalone helper only
  // needs the small FileOperations surface TokenManager uses for secure storage.
  return {
    async createDirectory(directoryPath) {
      await fs.mkdir(directoryPath, { recursive: true });
    },
    async readFile(filePath) {
      return fs.readFile(filePath, 'utf8');
    },
    async writeFile(filePath, content) {
      await fs.writeFile(filePath, content, { encoding: 'utf8' });
    },
    async deleteFile(filePath) {
      await fs.unlink(filePath);
    },
    async chmod(filePath, mode) {
      await fs.chmod(filePath, mode);
    },
    async exists(filePath) {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    }
  };
}

function cleanupPidFileSync() {
  try {
    if (pidFileBelongsToThisHelperSync()) {
      fsSync.unlinkSync(PID_FILE);
    }
  } catch {
    // Ignore cleanup errors
  }
}

function cleanupStateFileSync() {
  try {
    return withOAuthStateLockSync(STATE_FILE, () => {
      if (!stateFileBelongsToThisHelperSync()) return false;
      fsSync.unlinkSync(STATE_FILE);
      return true;
    });
  } catch {
    return false;
  }
}

async function cleanupPidFile() {
  try {
    if (await pidFileBelongsToThisHelper()) {
      await fs.unlink(PID_FILE).catch(() => {});
      await log('PID file cleaned up');
    } else {
      await log('PID file belongs to another helper flow; leaving it in place');
    }
  } catch {
    // Ignore cleanup errors
  }
}

function buildTerminalResult(status, attempts, errorCode = '') {
  const safeErrorCode = ALLOWED_RESULT_ERROR_CODES.has(errorCode) ? errorCode : 'fatal_error';
  const result = {
    status,
    attempts,
    completedAt: new Date().toISOString(),
    pid: process.pid
  };

  if (FLOW_ID) {
    result.flowId = FLOW_ID;
  }

  if (status !== 'success') {
    result.errorCode = safeErrorCode;
    result.message = RESULT_MESSAGES[safeErrorCode];
  }

  return { result, safeErrorCode };
}

function commitTerminalResultSync(status, attempts, errorCode, exitCode) {
  if (!terminalOutcome) {
    const { result, safeErrorCode } = buildTerminalResult(status, attempts, errorCode);
    terminalOutcome = { status, safeErrorCode, exitCode, result };
  }

  if (terminalWriteAttempted) return terminalOutcome;
  terminalWriteAttempted = true;

  try {
    fsSync.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
    terminalResultWritten = withOAuthStateLockSync(STATE_FILE, () => {
      // Flow-scoped helpers may publish only while their own generation is
      // current. This serializes against replacement state/result cleanup.
      if (FLOW_ID && !stateFileBelongsToThisHelperSync()) return false;
      writeFileAtomicallySync(RESULT_FILE, JSON.stringify(terminalOutcome.result, null, 2));
      return true;
    });
  } catch {
    // Preserve the existing best-effort terminal-reporting contract.
  }

  return terminalOutcome;
}

function claimPreparedStateSync() {
  if (!FLOW_ID) return true;

  try {
    return withOAuthStateLockSync(STATE_FILE, () => {
      const state = JSON.parse(fsSync.readFileSync(STATE_FILE, 'utf8'));
      if (state?.flowId !== FLOW_ID) return false;

      writeFileAtomicallySync(
        STATE_FILE,
        JSON.stringify({ ...state, pid: process.pid }, null, 2)
      );
      return true;
    });
  } catch {
    return false;
  }
}

async function logTerminalCommit(outcome) {
  if (!terminalResultWritten) {
    await log('Failed to write terminal result');
    return;
  }

  const resultSuffix = outcome.status === 'success' ? '' : `/${outcome.safeErrorCode}`;
  await log(`Terminal result written: ${outcome.status}${resultSuffix}`);
}

async function pidFileBelongsToThisHelper() {
  if (!FLOW_ID) return true;
  try {
    const pid = (await fs.readFile(PID_FILE, 'utf8')).trim();
    return pid === String(process.pid);
  } catch {
    return false;
  }
}

function pidFileBelongsToThisHelperSync() {
  if (!FLOW_ID) return fsSync.existsSync(PID_FILE);
  try {
    const pid = fsSync.readFileSync(PID_FILE, 'utf8').trim();
    return pid === String(process.pid);
  } catch {
    return false;
  }
}

function stateFileBelongsToThisHelperSync() {
  if (!FLOW_ID) return fsSync.existsSync(STATE_FILE);
  try {
    const state = JSON.parse(fsSync.readFileSync(STATE_FILE, 'utf8'));
    return state?.flowId === FLOW_ID &&
      (typeof state.pid !== 'number' || state.pid === process.pid);
  } catch {
    return false;
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

function installTerminationHandlers() {
  // Install handlers before the first startup await and before publishing the
  // PID file. The PID file is the parent process's readiness signal.
  process.once('exit', cleanupPidFileSync);
  process.once('beforeExit', async () => {
    await log('OAuth helper completing cleanup');
    await cleanupPidFile();
  });

  const handleInterruption = () => {
    const outcome = terminalOutcome ??
      commitTerminalResultSync('failed', attempts, 'interrupted', 1);
    cleanupStateFileSync();
    cleanupPidFileSync();
    process.exit(outcome?.exitCode ?? 1);
  };

  process.once('SIGINT', handleInterruption);
  process.once('SIGTERM', handleInterruption);
}

async function main() {
  await log(`[START] OAuth helper started - PID: ${process.pid}`);
  await log('[CONFIG] Device code received');
  await log(`[CONFIG] Poll interval: ${pollIntervalSeconds}s, Expires in: ${expiresIn}s`);
  await log(`[CONFIG] Node version: ${process.version}`);
  await log(`[CONFIG] Platform: ${process.platform}`);
  // Never log client ID

  if (PRE_READY_TEST_DELAY_MS > 0) {
    await sleep(PRE_READY_TEST_DELAY_MS);
  }
  
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
  let consecutiveErrors = 0;
  let currentPollIntervalMs = pollIntervalSeconds * 1000;
  const MAX_CONSECUTIVE_ERRORS = 5;

  async function finish(status, errorCode, exitCode) {
    clearInterval(heartbeatInterval);
    const outcome = commitTerminalResultSync(status, attempts, errorCode, exitCode);
    await logTerminalCommit(outcome);
    if (outcome?.status === 'success' && POST_RESULT_TEST_DELAY_MS > 0) {
      await sleep(POST_RESULT_TEST_DELAY_MS);
    }
    const stateCleaned = cleanupStateFileSync();
    await log(stateCleaned
      ? 'OAuth helper state file cleaned up'
      : 'OAuth helper state belongs to another flow; leaving it in place');
    await cleanupPidFile();
    process.exit(outcome?.exitCode ?? exitCode);
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
            // GitHub asks clients to add 5s to the polling interval, then wait
            // the updated interval before the next request.
            currentPollIntervalMs += 5000;
            await log(`[RATE_LIMIT] GitHub requested slower polling - increasing interval to ${currentPollIntervalMs / 1000}s`);
            await sleep(currentPollIntervalMs);
            continue;
            
          case 'expired_token':
            await log('OAUTH_HELPER_264: Device code expired - authentication window closed');
            console.error('OAUTH_EXPIRED: Device code expired at line 264 - authentication window closed');
            return finish('expired', 'expired_token', 1);
            
          case 'access_denied':
            await log('OAUTH_HELPER_270: User denied authorization request');
            console.error('OAUTH_ACCESS_DENIED: User denied authorization at line 270');
            return finish('denied', 'access_denied', 1);
            
          default:
            await log('OAUTH_HELPER_276: Unknown error from GitHub during device flow polling');
            await log('[ERROR] GitHub returned an unrecognized OAuth polling response');
            console.error('OAUTH_UNKNOWN_RESPONSE: Unknown GitHub OAuth response at line 276');
            return finish('failed', 'unknown_response', 1);
        }
      } else if (response.access_token) {
        // Success! We got the token
        await log('[SUCCESS] ✅ Token received from GitHub!');
        consecutiveErrors = 0; // Reset error counter
        
        let stored = false;
        try {
          stored = await storeToken(response.access_token);
        } catch {
          console.error('OAUTH_TOKEN_STORAGE_FAILED: Failed to store authentication token securely');
          return finish('failed', 'token_storage_failed', 1);
        }
        
        if (stored) {
          await log('[SUCCESS] ✅ OAuth authentication completed successfully');
          await log(`[STATS] Total attempts: ${attempts}, Time elapsed: ${Math.round((Date.now() - startTime) / 1000)}s`);
          console.log('✅ GitHub authentication successful! Token has been stored.');
          return finish('success', 'success', 0);
        } else {
          await log('[ERROR] ❌ Failed to store token');
          console.error('❌ Failed to store authentication token');
          return finish('failed', 'token_storage_failed', 1);
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
          return finish('failed', 'network_failure', 1);
        }
      } else {
        // Non-network error, likely fatal
        await log(`OAUTH_HELPER_330: Non-recoverable error: ${sanitizeDiagnostic(error instanceof Error ? error.message : 'Unknown error')}`);
        console.error('OAUTH_FATAL_ERROR: Non-recoverable error at line 330');
        return finish('failed', 'fatal_error', 1);
      }
    }
    
    // Wait before next poll
    await sleep(currentPollIntervalMs);
  }
  
  // Timeout reached
  await log('OAUTH_HELPER_342: OAuth authorization timed out');
  await log(`[STATS] Total attempts: ${attempts}, Time elapsed: ${Math.round((Date.now() - startTime) / 1000)}s`);
  console.error(`OAUTH_TIMEOUT: Authorization timed out at line 342 after ${Math.round((Date.now() - startTime) / 1000)}s - user did not authorize in time`);
  return finish('timeout', 'timeout', 1);
}

// Run the main function
main().catch(async (error) => {
  await log(`Fatal error: ${sanitizeDiagnostic(error instanceof Error ? error.message : 'Unknown error')}`);
  console.error('Fatal error in OAuth helper');
  const outcome = commitTerminalResultSync('failed', attempts, 'fatal_error', 1);
  await logTerminalCommit(outcome);
  cleanupStateFileSync();
  await cleanupPidFile();
  process.exit(outcome?.exitCode ?? 1);
});
