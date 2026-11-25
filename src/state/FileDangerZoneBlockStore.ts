import os from 'node:os';
import path from 'node:path';
import { watch, type FSWatcher, type Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { FileOperationsService } from '../services/FileOperationsService.js';
import { BlockStateValidationError } from '../security/BlockStateValidationError.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { logger } from '../utils/logger.js';
import type { IDangerZoneBlockStore, BlockMutation } from './IDangerZoneBlockStore.js';
import { isStateObject, type PersistedStateRead } from './persistence-utils.js';
import { MAX_BLOCK_SNAPSHOT_BYTES, readDangerZoneBlockSnapshot } from './readDangerZoneBlockSnapshot.js';

const REPAIR_PROBE_MS = 1000;
type ReadResult = PersistedStateRead<Record<string, unknown>>;
type RejectedRead = Exclude<ReadResult, { status: 'absent' | 'loaded' }>;
class SnapshotChangedError extends Error {}

interface RejectedSnapshot {
  revision?: string;
  retryUnreadable: boolean;
  digest?: string;
  evidence?: string;
  pendingEvidence?: string;
}

function revisionOf(stats: Stats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(':');
}

function digestOf(bytes: string): string {
  return createHash('sha256').update(bytes, 'latin1').digest('hex');
}

/**
 * Local file store. Cooperating writers serialize changes and rebase them on the
 * current on-disk snapshot. Readers validate a new revision before enforcing it.
 * Evidence copies named <file>.<uuid>.backup are retained until removed by an operator.
 */
export class FileDangerZoneBlockStore implements IDangerZoneBlockStore {
  readonly location: string;
  private liveSnapshot: Record<string, unknown> | undefined;
  private liveRevision?: string;
  private hadFile = false;
  private rejected?: RejectedSnapshot;

  constructor(private readonly fileOps: FileOperationsService, directory = path.join(os.homedir(), '.dollhouse', 'security')) {
    this.location = path.join(directory, 'blocked-agents.json');
  }

  load(refresh = false): Promise<ReadResult> {
    return this.readSnapshot(refresh);
  }

  private async readSnapshot(refresh: boolean): Promise<ReadResult> {
    const rejected = this.rejected;
    if (rejected?.pendingEvidence !== undefined && !await this.preserveEvidence(rejected)) {
      return { status: 'unreadable', cause: new Error('Rejected block snapshot evidence could not be saved') };
    }

    try {
      const before = typeof this.fileOps.stat === 'function' ? await this.fileOps.stat(this.location) : undefined;
      return await this.readObservedSnapshot(refresh, before);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT' && !rejected && !this.hadFile) {
        return { status: 'absent' };
      }
      return this.reject({ status: 'unreadable', cause }, undefined);
    }
  }

  private async readObservedSnapshot(refresh: boolean, before?: Stats): Promise<ReadResult> {
    const revision = before && revisionOf(before);
    if (refresh && this.liveSnapshot && revision === this.liveRevision) {
      return { status: 'loaded', value: this.liveSnapshot };
    }
    let bytes: string | undefined;
    const result = await readDangerZoneBlockSnapshot(async () => {
      bytes = await this.readCheckedBytes(before, revision);
      return Buffer.from(bytes, 'latin1').toString('utf8');
    }, before && (() => Promise.resolve(before)));

    if (result.status === 'loaded') {
      this.acceptSnapshot(result.value, revision, bytes);
      return result;
    }
    if (result.status !== 'absent') return this.reject(result, revision, bytes);
    if (before || this.rejected || this.hadFile) {
      return this.reject({ status: 'unreadable', cause: new SnapshotChangedError('Blocked-agent file disappeared while being read') }, revision);
    }
    this.liveSnapshot = {};
    return result;
  }

  private async readCheckedBytes(before?: Stats, revision?: string): Promise<string> {
    const content = await this.readBytes(this.location);
    // A valid JSON prefix or a complete read of the old inode still fails this check.
    if (before) {
      const after = await this.fileOps.stat(this.location);
      if (revisionOf(after) !== revision || content.length !== before.size) {
        throw new SnapshotChangedError('Blocked-agent file changed or the read was incomplete');
      }
    }
    return content;
  }

  private readBytes(file: string): Promise<string> {
    // Latin-1 is a lossless string representation of the bytes for evidence and digests.
    return this.fileOps.readFile(file, { encoding: 'latin1', maxSize: MAX_BLOCK_SNAPSHOT_BYTES });
  }

  private acceptSnapshot(blocks: Record<string, unknown>, revision?: string, bytes?: string): void {
    const rejected = this.rejected;
    if (rejected && bytes !== undefined) {
      SecurityMonitor.logSecurityEvent({
        type: 'DANGER_ZONE_OPERATION', severity: 'HIGH', source: 'FileDangerZoneBlockStore.load',
        details: 'Externally repaired blocked-agent state loaded',
        additionalData: {
          previousDigest: rejected.digest ?? null,
          currentDigest: digestOf(bytes),
        },
      });
    }
    this.rejected = undefined;
    this.liveSnapshot = blocks;
    this.liveRevision = revision;
    this.hadFile = true;
  }

  private async reject(result: RejectedRead, revision: string | undefined, bytes?: string): Promise<ReadResult> {
    const reason = rejectionReason(result);
    if (!this.rejected || revision !== this.rejected.revision) {
      logger.warn('Rejected blocked-agent snapshot', { reason });
    }
    await this.recordRejection(revision, result.status === 'unreadable', bytes);
    return result;
  }

  private async recordRejection(revision: string | undefined, retryUnreadable: boolean, bytes?: string): Promise<void> {
    this.liveSnapshot = undefined;
    const rejected = this.rejected ?? { retryUnreadable };
    this.rejected = rejected;
    rejected.revision = revision;
    rejected.retryUnreadable = retryUnreadable;
    if (bytes === undefined || bytes.length > MAX_BLOCK_SNAPSHOT_BYTES) return;
    const digest = digestOf(bytes);
    if (digest === rejected.digest && rejected.evidence) return;
    rejected.digest = digest;
    rejected.evidence = undefined;
    rejected.pendingEvidence = bytes;
    await this.preserveEvidence(rejected);
  }

  private async preserveEvidence(rejected: RejectedSnapshot): Promise<boolean> {
    const bytes = rejected.pendingEvidence;
    if (bytes === undefined) return true;
    const evidence = `${this.location}.${randomUUID()}.backup`;
    try {
      const saved = await this.fileOps.createFileExclusive(evidence, bytes, { encoding: 'latin1', mode: 0o600, maxSize: MAX_BLOCK_SNAPSHOT_BYTES });
      if (!saved) throw new Error('Evidence filename already exists');
      rejected.evidence = evidence;
      rejected.pendingEvidence = undefined;
      return true;
    } catch (error) {
      logger.warn('Could not preserve rejected blocked-agent state', { error });
      return false;
    }
  }

  private async recoveryMayHaveChanged(): Promise<boolean> {
    const rejected = this.rejected;
    if (!rejected) return false;
    if (rejected.pendingEvidence !== undefined || rejected.retryUnreadable) return true;
    try {
      return revisionOf(await this.fileOps.stat(this.location)) !== rejected.revision;
    } catch {
      return false;
    }
  }

  watchForRecovery(retry: () => Promise<void>): () => void {
    let closed = false;
    let running = false;
    let nextProbe = 0;
    const probe = () => {
      if (closed || running || Date.now() < nextProbe) return;
      running = true;
      nextProbe = Date.now() + REPAIR_PROBE_MS;
      void this.recoveryMayHaveChanged().then(async changed => {
        if (changed && !closed) await retry();
      }).catch(error => {
        logger.warn('Blocked-agent file recovery probe failed', { error });
      }).finally(() => { running = false; });
    };
    const timer = setInterval(probe, REPAIR_PROBE_MS);
    timer.unref();
    let watcher: FSWatcher | undefined;
    try {
      const basename = path.basename(this.location);
      watcher = watch(path.dirname(this.location), { persistent: false }, (_event, filename) => {
        if (!filename || filename === basename) probe();
      });
      watcher.on('error', () => watcher?.close());
    } catch {
      // The timer also handles directories that do not exist yet.
    }

    return () => {
      closed = true;
      clearInterval(timer);
      watcher?.close();
    };
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.fileOps.createDirectory(path.dirname(this.location), 0o700);
    return this.fileOps.withWriteLock(this.location, operation);
  }

  private async writeSnapshot(blocks: Record<string, unknown>): Promise<void> {
    await this.fileOps.writeFile(this.location, JSON.stringify({ version: 1, blocks }, null, 2));
    this.acceptSnapshot(blocks);
  }

  async save(blocks: Record<string, unknown>): Promise<void> {
    await this.withLock(() => this.writeSnapshot(blocks));
  }

  async apply(mutation: BlockMutation): Promise<false | { snapshot: Record<string, unknown> }> {
    return this.withLock(async () => {
      // A writer can queue behind another process after the enforcer's last load.
      const loaded = await this.readSnapshot(true);
      if (loaded.status !== 'loaded' && loaded.status !== 'absent') {
        throw new Error('Blocked-agent snapshot could not be validated before writing');
      }
      const blocks: Record<string, unknown> = Object.assign(Object.create(null), loaded.status === 'loaded' ? loaded.value : {});
      const next = applyMutation(blocks, mutation);
      if (!next) return false;
      await this.writeSnapshot(next);
      return { snapshot: next };
    });
  }

  private async existingEvidence(): Promise<string | undefined> {
    const rejected = this.rejected;
    if (!rejected?.evidence) return undefined;
    try {
      const current = digestOf(await this.readBytes(this.location));
      const retained = digestOf(await this.readBytes(rejected.evidence));
      return current === rejected.digest && retained === current ? rejected.evidence : undefined;
    } catch {
      return undefined;
    }
  }

  async reset(): Promise<string> {
    return this.withLock(async () => {
      const existingEvidence = await this.existingEvidence();
      const evidence = existingEvidence ?? await this.copyResetEvidence();
      await this.writeSnapshot({});
      return evidence;
    });
  }

  private async copyResetEvidence(): Promise<string> {
    const evidence = `${this.location}.${randomUUID()}.backup`;
    try {
      await this.fileOps.copyFile(this.location, evidence, { exclusive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
    await this.fileOps.chmod(evidence, 0o600);
    return evidence;
  }
}

function rejectionReason(result: RejectedRead): string {
  if (result.status === 'unsupportedVersion') return 'unsupported version';
  if (result.status === 'unreadable') {
    if (result.cause instanceof SnapshotChangedError) return result.cause.message;
    if ((result.cause as NodeJS.ErrnoException)?.code === 'ENOENT') return 'file disappeared or is missing';
    return 'file read failed';
  }
  if (result.cause instanceof SyntaxError) return 'malformed JSON';
  // Only the snapshot validator creates these messages. Parser and I/O errors may contain raw data.
  if (result.cause instanceof BlockStateValidationError) return result.cause.message;
  return 'invalid snapshot envelope';
}

function eventIdOf(block: unknown): unknown {
  return isStateObject(block) ? block.eventId ?? block.verificationId : undefined;
}

function blockedAtOf(block: unknown): number {
  const date = isStateObject(block) && typeof block.blockedAt === 'string' ? Date.parse(block.blockedAt) : Number.NaN;
  return Number.isNaN(date) ? 0 : date;
}

function applyMutation(blocks: Record<string, unknown>, mutation: BlockMutation): Record<string, unknown> | undefined {
  if (mutation.kind === 'clear') return {};
  const current = blocks[mutation.name];
  if (mutation.kind === 'remove') {
    if (!Object.hasOwn(blocks, mutation.name) || eventIdOf(current) !== mutation.eventId) return undefined;
    delete blocks[mutation.name];
  } else {
    if (blockedAtOf(current) > blockedAtOf(mutation.block)) return undefined;
    blocks[mutation.name] = mutation.block;
  }
  return blocks;
}
