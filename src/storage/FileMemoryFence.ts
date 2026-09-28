import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * A local-filesystem exclusion primitive for a single tenant memory locator.
 * It does not implement version-checked persistence or archive ownership.
 * Every file-memory writer must participate before it can protect a head.
 */
export interface FileMemoryFenceTarget {
  tenantRoot: string;
  /** Canonical relative file locator, with POSIX separators. */
  memoryLocator: string;
}

export interface FileMemoryFenceOptions {
  /** Acquisition deadline, not a time limit on the protected operation. */
  timeoutMs?: number;
}

interface Lease {
  lockPath: string;
  token: string;
  device: number;
  inode: number;
}

const LOCK_DIRECTORY = '.memory-fences';
const OWNER_FILE = 'owner';
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 25;

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function validateLocator(locator: string): string {
  if (
    typeof locator !== 'string' || !locator || locator.includes('\0') || locator.includes('\\') ||
    path.posix.isAbsolute(locator) || path.win32.isAbsolute(locator) ||
    locator.split('/').includes('..')
  ) {
    throw new TypeError('memoryLocator must be a relative, confined POSIX path without parent traversal');
  }
  const normalized = path.posix.normalize(locator);
  // Restrict unresolved filenames to one case and normalization form.
  if (normalized.split('/').some(segment => !/^[a-z0-9][a-z0-9._-]*$/.test(segment))) {
    throw new TypeError('memoryLocator must use lowercase ASCII path segments');
  }
  if (normalized === LOCK_DIRECTORY || normalized.startsWith(`${LOCK_DIRECTORY}/`)) {
    throw new TypeError('memoryLocator must name a memory file outside the fence directory');
  }
  return normalized;
}

export class FileMemoryFenceTimeoutError extends Error {
  constructor(lockPath: string, timeoutMs: number) {
    super(
      `Timed out waiting ${timeoutMs}ms for memory file fence ${lockPath}. ` +
      'Do not remove it while writers are running. Stop all writers, verify the owner is gone, ' +
      'then manually remove a crashed lease before retrying.'
    );
    this.name = 'FileMemoryFenceTimeoutError';
  }
}

export class FileMemoryFence {
  async withFence<T>(
    target: FileMemoryFenceTarget,
    operation: () => Promise<T> | T,
    options: FileMemoryFenceOptions = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new RangeError(`timeoutMs must be finite and between 0 and ${MAX_TIMEOUT_MS}`);
    }
    const lockPath = await this.resolveLockPath(target);
    const lease = await this.acquire(lockPath, timeoutMs);

    let result!: T;
    let operationError: unknown;
    let operationFailed = false;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
      operationFailed = true;
    }
    try {
      await this.release(lease);
    } catch (releaseError) {
      if (operationFailed) {
        throw new AggregateError(
          [operationError, releaseError],
          'Memory file operation failed and its fence could not be released',
          { cause: operationError },
        );
      }
      throw releaseError;
    }
    if (operationFailed) throw operationError;
    return result;
  }

  private async resolveLockPath(target: FileMemoryFenceTarget): Promise<string> {
    // Capture caller-owned values before the first asynchronous boundary.
    const suppliedRoot = target.tenantRoot;
    const locator = target.memoryLocator;
    if (process.platform === 'win32') {
      throw new Error('FileMemoryFence requires POSIX filesystem ownership and mode checks');
    }
    if (typeof suppliedRoot !== 'string' || !suppliedRoot) {
      throw new TypeError('tenantRoot must be a directory path');
    }
    const normalized = validateLocator(locator);
    const root = await fs.realpath(suppliedRoot);
    const relative = await this.resolveExistingComponents(root, normalized);
    const lockRoot = await this.ensureLockRoot(root);
    const key = createHash('sha256').update(root).update('\0').update(relative.split(path.sep).join('/')).digest('hex');
    return path.join(lockRoot, `${key}.lock`);
  }

  private async resolveExistingComponents(root: string, locator: string): Promise<string> {
    // Canonicalize every existing component. Symlink aliases are rejected,
    // rather than letting two spellings of one file acquire different locks.
    const segments = locator.split('/');
    let absolute = root;
    for (let index = 0; index < segments.length; index++) {
      const candidate = path.join(absolute, segments[index]);
      let stat;
      try {
        stat = await fs.lstat(candidate);
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
        absolute = path.join(candidate, ...segments.slice(index + 1));
        break;
      }
      if (stat.isSymbolicLink()) throw new Error('memoryLocator cannot traverse a symlink');
      if (index < segments.length - 1 && !stat.isDirectory()) {
        throw new Error('memoryLocator has a non-directory ancestor');
      }
      if (index === segments.length - 1 && stat.isFile() && stat.nlink > 1) {
        throw new Error('memoryLocator cannot target a hard-linked file');
      }
      absolute = await fs.realpath(candidate);
    }
    const relative = path.relative(root, absolute);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new TypeError('memoryLocator resolves outside tenantRoot');
    }

    return relative;
  }

  private async ensureLockRoot(root: string): Promise<string> {
    const lockRoot = path.join(root, LOCK_DIRECTORY);
    try {
      await fs.mkdir(lockRoot, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
    await this.assertRestrictedDirectory(lockRoot);
    return lockRoot;
  }

  private async assertRestrictedDirectory(directory: string): Promise<void> {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error(`Memory fence directory is not a private, non-symlink directory: ${directory}`);
    }
    if (process.getuid && stat.uid !== process.getuid()) {
      throw new Error(`Memory fence directory has another owner: ${directory}`);
    }
  }

  private async acquire(lockPath: string, timeoutMs: number): Promise<Lease> {
    const deadline = performance.now() + timeoutMs;
    while (true) {
      if (performance.now() >= deadline) throw new FileMemoryFenceTimeoutError(lockPath, timeoutMs);
      try {
        await fs.mkdir(lockPath, { mode: 0o700 });
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
        await this.waitForExistingLock(lockPath, deadline, timeoutMs);
        continue;
      }
      return this.initializeLease(lockPath);
    }
  }

  private async waitForExistingLock(lockPath: string, deadline: number, timeoutMs: number): Promise<void> {
    try {
      await this.assertRestrictedDirectory(lockPath);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      // The competing owner released between mkdir and inspection. The next
      // acquire loop still checks its deadline before attempting again.
      return;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new FileMemoryFenceTimeoutError(lockPath, timeoutMs);
    await delay(Math.min(POLL_INTERVAL_MS, remaining));
  }

  private async initializeLease(lockPath: string): Promise<Lease> {
    const stat = await fs.lstat(lockPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error('New memory fence lease is not a private directory');
    }
    const lease: Lease = {
      lockPath,
      token: randomBytes(32).toString('hex'),
      device: stat.dev,
      inode: stat.ino,
    };
    try {
      const owner = await fs.open(path.join(lockPath, OWNER_FILE), 'wx', 0o600);
      try {
        await owner.writeFile(lease.token, 'utf8');
        await owner.sync();
      } finally {
        await owner.close();
      }
      return lease;
    } catch (error) {
      // The directory belongs to this attempt. If setup cannot prove its
      // token, leave it fail-closed instead of deleting a changed lease.
      let cleanupError: unknown;
      try {
        await this.releaseFailedSetup(lease);
      } catch (failedRelease) {
        cleanupError = failedRelease;
      }
      if (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Memory fence acquisition failed and left a lock', { cause: error });
      }
      throw error;
    }
  }

  private async releaseFailedSetup(lease: Lease): Promise<void> {
    const directory = await fs.lstat(lease.lockPath);
    if (!directory.isDirectory() || directory.isSymbolicLink() ||
      directory.dev !== lease.device || directory.ino !== lease.inode) {
      throw new Error('Memory fence lease changed during failed setup');
    }
    try {
      await fs.lstat(path.join(lease.lockPath, OWNER_FILE));
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      // Our mkdir succeeded, but owner creation failed. Remove only the empty
      // directory we still own; a process crash has no cleanup path.
      await fs.rmdir(lease.lockPath);
      return;
    }
    await this.release(lease);
  }

  private async release(lease: Lease): Promise<void> {
    const directory = await fs.lstat(lease.lockPath);
    if (!directory.isDirectory() || directory.isSymbolicLink() ||
      directory.dev !== lease.device || directory.ino !== lease.inode) {
      throw new Error('Memory fence lease changed; refusing to release another owner');
    }
    const ownerPath = path.join(lease.lockPath, OWNER_FILE);
    const owner = await fs.lstat(ownerPath);
    if (!owner.isFile() || owner.isSymbolicLink() || (owner.mode & 0o077) !== 0 ||
      await fs.readFile(ownerPath, 'utf8') !== lease.token) {
      throw new Error('Memory fence owner token changed; refusing to release another owner');
    }
    await fs.unlink(ownerPath);
    const afterUnlink = await fs.lstat(lease.lockPath);
    if (afterUnlink.dev !== lease.device || afterUnlink.ino !== lease.inode || !afterUnlink.isDirectory()) {
      throw new Error('Memory fence lease changed during release; leaving it fail-closed');
    }
    await fs.rmdir(lease.lockPath);
  }
}
