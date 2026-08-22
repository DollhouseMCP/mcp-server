/**
 * FilesystemSigningKeyStore
 *
 * Durable JSON-on-disk backend. Single file at `<rootDir>/signing-keys.json`
 * holds the full set of keys (active + rotated). Atomic write-temp + rename
 * via `FileLockManager`; reads tolerate ENOENT (returns empty set) and fail
 * closed on malformed JSON after preserving a quarantine copy.
 *
 * Single-file (rather than file-per-kid) because:
 *   - Rotation is a multi-row update (mark old inactive + insert new),
 *     which is naturally atomic when the whole set is one file.
 *   - Number of keys is small (one active per kind + a short rotation
 *     audit tail).
 *
 * @module storage/signingKeys/FilesystemSigningKeyStore
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { FileLockManager } from '../../security/fileLockManager.js';
import {
  parseFilesystemProcessIncarnation,
  readFilesystemProcessIncarnation,
  sameFilesystemProcessIncarnation,
  withFilesystemInterprocessGuard,
  type FilesystemProcessIncarnation,
} from '../../security/filesystemInterprocessGuard.js';
import { logger } from '../../utils/logger.js';
import type {
  ISigningKeyStore,
  SigningKey,
  SigningKeyKind,
  SigningKeyModeTransition,
  SigningKeyModeTransitionResult,
  SigningKeyWrite,
} from './ISigningKeyStore.js';
import {
  cloneSigningKey,
  inheritAuthorizationGeneration,
  SigningKeyLifecycleConflictError,
  stageSigningKeyModeTransition,
} from './signingKeyLifecycle.js';

export interface FilesystemSigningKeyStoreOptions {
  /** Directory holding `signing-keys.json`. */
  rootDir: string;
  /** @internal Test-only seams for forced process-lock crash interleavings. */
  processLockHooks?: FilesystemSigningKeyStoreProcessLockHooks;
}

export interface FilesystemSigningKeyStoreProcessLockHooks {
  readonly beforeInitialPublish?: (temporaryPath: string) => Promise<void>;
  readonly afterReleaseRename?: (releasedPath: string) => Promise<void>;
  readonly processIncarnationProvider?: (
    pid: number,
  ) => Promise<FilesystemProcessIncarnation | null>;
}

export class SigningKeyStoreCorruptionError extends Error {
  constructor(message: string, readonly quarantinePath: string) {
    super(message);
    this.name = 'SigningKeyStoreCorruptionError';
  }
}

const PROCESS_LOCK_STALE_MS = 30_000;
const PROCESS_LOCK_HEARTBEAT_MS = 5_000;
const PROCESS_LOCK_ACQUIRE_TIMEOUT_MS = PROCESS_LOCK_STALE_MS + 10_000;
const STATE_TEMP_SUFFIX = '.tmp';
const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EBADF', 'EISDIR', 'EPERM']);

interface ProcessLockRecord {
  ownerToken: string;
  pid: number;
  host: string;
  incarnation: FilesystemProcessIncarnation | null;
  state: 'held' | 'released';
  createdAt: number;
  updatedAt: number;
}

interface ProcessLockSnapshot {
  record: ProcessLockRecord | null;
  mtimeMs: number;
  device: number;
  inode: number;
}

interface ProcessLockLease {
  ownerToken: string;
  handle: fs.FileHandle;
  record: ProcessLockRecord;
  heartbeat: NodeJS.Timeout | null;
  lost: boolean;
}

export class FilesystemSigningKeyStore implements ISigningKeyStore {
  private readonly rootDir: string;
  private readonly filePath: string;
  private readonly corruptionMarkerPath: string;
  private readonly locks = new FileLockManager();
  private readonly processLockPath: string;
  private readonly processLockGuardPath: string;
  private readonly processLockHooks?: FilesystemSigningKeyStoreProcessLockHooks;
  private activeProcessLease: ProcessLockLease | null = null;

  constructor(options: FilesystemSigningKeyStoreOptions) {
    this.rootDir = options.rootDir;
    this.filePath = path.join(this.rootDir, 'signing-keys.json');
    this.corruptionMarkerPath = `${this.filePath}.corrupt`;
    this.processLockPath = path.join(this.rootDir, '.signing-keys.lock');
    this.processLockGuardPath = path.join(this.rootDir, '.signing-keys.lock.guard');
    this.processLockHooks = options.processLockHooks;
  }

  async getActive(kind: SigningKeyKind): Promise<SigningKey | null> {
    const all = await this.readAll();
    return all.find((k) => k.kind === kind && k.active) ?? null;
  }

  async getByKid(kid: string): Promise<SigningKey | null> {
    const all = await this.readAll();
    return all.find((k) => k.kid === kid) ?? null;
  }

  async listByKind(kind: SigningKeyKind): Promise<SigningKey[]> {
    const all = await this.readAll();
    return all.filter((k) => k.kind === kind).sort((a, b) => b.createdAt - a.createdAt);
  }

  async withActiveKey<T>(kind: SigningKeyKind, operation: (key: SigningKey) => Promise<T>): Promise<T> {
    return this.withWriteLock(async () => {
      const key = (await this.readAllRaw()).find(candidate =>
        candidate.kind === kind && candidate.active && candidate.retiredAt === undefined);
      if (!key) throw new Error(`No active '${kind}' signing key is available`);
      return operation(cloneSigningKey(key));
    });
  }

  async rotate(write: SigningKeyWrite): Promise<SigningKey> {
    return this.withWriteLock(async () => {
      const all = await this.readAllRaw();
      if (all.some((k) => k.kid === write.kid)) {
        throw new Error(
          `SigningKeyStore: kid '${write.kid}' already exists; rotation requires a fresh kid.`,
        );
      }
      const now = Date.now();
      const current = all.find(key => key.kind === write.kind && key.active);
      const effectiveWrite = inheritAuthorizationGeneration(current, write);
      // Mark existing active of this kind as inactive
      for (const key of all) {
        if (key.kind === write.kind && key.active) {
          key.active = false;
          key.rotatedAt = now;
        }
      }
      const newKey: SigningKey = {
        kid: effectiveWrite.kid,
        kind: effectiveWrite.kind,
        payload: effectiveWrite.payload,
        active: true,
        createdAt: now,
      };
      all.push(newKey);
      await this.writeAll(all);
      return newKey;
    });
  }

  async assertActiveKey(kid: string, kind: SigningKeyKind): Promise<SigningKey> {
    const key = await this.getByKid(kid);
    if (!key || key.kind !== kind || !key.active || key.retiredAt !== undefined) {
      throw new SigningKeyLifecycleConflictError(
        `Signing key '${kid}' is no longer the active '${kind}' key`,
      );
    }
    return cloneSigningKey(key);
  }

  async transitionAuthorizationMode(
    transition: SigningKeyModeTransition,
  ): Promise<SigningKeyModeTransitionResult> {
    return this.withWriteLock(async () => {
      const staged = stageSigningKeyModeTransition(
        await this.readAllRaw(),
        transition,
        transition.transitionedAt,
      );
      await this.writeAll(staged.keys);
      return {
        transitionId: staged.transitionId,
        alreadyApplied: staged.alreadyApplied,
        retired: staged.retired.map(cloneSigningKey),
        installed: staged.installed.map(cloneSigningKey),
      };
    });
  }

  async pruneRotatedBefore(beforeEpochMs: number): Promise<number> {
    return this.withWriteLock(async () => {
      const all = await this.readAllRaw();
      const before = all.length;
      const kept = all.filter(
        (k) => k.active || k.rotatedAt === undefined || k.rotatedAt >= beforeEpochMs,
      );
      const removed = before - kept.length;
      if (removed > 0) {
        await this.writeAll(kept);
      }
      return removed;
    });
  }

  async retire(kid: string, retiredAt: number = Date.now()): Promise<SigningKey | null> {
    return this.withWriteLock(async () => {
      const all = await this.readAllRaw();
      const key = all.find(candidate => candidate.kid === kid);
      if (!key) return null;
      key.active = false;
      key.rotatedAt ??= retiredAt;
      key.retiredAt ??= retiredAt;
      await this.writeAll(all);
      return structuredClone(key);
    });
  }

  async delete(kid: string, options: { readonly force?: boolean } = {}): Promise<boolean> {
    return this.withWriteLock(async () => {
      const all = await this.readAllRaw();
      const key = all.find(candidate => candidate.kid === kid);
      if (!key) return false;
      if (!options.force && (key.active || key.retiredAt === undefined)) return false;
      const kept = all.filter(candidate => candidate.kid !== kid);
      await this.writeAll(kept);
      return true;
    });
  }

  private async readAll(): Promise<SigningKey[]> {
    return this.readAllRaw();
  }

  private async readAllRaw(): Promise<SigningKey[]> {
    await this.throwIfPreviouslyQuarantined();
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return this.failClosedOnCorruption('root value is not an array');
      }
      const validationError = validateSigningKeyState(parsed);
      if (validationError) return this.failClosedOnCorruption(validationError);
      return parsed as SigningKey[];
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      if (err instanceof SyntaxError) {
        return this.failClosedOnCorruption(`JSON parse failed: ${err.message}`);
      }
      throw err;
    }
  }

  private async failClosedOnCorruption(reason: string): Promise<never> {
    await this.ensureRoot();
    try {
      // Publish one stable quarantine inode without replacing an existing marker.
      // A crash between link and unlink leaves both names pointing to the same
      // corrupt inode, while every subsequent read still fails closed on marker.
      await fs.link(this.filePath, this.corruptionMarkerPath);
      await fs.chmod(this.corruptionMarkerPath, 0o600);
      await fs.unlink(this.filePath).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      await this.syncRootDirectory();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOENT') throw error;
      await this.throwIfPreviouslyQuarantined();
      throw error;
    }
    logger.error('[SigningKeyStore:fs] signing-key state is corrupt; refusing implicit replacement', {
      path: this.filePath,
      quarantinePath: this.corruptionMarkerPath,
      reason,
    });
    throw new SigningKeyStoreCorruptionError(
      `Signing-key state at '${this.filePath}' is corrupt (${reason}); preserved at '${this.corruptionMarkerPath}'`,
      this.corruptionMarkerPath,
    );
  }

  private async throwIfPreviouslyQuarantined(): Promise<void> {
    try {
      await fs.lstat(this.corruptionMarkerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    throw new SigningKeyStoreCorruptionError(
      `Signing-key state remains quarantined at '${this.corruptionMarkerPath}'`,
      this.corruptionMarkerPath,
    );
  }

  private async ensureRoot(): Promise<void> {
    try {
      await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      await fs.chmod(this.rootDir, 0o700);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }

  private async writeAll(keys: readonly SigningKey[]): Promise<void> {
    await this.ensureRoot();
    await this.assertCurrentProcessLockOwner();
    const temporaryPath = `${this.filePath}.${randomUUID()}${STATE_TEMP_SUFFIX}`;
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(keys, null, 2), 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      // Recheck after the potentially slow write/fsync and immediately before
      // publishing the new state inode.
      await this.assertCurrentProcessLockOwner();
      await fs.rename(temporaryPath, this.filePath);
      await this.syncRootDirectory();
    } finally {
      await handle?.close().catch(() => {});
      await fs.unlink(temporaryPath).catch(() => {});
    }
  }

  private async syncRootDirectory(): Promise<void> {
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(this.rootDir, 'r');
      await handle.sync();
    } catch (error) {
      if (!DIRECTORY_SYNC_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? '')) {
        throw error;
      }
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.locks.withLock(`signing-keys:${this.filePath}`, async () => {
      await this.ensureRoot();
      const lease = await this.acquireProcessLock();
      this.activeProcessLease = lease;
      try {
        return await operation();
      } finally {
        this.activeProcessLease = null;
        await this.releaseProcessLock(lease);
      }
    });
  }

  private async acquireProcessLock(): Promise<ProcessLockLease> {
    const deadline = Date.now() + PROCESS_LOCK_ACQUIRE_TIMEOUT_MS;
    const ownerToken = randomUUID();
    while (Date.now() < deadline) {
      const lease = await withFilesystemInterprocessGuard(this.processLockGuardPath, async () => {
        const published = await this.publishProcessLock(ownerToken);
        if (published) return published;

        const snapshot = await this.readProcessLockSnapshot();
        if (!snapshot || !(await this.canTakeOverProcessLock(snapshot))) return null;
        if (!(await this.quarantineProcessLock(snapshot))) return null;
        return this.publishProcessLock(ownerToken);
      });
      if (lease) {
        lease.heartbeat = setInterval(() => {
          void this.refreshProcessLockLease(lease);
        }, PROCESS_LOCK_HEARTBEAT_MS);
        lease.heartbeat.unref();
        return lease;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Timed out acquiring signing-key filesystem lock');
  }

  private async publishProcessLock(ownerToken: string): Promise<ProcessLockLease | null> {
    const temporaryPath = `${this.processLockPath}.${ownerToken}.tmp`;
    const now = Date.now();
    const identityProvider = this.processLockHooks?.processIncarnationProvider
      ?? readFilesystemProcessIncarnation;
    const incarnation = await identityProvider(process.pid).catch(() => null);
    const record: ProcessLockRecord = {
      ownerToken,
      pid: process.pid,
      host: hostname(),
      incarnation,
      state: 'held',
      createdAt: now,
      updatedAt: now,
    };
    let handle: fs.FileHandle | null = null;
    let published = false;
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await this.writeNewProcessLockRecord(handle, record);
      await this.processLockHooks?.beforeInitialPublish?.(temporaryPath);
      try {
        // Publish only the already-complete inode. A hard-link collision means
        // another process won without exposing either writer's partial bytes.
        await fs.link(temporaryPath, this.processLockPath);
        await this.syncRootDirectory();
        published = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        return null;
      }
      return {
        ownerToken,
        handle,
        record,
        heartbeat: null,
        lost: false,
      };
    } finally {
      await fs.unlink(temporaryPath).catch(() => {});
      if (!published) await handle?.close().catch(() => {});
    }
  }

  private async refreshProcessLockLease(lease: ProcessLockLease): Promise<void> {
    if (lease.lost || !(await this.isCurrentProcessLockOwner(lease.ownerToken))) {
      lease.lost = true;
      return;
    }
    const now = new Date();
    await lease.handle.utimes(now, now).catch(() => {
      lease.lost = true;
    });
  }

  private async releaseProcessLock(lease: ProcessLockLease): Promise<void> {
    if (lease.heartbeat) clearInterval(lease.heartbeat);
    try {
      await withFilesystemInterprocessGuard(this.processLockGuardPath, async () => {
        const snapshot = await this.readProcessLockSnapshot();
        if (snapshot?.record?.state === 'held' && snapshot.record.ownerToken === lease.ownerToken) {
          await lease.handle.close().catch(() => {});
          await this.quarantineProcessLock(
            snapshot,
            'released',
            this.processLockHooks?.afterReleaseRename,
          );
        }
      });
    } finally {
      await lease.handle.close().catch(() => {});
    }
  }

  private async assertCurrentProcessLockOwner(): Promise<void> {
    const lease = this.activeProcessLease;
    if (!lease || lease.lost || !(await this.isCurrentProcessLockOwner(lease.ownerToken))) {
      if (lease) lease.lost = true;
      throw new Error('Signing-key filesystem lock ownership was lost before write');
    }
  }

  private async isCurrentProcessLockOwner(ownerToken: string): Promise<boolean> {
    const snapshot = await this.readProcessLockSnapshot();
    return snapshot?.record?.state === 'held' && snapshot.record.ownerToken === ownerToken;
  }

  private async canTakeOverProcessLock(snapshot: ProcessLockSnapshot): Promise<boolean> {
    if (snapshot.record?.state === 'released') return true;
    if (snapshot.record?.host === hostname()) {
      if (!this.isProcessAlive(snapshot.record.pid)) return true;
      if (snapshot.record.incarnation) {
        const identityProvider = this.processLockHooks?.processIncarnationProvider
          ?? readFilesystemProcessIncarnation;
        const current = await identityProvider(snapshot.record.pid).catch(() => null);
        if (current && !sameFilesystemProcessIncarnation(snapshot.record.incarnation, current)) {
          return true;
        }
      }
    }
    // Atomic publishers never expose malformed records. A stale malformed
    // record can only be a legacy partial publication or interrupted legacy
    // release; wait out the lease window before reclaiming it so an older live
    // writer still gets a conservative rollout grace period.
    if (!snapshot.record && Date.now() - snapshot.mtimeMs >= PROCESS_LOCK_STALE_MS) return true;
    // Never steal a held lease based on age alone. A live owner can pause after
    // its final ownership check and resume with an atomic rename; time-only
    // takeover would then let that stale writer overwrite its successor. A
    // same-host dead PID is provable, while cross-host crash recovery requires
    // explicit operator cleanup or a distributed lock backend.
    return false;
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  private async quarantineProcessLock(
    expected: ProcessLockSnapshot,
    suffix = 'stale',
    afterRename?: (quarantinePath: string) => Promise<void>,
  ): Promise<boolean> {
    const current = await this.readProcessLockSnapshot();
    if (!current || current.device !== expected.device || current.inode !== expected.inode) {
      return false;
    }
    const quarantinePath = `${this.processLockPath}.${randomUUID()}.${suffix}`;
    try {
      await fs.rename(this.processLockPath, quarantinePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }

    const quarantined = await this.readProcessLockSnapshot(quarantinePath);
    const sameFile = quarantined?.device === expected.device && quarantined.inode === expected.inode;
    if (!sameFile) {
      await this.restoreQuarantinedProcessLock(quarantinePath);
      throw new Error('Signing-key filesystem lock changed during stale takeover');
    }
    await this.syncRootDirectory();
    await afterRename?.(quarantinePath);
    await fs.unlink(quarantinePath).catch(() => {});
    await this.syncRootDirectory();
    return true;
  }

  private async restoreQuarantinedProcessLock(quarantinePath: string): Promise<void> {
    try {
      await fs.link(quarantinePath, this.processLockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      await fs.unlink(quarantinePath).catch(() => {});
    }
  }

  private async readProcessLockSnapshot(
    lockPath: string = this.processLockPath,
  ): Promise<ProcessLockSnapshot | null> {
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(lockPath, 'r');
      const [raw, stat] = await Promise.all([handle.readFile('utf8'), handle.stat()]);
      return {
        record: this.parseProcessLockRecord(raw),
        mtimeMs: stat.mtimeMs,
        device: stat.dev,
        inode: stat.ino,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  private parseProcessLockRecord(raw: string): ProcessLockRecord | null {
    try {
      const parsed = JSON.parse(raw) as Partial<ProcessLockRecord>;
      const incarnation = parseFilesystemProcessIncarnation(parsed.incarnation);
      if (typeof parsed.ownerToken !== 'string' ||
          typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 ||
          typeof parsed.host !== 'string' || parsed.host.length === 0 ||
          (parsed.state !== 'held' && parsed.state !== 'released') ||
          typeof parsed.createdAt !== 'number' || !Number.isFinite(parsed.createdAt) ||
          typeof parsed.updatedAt !== 'number' || !Number.isFinite(parsed.updatedAt) ||
          incarnation === undefined) {
        return null;
      }
      return { ...parsed, incarnation } as ProcessLockRecord;
    } catch {
      return null;
    }
  }

  private async writeNewProcessLockRecord(
    handle: fs.FileHandle,
    record: ProcessLockRecord,
  ): Promise<void> {
    const serialized = Buffer.from(JSON.stringify(record), 'utf8');
    try {
      await handle.write(serialized, 0, serialized.length, 0);
      await handle.sync();
    } finally {
      serialized.fill(0);
    }
  }
}

function validateSigningKeyState(value: readonly unknown[]): string | null {
  const kids = new Set<string>();
  const activeKinds = new Set<SigningKeyKind>();
  for (const [index, candidate] of value.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return `entry ${index} is not an object`;
    }
    const key = candidate as Partial<SigningKey>;
    if (typeof key.kid !== 'string' || key.kid.length === 0) return `entry ${index} has an invalid kid`;
    if (key.kind !== 'jwks' && key.kind !== 'cookie' && key.kind !== 'invite') {
      return `entry ${index} has an invalid kind`;
    }
    if (!key.payload || typeof key.payload !== 'object' || Array.isArray(key.payload)) {
      return `entry ${index} has an invalid payload`;
    }
    if (typeof key.active !== 'boolean') return `entry ${index} has an invalid active flag`;
    if (!validEpoch(key.createdAt)) return `entry ${index} has an invalid createdAt`;
    if (key.rotatedAt !== undefined && !validEpoch(key.rotatedAt)) {
      return `entry ${index} has an invalid rotatedAt`;
    }
    if (key.retiredAt !== undefined && !validEpoch(key.retiredAt)) {
      return `entry ${index} has an invalid retiredAt`;
    }
    if (kids.has(key.kid)) return `entry ${index} duplicates kid '${key.kid}'`;
    kids.add(key.kid);
    if (key.active) {
      if (key.retiredAt !== undefined) return `entry ${index} is both active and retired`;
      if (activeKinds.has(key.kind)) return `multiple active '${key.kind}' keys exist`;
      activeKinds.add(key.kind);
    }
  }
  return null;
}

function validEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
