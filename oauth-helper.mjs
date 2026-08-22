#!/usr/bin/env node

/**
 * OAuth Helper Process - Standalone OAuth polling script
 * 
 * This script runs independently of the MCP server to handle OAuth device flow polling.
 * It's spawned as a detached process when authentication is initiated, polls GitHub
 * for the OAuth token, stores it securely, and then exits.
 * 
 * Usage: printf '%s' <device_code> | node oauth-helper.mjs <interval> <expires_in> <client_id>
 *   (device_code is passed through stdin, never argv or process environment)
 * 
 * This solves the MCP server lifecycle issue where the server may shut down
 * between tool calls, breaking background OAuth polling.
 */

import { dirname, join } from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { homedir, hostname } from 'os';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';

// Constants
const DEFAULT_POLL_INTERVAL = 5;
const DEFAULT_EXPIRES_IN = 900; // 15 minutes
const MAX_TOKEN_SIZE = 10000; // Maximum reasonable token size
const MAX_DEVICE_CODE_SIZE = 4096;
const DOLLHOUSE_HOME_DIR = process.env.DOLLHOUSE_HOME_DIR || homedir();
// Per-user paths: the server passes DOLLHOUSE_OAUTH_HELPER_AUTH_DIR / _LOG_FILE
// resolved for the current user (hosted HTTP mode). Fall back to the legacy
// global home layout for standalone/operator use.
const AUTH_DIR = process.env.DOLLHOUSE_OAUTH_HELPER_AUTH_DIR || join(DOLLHOUSE_HOME_DIR, '.dollhouse', '.auth');
const PID_FILE = join(AUTH_DIR, 'oauth-helper.pid');
const STATE_FILE = join(AUTH_DIR, 'oauth-helper-state.json');
const RESULT_FILE = join(AUTH_DIR, 'oauth-helper-result.json');
const LOG_FILE = process.env.DOLLHOUSE_OAUTH_HELPER_LOG_FILE || join(DOLLHOUSE_HOME_DIR, '.dollhouse', 'oauth-helper.log');
const FLOW_ID = process.env.DOLLHOUSE_OAUTH_HELPER_FLOW_ID || '';
const FLOW_LOCK_ID = process.env.DOLLHOUSE_OAUTH_HELPER_LOCK_ID || '';
const TOKEN_URL = process.env.DOLLHOUSE_OAUTH_TOKEN_URL || 'https://github.com/login/oauth/access_token';
const LOG_ENABLED = process.env.DOLLHOUSE_OAUTH_DEBUG === 'true';
const POST_HANDOFF_TEST_DELAY_MS = process.env.NODE_ENV === 'test'
  ? Number.parseInt(process.env.DOLLHOUSE_OAUTH_HELPER_TEST_POST_HANDOFF_DELAY_MS || '0', 10)
  : 0;
const FLOW_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLOW_LOCK_FILE = join(AUTH_DIR, 'oauth-helper-flow.lock');
const FLOW_LOCK_GUARD = `${FLOW_LOCK_FILE}.guard`;
const RESULT_TEMP_SUFFIX = '.tmp';
const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EBADF', 'EISDIR', 'EPERM']);

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

// Parse command line arguments. The device_code is a short-lived bearer secret
// and arrives on stdin so it is absent from both argv and /proc/<pid>/environ.
const args = process.argv.slice(2);
if (args.length < 3) {
  console.error('Usage: oauth-helper.mjs <interval> <expires_in> <client_id>  (device code via stdin)');
  process.exit(1);
}

const [intervalStr, expiresInStr, clientId] = args;
const stdinDeviceCode = (await readDeviceCodeFromStdin()).trim();
const deviceCode = stdinDeviceCode ||
  (process.env.NODE_ENV === 'test' ? process.env.DOLLHOUSE_OAUTH_HELPER_DEVICE_CODE || '' : '');
if (!deviceCode) {
  console.error('OAUTH_HELPER: missing device code on stdin');
  process.exit(1);
}
const pollIntervalSeconds = Number.parseInt(intervalStr, 10) || DEFAULT_POLL_INTERVAL;
const expiresIn = Number.parseInt(expiresInStr, 10) || DEFAULT_EXPIRES_IN;

async function readDeviceCodeFromStdin() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_DEVICE_CODE_SIZE) {
      throw new Error('OAUTH_HELPER: device code on stdin exceeds maximum size');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
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

  // The detached helper runs outside the server's DI/session context and cannot
  // write the session's ITokenStore — in database mode it has no DB pool, master
  // key, or RLS context. It therefore writes the token to an encrypted, per-user,
  // flow-bound handoff file; the server validates the matching terminal result
  // and flow id, then stores the token through the session's TokenManager (file
  // or database) and deletes the handoff. A flow id is mandatory: without it the
  // server cannot correlate or read the handoff, so there is nothing to hand off.
  if (!FLOW_ID) {
    await log('No flow id provided; cannot hand the token to the server securely');
    throw new Error('Missing OAuth helper flow id');
  }

  try {
    const { writeHandoffToken } = await import(
      new URL('./dist/security/oauthHelperTokenHandoff.js', import.meta.url).href
    );
    await writeHandoffToken(AUTH_DIR, FLOW_ID, token, Date.now() + expiresIn * 1000);
    await log('Token written to encrypted handoff for server import');
    return true;
  } catch (error) {
    await log(`Failed to write token handoff: ${sanitizeDiagnostic(error instanceof Error ? error.message : 'Unknown error')}`);
    throw error;
  }
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
    if (stateFileBelongsToThisHelperSync()) {
      fsSync.unlinkSync(STATE_FILE);
    }
  } catch {
    // Ignore cleanup errors
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

async function cleanupStateFile() {
  try {
    if (await stateFileBelongsToThisHelper()) {
      await fs.unlink(STATE_FILE).catch(() => {});
      await log('OAuth helper state file cleaned up');
    } else {
      await log('OAuth helper state belongs to another flow; leaving it in place');
    }
  } catch {
    // Ignore cleanup errors
  }
}

async function releaseFlowLock() {
  if (!FLOW_ID_RE.test(FLOW_ID) || !FLOW_ID_RE.test(FLOW_LOCK_ID)) return;
  try {
    const { releaseOAuthHelperFlowLock } = await import(
      new URL('./dist/security/oauthHelperTokenHandoff.js', import.meta.url).href
    );
    await releaseOAuthHelperFlowLock(AUTH_DIR, FLOW_ID, FLOW_LOCK_ID);
  } catch {
    // The lease expires independently; failure to release is non-fatal.
  }
}

function releaseFlowLockSync() {
  if (!FLOW_ID_RE.test(FLOW_ID) || !FLOW_ID_RE.test(FLOW_LOCK_ID)) return;
  const guard = tryAcquireFlowLockGuardSync();
  // Signal cleanup must never steal a guard from an in-flight server process.
  // Leaving the lease to expire is safer than racing a successor lock.
  if (!guard) return;
  const claimedPath = `${FLOW_LOCK_FILE}.${randomUUID()}.release`;
  let claimed = false;
  try {
    const lock = JSON.parse(fsSync.readFileSync(FLOW_LOCK_FILE, 'utf8'));
    if (lock?.flowId !== FLOW_ID || lock?.lockId !== FLOW_LOCK_ID) return;
    fsSync.renameSync(FLOW_LOCK_FILE, claimedPath);
    claimed = true;
    const claimedLock = JSON.parse(fsSync.readFileSync(claimedPath, 'utf8'));
    if (claimedLock?.flowId === FLOW_ID && claimedLock?.lockId === FLOW_LOCK_ID) {
      fsSync.unlinkSync(claimedPath);
      claimed = false;
      syncDirectorySync(AUTH_DIR);
      return;
    }
  } catch {
    // Ignore absent, malformed, or already-released locks during termination.
  } finally {
    if (claimed) restoreClaimedFlowLockSync(claimedPath);
    releaseFlowLockGuardSync(guard);
  }
}

function tryAcquireFlowLockGuardSync() {
  const ownerToken = randomUUID();
  const ownerMarkerName = `owner-${ownerToken}.json`;
  const candidatePath = `${FLOW_LOCK_GUARD}.${ownerToken}.candidate`;
  const candidateOwnerPath = join(candidatePath, ownerMarkerName);
  const incarnation = readProcessIncarnationSync(process.pid);
  try {
    fsSync.mkdirSync(candidatePath, { mode: 0o700 });
    const descriptor = fsSync.openSync(candidateOwnerPath, 'wx', 0o600);
    try {
      fsSync.writeFileSync(descriptor, JSON.stringify({
        version: 1,
        ownerToken,
        host: hostname(),
        pid: process.pid,
        createdAt: Date.now(),
        incarnation,
      }), 'utf8');
      fsSync.fsyncSync(descriptor);
    } finally {
      fsSync.closeSync(descriptor);
    }
    syncDirectorySync(candidatePath);
    syncDirectorySync(AUTH_DIR);
    fsSync.renameSync(candidatePath, FLOW_LOCK_GUARD);
    syncDirectorySync(AUTH_DIR);
    return { ownerPath: join(FLOW_LOCK_GUARD, ownerMarkerName), ownerToken };
  } catch {
    return null;
  } finally {
    try { fsSync.rmSync(candidatePath, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function readProcessIncarnationSync(pid) {
  if (process.platform === 'linux') {
    try {
      const bootId = fsSync.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const stat = fsSync.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closingParen = stat.lastIndexOf(')');
      if (closingParen < 0) return null;
      const fieldsAfterCommand = stat.slice(closingParen + 1).trim().split(/\s+/u);
      const processStartId = fieldsAfterCommand[19];
      if (!bootId || !processStartId || !/^[0-9]+$/u.test(processStartId)) return null;
      return { source: 'linux-proc', bootId, processStartId };
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const bootId = normalizeProcessIdentityText(
        execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
          encoding: 'utf8',
          env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
        }),
      );
      const processStartId = normalizeProcessIdentityText(
        execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
          encoding: 'utf8',
          env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
        }),
      );
      if (!bootId || !processStartId) return null;
      return { source: 'darwin-ps', bootId, processStartId };
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeProcessIdentityText(value) {
  return value.trim().replace(/\s+/gu, ' ');
}

function releaseFlowLockGuardSync(guard) {
  const claimedMarker = join(FLOW_LOCK_GUARD, `.claim-${guard.ownerToken}`);
  const quarantinedGuard = `${FLOW_LOCK_GUARD}.${guard.ownerToken}.released`;
  try {
    fsSync.renameSync(guard.ownerPath, claimedMarker);
  } catch {
    return;
  }
  try {
    fsSync.renameSync(FLOW_LOCK_GUARD, quarantinedGuard);
  } catch {
    try { fsSync.renameSync(claimedMarker, guard.ownerPath); } catch { /* fail closed */ }
    return;
  }
  syncDirectorySync(AUTH_DIR);
  try { fsSync.rmSync(quarantinedGuard, { recursive: true, force: true }); } catch { /* no longer blocks */ }
  syncDirectorySync(AUTH_DIR);
}

function restoreClaimedFlowLockSync(claimedPath) {
  try {
    fsSync.linkSync(claimedPath, FLOW_LOCK_FILE);
  } catch (error) {
    if (error?.code !== 'EEXIST') return;
  }
  try {
    fsSync.unlinkSync(claimedPath);
  } catch {
    // The lease or its quarantine copy will expire independently.
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

async function writeTerminalResult(status, attempts, errorCode = '') {
  const temporaryPath = `${RESULT_FILE}.${randomUUID()}${RESULT_TEMP_SUFFIX}`;
  let handle;
  try {
    await fs.mkdir(AUTH_DIR, { recursive: true, mode: 0o700 });
    const { result, safeErrorCode } = buildTerminalResult(status, attempts, errorCode);

    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(result, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    const guard = tryAcquireFlowLockGuardSync();
    if (!guard) throw new Error('OAuth helper flow lock is busy');
    try {
      if (!flowLockBelongsToThisHelperSync()) {
        throw new Error('OAuth helper no longer owns the active flow lock');
      }
      await fs.rename(temporaryPath, RESULT_FILE);
      await syncDirectory(AUTH_DIR);
    } finally {
      releaseFlowLockGuardSync(guard);
    }
    const resultSuffix = status === 'success' ? '' : `/${safeErrorCode}`;
    await log(`Terminal result written: ${status}${resultSuffix}`);
    return true;
  } catch {
    await log('Failed to write terminal result');
    return false;
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

function writeTerminalResultSync(status, attempts, errorCode = '') {
  const temporaryPath = `${RESULT_FILE}.${randomUUID()}${RESULT_TEMP_SUFFIX}`;
  let descriptor;
  try {
    fsSync.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
    const { result } = buildTerminalResult(status, attempts, errorCode);

    descriptor = fsSync.openSync(temporaryPath, 'wx', 0o600);
    fsSync.writeFileSync(descriptor, JSON.stringify(result, null, 2), 'utf8');
    fsSync.fsyncSync(descriptor);
    fsSync.closeSync(descriptor);
    descriptor = undefined;
    const guard = tryAcquireFlowLockGuardSync();
    if (!guard) return false;
    try {
      if (!flowLockBelongsToThisHelperSync()) return false;
      fsSync.renameSync(temporaryPath, RESULT_FILE);
      syncDirectorySync(AUTH_DIR);
    } finally {
      releaseFlowLockGuardSync(guard);
    }
    return true;
  } catch {
    // Ignore cleanup/status errors during process termination
    return false;
  } finally {
    if (descriptor !== undefined) {
      try { fsSync.closeSync(descriptor); } catch { /* already closed */ }
    }
    try { fsSync.unlinkSync(temporaryPath); } catch { /* published or never created */ }
  }
}

async function syncDirectory(directoryPath) {
  let handle;
  try {
    handle = await fs.open(directoryPath, 'r');
    await handle.sync();
  } catch (error) {
    if (!DIRECTORY_SYNC_UNSUPPORTED.has(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function syncDirectorySync(directoryPath) {
  let descriptor;
  try {
    descriptor = fsSync.openSync(directoryPath, 'r');
    fsSync.fsyncSync(descriptor);
  } catch (error) {
    if (!DIRECTORY_SYNC_UNSUPPORTED.has(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) {
      try { fsSync.closeSync(descriptor); } catch { /* already closed */ }
    }
  }
}

async function pidFileBelongsToThisHelper() {
  try {
    return pidRecordBelongsToThisHelper(JSON.parse(await fs.readFile(PID_FILE, 'utf8')));
  } catch {
    return false;
  }
}

function pidFileBelongsToThisHelperSync() {
  try {
    return pidRecordBelongsToThisHelper(JSON.parse(fsSync.readFileSync(PID_FILE, 'utf8')));
  } catch {
    return false;
  }
}

function pidRecordBelongsToThisHelper(record) {
  const currentIncarnation = readProcessIncarnationSync(process.pid);
  return record?.version === 1 && record.pid === process.pid &&
    record.flowId === FLOW_ID && record.lockId === FLOW_LOCK_ID &&
    currentIncarnation && sameProcessIncarnation(record.incarnation, currentIncarnation);
}

function sameProcessIncarnation(left, right) {
  return left?.source === right?.source && left?.bootId === right?.bootId &&
    left?.processStartId === right?.processStartId;
}

function flowLockBelongsToThisHelperSync() {
  if (!FLOW_ID_RE.test(FLOW_ID) || !FLOW_ID_RE.test(FLOW_LOCK_ID)) return false;
  try {
    const lock = JSON.parse(fsSync.readFileSync(FLOW_LOCK_FILE, 'utf8'));
    return lock?.flowId === FLOW_ID && lock?.lockId === FLOW_LOCK_ID &&
      typeof lock.expiresAt === 'number' && Number.isFinite(lock.expiresAt) &&
      lock.expiresAt > Date.now();
  } catch {
    return false;
  }
}

async function stateFileBelongsToThisHelper() {
  if (!FLOW_ID) return true;
  try {
    const state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    return state?.flowId === FLOW_ID &&
      (typeof state.pid !== 'number' || state.pid === process.pid);
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
    const incarnation = readProcessIncarnationSync(process.pid);
    if (!FLOW_ID_RE.test(FLOW_ID) || !FLOW_ID_RE.test(FLOW_LOCK_ID) || !incarnation) {
      throw new Error('Cannot establish OAuth helper process ownership');
    }
    await fs.writeFile(PID_FILE, JSON.stringify({
      version: 1,
      pid: process.pid,
      flowId: FLOW_ID,
      lockId: FLOW_LOCK_ID,
      incarnation,
    }), { mode: 0o600 });
    await log(`PID file written: ${PID_FILE}`);
  } catch {
    await log('Failed to write PID file');
  }
}

let handoffWritten = false;

function hasCommittedHandoffSync() {
  if (handoffWritten) return true;
  if (!FLOW_ID_RE.test(FLOW_ID)) return false;
  try {
    const handoffPath = join(AUTH_DIR, `oauth-helper-token-${FLOW_ID}.enc`);
    const stat = fsSync.statSync(handoffPath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function main() {
  let attempts = 0;
  let heartbeatInterval;
  const finishOnSignal = () => {
    const handoffCommitted = hasCommittedHandoffSync();
    const status = handoffCommitted ? 'success' : 'failed';
    const resultPublished = writeTerminalResultSync(
      status,
      attempts,
      handoffCommitted ? 'success' : 'interrupted'
    );
    if (!handoffCommitted) {
      cleanupStateFileSync();
      releaseFlowLockSync();
    }
    cleanupPidFileSync();
    process.exit(handoffCommitted && resultPublished ? 0 : 1);
  };

  // Install terminal handlers before publishing the PID readiness marker.
  // A supervisor may signal immediately after observing that file.
  process.on('exit', cleanupPidFileSync);
  process.on('beforeExit', async () => {
    await log('OAuth helper completing cleanup');
    await cleanupPidFile();
  });
  process.on('SIGINT', finishOnSignal);
  process.on('SIGTERM', finishOnSignal);

  await log(`[START] OAuth helper started - PID: ${process.pid}`);
  await log('[CONFIG] Device code received');
  await log(`[CONFIG] Poll interval: ${pollIntervalSeconds}s, Expires in: ${expiresIn}s`);
  await log(`[CONFIG] Node version: ${process.version}`);
  await log(`[CONFIG] Platform: ${process.platform}`);
  // Never log client ID
  
  // Write PID file for tracking
  await writePidFile();
  
  // Write initial heartbeat
  let lastHeartbeat = Date.now();
  heartbeatInterval = setInterval(async () => {
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
    const resultPublished = await writeTerminalResult(status, attempts, errorCode);
    // The server needs successful flow state to correlate and consume the
    // encrypted token handoff. Failed flows have no handoff to import.
    if (status !== 'success') {
      await cleanupStateFile();
      await releaseFlowLock();
    }
    await cleanupPidFile();
    if (status === 'success' && resultPublished) {
      console.log('✅ GitHub authentication successful! Token has been stored.');
    }
    process.exit(resultPublished ? exitCode : 1);
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
          handoffWritten = stored;
          if (handoffWritten && POST_HANDOFF_TEST_DELAY_MS > 0) {
            await sleep(POST_HANDOFF_TEST_DELAY_MS);
          }
        } catch {
          console.error('OAUTH_TOKEN_STORAGE_FAILED: Failed to store authentication token securely');
          return finish('failed', 'token_storage_failed', 1);
        }
        
        if (stored) {
          await log('[SUCCESS] ✅ OAuth authentication completed successfully');
          await log(`[STATS] Total attempts: ${attempts}, Time elapsed: ${Math.round((Date.now() - startTime) / 1000)}s`);
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
  const handoffCommitted = hasCommittedHandoffSync();
  const resultPublished = await writeTerminalResult(
    handoffCommitted ? 'success' : 'failed',
    0,
    handoffCommitted ? 'success' : 'fatal_error'
  );
  if (!handoffCommitted) {
    await cleanupStateFile();
    await releaseFlowLock();
  }
  await cleanupPidFile();
  process.exit(handoffCommitted && resultPublished ? 0 : 1);
});
