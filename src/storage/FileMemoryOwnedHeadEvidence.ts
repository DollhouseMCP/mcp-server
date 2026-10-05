/** Internal fresh evidence mechanics; callers retain lifecycle authority and state. */
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { logger } from '../utils/logger.js';
import { constants, type BigIntStats, type Dir, type Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { closeMemoryDirectoryInspection, FileMemoryDirectoryScanLimitError } from './FileMemoryDirectoryScanBudget.js';

// One failure observation per outer evidence boundary, after its cleanup and
// error composition. Nested helpers retain that scope without retaining causes.
const evidenceAuditScope = new AsyncLocalStorage<boolean>();
function auditEvidenceFailure(stage: string): void {
  try {
    evidenceAuditScope.exit(() => SecurityMonitor.logSecurityEvent({
      type: 'OPERATION_FAILED', severity: 'HIGH', source: 'FileMemoryOwnedHeadEvidence',
      details: `Evidence boundary failed; stage=${stage}; storage-outcome=unclassified; invocation=${randomUUID()}`,
    }));
  } catch {
    try { logger.warn('Memory evidence failure audit observer failed'); } catch { /* Preserve the original failure. */ }
  }
}
function observeEvidenceFailure<T>(stage: string, body: () => T): T {
  const nested = evidenceAuditScope.getStore() === true;
  const invoke = () => {
    try { return body(); } catch (cause) {
      if (!nested) auditEvidenceFailure(stage);
      throw cause;
    }
  };
  return nested ? invoke() : evidenceAuditScope.run(true, invoke);
}
async function observeEvidenceFailureAsync<T>(stage: string, body: () => Promise<T>): Promise<T> {
  const nested = evidenceAuditScope.getStore() === true;
  const invoke = async () => {
    try { return await body(); } catch (cause) {
      if (!nested) auditEvidenceFailure(stage);
      throw cause;
    }
  };
  return nested ? invoke() : evidenceAuditScope.run(true, invoke);
}

export interface HeadIdentity { device: string; inode: string; size: string; mtimeNs: string; ctimeNs: string }
export interface HeadArtifact { raw: string; digest: string; identity: HeadIdentity }
export interface HeadFileEvidence extends HeadArtifact { links: '1' | '2'; mode: string; uid: string }
export interface HeadChild { name: string; identity: HeadIdentity; mode: string; uid: string; links: string; directory: boolean }
export interface HeadDirectory { locator: string; identity: HeadIdentity; mode: string; uid: string; links: string; names: string[]; children: HeadChild[] }
export type HeadDirectoryNames = Omit<HeadDirectory, 'children'>;
export type EvidenceFail = (code?: string) => never;
export type EvidenceClose = <T>(handle: fs.FileHandle, body: () => Promise<T>) => Promise<T>;

export function evidenceCauseCode(cause: unknown): string | undefined {
  try { const value = (cause as NodeJS.ErrnoException | null | undefined)?.code; return typeof value === 'string' ? value : undefined; }
  catch { return undefined; }
}
export const evidenceDigest = (raw: string) => createHash('sha256').update(raw).digest('hex');
export function evidenceOrdinal(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
export function evidenceDecimal(value: unknown, width: number, signed = false): boolean {
  return typeof value === 'string' && (signed ? /^(?:0|-?[1-9]\d*)$/u : /^(?:0|[1-9]\d*)$/u).test(value) && value.replace('-', '').length <= width;
}
export function evidenceScalar(value: bigint, width: number, fail: EvidenceFail): string {
  const result = String(value);
  if (!evidenceDecimal(result, width, true)) fail('EHEADRESOURCE');
  return result;
}
export function evidenceIdentity(stat: BigIntStats, fail: EvidenceFail): HeadIdentity { return { device: evidenceScalar(stat.dev, 40, fail), inode: evidenceScalar(stat.ino, 40, fail), size: evidenceScalar(stat.size, 40, fail), mtimeNs: evidenceScalar(stat.mtimeNs, 40, fail), ctimeNs: evidenceScalar(stat.ctimeNs, 40, fail) }; }
export async function observeEvidenceCanonicalVolume(target: string, fail: EvidenceFail): Promise<BigIntStats | undefined> {
  return observeEvidenceFailureAsync('canonical-volume', async () => {
    try {
      const stat = await fs.lstat(target, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
      return stat;
    } catch (cause) {
      if (evidenceCauseCode(cause) === 'ENOENT') return undefined;
      throw cause;
    }
  });
}
export function evidenceVolumeIdentity(stat: BigIntStats, fail: EvidenceFail) {
  return { identity: evidenceIdentity(stat, fail), mode: evidenceScalar(stat.mode, 20, fail), uid: evidenceScalar(stat.uid, 20, fail), links: evidenceScalar(stat.nlink, 20, fail), directory: stat.isDirectory() };
}
export async function captureEvidenceConfinement(context: {
  sourceLocator(): string; tenantRoot(): string; absolute(locator: string): string;
  canonicalVolume(): Promise<BigIntStats | undefined>;
  reset(): void; admit(locator: string): void; observe(locator: string): Promise<HeadDirectory>; append(directory: HeadDirectory): void;
  validate(before: BigIntStats[], after: BigIntStats[], volumeBefore: BigIntStats | undefined, volumeAfter: BigIntStats | undefined): void;
  fail: EvidenceFail;
}): Promise<void> {
  return observeEvidenceFailureAsync('confinement', async () => {
    const first = context.sourceLocator().includes('/') ? context.absolute(context.sourceLocator().split('/')[0]) : context.tenantRoot();
    const paths = [first, context.absolute('.memory-owners'), context.absolute('.memory-fences')];
    const volumeBefore = await context.canonicalVolume();
    const before = await Promise.all(paths.map(target => fs.lstat(target, { bigint: true })));
    for (const stat of before) if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid!())) context.fail();
    const locators = new Set<string>(['.', '.memory-owners', '.memory-owners/owners']);
    let locator = '.';
    for (const component of context.sourceLocator().split('/').slice(0, -1)) { locator = locator === '.' ? component : `${locator}/${component}`; locators.add(locator); }
    // Ancestors are captured before descendants; partial capture on failure grants no authority.
    const ordered = [...locators].sort((a, b) => a.split('/').length - b.split('/').length || evidenceOrdinal(a, b));
    context.reset();
    for (const item of ordered) {
      context.admit(item);
      context.append(await context.observe(item));
    }
    const after = await Promise.all(paths.map(target => fs.lstat(target, { bigint: true })));
    const volumeAfter = await context.canonicalVolume();
    context.validate(before, after, volumeBefore, volumeAfter);
  });
}
export function evidenceKeys(value: unknown, expected: readonly string[]): value is object {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Reflect.ownKeys(value).length === expected.length &&
    Reflect.ownKeys(value).every(key => typeof key === 'string' && expected.includes(key));
}
export function evidenceValidIdentity(value: unknown): value is HeadIdentity {
  if (!evidenceKeys(value, ['device', 'inode', 'size', 'mtimeNs', 'ctimeNs'])) return false;
  const item = value as HeadIdentity;
  return ['device', 'inode', 'size'].every(key => evidenceDecimal(item[key as keyof HeadIdentity], 40)) &&
    ['mtimeNs', 'ctimeNs'].every(key => evidenceDecimal(item[key as keyof HeadIdentity], 40, true));
}
// Own link/unlink changes ctime; phase checks separately bind full identity and mode/UID.
export function evidenceOriginalIdentity(a: HeadIdentity, b: HeadIdentity): boolean { return a.device === b.device && a.inode === b.inode && a.size === b.size && a.mtimeNs === b.mtimeNs; }
export function canonicalEvidence(value: unknown, fieldOrder: readonly string[], fail: EvidenceFail): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalEvidence(item, fieldOrder, fail));
  if (value && typeof value === 'object') {
    const result: { [key: string]: unknown } = {};
    for (const key of fieldOrder) if (Object.hasOwn(value, key)) result[key] = canonicalEvidence((value as { [key: string]: unknown })[key], fieldOrder, fail);
    if (Object.keys(result).length !== Reflect.ownKeys(value).length) fail();
    return result;
  }
  return value;
}
export function stableEvidenceChild(child: HeadChild): HeadChild {
  return child.directory ? { ...child, links: '0', identity: { ...child.identity, size: '0', mtimeNs: '0', ctimeNs: '0' } } : child;
}

/** Retained weighted namespace/read accounting; executors own reservation arithmetic. */
export class OwnedHeadEvidenceBudget {
  consumed = 0;
  protected ceiling = 8192;
  get limit(): number { return this.ceiling; }
  private weights?: Map<string, number>;
  protected reserveWeights(slots: Map<string, string[]>): { P: number; q(locator: string): number } {
    if (this.weights) throw new FileMemoryDirectoryScanLimitError();
    this.weights = new Map([...slots].map(([locator, names]) => [locator, new Set(names).size + 1]));
    const P = [...this.weights.values()].reduce((sum, value) => sum + value, 0);
    if (P > 4096) throw new FileMemoryDirectoryScanLimitError();
    const q = (locator: string) => this.weights!.get(locator)! + (locator === '.' ? 0 : this.weights!.get(path.posix.dirname(locator)) ?? 0);
    return { P, q };
  }
  protected chargeRead(): void {
    if (this.consumed >= this.limit) throw new FileMemoryDirectoryScanLimitError();
    this.consumed++;
  }
  check(locator: string, names: string[]): void {
    const weight = this.weights?.get(locator);
    if (weight !== undefined && names.length + 1 > weight) throw new FileMemoryDirectoryScanLimitError();
  }
}

function artifact(raw: string, captured: HeadIdentity): HeadArtifact { return { raw, digest: evidenceDigest(raw), identity: captured }; }
export async function inspectEvidenceNames(target: string, inspect: (name: string) => void,
  read: (directory: Dir) => Promise<Dirent | null>, closeMessage: string): Promise<void> {
  return observeEvidenceFailureAsync('directory-census', async () => {
    const directory = await fs.opendir(target); let primary: { cause: unknown } | undefined;
    try {
      let attempts = 0;
      while (true) {
        if (attempts++ >= 4096) throw new FileMemoryDirectoryScanLimitError();
        const entry = await read(directory); if (!entry) break;
        if (Buffer.byteLength(entry.name) > 255 || Buffer.from(entry.name).toString('utf8') !== entry.name) throw new FileMemoryDirectoryScanLimitError();
        inspect(entry.name);
      }
    } catch (cause) { primary = { cause }; }
    await closeMemoryDirectoryInspection(directory, primary, closeMessage);
  });
}
export async function withEvidenceFileClose<T>(handle: fs.FileHandle, body: () => Promise<T>,
  dualFailure: (primary: unknown, close: unknown) => Error): Promise<T> {
  return observeEvidenceFailureAsync('file-close', async () => {
    let value!: T, primary: { cause: unknown } | undefined;
    try { value = await body(); } catch (cause) { primary = { cause }; }
    try { await handle.close(); } catch (error_) {
      if (primary) throw dualFailure(primary.cause, error_);
      throw error_;
    }
    if (primary) throw primary.cause;
    return value;
  });
}
export async function observeEvidenceDirectory(locator: string, target: string, full: boolean,
  scan: (inspect: (name: string) => void) => Promise<void>, check: (names: string[]) => void,
  fail: EvidenceFail): Promise<HeadDirectory | HeadDirectoryNames> {
  return observeEvidenceFailureAsync('directory-observation', async () => {
    const before = await fs.lstat(target, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== BigInt(process.getuid!()) ||
      ((locator === '.memory-owners' || locator.startsWith('.memory-owners/')) && (before.mode & 0o777n) !== 0o700n)) fail();
    const names: string[] = []; await scan(name => names.push(name)); names.sort(evidenceOrdinal);
    check(names);
    if (new Set(names).size !== names.length) fail();
    const children: HeadChild[] = [];
    for (let offset = 0; full && offset < names.length; offset += 16) {
      const observed = await Promise.allSettled(names.slice(offset, offset + 16).map(async name => {
        const stat = await fs.lstat(path.join(target, name), { bigint: true });
        return { name, identity: evidenceIdentity(stat, fail), mode: evidenceScalar(stat.mode, 20, fail), uid: evidenceScalar(stat.uid, 20, fail), links: evidenceScalar(stat.nlink, 20, fail), directory: stat.isDirectory() };
      }));
      for (const result of observed) {
        if (result.status === 'rejected') throw result.reason;
        children.push(result.value);
      }
    }
    const after = await fs.lstat(target, { bigint: true });
    if (!equal(evidenceIdentity(before, fail), evidenceIdentity(after, fail)) || before.nlink !== after.nlink || before.mode !== after.mode || before.uid !== after.uid) fail();
    const base = { locator, identity: evidenceIdentity(after, fail), mode: evidenceScalar(after.mode, 20, fail), uid: evidenceScalar(after.uid, 20, fail), links: evidenceScalar(after.nlink, 20, fail), names };
    return full ? { ...base, children } : base;
  });
}
export async function readEvidenceFile(target: string, maximum: number, links: '1' | '2', privateFile: boolean,
  active: () => void, closed: EvidenceClose, fail: EvidenceFail): Promise<HeadFileEvidence> {
  return observeEvidenceFailureAsync('file-read', async () => {
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return closed(handle, async () => {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== BigInt(links) || before.uid !== BigInt(process.getuid!()) ||
        (privateFile && (before.mode & 0o777n) !== 0o600n) || before.size > BigInt(maximum)) fail();
      const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
      while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) fail();
        offset += read.bytesRead; }
      const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const after = await handle.stat({ bigint: true }), named = await fs.lstat(target, { bigint: true });
      if (!equal(evidenceIdentity(before, fail), evidenceIdentity(after, fail)) || !equal(evidenceIdentity(after, fail), evidenceIdentity(named, fail)) || before.nlink !== named.nlink || before.mode !== named.mode || before.uid !== named.uid) fail();
      active(); return { ...artifact(raw, evidenceIdentity(after, fail)), links, mode: evidenceScalar(before.mode, 20, fail), uid: evidenceScalar(before.uid, 20, fail) };
    });
  });
}
export function applyEvidenceDirectoryTransition(directories: HeadDirectory[], index: number, before: HeadDirectory,
  after: HeadDirectory, delta: { add: string[]; remove: string[]; changed: string[] }, fail: EvidenceFail): void {
  return observeEvidenceFailure('directory-transition', () => {
    const { add, remove, changed } = delta;
    if (!equal(after.names, before.names.filter(name => !remove.includes(name)).concat(add).sort(evidenceOrdinal)) ||
      !['device', 'inode'].every(key => before.identity[key as keyof HeadIdentity] === after.identity[key as keyof HeadIdentity]) || before.mode !== after.mode || before.uid !== after.uid) fail();
    const children = new Map(after.children.map(child => [child.name, child]));
    for (const child of before.children) if (!remove.includes(child.name) && !changed.includes(child.name) && !equal(child, children.get(child.name))) fail();
    directories[index] = after;
  });
}
export function applyEvidenceAncestorTransition(directories: HeadDirectory[], index: number, before: HeadDirectory,
  fresh: HeadDirectory, name: string, fail: EvidenceFail): void {
  return observeEvidenceFailure('ancestor-transition', () => {
    if (!equal(before.identity, fresh.identity) || !equal(before.names, fresh.names) || before.mode !== fresh.mode || before.uid !== fresh.uid || before.links !== fresh.links) fail();
    const observed = new Map(fresh.children.map(child => [child.name, child]));
    for (const child of before.children) if (!equal(child.name === name ? stableEvidenceChild(child) : child,
      child.name === name ? stableEvidenceChild(observed.get(child.name)!) : observed.get(child.name))) fail();
    directories[index] = fresh;
  });
}
export function admitEvidenceAncestor(item: string, directories: readonly HeadDirectory[], fail: EvidenceFail): void {
  return observeEvidenceFailure('ancestor-admission', () => {
    if (item !== '.') {
      const parent = directories.find(directory => directory.locator === path.posix.dirname(item));
      const name = path.posix.basename(item);
      if (!parent?.names.includes(name)) fail();
      const aliases = parent.children.filter(child => child.name !== name && child.name.toLowerCase() === name.toLowerCase());
      if (aliases.length) {
        const actual = parent.children.find(child => child.name === name)!;
        if (parent.locator !== '.' || !['.memory-owners', '.memory-fences', 'volumes'].includes(name.toLowerCase()) || !actual.directory ||
          aliases.some(child => !child.directory || (child.identity.device === actual.identity.device && child.identity.inode === actual.identity.inode))) fail();
      }
    }
  });
}
export interface ExclusiveEvidenceWrite {
  active(): void;
  proof(): Promise<void>;
  markResidual(): void;
  closed: EvidenceClose;
  read(target: string, maximum: number): Promise<HeadFileEvidence>;
  track(target: string, evidence: HeadFileEvidence): void;
  transition(target: string, add?: string[], remove?: string[], changed?: string[]): Promise<void>;
  partialBarrier(): Promise<void>;
  containingDevice(target: string): string;
  fail: EvidenceFail;
}
export async function writeEvidenceFile(target: string, raw: string, limit: number, context: ExclusiveEvidenceWrite): Promise<HeadArtifact> {
  return observeEvidenceFailureAsync('file-write', async () => {
    if (Buffer.byteLength(raw) > limit) context.fail('EHEADRESOURCE');
    await context.proof(); context.active();
    context.markResidual();
    const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const captured = await context.closed(handle, async () => {
      const bytes = Buffer.from(raw); let split = Math.floor(bytes.length / 2);
      while (split > 0 && (bytes[split] & 0xc0) === 0x80) split--;
      const write = async (part: Buffer) => {
        let offset = 0;
        while (offset < part.length) { context.active(); const result = await handle.write(part, offset, part.length - offset, null); context.active(); if (!result.bytesWritten) context.fail();
          offset += result.bytesWritten; }
      };
      await write(bytes.subarray(0, split));
      const original = await handle.stat({ bigint: true }), part = await context.read(target, split), observed = await handle.stat({ bigint: true });
      if (!original.isFile() || original.nlink !== 1n || original.uid !== BigInt(process.getuid!()) || (original.mode & 0o777n) !== 0o600n ||
        !equal(evidenceIdentity(original, context.fail), evidenceIdentity(observed, context.fail)) || !equal(part.identity, evidenceIdentity(original, context.fail)) || part.mode !== evidenceScalar(original.mode, 20, context.fail) ||
        part.uid !== evidenceScalar(original.uid, 20, context.fail) || !Buffer.from(part.raw).equals(bytes.subarray(0, split))) context.fail();
      context.track(target, part);
      await context.transition(path.dirname(target), [path.basename(target)]); await context.partialBarrier();
      await write(bytes.subarray(split)); context.active(); await handle.sync(); context.active(); return evidenceIdentity(await handle.stat({ bigint: true }), context.fail);
    });
    const file = await context.read(target, Buffer.byteLength(raw));
    const device = context.containingDevice(target);
    if (file.raw !== raw || !equal(file.identity, captured) || file.identity.device !== device) context.fail();
    context.track(target, file); await context.transition(path.dirname(target), [], [], [path.basename(target)]); return artifact(file.raw, file.identity);
  });
}
