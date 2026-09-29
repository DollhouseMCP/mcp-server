/** Dormant owner-bound archive publication; no public read, cleanup or runtime wiring. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { MEMORY_CONSTANTS } from '../elements/memories/constants.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { FileMemoryOwnerSnapshots, type OwnedFileMemoryToken } from './FileMemoryOwnerSnapshots.js';
import { FileMemoryTransactionCoordinator, type FileMemoryLeaseContext, type FileMemoryOperationScope } from './FileMemoryTransactionCoordinator.js';

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
  /** Fault/process barriers only. Never recovery or production activation. */
  readonly afterPublication?: (phase: ArchivePublicationPhase, residualPath: string) => void | Promise<void>;
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
  if (firstEntryAt && lastEntryAt && firstEntryAt > lastEntryAt) throw new RangeError('Archive timestamps are reversed');
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
async function namesAt(directoryPath: string, limit: number): Promise<string[]> {
  const names: string[] = [];
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
    if (process.platform === 'win32' || !process.getuid) throw new Error('Archive publication requires local POSIX ownership checks');
    this.options = Object.freeze({ ...options });
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
  private captureToken(expected: OwnedFileMemoryToken): OwnedFileMemoryToken {
    const token = { ...expected, fileIdentity: { ...expected.fileIdentity } };
    if (!UUID.test(token.ownerId)) throw new TypeError('Archive requires a durable owner UUID');
    return Object.freeze(token);
  }
  private async namespaceComponent(parent: string, component: string): Promise<{ path: string; identity: ArchiveDirectoryIdentity }> {
    const siblings = await namesAt(parent, 100_000);
    if (siblings.some(name => name.toLowerCase() === component.toLowerCase() && name !== component)) {
      throw error('EARCHIVEUNSAFE', 'Archive namespace case alias is unsafe');
    }
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
  private async verify(volumePath: string, owner: OwnedFileMemoryToken, volume: number, expected?: FileMemoryVolumeReceipt, expectedBytes?: Buffer, expectedMetadata?: Buffer, requireMarker = !expected): Promise<{ metadata: Metadata; payloadIdentity: ArchiveFileIdentity; metadataIdentity: ArchiveFileIdentity; generationIdentity: ArchiveDirectoryIdentity; volumeIdentity: ArchiveDirectoryIdentity }> {
    const volumeIdentity = await directory(volumePath, expected?.volumeIdentity);
    const names = await namesAt(volumePath, 2);
    const generationNames = names.filter(name => GENERATION.test(name));
    if (generationNames.length !== 1 || names.some(name => name !== generationNames[0] && name !== 'COMMITTED') ||
      (requireMarker && !names.includes('COMMITTED'))) throw error('EARCHIVEBLOCKED', 'Partial or unexpected archive slot blocks allocation');
    const generationPath = path.join(volumePath, generationNames[0]);
    const generationIdentity = await directory(generationPath, expected?.generationIdentity);
    if ((await namesAt(generationPath, 2)).sort((left, right) => left.localeCompare(right)).join('|') !== 'metadata.json|payload.yaml') throw error('EARCHIVEBLOCKED', 'Archive generation has unexpected contents');
    if (names.includes('COMMITTED')) {
      await directory(path.join(volumePath, 'COMMITTED'));
      if ((await namesAt(path.join(volumePath, 'COMMITTED'), 0)).length) throw error('EARCHIVEUNSAFE', 'Archive marker is not empty');
    }
    const meta = await readFile(path.join(generationPath, 'metadata.json'), MAX_METADATA_BYTES, expected?.metadataIdentity);
    const payload = await readFile(path.join(generationPath, 'payload.yaml'), MAX_FILE_MEMORY_VOLUME_BYTES, expected?.payloadIdentity);
    if ((expectedBytes && !payload.bytes.equals(expectedBytes)) || (expectedMetadata && !meta.bytes.equals(expectedMetadata))) throw error('EARCHIVEUNSAFE', 'Archive readback bytes disagree');
    const metadata = this.verifyMetadata(meta.bytes, payload.bytes, owner, volume, generationNames[0]);
    await directory(volumePath, volumeIdentity);
    await directory(generationPath, generationIdentity);
    return { metadata, payloadIdentity: payload.identity, metadataIdentity: meta.identity, volumeIdentity, generationIdentity };
  }
  private verifyMetadata(metadataBytes: Buffer, payloadBytes: Buffer, owner: OwnedFileMemoryToken, volume: number, generationName: string): Metadata {
    const metadata = JSON.parse(metadataBytes.toString('utf8')) as Metadata;
    const keys = ['schema', 'userId', 'ownerId', 'volume', 'generationId', 'sha256', 'byteLength', 'entryCount', 'firstEntryAt', 'lastEntryAt', 'sealedAt'].sort((left, right) => left.localeCompare(right));
    if (!metadata || Object.keys(metadata).sort((left, right) => left.localeCompare(right)).join('|') !== keys.join('|') || metadata.schema !== 1 || metadata.userId !== owner.userId ||
      metadata.ownerId !== owner.ownerId || metadata.volume !== volume || `g-${metadata.generationId}` !== generationName ||
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
    const siblings = await namesAt(root, 100_000);
    if (siblings.some(name => /^v\d+$/iu.test(name) && BigInt(name.slice(1)) === BigInt(volume) && name !== `v${volume}`)) {
      throw error('EARCHIVEUNSAFE', 'Archive volume number alias is unsafe');
    }
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
      await this.verify(residualPath, token, volume, receipt, input.bytes, metadataBytes);
      await notify('verified-before-marker');
      await this.options.owners.requireOwnedAtScope(operation, token);
      await notify('before-marker');
      await this.options.owners.requireOwnedAtScope(operation, token);
      this.options.coordinator.requireActiveOperationScope(operation);
      await this.revalidateNamespace(namespace);
      await this.verify(residualPath, token, volume, receipt, input.bytes, metadataBytes);
      if ((await namesAt(residualPath, 1)).join('|') !== `g-${generationId}`) throw error('EARCHIVEUNSAFE', 'Archive slot changed before marker');
      markerAttempted = true;
      await notify('invoking-marker');
      await this.options.owners.requireOwnedAtScope(operation, token);
      await this.revalidateNamespace(namespace);
      await directory(residualPath, volumeIdentity);
      await directory(generationPath, generationIdentity);
      await fs.mkdir(path.join(residualPath, 'COMMITTED'), { recursive: false, mode: 0o700 });
      knownCommitted = true;
      await notify('committed-marker');
      await this.verify(residualPath, token, volume, receipt, input.bytes, metadataBytes, true);
      await notify('verified-after-marker');
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
