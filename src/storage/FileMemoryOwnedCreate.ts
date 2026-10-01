/** Dormant exclusive CREATE; unsupported/ambiguous residue is never cleaned up. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FileMemoryCreateScanBudget } from './FileMemoryCreateScanBudget.js';
import type { FileMemoryOperationScope } from './FileMemoryTransactionCoordinator.js';
import type { OwnedFileMemoryToken } from './FileMemoryOwnerSnapshots.js';
import { SecurityMonitor } from '../security/securityMonitor.js';

export interface CreateOwnedRequest { readonly operationId: string; readonly locator: string; readonly content: string }
export type CreatePublication = 'before-content' | 'partial-content' | 'prepared' | 'before-link' |
  'linked-before-intent' | 'linked' | 'unlinked-stage-before-intent' | 'published' |
  'active-registry' | 'active-sidecar' | 'intent-unlinked' | 'committed' | 'after-read' |
  'partial-linked-intent' | 'partial-published-intent';
type Identity = OwnedFileMemoryToken['fileIdentity'];
interface Child { name: string; identity: Identity; mode: string; uid: string; links: string; directory: boolean }
interface StableDirectory { locator: string; device: string; inode: string; mode: string; uid: string; names: string[]; children: Child[] }
interface Directory extends StableDirectory { identity: Identity; directoryLinks: string }
interface DirectoryCommitment {
  locator: string; device: string; inode: string; mode: string; uid: string;
  baselineChildCount: number; commitmentVersion: 1; sha256: string;
}
interface Artifact { raw: string; identity: Identity; links: '1' | '2' }
type State = 'PREPARED_CREATE' | 'LINKED_CREATE' | 'PUBLISHED_CREATE';
interface Intent {
  schema: 3 | 5; state: State; userId: string; ownerId: string; locator: string; operationId: string;
  revision: '1'; contentHash: string; contentBytes: number; stageName: string;
  initialStageIdentity: Identity; namespace: (StableDirectory | DirectoryCommitment)[];
  currentStageIdentity?: Identity; currentStageNlink?: '1' | '2';
  currentHeadIdentity?: Identity; currentHeadNlink?: '1' | '2';
  priorIntent?: { state: 'PREPARED_CREATE' | 'LINKED_CREATE'; hash: string; identity: Identity };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const LIMIT = 8192;
const MAX_NUMBER = '9'.repeat(32);
function scalar(value: bigint | number): string {
  const result = String(value);
  if (result.length > 32) fail('EHEADRESOURCE');
  return result;
}
function ordinal(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
const digest = (raw: string) => createHash('sha256').update(raw).digest('hex');
function stableChild(child: Child): Child {
  // Directory timestamps cannot be persisted across our journal's own rename.
  return child.directory ? { ...child, links: '0', identity: { ...child.identity, size: '0', mtimeNs: '0', ctimeNs: '0' } } : child;
}
function identity(stat: BigIntStats): Identity {
  return { device: scalar(stat.dev), inode: scalar(stat.ino), size: scalar(stat.size),
    mtimeNs: scalar(stat.mtimeNs), ctimeNs: scalar(stat.ctimeNs) };
}
/** Complete canonical baseline commitment; never a replacement for fresh live proof. */
export function commitCreateDirectory(directory: StableDirectory): DirectoryCommitment {
  validateNamespace(directory);
  const children = directory.children.map(stableChild).map(child => [child.name, child.directory,
    child.identity.device, child.identity.inode, child.identity.size, child.identity.mtimeNs, child.identity.ctimeNs,
    child.mode, child.uid, child.links]);
  return { locator: directory.locator, device: directory.device, inode: directory.inode, mode: directory.mode, uid: directory.uid,
    baselineChildCount: children.length, commitmentVersion: 1,
    sha256: digest(JSON.stringify(['dollhouse-create-namespace-directory-v1', directory.locator,
      directory.device, directory.inode, directory.mode, directory.uid, children])) };
}
function validateCommitment(directory: DirectoryCommitment): void {
  if (!directory || !exactKeys(directory, ['locator', 'device', 'inode', 'mode', 'uid', 'baselineChildCount', 'commitmentVersion', 'sha256']) ||
    typeof directory.locator !== 'string' || !['device', 'inode', 'mode', 'uid'].every(key => {
      const value = directory[key as keyof DirectoryCommitment];
      return typeof value === 'string' && value.length <= 32 && /^(?:0|[1-9]\d*)$/u.test(value);
    }) || directory.commitmentVersion !== 1 || !Number.isSafeInteger(directory.baselineChildCount) ||
    directory.baselineChildCount < 0 || directory.baselineChildCount > 4095 || typeof directory.sha256 !== 'string' || !HASH.test(directory.sha256)) fail();
}
function fail(code = 'EOWNERRECOVERY'): never {
  throw Object.assign(new Error('Exclusive memory creation evidence is unsafe or changed'), { code });
}
function exactKeys(value: object, keys: string[]): boolean {
  const actual = Reflect.ownKeys(value), expected = new Set(keys);
  return actual.length === expected.size && actual.every(key => typeof key === 'string' && expected.has(key));
}
function validIdentity(value: unknown): value is Identity {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !exactKeys(value, ['device', 'inode', 'size', 'mtimeNs', 'ctimeNs'])) return false;
  const fields = value as Identity;
  return ['device', 'inode', 'size'].every(key => typeof fields[key as keyof Identity] === 'string' && fields[key as keyof Identity].length <= 32 &&
    /^(?:0|[1-9]\d*)$/u.test(fields[key as keyof Identity])) &&
    ['mtimeNs', 'ctimeNs'].every(key => typeof fields[key as keyof Identity] === 'string' && fields[key as keyof Identity].length <= 32 &&
      /^(?:0|-?[1-9]\d*)$/u.test(fields[key as keyof Identity]));
}
// Only live, proved link/unlink transitions advance ctime; persisted phase identities remain exact.
function sameOriginal(a: Identity, b: Identity): boolean {
  return a.device === b.device && a.inode === b.inode && a.size === b.size && a.mtimeNs === b.mtimeNs;
}
export function captureCreateRequest(input: CreateOwnedRequest): CreateOwnedRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    !exactKeys(input, ['operationId', 'locator', 'content'])) throw new TypeError('CREATE requires exactly operationId, locator and content');
  const { operationId, locator, content } = input;
  if (typeof operationId !== 'string' || !UUID.test(operationId) || typeof locator !== 'string' ||
    !locator || Buffer.byteLength(locator) > 1024 || Buffer.from(locator).toString('utf8') !== locator ||
    ['.memory-owners', '.memory-fences'].includes(locator.split('/')[0].toLowerCase()) ||
    typeof content !== 'string') throw new TypeError('Invalid CREATE request');
  return Object.freeze({ operationId, locator, content });
}
function serialize(intent: Intent): string {
  const raw = JSON.stringify(intent);
  if (Buffer.byteLength(raw) > LIMIT) fail('EHEADRESOURCE');
  return raw;
}
function phaseKeys(state: State): string[] {
  if (state === 'PREPARED_CREATE') return ['currentStageIdentity', 'currentStageNlink'];
  if (state === 'LINKED_CREATE') return ['currentStageIdentity', 'currentStageNlink', 'currentHeadIdentity', 'currentHeadNlink', 'priorIntent'];
  return ['currentHeadIdentity', 'currentHeadNlink', 'priorIntent'];
}
function parse(raw: string): Intent {
  let value: Intent;
  try { value = JSON.parse(raw) as Intent; } catch { fail(); }
  const common = ['schema', 'state', 'userId', 'ownerId', 'locator', 'operationId', 'revision',
    'contentHash', 'contentBytes', 'stageName', 'initialStageIdentity', 'namespace'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value.schema !== 3 && value.schema !== 5) ||
    !['PREPARED_CREATE', 'LINKED_CREATE', 'PUBLISHED_CREATE'].includes(value.state)) fail();
  const extra = phaseKeys(value.state);
  if (!exactKeys(value, [...common, ...extra]) || typeof value.userId !== 'string' || !value.userId ||
    Buffer.byteLength(value.userId) > 128 || Buffer.from(value.userId).toString('utf8') !== value.userId ||
    typeof value.ownerId !== 'string' || !UUID.test(value.ownerId) || typeof value.operationId !== 'string' ||
    !UUID.test(value.operationId) || typeof value.locator !== 'string' || value.revision !== '1' ||
    typeof value.contentHash !== 'string' || !HASH.test(value.contentHash) ||
    !Number.isSafeInteger(value.contentBytes) || value.contentBytes < 0 ||
    !validIdentity(value.initialStageIdentity) || typeof value.stageName !== 'string' ||
    !Array.isArray(value.namespace) || !value.namespace.length) fail();
  validatePhase(value);
  for (const directory of value.namespace) {
    if (value.schema === 3) validateNamespace(directory as StableDirectory);
    else validateCommitment(directory as DirectoryCommitment);
  }
  serialize(value);
  return value;
}

function validatePhase(value: Intent): void {
  if (value.state === 'PREPARED_CREATE') {
    if (value.currentStageNlink !== '1' || !isDeepStrictEqual(value.currentStageIdentity, value.initialStageIdentity)) fail();
  } else {
    if (!validIdentity(value.currentHeadIdentity) || !sameOriginal(value.initialStageIdentity, value.currentHeadIdentity) ||
      value.currentHeadNlink !== (value.state === 'LINKED_CREATE' ? '2' : '1') ||
      !value.priorIntent || !exactKeys(value.priorIntent, ['state', 'hash', 'identity']) ||
      value.priorIntent.state !== (value.state === 'LINKED_CREATE' ? 'PREPARED_CREATE' : 'LINKED_CREATE') ||
      typeof value.priorIntent.hash !== 'string' || !HASH.test(value.priorIntent.hash) || !validIdentity(value.priorIntent.identity)) fail();
    if (value.state === 'LINKED_CREATE' && (value.currentStageNlink !== '2' ||
      !isDeepStrictEqual(value.currentStageIdentity, value.currentHeadIdentity))) fail();
  }
}
function validateNamespace(directory: StableDirectory): void {
    if (!directory || !exactKeys(directory, ['locator', 'device', 'inode', 'mode', 'uid', 'names', 'children']) ||
    typeof directory.locator !== 'string' || !['device', 'inode', 'mode', 'uid'].every(key =>
      typeof directory[key as keyof StableDirectory] === 'string' && (directory[key as keyof StableDirectory] as string).length <= 32 && /^(?:0|[1-9]\d*)$/u.test(directory[key as keyof StableDirectory] as string)) ||
    !Array.isArray(directory.names) || directory.names.some(name => typeof name !== 'string' || !name || name.includes('/') || name.includes('\0')) ||
    !isDeepStrictEqual(directory.names, [...new Set(directory.names)].sort(ordinal)) ||
    !Array.isArray(directory.children) || !isDeepStrictEqual(directory.children.map(child => child.name), directory.names)) fail();
    for (const child of directory.children) if (!child || !exactKeys(child, ['name', 'identity', 'mode', 'uid', 'links', 'directory']) ||
    !validIdentity(child.identity) || typeof child.directory !== 'boolean' ||
    !['mode', 'uid', 'links'].every(key => typeof child[key as keyof Child] === 'string' && (child[key as keyof Child] as string).length <= 32 && /^(?:0|[1-9]\d*)$/u.test(child[key as keyof Child] as string)) ||
    !isDeepStrictEqual(child, stableChild(child))) fail();
}

/** One local CREATE invocation, with no connection discovery or generic recovery authority. */
export class FileMemoryOwnedCreate {
  private readonly budget = new FileMemoryCreateScanBudget();
  private readonly files = new Map<string, Artifact>();
  private readonly closeFailures = new WeakMap<object, { cause: unknown; closeCause: unknown }>();
  private directories: Directory[] = [];
  private intent!: Intent;
  private ownerId!: string;
  private discovered = new Map<string, Directory>();
  private journal!: string;
  private head!: string;
  private stage!: string;
  private sidecar!: string;
  private registry!: string;
  private attempted = false;
  private linkConflict = false;
  private residual = false;
  private phase = 'initial';
  private committed?: OwnedFileMemoryToken;
  private readonly invocationId = randomUUID();
  constructor(private readonly scope: FileMemoryOperationScope, private readonly request: CreateOwnedRequest,
    private readonly active: () => void, private readonly hook: ((phase: CreatePublication) => void | Promise<void>) | undefined,
    private readonly capture: (token: OwnedFileMemoryToken) => void) {}

  private absolute(locator: string): string { return locator === '.' ? this.scope.tenantRoot : path.join(this.scope.tenantRoot, locator); }
  private async names(directory: string): Promise<string[]> {
    const names: string[] = [];
    await this.budget.scan(directory, name => names.push(name));
    return names.sort(ordinal);
  }
  private async directory(locator: string): Promise<Directory> {
    const target = this.absolute(locator), before = await fs.lstat(target, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== BigInt(process.getuid!()) ||
      ((locator === '.memory-owners' || locator.startsWith('.memory-owners/')) && (before.mode & 0o777n) !== 0o700n)) fail();
    const names = await this.names(target), children: Child[] = [];
    // Independent readonly observations are bounded to four. Drain the whole
    // batch and retain ordinal failure precedence before launching any next batch.
    for (let offset = 0; offset < names.length; offset += 4) {
      const results = await Promise.allSettled(names.slice(offset, offset + 4).map(name => this.observeChild(target, name)));
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
        children.push(result.value);
      }
    }
    const after = await fs.lstat(target, { bigint: true });
    if (!isDeepStrictEqual(identity(before), identity(after)) || before.nlink !== after.nlink || before.mode !== after.mode || before.uid !== after.uid) fail();
    return { locator, device: scalar(before.dev), inode: scalar(before.ino), mode: scalar(before.mode), uid: scalar(before.uid), names, children, identity: identity(after), directoryLinks: scalar(after.nlink) };
  }
  private async observeChild(target: string, name: string): Promise<Child> {
    const stat = await fs.lstat(path.join(target, name), { bigint: true });
    return { name, identity: identity(stat), mode: scalar(stat.mode), uid: scalar(stat.uid), links: scalar(stat.nlink), directory: stat.isDirectory() };
  }
  private async proof(): Promise<void> {
    // All directory observations consume the same monotonic budget in proof order.
    for (const before of this.directories) if (!isDeepStrictEqual(await this.directory(before.locator), before)) fail();
    // Serial artifact reproof bounds descriptor pressure and fails at the first changed file.
    for (const [target, before] of this.files) if (!isDeepStrictEqual(await this.read(target, Buffer.byteLength(before.raw), before.links), before)) fail();
    this.active();
  }
  private childIndex(children: Child[]): Map<string, Child> {
    const indexed = new Map<string, Child>();
    for (const child of children) {
      if (indexed.has(child.name)) fail();
      indexed.set(child.name, child);
    }
    return indexed;
  }
  private async transition(target: string, add: string[], remove: string[] = [], changed: string[] = []): Promise<void> {
    const locator = path.relative(this.scope.tenantRoot, target).split(path.sep).join('/') || '.';
    const index = this.directories.findIndex(directory => directory.locator === locator);
    const before = this.directories[index], after = await this.directory(locator);
    if (!before || !['device', 'inode', 'mode', 'uid'].every(key => before[key as keyof Directory] === after[key as keyof Directory]) ||
      !isDeepStrictEqual(after.names, before.names.filter(name => !remove.includes(name)).concat(add).sort(ordinal))) fail();
    const children = this.childIndex(after.children);
    for (const child of before.children) if (!remove.includes(child.name) && !changed.includes(child.name) &&
      !isDeepStrictEqual(child, children.get(child.name))) fail();
    this.directories[index] = after;
    await this.transitionAncestor(target, after);
    await this.proof();
  }
  private async transitionAncestor(target: string, after: Directory): Promise<void> {
    const ancestor = this.directories.find(directory => this.absolute(directory.locator) === path.dirname(target));
    if (ancestor && ancestor !== after) {
      const recaptured = await this.directory(ancestor.locator), name = path.basename(target);
      if (!isDeepStrictEqual(ancestor.identity, recaptured.identity) || !isDeepStrictEqual(ancestor.names, recaptured.names)) fail();
      const children = this.childIndex(recaptured.children);
      for (const child of ancestor.children) {
        const current = children.get(child.name)!;
        const expected = child.name === name ? stableChild(child) : child;
        if (!isDeepStrictEqual(expected, child.name === name ? stableChild(current) : current)) fail();
      }
      this.directories[this.directories.indexOf(ancestor)] = recaptured;
    }
  }
  private async closed<T>(handle: fs.FileHandle, body: () => Promise<T>): Promise<T> {
    let result!: T, primary: { cause: unknown } | undefined;
    try { result = await body(); } catch (cause) { primary = { cause }; }
    try { await handle.close(); } catch (cause) {
      if (primary) {
        const error = new Error('CREATE descriptor operation and close failed');
        this.closeFailures.set(error, { cause: primary.cause, closeCause: cause }); throw error;
      }
      throw cause;
    }
    if (primary) throw primary.cause;
    return result;
  }
  private async read(target: string, maximum: number, links: '1' | '2' = '1'): Promise<Artifact> {
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return this.closed(handle, async () => {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== BigInt(links) || before.uid !== BigInt(process.getuid!()) ||
        (before.mode & 0o777n) !== 0o600n || before.size > BigInt(maximum)) fail();
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      // Each read advances the actual returned byte offset; the next read depends on it.
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) fail();
        offset += bytesRead;
      }
      const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const after = await handle.stat({ bigint: true }), named = await fs.lstat(target, { bigint: true });
      if (!isDeepStrictEqual(identity(before), identity(after)) || !isDeepStrictEqual(identity(after), identity(named)) ||
        named.nlink !== before.nlink || named.mode !== before.mode || named.uid !== before.uid) fail();
      this.active();
      return { raw, identity: identity(after), links };
    });
  }
  private async barrier(phase: CreatePublication): Promise<void> {
    await this.hook?.(phase);
    await this.proof();
  }
  private async write(target: string, raw: string, partial?: CreatePublication): Promise<Artifact> {
    await this.proof(); this.residual = true;
    this.active();
    const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const captured = await this.closed(handle, async () => {
      this.active();
      const bytes = Buffer.from(raw); let split = Math.floor(bytes.length / 2);
      while (split > 0 && (bytes[split] & 0xc0) === 0x80) split--;
      await this.writeBytes(handle, bytes.subarray(0, split));
      const original = await handle.stat({ bigint: true });
      const part = await this.read(target, split);
      const observed = await handle.stat({ bigint: true });
      if (!original.isFile() || original.nlink !== 1n || original.uid !== BigInt(process.getuid!()) ||
        (original.mode & 0o777n) !== 0o600n || !isDeepStrictEqual(identity(original), identity(observed)) ||
        !isDeepStrictEqual(part.identity, identity(original)) || !Buffer.from(part.raw).equals(bytes.subarray(0, split))) fail();
      this.files.set(target, part);
      await this.transition(path.dirname(target), [path.basename(target)]);
      if (partial) await this.barrier(partial);
      await this.writeBytes(handle, bytes.subarray(split)); this.active(); await handle.sync(); this.active();
      return identity(await handle.stat({ bigint: true }));
    });
    const file = await this.read(target, Buffer.byteLength(raw));
    if (file.raw !== raw || !isDeepStrictEqual(file.identity, captured)) fail();
    this.files.set(target, file);
    await this.transition(path.dirname(target), [], [], [path.basename(target)]);
    return file;
  }
  private async writeBytes(handle: fs.FileHandle, bytes: Buffer): Promise<void> {
    let offset = 0;
    // Partial writes advance one descriptor position and require renewed authority in order.
    while (offset < bytes.length) {
      this.active();
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
      this.active(); if (bytesWritten < 1 || bytesWritten > bytes.length - offset) fail();
      offset += bytesWritten;
    }
  }
  private async syncDirectory(target: string, final = false): Promise<void> {
    await this.proof();
    const locator = path.relative(this.scope.tenantRoot, target).split(path.sep).join('/') || '.';
    const expected = this.directories.find(directory => directory.locator === locator)!;
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    await this.closed(handle, async () => {
      this.active();
      const before = await handle.stat({ bigint: true });
      if (!before.isDirectory() || !isDeepStrictEqual(identity(before), expected.identity) ||
        scalar(before.mode) !== expected.mode || scalar(before.uid) !== expected.uid) fail();
      await this.proof(); this.active(); await handle.sync();
      if (!isDeepStrictEqual(identity(await handle.stat({ bigint: true })), expected.identity)) fail();
      await this.proof();
    });
    if (final) {
      const token: OwnedFileMemoryToken = Object.freeze({ backend: 'file', ownership: 'owned', userId: this.scope.userId,
        tenantRoot: this.scope.tenantRoot, locator: this.request.locator, ownerId: this.intent.ownerId,
        revision: '1', contentHash: this.intent.contentHash, fileIdentity: Object.freeze({ ...this.intent.currentHeadIdentity! }) });
      this.committed = token; this.capture(token);
    } else this.active();
  }

  private async replaceIntent(next: Intent): Promise<void> {
    const old = this.files.get(this.journal)!;
    next.priorIntent = { state: this.intent.state as 'PREPARED_CREATE' | 'LINKED_CREATE', hash: digest(old.raw), identity: old.identity };
    const label = next.state === 'LINKED_CREATE' ? 'linked' : 'published';
    const target = `${this.journal}.create-${this.request.operationId}.${label}.tmp`;
    const staged = await this.write(target, serialize(next), label === 'linked' ? 'partial-linked-intent' : 'partial-published-intent');
    await this.proof(); this.active(); this.attempted = true;
    await fs.rename(target, this.journal);
    const published = await this.read(this.journal, LIMIT);
    if (published.raw !== staged.raw || !sameOriginal(published.identity, staged.identity)) fail();
    this.files.delete(target); this.files.set(this.journal, published); this.intent = next;
    await this.transition(path.dirname(target), [], [path.basename(target)], [path.basename(this.journal)]);
    await this.syncDirectory(path.dirname(target)); this.attempted = false;
  }

  private async initialize(): Promise<void> {
    if (!this.scope.userId || Buffer.byteLength(this.scope.userId) > 128 || this.scope.userId.includes('\0') ||
      Buffer.from(this.scope.userId).toString('utf8') !== this.scope.userId) fail('EHEADCONFLICT');
    const journalExists = await this.admitHeadNamespace();
    await this.loadIntent(journalExists);
    await this.preflight();
    // Each ancestor must be captured before its child can be admitted or created.
    await this.prepareOwnershipDirectory('.memory-owners', journalExists);
    await this.prepareOwnershipDirectory('.memory-owners/owners', journalExists);
    if (!journalExists) await this.prepareIntent();
    this.registry = this.absolute(`.memory-owners/owners/${this.intent.ownerId}.json`);
    const owners = this.directories.find(directory => directory.locator === '.memory-owners/owners')!;
    if (owners.names.some(name => name.toLowerCase().startsWith(this.intent.ownerId) &&
      !(this.intent.state === 'PUBLISHED_CREATE' && name === path.basename(this.registry)))) fail();
  }

  private async admitHeadNamespace(): Promise<boolean> {
    const segments = this.request.locator.split('/');
    let locator = '.';
    this.directories = [await this.directory(locator)];
    // Each exact ancestor census admits the next confined directory.
    for (const segment of segments.slice(0, -1)) {
      const parent = this.directories.at(-1)!;
      if (!parent.names.includes(segment) || parent.names.some(name => name !== segment && name.toLowerCase() === segment.toLowerCase())) fail();
      locator = locator === '.' ? segment : `${locator}/${segment}`;
      this.directories.push(await this.directory(locator));
    }
    this.head = this.absolute(this.request.locator);
    const hash = digest(path.basename(this.head));
    this.journal = path.join(path.dirname(this.head), `.${hash}.memory-write.json`);
    this.sidecar = path.join(path.dirname(this.head), `.${hash}.memory-owner.json`);
    this.stage = `${this.journal}.create-${this.request.operationId}.head.tmp`;
    const parent = this.directories.at(-1)!;
    const forbidden = new Set([path.basename(this.head).toLowerCase(), path.basename(this.sidecar).toLowerCase()]);
    const journalExists = parent.names.includes(path.basename(this.journal));
    if (parent.names.some(name => forbidden.has(name.toLowerCase()) &&
      name !== path.basename(this.head) && !(journalExists && name === path.basename(this.sidecar)))) fail('EHEADCONFLICT');
    if (!journalExists && parent.names.some(name => name.toLowerCase() === path.basename(this.head).toLowerCase())) fail('EHEADCONFLICT');
    if (parent.names.some(name => name.toLowerCase().startsWith(`.${hash}.memory-write`) &&
      name !== path.basename(this.journal) && !(journalExists && name === path.basename(this.stage)))) fail();
    if (parent.names.some(name => name.toLowerCase().startsWith(`.${hash}.memory-owner`) &&
      !(journalExists && name === path.basename(this.sidecar)))) fail();
    return journalExists;
  }
  private async loadIntent(journalExists: boolean): Promise<void> {
    if (journalExists) {
      const journal = await this.read(this.journal, LIMIT); this.files.set(this.journal, journal);
      this.intent = parse(journal.raw);
      if (this.intent.operationId !== this.request.operationId || this.intent.locator !== this.request.locator ||
        this.intent.userId !== this.scope.userId || this.intent.contentHash !== digest(this.request.content) ||
        this.intent.contentBytes !== Buffer.byteLength(this.request.content) || this.intent.stageName !== path.basename(this.stage)) fail('EHEADCONFLICT');
      this.residual = true;
    }
  }
  private async prepareOwnershipDirectory(fixed: string, journalExists: boolean): Promise<void> {
    const container = this.directories.find(directory => directory.locator === (fixed.includes('/') ? '.memory-owners' : '.'))!;
    const basename = path.posix.basename(fixed);
    if (container.names.some(name => name.toLowerCase() === basename && name !== basename)) fail();
    if (!container.names.includes(basename)) {
      if (journalExists) fail();
      await this.proof(); this.residual = true;
      this.active(); await fs.mkdir(this.absolute(fixed), { mode: 0o700 });
      const created = await this.captureCreatedDirectory(fixed);
      await this.transition(this.absolute(container.locator), [basename]);
      const added = await this.directory(fixed);
      if (added.names.length || !isDeepStrictEqual(added.identity, created.identity) || added.directoryLinks !== created.links) fail();
      this.directories.push(added); await this.syncDirectory(this.absolute(container.locator));
    } else {
      const recaptured = await this.directory(fixed);
      if (!isDeepStrictEqual(recaptured, this.discovered.get(fixed))) fail();
      const index = this.directories.findIndex(directory => directory.locator === fixed);
      if (index < 0) this.directories.push(recaptured);
      else this.directories[index] = recaptured;
      // A prior mkdir may not have acknowledged durability of its containing directory.
      await this.syncDirectory(this.absolute(container.locator));
    }
  }
  private async prepareIntent(): Promise<void> {
    const namespace = this.directories.map(({ identity: _identity, directoryLinks: _links, ...directory }) => ({ ...directory, children: directory.children.map(stableChild) }));
    const commitments = namespace.map(commitCreateDirectory);
    await this.barrier('before-content');
    const staged = await this.write(this.stage, this.request.content, 'partial-content');
    this.intent = { schema: 5, state: 'PREPARED_CREATE', userId: this.scope.userId, ownerId: this.ownerId,
      locator: this.request.locator, operationId: this.request.operationId, revision: '1', contentHash: digest(staged.raw),
      contentBytes: Buffer.byteLength(staged.raw), stageName: path.basename(this.stage), initialStageIdentity: staged.identity,
      currentStageIdentity: staged.identity, currentStageNlink: '1', namespace: commitments };
    parse(serialize(this.intent)); await this.write(this.journal, serialize(this.intent));
    await this.syncDirectory(path.dirname(this.head));
  }

  private async preflight(): Promise<void> {
    this.discovered = new Map(this.directories.map(directory => [directory.locator, directory]));
    for (const fixed of ['.memory-owners', '.memory-owners/owners']) {
      const parent = this.discovered.get(path.posix.dirname(fixed));
      const name = path.posix.basename(fixed);
      if (parent?.names.some(child => child !== name && child.toLowerCase() === name)) fail();
      if (parent?.names.includes(name)) this.discovered.set(fixed, await this.directory(fixed));
    }
    this.ownerId = this.intent?.ownerId ?? randomUUID();
    this.registry = this.absolute(`.memory-owners/owners/${this.ownerId}.json`);
    if (this.intent) {
      if (!this.discovered.has('.memory-owners/owners')) fail();
      this.directories = [...this.discovered.values()];
      await this.recover(); // Exact existing artifacts/namespace before even parent fsync.
    }
    const namespace = this.projectNamespace();
    this.admitPhaseSizes(this.intent?.namespace ?? namespace.map(commitCreateDirectory));
    const ownNames = new Map<string, string[]>([
      ['.', ['.memory-owners']], ['.memory-owners', ['owners']],
      ['.memory-owners/owners', [path.basename(this.registry)]],
    ]);
    const headParent = path.posix.dirname(this.request.locator);
    ownNames.set(headParent, (ownNames.get(headParent) ?? []).concat(
      [this.head, this.stage, this.journal, this.sidecar, `${this.journal}.create-${this.request.operationId}.linked.tmp`,
        `${this.journal}.create-${this.request.operationId}.published.tmp`].map(target => path.basename(target))));
    this.budget.reserve(namespace.map(directory => ({ locator: directory.locator,
      names: directory.names.concat(ownNames.get(directory.locator) ?? []), missing: !this.discovered.has(directory.locator) })), headParent, this.intent?.state);
  }
  private projectNamespace(): StableDirectory[] {
    const namespace = [...this.discovered.values()].map(({ identity: _identity, directoryLinks: _links, ...directory }) =>
      ({ ...directory, names: [...directory.names], children: directory.children.map(stableChild) }));
    for (const fixed of ['.memory-owners', '.memory-owners/owners']) {
      if (this.discovered.has(fixed)) continue;
      const parent = namespace.find(directory => directory.locator === path.posix.dirname(fixed))!;
      const child: Child = { name: path.posix.basename(fixed), mode: MAX_NUMBER, uid: MAX_NUMBER, links: '0', directory: true,
        identity: { device: MAX_NUMBER, inode: MAX_NUMBER, size: '0', mtimeNs: '0', ctimeNs: '0' } };
      parent.children.push(child); parent.children.sort((a, b) => ordinal(a.name, b.name)); parent.names = parent.children.map(item => item.name);
      namespace.push({ locator: fixed, device: MAX_NUMBER, inode: MAX_NUMBER, mode: MAX_NUMBER, uid: MAX_NUMBER, names: [], children: [] });
    }
    return namespace;
  }
  private admitPhaseSizes(namespace: (StableDirectory | DirectoryCommitment)[]): void {
    const future: Identity = { device: MAX_NUMBER, inode: MAX_NUMBER, size: String(Buffer.byteLength(this.request.content)), mtimeNs: MAX_NUMBER, ctimeNs: MAX_NUMBER };
    const common = { schema: this.intent?.schema ?? 5 as const, userId: this.scope.userId, ownerId: this.ownerId, locator: this.request.locator,
      operationId: this.request.operationId, revision: '1' as const, contentHash: digest(this.request.content), contentBytes: Buffer.byteLength(this.request.content),
      stageName: path.basename(this.stage), initialStageIdentity: this.intent?.initialStageIdentity ?? future, namespace };
    const prior = { state: 'PREPARED_CREATE' as const, hash: 'f'.repeat(64), identity: { ...future, size: String(LIMIT) } };
    if (!this.intent || this.intent.state === 'PREPARED_CREATE') serialize({ ...common, state: 'PREPARED_CREATE', currentStageIdentity: common.initialStageIdentity, currentStageNlink: '1' });
    if (this.intent?.state !== 'PUBLISHED_CREATE') serialize({ ...common, state: 'LINKED_CREATE', currentStageIdentity: future, currentStageNlink: '2',
      currentHeadIdentity: future, currentHeadNlink: '2', priorIntent: prior });
    serialize({ ...common, state: 'PUBLISHED_CREATE', currentHeadIdentity: future, currentHeadNlink: '1', priorIntent: { ...prior, state: 'LINKED_CREATE' } });
  }

  private async captureCreatedDirectory(locator: string): Promise<{ identity: Identity; links: string }> {
    this.active();
    const target = this.absolute(locator);
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    const captured = await this.closed(handle, async () => {
      this.active(); const descriptor = await handle.stat({ bigint: true });
      const named = await fs.lstat(target, { bigint: true });
      if (!descriptor.isDirectory() || !named.isDirectory() || named.isSymbolicLink() ||
        descriptor.uid !== BigInt(process.getuid!()) || (descriptor.mode & 0o777n) !== 0o700n ||
        !isDeepStrictEqual(identity(descriptor), identity(named)) || descriptor.nlink !== named.nlink ||
        descriptor.mode !== named.mode || descriptor.uid !== named.uid) fail();
      this.active();
      return { identity: identity(descriptor), links: scalar(descriptor.nlink) };
    });
    this.active();
    return captured;
  }

  private async recover(): Promise<void> {
    await this.recoverContent();
    const registry = this.absolute(`.memory-owners/owners/${this.intent.ownerId}.json`);
    const activeRaw = this.intent.state === 'PUBLISHED_CREATE' ? this.activeRecord() : undefined;
    const registryPresent = this.directories.find(item => this.absolute(item.locator) === path.dirname(registry))!.names.includes(path.basename(registry));
    const sidecarPresent = this.directories.find(item => this.absolute(item.locator) === path.dirname(this.sidecar))!.names.includes(path.basename(this.sidecar));
    // Registry publication precedes sidecar publication; reverse evidence cannot authorize recreation.
    if (sidecarPresent && !registryPresent) fail();
    // Sequential admission bounds descriptor pressure and stops at the first changed artifact.
    for (const target of [registry, this.sidecar]) {
      const directory = this.directories.find(item => this.absolute(item.locator) === path.dirname(target))!;
      if (directory.names.includes(path.basename(target))) {
        if (!activeRaw) fail();
        const file = await this.read(target, 4096);
        if (file.raw !== activeRaw) { fail(); }
        this.files.set(target, file);
      }
    }
    this.recoverNamespace();
    await this.proof();
  }
  private async recoverContent(): Promise<void> {
    const head = this.intent.state !== 'PREPARED_CREATE', stage = this.intent.state !== 'PUBLISHED_CREATE';
    if (stage) {
      const file = await this.read(this.stage, this.intent.contentBytes, this.intent.currentStageNlink!);
      if (!isDeepStrictEqual(file.identity, this.intent.currentStageIdentity) || file.raw !== this.request.content) fail();
      this.files.set(this.stage, file);
    }
    if (head) {
      const file = await this.read(this.head, this.intent.contentBytes, this.intent.currentHeadNlink!);
      if (!isDeepStrictEqual(file.identity, this.intent.currentHeadIdentity) || file.raw !== this.request.content) fail();
      this.files.set(this.head, file);
    }
  }
  private recoverNamespace(): void {
    if (this.intent.namespace.length !== this.directories.length) fail();
    for (let index = 0; index < this.directories.length; index++) {
      const expected = this.intent.namespace[index], actual = this.directories[index];
      if (!(['locator', 'device', 'inode', 'mode', 'uid'] as const).every(key => expected[key] === actual[key])) fail();
      const added = [...this.files.keys()].filter(target => path.dirname(target) === this.absolute(actual.locator)).map(target => path.basename(target));
      if (new Set(added).size !== added.length || added.some(name => !actual.names.includes(name))) fail();
      if (this.intent.schema === 5) {
        const retained = actual.children.filter(child => !added.includes(child.name)).map(stableChild);
        const baseline = { locator: actual.locator, device: actual.device, inode: actual.inode, mode: actual.mode, uid: actual.uid,
          names: retained.map(child => child.name), children: retained };
        if (!isDeepStrictEqual(commitCreateDirectory(baseline), expected)) fail();
        continue;
      }
      this.recoverLegacyNamespace(expected as StableDirectory, actual, added);
    }
  }
  private recoverLegacyNamespace(expected: StableDirectory, actual: Directory, added: string[]): void {
    if (!isDeepStrictEqual(actual.names, expected.names.concat(added).sort(ordinal))) fail();
    const children = this.childIndex(actual.children);
    for (const child of expected.children) {
      if (!isDeepStrictEqual(child, stableChild(children.get(child.name)!))) fail();
    }
  }
  private activeRecord(): string {
    return JSON.stringify({ schema: 1, state: 'ACTIVE', userId: this.scope.userId, ownerId: this.intent.ownerId,
      locator: this.request.locator, revision: '1', contentHash: this.intent.contentHash, fileIdentity: this.intent.currentHeadIdentity });
  }
  private audit(): void {
    SecurityMonitor.logSecurityEvent({ type: 'DANGER_ZONE_OPERATION', severity: 'LOW', source: 'FileMemoryOwnedCreate',
      details: `Exclusive memory CREATE known committed; invocation=${this.invocationId}` });
  }
  private async linkHead(): Promise<void> {
    this.phase = 'prepared'; await this.barrier('prepared'); await this.barrier('before-link');
    this.active(); this.attempted = true;
    try { await fs.link(this.stage, this.head); }
    catch (cause) {
      if (cause && typeof cause === 'object' && (cause as NodeJS.ErrnoException).code === 'EEXIST') {
        this.linkConflict = true; this.attempted = false;
      }
      throw cause;
    }
    const stage = await this.read(this.stage, this.intent.contentBytes, '2'), head = await this.read(this.head, this.intent.contentBytes, '2');
    if (!isDeepStrictEqual(stage, head) || !sameOriginal(stage.identity, this.intent.initialStageIdentity)) fail();
    this.files.set(this.stage, stage); this.files.set(this.head, head);
    await this.transition(path.dirname(this.head), [path.basename(this.head)], [], [path.basename(this.stage)]);
    await this.barrier('linked-before-intent');
    await this.replaceIntent({ ...this.intent, state: 'LINKED_CREATE', currentStageIdentity: stage.identity,
      currentStageNlink: '2', currentHeadIdentity: head.identity, currentHeadNlink: '2' });
  }
  private async publishHead(): Promise<void> {
    this.phase = 'linked'; await this.barrier('linked'); this.active(); this.attempted = true;
    await fs.unlink(this.stage); const head = await this.read(this.head, this.intent.contentBytes);
    if (!sameOriginal(head.identity, this.intent.currentHeadIdentity!)) fail();
    this.files.delete(this.stage); this.files.set(this.head, head);
    await this.transition(path.dirname(this.head), [], [path.basename(this.stage)], [path.basename(this.head)]);
    await this.barrier('unlinked-stage-before-intent');
    const { currentStageIdentity: _stage, currentStageNlink: _links, ...published } = this.intent;
    await this.replaceIntent({ ...published, state: 'PUBLISHED_CREATE', currentHeadIdentity: head.identity, currentHeadNlink: '1' });
  }
  private outcomeCode(): string {
    if (this.committed) return 'EHEADCOMMITTED';
    if (this.linkConflict) return 'EHEADCONFLICT';
    if (this.attempted) return 'EHEADCOMMITUNKNOWN';
    if (this.residual) return 'EOWNERRECOVERY';
    return 'EHEADCONFLICT';
  }
  private outcomeError(cause: unknown): Error {
    const close = cause && typeof cause === 'object' ? this.closeFailures.get(cause) : undefined;
    const error = Object.assign(new Error('Exclusive memory CREATE stopped; preserve residual evidence'), {
      code: this.outcomeCode(), cause: close ? close.cause : cause,
      operationId: this.request.operationId, phase: this.phase, residual: this.residual });
    if (close) Object.assign(error, { closeCause: close.closeCause });
    if (this.committed) Object.assign(error, { committed: true, token: this.committed });
    return error;
  }
  async run(): Promise<OwnedFileMemoryToken> {
    try {
      await this.initialize();
      if (this.intent.state === 'PREPARED_CREATE') await this.linkHead();
      if (this.intent.state === 'LINKED_CREATE') await this.publishHead();
      this.phase = 'published'; await this.barrier('published');
      // Durable registry publication must precede sidecar publication.
      for (const [target, point] of [[this.registry, 'active-registry'], [this.sidecar, 'active-sidecar']] as const) {
        if (!this.files.has(target)) await this.write(target, this.activeRecord());
        await this.syncDirectory(path.dirname(target)); await this.barrier(point);
      }
      await this.proof(); this.phase = 'intent-removal-unknown'; this.active(); this.attempted = true;
      await fs.unlink(this.journal); this.files.delete(this.journal);
      await this.transition(path.dirname(this.head), [], [path.basename(this.journal)]);
      this.phase = 'durability-unconfirmed'; await this.barrier('intent-unlinked');
      await this.syncDirectory(path.dirname(this.head), true);
      this.audit(); await this.barrier('committed'); await this.barrier('after-read');
      return this.committed!;
    } catch (cause) {
      throw this.outcomeError(cause);
    }
  }
}
