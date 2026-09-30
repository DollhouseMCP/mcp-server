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
import { observeTenantFence, type FileMemoryFence } from './FileMemoryFence.js';
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

export type AdoptionPublication =
  | 'reserved-sidecar'
  | 'reserved-registry'
  | 'active-registry'
  | 'active-sidecar';

interface FileMemoryOwnerSnapshotsBaseOptions {
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
    operation: FileMemoryOperationScope, expected: OwnedFileMemoryToken,
  ): Promise<OwnedFileMemoryToken> {
    const coordinator = this.requiredCoordinator();
    const scope = coordinator.requireActiveOperationScope(operation);
    const token = { ...expected, fileIdentity: { ...expected.fileIdentity } };
    if (token.backend !== 'file' || token.ownership !== 'owned' ||
      token.tenantRoot !== scope.tenantRoot || token.userId !== scope.userId) {
      throw headError('EHEADCONFLICT', 'Memory owner token belongs to another tenant or head');
    }
    const current = await this.readAtRoot(scope.tenantRoot, scope.userId, token.locator);
    coordinator.requireActiveOperationScope(operation);
    if (current.token.ownership !== 'owned' || !sameOwnedToken(current.token, token)) {
      throw headError('EHEADCONFLICT', 'Memory owner changed before guarded operation');
    }
    return current.token;
  }

  /** @internal Zero-write owner proof using one caller-captured read scope. Not mutation authority. */
  async requireOwnedAtReadScope(
    scope: FileMemoryTransactionScope, expected: OwnedFileMemoryToken,
  ): Promise<OwnedFileMemoryToken> {
    const token = { ...expected, fileIdentity: { ...expected.fileIdentity } };
    if (token.backend !== 'file' || token.ownership !== 'owned' ||
      token.tenantRoot !== scope.tenantRoot || token.userId !== scope.userId) {
      throw headError('EHEADCONFLICT', 'Memory owner token belongs to another tenant or head');
    }
    const current = await this.readAtRoot(scope.tenantRoot, scope.userId, token.locator);
    if (current.token.ownership !== 'owned' || !sameOwnedToken(current.token, token)) {
      throw headError('EHEADCONFLICT', 'Memory owner changed during archive observation');
    }
    return current.token;
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

  private async listMatchingArtifacts(directory: string, matches: (name: string) => boolean): Promise<string[]> {
    const handle = await fs.opendir(directory);
    let seen = 0;
    const names: string[] = [];
    for await (const entry of handle) {
      if (++seen > MAX_SCAN_ENTRIES) {
        throw headError('EHEADRESOURCE', 'Memory metadata directory exceeds scan limit');
      }
      if (matches(entry.name)) names.push(entry.name);
    }
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
        name.toLowerCase().startsWith(`${ownerId.toLowerCase()}.json.`));
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
