import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// The OAuth parent and detached helper are separate processes, so the
// repository's in-process FileLockManager cannot serialize their state-file
// transactions. This small lock is shared by both processes. Recovery never
// steals from a live PID; an orphan must also exceed the stale threshold.
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_SIGNAL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function lockPathFor(stateFile: string): string {
  return `${stateFile}.lock`;
}

function lockToken(): string {
  return `${process.pid}:${randomUUID()}`;
}

function isAlreadyLocked(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function waitSync(milliseconds: number): void {
  Atomics.wait(LOCK_WAIT_SIGNAL, 0, 0, milliseconds);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryRecoverStaleLockSync(lockPath: string): boolean {
  const recoveryPath = `${lockPath}.recovery`;
  let recoveryDescriptor: number;
  try {
    recoveryDescriptor = fs.openSync(recoveryPath, 'wx', 0o600);
  } catch {
    return false;
  }

  try {
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (age < LOCK_STALE_MS) return false;

    const token = fs.readFileSync(lockPath, 'utf8');
    const ownerPid = Number.parseInt(token.split(':', 1)[0] ?? '', 10);
    if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && processIsAlive(ownerPid)) {
      return false;
    }

    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  } finally {
    try {
      fs.closeSync(recoveryDescriptor);
    } finally {
      try {
        fs.unlinkSync(recoveryPath);
      } catch {
        // Recovery ownership is exclusive, so a missing file is harmless.
      }
    }
  }
}

function lockTimeoutError(lockPath: string): Error {
  return new Error(`Timed out waiting for OAuth state lock: ${lockPath}`);
}

function acquireLockSync(lockPath: string): string {
  const token = lockToken();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx', 0o600);
      let initialized = false;
      try {
        fs.writeFileSync(descriptor, token, 'utf8');
        initialized = true;
      } finally {
        try {
          fs.closeSync(descriptor);
        } finally {
          if (!initialized) fs.unlinkSync(lockPath);
        }
      }
      return token;
    } catch (error) {
      if (!isAlreadyLocked(error)) throw error;
      if (tryRecoverStaleLockSync(lockPath)) continue;
      if (Date.now() >= deadline) throw lockTimeoutError(lockPath);
      waitSync(LOCK_RETRY_MS);
    }
  }
}

async function acquireLock(lockPath: string): Promise<string> {
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
      if (!isAlreadyLocked(error)) throw error;
      if (tryRecoverStaleLockSync(lockPath)) continue;
      if (Date.now() >= deadline) throw lockTimeoutError(lockPath);
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

function releaseLockSync(lockPath: string, token: string): void {
  try {
    if (fs.readFileSync(lockPath, 'utf8') === token) fs.unlinkSync(lockPath);
  } catch {
    // Best-effort release. A mismatched lock is never removed.
  }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    if (await fsPromises.readFile(lockPath, 'utf8') === token) {
      await fsPromises.unlink(lockPath);
    }
  } catch {
    // Best-effort release. A mismatched lock is never removed.
  }
}

export function withOAuthStateLockSync<T>(stateFile: string, operation: () => T): T {
  const lockPath = lockPathFor(stateFile);
  const token = acquireLockSync(lockPath);
  try {
    return operation();
  } finally {
    releaseLockSync(lockPath, token);
  }
}

export async function withOAuthStateLock<T>(stateFile: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = lockPathFor(stateFile);
  const token = await acquireLock(lockPath);
  try {
    return await operation();
  } finally {
    await releaseLock(lockPath, token);
  }
}

export function writeFileAtomicallySync(filePath: string, serializedState: string, mode = 0o600): void {
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
