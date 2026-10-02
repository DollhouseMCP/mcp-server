/** Dormant owner-bound publication, observations and protected cleanup; no runtime wiring. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { MEMORY_CONSTANTS } from '../elements/memories/constants.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { FileMemoryDirectoryScanBudget, type FileMemoryDirectoryScanner } from './FileMemoryDirectoryScanBudget.js';
import { FileMemoryArchiveCleanup, captureArchiveCleanupRequest, type ArchiveCleanupPhase, type FileArchiveCleanupResult } from './FileMemoryArchiveCleanup.js';
export type { ArchiveCleanupPhase, FileArchiveCleanupResult } from './FileMemoryArchiveCleanup.js';
import { FileMemoryListProofBudget } from './FileMemoryListProofBudget.js';
import { captureMemoryVolumeEntryLimit, MAX_MEMORY_VOLUME_LIST_DIAGNOSTICS, type MemoryVolumeListOptions, type MemoryVolumeObservation, type MemoryVolumeListDiagnostic } from './MemoryVolumeObservation.js';
import { FileMemoryOwnerSnapshots, type OwnedFileMemoryToken } from './FileMemoryOwnerSnapshots.js';
import { FileMemoryTransactionCoordinator, type FileMemoryLeaseContext, type FileMemoryOperationScope, type FileMemoryTransactionScope } from './FileMemoryTransactionCoordinator.js';

export const MAX_FILE_MEMORY_VOLUME_BYTES = 3 * MEMORY_CONSTANTS.MAX_YAML_SIZE;
export const MAX_FILE_MEMORY_VOLUME_COLLISION_PROBES = 1000;
const MAX_METADATA_BYTES = 4096;
const GENERATION = /^g-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface FileMemoryVolumeInput {
  readonly minimumVolume: number;
  readonly rawContent: string;
  readonly entryCount: number;
  readonly firstEntryAt?: Date;
  readonly lastEntryAt?: Date;
  readonly sealedAt: Date;
}
export interface ArchiveDirectoryIdentity { readonly device: string; readonly inode: string }
export interface ArchiveFileIdentity extends ArchiveDirectoryIdentity {
  readonly size: string; readonly ctimeNs: string; readonly mtimeNs: string;
}
export interface FileMemoryVolumeReceipt {
  readonly schema: 1;
  readonly tenantRoot: string;
  readonly userId: string;
  readonly ownerId: string;
  readonly volume: number;
  readonly generationId: string;
  readonly operationId: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly entryCount: number;
  readonly volumeIdentity: ArchiveDirectoryIdentity;
  readonly generationIdentity: ArchiveDirectoryIdentity;
  readonly payloadIdentity: ArchiveFileIdentity;
  readonly metadataIdentity: ArchiveFileIdentity;
}
/** Verified storage evidence only; never a create receipt, cleanup permission or public history policy. */
export type FileMemoryVolumeObservation =
  | { readonly status: 'absent'; readonly owner: OwnedFileMemoryToken; readonly volume: number }
  | { readonly status: 'found'; readonly owner: OwnedFileMemoryToken; readonly volume: number;
      readonly rawContent: string; readonly metadata: Readonly<Metadata> };

export interface CommittedFileArchiveError extends NodeJS.ErrnoException {
  readonly committed: true;
  readonly receipts: readonly FileMemoryVolumeReceipt[];
  readonly receipt: FileMemoryVolumeReceipt;
}
export type ArchivePublicationPhase = 'reserved-volume' | 'reserved-generation' | 'payload-written' |
  'metadata-written' | 'partial-payload' | 'partial-metadata' | 'verified-before-marker' | 'before-marker' | 'invoking-marker' | 'committed-marker' | 'verified-after-marker';
export interface FileMemoryVolumeStoreOptions {
  readonly coordinator: FileMemoryTransactionCoordinator;
  readonly owners: FileMemoryOwnerSnapshots;
  /** Read-only deterministic fault barriers; no production callback or repair authority. */
  readonly afterObservation?: (phase: 'observed' | 'verified', location: string) => void | Promise<void>;
  /** Fault/process barriers only. Never recovery or production activation. */
  readonly afterCleanup?: (phase: ArchiveCleanupPhase) => void | Promise<void>;
  readonly afterPublication?: (phase: ArchivePublicationPhase, residualPath: string) => void | Promise<void>;
}
interface ReadArchiveNamespace {
  readonly root: string;
  readonly paths: readonly string[];
  readonly identities: readonly ArchiveDirectoryIdentity[];
  readonly missing?: string;
}
interface CapturedInput {
  readonly minimumVolume: number; readonly bytes: Buffer; readonly entryCount: number;
  readonly firstEntryAt: string | null; readonly lastEntryAt: string | null; readonly sealedAt: string;
}
interface Metadata {
  readonly schema: 1; readonly userId: string; readonly ownerId: string; readonly volume: number;
  readonly generationId: string; readonly sha256: string; readonly byteLength: number;
  readonly entryCount: number; readonly firstEntryAt: string | null; readonly lastEntryAt: string | null;
  readonly sealedAt: string;
}
/** Unverified archived-payload declarations; never access or cleanup authority. */
export type FileMemoryVolumeInfo = Readonly<Metadata>;
interface ListedDeclaration {
  readonly metadata: FileMemoryVolumeInfo;
  readonly metadataBytes: Buffer;
  readonly volumeIdentity: ArchiveDirectoryIdentity;
  readonly generationIdentity: ArchiveDirectoryIdentity;
  readonly markerIdentity: ArchiveDirectoryIdentity;
  readonly metadataIdentity: ArchiveFileIdentity;
}
interface ListContext {
  readonly scope: FileMemoryTransactionScope;
  readonly token: OwnedFileMemoryToken;
  readonly operation?: FileMemoryOperationScope;
  readonly budget: FileMemoryDirectoryScanBudget;
  readonly entryLimit: number;
  readonly proofBudget: FileMemoryListProofBudget;
}
function error(code: string, message: string, cause?: unknown): NodeJS.ErrnoException {
  return Object.assign(new Error(message, { cause }), { code });
}
function committed(cause: unknown, receipts: readonly FileMemoryVolumeReceipt[]): CommittedFileArchiveError {
  return Object.assign(error('EARCHIVECOMMITTED', 'Archive publication committed; a later operation failed', cause), {
    committed: true as const, receipts: Object.freeze([...receipts]), receipt: receipts.at(-1)!,
  });
}
function appendCommittedReceipts(value: unknown, receipts: FileMemoryVolumeReceipt[]): void {
  const outcome = value as Partial<CommittedFileArchiveError> | null;
  if (!outcome?.committed || !outcome.receipts) return;
  for (const receipt of outcome.receipts) {
    if (!receipts.includes(receipt)) receipts.push(receipt);
  }
}
function discoverCommittedReceipts(cause: unknown, receipts: FileMemoryVolumeReceipt[]): void {
  const visited = new Set<unknown>();
  const pending: unknown[] = [cause];
  while (pending.length) {
    const value = pending.pop();
    if (visited.has(value)) continue;
    visited.add(value);
    appendCommittedReceipts(value, receipts);
    if (value instanceof AggregateError) pending.push(...value.errors);
    if (value instanceof Error && value.cause) pending.push(value.cause);
  }
}
/** Retain each receipt immediately after create returns, across the OUTER transaction boundary. */
export async function retainCommittedFileArchives<T>(
  callback: (retain: (receipt: FileMemoryVolumeReceipt) => void) => Promise<T>,
): Promise<T> {
  const receipts: FileMemoryVolumeReceipt[] = [];
  try { return await callback(receipt => { receipts.push(receipt); }); }
  catch (cause) {
    discoverCommittedReceipts(cause, receipts);
    if (receipts.length) throw committed(cause, receipts);
    throw cause;
  }
}
function volumeNumber(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Volume number must be a positive safe integer');
}
function verifyYaml(raw: string, count: number): void {
  const parsed = SecureYamlParser.parseRawYaml(raw, {
    maxSize: MEMORY_CONSTANTS.MAX_YAML_SIZE, schema: 'core', contentPolicy: 'structure-only',
  });
  if (!Array.isArray(parsed.entries) || parsed.entries.length !== count) throw new TypeError('Archive entry count disagrees with YAML');
}
function capture(input: FileMemoryVolumeInput): CapturedInput {
  const { minimumVolume, rawContent, entryCount } = input;
  volumeNumber(minimumVolume);
  if (!Number.isInteger(entryCount) || entryCount < 0 || entryCount > 2_147_483_647) throw new RangeError('Invalid archive entry count');
  if (typeof rawContent !== 'string' || rawContent.length > MEMORY_CONSTANTS.MAX_YAML_SIZE ||
    Buffer.byteLength(rawContent, 'utf8') > MAX_FILE_MEMORY_VOLUME_BYTES) throw new RangeError('Archive YAML exceeds bound');
  const bytes = Buffer.from(rawContent, 'utf8');
  if (bytes.toString('utf8') !== rawContent) throw new TypeError('Archive content does not round-trip through UTF-8');
  const date = (value: Date): string => {
    const copied = new Date(value);
    if (!Number.isFinite(copied.getTime())) throw new RangeError('Invalid archive timestamp');
    return copied.toISOString();
  };
  const sealedAt = date(input.sealedAt);
  const firstEntryAt = input.firstEntryAt === undefined ? null : date(input.firstEntryAt);
  const lastEntryAt = input.lastEntryAt === undefined ? null : date(input.lastEntryAt);
  if (firstEntryAt && lastEntryAt && Date.parse(firstEntryAt) > Date.parse(lastEntryAt)) throw new RangeError('Archive timestamps are reversed');
  verifyYaml(rawContent, entryCount);
  return Object.freeze({ minimumVolume, bytes, entryCount, firstEntryAt, lastEntryAt, sealedAt });
}
function directoryIdentity(stat: BigIntStats): ArchiveDirectoryIdentity {
  return Object.freeze({ device: String(stat.dev), inode: String(stat.ino) });
}
function fileIdentity(stat: BigIntStats): ArchiveFileIdentity {
  return Object.freeze({ ...directoryIdentity(stat), size: String(stat.size), ctimeNs: String(stat.ctimeNs), mtimeNs: String(stat.mtimeNs) });
}
function privateObject(stat: BigIntStats): boolean {
  return (stat.mode & 0o077n) === 0n && !!process.getuid && stat.uid === BigInt(process.getuid());
}
async function namesAt(directoryPath: string, limit: number, budget?: FileMemoryDirectoryScanner): Promise<string[]> {
  const names: string[] = [];
  if (budget) {
    await budget.scan(directoryPath, name => {
      if (names.length === limit) throw error('EARCHIVEBLOCKED', 'Archive directory exceeds inspection bound');
      names.push(name);
    });
    return names;
  }
  const handle = await fs.opendir(directoryPath);
  for await (const entry of handle) {
    if (names.length === limit) throw error('EARCHIVEBLOCKED', 'Archive directory exceeds inspection bound');
    names.push(entry.name);
  }
  return names;
}
async function directory(directoryPath: string, expected?: ArchiveDirectoryIdentity, requirePrivate = true): Promise<ArchiveDirectoryIdentity> {
  const stat = await fs.lstat(directoryPath, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (requirePrivate && !privateObject(stat))) throw error('EARCHIVEUNSAFE', 'Archive directory is unsafe');
  const identity = directoryIdentity(stat);
  if (expected && !isDeepStrictEqual(expected, identity)) throw error('EARCHIVEUNSAFE', 'Archive directory was replaced');
  return identity;
}
async function readFile(filePath: string, limit: number, expected?: ArchiveFileIdentity): Promise<{ bytes: Buffer; identity: ArchiveFileIdentity }> {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || !privateObject(before) || before.size > BigInt(limit)) throw error('EARCHIVEUNSAFE', 'Archive file is unsafe or oversized');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let used = 0;
    while (used < bytes.length) {
      const result = await handle.read(bytes, used, bytes.length - used, used);
      if (!result.bytesRead) break;
      used += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const identity = fileIdentity(after);
    const named = await fs.lstat(filePath, { bigint: true });
    if (used > limit || BigInt(used) !== after.size || !isDeepStrictEqual(fileIdentity(before), identity) ||
      !isDeepStrictEqual(fileIdentity(named), identity) || (expected && !isDeepStrictEqual(expected, identity))) throw error('EARCHIVEUNSAFE', 'Archive file changed or differs from writer');
    return { bytes: bytes.subarray(0, used), identity };
  } finally { await handle.close(); }
}
async function writeFile(filePath: string, bytes: Buffer, partial?: () => Promise<void>): Promise<ArchiveFileIdentity> {
  const handle = await fs.open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const split = Math.max(1, Math.floor(bytes.length / 2));
    await handle.writeFile(bytes.subarray(0, split));
    await partial?.();
    await handle.writeFile(bytes.subarray(split));
    await handle.sync();
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || !privateObject(stat) || stat.size !== BigInt(bytes.length)) throw error('EARCHIVEUNSAFE', 'Archive writer descriptor is unsafe');
    return fileIdentity(stat);
  } finally { await handle.close(); }
}

/** Local POSIX cooperating-process crash safety only; tenant coordinator is exclusion, not rollback. */
export class FileMemoryVolumeStore {
  private readonly options: FileMemoryVolumeStoreOptions;
  constructor(options: FileMemoryVolumeStoreOptions) {
    if (process.platform === 'win32' || !process.getuid) throw new Error('File archive storage requires local POSIX ownership checks');
    this.options = Object.freeze({ ...options });
  }
  /** Dormant exact unreferenced content cleanup; a fresh current head and exact receipt are required. */
  removeUnreferenced(expected: OwnedFileMemoryToken, receipt: FileMemoryVolumeReceipt): Promise<FileArchiveCleanupResult> {
    const captured = captureArchiveCleanupRequest(expected, receipt);
    let outcome: FileArchiveCleanupResult | undefined;
    return this.options.coordinator.withTenantTransaction(context => this.options.coordinator.perform(context, async operation => {
      outcome = await new FileMemoryArchiveCleanup(this.options, operation, captured.token, captured.receipt).run();
      return outcome;
    })).catch(cause => {
      const result = { status: outcome?.status === 'removed' ? 'removed' as const : 'unknown' as const,
        reason: outcome?.status === 'removed' ? 'removed' as const : 'query' as const,
        ...(outcome?.status === 'removed' ? { receipt: captured.receipt } : {}) };
      Object.defineProperty(result, 'cause', { value: cause, enumerable: false });
      return Object.freeze(result);
    });
  }
  removeUnreferencedInTransaction(context: FileMemoryLeaseContext, expected: OwnedFileMemoryToken,
    receipt: FileMemoryVolumeReceipt): Promise<FileArchiveCleanupResult> {
    const captured = captureArchiveCleanupRequest(expected, receipt);
    return this.options.coordinator.perform(context, operation =>
      new FileMemoryArchiveCleanup(this.options, operation, captured.token, captured.receipt).run());
  }
  createExclusive(expected: OwnedFileMemoryToken, input: FileMemoryVolumeInput): Promise<FileMemoryVolumeReceipt> {
    const captured = capture(input);
    const token = this.captureToken(expected);
    return retainCommittedFileArchives(retain => this.options.coordinator.withTenantTransaction(context =>
      this.options.coordinator.perform(context, async operation => {
        const receipt = await this.publish(operation, token, captured);
        retain(receipt);
        return receipt;
      })));
  }
  createExclusiveInTransaction(context: FileMemoryLeaseContext, expected: OwnedFileMemoryToken, input: FileMemoryVolumeInput): Promise<FileMemoryVolumeReceipt> {
    const captured = capture(input);
    const token = this.captureToken(expected);
    return this.options.coordinator.perform(context, operation => this.publish(operation, token, captured));
  }
  /** Audited composition already inside perform(); never enqueues a nested operation. */
  createExclusiveAtScope(operation: FileMemoryOperationScope, expected: OwnedFileMemoryToken, input: FileMemoryVolumeInput): Promise<FileMemoryVolumeReceipt> {
    const captured = capture(input);
    const token = this.captureToken(expected);
    return this.publish(operation, token, captured);
  }
  /** Dormant storage observation: captures one tenant/user scope, never acquires a fence. */
  read(expected: OwnedFileMemoryToken, volume: number): Promise<FileMemoryVolumeObservation> {
    const token = this.captureToken(expected);
    volumeNumber(volume);
    return this.options.coordinator.captureReadScope().then(scope => this.observe(scope, token, volume));
  }
  /** Tracked read under a caller-owned transaction; standalone read does not acquire one. */
  readInTransaction(context: FileMemoryLeaseContext, expected: OwnedFileMemoryToken, volume: number): Promise<FileMemoryVolumeObservation> {
    const token = this.captureToken(expected);
    volumeNumber(volume);
    return this.options.coordinator.perform(context, operation =>
      this.observe(this.options.coordinator.requireActiveOperationScope(operation), token, volume, operation));
  }
  /** Audited composition inside perform(); no nested operation or lease. */
  readAtScope(operation: FileMemoryOperationScope, expected: OwnedFileMemoryToken, volume: number): Promise<FileMemoryVolumeObservation> {
    const token = this.captureToken(expected);
    volumeNumber(volume);
    const scope = this.options.coordinator.requireActiveOperationScope(operation);
    return this.observe(scope, token, volume, operation);
  }
  /** Dormant bounded declarations; standalone observation writes no tenant fence. */
  list(expected: OwnedFileMemoryToken, options: MemoryVolumeListOptions = {}): Promise<MemoryVolumeObservation<FileMemoryVolumeInfo>> {
    const token = this.captureToken(expected);
    const entryLimit = captureMemoryVolumeEntryLimit(options);
    const budget = new FileMemoryDirectoryScanBudget();
    const proofBudget = new FileMemoryListProofBudget();
    return this.options.coordinator.captureReadScope().then(scope => this.listCaptured({ scope, token, entryLimit, budget, proofBudget }));
  }
  listInTransaction(context: FileMemoryLeaseContext, expected: OwnedFileMemoryToken, options: MemoryVolumeListOptions = {}): Promise<MemoryVolumeObservation<FileMemoryVolumeInfo>> {
    const token = this.captureToken(expected);
    const entryLimit = captureMemoryVolumeEntryLimit(options);
    const budget = new FileMemoryDirectoryScanBudget();
    const proofBudget = new FileMemoryListProofBudget();
    return this.options.coordinator.perform(context, operation => this.listCaptured({
      scope: this.options.coordinator.requireActiveOperationScope(operation), token, entryLimit, budget, proofBudget, operation,
    }));
  }
  /** Composition already inside perform; never enqueues a nested operation. */
  listAtScope(operation: FileMemoryOperationScope, expected: OwnedFileMemoryToken, options: MemoryVolumeListOptions = {}): Promise<MemoryVolumeObservation<FileMemoryVolumeInfo>> {
    const token = this.captureToken(expected);
    const entryLimit = captureMemoryVolumeEntryLimit(options);
    const budget = new FileMemoryDirectoryScanBudget();
    const proofBudget = new FileMemoryListProofBudget();
    const scope = this.options.coordinator.requireActiveOperationScope(operation);
    return this.listCaptured({ scope, token, entryLimit, budget, proofBudget, operation });
  }
  private async listCaptured(context: ListContext): Promise<MemoryVolumeObservation<FileMemoryVolumeInfo>> {
    try { return await this.listCapturedEvidence(context); }
    catch (cause) {
      const code = (cause as NodeJS.ErrnoException)?.code;
      if (code?.startsWith('EARCHIVE') || code?.startsWith('EOWNER') || code?.startsWith('EHEAD') || code === 'EINVALIDOPERATION') throw cause;
      throw error('EARCHIVEUNAVAILABLE', 'Archive metadata observation could not be proved', cause);
    }
  }
  private async listCapturedEvidence(context: ListContext): Promise<MemoryVolumeObservation<FileMemoryVolumeInfo>> {
    const { scope, token, operation, budget, proofBudget, entryLimit } = context;
    await this.observationOwner(scope, token, operation, proofBudget);
    const namespace = await this.readNamespace(scope, token.ownerId, proofBudget);
    proofBudget.reserve(path.dirname(path.join(scope.tenantRoot, token.locator)),
      path.join(scope.tenantRoot, '.memory-owners', 'owners'), namespace.paths.slice(0, -1),
      namespace.missing ? path.dirname(namespace.missing) : undefined);
    const names = namespace.missing ? [] : await namesAt(namespace.root, budget.limit, budget);
    const diagnostics: MemoryVolumeListDiagnostic[] = [];
    let diagnosticsTruncated = false;
    const diagnose = (reason: MemoryVolumeListDiagnostic['reason'], message: string): void => {
      if (diagnostics.length === MAX_MEMORY_VOLUME_LIST_DIAGNOSTICS) diagnosticsTruncated = true;
      else diagnostics.push(Object.freeze({ reason, message }));
    };
    const groups = this.listCandidateGroups(names);
    const declarations: ListedDeclaration[] = [];
    await this.collectListDeclarations(groups, namespace.root, token, budget, declarations, diagnose);
    // Unrecognized children are preserved and cannot qualify a complete census.
    if (names.some(name => !/^v\d+$/iu.test(name) || !Number.isSafeInteger(Number(name.slice(1))) || Number(name.slice(1)) < 1)) {
      diagnose('unsafe', 'Archive namespace contains unrecognized children');
    }
    const selected = declarations.slice(0, entryLimit);
    if (declarations.length > entryLimit) diagnose('entry-limit', 'Archive declaration return limit reached');
    const prove = async (): Promise<void> => {
      await this.observationOwner(scope, token, operation, proofBudget);
      await this.proveListCensus(namespace, names, budget, proofBudget);
      await this.reproveListDeclarations(selected, namespace.root, token, budget);
      await this.proveListCensus(namespace, names, budget, proofBudget);
    };
    await this.options.afterObservation?.('observed', namespace.root);
    await prove();
    await this.options.afterObservation?.('verified', namespace.root);
    await prove();
    const currentScope = operation ? this.options.coordinator.requireActiveOperationScope(operation) : scope;
    if (currentScope.userId !== token.userId || currentScope.tenantRoot !== token.tenantRoot) {
      throw error('EHEADCONFLICT', 'Archive observation authority changed');
    }
    const complete = diagnostics.length === 0 && !diagnosticsTruncated;
    return Object.freeze({ entries: Object.freeze(selected.map(value => value.metadata)), complete,
      returnedCount: selected.length, observedCount: names.filter(name => /^v\d+$/iu.test(name)).length,
      acceptedCount: declarations.length, scannedCount: budget.consumed + proofBudget.consumed,
      totalCount: complete ? declarations.length : null,
      diagnostics: Object.freeze(diagnostics), diagnosticsTruncated });
  }
  private async collectListDeclarations(groups: readonly { volume: number; names: string[] }[], root: string,
    token: OwnedFileMemoryToken, budget: FileMemoryDirectoryScanBudget, declarations: ListedDeclaration[],
    diagnose: (reason: MemoryVolumeListDiagnostic['reason'], message: string) => void, index = 0): Promise<void> {
    const group = groups[index];
    if (!group) return;
    if (group.names.includes(`v${group.volume}.cleanup.json`)) {
      diagnose('partial', 'Pending cleanup blocks the archive declaration');
    } else if (group.names.length !== 1 || group.names[0] !== `v${group.volume}`) {
      diagnose('alias', 'Archive number spelling is ambiguous');
    } else {
      try { declarations.push(await this.listDeclaration(root, token, group.volume, budget)); }
      catch (cause) {
        const code = (cause as NodeJS.ErrnoException)?.code;
        if (code === 'EHEADRESOURCE') throw cause;
        let reason: MemoryVolumeListDiagnostic['reason'] = 'unsafe';
        if (cause instanceof SyntaxError) reason = 'corrupt';
        else if (code === 'EARCHIVEBLOCKED') reason = 'partial';
        diagnose(reason, 'Archive metadata declaration could not be proved');
      }
    }
    await this.collectListDeclarations(groups, root, token, budget, declarations, diagnose, index + 1);
  }
  private async reproveListDeclarations(declarations: readonly ListedDeclaration[], root: string,
    token: OwnedFileMemoryToken, budget: FileMemoryDirectoryScanBudget, index = 0): Promise<void> {
    const declaration = declarations[index];
    if (!declaration) return;
    await this.listDeclaration(root, token, declaration.metadata.volume, budget, declaration);
    await this.reproveListDeclarations(declarations, root, token, budget, index + 1);
  }
  private sortedListNames(names: readonly string[]): string[] {
    return [...names].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  }
  private listCandidateGroups(names: readonly string[]): { volume: number; names: string[] }[] {
    const groups = new Map<number, string[]>();
    for (const name of names) {
      const match = /^v(\d+)(.*)$/iu.exec(name);
      if (!match) continue;
      const volume = Number(match[1]);
      if (!Number.isSafeInteger(volume) || volume < 1) continue;
      const group = groups.get(volume) ?? [];
      group.push(name);
      groups.set(volume, group);
    }
    return [...groups].map(([volume, group]) => ({ volume, names: group })).sort((left, right) => left.volume - right.volume);
  }
  private async proveListCensus(namespace: ReadArchiveNamespace, first: readonly string[], budget: FileMemoryDirectoryScanBudget, proofBudget: FileMemoryListProofBudget): Promise<void> {
    await this.proveReadNamespace(namespace, proofBudget);
    if (!namespace.missing) {
      const last = await namesAt(namespace.root, budget.limit, budget);
      if (!isDeepStrictEqual(this.sortedListNames(first), this.sortedListNames(last))) throw error('EARCHIVECHANGED', 'Archive child set changed during observation');
    }
  }
  private async listDeclaration(root: string, owner: OwnedFileMemoryToken, volume: number, budget: FileMemoryDirectoryScanBudget,
    expected?: ListedDeclaration): Promise<ListedDeclaration> {
    const volumePath = path.join(root, `v${volume}`);
    const volumeIdentity = await directory(volumePath, expected?.volumeIdentity);
    const children = await namesAt(volumePath, 2, budget);
    const generation = children.filter(name => GENERATION.test(name));
    if (generation.length !== 1 || children.length !== 2 || !children.includes('COMMITTED')) {
      throw error('EARCHIVEBLOCKED', 'Archive slot is partial or has unexpected children');
    }
    const generationPath = path.join(volumePath, generation[0]);
    const generationIdentity = await directory(generationPath, expected?.generationIdentity);
    if (this.sortedListNames(await namesAt(generationPath, 2, budget)).join('|') !== 'metadata.json|payload.yaml') {
      throw error('EARCHIVEBLOCKED', 'Archive generation has unexpected children');
    }
    const markerIdentity = await directory(path.join(volumePath, 'COMMITTED'), expected?.markerIdentity);
    await namesAt(path.join(volumePath, 'COMMITTED'), 0, budget);
    const metadata = await readFile(path.join(generationPath, 'metadata.json'), MAX_METADATA_BYTES, expected?.metadataIdentity);
    if (expected && !metadata.bytes.equals(expected.metadataBytes)) throw error('EARCHIVECHANGED', 'Archive metadata bytes changed');
    const declaration = this.listMetadata(metadata.bytes, owner, volume, generation[0]);
    await directory(volumePath, volumeIdentity);
    await directory(generationPath, generationIdentity);
    await directory(path.join(volumePath, 'COMMITTED'), markerIdentity);
    await namesAt(path.join(volumePath, 'COMMITTED'), 0, budget);
    return { metadata: Object.freeze(declaration), metadataBytes: metadata.bytes, volumeIdentity, generationIdentity,
      markerIdentity, metadataIdentity: metadata.identity };
  }
  private listMetadata(bytes: Buffer, owner: OwnedFileMemoryToken, volume: number, generation: string): Metadata {
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw error('EARCHIVEUNSAFE', 'Archive metadata is not exact UTF-8');
    const value = JSON.parse(text) as Metadata;
    const keys = ['schema', 'userId', 'ownerId', 'volume', 'generationId', 'sha256', 'byteLength', 'entryCount', 'firstEntryAt', 'lastEntryAt', 'sealedAt'];
    const date = (input: unknown): boolean => typeof input === 'string' && Number.isFinite(Date.parse(input)) && new Date(input).toISOString() === input;
    if (!value || !isDeepStrictEqual(this.sortedListNames(Object.keys(value)), this.sortedListNames(keys)) || value.schema !== 1 ||
      value.userId !== owner.userId || value.ownerId !== owner.ownerId || value.volume !== volume ||
      typeof value.generationId !== 'string' || `g-${value.generationId}` !== generation ||
      typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sha256) ||
      !Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > MAX_FILE_MEMORY_VOLUME_BYTES ||
      !Number.isInteger(value.entryCount) || value.entryCount < 0 || value.entryCount > 2_147_483_647 || !date(value.sealedAt) ||
      (value.firstEntryAt !== null && !date(value.firstEntryAt)) || (value.lastEntryAt !== null && !date(value.lastEntryAt)) ||
      (value.firstEntryAt !== null && value.lastEntryAt !== null && Date.parse(value.firstEntryAt) > Date.parse(value.lastEntryAt))) {
      throw error('EARCHIVEUNSAFE', 'Archive metadata declarations are invalid');
    }
    return value;
  }
  private async observationOwner(scope: FileMemoryTransactionScope, token: OwnedFileMemoryToken,
    operation?: FileMemoryOperationScope, budget?: FileMemoryDirectoryScanner): Promise<void> {
    if (operation) await this.options.owners.requireOwnedAtScope(operation, token, budget);
    else await this.options.owners.requireOwnedAtReadScope(scope, token, budget);
  }
  private async readNamespace(scope: FileMemoryTransactionScope, ownerId: string, budget?: FileMemoryDirectoryScanner): Promise<ReadArchiveNamespace> {
    const namespace = { root: scope.tenantRoot, paths: [scope.tenantRoot],
      identities: [await directory(scope.tenantRoot, undefined, false)] };
    return this.readNamespaceChild(namespace, ['volumes', 'by-id', ownerId], 0, budget);
  }
  private async readNamespaceChild(namespace: ReadArchiveNamespace, components: readonly string[], index: number, budget?: FileMemoryDirectoryScanner): Promise<ReadArchiveNamespace> {
    if (index === components.length) return namespace;
    const component = components[index];
    await this.requireNamespaceComponent(namespace.root, component, false, budget);
    const child = path.join(namespace.root, component);
    let identity: ArchiveDirectoryIdentity;
    try { identity = await directory(child); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      return { ...namespace, root: child, missing: child };
    }
    return this.readNamespaceChild({ root: child, paths: [...namespace.paths, child],
      identities: [...namespace.identities, identity] }, components, index + 1, budget);
  }
  private async proveReadNamespace(namespace: ReadArchiveNamespace, budget?: FileMemoryDirectoryScanner): Promise<void> {
    await this.revalidateNamespace(namespace);
    await this.revalidateNamespaceSpelling(namespace, budget);
    if (namespace.missing) {
      const parent = path.dirname(namespace.missing);
      const component = path.basename(namespace.missing);
      await this.requireNamespaceComponent(parent, component, false, budget);
      const siblings = await namesAt(parent, 100_000, budget);
      this.requireCanonicalNamespaceComponent(siblings, component, false);
      if (siblings.includes(component)) throw error('EARCHIVECHANGED', 'Archive namespace appeared during observation');
    }
  }
  private async observe(scope: FileMemoryTransactionScope, token: OwnedFileMemoryToken, volume: number,
    operation?: FileMemoryOperationScope): Promise<FileMemoryVolumeObservation> {
    try { return await this.observeCaptured(scope, token, volume, operation); }
    catch (cause) {
      const code = (cause as NodeJS.ErrnoException)?.code;
      if (code?.startsWith('EARCHIVE') || code?.startsWith('EOWNER') || code?.startsWith('EHEAD') || code === 'EINVALIDOPERATION') throw cause;
      throw error(cause instanceof SyntaxError || cause instanceof TypeError || cause instanceof RangeError
        ? 'EARCHIVEUNSAFE' : 'EARCHIVEUNAVAILABLE', 'Archive observation could not be proved', cause);
    }
  }
  private async observeCaptured(scope: FileMemoryTransactionScope, token: OwnedFileMemoryToken, volume: number,
    operation?: FileMemoryOperationScope): Promise<FileMemoryVolumeObservation> {
    await this.observationOwner(scope, token, operation);
    const namespace = await this.readNamespace(scope, token.ownerId);
    const volumePath = path.join(namespace.root, `v${volume}`);
    if (namespace.missing) return this.absentObservation(scope, token, volume, namespace, operation);
    await this.requireVolumeSpelling(namespace.root, volume);
    try { await directory(volumePath); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      return this.absentObservation(scope, token, volume, namespace, operation);
    }
    // Capture the marker before payload observation; replacement is not a second commit.
    const marker = await directory(path.join(volumePath, 'COMMITTED'));
    const first = await this.verify(volumePath, token, volume, undefined, undefined, undefined, { required: true, identity: marker });
    await this.options.afterObservation?.('observed', volumePath);
    const proof = { volume, generationId: first.metadata.generationId,
      volumeIdentity: first.volumeIdentity, generationIdentity: first.generationIdentity,
      payloadIdentity: first.payloadIdentity, metadataIdentity: first.metadataIdentity };
    const prove = async (): Promise<void> => {
      await this.proveReadNamespace(namespace);
      await this.requireVolumeSpelling(namespace.root, volume);
      await this.verify(volumePath, token, volume, proof, first.payloadBytes, first.metadataBytes, { required: true, identity: marker });
      await this.observationOwner(scope, token, operation);
      await this.proveReadNamespace(namespace);
      await this.requireVolumeSpelling(namespace.root, volume);
      await directory(path.join(volumePath, 'COMMITTED'), marker);
      await namesAt(path.join(volumePath, 'COMMITTED'), 0);
    };
    await prove();
    await this.options.afterObservation?.('verified', volumePath);
    await prove();
    return Object.freeze({ status: 'found', owner: token, volume,
      rawContent: first.payloadBytes.toString('utf8'), metadata: Object.freeze(first.metadata) });
  }
  private async absentObservation(scope: FileMemoryTransactionScope, token: OwnedFileMemoryToken, volume: number,
    namespace: ReadArchiveNamespace,
    operation?: FileMemoryOperationScope): Promise<FileMemoryVolumeObservation> {
    await this.options.afterObservation?.('observed', namespace.root);
    await this.observationOwner(scope, token, operation);
    await this.proveReadNamespace(namespace);
    if (!namespace.missing) {
      await this.requireVolumeSpelling(namespace.root, volume);
      const siblings = await namesAt(namespace.root, 100_000);
      this.requireCanonicalVolumeSpelling(siblings, volume);
      if (siblings.includes(`v${volume}`)) throw error('EARCHIVECHANGED', 'Archive appeared during absence observation');
    }
    return Object.freeze({ status: 'absent', owner: token, volume });
  }
  private captureToken(expected: OwnedFileMemoryToken): OwnedFileMemoryToken {
    const token = { ...expected, fileIdentity: Object.freeze({ ...expected.fileIdentity }) };
    if (!UUID.test(token.ownerId)) throw new TypeError('Archive requires a durable owner UUID');
    return Object.freeze(token);
  }
  private async requireNamespaceComponent(parent: string, component: string, requirePresent = true, budget?: FileMemoryDirectoryScanner): Promise<void> {
    const siblings = await namesAt(parent, 100_000, budget);
    this.requireCanonicalNamespaceComponent(siblings, component, requirePresent);
  }
  private requireCanonicalNamespaceComponent(siblings: readonly string[], component: string, requirePresent: boolean): void {
    if ((requirePresent && !siblings.includes(component)) ||
      siblings.some(name => name.toLowerCase() === component.toLowerCase() && name !== component)) {
      throw error('EARCHIVEUNSAFE', 'Archive namespace spelling or case alias is unsafe');
    }
  }
  private async requireVolumeSpelling(root: string, volume: number): Promise<void> {
    const siblings = await namesAt(root, 100_000);
    this.requireCanonicalVolumeSpelling(siblings, volume);
  }
  private requireCanonicalVolumeSpelling(siblings: readonly string[], volume: number): void {
    for (const name of siblings) {
      const match = /^v(\d+)(.*)$/iu.exec(name);
      if (!match || BigInt(match[1]) !== BigInt(volume) || name === `v${volume}`) continue;
      if (name === `v${volume}.cleanup.json`) throw error('EARCHIVEBLOCKED', 'Pending cleanup blocks target archive admission');
      throw error('EARCHIVEUNSAFE', 'Unknown target-derived archive residue is unsafe');
    }
    if (siblings.some(name => /^v\d+$/iu.test(name) && BigInt(name.slice(1)) === BigInt(volume) && name !== `v${volume}`)) {
      throw error('EARCHIVEUNSAFE', 'Archive volume number alias is unsafe');
    }
  }
  private async namespaceComponent(parent: string, component: string): Promise<{ path: string; identity: ArchiveDirectoryIdentity }> {
    await this.requireNamespaceComponent(parent, component, false);
    const componentPath = path.join(parent, component);
    try { await fs.mkdir(componentPath, { mode: 0o700 }); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
    return { path: componentPath, identity: await directory(componentPath) };
  }
  private async namespace(operation: FileMemoryOperationScope, ownerId: string): Promise<{ root: string; paths: readonly string[]; identities: readonly ArchiveDirectoryIdentity[] }> {
    const scope = this.options.coordinator.requireActiveOperationScope(operation);
    const tenantIdentity = await directory(scope.tenantRoot, undefined, false);
    // Each child is inspected only after its parent has been created/validated.
    const volumes = await this.namespaceComponent(scope.tenantRoot, 'volumes');
    const byId = await this.namespaceComponent(volumes.path, 'by-id');
    const owner = await this.namespaceComponent(byId.path, ownerId);
    return { root: owner.path, paths: [scope.tenantRoot, volumes.path, byId.path, owner.path],
      identities: [tenantIdentity, volumes.identity, byId.identity, owner.identity] };
  }
  private async revalidateNamespace(namespace: { paths: readonly string[]; identities: readonly ArchiveDirectoryIdentity[] }): Promise<void> {
    // Independent read-only identity comparisons; every result must settle before publication.
    const results = await Promise.allSettled(namespace.paths.map((componentPath, index) => directory(componentPath, namespace.identities[index], index !== 0)));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  private async revalidateNamespaceSpelling(namespace: { paths: readonly string[] }, budget?: FileMemoryDirectoryScanner): Promise<void> {
    const results = await Promise.allSettled(namespace.paths.slice(1).map((componentPath, index) =>
      this.requireNamespaceComponent(namespace.paths[index], path.basename(componentPath), true, budget)));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  private async verify(volumePath: string, owner: OwnedFileMemoryToken, volume: number, expected?: Pick<FileMemoryVolumeReceipt, 'volume' | 'generationId' | 'volumeIdentity' | 'generationIdentity' | 'payloadIdentity' | 'metadataIdentity'>, expectedBytes?: Buffer, expectedMetadata?: Buffer, markerProof?: { required: boolean; identity?: ArchiveDirectoryIdentity }): Promise<{ metadata: Metadata; payloadBytes: Buffer; metadataBytes: Buffer; payloadIdentity: ArchiveFileIdentity; metadataIdentity: ArchiveFileIdentity; generationIdentity: ArchiveDirectoryIdentity; volumeIdentity: ArchiveDirectoryIdentity }> {
    const volumeIdentity = await directory(volumePath, expected?.volumeIdentity);
    const names = await namesAt(volumePath, 2);
    const generationNames = names.filter(name => GENERATION.test(name));
    if (generationNames.length !== 1 || names.some(name => name !== generationNames[0] && name !== 'COMMITTED') ||
      ((markerProof?.required ?? !expected) && !names.includes('COMMITTED'))) throw error('EARCHIVEBLOCKED', 'Partial or unexpected archive slot blocks allocation');
    const generationPath = path.join(volumePath, generationNames[0]);
    const generationIdentity = await directory(generationPath, expected?.generationIdentity);
    if ((await namesAt(generationPath, 2)).sort((left, right) => left.localeCompare(right)).join('|') !== 'metadata.json|payload.yaml') throw error('EARCHIVEBLOCKED', 'Archive generation has unexpected contents');
    if (names.includes('COMMITTED')) {
      await directory(path.join(volumePath, 'COMMITTED'), markerProof?.identity);
      if ((await namesAt(path.join(volumePath, 'COMMITTED'), 0)).length) throw error('EARCHIVEUNSAFE', 'Archive marker is not empty');
    }
    const meta = await readFile(path.join(generationPath, 'metadata.json'), MAX_METADATA_BYTES, expected?.metadataIdentity);
    const payload = await readFile(path.join(generationPath, 'payload.yaml'), MAX_FILE_MEMORY_VOLUME_BYTES, expected?.payloadIdentity);
    if ((expectedBytes && !payload.bytes.equals(expectedBytes)) || (expectedMetadata && !meta.bytes.equals(expectedMetadata))) throw error('EARCHIVEUNSAFE', 'Archive readback bytes disagree');
    const metadata = this.verifyMetadata(meta.bytes, payload.bytes, owner, volume, generationNames[0]);
    await directory(volumePath, volumeIdentity);
    await directory(generationPath, generationIdentity);
    return { metadata, payloadBytes: payload.bytes, metadataBytes: meta.bytes, payloadIdentity: payload.identity, metadataIdentity: meta.identity, volumeIdentity, generationIdentity };
  }
  private async verifyPublication(
    namespace: { root: string; paths: readonly string[]; identities: readonly ArchiveDirectoryIdentity[] },
    volumePath: string, owner: OwnedFileMemoryToken, receipt: FileMemoryVolumeReceipt,
    payload: Buffer, metadata: Buffer, markerProof?: { required: boolean; identity?: ArchiveDirectoryIdentity },
  ): Promise<void> {
    await this.revalidateNamespace(namespace);
    await this.revalidateNamespaceSpelling(namespace);
    await this.requireVolumeSpelling(namespace.root, receipt.volume);
    await this.verify(volumePath, owner, receipt.volume, receipt, payload, metadata, markerProof ?? { required: false });
    await this.revalidateNamespace(namespace);
    await this.revalidateNamespaceSpelling(namespace);
    await this.requireVolumeSpelling(namespace.root, receipt.volume);
  }
  private verifyMetadata(metadataBytes: Buffer, payloadBytes: Buffer, owner: OwnedFileMemoryToken, volume: number, generationName: string): Metadata {
    const metadata = JSON.parse(metadataBytes.toString('utf8')) as Metadata;
    const keys = ['schema', 'userId', 'ownerId', 'volume', 'generationId', 'sha256', 'byteLength', 'entryCount', 'firstEntryAt', 'lastEntryAt', 'sealedAt'].sort((left, right) => left.localeCompare(right));
    if (!metadata || Object.keys(metadata).sort((left, right) => left.localeCompare(right)).join('|') !== keys.join('|') || metadata.schema !== 1 || metadata.userId !== owner.userId ||
      metadata.ownerId !== owner.ownerId || metadata.volume !== volume || typeof metadata.generationId !== 'string' ||
      `g-${metadata.generationId}` !== generationName ||
      metadata.byteLength !== payloadBytes.length || metadata.sha256 !== createHash('sha256').update(payloadBytes).digest('hex')) throw error('EARCHIVEUNSAFE', 'Archive metadata disagrees');
    const canonicalDate = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
    if (!canonicalDate(metadata.sealedAt) || (metadata.firstEntryAt !== null && !canonicalDate(metadata.firstEntryAt)) ||
      (metadata.lastEntryAt !== null && !canonicalDate(metadata.lastEntryAt))) throw error('EARCHIVEUNSAFE', 'Archive metadata dates are not canonical');
    const rawContent = payloadBytes.toString('utf8');
    const validated = capture({ minimumVolume: volume, rawContent, entryCount: metadata.entryCount, sealedAt: new Date(metadata.sealedAt),
      ...(metadata.firstEntryAt === null ? {} : { firstEntryAt: new Date(metadata.firstEntryAt) }),
      ...(metadata.lastEntryAt === null ? {} : { lastEntryAt: new Date(metadata.lastEntryAt) }) });
    if (!validated.bytes.equals(payloadBytes)) throw error('EARCHIVEUNSAFE', 'Archive UTF-8 is invalid');
    return metadata;
  }
  private async reserveSlot(root: string, token: OwnedFileMemoryToken, volume: number, operationId: string,
    reserved: (candidate: string) => void, probe = 0): Promise<{ path: string; volume: number; identity: ArchiveDirectoryIdentity }> {
    if (probe === MAX_FILE_MEMORY_VOLUME_COLLISION_PROBES) throw error('EARCHIVEEXHAUSTED', 'Archive collision limit exhausted');
    const candidate = path.join(root, `v${volume}`);
    await this.requireVolumeSpelling(root, volume);
    try {
      await fs.mkdir(candidate, { mode: 0o700 });
      reserved(candidate);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      await this.requireCommittedCollision(candidate, token, volume, operationId);
      if (volume === Number.MAX_SAFE_INTEGER) throw error('EARCHIVEEXHAUSTED', 'Archive numbers exhausted');
      // Awaited filesystem proof precedes the next probe; no concurrent reservation or synchronous recursion.
      return this.reserveSlot(root, token, volume + 1, operationId, reserved, probe + 1);
    }
    return { path: candidate, volume, identity: await directory(candidate) };
  }
  private async requireCommittedCollision(candidate: string, token: OwnedFileMemoryToken, volume: number, operationId: string): Promise<void> {
    try { await this.verify(candidate, token, volume); }
    catch (cause) {
      throw Object.assign(error((cause as NodeJS.ErrnoException).code ?? 'EARCHIVEBLOCKED',
        'Existing archive slot cannot be qualified; allocation is blocked', cause),
      { outcome: 'blocked', operationId, residualPath: candidate });
    }
  }
  private async publish(operation: FileMemoryOperationScope, token: OwnedFileMemoryToken, input: CapturedInput): Promise<FileMemoryVolumeReceipt> {
    const scope = this.options.coordinator.requireActiveOperationScope(operation);
    await this.options.owners.requireOwnedAtScope(operation, token);
    const operationId = randomUUID();
    let residualPath: string | undefined;
    let markerAttempted = false;
    let receipt: FileMemoryVolumeReceipt | undefined;
    let knownCommitted = false;
    try {
      const namespace = await this.namespace(operation, token.ownerId);
      const slot = await this.reserveSlot(namespace.root, token, input.minimumVolume, operationId, candidate => { residualPath = candidate; });
      residualPath = slot.path;
      const volume = slot.volume;
      const volumeIdentity = slot.identity;
      const notify = async (phase: ArchivePublicationPhase): Promise<void> => { await this.options.afterPublication?.(phase, residualPath!); };
      await notify('reserved-volume');
      await this.revalidateNamespace(namespace);
      await directory(residualPath, volumeIdentity);
      const generationId = randomUUID();
      const generationPath = path.join(residualPath, `g-${generationId}`);
      await fs.mkdir(generationPath, { mode: 0o700 });
      const generationIdentity = await directory(generationPath);
      await notify('reserved-generation');
      await this.revalidateNamespace(namespace);
      await directory(residualPath, volumeIdentity);
      await directory(generationPath, generationIdentity);
      const payloadIdentity = await writeFile(path.join(generationPath, 'payload.yaml'), input.bytes, () => notify('partial-payload'));
      await notify('payload-written');
      await this.revalidateNamespace(namespace);
      await directory(residualPath, volumeIdentity);
      await directory(generationPath, generationIdentity);
      const sha256 = createHash('sha256').update(input.bytes).digest('hex');
      const metadata: Metadata = { schema: 1, userId: scope.userId, ownerId: token.ownerId, volume, generationId,
        sha256, byteLength: input.bytes.length, entryCount: input.entryCount, firstEntryAt: input.firstEntryAt,
        lastEntryAt: input.lastEntryAt, sealedAt: input.sealedAt };
      const metadataBytes = Buffer.from(JSON.stringify(metadata));
      if (metadataBytes.length > MAX_METADATA_BYTES) throw error('EARCHIVEUNSAFE', 'Archive metadata exceeds bound');
      const metadataIdentity = await writeFile(path.join(generationPath, 'metadata.json'), metadataBytes, () => notify('partial-metadata'));
      await notify('metadata-written');
      receipt = Object.freeze({ schema: 1, tenantRoot: scope.tenantRoot, userId: scope.userId, ownerId: token.ownerId,
        volume, generationId, operationId, sha256, byteLength: input.bytes.length, entryCount: input.entryCount,
        volumeIdentity, generationIdentity, payloadIdentity, metadataIdentity });
      await this.verifyPublication(namespace, residualPath, token, receipt, input.bytes, metadataBytes);
      await notify('verified-before-marker');
      await this.options.owners.requireOwnedAtScope(operation, token);
      await notify('before-marker');
      await this.options.owners.requireOwnedAtScope(operation, token);
      this.options.coordinator.requireActiveOperationScope(operation);
      await this.revalidateNamespace(namespace);
      await this.verifyPublication(namespace, residualPath, token, receipt, input.bytes, metadataBytes);
      if ((await namesAt(residualPath, 1)).join('|') !== `g-${generationId}`) throw error('EARCHIVEUNSAFE', 'Archive slot changed before marker');
      await notify('invoking-marker');
      await this.options.owners.requireOwnedAtScope(operation, token);
      await this.revalidateNamespace(namespace);
      await directory(residualPath, volumeIdentity);
      await directory(generationPath, generationIdentity);
      await this.verifyPublication(namespace, residualPath, token, receipt, input.bytes, metadataBytes);
      markerAttempted = true;
      await fs.mkdir(path.join(residualPath, 'COMMITTED'), { recursive: false, mode: 0o700 });
      knownCommitted = true;
      const markerIdentity = await directory(path.join(residualPath, 'COMMITTED'));
      await notify('committed-marker');
      await this.verifyPublication(namespace, residualPath, token, receipt, input.bytes, metadataBytes, { required: true, identity: markerIdentity });
      await notify('verified-after-marker');
      await this.verifyPublication(namespace, residualPath, token, receipt, input.bytes, metadataBytes, { required: true, identity: markerIdentity });
      return receipt;
    } catch (cause) {
      // Receipt construction precedes marker invocation; knownCommitted implies receipt exists.
      if (knownCommitted) throw committed(cause, [receipt!]);
      if (!residualPath) throw cause;
      throw Object.assign(error(markerAttempted ? 'EARCHIVECOMMITUNKNOWN' : 'EARCHIVEUNCOMMITTED',
        markerAttempted ? 'Archive marker outcome is unknown' : 'Archive remains uncommitted', cause), {
        ...(markerAttempted ? {} : { committed: false }), outcome: markerAttempted ? 'unknown' : 'uncommitted', operationId, residualPath,
      });
    }
  }
}
