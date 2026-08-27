import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// The OAuth parent and detached helper are separate processes, so the
// repository's in-process FileLockManager cannot serialize their state-file
// transactions. This lock is deployed beside oauth-helper.mjs and is shared
// by source, development, and packaged execution paths.
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_SIGNAL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function lockPathFor(stateFile) {
  return `${stateFile}.lock`;
}

function lockToken() {
  return `${process.pid}:${randomUUID()}`;
}

function errorCode(error) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

function waitSync(milliseconds) {
  Atomics.wait(LOCK_WAIT_SIGNAL, 0, 0, milliseconds);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function lockOwnerIsDead(lockPath) {
  const token = fs.readFileSync(lockPath, 'utf8');
  const ownerPid = Number.parseInt(token.split(':', 1)[0] ?? '', 10);
  return !Number.isSafeInteger(ownerPid) || ownerPid <= 0 || !processIsAlive(ownerPid);
}

function staleLockCanBeRecovered(lockPath) {
  return Date.now() - fs.statSync(lockPath).mtimeMs >= LOCK_STALE_MS &&
    lockOwnerIsDead(lockPath);
}

function releaseOwnedFileSync(filePath, token) {
  try {
    if (fs.readFileSync(filePath, 'utf8') === token) fs.unlinkSync(filePath);
  } catch {
    // A missing or differently owned file is never removed.
  }
}

function createOwnedFileSync(filePath, token) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  let initialized = false;
  try {
    fs.writeFileSync(descriptor, token, 'utf8');
    initialized = true;
  } finally {
    try {
      fs.closeSync(descriptor);
    } finally {
      if (!initialized) fs.unlinkSync(filePath);
    }
  }
}

function recoverAbandonedRecoveryGateSync(recoveryPath) {
  try {
    if (!staleLockCanBeRecovered(recoveryPath)) return false;
    const observedToken = fs.readFileSync(recoveryPath, 'utf8');
    if (!lockOwnerIsDead(recoveryPath)) return false;
    if (fs.readFileSync(recoveryPath, 'utf8') !== observedToken) return false;
    fs.unlinkSync(recoveryPath);
    return true;
  } catch (error) {
    return errorCode(error) === 'ENOENT';
  }
}

function acquireRecoveryGateSync(recoveryPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = lockToken();
    try {
      createOwnedFileSync(recoveryPath, token);
      return token;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') return null;
      if (!recoverAbandonedRecoveryGateSync(recoveryPath)) return null;
    }
  }
  return null;
}

function tryRecoverStaleLockSync(lockPath) {
  const recoveryPath = `${lockPath}.recovery`;
  const recoveryToken = acquireRecoveryGateSync(recoveryPath);
  if (!recoveryToken) return false;

  try {
    if (!staleLockCanBeRecovered(lockPath)) return false;
    const observedToken = fs.readFileSync(lockPath, 'utf8');
    if (lockOwnerIsDead(lockPath) && fs.readFileSync(lockPath, 'utf8') === observedToken) {
      fs.unlinkSync(lockPath);
      return true;
    }
    return false;
  } catch (error) {
    return errorCode(error) === 'ENOENT';
  } finally {
    releaseOwnedFileSync(recoveryPath, recoveryToken);
  }
}

function lockTimeoutError(lockPath) {
  return new Error(`Timed out waiting for OAuth state lock: ${lockPath}`);
}

function acquireLockSync(lockPath) {
  const token = lockToken();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      createOwnedFileSync(lockPath, token);
      return token;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      if (tryRecoverStaleLockSync(lockPath)) continue;
      if (Date.now() >= deadline) throw lockTimeoutError(lockPath);
      waitSync(LOCK_RETRY_MS);
    }
  }
}

async function acquireLock(lockPath) {
  const token = lockToken();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await fsPromises.open(lockPath, 'wx', 0o600);
      let initialized = false;
      try {
        await handle.writeFile(token, 'utf8');
        initialized = true;
      } finally {
        try {
          await handle.close();
        } finally {
          if (!initialized) await fsPromises.unlink(lockPath);
        }
      }
      return token;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      if (tryRecoverStaleLockSync(lockPath)) continue;
      if (Date.now() >= deadline) throw lockTimeoutError(lockPath);
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

async function releaseLock(lockPath, token) {
  try {
    if (await fsPromises.readFile(lockPath, 'utf8') === token) {
      await fsPromises.unlink(lockPath);
    }
  } catch {
    // A missing or differently owned lock is never removed.
  }
}

export function withOAuthStateLockSync(stateFile, operation) {
  const lockPath = lockPathFor(stateFile);
  const token = acquireLockSync(lockPath);
  try {
    return operation();
  } finally {
    releaseOwnedFileSync(lockPath, token);
  }
}

export async function withOAuthStateLock(stateFile, operation) {
  const lockPath = lockPathFor(stateFile);
  const token = await acquireLock(lockPath);
  try {
    return await operation();
  } finally {
    await releaseLock(lockPath, token);
  }
}

export function writeFileAtomicallySync(filePath, serializedState, mode = 0o600) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, serializedState, { encoding: 'utf8', mode });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The rename consumed the temporary file, or cleanup is best-effort.
    }
  }
}
