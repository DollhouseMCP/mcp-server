import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { UserIdResolver } from '../database/UserContext.js';
import { MEMORY_CONSTANTS } from '../elements/memories/constants.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { validateMemoryControlFields } from '../elements/memories/memoryYamlValidation.js';
import { getGatekeeperAuthoringErrors } from '../handlers/mcp-aql/policies/ElementPolicies.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { parseFileMemoryAbortIntent, serializeFileMemoryAbortIntent,
  type FileMemoryAbortIntent } from './FileMemoryAbortIntentCodec.js';
import { observeTenantFence, type FileMemoryFence } from './FileMemoryFence.js';
import type { FileMemoryDirectoryScanner } from './FileMemoryDirectoryScanBudget.js';
import { ErasureAccounting, ErasureInspection } from './FileMemoryErasureInspection.js';
import { FileMemoryOwnedErasure, type EraseOwnedRequest, type EraseOwnedResult, type ErasurePublication,
  type ErasureReplacementSnapshot, type RecoverOwnedErasureRequest } from './FileMemoryOwnedErasure.js';
import { erasureBinding, erasureJournalName } from './FileMemoryErasureEvidence.js';
import { evidenceKeys } from './FileMemoryOwnedHeadEvidence.js';
export type { EraseOwnedRequest, EraseOwnedResult, ErasurePublication, RecoverOwnedErasureRequest } from './FileMemoryOwnedErasure.js';
export type OwnedErasureWorkReport = FileMemoryOwnedErasure['workReport'] & {
  readonly head?: FileMemoryOwnedDelete['erasureHandoffReadWork'];
};
import { FileMemoryAdoptionRecoveryScanBudget } from './FileMemoryAdoptionRecoveryScanBudget.js';
import { FileMemoryOwnedCreate, captureCreateRequest, type CreateOwnedRequest, type CreatePublication } from './FileMemoryOwnedCreate.js';
export type { CreateOwnedRequest, CreatePublication } from './FileMemoryOwnedCreate.js';
import { FileMemoryOwnedDelete, captureDeleteRequest, type DeleteOwnedRequest, type DeleteOwnedResult, type DeletePublication } from './FileMemoryOwnedDelete.js';
export type { DeleteOwnedRequest, DeleteOwnedResult, DeletePublication } from './FileMemoryOwnedDelete.js';
import { FileMemoryOwnedRename, captureRenameRequest, type RenameOwnedRequest, type RenamePublication } from './FileMemoryOwnedRename.js';
export type { RenameOwnedRequest, RenamePublication } from './FileMemoryOwnedRename.js';
import {
  classifyFileMemoryWrite,
  type FileMemoryWriteDiagnostic,
  type FileMemoryWriteEvidence,
} from './FileMemoryWriteClassification.js';
import {
  FileMemoryTransactionCoordinator,
  type FileMemoryLeaseContext,
  type FileMemoryOperationScope,
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

interface DiagnosticEvidenceRead {
  readonly evidence: FileMemoryWriteEvidence;
  readonly signature: string;
  readonly headContent: string;
  readonly preparedTemp?: { path: string; raw: string; identity: FileIdentity };
  readonly journalRaw?: string;
  readonly journalIdentity?: FileIdentity;
  readonly sidecarRaw?: string;
  readonly sidecarIdentity?: FileIdentity;
  readonly registryRaw?: string;
  readonly registryIdentity?: FileIdentity;
  readonly recoveryStage?: { path: string; raw: string; identity: FileIdentity };
  readonly resolved: { headPath: string; sidecarPath: string; journalPath: string; basenameHash: string; locator: string };
}

export type UpdatePublication = 'prepared-temp' | 'prepared-journal' | 'renamed-head' |
  'published-journal' | 'updated-registry' | 'updated-sidecar' | 'unlinked-journal';

export type UpdateMetadataStage = 'published-journal' | 'active-registry' | 'active-sidecar';
export type UpdateMetadataStagePoint = 'partial-write' | 'verified-before-rename';

export interface CommittedFileHeadError extends NodeJS.ErrnoException {
  readonly committed: true;
  readonly token: OwnedFileMemoryToken;
}

export interface FinalizeOwnedUpdateRequest {
  readonly locator: string;
  readonly ownerId: string;
  readonly operationId: string;
}

export type FinalizeOwnedUpdateResult =
  | { readonly status: 'known-committed'; readonly token: OwnedFileMemoryToken }
  | { readonly status: 'already-clean-no-attribution' };

export type FinalizePublication = 'before-unlink' | 'after-unlink' | 'after-read';

export interface FileMemoryAbortReceipt {
  readonly operationId: string;
  readonly token: OwnedFileMemoryToken;
}
export type AbortOwnedUpdateResult =
  | { readonly status: 'known-aborted'; readonly receipt: FileMemoryAbortReceipt }
  | { readonly status: 'already-clean-no-attribution' };
export interface AbortedFileHeadError extends NodeJS.ErrnoException {
  readonly aborted: true;
  readonly receipt: FileMemoryAbortReceipt;
}
export type AbortPublication = 'before-intent-stage' | 'partial-intent-stage' | 'verified-intent-stage' |
  'before-intent-rename' | 'after-intent-rename' | 'before-temp-unlink' | 'after-temp-unlink' |
  'before-journal-unlink' | 'after-journal-unlink' | 'after-abort-read';
interface AbortEvidence {
  readonly resolved: DiagnosticEvidenceRead['resolved'];
  readonly token: OwnedFileMemoryToken;
  readonly journal?: { raw: string; identity: FileIdentity };
  readonly intent?: FileMemoryAbortIntent;
  readonly prepared?: WriteJournal;
  readonly temp?: { value: string; hash: string; identity: FileIdentity };
  readonly stage?: { raw: string; identity: FileIdentity };
  readonly sidecar: { raw: string; record: OwnerRecord; identity: FileIdentity };
  readonly registry: { raw: string; record: OwnerRecord; identity: FileIdentity };
  readonly signature: string;
}

export type AdoptionPublication =
  | 'reserved-sidecar'
  | 'reserved-registry'
  | 'active-registry'
  | 'active-sidecar';

export interface RecoverAdoptionRequest { readonly locator: string; readonly ownerId: string }
export type RecoverAdoptionResult =
  | { readonly status: 'known-adopted'; readonly token: OwnedFileMemoryToken }
  | { readonly status: 'already-clean-no-attribution' };
export interface AdoptedFileHeadError extends NodeJS.ErrnoException {
  readonly adopted: true;
  readonly token: OwnedFileMemoryToken;
}
export type AdoptionRecoveryPublication = 'before-stage' | 'partial-stage' | 'verified-stage' |
  'before-rename' | 'after-rename' | 'after-read' | 'before-registry-stage' | 'partial-registry-stage' |
  'verified-registry-stage' | 'before-registry-rename' | 'after-registry-rename' |
  'before-registry-create' | 'partial-registry-create' | 'after-registry-create' |
  'before-owners-directory-create' | 'after-owners-directory-create' |
  'before-ownership-parent-create' | 'after-ownership-parent-create';
type AdoptionProgress = 'ownership-parent-creation-unknown' | 'ownership-parent-created' |
  'owners-directory-creation-unknown' | 'owners-directory-created' |
  'registry-creation-unknown' | 'registry-created' |
  'registry-publication-unknown' | 'registry-published' | 'sidecar-publication-unknown';
interface AdoptionEvidence {
  readonly resolved: DiagnosticEvidenceRead['resolved'];
  readonly head: { value: string; hash: string; identity: FileIdentity };
  readonly sidecar: { raw: string; record: OwnerRecord; identity: FileIdentity };
  readonly registry: { raw: string; record: OwnerRecord; identity: FileIdentity };
  readonly stage?: { raw: string; record: OwnerRecord; identity: FileIdentity };
  readonly stagePath: string;
  readonly token: OwnedFileMemoryToken;
  readonly signature: string;
  readonly ownerDirectories: readonly FileIdentity[];
}
interface AbsentAdoptionEvidence {
  readonly resolved: AdoptionEvidence['resolved'];
  readonly head: AdoptionEvidence['head'];
  readonly sidecar: AdoptionEvidence['sidecar'];
  readonly ownerDirectories: readonly FileIdentity[];
  readonly signature: string;
}
interface MissingOwnersEvidence {
  readonly original: Pick<AbsentAdoptionEvidence, 'resolved' | 'head' | 'sidecar'>;
  readonly tenantIdentity: FileIdentity;
  readonly tenantMode: bigint;
  readonly tenantUid: bigint;
  readonly parentIdentity: FileIdentity;
  readonly tenantNames: readonly string[];
  readonly parentNames: readonly string[];
  readonly signature: string;
}
interface PreparedOwnersDirectory {
  readonly evidence: AbsentAdoptionEvidence;
  readonly reproof: (current: AbsentAdoptionEvidence | AdoptionEvidence) => Promise<void>;
  readonly publicationProof: AdoptionTopologyProof;
}
type MissingOwnershipParentEvidence = Omit<MissingOwnersEvidence, 'parentIdentity' | 'parentNames'>;
type AdoptionTopologyProof = (stage?: { path: string; identity: FileIdentity },
  publishedSidecar?: FileIdentity, transition?: 'registry-create' | 'registry-stage' | 'registry-rename' | 'sidecar-stage' | 'sidecar-rename') => Promise<void>;

interface FileMemoryOwnerSnapshotsBaseOptions {
  /** Dormant exclusive CREATE barriers; never mutation or retry authority. */
  readonly afterCreatePublication?: (phase: CreatePublication) => void | Promise<void>;
  readonly afterDeletePublication?: (phase: DeletePublication) => Promise<void> | void;
  /** Dormant erasure barriers and invocation-local diagnostics, never mutation authority. */
  readonly afterErasurePublication?: (phase: ErasurePublication) => Promise<void> | void;
  readonly afterErasureWork?: (report: OwnedErasureWorkReport) => Promise<void> | void;
  /** Dormant same-parent RENAME barriers; never mutation/recovery authority. */
  readonly afterRenamePublication?: (phase: RenamePublication) => void | Promise<void>;
  /** Dormant adoption-recovery test barriers; never recovery authority. */
  readonly afterAdoptionRecoveryPublication?: (phase: AdoptionRecoveryPublication) => void | Promise<void>;
  /** Isolated abort fault barriers; never authority or automatic orphan handling. */
  readonly afterAbortPublication?: (phase: AbortPublication) => void | Promise<void>;
  /** Fault barrier for dormant PREPARED forward publication; never repair authority. */
  readonly beforePreparedHeadRename?: () => void | Promise<void>;
  /** Fault injection for process-interruption tests; never performs recovery. */
  readonly afterPublication?: (phase: AdoptionPublication) => void | Promise<void>;
  /** Fault injection for conditional UPDATE; no production caller is wired. */
  readonly afterUpdatePublication?: (phase: UpdatePublication) => void | Promise<void>;
  /** Fault injection for dormant, operator-controlled finalization tests. */
  readonly afterFinalizePublication?: (phase: FinalizePublication) => void | Promise<void>;
  /** Fault injection for UPDATE staging, including explicit dormant forward recovery. */
  readonly duringUpdateMetadataStage?: (
    stage: UpdateMetadataStage, point: UpdateMetadataStagePoint,
  ) => void | Promise<void>;
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
  private readonly adoptedErrors = new WeakMap<object, OwnedFileMemoryToken>();
  private readonly deleteErrors = new WeakMap<object, DeleteOwnedResult>();
  private readonly renameErrors = new WeakMap<object, OwnedFileMemoryToken>();
  private readonly createErrors = new WeakMap<object, OwnedFileMemoryToken>();
  private readonly eraseErrors = new WeakMap<object, EraseOwnedResult>();
  private readonly eraseHeadErrors = new WeakSet<object>();

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

  /** Dormant exact head DELETE; archives remain pending erasure under the retained old UUID. */
  async deleteOwned(input: DeleteOwnedRequest): Promise<DeleteOwnedResult> {
    let captured: DeleteOwnedResult | undefined;
    try {
      const request = captureDeleteRequest(input); validateLocator(request.expectedToken.locator);
      return await this.requiredCoordinator().withTenantTransaction(context => this.performOwnedDelete(context, request, value => { captured = value; }));
    } catch (cause) {
      if (captured) {
        if (cause && typeof cause === 'object' && this.deleteErrors.get(cause) === captured) throw cause;
        const error = Object.assign(headError('EHEADDELETED', 'Head deletion reached its qualified boundary; erasure remains pending'), { cause, headDeleted: true, result: captured });
        this.deleteErrors.set(error, captured); throw error;
      }
      throw this.deletePrecommitError(cause);
    }
  }
  deleteOwnedInTransaction(context: FileMemoryLeaseContext, input: DeleteOwnedRequest): Promise<DeleteOwnedResult> {
    try { const request = captureDeleteRequest(input); validateLocator(request.expectedToken.locator); return this.performOwnedDelete(context, request); }
    catch (cause) { throw this.deletePrecommitError(cause); }
  }
  private deletePrecommitError(cause: unknown): unknown {
    if (cause === null || (typeof cause !== 'object' && typeof cause !== 'function')) return cause;
    let marker = false;
    try { const value = cause as { code?: unknown; headDeleted?: unknown }; marker = value.code === 'EHEADDELETED' || value.headDeleted === true || 'result' in value; }
    catch { marker = true; }
    return marker ? Object.assign(headError('EOWNERRECOVERY', 'This DELETE has no captured head-deletion outcome'), { cause }) : cause;
  }
  private performOwnedDelete(context: FileMemoryLeaseContext, request: DeleteOwnedRequest, capture?: (result: DeleteOwnedResult) => void): Promise<DeleteOwnedResult> {
    let captured: DeleteOwnedResult | undefined; const coordinator = this.requiredCoordinator();
    const result = coordinator.perform(context, async operation => {
      const executor = new FileMemoryOwnedDelete(operation, request, () => { coordinator.requireActiveOperationScope(operation); },
          budget => this.snapshotOwnedAtScope(operation, request.expectedToken, budget),
          budget => this.readAtRoot(operation.tenantRoot, operation.userId, request.expectedToken.locator, undefined, budget), this.options.afterDeletePublication,
          result => { captured = result; capture?.(result); });
      try { return await executor.run();
      } catch (cause) {
        if (!captured) throw this.deletePrecommitError(cause);
        if (executor.isCapturedError(cause, captured) && cause && typeof cause === 'object') this.deleteErrors.set(cause, captured);
        throw cause;
      }
    }).catch(cause => {
      if (!captured) throw this.deletePrecommitError(cause);
      if (cause && typeof cause === 'object' && this.deleteErrors.get(cause) === captured) throw cause;
      const error = Object.assign(headError('EHEADDELETED', 'Head deletion completed before transaction failure; erasure remains pending'), { cause, headDeleted: true, result: captured });
      this.deleteErrors.set(error, captured); throw error;
    });
    void result.catch(() => undefined); return result;
  }

  /** Dormant whole-owner erasure; no account purge or runtime Memory deletion wiring. */
  eraseOwned(input: EraseOwnedRequest): Promise<EraseOwnedResult> {
    return this.standaloneErasure(input, false);
  }
  recoverOwnedErasure(input: RecoverOwnedErasureRequest): Promise<EraseOwnedResult> {
    return this.standaloneErasure(input, true);
  }
  eraseOwnedInTransaction(context: FileMemoryLeaseContext, input: EraseOwnedRequest): Promise<EraseOwnedResult> {
    return this.performOwnedErasure(context, this.captureErasureRequest(input, false), false);
  }
  recoverOwnedErasureInTransaction(context: FileMemoryLeaseContext, input: RecoverOwnedErasureRequest): Promise<EraseOwnedResult> {
    return this.performOwnedErasure(context, this.captureErasureRequest(input, true), true);
  }
  private captureErasureRequest(input: EraseOwnedRequest | RecoverOwnedErasureRequest, recovery: boolean): EraseOwnedRequest | RecoverOwnedErasureRequest {
    if (process.platform !== 'linux' && process.platform !== 'darwin') throw new TypeError('Owner erasure supports Linux and Darwin only');
    const fields = recovery ? ['ownerId', 'deleteOperationId', 'operationId'] : ['expectedToken', 'deleteOperationId', 'operationId'];
    if (!evidenceKeys(input, fields)) throw new TypeError('Erasure request has unsupported fields');
    const operationId = input.operationId, deleteOperationId = input.deleteOperationId;
    if (recovery) {
      const ownerId = (input as RecoverOwnedErasureRequest).ownerId;
      erasureBinding({ userId: 'selector', operationId, deleteOperationId, ownerId });
      return Object.freeze({ ownerId, operationId, deleteOperationId });
    }
    const deleted = captureDeleteRequest({ operationId: deleteOperationId, expectedToken: (input as EraseOwnedRequest).expectedToken });
    validateLocator(deleted.expectedToken.locator);
    erasureBinding({ userId: deleted.expectedToken.userId, ownerId: deleted.expectedToken.ownerId, operationId, deleteOperationId });
    return Object.freeze({ operationId, deleteOperationId, expectedToken: deleted.expectedToken });
  }
  private standaloneErasure(input: EraseOwnedRequest | RecoverOwnedErasureRequest, recovery: boolean): Promise<EraseOwnedResult> {
    let captured: EraseOwnedResult | undefined;
    const result = (async () => {
      const request = this.captureErasureRequest(input, recovery);
      return await this.requiredCoordinator().withTenantTransaction(context => this.performOwnedErasure(context, request, recovery, value => { captured = value; }));
    })().catch(cause => {
      if (!captured) throw this.erasePrecommitError(cause);
      if (cause && typeof cause === 'object' && this.eraseErrors.get(cause) === captured) throw cause;
      const error = Object.assign(headError('EOWNERERASED', 'Owner erasure reached its qualified boundary before transaction failure'), { cause, result: captured });
      this.eraseErrors.set(error, captured); throw error;
    });
    void result.catch(() => undefined); return result;
  }
  private erasePrecommitError(cause: unknown): unknown {
    if (cause === null || (typeof cause !== 'object' && typeof cause !== 'function')) return cause;
    if (this.eraseHeadErrors.has(cause)) return cause;
    let marker = false;
    try { const value = cause as { code?: unknown; headDeleted?: unknown }; marker = value.code === 'EOWNERERASED' || value.headDeleted === true || 'result' in value; }
    catch { marker = true; }
    return marker ? Object.assign(headError('EERASURERESIDUAL', 'This erasure has no captured completion'), { cause }) : cause;
  }
  private performOwnedErasure(context: FileMemoryLeaseContext, request: EraseOwnedRequest | RecoverOwnedErasureRequest,
    recovery: boolean, capture?: (result: EraseOwnedResult) => void): Promise<EraseOwnedResult> {
    const coordinator = this.requiredCoordinator(); let captured: EraseOwnedResult | undefined;
    const result = coordinator.perform(context, async operation => {
      const active = () => { coordinator.requireActiveOperationScope(operation); };
      const accounting = new ErasureAccounting(); active(); accounting.charge('lstats');
      const root = await fs.lstat(operation.tenantRoot, { bigint: true });
      const inspection = new ErasureInspection(operation.tenantRoot, String(root.dev), accounting, active);
      const token = 'expectedToken' in request ? request.expectedToken : undefined;
      if (token && (token.userId !== operation.userId || token.tenantRoot !== operation.tenantRoot)) throw headError('EHEADCONFLICT', 'Erasure token belongs to another tenant');
      const binding = { userId: operation.userId, ownerId: token?.ownerId ?? (request as RecoverOwnedErasureRequest).ownerId,
        operationId: request.operationId, deleteOperationId: request.deleteOperationId };
      const executor = new FileMemoryOwnedErasure(inspection, binding, this.options.afterErasurePublication,
        (locator, observer) => this.observeErasureReplacementAtScope(operation, locator, observer),
        value => { captured = value; capture?.(value); });
      let head: FileMemoryOwnedDelete | undefined, headResult: DeleteOwnedResult | undefined;
      let value!: EraseOwnedResult, failed = false, failure: unknown;
      try {
        let existing = true;
        try { await inspection.lstat(`${OWNER_DIRECTORY}/owners/${erasureJournalName(binding.ownerId)}`); }
        catch (cause) { if (!hasCode(cause, 'ENOENT')) throw cause; existing = false; }
        if (!recovery && !existing) {
          if (!token) throw new TypeError('Initial erasure requires an owned token');
          head = new FileMemoryOwnedDelete(operation, { operationId: request.deleteOperationId, expectedToken: token }, active,
            budget => this.snapshotOwnedAtScope(operation, token, budget),
            budget => this.readAtRoot(operation.tenantRoot, operation.userId, token.locator, undefined, budget), this.options.afterDeletePublication,
            deleted => { headResult = deleted; }, { operationId: request.operationId, executor, publication: this.options.afterErasurePublication });
          await head.run();
          if (!headResult) throw headError('EERASURERESIDUAL', 'A minimal head tombstone is not erasure preparation');
        }
        value = await executor.run(recovery || existing, !!headResult, token);
      } catch (cause) { failed = true; failure = cause; }
      try { await this.options.afterErasureWork?.(Object.freeze({ ...executor.workReport, ...(head ? { head: head.erasureHandoffReadWork } : {}) })); }
      catch (cause) { failure = failed ? new AggregateError([failure, cause], 'Erasure operation and diagnostics failed', { cause: failure }) : cause; failed = true; }
      if (failed) {
        if (captured) {
          const error = Object.assign(headError('EOWNERERASED', 'Owner erasure completed before its tracked operation failed'), { cause: failure, result: captured });
          this.eraseErrors.set(error, captured); throw error;
        }
        if (headResult || executor.hasQualifiedHeadDeletion) {
          const error = Object.assign(headError(hasCode(failure, 'EERASURECOMMITUNKNOWN') ? 'EERASURECOMMITUNKNOWN' : 'EERASURERESIDUAL',
            'Head deletion completed; owner erasure remains pending'), { cause: failure, headDeleted: true,
            archiveMutationAttempted: accounting.actual.archiveMutationAttempts > 0,
            headEvidence: headResult?.evidence ?? { tenantRoot: operation.tenantRoot, userId: binding.userId, ownerId: binding.ownerId, operationId: binding.deleteOperationId } });
          this.eraseHeadErrors.add(error); throw error;
        }
        throw this.erasePrecommitError(failure);
      }
      return value;
    }).catch(cause => {
      if (!captured) throw this.erasePrecommitError(cause);
      if (cause && typeof cause === 'object' && this.eraseErrors.get(cause) === captured) throw cause;
      const error = Object.assign(headError('EOWNERERASED', 'Owner erasure completed before transaction failure'), { cause, result: captured });
      this.eraseErrors.set(error, captured); throw error;
    });
    void result.catch(() => undefined); return result;
  }

  /** Dormant same-parent RENAME; exact pending phase replay requires the original request. */
  async renameOwned(input: RenameOwnedRequest): Promise<OwnedFileMemoryToken> {
    let committed: OwnedFileMemoryToken | undefined;
    try {
      const request = captureRenameRequest(input);
      return await this.requiredCoordinator().withTenantTransaction(context =>
        this.performOwnedRename(context, request, token => { committed = token; }));
    } catch (cause) {
      if (!committed) throw this.renamePrecommitError(cause);
      if (cause && typeof cause === 'object' && this.renameErrors.get(cause) === committed) throw cause;
      const error = committedError(cause, committed); this.renameErrors.set(error, committed); throw error;
    }
  }

  renameOwnedInTransaction(context: FileMemoryLeaseContext, input: RenameOwnedRequest): Promise<OwnedFileMemoryToken> {
    try { return this.performOwnedRename(context, captureRenameRequest(input)); }
    catch (cause) { throw this.renamePrecommitError(cause); }
  }

  private renamePrecommitError(cause: unknown): unknown {
    if (cause === null || (typeof cause !== 'object' && typeof cause !== 'function')) return cause;
    let marker: boolean;
    try {
      const value = cause as { code?: unknown; committed?: unknown; token?: unknown };
      marker = value.code === 'EHEADCOMMITTED' || value.committed === true || 'token' in value;
    } catch { marker = true; }
    return marker ? Object.assign(headError('EOWNERRECOVERY', 'This RENAME has no captured publication outcome'), { cause }) : cause;
  }

  private performOwnedRename(context: FileMemoryLeaseContext, request: RenameOwnedRequest,
    capture?: (token: OwnedFileMemoryToken) => void): Promise<OwnedFileMemoryToken> {
    let committed: OwnedFileMemoryToken | undefined;
    const coordinator = this.requiredCoordinator();
    const result = coordinator.perform(context, async operation => {
      try {
        return await new FileMemoryOwnedRename(operation, request,
          () => { coordinator.requireActiveOperationScope(operation); },
          budget => this.readAtRoot(operation.tenantRoot, operation.userId, request.expectedToken.locator, undefined, budget),
          this.options.afterRenamePublication, token => { committed = token; capture?.(token); }).run();
      } catch (cause) {
        if (committed && cause && typeof cause === 'object') this.renameErrors.set(cause, committed);
        throw cause;
      }
    }).catch(cause => {
      if (!committed) throw this.renamePrecommitError(cause);
      if (cause && typeof cause === 'object' && this.renameErrors.get(cause) === committed) throw cause;
      const error = committedError(cause, committed); this.renameErrors.set(error, committed); throw error;
    });
    void result.catch(() => undefined); return result;
  }

  /** Dormant new-owner CREATE or exact persisted-phase forward recovery. */
  async createOwned(input: CreateOwnedRequest): Promise<OwnedFileMemoryToken> {
    let committed: OwnedFileMemoryToken | undefined;
    try {
      const request = this.captureOwnedCreate(input);
      return await this.requiredCoordinator().withTenantTransaction(context =>
        this.performOwnedCreate(context, request, token => { committed = token; }));
    } catch (cause) {
      if (!committed) throw this.createPrecommitError(cause);
      if (cause && typeof cause === 'object' && this.createErrors.get(cause) === committed) throw cause;
      const error = committedError(cause, committed);
      this.createErrors.set(error, committed); throw error;
    }
  }

  /** Uses exactly one existing tracked operation; never acquires a nested lease. */
  createOwnedInTransaction(context: FileMemoryLeaseContext, input: CreateOwnedRequest): Promise<OwnedFileMemoryToken> {
    try { return this.performOwnedCreate(context, this.captureOwnedCreate(input)); }
    catch (cause) { throw this.createPrecommitError(cause); }
  }

  private createPrecommitError(cause: unknown): unknown {
    if (cause === null || (typeof cause !== 'object' && typeof cause !== 'function')) return cause;
    let marker: boolean;
    try {
      const value = cause as { code?: unknown; committed?: unknown; token?: unknown };
      marker = value.code === 'EHEADCOMMITTED' || value.committed === true || 'token' in value;
    } catch { marker = true; }
    if (!marker) return cause;
    return Object.assign(headError('EOWNERRECOVERY', 'This CREATE has no captured publication outcome'), { cause });
  }

  private captureOwnedCreate(input: CreateOwnedRequest): CreateOwnedRequest {
    const request = captureCreateRequest(input);
    validateLocator(request.locator); this.validateHeadForSave(request.content);
    return request;
  }

  private performOwnedCreate(context: FileMemoryLeaseContext, request: CreateOwnedRequest,
    capture?: (token: OwnedFileMemoryToken) => void): Promise<OwnedFileMemoryToken> {
    let committed: OwnedFileMemoryToken | undefined;
    const coordinator = this.requiredCoordinator();
    const result = coordinator.perform(context, async operation => {
      try {
        return await new FileMemoryOwnedCreate(operation, request,
          () => { coordinator.requireActiveOperationScope(operation); }, this.options.afterCreatePublication,
          token => { committed = token; capture?.(token); }).run();
      } catch (cause) {
        if (committed && cause && typeof cause === 'object') this.createErrors.set(cause, committed);
        throw cause;
      }
    }).catch(cause => {
      if (!committed) throw this.createPrecommitError(cause);
      if (cause && typeof cause === 'object' && this.createErrors.get(cause) === committed) throw cause;
      const error = committedError(cause, committed); this.createErrors.set(error, committed); throw error;
    });
    void result.catch(() => undefined);
    return result;
  }

  /**
   * Read-only diagnostic, not a snapshot token or repair permission. Repeated
   * observations are not atomic against active writers; operators must first
   * quiesce every writer before relying on a phase for separately reviewed repair.
   */
  async inspectInterruptedOwnedHead(locator: string): Promise<FileMemoryWriteDiagnostic> {
    const scope = await this.captureStandaloneScope();
    let firstLock;
    try { firstLock = await observeTenantFence(scope.tenantRoot); } catch {
      return this.unknownDiagnostic('Tenant fence cannot be safely observed');
    }
    if (firstLock.present) {
      let secondLock;
      try { secondLock = await observeTenantFence(scope.tenantRoot); } catch {
        return this.unknownDiagnostic('Tenant fence changed during inspection', 'unstable-or-unknown');
      }
      return this.lockDiagnostic(firstLock, secondLock);
    }
    let first: DiagnosticEvidenceRead | undefined;
    let second: DiagnosticEvidenceRead | undefined;
    try {
      first = await this.readDiagnosticEvidence(scope, locator);
      second = await this.readDiagnosticEvidence(scope, locator);
    } catch {
      // Unsafe paths, malformed/partial metadata and missing heads stay unknown.
    }
    let lastLock;
    try { lastLock = await observeTenantFence(scope.tenantRoot); } catch {
      return this.unknownDiagnostic('Tenant fence changed during inspection', 'unstable-or-unknown');
    }
    if (lastLock.present) return this.unknownDiagnostic('Evidence or tenant fence changed', 'unstable-or-unknown');
    if (!first || !second) return this.unknownDiagnostic('Memory evidence is unsafe or incomplete');
    if (first.signature !== second.signature) {
      return this.unknownDiagnostic('Memory evidence changed between reads', 'unstable-or-unknown');
    }
    return classifyFileMemoryWrite(second.evidence);
  }

  private lockDiagnostic(
    first: { present: boolean; identity?: string }, second: { present: boolean; identity?: string },
  ): FileMemoryWriteDiagnostic {
    return first.present === second.present && first.identity === second.identity
      ? this.unknownDiagnostic('Tenant fence is present; stop writers before review', 'blocked-by-fence')
      : this.unknownDiagnostic('Tenant fence changed during inspection', 'unstable-or-unknown');
  }

  private unknownDiagnostic(
    reason: string, kind: 'unknown-manual-review' | 'unstable-or-unknown' | 'blocked-by-fence' = 'unknown-manual-review',
  ): FileMemoryWriteDiagnostic {
    return { kind, reason, artifactNames: [], artifactCount: null,
      artifactNamesTruncated: false, artifactNamesRedacted: true, evidenceComplete: false };
  }

  private async readDiagnosticEvidence(
    scope: FileMemoryTransactionScope, locator: string, recovery: boolean | 'prepared' | 'old-head' = false,
  ): Promise<DiagnosticEvidenceRead> {
    const resolved = await this.resolveHead(scope.tenantRoot, locator);
    const head = await this.readHeadBytes(resolved.headPath);
    const sidecar = await this.readRecord(resolved.sidecarPath);
    const journal = await this.readJournalEvidence(resolved.journalPath);
    const owner = sidecar?.record;
    const write = journal?.record;
    if (owner?.userId !== scope.userId || owner.locator !== resolved.locator ||
      (write && (write.userId !== scope.userId || write.locator !== resolved.locator ||
        write.ownerId !== owner.ownerId))) {
      throw headError('EOWNERRECOVERY', 'Memory diagnostic owner does not bind to the requested head');
    }
    const ownerId = owner.ownerId;
    const registry = await this.readRegistry(scope.tenantRoot, ownerId);
    if (registry?.record.userId !== scope.userId ||
      registry.record.locator !== resolved.locator || registry.record.ownerId !== ownerId) {
      throw headError('EOWNERRECOVERY', 'Memory diagnostic registry does not bind to the requested head');
    }
    const artifacts = await this.collectDiagnosticArtifacts(
      scope.tenantRoot, resolved, sidecar?.record, journal?.record, ownerId);
    const temp = artifacts.exactTemp
      ? await this.readHeadBytes(path.join(path.dirname(resolved.headPath), artifacts.exactTemp), true) : undefined;
    let evidence: FileMemoryWriteEvidence = {
      userId: scope.userId, locator: resolved.locator,
      head: { hash: head.hash, identity: head.identity },
      sidecar: sidecar?.record, registry: registry?.record, journal: journal?.record,
      temp: temp ? { hash: temp.hash, identity: temp.identity } : undefined,
      artifactNames: artifacts.names,
      unexpectedArtifacts: artifacts.unexpected ||
        !this.strictDiagnosticRecord(sidecar?.record) || !this.strictDiagnosticRecord(registry?.record),
    };
    let recoveryStage: DiagnosticEvidenceRead['recoveryStage'];
    if (recovery && (write?.state === 'PUBLISHED_WRITE' ||
      ((recovery === 'prepared' || recovery === 'old-head') && write?.state === 'PREPARED_WRITE'))) {
      recoveryStage = await this.readRecoveryStage(scope, resolved, write, evidence, recovery === 'old-head');
      evidence = { ...evidence, unexpectedArtifacts:
        !this.strictDiagnosticRecord(sidecar?.record) || !this.strictDiagnosticRecord(registry?.record) };
    }
    // Preserve exact raw bytes and filename code units, plus descriptor identities.
    const signature = JSON.stringify({
      evidence, headRaw: head.value, tempRaw: temp?.value,
      sidecarRaw: sidecar?.raw, sidecarIdentity: sidecar?.identity,
      registryRaw: registry?.raw, registryIdentity: registry?.identity,
      journalRaw: journal?.raw, journalIdentity: journal?.identity, recoveryStage,
    });
    return { evidence, signature, headContent: head.value,
      preparedTemp: temp && artifacts.exactTemp ? {
        path: path.join(path.dirname(resolved.headPath), artifacts.exactTemp), raw: temp.value, identity: temp.identity,
      } : undefined,
      journalRaw: journal?.raw, journalIdentity: journal?.identity,
      sidecarRaw: sidecar?.raw, sidecarIdentity: sidecar?.identity,
      registryRaw: registry?.raw, registryIdentity: registry?.identity, recoveryStage, resolved };
  }

  private async readRecoveryStage(
    scope: FileMemoryTransactionScope, resolved: DiagnosticEvidenceRead['resolved'],
    journal: WriteJournal, evidence: FileMemoryWriteEvidence, permitPreparedTemp = false,
  ): Promise<DiagnosticEvidenceRead['recoveryStage']> {
    const registryPath = this.registryPath(scope.tenantRoot, journal.ownerId);
    const registryName = path.basename(registryPath);
    const registryNames = await this.listMatchingArtifacts(path.dirname(registryPath), name =>
      name.toLowerCase() === registryName.toLowerCase() ||
      name.toLowerCase().startsWith(`${registryName.toLowerCase()}.`));
    if (!registryNames.includes(registryName) || registryNames.some(name =>
      name.toLowerCase() === registryName.toLowerCase() && name !== registryName)) {
      throw headError('EOWNERRECOVERY', 'Memory registry namespace is ambiguous');
    }
    const names = evidence.artifactNames.filter(name => name !== path.basename(resolved.journalPath));
    const phase = classifyFileMemoryWrite({ ...evidence, unexpectedArtifacts: false }).kind;
    if (permitPreparedTemp && phase === 'prepared-not-published' &&
      names.length === 1 && names[0] === journal.preparedTempName) return undefined;
    let target: string | undefined;
    if (phase === 'published-before-registry') target = registryPath;
    else if (phase === 'registry-advanced') target = resolved.sidecarPath;
    else if (phase === 'renamed-before-published-journal') target = resolved.journalPath;
    const expectedPath = target ? `${target}.update-${journal.operationId}.tmp` : undefined;
    if (!names.length) return undefined;
    if (names.length !== 1 || !expectedPath || names[0] !== path.basename(expectedPath)) {
      throw headError('EOWNERRECOVERY', 'Memory repair contains unexpected stages');
    }
    const stage = journal.state === 'PREPARED_WRITE'
      ? await this.readJournalEvidence(expectedPath) : await this.readRecord(expectedPath);
    const expectedRaw = journal.state === 'PREPARED_WRITE'
      ? this.serializedJournal({ ...journal, state: 'PUBLISHED_WRITE', publishedHeadIdentity: evidence.head.identity })
      : serializedRecord(this.publishedRecord(journal));
    if (stage?.raw !== expectedRaw) {
      throw headError('EOWNERRECOVERY', 'Memory repair stage is incomplete or mismatched');
    }
    return { path: expectedPath, raw: stage.raw, identity: stage.identity };
  }

  private async collectDiagnosticArtifacts(
    tenantRoot: string,
    resolved: { headPath: string; sidecarPath: string; journalPath: string; basenameHash: string },
    sidecar: OwnerRecord | undefined, journal: WriteJournal | undefined, ownerId: string | undefined,
  ): Promise<{ names: string[]; exactTemp?: string; unexpected: boolean }> {
    const names = await this.listMatchingArtifacts(path.dirname(resolved.headPath), name => {
      const folded = name.toLowerCase();
      const prefix = `.${resolved.basenameHash}.`;
      return folded.startsWith(`${prefix}memory-write`) || folded.startsWith(`${prefix}memory-owner.json`);
    });
    const registryTemps = ownerId ? await this.listMatchingArtifacts(
      path.dirname(this.registryPath(tenantRoot, ownerId)),
      name => name.toLowerCase().startsWith(`${ownerId.toLowerCase()}.json.`),
    ) : [];
    const expectedSidecar = path.basename(resolved.sidecarPath);
    const expectedJournal = path.basename(resolved.journalPath);
    const candidates = names.filter(name => name !== expectedSidecar && name !== expectedJournal);
    const exactTemp = journal?.preparedTempName ??
      (sidecar && candidates.length === 1 && this.isOwnerWriteTemp(candidates[0], resolved.basenameHash, sidecar.ownerId)
        ? candidates[0] : undefined);
    const unexpected = registryTemps.length > 0 || candidates.some(name => name !== exactTemp) ||
      names.some(name => name.toLowerCase() === expectedSidecar && name !== expectedSidecar) ||
      names.some(name => name.toLowerCase() === expectedJournal && name !== expectedJournal);
    return { names: [...names.filter(name => name !== expectedSidecar), ...registryTemps],
      exactTemp: exactTemp && candidates.includes(exactTemp) ? exactTemp : undefined, unexpected };
  }

  private isOwnerWriteTemp(name: string, basenameHash: string, ownerId: string): boolean {
    const prefix = `.${basenameHash}.memory-write.${ownerId}.`;
    return name.startsWith(prefix) && name.endsWith('.tmp') &&
      UUID_PATTERN.test(name.slice(prefix.length, -'.tmp'.length));
  }

  private strictDiagnosticRecord(record: OwnerRecord | undefined): boolean {
    if (!record) return false;
    const fields = new Set(['schema', 'state', 'userId', 'ownerId', 'locator', 'revision',
      'contentHash', 'fileIdentity']);
    const identityFields = new Set(['device', 'inode', 'size', 'ctimeNs', 'mtimeNs']);
    const names = Object.keys(record);
    const identityNames = Object.keys(record.fileIdentity);
    return names.length === fields.size && names.every(name => fields.has(name)) &&
      identityNames.length === identityFields.size && identityNames.every(name => identityFields.has(name)) &&
      ['device', 'inode', 'size'].every(key => /^(?:0|[1-9]\d*)$/u.test(record.fileIdentity[key as keyof FileIdentity])) &&
      ['ctimeNs', 'mtimeNs'].every(key => /^(?:0|[1-9]\d*|-[1-9]\d*)$/u.test(record.fileIdentity[key as keyof FileIdentity]));
  }

  /** Tracked, read-only operation under an existing tenant lease. */
  readHeadSnapshotInTransaction(
    context: FileMemoryLeaseContext, locator: string,
  ): Promise<FileMemorySnapshot> {
    return this.requiredCoordinator().perform(context, scope =>
      this.readAtRoot(scope.tenantRoot, scope.userId, locator));
  }

  /**
   * Dormant operator-maintenance entry point. This never clears an orphan fence:
   * callers must first establish quiescence and handle the lease separately.
   */
  async finalizePublishedOwnedUpdate(request: FinalizeOwnedUpdateRequest): Promise<FinalizeOwnedUpdateResult> {
    return this.runPublishedMaintenance(request, false);
  }

  private async runPublishedMaintenance(
    request: FinalizeOwnedUpdateRequest, forward: boolean | 'prepared' | 'old-head',
  ): Promise<FinalizeOwnedUpdateResult> {
    const captured = { ...request };
    this.validateFinalizeRequest(captured);
    const preparedMode = forward === 'old-head' ? 'old-head' : forward === 'prepared';
    let committedToken: OwnedFileMemoryToken | undefined;
    try {
      return await this.requiredCoordinator().withTenantTransaction(async context => {
        try {
          const result = forward
            ? await this.performForwardMaintenance(context, captured, preparedMode)
            : await this.finalizePublishedOwnedUpdateInTransaction(context, captured);
          if (result.status === 'known-committed') committedToken = result.token;
          return result;
        } catch (cause) {
          const outcome = cause as Partial<CommittedFileHeadError>;
          if (outcome?.committed && outcome.token) committedToken = outcome.token;
          throw cause;
        }
      });
    } catch (cause) {
      if (committedToken) {
        if ((cause as Partial<CommittedFileHeadError>)?.committed) throw cause;
        throw committedError(cause, committedToken);
      }
      throw cause;
    }
  }

  /** A single tracked operation under the caller's fresh tenant lease. */
  finalizePublishedOwnedUpdateInTransaction(
    context: FileMemoryLeaseContext, request: FinalizeOwnedUpdateRequest,
  ): Promise<FinalizeOwnedUpdateResult> {
    const captured = { ...request };
    this.validateFinalizeRequest(captured);
    return this.requiredCoordinator().perform(context, operation => this.finalizeAtScope(operation, captured));
  }

  /** Dormant forward completion; all writers must be quiesced before acquisition. */
  async forwardPublishedOwnedUpdate(request: FinalizeOwnedUpdateRequest): Promise<FinalizeOwnedUpdateResult> {
    return this.runPublishedMaintenance(request, true);
  }

  /**
   * One tracked maintenance operation under the caller's fresh, live lease.
   * Callers retain known-committed results if their outer transaction later fails.
   */
  forwardPublishedOwnedUpdateInTransaction(
    context: FileMemoryLeaseContext, request: FinalizeOwnedUpdateRequest,
  ): Promise<FinalizeOwnedUpdateResult> {
    return this.performForwardMaintenance(context, request, false);
  }

  /** Dormant recovery of PREPARED evidence whose exact prepared file is already at the head. */
  forwardPreparedRenamedOwnedUpdate(request: FinalizeOwnedUpdateRequest): Promise<FinalizeOwnedUpdateResult> {
    return this.runPublishedMaintenance(request, 'prepared');
  }

  /** Caller owns the fresh live lease and retains committed results across outer failures. */
  forwardPreparedRenamedOwnedUpdateInTransaction(
    context: FileMemoryLeaseContext, request: FinalizeOwnedUpdateRequest,
  ): Promise<FinalizeOwnedUpdateResult> {
    return this.performForwardMaintenance(context, request, true);
  }

  /** Dormant forward recovery; only an exact original PREPARED temp may publish a head. */
  forwardPreparedOwnedUpdate(request: FinalizeOwnedUpdateRequest): Promise<FinalizeOwnedUpdateResult> {
    return this.runPublishedMaintenance(request, 'old-head');
  }

  /** Caller owns the fresh lease and retains committed results across outer failures. */
  forwardPreparedOwnedUpdateInTransaction(
    context: FileMemoryLeaseContext, request: FinalizeOwnedUpdateRequest,
  ): Promise<FinalizeOwnedUpdateResult> {
    return this.performForwardMaintenance(context, request, 'old-head');
  }

  private performForwardMaintenance(
    context: FileMemoryLeaseContext, request: FinalizeOwnedUpdateRequest, prepared: boolean | 'old-head',
  ): Promise<FinalizeOwnedUpdateResult> {
    const captured = { ...request };
    this.validateFinalizeRequest(captured);
    return this.requiredCoordinator().perform(context, async operation => {
      try {
        if (prepared === 'old-head') return await this.forwardPreparedOldHeadAtScope(operation, captured);
        return prepared ? await this.forwardPreparedAtScope(operation, captured) :
          await this.forwardAtScope(operation, captured);
      } catch (cause) {
        const error = cause as Partial<CommittedFileHeadError>;
        if (error?.committed || ['EOWNERRECOVERY', 'EINVALIDHEAD', 'EHEADCONFLICT', 'EHEADCOMMITUNKNOWN'].includes(error?.code ?? '')) {
          throw cause;
        }
        const pending = headError('EHEADCOMMITUNKNOWN', 'Owned memory repair remains pending; preserve residual evidence');
        Object.assign(pending, { cause, operationId: captured.operationId, residual: true });
        throw pending;
      }
    });
  }

  private captureAdoptionRequest(request: RecoverAdoptionRequest): RecoverAdoptionRequest {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).length !== 2 || !Object.hasOwn(request, 'locator') || !Object.hasOwn(request, 'ownerId')) {
      throw new TypeError('Adoption recovery requires exactly locator and ownerId');
    }
    const { locator, ownerId } = request;
    if (typeof locator !== 'string' || typeof ownerId !== 'string' || !UUID_PATTERN.test(ownerId)) {
      throw new TypeError('Adoption recovery requires primitive locator and ownerId');
    }
    validateLocator(locator);
    return Object.freeze({ locator, ownerId });
  }

  async recoverReservedAdoption(request: RecoverAdoptionRequest): Promise<RecoverAdoptionResult> {
    const captured = this.captureAdoptionRequest(request);
    let token: OwnedFileMemoryToken | undefined;
    try {
      return await this.requiredCoordinator().withTenantTransaction(async context => {
        return this.performAdoptionRecovery(context, captured, committed => { token = committed; });
      });
    } catch (cause) {
      if (token) throw this.adoptedError(cause, token);
      throw cause;
    }
  }

  /** Caller owns the fresh lease and must retain known-adopted tokens across outer failures. */
  recoverReservedAdoptionInTransaction(
    context: FileMemoryLeaseContext, request: RecoverAdoptionRequest,
  ): Promise<RecoverAdoptionResult> {
    return this.performAdoptionRecovery(context, this.captureAdoptionRequest(request));
  }

  private performAdoptionRecovery(
    context: FileMemoryLeaseContext, captured: RecoverAdoptionRequest, capture?: (token: OwnedFileMemoryToken) => void,
  ): Promise<RecoverAdoptionResult> {
    return this.requiredCoordinator().perform(context, async operation => {
      const budget = new FileMemoryAdoptionRecoveryScanBudget();
      const invocationId = randomUUID();
      let committed: OwnedFileMemoryToken | undefined;
      let publicationPhase: AdoptionProgress | undefined;
      let closeFailure: { cause: unknown } | undefined;
      try {
        this.auditAdoption('requested', invocationId);
        const scope = this.requiredCoordinator().requireActiveOperationScope(operation);
        const resolved = await this.resolveHead(scope.tenantRoot, captured.locator);
        await budget.discover(scope.tenantRoot, path.dirname(resolved.headPath), path.basename(resolved.sidecarPath), captured.ownerId);
        budget.reserve();
        this.requiredCoordinator().requireActiveOperationScope(operation);
        return await this.recoverAdoptionAtScope(operation, captured, budget, invocationId, token => {
          committed = token;
          capture?.(token);
        }, phase => { publicationPhase = phase; }, cause => { closeFailure = { cause }; });
      } catch (cause) {
        if (committed) throw this.adoptedError(cause, committed);
        try { this.auditAdoption('pending-unknown', invocationId); } catch { /* retain original refusal */ }
        if (publicationPhase === 'sidecar-publication-unknown') {
          const error = headError('EADOPTIONCOMMITUNKNOWN', 'Adoption sidecar rename outcome is unknown');
          Object.assign(error, { cause, ownerId: captured.ownerId, residual: true });
          throw error;
        }
        const error = headError('EADOPTIONPENDING', 'Adoption recovery remains pending; preserve residual evidence');
        Object.assign(error, { cause, ownerId: captured.ownerId, residual: true,
          ...(publicationPhase ? { phase: publicationPhase } : {}),
          ...(closeFailure ? { closeCause: closeFailure.cause } : {}) });
        throw error;
      }
    });
  }

  private auditAdoption(
    outcome: 'requested' | 'pending-unknown' | 'known-adopted' | 'already-clean-no-attribution', invocationId: string,
  ): void {
    SecurityMonitor.logSecurityEvent({ type: 'DANGER_ZONE_OPERATION', severity: 'LOW',
      source: 'FileMemoryOwnerSnapshots.adoption-recovery',
      details: `Explicit dormant adoption maintenance: ${outcome} (${invocationId})`, additionalData: { outcome } });
  }

  private adoptedError(cause: unknown, token: OwnedFileMemoryToken): AdoptedFileHeadError {
    if (cause !== null && typeof cause === 'object' && this.adoptedErrors.get(cause) === token) {
      return cause as AdoptedFileHeadError;
    }
    const error = headError('EHEADADOPTED', 'Memory adoption committed; a later operation failed') as AdoptedFileHeadError;
    Object.assign(error, { cause, adopted: true, token });
    this.adoptedErrors.set(error, token);
    return error;
  }

  private async adoptionProof(
    operation: FileMemoryOperationScope, request: RecoverAdoptionRequest, budget: FileMemoryDirectoryScanner,
  ): Promise<AdoptionEvidence> {
    const scope = this.requiredCoordinator().requireActiveOperationScope(operation);
    const evidence = await this.readAdoptionEvidence(scope, request, budget);
    this.requiredCoordinator().requireActiveOperationScope(operation);
    return evidence;
  }

  private async adoptionReproof(
    operation: FileMemoryOperationScope, request: RecoverAdoptionRequest, budget: FileMemoryDirectoryScanner,
    first: AdoptionEvidence, phase: AdoptionRecoveryPublication, topology?: AdoptionTopologyProof,
  ): Promise<AdoptionEvidence> {
    await this.options.afterAdoptionRecoveryPublication?.(phase);
    const last = await this.adoptionProof(operation, request, budget);
    if (first.signature !== last.signature) throw headError('EOWNERRECOVERY', 'Adoption evidence changed before publication');
    await topology?.(last.stage && { path: last.stagePath, identity: last.stage.identity });
    return last;
  }

  private sameAdoptionBase(first: AdoptionEvidence, last: AdoptionEvidence): boolean {
    return sameOwnedToken(first.token, last.token) && first.head.value === last.head.value &&
      isDeepStrictEqual(first.ownerDirectories, last.ownerDirectories) &&
      first.registry.raw === last.registry.raw && sameIdentity(first.registry.identity, last.registry.identity);
  }

  private async requireAdoptionClean(
    operation: FileMemoryOperationScope, request: RecoverAdoptionRequest, budget: FileMemoryDirectoryScanner,
    original: AdoptionEvidence, published?: AdoptionEvidence, topology?: AdoptionTopologyProof,
  ): Promise<AdoptionEvidence> {
    const clean = await this.adoptionProof(operation, request, budget);
    const expected = published?.sidecar ?? original.sidecar;
    if (clean.sidecar.record.state !== 'ACTIVE' || clean.stage || !this.sameAdoptionBase(original, clean) ||
      clean.sidecar.raw !== expected.raw || !sameIdentity(clean.sidecar.identity, expected.identity)) {
      throw headError('EOWNERRECOVERY', 'Adopted evidence changed after publication');
    }
    await topology?.(undefined, clean.sidecar.identity);
    return clean;
  }

  private async recoverAdoptionAtScope(
    operation: FileMemoryOperationScope, request: RecoverAdoptionRequest,
    budget: FileMemoryDirectoryScanner, invocationId: string, capture: (token: OwnedFileMemoryToken) => void,
    progress: (phase: AdoptionProgress) => void, closeFailure: (cause: unknown) => void,
  ): Promise<RecoverAdoptionResult> {
    const createdDirectory = await this.prepareOwnersDirectory(operation, request, budget, progress, closeFailure);
    const topology = createdDirectory?.publicationProof;
    const scope = this.requiredCoordinator().requireActiveOperationScope(operation);
    const registry = createdDirectory ? undefined : await this.readRegistry(scope.tenantRoot, request.ownerId);
    this.requiredCoordinator().requireActiveOperationScope(operation);
    let first = registry ? await this.adoptionProof(operation, request, budget) :
      await this.createAbsentAdoptionRegistry(operation, request, budget, progress, closeFailure, createdDirectory);
    if (first.registry.record.state === 'RESERVED') {
      first = await this.publishReservedRegistry(operation, request, budget, first, progress, topology);
    }
    if (first.registry.record.state !== 'ACTIVE') throw headError('EOWNERRECOVERY', 'Final adoption requires an ACTIVE registry');
    if (first.sidecar.record.state === 'ACTIVE') {
      this.auditAdoption('already-clean-no-attribution', invocationId);
      await this.requireAdoptionClean(operation, request, budget, first);
      return { status: 'already-clean-no-attribution' };
    }
    const staged = await this.stageAdoption(operation, request, budget, first, topology);
    const last = await this.adoptionReproof(operation, request, budget, staged, 'before-rename', topology);
    progress('sidecar-publication-unknown');
    await fs.rename(last.stagePath, last.resolved.sidecarPath);
    // Sole known-adoption commit: capture before any listener, hook or observation await.
    const token: OwnedFileMemoryToken = Object.freeze({ ...last.token,
      fileIdentity: Object.freeze({ ...last.token.fileIdentity }) });
    capture(token);
    try {
      let primary: { cause: unknown } | undefined;
      try { if (topology) await topology(undefined, last.stage!.identity, 'sidecar-rename'); } catch (cause) { primary = { cause }; }
      try { this.auditAdoption('known-adopted', invocationId); } catch (cause) { primary ??= { cause }; }
      if (primary) throw primary.cause;
      await this.options.afterAdoptionRecoveryPublication?.('after-rename');
      const published = await this.adoptionProof(operation, request, budget);
      if (!last.stage || published.stage || published.sidecar.record.state !== 'ACTIVE' ||
        !this.sameAdoptionBase(last, published) || published.sidecar.raw !== last.stage.raw ||
        !samePublishedFile(published.sidecar.identity, last.stage.identity)) {
        throw headError('EOWNERRECOVERY', 'Adoption publication does not match the verified stage');
      }
      await topology?.(undefined, published.sidecar.identity);
      await this.options.afterAdoptionRecoveryPublication?.('after-read');
      await this.requireAdoptionClean(operation, request, budget, last, published, topology);
    } catch (cause) { throw this.adoptedError(cause, token); }
    return { status: 'known-adopted', token };
  }

  private async reservedAdoptionOriginal(
    scope: FileMemoryTransactionScope, request: RecoverAdoptionRequest,
  ): Promise<Pick<AbsentAdoptionEvidence, 'resolved' | 'head' | 'sidecar'>> {
    const resolved = await this.resolveHead(scope.tenantRoot, request.locator);
    const head = await this.readHeadBytes(resolved.headPath);
    const sidecar = await this.readRecord(resolved.sidecarPath);
    if (!sidecar || !this.strictDiagnosticRecord(sidecar.record) || sidecar.record.state !== 'RESERVED' ||
      sidecar.record.revision !== '1' || sidecar.record.userId !== scope.userId ||
      sidecar.record.ownerId !== request.ownerId || sidecar.record.locator !== request.locator ||
      resolved.locator !== request.locator || sidecar.record.contentHash !== head.hash ||
      !sameIdentity(sidecar.record.fileIdentity, head.identity)) {
      throw headError('EOWNERRECOVERY', 'Missing registry requires exact RESERVED sidecar and head');
    }
    return { resolved, head, sidecar };
  }

  private async missingOwnersProof(
    operation: FileMemoryOperationScope, request: RecoverAdoptionRequest, budget: FileMemoryDirectoryScanner,
  ): Promise<MissingOwnersEvidence> {
    const scope = this.requiredCoordinator().requireActiveOperationScope(operation);
    const original = await this.reservedAdoptionOriginal(scope, request);
    const parent = path.dirname(this.registryPath(scope.tenantRoot, request.ownerId));
    const ownerRoot = path.dirname(parent);
    await this.checkPrivateDirectory(ownerRoot);
    const tenantStat = await fs.lstat(scope.tenantRoot, { bigint: true });
    if (!tenantStat.isDirectory() || tenantStat.isSymbolicLink()) throw headError('EOWNERRECOVERY', 'Tenant directory changed');
    const tenantIdentity = identityOf(tenantStat);
    const parentIdentity = identityOf(await fs.lstat(ownerRoot, { bigint: true }));
    const tenantNames = await this.listMatchingArtifacts(scope.tenantRoot, () => true, budget);
    const parentNames = await this.listMatchingArtifacts(ownerRoot, () => true, budget);
    if (!tenantNames.includes(OWNER_DIRECTORY) || tenantNames.some(name => name.toLowerCase() === OWNER_DIRECTORY && name !== OWNER_DIRECTORY) ||
      parentNames.some(name => name.toLowerCase() === 'owners' || name.toLowerCase().startsWith('owners.'))) {
      throw headError('EOWNERRECOVERY', 'Missing owners directory namespace is ambiguous');
    }
    const prefix = `.${original.resolved.basenameHash}.memory-`;
    const headNames = await this.listMatchingArtifacts(path.dirname(original.resolved.headPath), name => name.toLowerCase().startsWith(prefix), budget);
    if (headNames.length !== 1 || headNames[0] !== path.basename(original.resolved.sidecarPath)) {
      throw headError('EOWNERRECOVERY', 'Missing owners directory has unbound head artifacts');
    }
    await this.requireAdoptionNamedFiles([[original.resolved.headPath, original.head.identity], [original.resolved.sidecarPath, original.sidecar.identity]]);
    await this.checkPrivateDirectory(ownerRoot);
    const finalTenantNames = await this.listMatchingArtifacts(scope.tenantRoot, () => true, budget);
    const finalParentNames = await this.listMatchingArtifacts(ownerRoot, () => true, budget);
    const finalHeadNames = await this.listMatchingArtifacts(path.dirname(original.resolved.headPath), name => name.toLowerCase().startsWith(prefix), budget);
    if (!isDeepStrictEqual(tenantNames, finalTenantNames) || !isDeepStrictEqual(parentNames, finalParentNames) ||
      !isDeepStrictEqual(headNames, finalHeadNames)) throw headError('EOWNERRECOVERY', 'Missing owners namespace changed');
    await this.requireAdoptionNamedFiles([[scope.tenantRoot, tenantIdentity], [ownerRoot, parentIdentity],
      [original.resolved.headPath, original.head.identity], [original.resolved.sidecarPath, original.sidecar.identity]]);
    this.requiredCoordinator().requireActiveOperationScope(operation);
    return { original, tenantIdentity, tenantMode: tenantStat.mode, tenantUid: tenantStat.uid, parentIdentity, tenantNames, parentNames,
      signature: JSON.stringify({ original, tenantIdentity, parentIdentity, tenantNames, parentNames }) };
  }

  private async captureOwnersDirectory(file: string, closeFailure: (cause: unknown) => void): Promise<FileIdentity> {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let captured: FileIdentity | undefined;
    let primary: { cause: unknown } | undefined;
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isDirectory() || (stat.mode & 0o077n) !== 0n ||
        (process.getuid && stat.uid !== BigInt(process.getuid()))) throw headError('EOWNERRECOVERY', 'Created owners directory is not private');
      captured = identityOf(stat);
      await this.requireAdoptionNamedFiles([[file, captured]]);
    } catch (cause) { primary = { cause }; }
    try { await handle.close(); } catch (cause) {
      if (!primary) throw cause;
      closeFailure(cause);
    }
    if (primary) throw primary.cause;
    return captured!;
  }

  private async prepareOwnersDirectory(
    operation: FileMemoryOperationScope, request: RecoverAdoptionRequest, budget: FileMemoryDirectoryScanner,
    progress: (phase: AdoptionProgress) => void, closeFailure: (cause: unknown) => void,
  ): Promise<PreparedOwnersDirectory | undefined> {
    const directory = path.dirname(this.registryPath(operation.tenantRoot, request.ownerId));
    try { await fs.lstat(directory); return undefined; } catch (cause) { if (!hasCode(cause, 'ENOENT')) throw cause; }
    const first = await this.prepareOwnershipParent(operation, request, budget, progress, closeFailure) ??
      await this.missingOwnersProof(operation, request, budget);
    await this.options.afterAdoptionRecoveryPublication?.('before-owners-directory-create');
    const last = await this.missingOwnersProof(operation, request, budget);
    if (first.signature !== last.signature) throw headError('EOWNERRECOVERY', 'Missing owners evidence changed');
    this.requiredCoordinator().requireActiveOperationScope(operation);
    progress('owners-directory-creation-unknown');
    await fs.mkdir(directory, { mode: 0o700 });
    const created = await this.captureOwnersDirectory(directory, closeFailure);
    progress('owners-directory-created');
    await this.options.afterAdoptionRecoveryPublication?.('after-owners-directory-create');
    const evidence = await this.absentAdoptionProof(operation, request, budget);
    const tenantNames = await this.listMatchingArtifacts(operation.tenantRoot, () => true, budget);
    const parentNames = await this.listMatchingArtifacts(path.dirname(directory), () => true, budget);
    if (!isDeepStrictEqual(first.original, { resolved: evidence.resolved, head: evidence.head, sidecar: evidence.sidecar }) ||
      !sameIdentity(evidence.ownerDirectories[1], created) || evidence.ownerDirectories[0].device !== first.parentIdentity.device ||
      evidence.ownerDirectories[0].inode !== first.parentIdentity.inode ||
      !isDeepStrictEqual(first.tenantNames, tenantNames) || !isDeepStrictEqual(this.sortArtifactNames([...first.parentNames, 'owners']), parentNames)) {
      throw headError('EOWNERRECOVERY', 'Created owners directory changed original adoption evidence');
    }
    const children = await this.listMatchingArtifacts(directory, () => true, budget);
    if (children.length) throw headError('EOWNERRECOVERY', 'Created owners directory is not empty');
    await this.requireAdoptionNamedFiles([[operation.tenantRoot, first.tenantIdentity],
      [path.dirname(directory), evidence.ownerDirectories[0]], [directory, created],
      [evidence.resolved.headPath, evidence.head.identity], [evidence.resolved.sidecarPath, evidence.sidecar.identity]]);
    this.requiredCoordinator().requireActiveOperationScope(operation);
    return { evidence, reproof: current => this.requireCreatedOwnersContext(operation, budget, first, evidence, current),
      publicationProof: this.createdOwnersPublicationProof(operation, budget, first, evidence) };
  }

  private async missingOwnershipParentProof(
    operation: FileMemoryOperationScope, request: RecoverAdoptionRequest, budget: FileMemoryDirectoryScanner,
  ): Promise<MissingOwnershipParentEvidence> {
    const scope = this.requiredCoordinator().requireActiveOperationScope(operation);
    const original = await this.reservedAdoptionOriginal(scope, request);
    const stat = await fs.lstat(scope.tenantRoot, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw headError('EOWNERRECOVERY', 'Tenant directory changed');
    const tenantIdentity = identityOf(stat);
    const tenantNames = await this.listMatchingArtifacts(scope.tenantRoot, () => true, budget);
    if (tenantNames.some(name => name.toLowerCase() === OWNER_DIRECTORY)) {
      throw headError('EOWNERRECOVERY', 'Missing ownership parent namespace is ambiguous');
    }
    const prefix = `.${original.resolved.basenameHash}.memory-`;
    const headNames = await this.listMatchingArtifacts(path.dirname(original.resolved.headPath), name => name.toLowerCase().startsWith(prefix), budget);
    if (headNames.length !== 1 || headNames[0] !== path.basename(original.resolved.sidecarPath)) {
      throw headError('EOWNERRECOVERY', 'Missing ownership parent has unbound head artifacts');
    }
    await this.requireAdoptionNamedFiles([[original.resolved.headPath, original.head.identity], [original.resolved.sidecarPath, original.sidecar.identity]]);
    const finalTenantNames = await this.listMatchingArtifacts(scope.tenantRoot, () => true, budget);
    const finalHeadNames = await this.listMatchingArtifacts(path.dirname(original.resolved.headPath), name => name.toLowerCase().startsWith(prefix), budget);
    if (!isDeepStrictEqual(tenantNames, finalTenantNames) || !isDeepStrictEqual(headNames, finalHeadNames)) {
      throw headError('EOWNERRECOVERY', 'Missing ownership parent census changed');
    }
    await this.requireAdoptionNamedFiles([[scope.tenantRoot, tenantIdentity],
      [original.resolved.headPath, original.head.identity], [original.resolved.sidecarPath, original.sidecar.identity]]);
    this.requiredCoordinator().requireActiveOperationScope(operation);
    return { original, tenantIdentity, tenantMode: stat.mode, tenantUid: stat.uid, tenantNames,
      signature: JSON.stringify({ original, tenantIdentity, tenantNames }) };
  }

  private async prepareOwnershipParent(
    operation: FileMemoryOperationScope, request: RecoverAdoptionRequest, budget: FileMemoryDirectoryScanner,
    progress: (phase: AdoptionProgress) => void, closeFailure: (cause: unknown) => void,
  ): Promise<MissingOwnersEvidence | undefined> {
    const parent = path.dirname(path.dirname(this.registryPath(operation.tenantRoot, request.ownerId)));
    try { await fs.lstat(parent); return undefined; } catch (cause) { if (!hasCode(cause, 'ENOENT')) throw cause; }
    const first = await this.missingOwnershipParentProof(operation, request, budget);
    await this.options.afterAdoptionRecoveryPublication?.('before-ownership-parent-create');
    const last = await this.missingOwnershipParentProof(operation, request, budget);
    if (first.signature !== last.signature) throw headError('EOWNERRECOVERY', 'Missing ownership parent evidence changed');
    this.requiredCoordinator().requireActiveOperationScope(operation);
    progress('ownership-parent-creation-unknown');
    await fs.mkdir(parent, { mode: 0o700 });
    const captured = await this.captureOwnersDirectory(parent, closeFailure);
    progress('ownership-parent-created');
    // Capture only the exact own mkdir transition before any callback can mutate it.
    const created = await this.missingOwnersProof(operation, request, budget);
    if (!isDeepStrictEqual(first.original, created.original) || !sameIdentity(captured, created.parentIdentity) ||
      created.parentNames.length || created.tenantMode !== first.tenantMode || created.tenantUid !== first.tenantUid ||
      !this.sameCreatedDirectory(first.tenantIdentity, created.tenantIdentity, true) ||
      !isDeepStrictEqual(this.sortArtifactNames([...first.tenantNames, OWNER_DIRECTORY]), created.tenantNames)) {
      throw headError('EOWNERRECOVERY', 'Created ownership parent changed original evidence');
    }
    await this.options.afterAdoptionRecoveryPublication?.('after-ownership-parent-create');
    const rechecked = await this.missingOwnersProof(operation, request, budget);
    if (created.signature !== rechecked.signature) throw headError('EOWNERRECOVERY', 'Created ownership parent evidence changed');
    return created;
  }

  private async requireCreatedOwnersContext(
    operation: FileMemoryOperationScope, budget: FileMemoryDirectoryScanner, original: MissingOwnersEvidence,
    created: AbsentAdoptionEvidence, current: AbsentAdoptionEvidence | AdoptionEvidence,
  ): Promise<void> {
    const parent = path.dirname(path.dirname(this.registryPath(operation.tenantRoot, created.sidecar.record.ownerId)));
    await this.checkPrivateDirectory(parent);
    const tenantNames = await this.listMatchingArtifacts(operation.tenantRoot, () => true, budget);
    const parentNames = await this.listMatchingArtifacts(parent, () => true, budget);
    if (!isDeepStrictEqual(original.tenantNames, tenantNames) || !isDeepStrictEqual(this.sortArtifactNames([...original.parentNames, 'owners']), parentNames) ||
      !sameIdentity(created.ownerDirectories[0], current.ownerDirectories[0]) ||
      created.ownerDirectories[1].device !== current.ownerDirectories[1].device ||
      created.ownerDirectories[1].inode !== current.ownerDirectories[1].inode) {
      throw headError('EOWNERRECOVERY', 'Created owners namespace changed before continuation');
    }
    await this.requireAdoptionNamedFiles([[operation.tenantRoot, original.tenantIdentity], [parent, created.ownerDirectories[0]],
      [path.join(parent, 'owners'), current.ownerDirectories[1]],
      [original.original.resolved.headPath, original.original.head.identity],
      [original.original.resolved.sidecarPath, original.original.sidecar.identity]]);
    this.requiredCoordinator().requireActiveOperationScope(operation);
  }

  private createdOwnersPublicationProof(
    operation: FileMemoryOperationScope, budget: FileMemoryDirectoryScanner,
    original: MissingOwnersEvidence, created: AbsentAdoptionEvidence,
  ): AdoptionTopologyProof {
    let tenantIdentity = original.tenantIdentity;
    let childIdentity = created.ownerDirectories[1];
    let registryCreated = false;
    const root = operation.tenantRoot;
    const registryPath = this.registryPath(root, original.original.sidecar.record.ownerId);
    const childPath = path.dirname(registryPath);
    const parent = path.dirname(childPath);
    const headAtRoot = path.dirname(original.original.resolved.headPath) === root;
    return async (stage, publishedSidecar, transition) => {
      const tenantTransition = transition === 'sidecar-stage' || transition === 'sidecar-rename';
      const childTransition = transition === 'registry-create' || transition === 'registry-stage' || transition === 'registry-rename';
      const expectedNames = [...original.tenantNames];
      if (stage && path.dirname(stage.path) === root) expectedNames.push(path.basename(stage.path));
      const expectedChild = registryCreated || transition === 'registry-create' ? [path.basename(registryPath)] : [];
      if (stage && path.dirname(stage.path) === childPath && stage.path !== registryPath) expectedChild.push(path.basename(stage.path));
      const tenantNames = await this.listMatchingArtifacts(root, () => true, budget);
      const parentNames = await this.listMatchingArtifacts(parent, () => true, budget);
      const childNames = await this.listMatchingArtifacts(childPath, () => true, budget);
      if (!isDeepStrictEqual(this.sortArtifactNames(expectedNames), tenantNames) ||
        !isDeepStrictEqual(this.sortArtifactNames([...original.parentNames, 'owners']), parentNames) ||
        !isDeepStrictEqual(this.sortArtifactNames(expectedChild), childNames)) {
        throw headError('EOWNERRECOVERY', 'Created owners publication namespace changed');
      }
      const tenantStat = await fs.lstat(root, { bigint: true });
      if (!tenantStat.isDirectory() || tenantStat.isSymbolicLink() || tenantStat.mode !== original.tenantMode || tenantStat.uid !== original.tenantUid) {
        throw headError('EOWNERRECOVERY', 'Created owners tenant properties changed');
      }
      const currentTenant = identityOf(tenantStat);
      if (!this.sameCreatedDirectory(tenantIdentity, currentTenant, tenantTransition && headAtRoot)) {
        throw headError('EOWNERRECOVERY', 'Created owners tenant identity changed');
      }
      const sidecarIdentity = publishedSidecar
        ? await this.requireCreatedFileIdentity({ path: original.original.resolved.sidecarPath, identity: publishedSidecar },
          tenantTransition, 'Published sidecar identity changed') : original.original.sidecar.identity;
      await this.checkPrivateDirectory(parent);
      await this.checkPrivateDirectory(childPath);
      const child = identityOf(await fs.lstat(childPath, { bigint: true }));
      if (!this.sameCreatedDirectory(childIdentity, child, childTransition)) {
        throw headError('EOWNERRECOVERY', 'Created owners child identity changed');
      }
      if (!isDeepStrictEqual(tenantNames, await this.listMatchingArtifacts(root, () => true, budget)) ||
        !isDeepStrictEqual(parentNames, await this.listMatchingArtifacts(parent, () => true, budget)) ||
        !isDeepStrictEqual(childNames, await this.listMatchingArtifacts(childPath, () => true, budget))) {
        throw headError('EOWNERRECOVERY', 'Created owners publication census changed');
      }
      await this.requireAdoptionNamedFiles([[root, currentTenant], [parent, created.ownerDirectories[0]],
        [childPath, child],
        [original.original.resolved.headPath, original.original.head.identity],
        [original.original.resolved.sidecarPath, sidecarIdentity]]);
      if (stage) {
        await this.requireCreatedFileIdentity(stage, transition === 'registry-rename', 'Created owners transition descriptor changed');
      }
      this.requiredCoordinator().requireActiveOperationScope(operation);
      tenantIdentity = currentTenant;
      childIdentity = child;
      registryCreated ||= transition === 'registry-create';
    };
  }

  private sameCreatedDirectory(expected: FileIdentity, current: FileIdentity, ownTransition: boolean): boolean {
    if (!ownTransition) return sameIdentity(expected, current);
    return expected.device === current.device && expected.inode === current.inode;
  }

  private async requireCreatedFileIdentity(file: { path: string; identity: FileIdentity }, renamed: boolean, message: string): Promise<FileIdentity> {
    const named = identityOf(await fs.lstat(file.path, { bigint: true }));
    if (!(renamed ? samePublishedFile(named, file.identity) : sameIdentity(named, file.identity))) {
      throw headError('EOWNERRECOVERY', message);
    }
    return named;
  }

  private async absentAdoptionProof(
    operation: FileMemoryOperationScope, request: RecoverAdoptionRequest, budget: FileMemoryDirectoryScanner,
  ): Promise<AbsentAdoptionEvidence> {
    const scope = this.requiredCoordinator().requireActiveOperationScope(operation);
    const { resolved, head, sidecar } = await this.reservedAdoptionOriginal(scope, request);
    const registryPath = this.registryPath(scope.tenantRoot, request.ownerId);
    const directories = [path.dirname(path.dirname(registryPath)), path.dirname(registryPath)];
    for (const directory of directories) await this.checkPrivateDirectory(directory);
    const ownerDirectories = await Promise.all(directories.map(async directory => identityOf(await fs.lstat(directory, { bigint: true }))));
    await this.requireAdoptionNamedFiles([[resolved.headPath, head.identity], [resolved.sidecarPath, sidecar.identity]]);
    const prefix = `.${resolved.basenameHash}.memory-`;
    const headNames = await this.listMatchingArtifacts(path.dirname(resolved.headPath), name => name.toLowerCase().startsWith(prefix), budget);
    const registryNames = await this.listMatchingArtifacts(path.dirname(registryPath), name =>
      name.toLowerCase().startsWith(`${request.ownerId.toLowerCase()}.json`), budget);
    if (headNames.length !== 1 || headNames[0] !== path.basename(resolved.sidecarPath) || registryNames.length) {
      throw headError('EOWNERRECOVERY', 'Missing registry namespace is ambiguous');
    }
    await this.requireAdoptionNamedFiles([[resolved.headPath, head.identity], [resolved.sidecarPath, sidecar.identity]]);
    for (const directory of directories) await this.checkPrivateDirectory(directory);
    const finalHeadNames = await this.listMatchingArtifacts(path.dirname(resolved.headPath), name => name.toLowerCase().startsWith(prefix), budget);
    const finalRegistryNames = await this.listMatchingArtifacts(path.dirname(registryPath), name =>
      name.toLowerCase().startsWith(`${request.ownerId.toLowerCase()}.json`), budget);
    if (!isDeepStrictEqual(headNames, finalHeadNames) || !isDeepStrictEqual(registryNames, finalRegistryNames)) {
      throw headError('EOWNERRECOVERY', 'Missing registry namespace changed during observation');
    }
    await this.requireAdoptionNamedFiles([[resolved.headPath, head.identity], [resolved.sidecarPath, sidecar.identity]]);
    const finalDirectories = await Promise.all(directories.map(async directory => identityOf(await fs.lstat(directory, { bigint: true }))));
    if (!isDeepStrictEqual(ownerDirectories, finalDirectories)) throw headError('EOWNERRECOVERY', 'Missing registry ancestry changed');
    this.requiredCoordinator().requireActiveOperationScope(operation);
    return { resolved, head, sidecar, ownerDirectories, signature: JSON.stringify({ resolved, head, sidecar, ownerDirectories }) };
  }

  private async writeAbsentRegistry(
    operation: FileMemoryOperationScope, file: string, raw: string, closeFailure: (cause: unknown) => void, topology?: AdoptionTopologyProof,
  ): Promise<FileIdentity> {
    this.requiredCoordinator().requireActiveOperationScope(operation);
    const handle = await fs.open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    let created: FileIdentity | undefined;
    let primary: { cause: unknown } | undefined;
    try {
      const bytes = Buffer.from(raw);
      const split = Math.floor(bytes.length / 2);
      for (const [index, chunk] of [bytes.subarray(0, split), bytes.subarray(split)].entries()) {
        let used = 0;
        while (used < chunk.length) {
          this.requiredCoordinator().requireActiveOperationScope(operation);
          const result = await handle.write(chunk, used, chunk.length - used);
          if (!result.bytesWritten) throw headError('EOWNERRECOVERY', 'Registry write made no progress');
          used += result.bytesWritten;
        }
        if (index === 0) await this.proveAbsentRegistryPartial(handle, file, topology);
      }
      this.requiredCoordinator().requireActiveOperationScope(operation);
      await handle.sync();
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(bytes.length) || (stat.mode & 0o077n) !== 0n ||
        (process.getuid && stat.uid !== BigInt(process.getuid()))) throw headError('EOWNERRECOVERY', 'Created registry is not private');
      created = identityOf(stat);
    } catch (cause) { primary = { cause }; }
    try { await handle.close(); } catch (cause) {
      if (!primary) throw cause;
      closeFailure(cause);
    }
    if (primary) throw primary.cause;
    return created!;
  }

  private async proveAbsentRegistryPartial(handle: fs.FileHandle, file: string, topology?: AdoptionTopologyProof): Promise<void> {
    const partial = topology ? { path: file, identity: identityOf(await handle.stat({ bigint: true })) } : undefined;
    await topology?.(partial, undefined, 'registry-create');
    await this.options.afterAdoptionRecoveryPublication?.('partial-registry-create');
    await topology?.(partial);
  }

  private async createAbsentAdoptionRegistry(
    operation: FileMemoryOperationScope, request: RecoverAdoptionRequest, budget: FileMemoryDirectoryScanner,
    progress: (phase: AdoptionProgress) => void, closeFailure: (cause: unknown) => void, carried?: PreparedOwnersDirectory,
  ): Promise<AdoptionEvidence> {
    const first = await this.absentAdoptionProof(operation, request, budget);
    if (carried && carried.evidence.signature !== first.signature) throw headError('EOWNERRECOVERY', 'Created owners evidence changed before registry creation');
    const raw = serializedRecord(first.sidecar.record);
    await this.options.afterAdoptionRecoveryPublication?.('before-registry-create');
    const last = await this.absentAdoptionProof(operation, request, budget);
    if (first.signature !== last.signature) throw headError('EOWNERRECOVERY', 'Missing registry evidence changed');
    await carried?.reproof(last);
    progress('registry-creation-unknown');
    const created = await this.writeAbsentRegistry(operation, this.registryPath(operation.tenantRoot, request.ownerId), raw, closeFailure, carried?.publicationProof);
    progress('registry-created');
    await this.options.afterAdoptionRecoveryPublication?.('after-registry-create');
    const pair = await this.adoptionProof(operation, request, budget);
    if (pair.registry.record.state !== 'RESERVED' || pair.stage || pair.registry.raw !== raw ||
      !sameIdentity(pair.registry.identity, created) || pair.head.value !== first.head.value ||
      !sameIdentity(pair.head.identity, first.head.identity) || pair.sidecar.raw !== first.sidecar.raw ||
      !sameIdentity(pair.sidecar.identity, first.sidecar.identity) ||
      !sameIdentity(pair.ownerDirectories[0], first.ownerDirectories[0]) ||
      pair.ownerDirectories[1].device !== first.ownerDirectories[1].device ||
      pair.ownerDirectories[1].inode !== first.ownerDirectories[1].inode) {
      throw headError('EOWNERRECOVERY', 'Created registry changed original adoption evidence');
    }
    await carried?.reproof(pair);
    await carried?.publicationProof();
    return pair;
  }

  private async stageAdoption(
    operation: FileMemoryOperationScope, request: RecoverAdoptionRequest,
    budget: FileMemoryDirectoryScanner, first: AdoptionEvidence, topology?: AdoptionTopologyProof,
  ): Promise<AdoptionEvidence> {
    let staged = await this.adoptionReproof(operation, request, budget, first, 'before-stage', topology);
    if (!staged.stage) {
      const raw = serializedRecord(staged.registry.record);
      const handle = await fs.open(staged.stagePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      let created: FileIdentity;
      try {
        const split = Math.floor(Buffer.byteLength(raw) / 2);
        const bytes = Buffer.from(raw);
        await handle.writeFile(bytes.subarray(0, split));
        const partial = topology ? { path: staged.stagePath, identity: identityOf(await handle.stat({ bigint: true })) } : undefined;
        await topology?.(partial, undefined, 'sidecar-stage');
        await this.options.afterAdoptionRecoveryPublication?.('partial-stage');
        await topology?.(partial);
        this.requiredCoordinator().requireActiveOperationScope(operation);
        await handle.writeFile(bytes.subarray(split));
        await handle.sync();
        created = identityOf(await handle.stat({ bigint: true }));
      } finally { await handle.close(); }
      staged = await this.adoptionProof(operation, request, budget);
      if (!this.sameAdoptionBase(first, staged) || staged.sidecar.raw !== first.sidecar.raw ||
        !sameIdentity(staged.sidecar.identity, first.sidecar.identity) ||
        !staged.stage || !sameIdentity(staged.stage.identity, created)) {
        throw headError('EOWNERRECOVERY', 'Adoption evidence changed during staging');
      }
      await topology?.({ path: staged.stagePath, identity: staged.stage!.identity });
    }
    return this.adoptionReproof(operation, request, budget, staged, 'verified-stage', topology);
  }

  private sameRegistryTransitionBase(first: AdoptionEvidence, last: AdoptionEvidence): boolean {
    return sameOwnedToken(first.token, last.token) && first.head.value === last.head.value &&
      first.sidecar.raw === last.sidecar.raw && sameIdentity(first.sidecar.identity, last.sidecar.identity) &&
      sameIdentity(first.ownerDirectories[0], last.ownerDirectories[0]) &&
      first.ownerDirectories[1].device === last.ownerDirectories[1].device &&
      first.ownerDirectories[1].inode === last.ownerDirectories[1].inode;
  }

  private async publishReservedRegistry(
    operation: FileMemoryOperationScope, request: RecoverAdoptionRequest, budget: FileMemoryDirectoryScanner,
    first: AdoptionEvidence, progress: (phase: 'registry-publication-unknown' | 'registry-published') => void,
    topology?: AdoptionTopologyProof,
  ): Promise<AdoptionEvidence> {
    let staged = await this.adoptionReproof(operation, request, budget, first, 'before-registry-stage', topology);
    if (!staged.stage) {
      const bytes = Buffer.from(serializedRecord({ ...staged.registry.record, state: 'ACTIVE' }));
      const handle = await fs.open(staged.stagePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      let created: FileIdentity;
      try {
        const split = Math.floor(bytes.length / 2);
        await handle.writeFile(bytes.subarray(0, split));
        const partial = topology ? { path: staged.stagePath, identity: identityOf(await handle.stat({ bigint: true })) } : undefined;
        await topology?.(partial, undefined, 'registry-stage');
        await this.options.afterAdoptionRecoveryPublication?.('partial-registry-stage');
        await topology?.(partial);
        this.requiredCoordinator().requireActiveOperationScope(operation);
        await handle.writeFile(bytes.subarray(split));
        await handle.sync();
        created = identityOf(await handle.stat({ bigint: true }));
      } finally { await handle.close(); }
      staged = await this.adoptionProof(operation, request, budget);
      if (!this.sameRegistryTransitionBase(first, staged) || first.registry.raw !== staged.registry.raw ||
        !sameIdentity(first.registry.identity, staged.registry.identity) || !staged.stage ||
        !sameIdentity(staged.stage.identity, created)) {
        throw headError('EOWNERRECOVERY', 'Registry staging changed bound adoption evidence');
      }
    }
    staged = await this.adoptionReproof(operation, request, budget, staged, 'verified-registry-stage', topology);
    const last = await this.adoptionReproof(operation, request, budget, staged, 'before-registry-rename', topology);
    progress('registry-publication-unknown');
    await fs.rename(last.stagePath, this.registryPath(operation.tenantRoot, request.ownerId));
    progress('registry-published');
    if (topology) await topology({ path: this.registryPath(operation.tenantRoot, request.ownerId), identity: last.stage!.identity }, undefined, 'registry-rename');
    await this.options.afterAdoptionRecoveryPublication?.('after-registry-rename');
    const published = await this.adoptionProof(operation, request, budget);
    if (!last.stage || published.stage || published.registry.record.state !== 'ACTIVE' ||
      !this.sameRegistryTransitionBase(last, published) || published.registry.raw !== last.stage.raw ||
      !samePublishedFile(published.registry.identity, last.stage.identity)) {
      throw headError('EOWNERRECOVERY', 'Registry publication does not match the verified stage');
    }
    await topology?.();
    return published;
  }

  private async readAdoptionEvidence(
    scope: FileMemoryTransactionScope, request: RecoverAdoptionRequest, budget: FileMemoryDirectoryScanner,
  ): Promise<AdoptionEvidence> {
    const resolved = await this.resolveHead(scope.tenantRoot, request.locator);
    const head = await this.readHeadBytes(resolved.headPath);
    const sidecar = await this.readRecord(resolved.sidecarPath);
    const registry = await this.readRegistry(scope.tenantRoot, request.ownerId);
    if (!sidecar || !registry || !this.strictDiagnosticRecord(sidecar.record) || !this.strictDiagnosticRecord(registry.record) ||
      registry.record.revision !== '1' ||
      (registry.record.state === 'RESERVED' && sidecar.record.state !== 'RESERVED') ||
      !isDeepStrictEqual({ ...sidecar.record, state: 'ACTIVE' }, { ...registry.record, state: 'ACTIVE' }) ||
      registry.record.userId !== scope.userId || registry.record.ownerId !== request.ownerId ||
      registry.record.locator !== request.locator || resolved.locator !== request.locator ||
      registry.record.contentHash !== head.hash || !sameIdentity(registry.record.fileIdentity, head.identity)) {
      throw headError('EOWNERRECOVERY', 'Adoption requires the unchanged revision-one owner triple');
    }
    const registryPath = this.registryPath(scope.tenantRoot, request.ownerId);
    const ownerPaths = [path.dirname(path.dirname(registryPath)), path.dirname(registryPath)];
    const ownerDirectories = await Promise.all(ownerPaths.map(async directory => identityOf(await fs.lstat(directory, { bigint: true }))));
    const reservedPair = registry.record.state === 'RESERVED';
    const stagePath = `${reservedPair ? registryPath : resolved.sidecarPath}.adopt-${request.ownerId}.tmp`;
    const namespaces = await this.adoptionNamespace(scope, resolved, request.ownerId, budget, reservedPair);
    const names = namespaces.headNames;
    const sidecarName = path.basename(resolved.sidecarPath);
    const stageName = path.basename(stagePath);
    if (!names.includes(sidecarName) || names.some(name => name !== sidecarName && (reservedPair || name !== stageName)) ||
      (sidecar.record.state === 'ACTIVE' && names.includes(stageName))) {
      throw headError('EOWNERRECOVERY', 'Adoption namespace contains unbound artifacts');
    }
    const stagePresent = (reservedPair ? namespaces.registryNames : names).includes(stageName);
    const stage = stagePresent ? await this.readRecord(stagePath) : undefined;
    if (stagePresent && stage?.raw !== serializedRecord({ ...registry.record, state: 'ACTIVE' })) {
      throw headError('EOWNERRECOVERY', 'Adoption stage is incomplete or mismatched');
    }
    const finalNames = await this.adoptionNamespace(scope, resolved, request.ownerId, budget, reservedPair);
    if (!isDeepStrictEqual(namespaces, finalNames)) throw headError('EOWNERRECOVERY', 'Adoption namespace changed during observation');
    await this.requireAdoptionNamedFiles([[resolved.headPath, head.identity], [resolved.sidecarPath, sidecar.identity],
      [registryPath, registry.identity], ...(stage ? [[stagePath, stage.identity] as [string, FileIdentity]] : [])]);
    const finalDirectories = await Promise.all(ownerPaths.map(async directory => identityOf(await fs.lstat(directory, { bigint: true }))));
    if (!isDeepStrictEqual(ownerDirectories, finalDirectories)) throw headError('EOWNERRECOVERY', 'Adoption owner ancestry changed');
    const token: OwnedFileMemoryToken = { backend: 'file', ownership: 'owned', userId: scope.userId,
      tenantRoot: scope.tenantRoot, locator: request.locator, ownerId: request.ownerId, revision: '1',
      contentHash: head.hash, fileIdentity: head.identity };
    return { resolved, head, sidecar, registry, stage, stagePath, token, ownerDirectories,
      signature: JSON.stringify({ head, sidecar, registry, stage, namespaces, ownerDirectories }) };
  }

  private async requireAdoptionNamedFiles(files: readonly [string, FileIdentity][], index = 0): Promise<void> {
    const current = files[index];
    if (!current) return;
    const [file, expected] = current;
    if (!sameIdentity(identityOf(await fs.lstat(file, { bigint: true })), expected)) {
      throw headError('EOWNERRECOVERY', 'Adoption named evidence changed during observation');
    }
    // The caller supplies only the bounded head/sidecar/registry/optional-stage set.
    await this.requireAdoptionNamedFiles(files, index + 1);
  }

  private async adoptionNamespace(
    scope: FileMemoryTransactionScope, resolved: DiagnosticEvidenceRead['resolved'], ownerId: string,
    budget: FileMemoryDirectoryScanner, reservedPair: boolean,
  ): Promise<{ headNames: string[]; registryNames: string[] }> {
    const prefix = `.${resolved.basenameHash}.memory-`;
    const names = await this.listMatchingArtifacts(path.dirname(resolved.headPath), name => name.toLowerCase().startsWith(prefix), budget);
    const registryPath = this.registryPath(scope.tenantRoot, ownerId);
    await this.checkPrivateDirectory(path.dirname(path.dirname(registryPath)));
    await this.checkPrivateDirectory(path.dirname(registryPath));
    const registryNames = await this.listMatchingArtifacts(path.dirname(registryPath), name =>
      name.toLowerCase().startsWith(`${ownerId.toLowerCase()}.json`), budget);
    const registryName = path.basename(registryPath);
    const stageName = `${registryName}.adopt-${ownerId}.tmp`;
    if (!registryNames.includes(registryName) || registryNames.some(name =>
      name !== registryName && (!reservedPair || name !== stageName))) {
      throw headError('EOWNERRECOVERY', 'Adoption registry namespace is ambiguous');
    }
    return { headNames: names, registryNames };
  }

  /** Dormant explicit abort; all writers quiescent and orphan leases separately handled. */
  async abortPreparedOwnedUpdate(request: FinalizeOwnedUpdateRequest): Promise<AbortOwnedUpdateResult> {
    const captured = { ...request };
    this.validateFinalizeRequest(captured);
    let receipt: FileMemoryAbortReceipt | undefined;
    try {
      return await this.requiredCoordinator().withTenantTransaction(async context => {
        try {
          const result = await this.abortPreparedOwnedUpdateInTransaction(context, captured);
          if (result.status === 'known-aborted') receipt = result.receipt;
          return result;
        } catch (cause) {
          const known = cause as Partial<AbortedFileHeadError>;
          if (known?.aborted && known.receipt) receipt = known.receipt;
          throw cause;
        }
      });
    } catch (cause) {
      if (receipt && !(cause as Partial<AbortedFileHeadError>)?.aborted) throw this.abortedError(cause, receipt);
      throw cause;
    }
  }

  /** Caller owns the fresh lease and retains known-aborted receipts across outer failure. */
  abortPreparedOwnedUpdateInTransaction(
    context: FileMemoryLeaseContext, request: FinalizeOwnedUpdateRequest,
  ): Promise<AbortOwnedUpdateResult> {
    const captured = { ...request };
    this.validateFinalizeRequest(captured);
    return this.requiredCoordinator().perform(context, async operation => {
      const auditInvocationId = randomUUID();
      try {
        this.auditAbort('requested', auditInvocationId);
        const result = await this.abortAtScope(operation, captured, auditInvocationId);
        return result;
      } catch (cause) {
        if ((cause as Partial<AbortedFileHeadError>)?.aborted) throw cause;
        // An audit failure never replaces the original error/evidence classification.
        try { this.auditAbort('pending-unknown', auditInvocationId); } catch { /* retain original cause */ }
        const code = (cause as NodeJS.ErrnoException)?.code;
        if (code === 'EOWNERRECOVERY' || code === 'EHEADCONFLICT' || code === 'EINVALIDHEAD' ||
          code === 'EABORTCOMMITUNKNOWN' || code === 'EABORTPENDING') throw cause;
        const error = headError('EABORTPENDING', 'Memory abort remains pending; preserve residual evidence');
        Object.assign(error, { cause, operationId: captured.operationId, residual: true });
        throw error;
      }
    });
  }

  private auditAbort(
    outcome: 'requested' | 'pending-unknown' | 'known-aborted' | 'already-clean-no-attribution', invocationId: string,
  ): void {
    SecurityMonitor.logSecurityEvent({ type: 'DANGER_ZONE_OPERATION', severity: 'LOW',
      source: 'FileMemoryOwnerSnapshots.abort', details: `Explicit dormant memory abort maintenance: ${outcome} (${invocationId})`,
      additionalData: { outcome } });
  }

  private abortedError(cause: unknown, receipt: FileMemoryAbortReceipt): AbortedFileHeadError {
    const error = headError('EHEADABORTED', 'Memory update aborted; a later operation failed') as AbortedFileHeadError;
    Object.assign(error, { cause, aborted: true, receipt });
    return error;
  }

  private async abortAtScope(
    operation: FileMemoryOperationScope, request: FinalizeOwnedUpdateRequest, auditInvocationId: string,
  ): Promise<AbortOwnedUpdateResult> {
    const scope = this.requiredCoordinator().requireActiveOperationScope(operation);
    let first = await this.readAbortEvidence(scope, request);
    this.requiredCoordinator().requireActiveOperationScope(operation);
    if (!first.journal) {
      this.auditAbort('already-clean-no-attribution', auditInvocationId);
      await this.requireCleanAbort(operation, request, first);
      return { status: 'already-clean-no-attribution' };
    }
    if (first.prepared) first = await this.publishAbortIntent(operation, request, first);
    if (first.temp) {
      try {
        const last = await this.abortReproof(operation, request, first, 'before-temp-unlink');
        await fs.unlink(path.join(path.dirname(last.resolved.headPath), last.intent!.preparedTempName));
        await this.options.afterAbortPublication?.('after-temp-unlink');
        const advanced = await this.readAbortEvidence(scope, request);
        this.requiredCoordinator().requireActiveOperationScope(operation);
        if (!this.sameAbortBase(last, advanced) || advanced.temp) {
          throw this.pendingAbortError(headError('EOWNERRECOVERY', 'Abort evidence changed after temp removal'), request);
        }
        first = advanced;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException)?.code === 'EABORTPENDING') throw cause;
        throw this.pendingAbortError(cause, request);
      }
    }
    const last = await this.abortReproof(operation, request, first, 'before-journal-unlink');
    if (!last.intent || last.temp) throw headError('EOWNERRECOVERY', 'Abort is not ready for finalization');
    const journal = await this.readAbortRaw(last.resolved.journalPath);
    this.requiredCoordinator().requireActiveOperationScope(operation);
    if (journal?.raw !== last.journal!.raw || !sameIdentity(journal.identity, last.journal!.identity)) {
      throw headError('EOWNERRECOVERY', 'Abort journal changed before finalization');
    }
    try { await fs.unlink(last.resolved.journalPath); }
    catch (cause) {
      const error = headError('EABORTCOMMITUNKNOWN', 'Abort journal unlink outcome is unknown');
      Object.assign(error, { cause, operationId: request.operationId, residual: true });
      throw error;
    }
    // Sole known-abort commit. Capture before any hook, audit or observation await.
    const receipt: FileMemoryAbortReceipt = Object.freeze({ operationId: request.operationId,
      token: Object.freeze({ ...last.token, fileIdentity: Object.freeze({ ...last.token.fileIdentity }) }) });
    try {
      this.auditAbort('known-aborted', auditInvocationId);
      await this.options.afterAbortPublication?.('after-journal-unlink');
      await this.requireCleanAbort(operation, request, last);
      await this.options.afterAbortPublication?.('after-abort-read');
      await this.requireCleanAbort(operation, request, last);
    } catch (cause) { throw this.abortedError(cause, receipt); }
    return { status: 'known-aborted', receipt };
  }

  private async requireCleanAbort(
    operation: FileMemoryOperationScope, request: FinalizeOwnedUpdateRequest, original: AbortEvidence,
  ): Promise<void> {
    const scope = this.requiredCoordinator().requireActiveOperationScope(operation);
    const clean = await this.readAbortEvidence(scope, request);
    this.requiredCoordinator().requireActiveOperationScope(operation);
    if (clean.journal || !this.sameAbortOwner(original, clean)) {
      throw headError('EOWNERRECOVERY', 'Aborted owner changed after finalization');
    }
  }

  private async abortReproof(
    operation: FileMemoryOperationScope, request: FinalizeOwnedUpdateRequest, first: AbortEvidence, phase: AbortPublication,
  ): Promise<AbortEvidence> {
    await this.options.afterAbortPublication?.(phase);
    const scope = this.requiredCoordinator().requireActiveOperationScope(operation);
    const last = await this.readAbortEvidence(scope, request);
    this.requiredCoordinator().requireActiveOperationScope(operation);
    if (first.signature !== last.signature) throw headError('EOWNERRECOVERY', 'Abort evidence changed before mutation');
    return last;
  }

  private sameAbortBase(left: AbortEvidence, right: AbortEvidence): boolean {
    return this.sameAbortOwner(left, right) &&
      left.journal?.raw === right.journal?.raw && isDeepStrictEqual(left.journal?.identity, right.journal?.identity);
  }

  private sameAbortOwner(left: AbortEvidence, right: AbortEvidence): boolean {
    return sameOwnedToken(left.token, right.token) && left.sidecar.raw === right.sidecar.raw &&
      left.registry.raw === right.registry.raw && sameIdentity(left.sidecar.identity, right.sidecar.identity) &&
      sameIdentity(left.registry.identity, right.registry.identity);
  }

  private abortIntent(first: AbortEvidence): FileMemoryAbortIntent {
    const journal = first.prepared!;
    return { ...journal, schema: 2, state: 'ABORTING_WRITE',
      preparedJournalHash: createHash('sha256').update(first.journal!.raw).digest('hex'),
      preparedJournalIdentity: first.journal!.identity,
      oldSidecarHash: createHash('sha256').update(first.sidecar.raw).digest('hex'), oldSidecarIdentity: first.sidecar.identity,
      oldRegistryHash: createHash('sha256').update(first.registry.raw).digest('hex'), oldRegistryIdentity: first.registry.identity };
  }

  private pendingAbortError(cause: unknown, request: FinalizeOwnedUpdateRequest): NodeJS.ErrnoException {
    const error = headError('EABORTPENDING', 'Memory abort remains pending; preserve residual evidence');
    Object.assign(error, { cause, operationId: request.operationId, residual: true });
    return error;
  }

  private async publishAbortIntent(
    operation: FileMemoryOperationScope, request: FinalizeOwnedUpdateRequest, first: AbortEvidence,
  ): Promise<AbortEvidence> {
    try { return await this.publishAbortIntentAtScope(operation, request, first); }
    catch (cause) { throw this.pendingAbortError(cause, request); }
  }

  private async publishAbortIntentAtScope(
    operation: FileMemoryOperationScope, request: FinalizeOwnedUpdateRequest, first: AbortEvidence,
  ): Promise<AbortEvidence> {
    const raw = serializeFileMemoryAbortIntent(this.abortIntent(first));
    const stagePath = `${first.resolved.journalPath}.abort-${request.operationId}.tmp`;
    let staged = first;
    if (!first.stage) {
      await this.abortReproof(operation, request, first, 'before-intent-stage');
      const handle = await fs.open(stagePath, 'wx', 0o600);
      let created: FileIdentity;
      try {
        const bytes = Buffer.from(raw);
        const split = Math.floor(bytes.length / 2);
        await handle.writeFile(bytes.subarray(0, split));
        await this.options.afterAbortPublication?.('partial-intent-stage');
        await handle.writeFile(bytes.subarray(split));
        await handle.sync();
        created = identityOf(await handle.stat({ bigint: true }));
      } finally { await handle.close(); }
      const scope = this.requiredCoordinator().requireActiveOperationScope(operation);
      staged = await this.readAbortEvidence(scope, request);
      if (!this.sameAbortBase(first, staged) || !staged.stage || !sameIdentity(staged.stage.identity, created)) {
        throw headError('EOWNERRECOVERY', 'Abort evidence changed during intent staging');
      }
    }
    await this.options.afterAbortPublication?.('verified-intent-stage');
    const last = await this.abortReproof(operation, request, staged, 'before-intent-rename');
    await fs.rename(stagePath, last.resolved.journalPath);
    await this.options.afterAbortPublication?.('after-intent-rename');
    const scope = this.requiredCoordinator().requireActiveOperationScope(operation);
    const advanced = await this.readAbortEvidence(scope, request);
    this.requiredCoordinator().requireActiveOperationScope(operation);
    if (!advanced.intent || advanced.journal?.raw !== raw || !last.stage ||
      !samePublishedFile(last.stage.identity, advanced.journal.identity) ||
      !sameOwnedToken(last.token, advanced.token) || !isDeepStrictEqual(last.temp, advanced.temp) ||
      last.sidecar.raw !== advanced.sidecar.raw || last.registry.raw !== advanced.registry.raw ||
      !sameIdentity(last.sidecar.identity, advanced.sidecar.identity) || !sameIdentity(last.registry.identity, advanced.registry.identity)) {
      throw headError('EOWNERRECOVERY', 'Abort intent publication proof changed');
    }
    return advanced;
  }

  private async readAbortRaw(filePath: string): Promise<{ raw: string; identity: FileIdentity } | undefined> {
    let handle;
    try { handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (cause) {
      if (hasCode(cause, 'ENOENT')) return undefined;
      throw cause;
    }
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_JOURNAL_BYTES) ||
        (before.mode & 0o077n) !== 0n || (process.getuid && before.uid !== BigInt(process.getuid()))) {
        throw headError('EOWNERRECOVERY', 'Abort journal is not a bounded private regular file');
      }
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let used = 0;
      while (used < bytes.length) {
        const next = await handle.read(bytes, used, bytes.length - used, used);
        if (!next.bytesRead) break;
        used += next.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const named = await fs.lstat(filePath, { bigint: true });
      if (BigInt(used) !== after.size || !sameIdentity(identityOf(before), identityOf(after)) ||
        !sameIdentity(identityOf(after), identityOf(named))) {
        throw headError('EOWNERRECOVERY', 'Abort journal changed during bounded read');
      }
      return { raw: decodeUtf8(bytes.subarray(0, used), 'EOWNERRECOVERY'), identity: identityOf(after) };
    } finally { await handle.close(); }
  }

  private async readAbortEvidence(scope: FileMemoryTransactionScope, request: FinalizeOwnedUpdateRequest): Promise<AbortEvidence> {
    const resolved = await this.resolveHead(scope.tenantRoot, request.locator);
    const head = await this.readHeadBytes(resolved.headPath);
    const sidecar = await this.readRecord(resolved.sidecarPath);
    const registry = await this.readRegistry(scope.tenantRoot, request.ownerId);
    if (!sidecar || !registry || !this.strictDiagnosticRecord(sidecar.record) || !this.strictDiagnosticRecord(registry.record) ||
      sidecar.record.state !== 'ACTIVE' || registry.record.state !== 'ACTIVE' ||
      !isDeepStrictEqual(sidecar.record, registry.record) || sidecar.record.userId !== scope.userId ||
      sidecar.record.ownerId !== request.ownerId || sidecar.record.locator !== request.locator || resolved.locator !== request.locator ||
      sidecar.record.contentHash !== head.hash || !sameIdentity(sidecar.record.fileIdentity, head.identity)) {
      throw headError('EOWNERRECOVERY', 'Abort requires an unchanged agreeing old owner triple');
    }
    const journal = await this.readAbortRaw(resolved.journalPath);
    const { intent, prepared } = this.requireAbortJournal(scope, request, head, sidecar, registry, journal);
    const names = await this.abortNamespace(scope, resolved, request.ownerId);
    const stageName = `${path.basename(resolved.journalPath)}.abort-${request.operationId}.tmp`;
    const bound = intent ?? prepared;
    const permitted = new Set([path.basename(resolved.journalPath), bound?.preparedTempName, prepared ? stageName : undefined]);
    if (names.some(name => !permitted.has(name)) || (!!journal !== names.includes(path.basename(resolved.journalPath)))) {
      throw headError('EOWNERRECOVERY', 'Abort namespace contains unbound artifacts');
    }
    const temp = bound && names.includes(bound.preparedTempName)
      ? await this.readHeadBytes(path.join(path.dirname(resolved.headPath), bound.preparedTempName), true) : undefined;
    this.requireAbortTemp(scope, request, { head, sidecar, registry, prepared, bound, temp }, names, stageName);
    const token: OwnedFileMemoryToken = { backend: 'file', ownership: 'owned', userId: scope.userId,
      tenantRoot: scope.tenantRoot, locator: request.locator, ownerId: request.ownerId,
      revision: sidecar.record.revision, contentHash: head.hash, fileIdentity: head.identity };
    const base = { resolved, token, journal, intent, prepared, temp, sidecar, registry };
    const stage = names.includes(stageName) ? await this.readAbortRaw(path.join(path.dirname(resolved.headPath), stageName)) : undefined;
    if (names.includes(stageName) && stage?.raw !== serializeFileMemoryAbortIntent(this.abortIntent({ ...base, signature: '' }))) {
      throw headError('EOWNERRECOVERY', 'Abort stage is incomplete or mismatched');
    }
    return { ...base, stage, signature: JSON.stringify({ base, names, stage, headRaw: head.value }) };
  }

  private requireAbortJournal(
    scope: FileMemoryTransactionScope, request: FinalizeOwnedUpdateRequest,
    head: { hash: string; identity: FileIdentity }, sidecar: AbortEvidence['sidecar'], registry: AbortEvidence['registry'],
    journal: AbortEvidence['journal'],
  ): { intent?: FileMemoryAbortIntent; prepared?: WriteJournal } {
    if (!journal) return {};
    let intent: FileMemoryAbortIntent | undefined;
    let prepared: WriteJournal | undefined;
    let value: unknown;
    try { value = JSON.parse(journal.raw); } catch { throw headError('EOWNERRECOVERY', 'Abort journal is malformed'); }
    if (this.validJournal(value) && value.state === 'PREPARED_WRITE') prepared = value;
    else {
      try { intent = parseFileMemoryAbortIntent(journal.raw); }
      catch { throw headError('EOWNERRECOVERY', 'Journal does not authorize pre-publication abort'); }
    }
    const bound = intent ?? prepared!;
    if (bound.userId !== scope.userId || bound.ownerId !== request.ownerId || bound.operationId !== request.operationId ||
      bound.locator !== request.locator || bound.oldRevision !== sidecar.record.revision ||
      bound.oldContentHash !== head.hash || !sameIdentity(bound.oldFileIdentity, head.identity)) {
      throw headError('EOWNERRECOVERY', 'Abort request does not match original write bindings');
    }
    if (intent && (intent.oldSidecarHash !== createHash('sha256').update(sidecar.raw).digest('hex') ||
      intent.oldRegistryHash !== createHash('sha256').update(registry.raw).digest('hex') ||
      !sameIdentity(intent.oldSidecarIdentity, sidecar.identity) || !sameIdentity(intent.oldRegistryIdentity, registry.identity))) {
      throw headError('EOWNERRECOVERY', 'Abort old record bindings changed');
    }
    return { intent, prepared };
  }

  private requireAbortTemp(
    scope: FileMemoryTransactionScope, request: FinalizeOwnedUpdateRequest,
    evidence: Pick<AbortEvidence, 'sidecar' | 'registry' | 'prepared' | 'temp'> & {
      head: { hash: string; identity: FileIdentity }; bound?: WriteJournal | FileMemoryAbortIntent;
    }, names: string[], stageName: string,
  ): void {
    const { head, sidecar, registry, prepared, bound, temp } = evidence;
    if ((prepared && !temp) || (temp && (temp.hash !== bound?.newContentHash ||
      !sameIdentity(temp.identity, bound!.preparedTempIdentity)))) {
      throw headError('EOWNERRECOVERY', 'Abort prepared temp is absent or changed');
    }
    if (prepared && classifyFileMemoryWrite({ userId: scope.userId, locator: request.locator,
      head: { hash: head.hash, identity: head.identity }, sidecar: sidecar.record, registry: registry.record,
      journal: prepared, temp: temp && { hash: temp.hash, identity: temp.identity },
      artifactNames: names.filter(name => name !== stageName), unexpectedArtifacts: false }).kind !== 'prepared-not-published') {
      throw headError('EOWNERRECOVERY', 'Abort is not an original old-head PREPARED state');
    }
  }

  private async abortNamespace(
    scope: FileMemoryTransactionScope, resolved: DiagnosticEvidenceRead['resolved'], ownerId: string,
  ): Promise<string[]> {
    const prefix = `.${resolved.basenameHash}.`;
    const names = await this.listMatchingArtifacts(path.dirname(resolved.headPath), name => {
      const folded = name.toLowerCase();
      return folded.startsWith(`${prefix}memory-write`) || folded.startsWith(`${prefix}memory-owner.json`);
    });
    const sidecarName = path.basename(resolved.sidecarPath);
    if (!names.includes(sidecarName) || names.some(name => name.toLowerCase() === sidecarName.toLowerCase() && name !== sidecarName)) {
      throw headError('EOWNERRECOVERY', 'Abort sidecar namespace is ambiguous');
    }
    const registryPath = this.registryPath(scope.tenantRoot, ownerId);
    const registryName = path.basename(registryPath);
    const registryNames = await this.listMatchingArtifacts(path.dirname(registryPath), name =>
      name.toLowerCase() === registryName.toLowerCase() || name.toLowerCase().startsWith(`${registryName.toLowerCase()}.`));
    if (registryNames.length !== 1 || registryNames[0] !== registryName) {
      throw headError('EOWNERRECOVERY', 'Abort registry namespace is ambiguous');
    }
    return names.filter(name => name !== sidecarName);
  }

  private async forwardPreparedOldHeadAtScope(
    operation: FileMemoryOperationScope, request: FinalizeOwnedUpdateRequest,
  ): Promise<FinalizeOwnedUpdateResult> {
    const coordinator = this.requiredCoordinator();
    const scope = coordinator.requireActiveOperationScope(operation);
    const first = await this.readDiagnosticEvidence(scope, request.locator, 'old-head');
    coordinator.requireActiveOperationScope(operation);
    if (classifyFileMemoryWrite(first.evidence).kind !== 'prepared-not-published') {
      return this.forwardPreparedAtScope(operation, request, first);
    }
    this.requirePreparedOldHead(first, request, scope);
    const originalTemp = first.preparedTemp;
    if (!originalTemp) throw headError('EOWNERRECOVERY', 'Missing prepared head bytes');
    this.validateHeadForSave(originalTemp.raw);
    await this.options.beforePreparedHeadRename?.();
    coordinator.requireActiveOperationScope(operation);
    const last = await this.readDiagnosticEvidence(scope, request.locator, 'old-head');
    if (first.signature !== last.signature || !last.preparedTemp) {
      throw headError('EOWNERRECOVERY', 'Prepared evidence changed before head rename');
    }
    await fs.rename(last.preparedTemp.path, last.resolved.headPath);
    await this.options.afterUpdatePublication?.('renamed-head');
    coordinator.requireActiveOperationScope(operation);
    const advanced = await this.readDiagnosticEvidence(scope, request.locator, 'prepared');
    this.requirePreparedHeadPublication(last, advanced);
    return this.forwardPreparedAtScope(operation, request, advanced);
  }

  private requirePreparedOldHead(
    evidence: DiagnosticEvidenceRead, request: FinalizeOwnedUpdateRequest, scope: FileMemoryTransactionScope,
  ): void {
    const journal = evidence.evidence.journal;
    if (journal?.state !== 'PREPARED_WRITE' || journal.ownerId !== request.ownerId ||
      journal.operationId !== request.operationId || journal.userId !== scope.userId ||
      journal.locator !== request.locator || evidence.resolved.locator !== request.locator ||
      !evidence.journalRaw || !evidence.journalIdentity || !evidence.preparedTemp ||
      path.basename(evidence.preparedTemp.path) !== journal.preparedTempName ||
      !sameIdentity(evidence.preparedTemp.identity, journal.preparedTempIdentity)) {
      throw headError('EOWNERRECOVERY', 'Memory is not an exact original old-head PREPARED repair');
    }
  }

  private requirePreparedHeadPublication(before: DiagnosticEvidenceRead, after: DiagnosticEvidenceRead): void {
    if (!before.preparedTemp || after.preparedTemp || after.recoveryStage ||
      classifyFileMemoryWrite(after.evidence).kind !== 'renamed-before-published-journal' ||
      after.headContent !== before.preparedTemp.raw ||
      !samePublishedFile(before.preparedTemp.identity, after.evidence.head.identity) ||
      before.journalRaw !== after.journalRaw || !isDeepStrictEqual(before.journalIdentity, after.journalIdentity) ||
      before.sidecarRaw !== after.sidecarRaw || before.registryRaw !== after.registryRaw ||
      !isDeepStrictEqual(before.sidecarIdentity, after.sidecarIdentity) ||
      !isDeepStrictEqual(before.registryIdentity, after.registryIdentity)) {
      throw headError('EOWNERRECOVERY', 'Prepared head publication changed bound evidence');
    }
  }

  private async forwardPreparedAtScope(
    operation: FileMemoryOperationScope, request: FinalizeOwnedUpdateRequest, captured?: DiagnosticEvidenceRead,
  ): Promise<FinalizeOwnedUpdateResult> {
    const coordinator = this.requiredCoordinator();
    const scope = coordinator.requireActiveOperationScope(operation);
    const first = captured ?? await this.readDiagnosticEvidence(scope, request.locator, 'prepared');
    coordinator.requireActiveOperationScope(operation);
    // A resumed request may have completed the journal transition or commit.
    if (first.evidence.journal?.state !== 'PREPARED_WRITE') {
      return this.forwardAtScope(operation, request, first);
    }
    this.requirePreparedRenamed(first, request, scope);
    this.validateHeadForSave(first.headContent);
    const journal = first.evidence.journal as WriteJournal;
    const raw = this.serializedJournal({ ...journal, state: 'PUBLISHED_WRITE',
      publishedHeadIdentity: first.evidence.head.identity });
    const proof = await this.stagePreparedJournal(operation, request, first, raw);
    await this.options.duringUpdateMetadataStage?.('published-journal', 'verified-before-rename');
    coordinator.requireActiveOperationScope(operation);
    const last = await this.readDiagnosticEvidence(scope, request.locator, 'prepared');
    if (proof.signature !== last.signature || !last.recoveryStage) {
      throw headError('EOWNERRECOVERY', 'Prepared evidence changed before journal rename');
    }
    await fs.rename(last.recoveryStage.path, last.resolved.journalPath);
    await this.options.afterUpdatePublication?.('published-journal');
    coordinator.requireActiveOperationScope(operation);
    const advanced = await this.readDiagnosticEvidence(scope, request.locator, true);
    if (!this.samePreparedRecords(last, advanced) || advanced.recoveryStage ||
      advanced.journalRaw !== raw || !advanced.journalIdentity ||
      !samePublishedFile(last.recoveryStage.identity, advanced.journalIdentity) ||
      classifyFileMemoryWrite(advanced.evidence).kind !== 'published-before-registry') {
      throw headError('EOWNERRECOVERY', 'Prepared journal publication changed bound evidence');
    }
    return this.forwardAtScope(operation, request, advanced);
  }

  private async stagePreparedJournal(
    operation: FileMemoryOperationScope, request: FinalizeOwnedUpdateRequest,
    first: DiagnosticEvidenceRead, raw: string,
  ): Promise<DiagnosticEvidenceRead> {
    if (first.recoveryStage) return first;
    const coordinator = this.requiredCoordinator();
    const scope = coordinator.requireActiveOperationScope(operation);
    const beforeStage = await this.readDiagnosticEvidence(scope, request.locator, 'prepared');
    if (first.signature !== beforeStage.signature) {
      throw headError('EOWNERRECOVERY', 'Prepared evidence changed before staging');
    }
    coordinator.requireActiveOperationScope(operation);
    const created = await this.writeRecoveryStage(
      `${first.resolved.journalPath}.update-${request.operationId}.tmp`, raw, 'published-journal');
    const proof = await this.readDiagnosticEvidence(scope, request.locator, 'prepared');
    if (!this.samePreparedBase(first, proof) || !proof.recoveryStage ||
      !sameIdentity(created, proof.recoveryStage.identity)) {
      throw headError('EOWNERRECOVERY', 'Prepared evidence changed during staging');
    }
    return proof;
  }

  private requirePreparedRenamed(
    evidence: DiagnosticEvidenceRead, request: FinalizeOwnedUpdateRequest, scope: FileMemoryTransactionScope,
  ): void {
    const journal = evidence.evidence.journal;
    if (classifyFileMemoryWrite(evidence.evidence).kind !== 'renamed-before-published-journal' ||
      journal?.state !== 'PREPARED_WRITE' || journal.ownerId !== request.ownerId ||
      journal.operationId !== request.operationId || journal.userId !== scope.userId ||
      journal.locator !== request.locator || evidence.resolved.locator !== request.locator ||
      !evidence.journalRaw || !evidence.journalIdentity) {
      throw headError('EOWNERRECOVERY', 'Memory is not an exact already-renamed PREPARED repair');
    }
  }

  private samePreparedRecords(left: DiagnosticEvidenceRead, right: DiagnosticEvidenceRead): boolean {
    return left.headContent === right.headContent && isDeepStrictEqual(left.evidence.head, right.evidence.head) &&
      left.sidecarRaw === right.sidecarRaw && left.registryRaw === right.registryRaw &&
      isDeepStrictEqual(left.sidecarIdentity, right.sidecarIdentity) &&
      isDeepStrictEqual(left.registryIdentity, right.registryIdentity);
  }

  private samePreparedBase(left: DiagnosticEvidenceRead, right: DiagnosticEvidenceRead): boolean {
    return this.sameRepairBase(left, right) && this.samePreparedRecords(left, right) &&
      isDeepStrictEqual(left.evidence, { ...right.evidence, artifactNames: left.evidence.artifactNames });
  }

  private publishedRecord(journal: WriteJournal): OwnerRecord {
    if (!journal.publishedHeadIdentity) throw headError('EOWNERRECOVERY', 'Published identity is missing');
    return { schema: 1, state: 'ACTIVE', userId: journal.userId, ownerId: journal.ownerId,
      locator: journal.locator, revision: journal.newRevision, contentHash: journal.newContentHash,
      fileIdentity: journal.publishedHeadIdentity };
  }

  private async forwardAtScope(
    operation: FileMemoryOperationScope, request: FinalizeOwnedUpdateRequest,
    expectedEvidence?: DiagnosticEvidenceRead, metadataSteps = 0,
  ): Promise<FinalizeOwnedUpdateResult> {
    const coordinator = this.requiredCoordinator();
    const scope = coordinator.requireActiveOperationScope(operation);
    const first = await this.readDiagnosticEvidence(scope, request.locator, true);
    coordinator.requireActiveOperationScope(operation);
    if (expectedEvidence && expectedEvidence.signature !== first.signature) {
      throw headError('EOWNERRECOVERY', 'Memory evidence changed between repair steps');
    }
    const phase = classifyFileMemoryWrite(first.evidence).kind;
    if (phase === 'clean-consistent' || phase === 'metadata-advanced-before-unlink') {
      return this.finalizeAtScope(operation, request, first);
    }
    const journal = this.requireForwardJournal(first, request, scope, phase);
    if (phase !== 'published-before-registry' && phase !== 'registry-advanced') {
      throw headError('EOWNERRECOVERY', 'Memory write is not an ordered PUBLISHED repair');
    }
    if (metadataSteps >= 2) {
      throw headError('EOWNERRECOVERY', 'Memory repair did not reach metadata agreement');
    }
    const advanced = await this.advancePublishedMetadata(operation, request, first, journal, phase);
    // At most registry then sidecar advance; recurse privately in the same
    // operation so each publication completes before the next evidence read.
    return this.forwardAtScope(operation, request, advanced, metadataSteps + 1);
  }

  private requireForwardJournal(
    first: DiagnosticEvidenceRead, request: FinalizeOwnedUpdateRequest,
    scope: FileMemoryTransactionScope, phase: string,
  ): WriteJournal {
    const journal = first.evidence.journal as WriteJournal | undefined;
    if (journal?.state !== 'PUBLISHED_WRITE' || journal.ownerId !== request.ownerId ||
      journal.operationId !== request.operationId || journal.userId !== scope.userId ||
      journal.locator !== request.locator || first.resolved.locator !== request.locator ||
      !first.journalRaw || !first.journalIdentity ||
      (phase !== 'published-before-registry' && phase !== 'registry-advanced')) {
      throw headError('EOWNERRECOVERY', 'Memory write is not an exact ordered PUBLISHED repair');
    }
    return journal;
  }

  private async advancePublishedMetadata(
    operation: FileMemoryOperationScope, request: FinalizeOwnedUpdateRequest,
    first: DiagnosticEvidenceRead, journal: WriteJournal,
    phase: 'published-before-registry' | 'registry-advanced',
  ): Promise<DiagnosticEvidenceRead> {
    const coordinator = this.requiredCoordinator();
    const scope = coordinator.requireActiveOperationScope(operation);
    this.validateHeadForSave(first.headContent);
    const stage: UpdateMetadataStage = phase === 'published-before-registry' ? 'active-registry' : 'active-sidecar';
    const target = stage === 'active-registry' ? this.registryPath(scope.tenantRoot, request.ownerId) :
      first.resolved.sidecarPath;
    const raw = serializedRecord(this.publishedRecord(journal));
    let proof = first;
    if (!first.recoveryStage) {
      const beforeStage = await this.readDiagnosticEvidence(scope, request.locator, true);
      coordinator.requireActiveOperationScope(operation);
      if (first.signature !== beforeStage.signature) {
        throw headError('EOWNERRECOVERY', 'Memory evidence changed before repair staging');
      }
      // Exclusive staging retains every partial artifact on error or interruption.
      const createdIdentity = await this.writeRecoveryStage(`${target}.update-${request.operationId}.tmp`, raw, stage);
      proof = await this.readDiagnosticEvidence(scope, request.locator, true);
      // Stage creation is the only permitted evidence change; metadata raw
      // bytes and descriptor identities must remain exactly bound.
      if (!this.sameRepairBase(first, proof) ||
        first.sidecarRaw !== proof.sidecarRaw || first.registryRaw !== proof.registryRaw ||
        !isDeepStrictEqual(first.sidecarIdentity, proof.sidecarIdentity) ||
        !isDeepStrictEqual(first.registryIdentity, proof.registryIdentity) ||
        !isDeepStrictEqual(first.evidence, { ...proof.evidence, artifactNames: first.evidence.artifactNames }) ||
        !proof.recoveryStage || !sameIdentity(createdIdentity, proof.recoveryStage.identity)) {
        throw headError('EOWNERRECOVERY', 'Memory evidence changed while staging repair');
      }
    }
    await this.options.duringUpdateMetadataStage?.(stage, 'verified-before-rename');
    coordinator.requireActiveOperationScope(operation);
    const last = await this.readDiagnosticEvidence(scope, request.locator, true);
    if (proof.signature !== last.signature || !last.recoveryStage) {
      throw headError('EOWNERRECOVERY', 'Memory repair evidence changed before rename');
    }
    await fs.rename(last.recoveryStage.path, target);
    await this.options.afterUpdatePublication?.(stage === 'active-registry' ? 'updated-registry' : 'updated-sidecar');
    coordinator.requireActiveOperationScope(operation);
    const advanced = await this.readDiagnosticEvidence(scope, request.locator, true);
    const nextPhase = classifyFileMemoryWrite(advanced.evidence).kind;
    this.requireRepairAdvance(last, advanced, stage, nextPhase);
    return advanced;
  }

  private sameRepairBase(left: DiagnosticEvidenceRead, right: DiagnosticEvidenceRead): boolean {
    return left.journalRaw === right.journalRaw && isDeepStrictEqual(left.journalIdentity, right.journalIdentity) &&
      left.headContent === right.headContent && isDeepStrictEqual(left.evidence.head, right.evidence.head);
  }

  private requireRepairAdvance(
    before: DiagnosticEvidenceRead, after: DiagnosticEvidenceRead,
    stage: UpdateMetadataStage, phase: string,
  ): void {
    const registry = stage === 'active-registry';
    const untouchedRaw = registry ? 'sidecarRaw' : 'registryRaw';
    const untouchedIdentity = registry ? 'sidecarIdentity' : 'registryIdentity';
    const publishedRaw = registry ? after.registryRaw : after.sidecarRaw;
    const publishedIdentity = registry ? after.registryIdentity : after.sidecarIdentity;
    const staged = before.recoveryStage;
    if (phase !== (registry ? 'registry-advanced' : 'metadata-advanced-before-unlink') ||
      after.recoveryStage || !this.sameRepairBase(before, after) ||
      before[untouchedRaw] !== after[untouchedRaw] ||
      !isDeepStrictEqual(before[untouchedIdentity], after[untouchedIdentity]) ||
      !staged || publishedRaw !== staged.raw || !publishedIdentity ||
      !samePublishedFile(staged.identity, publishedIdentity)) {
      throw headError('EOWNERRECOVERY', 'Memory evidence changed after repair publication');
    }
  }

  private async writeRecoveryStage(filePath: string, raw: string, stage: UpdateMetadataStage): Promise<FileIdentity> {
    const bytes = Buffer.from(raw, 'utf8');
    const handle = await fs.open(filePath, 'wx', 0o600);
    try {
      const split = Math.max(1, Math.floor(bytes.length / 2));
      await handle.writeFile(bytes.subarray(0, split));
      await this.options.duringUpdateMetadataStage?.(stage, 'partial-write');
      await handle.writeFile(bytes.subarray(split));
      await handle.sync();
      return identityOf(await handle.stat({ bigint: true }));
    } finally {
      await handle.close();
    }
  }

  private validateFinalizeRequest(request: FinalizeOwnedUpdateRequest): void {
    validateLocator(request.locator);
    if (!UUID_PATTERN.test(request.ownerId) || !UUID_PATTERN.test(request.operationId)) {
      throw new TypeError('Finalization requires an owner and operation UUID');
    }
  }

  private async finalizeAtScope(
    operation: FileMemoryOperationScope, request: FinalizeOwnedUpdateRequest,
    expectedEvidence?: DiagnosticEvidenceRead,
  ): Promise<FinalizeOwnedUpdateResult> {
    const coordinator = this.requiredCoordinator();
    const scope = coordinator.requireActiveOperationScope(operation);
    const first = await this.readDiagnosticEvidence(scope, request.locator);
    if (expectedEvidence && first.signature !== expectedEvidence.signature) {
      throw headError('EOWNERRECOVERY', 'Memory evidence changed before repair finalization');
    }
    coordinator.requireActiveOperationScope(operation);
    const phase = classifyFileMemoryWrite(first.evidence);
    if (!first.evidence.journal && phase.kind === 'clean-consistent' &&
      first.evidence.sidecar?.ownerId === request.ownerId && first.evidence.userId === scope.userId) {
      return { status: 'already-clean-no-attribution' };
    }
    this.requireFinalizableEvidence(first, request, scope);
    this.validateHeadForSave(first.headContent);
    const snapshot = await this.readAtRoot(
      scope.tenantRoot, scope.userId, first.resolved.locator, path.basename(first.resolved.journalPath));
    coordinator.requireActiveOperationScope(operation);
    const token = this.requireMatchingFinalToken(snapshot, first, request, scope);
    await this.options.afterFinalizePublication?.('before-unlink');
    coordinator.requireActiveOperationScope(operation);
    const last = await this.readDiagnosticEvidence(scope, request.locator);
    if (first.signature !== last.signature) {
      throw headError('EOWNERRECOVERY', 'Memory write evidence changed before finalization');
    }
    this.requireFinalizableEvidence(last, request, scope);
    const journal = await this.readJournalEvidence(last.resolved.journalPath);
    coordinator.requireActiveOperationScope(operation);
    if (!journal?.raw || journal.raw !== last.journalRaw || !last.journalIdentity ||
      !sameIdentity(journal.identity, last.journalIdentity)) {
      throw headError('EOWNERRECOVERY', 'Memory write journal changed before finalization');
    }
    try {
      await fs.unlink(last.resolved.journalPath);
    } catch (cause) {
      const error = headError('EHEADCOMMITUNKNOWN', 'Memory write journal unlink outcome is unknown');
      Object.assign(error, { cause, operationId: request.operationId, residual: true });
      throw error;
    }
    try {
      await this.options.afterFinalizePublication?.('after-unlink');
      const clean = await this.readAtRoot(scope.tenantRoot, scope.userId, last.resolved.locator);
      coordinator.requireActiveOperationScope(operation);
      if (clean.token.ownership !== 'owned' || !sameOwnedToken(clean.token, token)) {
        throw headError('EOWNERRECOVERY', 'Committed memory head changed after finalization');
      }
      await this.options.afterFinalizePublication?.('after-read');
    } catch (cause) {
      throw committedError(cause, token);
    }
    return { status: 'known-committed', token };
  }

  private requireFinalizableEvidence(
    read: DiagnosticEvidenceRead, request: FinalizeOwnedUpdateRequest, scope: FileMemoryTransactionScope,
  ): void {
    const { evidence } = read;
    if (classifyFileMemoryWrite(evidence).kind !== 'metadata-advanced-before-unlink' ||
      evidence.journal?.state !== 'PUBLISHED_WRITE' || evidence.journal.ownerId !== request.ownerId ||
      evidence.journal.operationId !== request.operationId || evidence.journal.userId !== scope.userId ||
      evidence.journal.locator !== read.resolved.locator || read.resolved.locator !== request.locator ||
      !read.journalRaw || !read.journalIdentity) {
      throw headError('EOWNERRECOVERY', 'Memory write is not in the exact finalizable phase');
    }
  }

  private requireMatchingFinalToken(
    snapshot: FileMemorySnapshot, read: DiagnosticEvidenceRead,
    request: FinalizeOwnedUpdateRequest, scope: FileMemoryTransactionScope,
  ): OwnedFileMemoryToken {
    const token = snapshot.token;
    const journal = read.evidence.journal;
    if (token.ownership !== 'owned' || !journal || snapshot.content !== read.headContent ||
      token.ownerId !== request.ownerId || token.revision !== journal.newRevision ||
      token.contentHash !== journal.newContentHash || token.userId !== scope.userId ||
      token.tenantRoot !== scope.tenantRoot || token.locator !== read.resolved.locator ||
      !journal.publishedHeadIdentity || !sameIdentity(token.fileIdentity, journal.publishedHeadIdentity)) {
      throw headError('EOWNERRECOVERY', 'Published memory head token disagrees with journal');
    }
    return token;
  }

  /**
   * @internal Revalidate a same-read ACTIVE owner token inside the caller's
   * tracked operation. This helper never acquires another fence or enqueues a
   * nested operation; future archive stores must await it before publication.
   */
  async requireOwnedAtScope(
    operation: FileMemoryOperationScope, expected: OwnedFileMemoryToken, budget?: FileMemoryDirectoryScanner,
  ): Promise<OwnedFileMemoryToken> {
    const coordinator = this.requiredCoordinator();
    const scope = coordinator.requireActiveOperationScope(operation);
    const token = { ...expected, fileIdentity: { ...expected.fileIdentity } };
    if (token.backend !== 'file' || token.ownership !== 'owned' ||
      token.tenantRoot !== scope.tenantRoot || token.userId !== scope.userId) {
      throw headError('EHEADCONFLICT', 'Memory owner token belongs to another tenant or head');
    }
    const current = await this.readAtRoot(scope.tenantRoot, scope.userId, token.locator, undefined, budget);
    coordinator.requireActiveOperationScope(operation);
    if (current.token.ownership !== 'owned' || !sameOwnedToken(current.token, token)) {
      throw headError('EHEADCONFLICT', 'Memory owner changed before guarded operation');
    }
    return current.token;
  }

  /** @internal Accounted, read-only replacement authority for the dormant erasure executor. */
  async observeErasureReplacementAtScope(
    operation: FileMemoryOperationScope, locator: string, inspection: ErasureInspection,
  ): Promise<ErasureReplacementSnapshot> {
    const coordinator = this.requiredCoordinator(), scope = coordinator.requireActiveOperationScope(operation);
    validateLocator(locator);
    if (inspection.root !== scope.tenantRoot) throw headError('EHEADCONFLICT', 'Replacement observation belongs to another tenant');
    const components = locator.split('/'), name = components.pop()!, parent = components.join('/') || '.';
    const hash = createHash('sha256').update(name).digest('hex');
    const sidecar = `${parent === '.' ? '' : `${parent}/`}.${hash}${SIDECAR_SUFFIX}`;
    const artifacts = async (ownerId?: string) => {
      const names = await inspection.names(parent);
      const exact = `.${hash}${SIDECAR_SUFFIX}`;
      if (names.some(value => value.toLowerCase().startsWith(`.${hash}.memory-write`) ||
        value.toLowerCase().startsWith(exact) && value !== exact)) throw headError('EOWNERRECOVERY', 'Replacement head has publication evidence');
      if (ownerId && (await inspection.names(`${OWNER_DIRECTORY}/owners`)).some(value =>
        value.toLowerCase().startsWith(`${ownerId}.json.`))) throw headError('EOWNERRECOVERY', 'Replacement registry has publication evidence');
    };
    await artifacts();
    const before = await inspection.record(sidecar), content = await inspection.replacementHead(locator);
    if (Buffer.byteLength(before.raw, 'utf8') > MAX_RECORD_BYTES) throw headError('EOWNERRECOVERY', 'Replacement owner exceeds the ownership record bound');
    let owner: unknown; try { owner = JSON.parse(before.raw); } catch { throw headError('EOWNERRECOVERY', 'Replacement owner is malformed'); }
    if (!validRecord(owner) || owner.state !== 'ACTIVE') throw headError('EOWNERRECOVERY', 'Replacement owner is incomplete');
    const registry = await inspection.record(`${OWNER_DIRECTORY}/owners/${owner.ownerId}.json`);
    if (Buffer.byteLength(registry.raw, 'utf8') > MAX_RECORD_BYTES) throw headError('EOWNERRECOVERY', 'Replacement registry exceeds the ownership record bound');
    let recorded: unknown; try { recorded = JSON.parse(registry.raw); } catch { throw headError('EOWNERRECOVERY', 'Replacement registry is malformed'); }
    const after = await inspection.record(sidecar); await artifacts(owner.ownerId);
    if (Buffer.byteLength(after.raw, 'utf8') > MAX_RECORD_BYTES) throw headError('EOWNERRECOVERY', 'Replacement owner exceeds the ownership record bound');
    const head = await inspection.lstat(locator);
    if (!validRecord(recorded) || recorded.state !== 'ACTIVE' || before.raw !== after.raw || !sameIdentity(before.identity, after.identity) ||
      owner.userId !== scope.userId || owner.locator !== locator || owner.contentHash !== content.digest || !sameIdentity(owner.fileIdentity, content.identity) ||
      !isDeepStrictEqual(owner, recorded) || !sameIdentity(content.identity, identityOf(head))) throw headError('EOWNERRECOVERY', 'Replacement head and ownership disagree');
    coordinator.requireActiveOperationScope(operation);
    return { content: content.raw, registryEvidence: registry, token: { backend: 'file', ownership: 'owned', userId: scope.userId, tenantRoot: scope.tenantRoot,
      locator, ownerId: owner.ownerId, revision: owner.revision, contentHash: content.digest, fileIdentity: content.identity } };
  }

  /** @internal Same-read raw head and token for guarded archive cleanup; no nested operation. */
  async snapshotOwnedAtScope(
    operation: FileMemoryOperationScope, expected: OwnedFileMemoryToken, budget?: FileMemoryDirectoryScanner,
  ): Promise<FileMemorySnapshot & { readonly token: OwnedFileMemoryToken }> {
    const coordinator = this.requiredCoordinator();
    const scope = coordinator.requireActiveOperationScope(operation);
    const token = { ...expected, fileIdentity: { ...expected.fileIdentity } };
    if (token.backend !== 'file' || token.ownership !== 'owned' ||
      token.tenantRoot !== scope.tenantRoot || token.userId !== scope.userId) {
      throw headError('EHEADCONFLICT', 'Memory owner token belongs to another tenant or head');
    }
    const current = await this.readAtRoot(scope.tenantRoot, scope.userId, token.locator, undefined, budget);
    coordinator.requireActiveOperationScope(operation);
    if (current.token.ownership !== 'owned' || !sameOwnedToken(current.token, token)) {
      throw headError('EHEADCONFLICT', 'Memory owner changed before archive cleanup');
    }
    return { content: current.content, token: current.token };
  }

  /** @internal Zero-write owner proof using one caller-captured read scope. Not mutation authority. */
  async requireOwnedAtReadScope(
    scope: FileMemoryTransactionScope, expected: OwnedFileMemoryToken, budget?: FileMemoryDirectoryScanner,
  ): Promise<OwnedFileMemoryToken> {
    const token = { ...expected, fileIdentity: { ...expected.fileIdentity } };
    if (token.backend !== 'file' || token.ownership !== 'owned' ||
      token.tenantRoot !== scope.tenantRoot || token.userId !== scope.userId) {
      throw headError('EHEADCONFLICT', 'Memory owner token belongs to another tenant or head');
    }
    const current = await this.readAtRoot(scope.tenantRoot, scope.userId, token.locator, undefined, budget);
    if (current.token.ownership !== 'owned' || !sameOwnedToken(current.token, token)) {
      throw headError('EHEADCONFLICT', 'Memory owner changed during archive observation');
    }
    return current.token;
  }

  private async readAtRoot(
    tenantRoot: string, userId: string, locator: string, permittedJournal?: string, budget?: FileMemoryDirectoryScanner,
  ): Promise<FileMemorySnapshot> {
    const resolved = await this.resolveHead(tenantRoot, locator);

    // No lease, directory creation, or owner publication on this read path.
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.checkWriteArtifacts(tenantRoot, resolved, undefined, permittedJournal, budget);
      const before = await this.readRecord(resolved.sidecarPath);
      if (before && before.record.state !== 'ACTIVE') {
        throw headError('EOWNERRECOVERY', 'Memory owner publication is incomplete');
      }
      const content = await this.readHeadBytes(resolved.headPath);
      const registry = before
        ? await this.readRegistry(tenantRoot, before.record.ownerId)
        : undefined;
      const after = await this.readRecord(resolved.sidecarPath);
      await this.checkWriteArtifacts(tenantRoot, resolved, before?.record.ownerId, permittedJournal, budget);
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
    let committed: OwnedFileMemoryToken | undefined;
    const capture = (published: OwnedFileMemoryToken) => { committed = published; };
    try {
      if ('coordinator' in this.options) {
        return await this.options.coordinator.withTenantTransaction(context =>
          this.performOrdinaryAdoption(context, token, capture));
      }
      if (token.backend !== 'file' || token.ownership !== 'unowned') {
        throw new TypeError('Adoption requires an unowned file snapshot');
      }
      const userId = this.options.getCurrentUserId();
      const root = await fs.realpath(this.options.tenantRoot);
      return await this.options.fence.withTenantFence(root, async () => {
        try { return await this.adoptAtRoot({ tenantRoot: root, userId }, token, capture); }
        catch (cause) {
          if (committed) throw this.adoptedError(cause, committed);
          throw this.ordinaryAdoptionPrecommitError(cause);
        }
      });
    } catch (cause) {
      if (committed) throw this.adoptedError(cause, committed);
      throw this.ordinaryAdoptionPrecommitError(cause);
    }
  }

  /** Caller owns the lease and retains returned known-adopted tokens across outer failures. */
  adoptUnownedInTransaction(
    context: FileMemoryLeaseContext, expected: UnownedFileMemoryToken,
  ): Promise<OwnedFileMemoryToken> {
    const token = { ...expected, fileIdentity: { ...expected.fileIdentity } };
    return this.performOrdinaryAdoption(context, token);
  }

  private performOrdinaryAdoption(
    context: FileMemoryLeaseContext, token: UnownedFileMemoryToken,
    capture?: (published: OwnedFileMemoryToken) => void,
  ): Promise<OwnedFileMemoryToken> {
    let committed: OwnedFileMemoryToken | undefined;
    const result = this.requiredCoordinator().perform(context, async scope => {
      try {
        return await this.adoptAtRoot(scope, token, published => {
          committed = published;
          capture?.(published);
        });
      } catch (cause) {
        if (committed) throw this.adoptedError(cause, committed);
        throw this.ordinaryAdoptionPrecommitError(cause);
      }
    }).catch(cause => {
      if (committed) throw this.adoptedError(cause, committed);
      throw this.ordinaryAdoptionPrecommitError(cause);
    });
    // Preserve perform's ignored-operation rejection handling for this wrapper too.
    void result.catch(() => undefined);
    return result;
  }

  private ordinaryAdoptionPrecommitError(cause: unknown): unknown {
    if (cause === null || (typeof cause !== 'object' && typeof cause !== 'function')) return cause;
    let signalsAdoption: boolean;
    try {
      const marker = cause as { code?: unknown; adopted?: unknown };
      signalsAdoption = marker.code === 'EHEADADOPTED' || marker.adopted === true;
    } catch { signalsAdoption = true; } // An accessor cannot replace the original refusal.
    if (!signalsAdoption) return cause;
    const error = headError('EADOPTIONPENDING', 'This adoption has no captured publication outcome');
    Object.assign(error, { cause });
    return error;
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
    this.validateHeadForSave(content);
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

  private validateHeadForSave(content: string): void {
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
      const nested = parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
        ? parsed.metadata as Record<string, unknown> : undefined;
      if (getGatekeeperAuthoringErrors(parsed).length || getGatekeeperAuthoringErrors(nested).length) {
        throw new Error('Invalid gatekeeper authoring fields');
      }
    } catch {
      throw headError('EINVALIDHEAD', 'Memory update YAML is invalid');
    }
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
      await this.replaceUpdateMetadata(
        resolved.journalPath, this.serializedJournal(publishedJournal), operationId, 'published-journal');
      await this.options.afterUpdatePublication?.('published-journal');
      const nextRecord: OwnerRecord = {
        schema: 1, state: 'ACTIVE', userId: scope.userId, ownerId: expected.ownerId,
        locator: resolved.locator, revision: newRevision,
        contentHash: newContentHash, fileIdentity: published.identity,
      };
      serializedRecord(nextRecord);
      await this.replaceUpdateMetadata(
        this.registryPath(scope.tenantRoot, expected.ownerId), serializedRecord(nextRecord),
        operationId, 'active-registry');
      await this.options.afterUpdatePublication?.('updated-registry');
      await this.replaceUpdateMetadata(
        resolved.sidecarPath, serializedRecord(nextRecord), operationId, 'active-sidecar');
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
    capture: (published: OwnedFileMemoryToken) => void,
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
    const published: OwnedFileMemoryToken = Object.freeze({ ...token,
      fileIdentity: Object.freeze({ ...token.fileIdentity }),
      ownership: 'owned', ownerId, revision: '1' });
    capture(published);
    await this.options.afterPublication?.('active-sidecar');
    return published;
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

  private async scanDirectory(directory: string, matches: (name: string) => boolean, budget?: FileMemoryDirectoryScanner): Promise<void> {
    if (budget) {
      return budget.scan(directory, name => {
        if (matches(name)) throw headError('EOWNERRECOVERY', `Memory update artifact requires recovery: ${name}`);
      });
    }
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

  private async listMatchingArtifacts(directory: string, matches: (name: string) => boolean, budget?: FileMemoryDirectoryScanner): Promise<string[]> {
    if (budget) {
      const names: string[] = [];
      await budget.scan(directory, name => { if (matches(name)) names.push(name); });
      return this.sortArtifactNames(names);
    }
    const handle = await fs.opendir(directory);
    let seen = 0;
    const names: string[] = [];
    for await (const entry of handle) {
      if (++seen > MAX_SCAN_ENTRIES) {
        throw headError('EHEADRESOURCE', 'Memory metadata directory exceeds scan limit');
      }
      if (matches(entry.name)) names.push(entry.name);
    }
    return this.sortArtifactNames(names);
  }

  private sortArtifactNames(names: string[]): string[] {
    // Code-unit ordering preserves distinct Unicode spellings and gives exact two-pass comparison.
    return names.sort((left, right) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    });
  }

  private async checkWriteArtifacts(
    tenantRoot: string,
    resolved: { headPath: string; journalPath: string; basenameHash: string }, ownerId?: string,
    permittedJournal?: string,
    budget?: FileMemoryDirectoryScanner,
  ): Promise<void> {
    const prefix = `.${resolved.basenameHash}.`;
    await this.scanDirectory(path.dirname(resolved.headPath), name => {
      const folded = name.toLowerCase();
      if (folded === path.basename(resolved.journalPath)) return name !== permittedJournal;
      const sidecarName = `.${resolved.basenameHash}.memory-owner.json`;
      if (folded === sidecarName) return name !== sidecarName;
      return folded.startsWith(`${prefix}memory-write`) ||
        folded.startsWith(`${prefix}memory-owner.json`);
    }, budget);
    if (ownerId) {
      const registryPath = this.registryPath(tenantRoot, ownerId);
      await this.scanDirectory(path.dirname(registryPath), name =>
        name.toLowerCase().startsWith(`${ownerId.toLowerCase()}.json.`), budget);
    }
  }

  private registryPath(tenantRoot: string, ownerId: string): string {
    if (!UUID_PATTERN.test(ownerId)) throw headError('EOWNERRECOVERY', 'Invalid memory owner ID');
    return path.join(tenantRoot, OWNER_DIRECTORY, 'owners', `${ownerId}.json`);
  }

  private async readRegistry(tenantRoot: string, ownerId: string): Promise<{
    raw: string; record: OwnerRecord; identity: FileIdentity;
  } | undefined> {
    const ownerRoot = path.join(tenantRoot, OWNER_DIRECTORY);
    await this.checkPrivateDirectory(ownerRoot);
    await this.checkPrivateDirectory(path.join(ownerRoot, 'owners'));
    return this.readRecord(this.registryPath(tenantRoot, ownerId));
  }

  private async readHeadBytes(
    headPath: string, requirePrivate = false,
  ): Promise<{ value: string; hash: string; identity: FileIdentity }> {
    const handle = await fs.open(headPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (requirePrivate && ((before.mode & 0o077n) !== 0n ||
        (process.getuid && before.uid !== BigInt(process.getuid())))) {
        throw headError('EOWNERRECOVERY', 'Memory write artifact is not private');
      }
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

  private async readRecord(filePath: string): Promise<{
    raw: string; record: OwnerRecord; identity: FileIdentity;
  } | undefined> {
    let handle;
    try {
      handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
      return { raw, record: parsed, identity: identityOf(after) };
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
    return (await this.readJournalEvidence(filePath))?.record;
  }

  private async readJournalEvidence(filePath: string): Promise<{
    raw: string; record: WriteJournal; identity: FileIdentity;
  } | undefined> {
    let handle;
    try {
      handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
      const raw = decodeUtf8(bytes.subarray(0, used), 'EOWNERRECOVERY');
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch {
        throw headError('EOWNERRECOVERY', 'Memory write journal is malformed');
      }
      if (!this.validJournal(parsed)) throw headError('EOWNERRECOVERY', 'Memory write journal is invalid');
      return { raw, record: parsed, identity: identityOf(after) };
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

  /** UPDATE-only staging. Adoption keeps its separate generic replacement protocol. */
  private async replaceUpdateMetadata(
    filePath: string, raw: string, operationId: string, stage: UpdateMetadataStage,
  ): Promise<void> {
    if (!UUID_PATTERN.test(operationId)) {
      throw headError('EOWNERRECOVERY', 'Memory update operation ID is invalid');
    }
    const tempPath = `${filePath}.update-${operationId}.tmp`;
    const targetName = path.basename(filePath);
    const foldedTarget = targetName.toLowerCase();
    // Any earlier or aliased replacement in this target namespace blocks a
    // fresh UPDATE. The ordinary writer never interprets or removes it.
    await this.scanDirectory(path.dirname(filePath), name => {
      const folded = name.toLowerCase();
      return (folded === foldedTarget && name !== targetName) ||
        folded.startsWith(`${foldedTarget}.`);
    });
    const bytes = Buffer.from(raw, 'utf8');
    const handle = await fs.open(tempPath, 'wx', 0o600);
    let stagedIdentity: FileIdentity;
    try {
      const split = Math.max(1, Math.floor(bytes.length / 2));
      await handle.writeFile(bytes.subarray(0, split));
      await this.options.duringUpdateMetadataStage?.(stage, 'partial-write');
      await handle.writeFile(bytes.subarray(split));
      await handle.sync();
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(bytes.length) ||
        (stat.mode & 0o077n) !== 0n || (process.getuid && stat.uid !== BigInt(process.getuid()))) {
        throw headError('EOWNERRECOVERY', 'Staged memory metadata is not a private regular file');
      }
      stagedIdentity = identityOf(stat);
    } finally {
      await handle.close();
    }
    const readback = async () => stage === 'published-journal'
      ? this.readJournalEvidence(tempPath) : this.readRecord(tempPath);
    const first = await readback();
    if (first?.raw !== raw || !sameIdentity(first.identity, stagedIdentity)) {
      throw headError('EOWNERRECOVERY', 'Staged memory metadata changed before publication');
    }
    await this.options.duringUpdateMetadataStage?.(stage, 'verified-before-rename');
    const beforeRename = await readback();
    if (beforeRename?.raw !== raw || !sameIdentity(beforeRename.identity, stagedIdentity)) {
      throw headError('EOWNERRECOVERY', 'Staged memory metadata changed before rename');
    }
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
