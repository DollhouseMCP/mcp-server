import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { UserIdResolver } from '../database/UserContext.js';
import { MEMORY_CONSTANTS } from '../elements/memories/constants.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { validateMemoryControlFields } from '../elements/memories/memoryYamlValidation.js';
import type { FileMemoryFence } from './FileMemoryFence.js';
import {
  FileMemoryTransactionCoordinator,
  type FileMemoryLeaseContext,
  type FileMemoryTransactionScope,
} from './FileMemoryTransactionCoordinator.js';

const SIDECAR_SUFFIX = '.memory-owner.json';
const OWNER_DIRECTORY = '.memory-owners';
const MAX_RECORD_BYTES = 4096;
const MAX_JOURNAL_BYTES = 8192;
const MAX_SCAN_ENTRIES = 100_000;
const MAX_REVISION = 9_223_372_036_854_775_807n;
const RESERVED_SIDECAR_NAME = /^\.[0-9a-f]{64}\.memory-(?:owner\.json|write)(?:\.|$)/iu;
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

interface WriteJournal {
  readonly schema: 1;
  readonly state: 'PREPARED_WRITE' | 'PUBLISHED_WRITE';
  readonly userId: string;
  readonly ownerId: string;
  readonly locator: string;
  readonly operationId: string;
  readonly oldRevision: string;
  readonly newRevision: string;
  readonly oldContentHash: string;
  readonly newContentHash: string;
  readonly oldFileIdentity: FileIdentity;
  readonly preparedTempName: string;
  readonly preparedTempIdentity: FileIdentity;
  readonly publishedHeadIdentity?: FileIdentity;
}

export type UpdatePublication = 'prepared-temp' | 'prepared-journal' | 'renamed-head' |
  'published-journal' | 'updated-registry' | 'updated-sidecar' | 'unlinked-journal';

export interface CommittedFileHeadError extends NodeJS.ErrnoException {
  readonly committed: true;
  readonly token: OwnedFileMemoryToken;
}

export type AdoptionPublication =
  | 'reserved-sidecar'
  | 'reserved-registry'
  | 'active-registry'
  | 'active-sidecar';

interface FileMemoryOwnerSnapshotsBaseOptions {
  /** Fault injection for process-interruption tests; never performs recovery. */
  readonly afterPublication?: (phase: AdoptionPublication) => void | Promise<void>;
  /** Fault injection for conditional UPDATE; no production caller is wired. */
  readonly afterUpdatePublication?: (phase: UpdatePublication) => void | Promise<void>;
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

function samePublishedFile(prepared: FileIdentity, published: FileIdentity): boolean {
  // POSIX rename can update ctime on the moved inode; it must not change the
  // descriptor's device, inode, size, or mtime.
  return prepared.device === published.device && prepared.inode === published.inode &&
    prepared.size === published.size && prepared.mtimeNs === published.mtimeNs;
}

function sameOwnedToken(left: OwnedFileMemoryToken, right: OwnedFileMemoryToken): boolean {
  return left.backend === right.backend && left.ownership === right.ownership &&
    left.userId === right.userId && left.tenantRoot === right.tenantRoot &&
    left.locator === right.locator && left.ownerId === right.ownerId &&
    left.revision === right.revision && left.contentHash === right.contentHash &&
    sameIdentity(left.fileIdentity, right.fileIdentity);
}

function committedError(cause: unknown, token: OwnedFileMemoryToken): CommittedFileHeadError {
  const error = headError('EHEADCOMMITTED', 'Memory head committed; a later operation failed') as CommittedFileHeadError;
  Object.assign(error, { cause, committed: true as const, token });
  return error;
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
    !!identity && ['device', 'inode', 'size', 'ctimeNs', 'mtimeNs']
      .every(key => typeof identity[key as keyof FileIdentity] === 'string' &&
        /^\d+$/u.test(identity[key as keyof FileIdentity]));
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

  private async readAtRoot(
    tenantRoot: string, userId: string, locator: string, permittedJournal?: string,
  ): Promise<FileMemorySnapshot> {
    const resolved = await this.resolveHead(tenantRoot, locator);

    // No lease, directory creation, or owner publication on this read path.
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.checkWriteArtifacts(tenantRoot, resolved, undefined, permittedJournal);
      const before = await this.readRecord(resolved.sidecarPath);
      if (before && before.record.state !== 'ACTIVE') {
        throw headError('EOWNERRECOVERY', 'Memory owner publication is incomplete');
      }
      const content = await this.readHeadBytes(resolved.headPath);
      const registry = before
        ? await this.readRegistry(tenantRoot, before.record.ownerId)
        : undefined;
      const after = await this.readRecord(resolved.sidecarPath);
      await this.checkWriteArtifacts(tenantRoot, resolved, before?.record.ownerId, permittedJournal);
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

  /** Dormant same-locator UPDATE. The expected token is copied before the first await. */
  async updateOwnedHead(expected: OwnedFileMemoryToken, content: string): Promise<OwnedFileMemoryToken> {
    const token = { ...expected, fileIdentity: { ...expected.fileIdentity } };
    if (typeof content !== 'string') throw new TypeError('Memory head content must be a string');
    let publishedToken: OwnedFileMemoryToken | undefined;
    try {
      return await this.requiredCoordinator().withTenantTransaction(async context => {
        try {
          const updated = await this.updateOwnedHeadInTransaction(context, token, content);
          publishedToken = updated;
          return updated;
        } catch (cause) {
          const outcome = cause as Partial<CommittedFileHeadError>;
          if (outcome.committed && outcome.token) publishedToken = outcome.token;
          throw cause;
        }
      });
    } catch (cause) {
      if (publishedToken) {
        if ((cause as Partial<CommittedFileHeadError>)?.committed) throw cause;
        throw committedError(cause, publishedToken);
      }
      throw cause;
    }
  }

  /** Tracked UPDATE under an existing tenant lease; it never nests a lease. */
  updateOwnedHeadInTransaction(
    context: FileMemoryLeaseContext, expected: OwnedFileMemoryToken, content: string,
  ): Promise<OwnedFileMemoryToken> {
    const token = { ...expected, fileIdentity: { ...expected.fileIdentity } };
    if (typeof content !== 'string') throw new TypeError('Memory head content must be a string');
    return this.requiredCoordinator().perform(context, scope => this.updateAtRoot(scope, token, content));
  }

  private async prepareOwnedUpdate(
    scope: FileMemoryTransactionScope, expected: OwnedFileMemoryToken, content: string,
  ): Promise<{
    resolved: Awaited<ReturnType<FileMemoryOwnerSnapshots['resolveHead']>>;
    operationId: string; newRevision: string; newContentHash: string;
    tempName: string; tempPath: string;
  }> {
    if (expected.backend !== 'file' || expected.ownership !== 'owned' ||
      expected.userId !== scope.userId || expected.tenantRoot !== scope.tenantRoot ||
      !UUID_PATTERN.test(expected.ownerId)) {
      throw headError('EHEADCONFLICT', 'Memory update token belongs to another head or tenant');
    }
    if (content.length > MEMORY_CONSTANTS.MAX_YAML_SIZE) {
      throw headError('EINVALIDHEAD', 'Memory update exceeds the save limit');
    }
    if (Buffer.from(content, 'utf8').toString('utf8') !== content) {
      throw headError('EINVALIDHEAD', 'Memory update cannot round-trip through UTF-8');
    }
    try {
      const parsed = SecureYamlParser.parseRawYaml(content, {
        maxSize: MEMORY_CONSTANTS.MAX_YAML_SIZE, contentPolicy: 'structure-only',
      });
      if (!validateMemoryControlFields(parsed)) throw new Error('Invalid memory control fields');
    } catch {
      throw headError('EINVALIDHEAD', 'Memory update YAML is invalid');
    }
    const current = await this.readAtRoot(scope.tenantRoot, scope.userId, expected.locator);
    if (current.token.ownership !== 'owned' || !sameOwnedToken(expected, current.token)) {
      throw headError('EHEADCONFLICT', 'Memory head changed before conditional update');
    }
    const revision = BigInt(expected.revision);
    if (revision < 1n || revision >= MAX_REVISION) {
      throw headError('EOWNERRECOVERY', 'Memory revision cannot advance');
    }
    const resolved = await this.resolveHead(scope.tenantRoot, expected.locator);
    const operationId = randomUUID();
    const newRevision = (revision + 1n).toString();
    const newContentHash = createHash('sha256').update(content, 'utf8').digest('hex');
    const tempName = `.${resolved.basenameHash}.memory-write.${expected.ownerId}.${operationId}.tmp`;
    const tempPath = path.join(path.dirname(resolved.headPath), tempName);
    const placeholderIdentity: FileIdentity = {
      device: '9'.repeat(32), inode: '9'.repeat(32), size: '9'.repeat(32),
      ctimeNs: '-'.concat('9'.repeat(32)), mtimeNs: '-'.concat('9'.repeat(32)),
    };
    this.serializedJournal({
      schema: 1, state: 'PUBLISHED_WRITE', userId: scope.userId, ownerId: expected.ownerId,
      locator: resolved.locator, operationId, oldRevision: expected.revision, newRevision,
      oldContentHash: expected.contentHash, newContentHash,
      oldFileIdentity: expected.fileIdentity, preparedTempName: tempName,
      preparedTempIdentity: placeholderIdentity, publishedHeadIdentity: placeholderIdentity,
    });
    serializedRecord({
      schema: 1, state: 'ACTIVE', userId: scope.userId, ownerId: expected.ownerId,
      locator: resolved.locator, revision: newRevision,
      contentHash: newContentHash, fileIdentity: placeholderIdentity,
    });
    return { resolved, operationId, newRevision, newContentHash, tempName, tempPath };
  }

  private async updateAtRoot(
    scope: FileMemoryTransactionScope, expected: OwnedFileMemoryToken, content: string,
  ): Promise<OwnedFileMemoryToken> {
    const { resolved, operationId, newRevision, newContentHash, tempName, tempPath } =
      await this.prepareOwnedUpdate(scope, expected, content);
    let artifactStarted = false;
    let publicationAttempted = false;
    let committedToken: OwnedFileMemoryToken | undefined;
    try {
      const tempHandle = await fs.open(tempPath, 'wx', 0o600);
      artifactStarted = true;
      try {
        await tempHandle.writeFile(content, 'utf8');
        await tempHandle.sync();
      } finally {
        await tempHandle.close();
      }
      await this.options.afterUpdatePublication?.('prepared-temp');
      const prepared = await this.readHeadBytes(tempPath);
      if (prepared.hash !== newContentHash || prepared.value !== content) {
        throw headError('EOWNERRECOVERY', 'Prepared memory head differs from input');
      }
      const journal: WriteJournal = {
        schema: 1, state: 'PREPARED_WRITE', userId: scope.userId,
        ownerId: expected.ownerId, locator: resolved.locator, operationId,
        oldRevision: expected.revision, newRevision,
        oldContentHash: expected.contentHash, newContentHash,
        oldFileIdentity: expected.fileIdentity,
        preparedTempName: tempName, preparedTempIdentity: prepared.identity,
      };
      await this.writeExclusiveRaw(resolved.journalPath, this.serializedJournal(journal));
      await this.options.afterUpdatePublication?.('prepared-journal');
      publicationAttempted = true;
      await fs.rename(tempPath, resolved.headPath);
      await this.options.afterUpdatePublication?.('renamed-head');
      const published = await this.readHeadBytes(resolved.headPath);
      if (published.hash !== newContentHash || !samePublishedFile(prepared.identity, published.identity)) {
        throw headError('EOWNERRECOVERY', 'Published memory head differs from prepared file');
      }
      const publishedJournal: WriteJournal = {
        ...journal, state: 'PUBLISHED_WRITE', publishedHeadIdentity: published.identity,
      };
      const preparedAtPublication = await this.readJournal(resolved.journalPath);
      if (!preparedAtPublication || !isDeepStrictEqual(preparedAtPublication, journal)) {
        throw headError('EOWNERRECOVERY', 'Prepared memory write journal changed before publication');
      }
      await this.replaceRawRecord(resolved.journalPath, this.serializedJournal(publishedJournal));
      await this.options.afterUpdatePublication?.('published-journal');
      const nextRecord: OwnerRecord = {
        schema: 1, state: 'ACTIVE', userId: scope.userId, ownerId: expected.ownerId,
        locator: resolved.locator, revision: newRevision,
        contentHash: newContentHash, fileIdentity: published.identity,
      };
      serializedRecord(nextRecord);
      await this.replaceRecord(this.registryPath(scope.tenantRoot, expected.ownerId), nextRecord);
      await this.options.afterUpdatePublication?.('updated-registry');
      await this.replaceRecord(resolved.sidecarPath, nextRecord);
      await this.options.afterUpdatePublication?.('updated-sidecar');
      const final = await this.readAtRoot(
        scope.tenantRoot, scope.userId, resolved.locator, path.basename(resolved.journalPath));
      if (final.token.ownership !== 'owned' || final.token.ownerId !== expected.ownerId ||
        final.token.revision !== newRevision || final.token.contentHash !== newContentHash ||
        !sameIdentity(final.token.fileIdentity, published.identity)) {
        throw headError('EOWNERRECOVERY', 'Final memory owner receipt disagrees with published head');
      }
      const journalAtCommit = await this.readJournal(resolved.journalPath);
      if (!journalAtCommit || !isDeepStrictEqual(journalAtCommit, publishedJournal)) {
        throw headError('EOWNERRECOVERY', 'Memory write journal changed before commit');
      }
      await fs.unlink(resolved.journalPath);
      committedToken = final.token;
      await this.options.afterUpdatePublication?.('unlinked-journal');
      return final.token;
    } catch (cause) {
      this.raiseUpdateFailure(cause, { committedToken, artifactStarted, publicationAttempted, operationId });
    }
  }

  private raiseUpdateFailure(
    cause: unknown,
    state: {
      committedToken?: OwnedFileMemoryToken;
      artifactStarted: boolean;
      publicationAttempted: boolean;
      operationId: string;
    },
  ): never {
    if (state.committedToken) throw committedError(cause, state.committedToken);
    if (!state.artifactStarted && !state.publicationAttempted) throw cause;
    const code = state.publicationAttempted ? 'EHEADCOMMITUNKNOWN' : 'EOWNERRECOVERY';
    const error = headError(code, 'Memory update stopped with recovery artifacts');
    Object.assign(error, { cause, operationId: state.operationId, residual: true });
    throw error;
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
    headPath: string; sidecarPath: string; journalPath: string; basenameHash: string; locator: string;
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
    const journalPath = path.join(path.dirname(headPath), `.${basenameHash}.memory-write.json`);
    return { headPath, sidecarPath, journalPath, basenameHash, locator: canonicalLocator };
  }

  private async scanDirectory(directory: string, matches: (name: string) => boolean): Promise<void> {
    const handle = await fs.opendir(directory);
    let seen = 0;
    for await (const entry of handle) {
      if (++seen > MAX_SCAN_ENTRIES) {
        throw headError('EHEADRESOURCE', 'Memory metadata directory exceeds scan limit');
      }
      if (matches(entry.name)) {
        throw headError('EOWNERRECOVERY', `Memory update artifact requires recovery: ${entry.name}`);
      }
    }
  }

  private async checkWriteArtifacts(
    tenantRoot: string,
    resolved: { headPath: string; journalPath: string; basenameHash: string }, ownerId?: string,
    permittedJournal?: string,
  ): Promise<void> {
    const prefix = `.${resolved.basenameHash}.`;
    await this.scanDirectory(path.dirname(resolved.headPath), name => {
      const folded = name.toLowerCase();
      if (folded === path.basename(resolved.journalPath)) return name !== permittedJournal;
      const sidecarName = `.${resolved.basenameHash}.memory-owner.json`;
      if (folded === sidecarName) return name !== sidecarName;
      return folded.startsWith(`${prefix}memory-write`) ||
        folded.startsWith(`${prefix}memory-owner.json`);
    });
    if (ownerId) {
      const registryPath = this.registryPath(tenantRoot, ownerId);
      await this.scanDirectory(path.dirname(registryPath), name =>
        name.toLowerCase().startsWith(`${ownerId}.json.`));
    }
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

  private serializedJournal(record: WriteJournal): string {
    const raw = JSON.stringify(record);
    if (Buffer.byteLength(raw, 'utf8') > MAX_JOURNAL_BYTES) {
      throw headError('EOWNERRECOVERY', 'Memory write journal exceeds limit');
    }
    return raw;
  }

  private async readJournal(filePath: string): Promise<WriteJournal | undefined> {
    let handle;
    try {
      handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_JOURNAL_BYTES) ||
        (before.mode & 0o077n) !== 0n || (process.getuid && before.uid !== BigInt(process.getuid()))) {
        throw headError('EOWNERRECOVERY', 'Memory write journal is not a private regular file');
      }
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let used = 0;
      while (used < bytes.length) {
        const read = await handle.read(bytes, used, bytes.length - used, used);
        if (!read.bytesRead) break;
        used += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (BigInt(used) !== after.size || !sameIdentity(identityOf(before), identityOf(after))) {
        throw headError('EOWNERRECOVERY', 'Memory write journal changed during read');
      }
      let parsed: unknown;
      try { parsed = JSON.parse(decodeUtf8(bytes.subarray(0, used), 'EOWNERRECOVERY')); } catch {
        throw headError('EOWNERRECOVERY', 'Memory write journal is malformed');
      }
      if (!this.validJournal(parsed)) throw headError('EOWNERRECOVERY', 'Memory write journal is invalid');
      return parsed;
    } finally {
      await handle.close();
    }
  }

  private validJournal(value: unknown): value is WriteJournal {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Partial<WriteJournal>;
    const fields = ['schema', 'state', 'userId', 'ownerId', 'locator', 'operationId',
      'oldRevision', 'newRevision', 'oldContentHash', 'newContentHash',
      'oldFileIdentity', 'preparedTempName', 'preparedTempIdentity'];
    const expected = record.state === 'PUBLISHED_WRITE' ? [...fields, 'publishedHeadIdentity'] : fields;
    const actualFields = Object.keys(record);
    const expectedFields = new Set(expected);
    if (actualFields.length !== expectedFields.size ||
      actualFields.some(field => !expectedFields.has(field))) return false;
    if (record.schema !== 1 || (record.state !== 'PREPARED_WRITE' && record.state !== 'PUBLISHED_WRITE') ||
      typeof record.userId !== 'string' || !record.userId ||
      typeof record.ownerId !== 'string' || !UUID_PATTERN.test(record.ownerId) ||
      typeof record.operationId !== 'string' || !UUID_PATTERN.test(record.operationId) ||
      typeof record.locator !== 'string' || !record.locator ||
      typeof record.oldRevision !== 'string' || !/^[1-9]\d*$/u.test(record.oldRevision) ||
      typeof record.newRevision !== 'string' || !/^[1-9]\d*$/u.test(record.newRevision) ||
      BigInt(record.newRevision) > MAX_REVISION || BigInt(record.oldRevision) + 1n !== BigInt(record.newRevision) ||
      typeof record.oldContentHash !== 'string' || !HASH_PATTERN.test(record.oldContentHash) ||
      typeof record.newContentHash !== 'string' || !HASH_PATTERN.test(record.newContentHash)) return false;
    try { validateLocator(record.locator); } catch { return false; }
    const basenameHash = createHash('sha256').update(path.posix.basename(record.locator)).digest('hex');
    if (record.preparedTempName !== `.${basenameHash}.memory-write.${record.ownerId}.${record.operationId}.tmp`) {
      return false;
    }
    const identities = [record.oldFileIdentity, record.preparedTempIdentity];
    if (record.state === 'PUBLISHED_WRITE') identities.push(record.publishedHeadIdentity);
    return identities.every(identity => this.validIdentity(identity));
  }

  private validIdentity(value: unknown): value is FileIdentity {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const identity = value as Partial<FileIdentity>;
    const fields = new Set(['device', 'inode', 'size', 'ctimeNs', 'mtimeNs']);
    const actualFields = Object.keys(identity);
    if (actualFields.length !== fields.size || actualFields.some(field => !fields.has(field))) return false;
    return ['device', 'inode', 'size'].every(key =>
      typeof identity[key as keyof FileIdentity] === 'string' &&
      /^(?:0|[1-9]\d*)$/u.test(identity[key as keyof FileIdentity]!)) &&
      ['ctimeNs', 'mtimeNs'].every(key =>
        typeof identity[key as keyof FileIdentity] === 'string' &&
        /^(?:0|[1-9]\d*|-[1-9]\d*)$/u.test(identity[key as keyof FileIdentity]!));
  }

  private async writeExclusiveRaw(filePath: string, raw: string): Promise<void> {
    const handle = await fs.open(filePath, 'wx', 0o600);
    try {
      await handle.writeFile(raw, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async replaceRawRecord(filePath: string, raw: string): Promise<void> {
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    await this.writeExclusiveRaw(tempPath, raw);
    await fs.rename(tempPath, filePath);
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
