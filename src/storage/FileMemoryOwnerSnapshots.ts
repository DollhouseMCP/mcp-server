import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import * as path from 'node:path';
import type { UserIdResolver } from '../database/UserContext.js';
import { MEMORY_CONSTANTS } from '../elements/memories/constants.js';
import type { FileMemoryFence } from './FileMemoryFence.js';
import {
  FileMemoryTransactionCoordinator,
  type FileMemoryLeaseContext,
  type FileMemoryTransactionScope,
} from './FileMemoryTransactionCoordinator.js';

const SIDECAR_SUFFIX = '.memory-owner.json';
const OWNER_DIRECTORY = '.memory-owners';
const MAX_RECORD_BYTES = 4096;
const RESERVED_SIDECAR_NAME = /^\.[0-9a-f]{64}\.memory-owner\.json(?:\.[0-9a-f-]{36}\.tmp)?$/iu;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

interface FileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly ctimeNs: string;
  readonly mtimeNs: string;
}

interface FileTokenBase {
  readonly backend: 'file';
  readonly userId: string;
  readonly tenantRoot: string;
  readonly locator: string;
  readonly contentHash: string;
  readonly fileIdentity: FileIdentity;
}

/** A legacy file has no durable owner. Reads and dry-runs never adopt it. */
export interface UnownedFileMemoryToken extends FileTokenBase {
  readonly ownership: 'unowned';
}

/** Owner identity and revision are unrelated to runtime Memory.id/YAML unique_id. */
export interface OwnedFileMemoryToken extends FileTokenBase {
  readonly ownership: 'owned';
  readonly ownerId: string;
  readonly revision: string;
}

export type FileMemorySnapshotToken = UnownedFileMemoryToken | OwnedFileMemoryToken;

export interface FileMemorySnapshot {
  readonly content: string;
  readonly token: FileMemorySnapshotToken;
}

type OwnerState = 'RESERVED' | 'ACTIVE';

interface OwnerRecord {
  readonly schema: 1;
  readonly state: OwnerState;
  readonly userId: string;
  readonly ownerId: string;
  readonly locator: string;
  readonly revision: string;
  readonly contentHash: string;
  readonly fileIdentity: FileIdentity;
}

export type AdoptionPublication =
  | 'reserved-sidecar'
  | 'reserved-registry'
  | 'active-registry'
  | 'active-sidecar';

interface FileMemoryOwnerSnapshotsBaseOptions {
  /** Fault injection for process-interruption tests; never performs recovery. */
  readonly afterPublication?: (phase: AdoptionPublication) => void | Promise<void>;
}

export interface FileMemoryOwnerSnapshotsLegacyOptions extends FileMemoryOwnerSnapshotsBaseOptions {
  readonly tenantRoot: string;
  readonly getCurrentUserId: UserIdResolver;
  readonly fence: Pick<FileMemoryFence, 'withTenantFence'>;
}

export interface FileMemoryOwnerSnapshotsCoordinatedOptions extends FileMemoryOwnerSnapshotsBaseOptions {
  readonly coordinator: FileMemoryTransactionCoordinator;
}

export type FileMemoryOwnerSnapshotsOptions =
  | FileMemoryOwnerSnapshotsLegacyOptions
  | FileMemoryOwnerSnapshotsCoordinatedOptions;

function headError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function validateLocator(locator: string): void {
  // Existing heads can have uppercase/Unicode names; the older per-head fence
  // restricts new lock keys, while this module uses the tenant-wide fence.
  if (
    typeof locator !== 'string' || !locator || locator.includes('\0') || locator.includes('\\') ||
    path.posix.isAbsolute(locator) || path.win32.isAbsolute(locator) ||
    locator.split('/').some(part => !part || part === '.' || part === '..') ||
    locator.split('/')[0] === OWNER_DIRECTORY || locator.split('/')[0] === '.memory-fences' ||
    RESERVED_SIDECAR_NAME.test(path.posix.basename(locator))
  ) {
    throw new TypeError('Memory locator must be a confined relative POSIX path');
  }
}

function identityOf(stat: BigIntStats): FileIdentity {
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    mtimeNs: stat.mtimeNs.toString(),
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size &&
    left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs;
}

function validRecord(value: unknown): value is OwnerRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<OwnerRecord>;
  const identity = record.fileIdentity;
  return record.schema === 1 && (record.state === 'RESERVED' || record.state === 'ACTIVE') &&
    typeof record.userId === 'string' && !!record.userId &&
    typeof record.ownerId === 'string' && UUID_PATTERN.test(record.ownerId) &&
    typeof record.locator === 'string' && !!record.locator &&
    typeof record.revision === 'string' && /^[1-9]\d*$/u.test(record.revision) &&
    typeof record.contentHash === 'string' && HASH_PATTERN.test(record.contentHash) &&
    !!identity && ['device', 'inode', 'size']
      .every(key => typeof identity[key as keyof FileIdentity] === 'string' &&
        /^\d+$/u.test(identity[key as keyof FileIdentity])) &&
    ['ctimeNs', 'mtimeNs'].every(key => typeof identity[key as keyof FileIdentity] === 'string' &&
      /^-?\d+$/u.test(identity[key as keyof FileIdentity]));
}

function serializedRecord(record: OwnerRecord): string {
  const raw = JSON.stringify(record);
  if (Buffer.byteLength(raw, 'utf8') > MAX_RECORD_BYTES) {
    throw headError('EOWNERRECOVERY', 'Memory owner record exceeds limit');
  }
  return raw;
}

function decodeUtf8(bytes: Buffer, code = 'EINVALIDHEAD'): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw headError(code, 'Memory file contains invalid UTF-8');
  }
}

/**
 * Unwired file-head ownership primitive. Every scanner and writer must honor
 * its sidecar states before adoption or file-volume storage can be activated.
 * Supported model: cooperating writers on a local POSIX filesystem and
 * process interruption, not power loss. The ACTIVE sidecar is the adoption
 * commit. A later callback failure does not roll it back. Multi-step lifecycle
 * operations must pass one tenant lease context; nested withTenantFence calls
 * would deadlock. No scanner/writer may ignore RESERVED or ACTIVE sidecars.
 * A process stopped before a record rename can leave an unreferenced private
 * temp record for manual cleanup while writers are stopped.
 */
export class FileMemoryOwnerSnapshots {
  private readonly options: FileMemoryOwnerSnapshotsOptions;

  constructor(options: FileMemoryOwnerSnapshotsOptions) {
    if (process.platform === 'win32') {
      throw new Error('FileMemoryOwnerSnapshots requires POSIX filesystem ownership and mode checks');
    }
    if ('coordinator' in options &&
      ('tenantRoot' in options || 'getCurrentUserId' in options || 'fence' in options)) {
      throw new TypeError('Coordinated owner snapshots cannot override coordinator scope or fence');
    }
    this.options = Object.freeze({ ...options });
  }

  async readHeadSnapshot(locator: string): Promise<FileMemorySnapshot> {
    const scope = await this.captureStandaloneScope();
    return this.readAtRoot(scope.tenantRoot, scope.userId, locator);
  }

  /** Tracked, read-only operation under an existing tenant lease. */
  readHeadSnapshotInTransaction(
    context: FileMemoryLeaseContext, locator: string,
  ): Promise<FileMemorySnapshot> {
    return this.requiredCoordinator().perform(context, scope =>
      this.readAtRoot(scope.tenantRoot, scope.userId, locator));
  }

  private async readAtRoot(tenantRoot: string, userId: string, locator: string): Promise<FileMemorySnapshot> {
    const resolved = await this.resolveHead(tenantRoot, locator);

    // No lease, directory creation, or owner publication on this read path.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.readRecord(resolved.sidecarPath);
      if (before && before.record.state !== 'ACTIVE') {
        throw headError('EOWNERRECOVERY', 'Memory owner publication is incomplete');
      }
      const content = await this.readHeadBytes(resolved.headPath);
      const registry = before
        ? await this.readRegistry(tenantRoot, before.record.ownerId)
        : undefined;
      const after = await this.readRecord(resolved.sidecarPath);
      if (before?.raw !== after?.raw) continue;

      const base = {
        backend: 'file' as const,
        userId,
        tenantRoot,
        locator: resolved.locator,
        contentHash: content.hash,
        fileIdentity: content.identity,
      };
      if (!before) {
        return { content: content.value, token: { ...base, ownership: 'unowned' } };
      }
      const owner = before.record;
      if (
        registry?.record.state !== 'ACTIVE' ||
        owner.userId !== userId || owner.locator !== resolved.locator ||
        owner.contentHash !== content.hash || !sameIdentity(owner.fileIdentity, content.identity) ||
        registry.record.userId !== owner.userId || registry.record.ownerId !== owner.ownerId ||
        registry.record.locator !== owner.locator || registry.record.revision !== owner.revision ||
        registry.record.contentHash !== owner.contentHash ||
        !sameIdentity(registry.record.fileIdentity, owner.fileIdentity)
      ) {
        throw headError('EOWNERRECOVERY', 'Memory owner, registry, and head disagree');
      }
      return {
        content: content.value,
        token: { ...base, ownership: 'owned', ownerId: owner.ownerId, revision: owner.revision },
      };
    }
    throw headError('EHEADCONFLICT', 'Memory changed during snapshot read');
  }

  async adoptUnowned(expected: UnownedFileMemoryToken): Promise<OwnedFileMemoryToken> {
    const token = { ...expected, fileIdentity: { ...expected.fileIdentity } };
    if ('coordinator' in this.options) {
      return this.options.coordinator.withTenantTransaction(context =>
        this.adoptUnownedInTransaction(context, token));
    }
    if (token.backend !== 'file' || token.ownership !== 'unowned') {
      throw new TypeError('Adoption requires an unowned file snapshot');
    }
    const userId = this.options.getCurrentUserId();
    const root = await fs.realpath(this.options.tenantRoot);
    return this.options.fence.withTenantFence(root, () =>
      this.adoptAtRoot({ tenantRoot: root, userId }, token));
  }

  /** Tracked adoption under the caller's existing lease; never reacquires it. */
  adoptUnownedInTransaction(
    context: FileMemoryLeaseContext, expected: UnownedFileMemoryToken,
  ): Promise<OwnedFileMemoryToken> {
    const token = { ...expected, fileIdentity: { ...expected.fileIdentity } };
    return this.requiredCoordinator().perform(context, scope => this.adoptAtRoot(scope, token));
  }

  private async captureStandaloneScope(): Promise<FileMemoryTransactionScope> {
    if ('coordinator' in this.options) return this.options.coordinator.captureReadScope();
    const userId = this.options.getCurrentUserId();
    if (typeof userId !== 'string' || !userId) throw new TypeError('Current user ID is required');
    const suppliedRoot = this.options.tenantRoot;
    const tenantRoot = await fs.realpath(suppliedRoot);
    return { tenantRoot, userId };
  }

  private requiredCoordinator(): FileMemoryTransactionCoordinator {
    if (!('coordinator' in this.options)) {
      throw new TypeError('Owner snapshot store is not bound to a transaction coordinator');
    }
    return this.options.coordinator;
  }

  private async adoptAtRoot(
    scope: FileMemoryTransactionScope, token: UnownedFileMemoryToken,
  ): Promise<OwnedFileMemoryToken> {
    if (token.backend !== 'file' || token.ownership !== 'unowned') {
      throw new TypeError('Adoption requires an unowned file snapshot');
    }
    const { tenantRoot: root, userId } = scope;
    if (token.userId !== userId || token.tenantRoot !== root) {
      throw headError('EHEADCONFLICT', 'Memory snapshot belongs to a different tenant');
    }
    const current = await this.readAtRoot(root, userId, token.locator);
    if (current.token.ownership !== 'unowned' ||
      current.token.locator !== token.locator || current.token.contentHash !== token.contentHash ||
      !sameIdentity(current.token.fileIdentity, token.fileIdentity)) {
      throw headError('EHEADCONFLICT', 'Unowned memory changed before adoption');
    }
    const { sidecarPath } = await this.resolveHead(root, token.locator);
    const ownerId = randomUUID();
    const rechecked = current.token;
    const record: OwnerRecord = {
      schema: 1, state: 'RESERVED', userId, ownerId, locator: token.locator,
      revision: '1', contentHash: rechecked.contentHash, fileIdentity: rechecked.fileIdentity,
    };
    const active = { ...record, state: 'ACTIVE' as const };
    // Reject oversized metadata before the first owner publication.
    serializedRecord(record);
    serializedRecord(active);

    // A pre-existing legacy head becomes blocked before any owner registry
    // is published. A crash here leaves RESERVED, never a fake unowned head.
    await this.writeExclusiveRecord(sidecarPath, record);
    await this.options.afterPublication?.('reserved-sidecar');
    const ownerDirectory = path.dirname(this.registryPath(root, ownerId));
    await this.ensurePrivateDirectory(path.dirname(ownerDirectory));
    await this.ensurePrivateDirectory(ownerDirectory);
    const registryPath = this.registryPath(root, ownerId);
    await this.writeExclusiveRecord(registryPath, record);
    await this.options.afterPublication?.('reserved-registry');
    await this.replaceRecord(registryPath, active);
    await this.options.afterPublication?.('active-registry');
    await this.replaceRecord(sidecarPath, active);
    // ACTIVE sidecar plus agreeing ACTIVE registry is the adoption commit.
    await this.options.afterPublication?.('active-sidecar');
    return { ...token, ownership: 'owned', ownerId, revision: '1' };
  }

  private async resolveHead(tenantRoot: string, locator: string): Promise<{
    headPath: string; sidecarPath: string; locator: string;
  }> {
    validateLocator(locator);
    let current = tenantRoot;
    for (const segment of locator.split('/')) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw headError('EHEADCONFLICT', 'Memory path contains a symlink');
    }
    const stat = await fs.lstat(current);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw headError('EHEADCONFLICT', 'Memory head must be a regular, unlinked file');
    }
    const headPath = await fs.realpath(current);
    const canonical = path.relative(tenantRoot, headPath);
    if (!canonical || canonical === '..' || canonical.startsWith(`..${path.sep}`) || path.isAbsolute(canonical)) {
      throw headError('EHEADCONFLICT', 'Memory path leaves tenant root');
    }
    const canonicalLocator = canonical.split(path.sep).join('/');
    validateLocator(canonicalLocator);
    const basenameHash = createHash('sha256').update(path.basename(headPath)).digest('hex');
    const sidecarPath = path.join(path.dirname(headPath), `.${basenameHash}${SIDECAR_SUFFIX}`);
    return { headPath, sidecarPath, locator: canonicalLocator };
  }

  private registryPath(tenantRoot: string, ownerId: string): string {
    if (!UUID_PATTERN.test(ownerId)) throw headError('EOWNERRECOVERY', 'Invalid memory owner ID');
    return path.join(tenantRoot, OWNER_DIRECTORY, 'owners', `${ownerId}.json`);
  }

  private async readRegistry(tenantRoot: string, ownerId: string): Promise<{
    raw: string; record: OwnerRecord;
  } | undefined> {
    const ownerRoot = path.join(tenantRoot, OWNER_DIRECTORY);
    await this.checkPrivateDirectory(ownerRoot);
    await this.checkPrivateDirectory(path.join(ownerRoot, 'owners'));
    return this.readRecord(this.registryPath(tenantRoot, ownerId));
  }

  private async readHeadBytes(headPath: string): Promise<{ value: string; hash: string; identity: FileIdentity }> {
    const handle = await fs.open(headPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      const limit = MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE;
      // The legacy loader limits UTF-16 string units. Three UTF-8 bytes per
      // unit is the largest valid expansion; enforce that same limit after decode.
      const rawLimit = limit * 3;
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(rawLimit)) {
        throw headError('EINVALIDHEAD', 'Memory head exceeds the read-only legacy limit or is linked');
      }
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let used = 0;
      while (used < bytes.length) {
        const read = await handle.read(bytes, used, bytes.length - used, used);
        if (read.bytesRead === 0) break;
        used += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (used > rawLimit || BigInt(used) !== after.size ||
        !sameIdentity(identityOf(before), identityOf(after))) {
        throw headError('EHEADCONFLICT', 'Memory head changed during read');
      }
      const content = bytes.subarray(0, used);
      const value = decodeUtf8(content);
      if (value.length > limit) throw headError('EINVALIDHEAD', 'Memory head exceeds the legacy character limit');
      return {
        value,
        hash: createHash('sha256').update(content).digest('hex'),
        identity: identityOf(after),
      };
    } finally {
      await handle.close();
    }
  }

  private async readRecord(filePath: string): Promise<{ raw: string; record: OwnerRecord } | undefined> {
    let handle;
    try {
      handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(MAX_RECORD_BYTES) ||
        (stat.mode & 0o077n) !== 0n || (process.getuid && stat.uid !== BigInt(process.getuid()))) {
        throw headError('EOWNERRECOVERY', 'Memory owner record is not a private regular file');
      }
      const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
      let used = 0;
      while (used < bytes.length) {
        const read = await handle.read(bytes, used, bytes.length - used, used);
        if (read.bytesRead === 0) break;
        used += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (used > MAX_RECORD_BYTES || BigInt(used) !== after.size ||
        !sameIdentity(identityOf(stat), identityOf(after))) {
        throw headError('EOWNERRECOVERY', 'Memory owner record changed or exceeds limit');
      }
      const raw = decodeUtf8(bytes.subarray(0, used), 'EOWNERRECOVERY');
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { throw headError('EOWNERRECOVERY', 'Memory owner record is invalid JSON'); }
      if (!validRecord(parsed)) throw headError('EOWNERRECOVERY', 'Memory owner record is malformed');
      return { raw, record: parsed };
    } finally {
      await handle.close();
    }
  }

  private async writeExclusiveRecord(filePath: string, record: OwnerRecord): Promise<void> {
    const raw = serializedRecord(record);
    const handle = await fs.open(filePath, 'wx', 0o600);
    try {
      await handle.writeFile(raw, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async replaceRecord(filePath: string, record: OwnerRecord): Promise<void> {
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    await this.writeExclusiveRecord(tempPath, record);
    await fs.rename(tempPath, filePath);
  }

  private async ensurePrivateDirectory(directory: string): Promise<void> {
    try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
    await this.checkPrivateDirectory(directory);
  }

  private async checkPrivateDirectory(directory: string): Promise<void> {
    let stat;
    try { stat = await fs.lstat(directory); } catch (error) {
      if (hasCode(error, 'ENOENT')) throw headError('EOWNERRECOVERY', 'Memory owner directory is missing');
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())) {
      throw headError('EOWNERRECOVERY', 'Memory owner directory is not private');
    }
  }
}
