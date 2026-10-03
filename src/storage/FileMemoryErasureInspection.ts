/** No-follow, content-free observations for the internal whole-owner executor. */
import { constants, type BigIntStats, type Dir, type Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { closeMemoryDirectoryInspection } from './FileMemoryDirectoryScanBudget.js';
import { evidenceDigest, evidenceIdentity, evidenceOrdinal, type HeadChild, type HeadDirectory, type HeadIdentity } from './FileMemoryOwnedHeadEvidence.js';
import { ERASURE_DEPTH_LIMIT, ERASURE_NODE_LIMIT, ERASURE_RECORD_LIMIT, erasureBasename, erasureFail, erasureNamesDigest, type ErasureArtifact, type ErasureDirectoryBinding, type ErasureNode } from './FileMemoryErasureEvidence.js';
import { MEMORY_CONSTANTS } from '../elements/memories/constants.js';

export interface ErasureWork {
  directoryReads: number; censuses: number; lstats: number; directoryOpens: number;
  fileOpens: number; descriptorStats: number; recordReads: number; recordReadBytes: number;
  recordWrites: number; recordWriteBytes: number; fileSyncs: number; directorySyncs: number;
  closes: number; mutations: number; chainValidations: number;
  replacementHeadReads: number; replacementHeadReadBytes: number;
  archiveMutationAttempts: number;
}
/** Counts actual attempts at invocation time; no persisted historical I/O claims. */
export type ErasureNamesCapture = Omit<HeadDirectory, 'children'> & { kind: 'names' };
export type ErasureDirectoryCapture = HeadDirectory | ErasureNamesCapture;
export function erasureNamesCapture(value: ErasureDirectoryCapture): value is ErasureNamesCapture { return 'kind' in value && value.kind === 'names'; }

export class ErasureAccounting {
  readonly actual: ErasureWork = { directoryReads: 0, censuses: 0, lstats: 0, directoryOpens: 0,
    fileOpens: 0, descriptorStats: 0, recordReads: 0, recordReadBytes: 0, recordWrites: 0,
    recordWriteBytes: 0, fileSyncs: 0, directorySyncs: 0, closes: 0, mutations: 0, chainValidations: 0,
    replacementHeadReads: 0, replacementHeadReadBytes: 0, archiveMutationAttempts: 0 };
  private discovery = 0;
  private ceiling: number | undefined;
  private limits?: ErasureWork;
  private readPhase?: 'head-tail' | 'owner-and-evidence';
  private operationPhase?: 'head-tail' | 'owner-and-evidence';
  charge(kind: keyof ErasureWork, amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0) erasureFail('EHEADRESOURCE');
    if (kind === 'directoryReads' && this.ceiling !== undefined && this.actual.directoryReads + amount > this.ceiling) erasureFail('EHEADRESOURCE');
    const next = this.actual[kind] + amount;
    if (!Number.isSafeInteger(next) || this.limits && next > this.limits[kind]) erasureFail('EHEADRESOURCE');
    this.actual[kind] = next;
  }
  archiveMutation(): void {
    const mutation = this.actual.mutations + 1, archive = this.actual.archiveMutationAttempts + 1;
    if (!Number.isSafeInteger(mutation) || !Number.isSafeInteger(archive) || this.limits &&
      (mutation > this.limits.mutations || archive > this.limits.archiveMutationAttempts)) erasureFail('EHEADRESOURCE');
    this.actual.mutations = mutation; this.actual.archiveMutationAttempts = archive;
  }
  read(directory: Dir, discovering: boolean): Promise<Dirent | null> {
    if (discovering && this.discovery === ERASURE_NODE_LIMIT) erasureFail('EHEADRESOURCE');
    this.charge('directoryReads');
    if (discovering) this.discovery++;
    return directory.read();
  }
  /** Caller supplies the expanded concrete remaining scan schedule before mutation. */
  reserve(scanWeights: readonly (number | { weight: number; repetitions: number })[], phase: 'head-tail' | 'owner-and-evidence' = 'owner-and-evidence'): void {
    if (this.readPhase && !(this.readPhase === 'head-tail' && phase === 'owner-and-evidence')) erasureFail('EHEADRESOURCE');
    let total = this.actual.directoryReads;
    for (const scan of scanWeights) {
      const weight = typeof scan === 'number' ? scan : scan.weight;
      const repetitions = typeof scan === 'number' ? 1 : scan.repetitions;
      if (!Number.isSafeInteger(weight) || weight < 1 || weight > ERASURE_NODE_LIMIT) erasureFail('EHEADRESOURCE');
      if (!Number.isSafeInteger(repetitions) || repetitions < 0) erasureFail('EHEADRESOURCE');
      total += weight * repetitions;
      if (!Number.isSafeInteger(total)) erasureFail('EHEADRESOURCE');
    }
    this.ceiling = Math.max(this.ceiling ?? 0, total); this.readPhase = phase;
  }
  get discoveryConsumed(): number { return this.discovery; }
  get reservedDirectoryReads(): number | undefined { return this.ceiling; }
  cleanupClose(primary: { cause: unknown } | undefined): { cause: unknown } | undefined {
    // Cleanup remains mandatory even when admission has refused further ordinary I/O.
    this.actual.closes++;
    if (!Number.isSafeInteger(this.actual.closes) || this.limits && this.actual.closes > this.limits.closes) {
      const refusal = Object.assign(new Error('Erasure close reservation exhausted'), { code: 'EHEADRESOURCE' });
      return primary ? { cause: Object.assign(new AggregateError([primary.cause, refusal], 'Erasure operation and close admission failed',
        { cause: primary.cause }), { code: (primary.cause as NodeJS.ErrnoException | undefined)?.code }) } : { cause: refusal };
    }
    return primary;
  }
  /** Independently expanded finite I/O attempt bounds, admitted before evidence staging. */
  reserveOperations(remaining: ErasureWork, phase: 'head-tail' | 'owner-and-evidence' = 'owner-and-evidence'): void {
    if (this.operationPhase && !(this.operationPhase === 'head-tail' && phase === 'owner-and-evidence')) erasureFail('EHEADRESOURCE');
    const limits = { ...this.actual };
    for (const kind of Object.keys(limits) as (keyof ErasureWork)[]) {
      const amount = remaining[kind], total = limits[kind] + amount;
      if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(total)) erasureFail('EHEADRESOURCE');
      limits[kind] = Math.max(this.limits?.[kind] ?? 0, total);
    }
    this.limits = limits; this.operationPhase = phase;
  }
}

export class ErasureInspection {
  constructor(readonly root: string, readonly device: string, readonly accounting: ErasureAccounting,
    private readonly active: () => void) {}
  absolute(locator: string): string {
    if (locator !== '.' && (!locator || path.isAbsolute(locator) || !locator.split('/').every(erasureBasename))) erasureFail();
    const target = locator === '.' ? this.root : path.join(this.root, ...locator.split('/'));
    if (Buffer.byteLength(target) + 1 > (process.platform === 'darwin' ? 1024 : 4096)) erasureFail('EHEADRESOURCE');
    return target;
  }
  async lstat(locator: string): Promise<BigIntStats> {
    this.active(); this.accounting.charge('lstats');
    return fs.lstat(this.absolute(locator), { bigint: true });
  }
  private supported(stat: BigIntStats, directory: boolean, privateMode: boolean): void {
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      String(stat.dev) !== this.device || stat.uid !== BigInt(process.getuid!()) ||
      privateMode && (stat.mode & 0o077n) !== 0n || !directory && stat.nlink !== 1n) erasureFail();
  }
  private child(name: string, stat: BigIntStats): HeadChild {
    return { name, identity: evidenceIdentity(stat, erasureFail), mode: String(stat.mode), uid: String(stat.uid),
      links: String(stat.nlink), directory: stat.isDirectory() };
  }
  private sameStat(a: BigIntStats, b: BigIntStats): boolean {
    return equal(evidenceIdentity(a, erasureFail), evidenceIdentity(b, erasureFail)) &&
      a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink && a.isDirectory() === b.isDirectory();
  }
  private async closed<T>(handle: fs.FileHandle, body: () => Promise<T>): Promise<T> {
    let primary: { cause: unknown } | undefined;
    let value!: T;
    try { value = await body(); } catch (cause) { primary = { cause }; }
    primary = this.accounting.cleanupClose(primary);
    try { await handle.close(); }
    catch (cause) {
      if (!primary) throw cause;
      throw Object.assign(new AggregateError([primary.cause, cause], 'Erasure inspection and close failed', { cause: primary.cause }),
        { code: (primary.cause as NodeJS.ErrnoException | undefined)?.code });
    }
    if (primary) throw primary.cause;
    return value;
  }
  async names(locator: string, discovering = false, shared = false): Promise<string[]> {
    this.active(); this.accounting.charge('censuses'); this.accounting.charge('directoryOpens');
    const directory = await fs.opendir(this.absolute(locator), shared ? { bufferSize: ERASURE_NODE_LIMIT } : undefined);
    const names: string[] = []; const seen = new Set<string>(); let primary: { cause: unknown } | undefined;
    try {
      for (;;) {
        this.active();
        if (names.length === 4095) {
          const eof = await this.accounting.read(directory, discovering);
          if (eof) erasureFail('EHEADRESOURCE');
          break;
        }
        const entry = await this.accounting.read(directory, discovering);
        if (!entry) break;
        if (!erasureBasename(entry.name) || seen.has(entry.name)) erasureFail();
        seen.add(entry.name);
        names.push(entry.name);
      }
    } catch (cause) { primary = { cause }; }
    primary = this.accounting.cleanupClose(primary);
    await closeMemoryDirectoryInspection(directory, primary, 'Erasure census and close failed');
    return names.sort(evidenceOrdinal);
  }
  directory(locator: string, discovering = false, privateMode = true): Promise<HeadDirectory> {
    return this.observeDirectory(locator, discovering, privateMode, 'full') as Promise<HeadDirectory>;
  }
  sharedDirectory(locator: string, privateMode = true): Promise<ErasureNamesCapture> {
    return this.observeDirectory(locator, false, privateMode, 'names') as Promise<ErasureNamesCapture>;
  }
  private async observeDirectory(locator: string, discovering: boolean, privateMode: boolean, kind: 'full' | 'names'): Promise<ErasureDirectoryCapture> {
    const before = await this.lstat(locator); this.supported(before, true, privateMode);
    this.active(); this.accounting.charge('directoryOpens');
    const handle = await fs.open(this.absolute(locator), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    return this.closed(handle, async () => {
      this.accounting.charge('descriptorStats'); const opened = await handle.stat({ bigint: true });
      if (!equal(evidenceIdentity(opened, erasureFail), evidenceIdentity(before, erasureFail))) erasureFail();
      const names = await this.names(locator, discovering, kind === 'names');
      const children: HeadChild[] = [];
      for (let offset = 0; kind === 'full' && offset < names.length; offset += 16) {
        const observed = await Promise.allSettled(names.slice(offset, offset + 16).map(async name =>
          this.child(name, await this.lstat(locator === '.' ? name : `${locator}/${name}`))));
        for (const result of observed) {
          if (result.status === 'rejected') throw result.reason;
          children.push(result.value);
        }
      }
      const after = await this.lstat(locator);
      this.accounting.charge('descriptorStats'); const final = await handle.stat({ bigint: true });
      if (!this.sameStat(before, after) || !this.sameStat(before, final)) erasureFail();
      const binding = { locator, identity: evidenceIdentity(before, erasureFail), mode: String(before.mode), uid: String(before.uid),
        links: String(before.nlink), names };
      return kind === 'names' ? { ...binding, kind } : { ...binding, children };
    });
  }
  async recheckDirectory(captured: ErasureDirectoryCapture): Promise<void> {
    const current = await this.lstat(captured.locator);
    if (!current.isDirectory() || current.isSymbolicLink() ||
      !equal(evidenceIdentity(current, erasureFail), captured.identity) || String(current.mode) !== captured.mode ||
      String(current.uid) !== captured.uid || String(current.nlink) !== captured.links) erasureFail();
  }
  async file(locator: string): Promise<HeadChild> {
    const before = await this.lstat(locator); this.supported(before, false, true);
    this.active(); this.accounting.charge('fileOpens');
    const handle = await fs.open(this.absolute(locator), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return this.closed(handle, async () => {
      this.accounting.charge('descriptorStats'); const opened = await handle.stat({ bigint: true });
      const after = await this.lstat(locator);
      this.accounting.charge('descriptorStats'); const final = await handle.stat({ bigint: true });
      if (!this.sameStat(before, opened) || !this.sameStat(before, after) || !this.sameStat(before, final)) erasureFail();
      return this.child(path.posix.basename(locator), before);
    });
  }
  async record(locator: string): Promise<ErasureArtifact & { raw: string }> {
    return this.boundedBytes(locator, ERASURE_RECORD_LIMIT, false);
  }
  async replacementHead(locator: string): Promise<ErasureArtifact & { raw: string }> {
    const observed = await this.boundedBytes(locator, 3 * MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE, true);
    if (observed.raw.length > MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE) erasureFail('EHEADRESOURCE');
    return observed;
  }
  private async boundedBytes(locator: string, maximum: number, replacement: boolean): Promise<ErasureArtifact & { raw: string }> {
    const before = await this.lstat(locator);
    if (replacement) {
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || String(before.dev) !== this.device) erasureFail();
    } else this.supported(before, false, true);
    if (before.size > BigInt(maximum)) erasureFail('EHEADRESOURCE');
    this.active(); this.accounting.charge('fileOpens');
    const handle = await fs.open(this.absolute(locator), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return this.closed(handle, async () => {
      this.accounting.charge('descriptorStats'); const opened = await handle.stat({ bigint: true });
      if (!this.sameStat(before, opened)) erasureFail();
      const bytes = Buffer.alloc(Number(before.size)), eof = Buffer.alloc(1);
      let offset = 0;
      while (offset < bytes.length) {
        this.active(); this.accounting.charge(replacement ? 'replacementHeadReads' : 'recordReads');
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        this.accounting.charge(replacement ? 'replacementHeadReadBytes' : 'recordReadBytes', read.bytesRead);
        if (!read.bytesRead) erasureFail(); offset += read.bytesRead;
      }
      this.active(); this.accounting.charge(replacement ? 'replacementHeadReads' : 'recordReads');
      const end = await handle.read(eof, 0, 1, offset);
      this.accounting.charge(replacement ? 'replacementHeadReadBytes' : 'recordReadBytes', end.bytesRead);
      if (end.bytesRead) erasureFail();
      const after = await this.lstat(locator);
      this.accounting.charge('descriptorStats'); const final = await handle.stat({ bigint: true });
      if (!this.sameStat(before, after) || !this.sameStat(before, final)) erasureFail();
      const raw = bytes.toString('utf8'); if (!Buffer.from(raw).equals(bytes)) erasureFail();
      return { raw, digest: evidenceDigest(raw), identity: evidenceIdentity(before, erasureFail),
        mode: String(before.mode), uid: String(before.uid), links: String(before.nlink) };
    });
  }
  async syncDirectory(binding: ErasureDirectoryBinding, prove: () => Promise<void>): Promise<void> {
    await prove(); const before = await this.lstat(binding.locator); this.supported(before, true, binding.locator !== '.');
    if (String(before.dev) !== binding.device || String(before.ino) !== binding.inode ||
      String(before.mode) !== binding.mode || String(before.uid) !== binding.uid) erasureFail();
    this.active(); this.accounting.charge('directoryOpens');
    const handle = await fs.open(this.absolute(binding.locator), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    await this.closed(handle, async () => {
      this.accounting.charge('descriptorStats'); const opened = await handle.stat({ bigint: true });
      if (!this.sameStat(before, opened)) erasureFail();
      await prove(); this.active(); this.accounting.charge('directorySyncs'); await handle.sync();
      const after = await this.lstat(binding.locator);
      this.accounting.charge('descriptorStats'); const final = await handle.stat({ bigint: true });
      if (!this.sameStat(before, after) || !this.sameStat(before, final)) erasureFail();
      await prove();
    });
  }
  /** Exclusive staging write; publication/parent authority remain executor-owned. */
  async writeRecord(locator: string, raw: string, prove: () => Promise<void>): Promise<ErasureArtifact> {
    const bytes = Buffer.from(raw);
    if (bytes.length > ERASURE_RECORD_LIMIT) erasureFail('EHEADRESOURCE');
    await prove(); this.active(); this.accounting.charge('fileOpens'); this.accounting.charge('mutations');
    const handle = await fs.open(this.absolute(locator), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let captured!: ErasureArtifact;
    await this.closed(handle, async () => {
      let offset = 0;
      while (offset < bytes.length) {
        this.active(); this.accounting.charge('recordWrites');
        const written = await handle.write(bytes, offset, bytes.length - offset, offset);
        this.accounting.charge('recordWriteBytes', written.bytesWritten);
        if (!written.bytesWritten) erasureFail(); offset += written.bytesWritten;
      }
      this.active(); this.accounting.charge('fileSyncs'); await handle.sync();
      this.accounting.charge('descriptorStats'); const observed = await handle.stat({ bigint: true });
      this.supported(observed, false, true);
      const named = await this.lstat(locator);
      if (!this.sameStat(observed, named) || observed.size !== BigInt(bytes.length)) erasureFail();
      captured = { identity: evidenceIdentity(observed, erasureFail), mode: String(observed.mode), uid: String(observed.uid),
        links: String(observed.nlink), digest: evidenceDigest(raw) };
    });
    const qualified = await this.record(locator);
    if (!equal(qualified.identity, captured.identity) || qualified.raw !== raw || qualified.digest !== captured.digest ||
      qualified.mode !== captured.mode || qualified.uid !== captured.uid || qualified.links !== captured.links) erasureFail();
    return qualified;
  }
  async remove(locator: string, directory: boolean, archive = false): Promise<void> {
    this.active();
    if (archive) this.accounting.archiveMutation(); else this.accounting.charge('mutations');
    if (directory) await fs.rmdir(this.absolute(locator));
    else await fs.unlink(this.absolute(locator));
  }
  async rename(source: string, target: string): Promise<void> {
    this.active(); this.accounting.charge('mutations');
    await fs.rename(this.absolute(source), this.absolute(target));
  }
  binding(directory: Pick<HeadDirectory, 'locator' | 'identity' | 'mode' | 'uid'>): ErasureDirectoryBinding {
    return { locator: directory.locator, device: directory.identity.device, inode: directory.identity.inode,
      mode: directory.mode, uid: directory.uid };
  }
  async inventory(ownerId: string, forbidden: ReadonlySet<string> = new Set()): Promise<ErasureNode[]> {
    const prefix = `volumes/by-id/${ownerId}`;
    const nodes: ErasureNode[] = [], identities = new Set<string>();
    const parents: { node: ErasureNode; parent: ErasureNode | null }[] = [];
    const visit = async (locator: string, parent: ErasureNode | null, depth: number): Promise<ErasureNode> => {
      if (depth > ERASURE_DEPTH_LIMIT || identities.size === ERASURE_NODE_LIMIT) erasureFail('EHEADRESOURCE');
      const stat = await this.lstat(locator), directory = stat.isDirectory();
      this.supported(stat, directory, true);
      const physical = `${stat.dev}:${stat.ino}`;
      if (identities.has(physical) || forbidden.has(physical)) erasureFail(); identities.add(physical);
      const node: ErasureNode = { index: 0, parent: null, name: path.posix.basename(locator), directory,
        identity: evidenceIdentity(stat, erasureFail), mode: String(stat.mode), uid: String(stat.uid), links: String(stat.nlink),
        childCount: 0, sha256: erasureNamesDigest([]) };
      if (directory) {
        const observed = await this.directory(locator, true);
        if (!equal(observed.identity, node.identity)) erasureFail();
        node.childCount = observed.names.length; node.sha256 = erasureNamesDigest(observed.names);
        for (const name of observed.names) await visit(`${locator}/${name}`, node, depth + 1);
        const after = await this.lstat(locator);
        if (!equal(evidenceIdentity(after, erasureFail), node.identity)) erasureFail();
      } else if (!equal((await this.file(locator)).identity, node.identity)) erasureFail();
      node.index = nodes.length; nodes.push(node); parents.push({ node, parent }); return node;
    };
    await visit(prefix, null, 0);
    for (const item of parents) item.node.parent = item.parent?.index ?? null;
    return nodes;
  }
}

export function erasureSameDirectory(binding: ErasureDirectoryBinding, observed: Pick<HeadDirectory, 'locator' | 'identity' | 'mode' | 'uid'>): boolean {
  return binding.locator === observed.locator && binding.device === observed.identity.device &&
    binding.inode === observed.identity.inode && binding.mode === observed.mode && binding.uid === observed.uid;
}
export function erasureSameIdentity(expected: HeadIdentity, observed: HeadIdentity): boolean { return equal(expected, observed); }
