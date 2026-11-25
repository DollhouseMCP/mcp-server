import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SecurityMonitor } from '../security/securityMonitor.js';

const WAIT_LIMIT_MS = 10 * 60 * 1000;
const RETRY_MS = 100;
const HOST = createHash('sha256').update(hostname()).digest('hex');
const OWNER_NAME = /^owner-([1-9]\d{0,9})-([0-9a-f]{64})-[0-9a-f-]{36}$/u;
const RENAME_CONFLICT = new Set(['EEXIST', 'ENOTEMPTY', 'EACCES', 'EPERM', 'EBUSY']);
const DIRECTORY_IN_USE = new Set(['ENOENT', 'ENOTEMPTY', 'EEXIST']);

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | null)?.code ?? '';
}

function deadLocalOwner(marker: string): number | undefined {
  const match = OWNER_NAME.exec(marker);
  if (!match || match[2] !== HOST) return undefined;
  const pid = Number(match[1]);
  if (pid > 2_147_483_647) return undefined;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return pid;
  }
  return undefined;
}

async function unlinkMarker(directory: string, marker: string): Promise<boolean> {
  try {
    await fs.unlink(path.join(directory, marker));
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  try {
    await fs.rmdir(directory);
  } catch (error) {
    // A new owner may have already published a nonempty directory here.
    if (!DIRECTORY_IN_USE.has(errorCode(error))) throw error;
  }
}

async function reclaim(lockPath: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(lockPath, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  if (entries.length === 0) {
    await removeEmptyDirectory(lockPath);
    return;
  }

  if (entries.length !== 1 || !entries[0].isFile()) return;
  const marker = entries[0].name;
  const pid = deadLocalOwner(marker);
  if (pid === undefined || !await unlinkMarker(lockPath, marker)) return;
  SecurityMonitor.logSecurityEvent({
    type: 'DANGER_ZONE_OPERATION',
    severity: 'HIGH',
    source: 'RecoverableFileWriteLock',
    details: 'Reclaimed the file write lock of a dead local process',
    additionalData: { pid },
  });
  await removeEmptyDirectory(lockPath);
}

async function acquire(staging: string, lockPath: string, deadline: number): Promise<void> {
  if (performance.now() >= deadline) throw new Error('Timed out waiting for the file write lock');
  try {
    await fs.rename(staging, lockPath);
    return;
  } catch (error) {
    if (!RENAME_CONFLICT.has(errorCode(error))) throw error;
  }

  await reclaim(lockPath);
  await delay(Math.min(RETRY_MS, Math.max(0, deadline - performance.now())));
  return acquire(staging, lockPath, deadline);
}

/**
 * Writers sharing a local filesystem and PID namespace publish a nonempty
 * lock directory atomically. The unique marker is the only entry a reclaimer
 * can unlink. A crashed reclaimer can leave an empty directory, which any
 * writer can remove without disturbing a published owner.
 */
export async function withRecoverableFileWriteLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  timeoutMs = WAIT_LIMIT_MS,
): Promise<T> {
  const staging = await fs.mkdtemp(`${lockPath}.pending-`);
  const marker = `owner-${process.pid}-${HOST}-${randomUUID()}`;
  let ownedDirectory = staging;
  try {
    await fs.writeFile(path.join(staging, marker), '', { flag: 'wx', mode: 0o600 });
    await acquire(staging, lockPath, performance.now() + timeoutMs);
    ownedDirectory = lockPath;
    return await operation();
  } finally {
    await unlinkMarker(ownedDirectory, marker);
    await removeEmptyDirectory(ownedDirectory);
  }
}
