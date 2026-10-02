/** Dormant exact archive cleanup. Local cooperating-process crash model, never recursive erasure. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { closeMemoryDirectoryInspection, FileMemoryDirectoryScanLimitError, type FileMemoryDirectoryScanner } from './FileMemoryDirectoryScanBudget.js';

const MAX_INTENT = 8192;
const MAX_NUMERIC_WIDTH = 40;
type Identity = Readonly<{ device: string; inode: string; mode: string; uid: string; type: 'directory' | 'file';
  size: string; mtimeNs: string; ctimeNs: string; nlink: string }>;
type StableDirectory = Pick<Identity, 'device' | 'inode' | 'mode' | 'uid' | 'type'>;
type Commitment = Readonly<{ identity: StableDirectory; count: number; sha256: string }>;
// T tenant, H head parent, R registry, V volumes, B by-id, O owner, S slot, G generation, K marker.
type Role = 'T' | 'H' | 'R' | 'V' | 'B' | 'O' | 'S' | 'G' | 'K';
const ROLES: readonly Role[] = ['T', 'H', 'R', 'V', 'B', 'O', 'S', 'G', 'K'];
function causeCode(cause: unknown): string | undefined {
  try { const value = (cause as NodeJS.ErrnoException | null | undefined)?.code; return typeof value === 'string' ? value : undefined; }
  catch { return undefined; }
}
function failure(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'EARCHIVEUNSAFE' });
}
function digest(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }
function identity(stat: BigIntStats, directory: boolean, privateRequired = true): Identity {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) ||
    (privateRequired && ((stat.mode & 0o077n) !== 0n || !process.getuid || stat.uid !== BigInt(process.getuid())))) {
    throw failure('Cleanup evidence is not a confined private object');
  }
  const value = { device: String(stat.dev), inode: String(stat.ino), mode: String(stat.mode), uid: String(stat.uid),
    type: directory ? 'directory' as const : 'file' as const, size: String(stat.size), mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs), nlink: String(stat.nlink) };
  if (Object.entries(value).some(([key, field]) => key !== 'type' && !/^-?\d+$/u.test(field)) ||
    Object.entries(value).some(([key, field]) => key !== 'type' && field.length > MAX_NUMERIC_WIDTH)) {
    throw new FileMemoryDirectoryScanLimitError();
  }
  return Object.freeze(value);
}
function stable(value: Identity): StableDirectory {
  return { device: value.device, inode: value.inode, mode: value.mode, uid: value.uid, type: value.type };
}
function namesHash(names: readonly string[]): string {
  return digest(JSON.stringify([...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))));
}
interface Slot { readonly path: string; readonly key: string; readonly names: readonly string[]; readonly identity: Identity; readonly weight: number }

/** Resource-only discovery. Later scans remain fresh authority, never replay a discovery census. */
class CleanupScans implements FileMemoryDirectoryScanner {
  #used = 0;
  #limit = 8192;
  #reserved = false;
  readonly #slots = new Map<string, Slot>();
  readonly #paths = new Map<string, string>();
  readonly #virtual = new Map<string, number>();
  verify?: (named: string, names: readonly string[], value: Identity) => void;
  get consumed(): number { return this.#used; }
  get limit(): number { return this.#limit; }
  async scan(directoryPath: string, inspect: (name: string) => void): Promise<void> {
    const named = path.resolve(directoryPath);
    const before = identity(await fs.lstat(named, { bigint: true }), true, false);
    const key = `${before.device}:${before.inode}`;
    const originalKey = this.#paths.get(named);
    if (originalKey && originalKey !== key) throw failure('Cleanup resource namespace was replaced');
    const original = this.#slots.get(key);
    const maximum = this.#reserved ? original?.weight ?? this.#virtual.get(named) : 4096;
    if (!maximum) throw new FileMemoryDirectoryScanLimitError();
    const { names, attempts } = await this.readCensus(named, maximum, inspect);
    const after = identity(await fs.lstat(named, { bigint: true }), true, false);
    if (!isDeepStrictEqual(before, after)) throw failure('Cleanup directory changed during census');
    this.verify?.(named, names, after);
    if (!this.#reserved) {
      if (original && (!isDeepStrictEqual(original.identity, before) || namesHash(original.names) !== namesHash(names))) {
        throw failure('Cleanup discovery changed between physical roles');
      }
      if (!original) this.#slots.set(key, { path: named, key, names, identity: before, weight: attempts });
      this.#paths.set(named, key);
    }
  }
  private async readCensus(named: string, maximum: number, inspect: (name: string) => void): Promise<{ names: string[]; attempts: number }> {
    const directory = await fs.opendir(named);
    const names: string[] = [];
    let attempts = 0;
    let primary: { cause: unknown } | undefined;
    try {
      // Entry, EOF and error each debit synchronously, with no refund or free overflow read.
      while (true) {
        if (attempts >= maximum || this.#used >= this.#limit) throw new FileMemoryDirectoryScanLimitError();
        attempts++; this.#used++;
        const entry = await directory.read();
        if (!entry) break;
        names.push(entry.name); inspect(entry.name);
      }
    } catch (cause) { primary = { cause }; }
    await closeMemoryDirectoryInspection(directory, primary, 'Cleanup directory inspection and close failed');
    return { names, attempts };
  }
  bindRole(named: string, value: Identity): void {
    const key = `${value.device}:${value.inode}`;
    const slot = this.#slots.get(key);
    if (!slot || !isDeepStrictEqual(slot.identity, value)) throw failure('Cleanup discovery role changed');
    this.#paths.set(path.resolve(named), key);
  }
  weight(named: string): number {
    const key = this.#paths.get(path.resolve(named));
    const slot = key && this.#slots.get(key);
    if (slot) return slot.weight;
    const value = this.#virtual.get(path.resolve(named));
    if (!value) throw new FileMemoryDirectoryScanLimitError();
    return value;
  }
  reserve(paths: Record<Role, string>, intentName: string, fresh: boolean, remainingActions: number): void {
    if (this.#reserved) throw new FileMemoryDirectoryScanLimitError();
    const ownerKey = this.#paths.get(paths.O);
    const owner = ownerKey && this.#slots.get(ownerKey);
    if (!owner) throw failure('Cleanup owner namespace is absent');
    if (!owner.names.includes(intentName)) this.#slots.set(owner.key, { ...owner, weight: owner.weight + 1 });
    // Missing residual roles are projected, never new discovery authority or mutation permission.
    for (const [role, weight] of [['S', 3], ['G', 3], ['K', 1]] as const) {
      if (!this.#paths.has(paths[role])) this.#virtual.set(paths[role], weight);
    }
    const projected = [...this.#slots.values()].reduce((sum, slot) => sum + slot.weight, 0) +
      [...this.#virtual.values()].reduce((sum, weight) => sum + weight, 0);
    if (projected > 4096) throw new FileMemoryDirectoryScanLimitError();
    const w = (role: Role): number => this.weight(paths[role]);
    const C = 12 * w('H') + 6 * w('R') + 2 * (w('T') + w('V') + w('B') + w('O')) + w('S') + w('G') + w('K');
    // Fresh17F; retry(3+2k)F. Full transition sum is conservative for every suffix.
    const proofs = fresh ? 17 : 3 + 2 * remainingActions;
    const allowance = this.#used + proofs * C + 8 * w('O') + 3 * w('B') + 6 * w('S') + 4 * w('G');
    if (!Number.isSafeInteger(allowance) || allowance > 2_109_440) throw new FileMemoryDirectoryScanLimitError();
    this.#limit = allowance; this.#reserved = true;
  }
}

async function readBoundFile(named: string, limit: number, expected?: Identity): Promise<{ bytes: Buffer; identity: Identity }> {
  const handle = await fs.open(named, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let primary: { cause: unknown } | undefined;
  let result: { bytes: Buffer; identity: Identity } | undefined;
  try {
    const before = identity(await handle.stat({ bigint: true }), false);
    if (BigInt(before.size) > BigInt(limit)) throw new FileMemoryDirectoryScanLimitError();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let used = 0;
    while (used < bytes.length) {
      const read = await handle.read(bytes, used, bytes.length - used, used);
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    const after = identity(await handle.stat({ bigint: true }), false);
    const namedIdentity = identity(await fs.lstat(named, { bigint: true }), false);
    if (BigInt(used) !== BigInt(after.size) || !isDeepStrictEqual(before, after) ||
      !isDeepStrictEqual(after, namedIdentity) || (expected && !isDeepStrictEqual(after, expected))) {
      throw failure('Cleanup file identity changed');
    }
    result = { bytes: bytes.subarray(0, used), identity: after };
  } catch (cause) { primary = { cause }; }
  try { await handle.close(); }
  catch (cause) {
    if (!primary) throw cause;
    throw Object.assign(new AggregateError([primary.cause, cause], 'Cleanup file inspection and close failed', { cause: primary.cause }),
      { code: causeCode(primary.cause) });
  }
  if (primary) throw primary.cause;
  return result!;
}

import { SecureYamlParser } from '../security/secureYamlParser.js';
import { MEMORY_CONSTANTS } from '../elements/memories/constants.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import type { FileMemoryOwnerSnapshots, OwnedFileMemoryToken } from './FileMemoryOwnerSnapshots.js';
import type { FileMemoryVolumeReceipt } from './FileMemoryVolumeStore.js';
import type { FileMemoryOperationScope, FileMemoryTransactionCoordinator } from './FileMemoryTransactionCoordinator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const ORDER = ['marker', 'payload', 'metadata', 'generation', 'slot'] as const;
type Action = typeof ORDER[number];
export type ArchiveCleanupPhase = 'partial-intent' | 'before-intent-sync' | 'intent-durable' |
  `before-${Action}` | `after-${Action}` | 'before-retire' | 'after-retire';
/** Exact durable archive target; publication operationId is runtime-only correlation. */
export type FileMemoryArchiveCleanupEvidence = Omit<FileMemoryVolumeReceipt, 'operationId'>;
export interface FileArchiveCleanupResult {
  readonly status: 'removed' | 'absent' | 'refused' | 'unknown';
  readonly reason: 'removed' | 'absent' | 'referenced' | 'mismatch' | 'unsafe' | 'resource' | 'head' | 'query';
  readonly receipt?: FileMemoryArchiveCleanupEvidence;
  readonly cause?: unknown;
}
interface Intent {
  schema: 1; kind: 'ARCHIVE_CLEANUP'; state: 'PREPARED';
  operationId: string; token: OwnedFileMemoryToken; receipt: FileMemoryArchiveCleanupEvidence;
  metadata: { sha256: string; sealedAt: string; firstEntryAt: string | null; lastEntryAt: string | null };
  files: { payload: Identity; metadata: Identity }; marker: Identity;
  namespace: Record<Role, Commitment>;
}
interface CleanupOptions {
  coordinator: FileMemoryTransactionCoordinator; owners: FileMemoryOwnerSnapshots;
  afterCleanup?: (phase: ArchiveCleanupPhase) => void | Promise<void>;
}
function exactKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length ||
    keys.some(key => !Object.hasOwn(value, key))) throw failure('Cleanup record grammar is invalid');
}
function requireScalarIdentity(value: unknown, directory: boolean): asserts value is Identity {
  exactKeys(value, ['device', 'inode', 'mode', 'uid', 'type', 'size', 'mtimeNs', 'ctimeNs', 'nlink']);
  if (value.type !== (directory ? 'directory' : 'file') || Object.entries(value).some(([key, item]) => key !== 'type' &&
    (typeof item !== 'string' || item.length > MAX_NUMERIC_WIDTH || !/^-?\d+$/u.test(item))) ||
    (!directory && value.nlink !== '1')) throw failure('Cleanup identity grammar is invalid');
}
function validateLogicalDates(entry: Record<string, unknown>): void {
  for (const field of ['sealedAt', 'firstEntryAt', 'lastEntryAt']) {
    const value = entry[field];
    if (value === null && field !== 'sealedAt') continue;
    if (!(value instanceof Date) && typeof value !== 'string') throw failure('Cleanup date is invalid');
    if (typeof value === 'string' && /\.\d{3}0*[1-9]/u.test(value)) throw failure('Cleanup date loses precision');
    if (!Number.isFinite(new Date(value).getTime())) throw failure('Cleanup date is invalid');
  }
  validateDateOrder(entry);
}
function validateDateOrder(entry: Record<string, unknown>): void {
  if (entry.firstEntryAt !== null && entry.lastEntryAt !== null &&
    new Date(entry.firstEntryAt as Date | string).getTime() > new Date(entry.lastEntryAt as Date | string).getTime()) {
    throw failure('Cleanup reference timestamps are reversed');
  }
}
function validateLogicalReference(entry: unknown, owner: string, seen: Set<number>): void {
  exactKeys(entry, ['volume', 'file', 'sha256', 'entryCount', 'sealedAt', 'firstEntryAt', 'lastEntryAt']);
  if (!Number.isSafeInteger(entry.volume) || Number(entry.volume) < 1 || seen.has(Number(entry.volume)) ||
    entry.file !== `volumes/${owner}/v${String(entry.volume).padStart(4, '0')}.yaml` ||
    typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256) || !Number.isInteger(entry.entryCount) ||
    Number(entry.entryCount) < 0 || Number(entry.entryCount) > 2_147_483_647) throw failure('Cleanup declaration is invalid');
  validateLogicalDates(entry);
}
function references(content: string, owner: string): number[] {
  if (Buffer.byteLength(content) > 8 * 1024 * 1024 || Buffer.from(content).toString('utf8') !== content) {
    throw new FileMemoryDirectoryScanLimitError();
  }
  const raw = SecureYamlParser.parseRawYaml(content, { maxSize: MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE, contentPolicy: 'structure-only' });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw failure('Cleanup head shape is invalid');
  const nested = raw.metadata;
  if (nested !== undefined && (!nested || typeof nested !== 'object' || Array.isArray(nested) ||
    Object.keys(raw).some(key => !['metadata', 'entries', 'stats', 'instructions', 'extensions'].includes(key)))) {
    throw failure('Cleanup mixed head shape is invalid');
  }
  const source = (nested ?? raw) as Record<string, unknown>;
  if (!Object.hasOwn(source, 'volumes')) return [];
  if (!Array.isArray(source.volumes) || source.volumes.length > 10_000) throw failure('Cleanup references are invalid');
  const seen = new Set<number>();
  for (const entry of source.volumes) {
    validateLogicalReference(entry, owner, seen);
    seen.add(Number(entry.volume));
  }
  return [...seen];
}

function cleanupReason(code: string | undefined): FileArchiveCleanupResult['reason'] {
  if (code === 'EARCHIVEREFERENCED') return 'referenced';
  if (code === 'EARCHIVEMISMATCH') return 'mismatch';
  if (code === 'EHEADRESOURCE') return 'resource';
  if (code?.startsWith('EHEAD') || code?.startsWith('EOWNER')) return 'head';
  return 'unsafe';
}

/** One invocation owns its capture, counter and authority; durable intent is provenance only. */
export class FileMemoryArchiveCleanup {
  readonly #budget = new CleanupScans();
  readonly #paths: Record<Role, string>;
  readonly #intentPath: string;
  readonly #live = new Map<string, Identity>();
  readonly #exclusions = new Map<string, Set<string>>();
  readonly #discovery = new Map<string, readonly string[]>();
  #intent!: Intent;
  #intentFile: { bytes: Buffer; identity: Identity } | undefined;
  #prefix = 0;
  #attempted = false;
  #captured = false;
  #retired = false;
  constructor(readonly options: CleanupOptions, readonly operation: FileMemoryOperationScope,
    readonly expected: OwnedFileMemoryToken, readonly receipt: FileMemoryArchiveCleanupEvidence) {
    const scope = this.active();
    const owner = path.join(scope.tenantRoot, 'volumes', 'by-id', expected.ownerId);
    this.#paths = { T: scope.tenantRoot, H: path.dirname(path.join(scope.tenantRoot, expected.locator)),
      R: path.join(scope.tenantRoot, '.memory-owners', 'owners'), V: path.join(scope.tenantRoot, 'volumes'),
      B: path.join(scope.tenantRoot, 'volumes', 'by-id'), O: owner, S: path.join(owner, `v${receipt.volume}`),
      G: path.join(owner, `v${receipt.volume}`, `g-${receipt.generationId}`), K: path.join(owner, `v${receipt.volume}`, 'COMMITTED') };
    this.#intentPath = path.join(owner, `v${receipt.volume}.cleanup.json`);
    const head = path.join(scope.tenantRoot, expected.locator);
    if ([this.#intentPath, path.join(this.#paths.G, 'payload.yaml'), path.join(this.#paths.G, 'metadata.json')].includes(head)) {
      throw failure('Cleanup selected archive object is also the authoritative head');
    }
  }
  private active() { return this.options.coordinator.requireActiveOperationScope(this.operation); }
  private result(status: FileArchiveCleanupResult['status'], reason: FileArchiveCleanupResult['reason'], cause?: unknown): FileArchiveCleanupResult {
    const value = { status, reason, ...(this.#captured ? { receipt: this.receipt } : {}) };
    if (arguments.length === 3) Object.defineProperty(value, 'cause', { value: cause, enumerable: false });
    return Object.freeze(value);
  }
  private async census(named: string): Promise<string[]> {
    const names: string[] = [];
    await this.#budget.scan(named, name => { names.push(name); });
    return names;
  }
  private selected(role: Role, prefix = this.#prefix): string[] {
    const names: string[] = [];
    if (role === 'O') return this.ownerSelected(prefix);
    if (role === 'S') {
      if (prefix < 4) names.push(`g-${this.receipt.generationId}`);
      if (prefix < 1) names.push('COMMITTED');
    }
    if (role === 'G') {
      if (prefix < 2) names.push('payload.yaml');
      if (prefix < 3) names.push('metadata.json');
    }
    return names;
  }
  private ownerSelected(prefix: number): string[] {
    const names: string[] = [];
    if (prefix < 5) names.push(`v${this.receipt.volume}`);
    if (!this.#retired && this.#intentFile) names.push(path.basename(this.#intentPath));
    return names;
  }
  private exclusionNames(role: Role): string[] {
    if (role === 'O') return [`v${this.receipt.volume}`, path.basename(this.#intentPath)];
    if (role === 'S') return [`g-${this.receipt.generationId}`, 'COMMITTED'];
    if (role === 'G') return ['payload.yaml', 'metadata.json'];
    return [];
  }
  private ancestorChild(role: Role): string | undefined {
    if (role === 'T') return 'volumes';
    if (role === 'V') return 'by-id';
    if (role === 'B') return this.expected.ownerId;
    return undefined;
  }
  private async initializeNames(): Promise<void> {
    const groups = new Map<string, Set<string>>();
    const captured = new Map<string, readonly string[]>();
    for (const role of ROLES) {
      let stat: BigIntStats;
      try { stat = await fs.lstat(this.#paths[role], { bigint: true }); }
      catch (cause) {
        if (['S', 'G', 'K'].includes(role) && causeCode(cause) === 'ENOENT') continue;
        throw cause;
      }
      const value = identity(stat, true, role !== 'T' && role !== 'H');
      const key = `${value.device}:${value.inode}`;
      const names = captured.get(key) ?? await this.census(this.#paths[role]);
      captured.set(key, names);
      this.#budget.bindRole(this.#paths[role], value);
      const selected = groups.get(key) ?? new Set<string>();
      const candidates = this.exclusionNames(role);
      candidates.forEach(name => selected.add(name)); groups.set(key, selected);
      this.#exclusions.set(this.#paths[role], selected);
      this.#discovery.set(this.#paths[role], names);
      this.#live.set(this.#paths[role], value);
      this.requireSafeSpelling(role, names);
    }
  }
  private requireSafeSpelling(role: Role, names: readonly string[]): void {
    const child = this.ancestorChild(role);
    if (child && (!names.includes(child) || names.some(name => name.toLowerCase() === child.toLowerCase() && name !== child))) {
      throw failure('Cleanup ancestor spelling is unsafe');
    }
    if (role === 'O' && names.some(name => {
      const match = /^v(\d+)(?:\.cleanup(?:\.|$))?/iu.exec(name);
      return match && BigInt(match[1]) === BigInt(this.receipt.volume) &&
        name !== `v${this.receipt.volume}` && name !== path.basename(this.#intentPath);
    })) throw failure('Cleanup target number or intent has ambiguous residue');
    if (names.some(name => name.toLowerCase() === path.basename(this.#intentPath).toLowerCase() && name !== path.basename(this.#intentPath))) {
      throw failure('Cleanup intent spelling alias is unsafe');
    }
  }
  private async present(named: string): Promise<boolean> {
    try { await fs.lstat(named); return true; }
    catch (cause) {
      if (causeCode(cause) === 'ENOENT') return false;
      throw cause;
    }
  }
  private async detectPrefix(): Promise<number> {
    const objects = [this.#paths.K, path.join(this.#paths.G, 'payload.yaml'), path.join(this.#paths.G, 'metadata.json'), this.#paths.G, this.#paths.S];
    let prefix = 0;
    for (const named of objects) {
      if (await this.present(named)) break;
      prefix++;
    }
    for (let i = prefix; i < objects.length; i++) {
      if (!(await this.present(objects[i]))) throw failure('Cleanup residuals are not an ordered prefix');
    }
    return prefix;
  }
  private namespaceCommitments(): Record<Role, Commitment> {
    const result = {} as Record<Role, Commitment>;
    for (const role of ROLES) {
      const value = this.#live.get(this.#paths[role]);
      if (!value) throw failure('Fresh committed archive namespace is incomplete');
      const names = this.#discovery.get(this.#paths[role])!;
      const foreign = names.filter(name => !this.#exclusions.get(this.#paths[role])?.has(name));
      if (['S', 'G', 'K'].includes(role) && foreign.length) throw failure('Fresh archive contains unexpected children');
      result[role] = { identity: stable(value), count: foreign.length, sha256: namesHash(foreign) };
    }
    return result;
  }
  private async bindFresh(): Promise<void> {
    const payload = await readBoundFile(path.join(this.#paths.G, 'payload.yaml'), 3 * MEMORY_CONSTANTS.MAX_YAML_SIZE);
    const metadata = await readBoundFile(path.join(this.#paths.G, 'metadata.json'), 4096);
    for (const [actual, expected] of [[payload.identity, this.receipt.payloadIdentity], [metadata.identity, this.receipt.metadataIdentity]] as const) {
      if (Object.entries(expected).some(([key, value]) => actual[key as keyof Identity] !== value)) throw Object.assign(failure('Cleanup receipt file disagrees'), { code: 'EARCHIVEMISMATCH' });
    }
    if (payload.bytes.length !== this.receipt.byteLength) {
      throw Object.assign(failure('Cleanup receipt payload length disagrees'), { code: 'EARCHIVEMISMATCH' });
    }
    const declaration = JSON.parse(metadata.bytes.toString('utf8')) as Record<string, unknown>;
    exactKeys(declaration, ['schema', 'userId', 'ownerId', 'volume', 'generationId', 'sha256', 'byteLength', 'entryCount', 'firstEntryAt', 'lastEntryAt', 'sealedAt']);
    if (declaration.schema !== 1 || declaration.userId !== this.expected.userId || declaration.ownerId !== this.expected.ownerId ||
      declaration.volume !== this.receipt.volume || declaration.generationId !== this.receipt.generationId ||
      declaration.sha256 !== this.receipt.sha256 || declaration.byteLength !== payload.bytes.length ||
      declaration.entryCount !== this.receipt.entryCount || digest(payload.bytes) !== this.receipt.sha256) throw failure('Cleanup archive declaration disagrees');
    const parsed = SecureYamlParser.parseRawYaml(payload.bytes.toString('utf8'), { maxSize: MEMORY_CONSTANTS.MAX_YAML_SIZE, schema: 'core', contentPolicy: 'structure-only' });
    if (!Array.isArray(parsed.entries) || parsed.entries.length !== this.receipt.entryCount ||
      !payload.bytes.equals(Buffer.from(payload.bytes.toString('utf8')))) throw failure('Cleanup payload disagrees');
    const date = (value: unknown, nullable: boolean): string | null => {
      if (value === null && nullable) return null;
      if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw failure('Cleanup metadata dates disagree');
      return value;
    };
    this.#intent = { schema: 1, kind: 'ARCHIVE_CLEANUP', state: 'PREPARED', operationId: randomUUID(), token: this.expected,
      receipt: this.receipt, metadata: { sha256: digest(metadata.bytes), sealedAt: date(declaration.sealedAt, false)!,
        firstEntryAt: date(declaration.firstEntryAt, true), lastEntryAt: date(declaration.lastEntryAt, true) },
      files: { payload: payload.identity, metadata: metadata.identity }, marker: this.#live.get(this.#paths.K)!, namespace: this.namespaceCommitments() };
    validateDateOrder(this.#intent.metadata);
    for (const [role, expected] of [['S', this.receipt.volumeIdentity], ['G', this.receipt.generationIdentity]] as const) {
      const value = this.#live.get(this.#paths[role])!;
      if (value.device !== expected.device || value.inode !== expected.inode) throw Object.assign(failure('Cleanup receipt directory disagrees'), { code: 'EARCHIVEMISMATCH' });
    }
  }
  private parseIntent(bytes: Buffer): Intent {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    exactKeys(parsed, ['schema', 'kind', 'state', 'operationId', 'token', 'receipt', 'metadata', 'files', 'marker', 'namespace']);
    if (parsed.schema !== 1 || parsed.kind !== 'ARCHIVE_CLEANUP' || parsed.state !== 'PREPARED' ||
      typeof parsed.operationId !== 'string' || !UUID.test(parsed.operationId)) throw failure('Cleanup intent binding is invalid');
    const record = parsed as unknown as Intent;
    exactKeys(record.token, ['backend', 'ownership', 'userId', 'tenantRoot', 'locator', 'ownerId', 'revision', 'contentHash', 'fileIdentity']);
    exactKeys(record.token.fileIdentity, ['device', 'inode', 'size', 'mtimeNs', 'ctimeNs']);
    captureArchiveCleanupRequest(record.token, record.receipt);
    if (!isDeepStrictEqual(record.receipt, this.receipt) || record.token.ownerId !== this.expected.ownerId ||
      record.token.userId !== this.expected.userId || record.token.tenantRoot !== this.expected.tenantRoot ||
      record.token.locator !== this.expected.locator) throw Object.assign(failure('Cleanup intent belongs to different archive'), { code: 'EARCHIVEMISMATCH' });
    exactKeys(record.files, ['payload', 'metadata']);
    requireScalarIdentity(record.files.payload, false); requireScalarIdentity(record.files.metadata, false);
    requireScalarIdentity(record.marker, true);
    if (record.files.payload.size !== String(this.receipt.byteLength)) {
      throw Object.assign(failure('Cleanup intent payload length contradicts receipt'), { code: 'EARCHIVEMISMATCH' });
    }
    for (const [actual, bound] of [[record.files.payload, this.receipt.payloadIdentity], [record.files.metadata, this.receipt.metadataIdentity]] as const) {
      if (Object.entries(bound).some(([key, value]) => actual[key as keyof Identity] !== value)) {
        throw Object.assign(failure('Cleanup intent file contradicts receipt'), { code: 'EARCHIVEMISMATCH' });
      }
    }
    this.validateNamespace(record);
    for (const [role, bound] of [['S', this.receipt.volumeIdentity], ['G', this.receipt.generationIdentity]] as const) {
      const actual = record.namespace[role].identity;
      if (actual.device !== bound.device || actual.inode !== bound.inode) {
        throw Object.assign(failure('Cleanup intent directory contradicts receipt'), { code: 'EARCHIVEMISMATCH' });
      }
    }
    if (!isDeepStrictEqual(stable(record.marker), record.namespace.K.identity)) throw failure('Cleanup marker commitment disagrees');
    this.validateIntentMetadata(record);
    return record;
  }
  private validateNamespace(record: Intent): void {
    exactKeys(record.namespace, ROLES);
    for (const role of ROLES) {
      const item = record.namespace[role];
      exactKeys(item, ['identity', 'count', 'sha256']);
      exactKeys(item.identity, ['device', 'inode', 'mode', 'uid', 'type']);
      if (item.identity.type !== 'directory' || Object.entries(item.identity).some(([key, value]) => key !== 'type' &&
        (typeof value !== 'string' || value.length > MAX_NUMERIC_WIDTH || !/^\d+$/u.test(value))) ||
        !Number.isSafeInteger(item.count) || item.count < 0 || item.count > 4095 || !HASH.test(item.sha256)) throw failure('Cleanup namespace commitment is invalid');
    }
  }
  private validateIntentMetadata(record: Intent): void {
    exactKeys(record.metadata, ['sha256', 'sealedAt', 'firstEntryAt', 'lastEntryAt']);
    for (const field of ['sealedAt', 'firstEntryAt', 'lastEntryAt'] as const) {
      const value = record.metadata[field];
      if (value === null && field !== 'sealedAt') continue;
      if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
        throw failure('Cleanup persisted date is not canonical');
      }
    }
    validateDateOrder(record.metadata);
    if (typeof record.metadata.sha256 !== 'string' || !HASH.test(record.metadata.sha256)) throw failure('Cleanup metadata commitment is invalid');
  }
  private async ownerProof(): Promise<void> {
    // Observe H/R only during the actual owner scans, not during attributable own transitions.
    this.#budget.verify = this.#intent ? (named, names, value) => {
      for (const role of ['H', 'R'] as const) if (named === this.#paths[role]) this.checkCensus(role, names, value);
    } : undefined;
    try {
      const snapshot = await this.options.owners.snapshotOwnedAtScope(this.operation, this.expected, this.#budget);
      if (references(snapshot.content, this.expected.ownerId).includes(this.receipt.volume)) {
        throw Object.assign(failure('Cleanup target is referenced'), { code: 'EARCHIVEREFERENCED' });
      }
      this.active();
    } finally { this.#budget.verify = undefined; }
  }
  private checkCensus(role: Role, names: readonly string[], value: Identity): void {
    const prior = this.#live.get(this.#paths[role]);
    const commitment = this.#intent.namespace[role];
    if (!isDeepStrictEqual(stable(value), commitment.identity) || (prior && !isDeepStrictEqual(prior, value))) {
      throw failure('Cleanup directory identity changed');
    }
    const exclusions = this.#exclusions.get(this.#paths[role]) ?? new Set<string>();
    const foreign = names.filter(name => !exclusions.has(name));
    const selected = ROLES.filter(candidate => this.#paths[candidate] === this.#paths[role]).flatMap(candidate => this.selected(candidate));
    if (foreign.length !== commitment.count || namesHash(foreign) !== commitment.sha256 ||
      namesHash(names.filter(name => exclusions.has(name))) !== namesHash([...new Set(selected)])) {
      throw failure('Cleanup namespace contents changed');
    }
    this.#live.set(this.#paths[role], value);
  }
  private roleAbsent(role: Role): boolean {
    if (role === 'K') return this.#prefix >= 1;
    if (role === 'G') return this.#prefix >= 4;
    if (role === 'S') return this.#prefix >= 5;
    return false;
  }
  private async proveRole(role: Role): Promise<void> {
    const absent = this.roleAbsent(role);
    if (absent) {
      if (await this.present(this.#paths[role])) throw failure('Cleanup removed directory reappeared');
      return;
    }
    const value = identity(await fs.lstat(this.#paths[role], { bigint: true }), true, role !== 'T');
    if (role === 'K' && !isDeepStrictEqual(value, this.#intent.marker)) throw failure('Cleanup marker identity changed');
    this.checkCensus(role, await this.census(this.#paths[role]), value);
  }
  private async prove(): Promise<void> {
    await this.ownerProof();
    for (const role of ['T', 'V', 'B', 'O', 'S', 'G', 'K', 'T', 'V', 'B', 'O'] as const) {
      await this.proveRole(role);
    }
    if (this.#prefix < 2) {
      const payload = await readBoundFile(path.join(this.#paths.G, 'payload.yaml'), 3 * MEMORY_CONSTANTS.MAX_YAML_SIZE, this.#intent.files.payload);
      if (digest(payload.bytes) !== this.receipt.sha256) throw failure('Cleanup payload changed');
    }
    if (this.#prefix < 3) {
      const metadata = await readBoundFile(path.join(this.#paths.G, 'metadata.json'), 4096, this.#intent.files.metadata);
      if (digest(metadata.bytes) !== this.#intent.metadata.sha256) throw failure('Cleanup metadata changed');
    }
    if (this.#intentFile && !this.#retired) {
      const intent = await readBoundFile(this.#intentPath, MAX_INTENT, this.#intentFile.identity);
      if (!intent.bytes.equals(this.#intentFile.bytes)) throw failure('Cleanup intent changed');
    }
    await this.ownerProof();
  }
  private async barrier(phase: ArchiveCleanupPhase): Promise<void> {
    if (this.options.afterCleanup) { await this.options.afterCleanup(phase); await this.prove(); }
  }
  private async syncDirectory(named: string): Promise<void> {
    const expected = this.#live.get(named)!;
    const handle = await fs.open(named, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let primary: { cause: unknown } | undefined;
    try {
      const descriptor = identity(await handle.stat({ bigint: true }), true);
      const namedIdentity = identity(await fs.lstat(named, { bigint: true }), true);
      if (!isDeepStrictEqual(expected, descriptor) || !isDeepStrictEqual(descriptor, namedIdentity)) throw failure('Cleanup sync directory changed');
      this.active(); await handle.sync();
      if (!isDeepStrictEqual(identity(await handle.stat({ bigint: true }), true), descriptor) ||
        !isDeepStrictEqual(identity(await fs.lstat(named, { bigint: true }), true), descriptor)) throw failure('Cleanup directory changed during sync');
    } catch (cause) { primary = { cause }; }
    try { await handle.close(); }
    catch (cause) {
      if (!primary) throw cause;
      throw new AggregateError([primary.cause, cause], 'Cleanup directory sync and close failed', { cause: primary.cause });
    }
    if (primary) throw primary.cause;
  }
  private async transition(named: string, child: string, adding: boolean, action: () => Promise<unknown>): Promise<void> {
    const before = await this.census(named);
    const prior = this.#live.get(named)!;
    if (!isDeepStrictEqual(identity(await fs.lstat(named, { bigint: true }), true), prior)) throw failure('Cleanup transition parent changed');
    if (before.includes(child) === adding) throw failure('Cleanup selected transition presence disagrees');
    this.active(); this.#attempted = true; await action();
    const after = await this.census(named);
    const expected = adding ? [...before, child] : before.filter(name => name !== child);
    if (namesHash(after) !== namesHash(expected)) throw failure('Cleanup transition changed foreign names');
    const value = identity(await fs.lstat(named, { bigint: true }), true);
    if (!isDeepStrictEqual(stable(value), stable(prior))) throw failure('Cleanup transition replaced its parent');
    this.#live.set(named, value);
    const ancestor = path.dirname(named);
    await this.census(ancestor);
    if (this.#live.has(ancestor) && !isDeepStrictEqual(identity(await fs.lstat(ancestor, { bigint: true }), true, ancestor !== this.#paths.T && ancestor !== this.#paths.H), this.#live.get(ancestor))) {
      throw failure('Cleanup transition ancestor changed');
    }
  }
  private async writeIntentPart(handle: Awaited<ReturnType<typeof fs.open>>, bytes: Buffer, offset: number, end: number, partial: boolean): Promise<void> {
    let used = offset;
    while (used < end) {
      this.active(); const value = await handle.write(bytes, used, end - used, used);
      if (!value.bytesWritten) throw failure('Cleanup intent writer made no progress');
      used += value.bytesWritten;
    }
    const captured = identity(await handle.stat({ bigint: true }), false);
    const named = identity(await fs.lstat(this.#intentPath, { bigint: true }), false);
    if (!isDeepStrictEqual(captured, named) || captured.size !== String(end)) throw failure('Cleanup intent writer identity changed');
    this.#intentFile = { bytes: bytes.subarray(0, end), identity: captured };
    if (partial) {
      if (this.options.afterCleanup) await this.options.afterCleanup('partial-intent');
      await this.prove();
    }
  }
  private async publishIntent(): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(this.#intent));
    if (bytes.length > MAX_INTENT) throw new FileMemoryDirectoryScanLimitError();
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let primary: { cause: unknown } | undefined;
    try {
      await this.transition(this.#paths.O, path.basename(this.#intentPath), true, async () => {
        this.active(); handle = await fs.open(this.#intentPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      });
      const split = Math.max(1, Math.floor(bytes.length / 2));
      for (const [offset, end] of [[0, split], [split, bytes.length]]) {
        await this.writeIntentPart(handle!, bytes, offset, end, end === split);
      }
      this.active(); await handle!.sync();
      this.#intentFile = { bytes, identity: identity(await handle!.stat({ bigint: true }), false) };
    } catch (cause) { primary = { cause }; }
    try { if (handle) await handle.close(); }
    catch (cause) {
      if (!primary) throw cause;
      throw new AggregateError([primary.cause, cause], 'Cleanup intent write and close failed', { cause: primary.cause });
    }
    if (primary) throw primary.cause;
    await this.prove(); if (this.options.afterCleanup) await this.barrier('before-intent-sync');
    await this.syncDirectory(this.#paths.O);
    if (this.options.afterCleanup) await this.options.afterCleanup('intent-durable');
    await this.prove();
  }
  private async observeAbsence(): Promise<FileArchiveCleanupResult> {
    await this.ownerProof();
    for (const role of ['T', 'V', 'B', 'O'] as const) {
      const before = this.#live.get(this.#paths[role])!;
      const names = await this.census(this.#paths[role]);
      if (!isDeepStrictEqual(identity(await fs.lstat(this.#paths[role], { bigint: true }), true, role !== 'T'), before) ||
        (role === 'O' && names.includes(`v${this.receipt.volume}`))) throw failure('Cleanup absence changed');
    }
    await this.ownerProof(); this.active(); return this.result('absent', 'absent');
  }
  private async removeSelectedArtifacts(): Promise<void> {
    const objects = [this.#paths.K, path.join(this.#paths.G, 'payload.yaml'), path.join(this.#paths.G, 'metadata.json'), this.#paths.G, this.#paths.S];
    while (this.#prefix < 5) {
      const action = ORDER[this.#prefix];
      if (this.options.afterCleanup) await this.barrier(`before-${action}`);
      const named = objects[this.#prefix]; const parent = path.dirname(named);
      await this.transition(parent, path.basename(named), false, () => action === 'payload' || action === 'metadata' ? fs.unlink(named) : fs.rmdir(named));
      this.#prefix++;
      await this.syncDirectory(parent);
      // This exact current invocation reaches the chosen durable boundary before later checks/hooks.
      if (action === 'slot') this.#captured = true;
      if (this.options.afterCleanup) await this.options.afterCleanup(`after-${action}`);
      await this.prove();
    }
  }
  private async retireIntent(): Promise<void> {
    if (this.options.afterCleanup) await this.barrier('before-retire');
    await this.transition(this.#paths.O, path.basename(this.#intentPath), false, () => fs.unlink(this.#intentPath));
    this.#retired = true;
    await this.syncDirectory(this.#paths.O);
    if (this.options.afterCleanup) await this.options.afterCleanup('after-retire');
    if (this.#captured) SecurityMonitor.logSecurityEvent({ type: 'DANGER_ZONE_OPERATION', severity: 'LOW', source: 'FileMemoryArchiveCleanup', details: 'Exact unreferenced archive removal known durable' });
    await this.prove(); this.active();
  }
  async run(): Promise<FileArchiveCleanupResult> {
    try {
      await this.initializeNames();
      if (await this.present(this.#intentPath)) {
        this.#intentFile = await readBoundFile(this.#intentPath, MAX_INTENT);
        this.#intent = this.parseIntent(this.#intentFile.bytes);
        this.#prefix = await this.detectPrefix();
      }
      this.#budget.reserve(this.#paths, path.basename(this.#intentPath), !this.#intentFile, 5 - this.#prefix);
      if (!this.#intentFile && !(await this.present(this.#paths.S))) {
        return await this.observeAbsence();
      }
      if (!this.#intentFile) await this.bindFresh();
      await this.prove();
      if (!this.#intentFile) await this.publishIntent();
      await this.removeSelectedArtifacts();
      await this.retireIntent();
      return this.result(this.#captured ? 'removed' : 'absent', this.#captured ? 'removed' : 'absent');
    } catch (cause) {
      if (this.#captured) return this.result('removed', 'removed', cause);
      const code = causeCode(cause);
      return this.result(this.#attempted ? 'unknown' : 'refused', cleanupReason(code), cause);
    }
  }
}

/** Exact primitive capture precedes tenant acquisition; caller outcome markers never become results. */
export function captureArchiveCleanupRequest(expected: OwnedFileMemoryToken, receipt: FileMemoryArchiveCleanupEvidence): {
  token: OwnedFileMemoryToken; receipt: FileMemoryArchiveCleanupEvidence;
} {
  const token = { backend: expected.backend, ownership: expected.ownership, userId: expected.userId,
    tenantRoot: expected.tenantRoot, locator: expected.locator, ownerId: expected.ownerId, revision: expected.revision,
    contentHash: expected.contentHash, fileIdentity: { device: expected.fileIdentity.device, inode: expected.fileIdentity.inode,
      size: expected.fileIdentity.size, mtimeNs: expected.fileIdentity.mtimeNs, ctimeNs: expected.fileIdentity.ctimeNs } };
  if (token.backend !== 'file' || token.ownership !== 'owned' || typeof token.userId !== 'string' ||
    typeof token.tenantRoot !== 'string' || !path.isAbsolute(token.tenantRoot) || typeof token.locator !== 'string' ||
    path.isAbsolute(token.locator) || token.locator.split(/[\\/]/u).some(part => !part || part === '.' || part === '..') ||
    typeof token.ownerId !== 'string' || !UUID.test(token.ownerId) || typeof token.contentHash !== 'string' || !HASH.test(token.contentHash) ||
    typeof token.revision !== 'string' || !/^[1-9]\d{0,18}$/u.test(token.revision) || BigInt(token.revision) > 9_223_372_036_854_775_807n) {
    throw failure('Cleanup requires exact owned head evidence');
  }
  const copyDirectory = (value: { device: string; inode: string }) => ({ device: value.device, inode: value.inode });
  const copyFile = (value: FileMemoryVolumeReceipt['payloadIdentity']) => ({ ...copyDirectory(value), size: value.size, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs });
  const captured = { schema: receipt.schema, tenantRoot: receipt.tenantRoot, userId: receipt.userId, ownerId: receipt.ownerId,
    volume: receipt.volume, generationId: receipt.generationId, sha256: receipt.sha256,
    byteLength: receipt.byteLength, entryCount: receipt.entryCount, volumeIdentity: copyDirectory(receipt.volumeIdentity),
    generationIdentity: copyDirectory(receipt.generationIdentity), payloadIdentity: copyFile(receipt.payloadIdentity), metadataIdentity: copyFile(receipt.metadataIdentity) };
  const values = [token.fileIdentity, captured.volumeIdentity, captured.generationIdentity, captured.payloadIdentity, captured.metadataIdentity];
  if (captured.schema !== 1 || captured.tenantRoot !== token.tenantRoot || captured.userId !== token.userId || captured.ownerId !== token.ownerId ||
    !Number.isSafeInteger(captured.volume) || captured.volume < 1 || typeof captured.generationId !== 'string' || !UUID.test(captured.generationId) ||
    typeof captured.sha256 !== 'string' || !HASH.test(captured.sha256) ||
    !Number.isSafeInteger(captured.byteLength) || captured.byteLength < 0 || captured.byteLength > 3 * MEMORY_CONSTANTS.MAX_YAML_SIZE ||
    !Number.isInteger(captured.entryCount) || captured.entryCount < 0 || captured.entryCount > 2_147_483_647 ||
    values.some(value => Object.entries(value).some(([key, field]) => typeof field !== 'string' || field.length > MAX_NUMERIC_WIDTH ||
      !(key === 'mtimeNs' || key === 'ctimeNs' ? /^-?\d+$/u : /^\d+$/u).test(field)))) throw failure('Cleanup receipt is invalid');
  values.forEach(Object.freeze);
  return { token: Object.freeze(token), receipt: Object.freeze(captured) };
}
