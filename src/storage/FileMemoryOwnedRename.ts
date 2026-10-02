/** Dormant same-existing-parent RENAME; ambiguous mutation gaps remain manual. */
import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats, type Dir, type Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { FileMemoryDirectoryScanLimitError } from './FileMemoryDirectoryScanBudget.js';
import type { OwnedFileMemoryToken, FileMemorySnapshot } from './FileMemoryOwnerSnapshots.js';
import { MEMORY_CONSTANTS } from '../elements/memories/constants.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import type { FileMemoryOperationScope } from './FileMemoryTransactionCoordinator.js';

import { evidenceCauseCode as causeCode, evidenceDigest as digest, evidenceOrdinal as ordinal, evidenceDecimal as decimal,
  evidenceScalar, evidenceIdentity, evidenceKeys as keys, evidenceValidIdentity as validIdentity,
  evidenceOriginalIdentity as original, canonicalEvidence, stableEvidenceChild as stable, inspectEvidenceNames,
  withEvidenceFileClose, observeEvidenceDirectory, readEvidenceFile, admitEvidenceAncestor, writeEvidenceFile,
  type HeadIdentity as Identity, type HeadArtifact as Artifact, type HeadChild as Child,
  type HeadDirectory as Directory, type HeadDirectoryNames as DirectoryNames, type HeadFileEvidence as FileEvidence } from './FileMemoryOwnedHeadEvidence.js';

interface TransitionDelta { add: string[]; remove: string[]; changed: string[]; removed: ReadonlyMap<string, FileEvidence> }

export interface RenameOwnedRequest { readonly operationId: string; readonly expectedToken: OwnedFileMemoryToken; readonly destinationLocator: string }
export type RenamePublication = 'partial-base' | 'partial-reservation' | 'partial-prepared' | 'partial-linked' | 'partial-moved' |
  'partial-destination-sidecar' | 'partial-destination-metadata' | 'partial-registry' | 'partial-metadata' | 'partial-final' |
  'base-durable' | 'reservation-durable' | 'prepared-durable' | 'linked-durable' | 'moved-durable' |
  'destination-metadata-durable' | 'metadata-durable' | 'final-durable' | 'before-link' | 'after-link' |
  'after-source-unlink' | 'after-destination-sidecar' | 'after-registry' | 'before-old-sidecar' | 'after-old-sidecar' |
  'before-source-journal' | 'after-source-journal' | 'before-final' | 'after-final' | 'after-audit' | 'before-return';
type State = 'BASE_RENAME' | 'RESERVED_RENAME' | 'PREPARED_RENAME' | 'LINKED_RENAME' | 'MOVED_RENAME' |
  'DESTINATION_METADATA_RENAME' | 'METADATA_RENAME' | 'FINAL_RENAME';
interface Commitment { locator: string; device: string; inode: string; mode: string; uid: string; childCount: number; domain: string; sha256: string }
interface Historical { digest: string; identity: Identity }
interface Binding { userId: string; ownerId: string; operationId: string; sourceLocator: string; destinationLocator: string;
  oldRevision: string; newRevision: string; contentHash: string; contentBytes: number; originalSourceIdentity: Identity }
interface Baseline { sourceSidecar: Artifact; registry: Artifact; originalChildren: { head: Child; sourceSidecar: Child; registry: Child }; namespace: Commitment[] }
interface RecordBase { schema: 4; state: State; binding: Binding }
interface SourceRecord extends RecordBase { baseline: Baseline; originalSourceJournal?: Historical; reservation?: Historical;
  prior?: Historical & { state: State }; currentHead?: { identity: Identity; links: '1' | '2' }; destinationSidecar?: Artifact; newRegistry?: Artifact }
interface ReservationRecord extends RecordBase { state: 'RESERVED_RENAME'; originalSourceJournal: Historical }
interface FinalRecord extends RecordBase { state: 'FINAL_RENAME'; sourceFinalJournal: { record: SourceRecord; digest: string; identity: Identity };
  prior: Historical & { state: 'RESERVED_RENAME' } }
type Record = SourceRecord | ReservationRecord | FinalRecord;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const DOMAIN = 'dollhouse.rename.schema4.full-children.v1';
const RAW_HEAD_LIMIT = 3 * MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE;
const PATH_LIMIT = process.platform === 'linux' ? 4096 : 1024;
const LIMIT = 8192, MAX_REVISION = 9223372036854775807n;
const states = new Set<State>(['BASE_RENAME', 'RESERVED_RENAME', 'PREPARED_RENAME', 'LINKED_RENAME', 'MOVED_RENAME', 'DESTINATION_METADATA_RENAME', 'METADATA_RENAME', 'FINAL_RENAME']);
function fail(code = 'EOWNERRECOVERY'): never { throw Object.assign(new Error('Managed RENAME evidence is unsafe or changed'), { code }); }
function scalar(value: bigint, width = 40): string { return evidenceScalar(value, width, fail); }
function identity(stat: BigIntStats): Identity { return evidenceIdentity(stat, fail); }
function validLocator(value: unknown): value is string {
  return typeof value === 'string' && !!value && Buffer.byteLength(value) <= 1024 && Buffer.from(value).toString('utf8') === value &&
    !value.includes('\\') && !value.includes('\0') && !path.win32.isAbsolute(value) &&
    !/^\.[0-9a-f]{64}\.memory-(?:owner\.json|write)(?:\.|$)/iu.test(path.posix.basename(value)) && value.split('/').every(part => !!part && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255) && !path.isAbsolute(value);
}
export function captureRenameRequest(input: RenameOwnedRequest): RenameOwnedRequest {
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new TypeError('Managed RENAME is qualified only on Linux and Darwin');
  if (!keys(input, ['operationId', 'expectedToken', 'destinationLocator'])) throw new TypeError('RENAME requires operationId, expectedToken and destinationLocator');
  const { operationId, destinationLocator, expectedToken: token } = input;
  if (typeof operationId !== 'string' || !UUID.test(operationId) || !validLocator(destinationLocator) || !keys(token, ['backend', 'ownership', 'userId', 'tenantRoot', 'locator', 'ownerId', 'revision', 'contentHash', 'fileIdentity']) ||
    token.backend !== 'file' || token.ownership !== 'owned' || !UUID.test(token.ownerId) || !HASH.test(token.contentHash) || !validIdentity(token.fileIdentity) ||
    !validLocator(token.locator) || !decimal(token.revision, 19) || BigInt(token.revision) < 1n || BigInt(token.revision) >= MAX_REVISION ||
    typeof token.userId !== 'string' || !token.userId || Buffer.byteLength(token.userId) > 128 || typeof token.tenantRoot !== 'string' ||
    path.posix.dirname(token.locator) !== path.posix.dirname(destinationLocator) || path.posix.basename(token.locator).toLowerCase() === path.posix.basename(destinationLocator).toLowerCase() ||
    [token.locator, destinationLocator].some(locator => ['.memory-owners', '.memory-fences', 'volumes'].includes(locator.includes('/') ? locator.split('/')[0] : locator.toLowerCase()))) throw new TypeError('Unsupported managed RENAME request');
  return Object.freeze({ operationId, destinationLocator, expectedToken: Object.freeze({ ...token, fileIdentity: Object.freeze({ ...token.fileIdentity }) }) });
}
const fieldOrder = ['schema', 'state', 'binding', 'baseline', 'originalSourceJournal', 'reservation', 'prior', 'currentHead', 'destinationSidecar', 'newRegistry',
  'sourceFinalJournal', 'record', 'raw', 'digest', 'identity', 'userId', 'ownerId', 'operationId', 'sourceLocator', 'destinationLocator', 'oldRevision', 'newRevision',
  'contentHash', 'contentBytes', 'originalSourceIdentity', 'sourceSidecar', 'registry', 'originalChildren', 'head', 'namespace', 'locator', 'device', 'inode', 'size',
  'mtimeNs', 'ctimeNs', 'mode', 'uid', 'links', 'directory', 'name', 'childCount', 'domain', 'sha256'];
function canonical(value: unknown): unknown { return canonicalEvidence(value, fieldOrder, fail); }
function serialize(record: Record): string {
  const raw = JSON.stringify(canonical(record));
  if (Buffer.byteLength(raw) > LIMIT) fail('EHEADRESOURCE');
  return raw;
}
function artifact(raw: string, captured: Identity): Artifact { return { raw, digest: digest(raw), identity: captured }; }
function validArtifact(value: unknown): value is Artifact {
  if (!keys(value, ['raw', 'digest', 'identity'])) return false;
  const item = value as Artifact;
  return typeof item.raw === 'string' && Buffer.byteLength(item.raw) <= LIMIT && HASH.test(item.digest) && digest(item.raw) === item.digest && validIdentity(item.identity) && item.identity.size === String(Buffer.byteLength(item.raw));
}
function validHistory(value: unknown, withState = false): boolean {
  if (!keys(value, withState ? ['state', 'digest', 'identity'] : ['digest', 'identity'])) return false;
  const item = value as Historical & { state?: State };
  return HASH.test(item.digest) && validIdentity(item.identity) && BigInt(item.identity.size) <= BigInt(LIMIT) && (!withState || states.has(item.state!));
}
function validChild(item: Child): boolean {
  return keys(item, ['name', 'identity', 'mode', 'uid', 'links', 'directory']) && typeof item.name === 'string' && !!item.name && !item.name.includes('/') &&
    validIdentity(item.identity) && decimal(item.mode, 20) && decimal(item.uid, 20) && decimal(item.links, 20) && typeof item.directory === 'boolean';
}
function validateBinding(binding: Binding): void {
  if (!keys(binding, ['userId', 'ownerId', 'operationId', 'sourceLocator', 'destinationLocator', 'oldRevision', 'newRevision', 'contentHash', 'contentBytes', 'originalSourceIdentity']) ||
    typeof binding.userId !== 'string' || !binding.userId || Buffer.byteLength(binding.userId) > 128 || !UUID.test(binding.ownerId) || typeof binding.operationId !== 'string' || !UUID.test(binding.operationId) ||
    !validLocator(binding.sourceLocator) || !validLocator(binding.destinationLocator) || path.posix.dirname(binding.sourceLocator) !== path.posix.dirname(binding.destinationLocator) ||
    path.posix.basename(binding.sourceLocator).toLowerCase() === path.posix.basename(binding.destinationLocator).toLowerCase() ||
    !decimal(binding.oldRevision, 19) || !decimal(binding.newRevision, 19) || BigInt(binding.oldRevision) < 1n || BigInt(binding.newRevision) !== BigInt(binding.oldRevision) + 1n || BigInt(binding.newRevision) > MAX_REVISION ||
    !HASH.test(binding.contentHash) || !Number.isSafeInteger(binding.contentBytes) || binding.contentBytes < 0 || binding.contentBytes > RAW_HEAD_LIMIT || !validIdentity(binding.originalSourceIdentity) || binding.originalSourceIdentity.size !== String(binding.contentBytes)) fail();
}
function validateBaseline(baseline: Baseline): void {
  if (!keys(baseline, ['sourceSidecar', 'registry', 'originalChildren', 'namespace']) || !validArtifact(baseline.sourceSidecar) || !validArtifact(baseline.registry) ||
    !keys(baseline.originalChildren, ['head', 'sourceSidecar', 'registry']) || !Object.values(baseline.originalChildren).every(validChild) ||
    !Array.isArray(baseline.namespace) || !baseline.namespace.length) fail();
  for (const entry of baseline.namespace) if (!keys(entry, ['locator', 'device', 'inode', 'mode', 'uid', 'childCount', 'domain', 'sha256']) ||
    (entry.locator !== '.' && !validLocator(entry.locator)) || !decimal(entry.device, 40) || !decimal(entry.inode, 40) || !decimal(entry.mode, 20) || !decimal(entry.uid, 20) ||
    !Number.isInteger(entry.childCount) || entry.childCount < 0 || entry.childCount > 4095 || entry.domain !== DOMAIN || !HASH.test(entry.sha256)) fail();
}
function validateFinal(final: FinalRecord, common: string[]): void {
  if (!keys(final, [...common, 'sourceFinalJournal', 'prior']) || !keys(final.sourceFinalJournal, ['record', 'digest', 'identity']) || !validHistory(final.prior, true) || final.prior.state !== 'RESERVED_RENAME') fail();
  const terminal = final.sourceFinalJournal.record;
  if (terminal?.state !== 'METADATA_RENAME') fail();
  validateRecord(terminal);
  const raw = serialize(terminal);
  if (!equal(terminal.binding, final.binding) || digest(raw) !== final.sourceFinalJournal.digest || !validIdentity(final.sourceFinalJournal.identity) ||
    final.sourceFinalJournal.identity.size !== String(Buffer.byteLength(raw)) || !equal(terminal.reservation, { digest: final.prior.digest, identity: final.prior.identity })) fail();
}
function validateRecord(record: Record): void {
  if (record?.schema !== 4 || !states.has(record.state)) fail();
  validateBinding(record.binding);
  const common = ['schema', 'state', 'binding'];
  if (record.state === 'FINAL_RENAME') {
    validateFinal(record as FinalRecord, common);
    return;
  }
  if (record.state === 'RESERVED_RENAME') {
    if (!keys(record, [...common, 'originalSourceJournal']) || !validHistory(record.originalSourceJournal)) fail();
    return;
  }
  const source = record as SourceRecord;
  const extras = source.state === 'BASE_RENAME' ? [] : ['originalSourceJournal', 'reservation', 'prior', 'currentHead'];
  if (['DESTINATION_METADATA_RENAME', 'METADATA_RENAME'].includes(source.state)) extras.push('destinationSidecar');
  if (source.state === 'METADATA_RENAME') extras.push('newRegistry');
  if (!keys(source, [...common, 'baseline', ...extras])) fail();
  validateBaseline(source.baseline);
  if (source.state === 'BASE_RENAME') return;
  validateSourceHistory(source);
}
function validateSourceHistory(source: SourceRecord): void {
  const previous: { [key: string]: State } = { PREPARED_RENAME: 'BASE_RENAME', LINKED_RENAME: 'PREPARED_RENAME', MOVED_RENAME: 'LINKED_RENAME', DESTINATION_METADATA_RENAME: 'MOVED_RENAME', METADATA_RENAME: 'DESTINATION_METADATA_RENAME' };
  if (!validHistory(source.originalSourceJournal) || !validHistory(source.reservation) || !validHistory(source.prior, true) || source.prior!.state !== previous[source.state] ||
    (source.state === 'PREPARED_RENAME' && !equal(source.currentHead?.identity, source.binding.originalSourceIdentity)) ||
    !keys(source.currentHead, ['identity', 'links']) || !validIdentity(source.currentHead!.identity) || !original(source.currentHead!.identity, source.binding.originalSourceIdentity) ||
    source.currentHead!.links !== (source.state === 'LINKED_RENAME' ? '2' : '1') || (source.destinationSidecar && !validArtifact(source.destinationSidecar)) || (source.newRegistry && !validArtifact(source.newRegistry))) fail();
}
function parse(raw: string): Record {
  let record: Record; try { record = JSON.parse(raw) as Record; } catch { fail(); }
  validateRecord(record);
  if (serialize(record) !== raw) fail();
  return record;
}

class RenameBudget {
  consumed = 0;
  private ceiling = 8192;
  get limit(): number { return this.ceiling; }
  private weights?: Map<string, number>;
  reserve(slots: Map<string, string[]>, head: string): void {
    if (this.weights) throw new FileMemoryDirectoryScanLimitError();
    this.weights = new Map([...slots].map(([locator, names]) => [locator, new Set(names).size + 1]));
    const P = [...this.weights.values()].reduce((sum, value) => sum + value, 0);
    if (P > 4096) throw new FileMemoryDirectoryScanLimitError();
    const q = (locator: string) => this.weights!.get(locator)! + (locator === '.' ? 0 : this.weights!.get(path.posix.dirname(locator)) ?? 0);
    // 89P forward +31P barriers +1P baseline +9P source reader.
    // Disjoint head/ancestor and registry/ownership roles give qH+qR<=P;
    // with retained discovery this is <=160P, inside the selected194P ceiling.
    this.ceiling = this.consumed + 130 * P + 29 * q(head) + 3 * q('.memory-owners/owners');
    if (this.limit > 794624) throw new FileMemoryDirectoryScanLimitError();
  }
  private read(directory: Dir): Promise<Dirent | null> {
    if (this.consumed >= this.limit) throw new FileMemoryDirectoryScanLimitError();
    this.consumed++; return directory.read();
  }
  scan(target: string, inspect: (name: string) => void): Promise<void> {
    return inspectEvidenceNames(target, inspect, directory => this.read(directory), 'RENAME directory inspection and close failed');
  }
  check(locator: string, names: string[]): void {
    const weight = this.weights?.get(locator);
    if (weight !== undefined && names.length + 1 > weight) throw new FileMemoryDirectoryScanLimitError();
  }
}
function commitment(directory: Directory): Commitment {
  const children = directory.children.map(stable).map(child => [child.name, child.directory, child.identity.device, child.identity.inode,
    child.identity.size, child.identity.mtimeNs, child.identity.ctimeNs, child.mode, child.uid, child.links]);
  return { locator: directory.locator, device: directory.identity.device, inode: directory.identity.inode, mode: directory.mode, uid: directory.uid,
    childCount: children.length, domain: DOMAIN, sha256: digest(JSON.stringify([DOMAIN, directory.locator, directory.identity.device, directory.identity.inode, directory.mode, directory.uid, children])) };
}
export class FileMemoryOwnedRename {
  private readonly budget = new RenameBudget();
  private directories: Directory[] = [];
  private readonly files = new Map<string, Artifact & { links: '1' | '2'; mode: string; uid: string }>();
  private record!: SourceRecord;
  private final?: FinalRecord;
  private binding!: Binding;
  private source = ''; private destination = ''; private sourceJournal = ''; private destinationJournal = '';
  private sourceSidecar = ''; private destinationSidecar = ''; private registry = '';
  private readonly invocationId = randomUUID();
  private readonly closeFailures = new WeakMap<object, { cause: unknown; closeCause: unknown }>();
  private linkConflict = false;
  private attempted = false; private residual = false; private committed?: OwnedFileMemoryToken;
  constructor(private readonly scope: FileMemoryOperationScope, private readonly request: RenameOwnedRequest, private readonly active: () => void,
    private readonly reader: (budget: RenameBudget) => Promise<FileMemorySnapshot>, private readonly hook: ((phase: RenamePublication) => void | Promise<void>) | undefined,
    private readonly capture: (token: OwnedFileMemoryToken) => void) {}
  private absolute(locator: string): string { return locator === '.' ? this.scope.tenantRoot : path.join(this.scope.tenantRoot, locator); }
  private relative(target: string): string { return path.relative(this.scope.tenantRoot, target).split(path.sep).join('/') || '.'; }
  private closed<T>(handle: fs.FileHandle, body: () => Promise<T>): Promise<T> {
    return withEvidenceFileClose(handle, body, (cause, closeCause) => {
      const error = new Error('RENAME operation and close failed'); this.closeFailures.set(error, { cause, closeCause }); return error;
    });
  }
  private observe(locator: string, full: true): Promise<Directory>;
  private observe(locator: string, full: false): Promise<DirectoryNames>;
  private observe(locator: string, full: boolean): Promise<Directory | DirectoryNames> {
    const target = this.absolute(locator);
    return observeEvidenceDirectory(locator, target, full,
      inspect => this.budget.scan(target, inspect), names => this.budget.check(locator, names), fail);
  }
  private read(target: string, maximum: number, links: '1' | '2' = '1', privateFile = true): Promise<Artifact & { links: '1' | '2'; mode: string; uid: string }> {
    return readEvidenceFile(target, maximum, links, privateFile, () => this.active(), (handle, body) => this.closed(handle, body), fail);
  }
  private async proof(full = false): Promise<void> {
    for (const before of this.directories) {
      const current = full ? await this.observe(before.locator, true) : await this.observe(before.locator, false);
      const { children: _children, ...names } = before;
      if (!equal(current, full ? before : names)) fail();
    }
    for (const [target, before] of this.files) if (!equal(await this.read(target, Buffer.byteLength(before.raw), before.links,
      target !== this.source && target !== this.destination), before)) fail();
    this.active();
  }
  /** Names remain fresh; targeted reads must finish inside this selected-directory sandwich. */
  private async observeTransition(locator: string, inspect: () => Promise<void>): Promise<DirectoryNames> {
    const target = this.absolute(locator), before = await fs.lstat(target, { bigint: true });
    const captured = await this.observe(locator, false);
    await inspect();
    const after = await fs.lstat(target, { bigint: true });
    if (!equal(identity(before), captured.identity) || !equal(captured.identity, identity(after)) ||
      scalar(before.mode, 20) !== captured.mode || scalar(after.mode, 20) !== captured.mode ||
      scalar(before.uid, 20) !== captured.uid || scalar(after.uid, 20) !== captured.uid ||
      scalar(before.nlink, 20) !== captured.links || scalar(after.nlink, 20) !== captured.links) fail();
    return captured;
  }
  private validateTransitionDelta(target: string, before: Directory, delta: TransitionDelta): void {
    const { add, remove, changed, removed } = delta;
    const all = [...add, ...remove, ...changed], old = new Map(before.children.map(child => [child.name, child]));
    if (new Set(all).size !== all.length || all.some(name => path.basename(name) !== name) ||
      add.some(name => old.has(name)) || [...remove, ...changed].some(name => !old.has(name)) || removed.size !== remove.length) fail();
    for (const name of remove) {
      const item = path.join(target, name), expected = removed.get(item), child = old.get(name)!;
      if (!expected || this.files.has(item) || child.directory || !equal(child.identity, expected.identity) ||
        child.mode !== expected.mode || child.uid !== expected.uid || child.links !== expected.links) fail();
    }
  }
  private async captureTransitionFiles(target: string, delta: TransitionDelta): Promise<Map<string, Child>> {
    const refreshed = new Map<string, Child>();
    for (const name of [...delta.add, ...delta.changed]) {
      const item = path.join(target, name), expected = this.files.get(item);
      if (!expected) fail();
      const actual = await this.read(item, Buffer.byteLength(expected.raw), expected.links,
        item !== this.source && item !== this.destination);
      if (!equal(actual, expected)) fail();
      this.bindContainingDevice(item, actual.identity);
      refreshed.set(name, { name, identity: actual.identity, mode: actual.mode, uid: actual.uid,
        links: actual.links, directory: false });
    }
    for (const name of delta.remove) await this.absent(path.join(target, name));
    return refreshed;
  }
  private async transition(target: string, add: string[] = [], remove: string[] = [], changed: string[] = [],
    removed: ReadonlyMap<string, FileEvidence> = new Map()): Promise<void> {
    const index = this.directories.findIndex(item => item.locator === this.relative(target)), before = this.directories[index];
    if (!before) fail();
    const delta = { add, remove, changed, removed }; this.validateTransitionDelta(target, before, delta);
    let refreshed!: Map<string, Child>;
    const after = await this.observeTransition(before.locator, async () => { refreshed = await this.captureTransitionFiles(target, delta); });
    if (!equal(after.names, before.names.filter(name => !remove.includes(name)).concat(add).sort(ordinal)) ||
      !['device', 'inode'].every(key => before.identity[key as keyof Identity] === after.identity[key as keyof Identity]) ||
      before.mode !== after.mode || before.uid !== after.uid) fail();
    // Only exact own deltas change. Unrelated descriptors remain the original expected tuples.
    const children = before.children.filter(child => !remove.includes(child.name))
      .map(child => refreshed.get(child.name) ?? child).concat(add.map(name => refreshed.get(name)!))
      .sort((a, b) => ordinal(a.name, b.name));
    this.directories[index] = { ...after, children };
    await this.transitionAncestor(target, index);
    await this.proof();
  }
  private async transitionAncestor(target: string, index: number): Promise<void> {
    const ancestorIndex = this.directories.findIndex(item => this.absolute(item.locator) === path.dirname(target));
    if (ancestorIndex >= 0 && ancestorIndex !== index) {
      const ancestor = this.directories[ancestorIndex], selected = this.directories[index], name = path.basename(target);
      let child!: Child;
      const fresh = await this.observeTransition(ancestor.locator, async () => {
        const stat = await fs.lstat(target, { bigint: true });
        if (!stat.isDirectory() || !equal(identity(stat), selected.identity) || scalar(stat.mode, 20) !== selected.mode ||
          scalar(stat.uid, 20) !== selected.uid || scalar(stat.nlink, 20) !== selected.links) fail();
        child = { name, identity: identity(stat), mode: scalar(stat.mode, 20), uid: scalar(stat.uid, 20),
          links: scalar(stat.nlink, 20), directory: true };
      });
      if (!equal(ancestor.identity, fresh.identity) || !equal(ancestor.names, fresh.names) ||
        ancestor.mode !== fresh.mode || ancestor.uid !== fresh.uid || ancestor.links !== fresh.links ||
        !ancestor.children.some(item => item.name === name && item.directory)) fail();
      this.directories[ancestorIndex] = { ...fresh, children: ancestor.children.map(item => item.name === name ? child : item) };
    }
  }
  private async barrier(phase: RenamePublication, mandatory = false): Promise<void> { await this.hook?.(phase); await this.proof(mandatory || !!this.hook); }
  private async sync(target: string, final = false): Promise<void> {
    await this.proof(final); const expected = this.directories.find(item => item.locator === this.relative(target))!;
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    await this.closed(handle, async () => {
      const matches = async () => { const stat = await handle.stat({ bigint: true }); if (!stat.isDirectory() || !equal(identity(stat), expected.identity) || scalar(stat.mode, 20) !== expected.mode || scalar(stat.uid, 20) !== expected.uid) fail(); };
      await matches(); await this.proof(final); this.active(); await handle.sync(); await matches(); await this.proof(final);
    });
    if (final) {
      const token: OwnedFileMemoryToken = Object.freeze({ ...this.request.expectedToken, locator: this.request.destinationLocator,
        revision: this.binding.newRevision, fileIdentity: Object.freeze({ ...this.record.currentHead!.identity }) });
      this.committed = token; this.capture(token);
    } else this.active();
  }
  private write(target: string, raw: string, partial: RenamePublication): Promise<Artifact> {
    return writeEvidenceFile(target, raw, LIMIT, {
      active: () => this.active(), proof: () => this.proof(), markResidual: () => { this.residual = true; },
      closed: (handle, body) => this.closed(handle, body), read: (target, maximum) => this.read(target, maximum),
      track: (target, evidence) => { this.files.set(target, evidence); },
      transition: (target, add, remove, changed) => this.transition(target, add, remove, changed),
      partialBarrier: () => this.barrier(partial),
      containingDevice: target => this.directories.find(item => item.locator === this.relative(path.dirname(target)))!.identity.device,
      fail,
    });
  }
  private stage(target: string, state: string): string { return `${target}.rename-${this.request.operationId}.${state}.tmp`; }
  private async replace(target: string, record: Record | string, state: string, partial: RenamePublication): Promise<Artifact> {
    const old = this.files.get(target); if (!old) fail();
    const stage = this.stage(target, state), staged = await this.write(stage, typeof record === 'string' ? record : serialize(record), partial);
    await this.proof(); const removedStage = this.files.get(stage)!; this.active(); this.attempted = true; await fs.rename(stage, target);
    const published = await this.read(target, LIMIT);
    if (published.raw !== staged.raw || !original(published.identity, staged.identity)) fail();
    this.files.delete(stage); this.files.set(target, published);
    await this.transition(path.dirname(target), [], [path.basename(stage)], [path.basename(target)], new Map([[stage, removedStage]])); await this.sync(path.dirname(target));
    this.attempted = false; return artifact(published.raw, published.identity);
  }
  private history(target: string): Historical { const file = this.files.get(target);
    if (!file) fail();
    return { digest: file.digest, identity: file.identity }; }
  private async publish(next: SourceRecord, partial: RenamePublication, durable: RenamePublication): Promise<void> {
    next.prior = { state: this.record.state, ...this.history(this.sourceJournal) }; validateRecord(next);
    await this.replace(this.sourceJournal, next, next.state, partial); this.record = next; await this.barrier(durable);
  }
  private activeRaw(head: Identity): string {
    return JSON.stringify({ schema: 1, state: 'ACTIVE', userId: this.binding.userId, ownerId: this.binding.ownerId,
      locator: this.binding.destinationLocator, revision: this.binding.newRevision, contentHash: this.binding.contentHash, fileIdentity: head });
  }
  private async optional(target: string): Promise<Artifact | undefined> {
    try { const file = await this.read(target, LIMIT); this.files.set(target, file); return artifact(file.raw, file.identity); }
    catch (cause) { if (causeCode(cause) === 'ENOENT') return undefined;
      throw cause; }
  }
  private async confined(): Promise<void> {
    const first = this.request.expectedToken.locator.includes('/') ? this.absolute(this.request.expectedToken.locator.split('/')[0]) : this.scope.tenantRoot;
    const paths = [first, this.absolute('.memory-owners'), this.absolute('.memory-fences')];
    const volumeBefore = await this.canonicalVolume();
    const before = await Promise.all(paths.map(target => fs.lstat(target, { bigint: true })));
    for (const stat of before) if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid!())) fail();
    const locators = new Set<string>(['.', '.memory-owners', '.memory-owners/owners']);
    let locator = '.';
    for (const component of this.request.expectedToken.locator.split('/').slice(0, -1)) { locator = locator === '.' ? component : `${locator}/${component}`; locators.add(locator); }
    // Ancestors are captured before descendants. No directory is created by RENAME.
    const ordered = [...locators].sort((a, b) => a.split('/').length - b.split('/').length || ordinal(a, b));
    this.directories = [];
    for (const item of ordered) {
      this.admitAncestor(item);
      this.directories.push(await this.observe(item, true));
    }
    const after = await Promise.all(paths.map(target => fs.lstat(target, { bigint: true })));
    const volumeAfter = await this.canonicalVolume();
    this.validateConfinement(before, after, volumeBefore, volumeAfter);
  }
  private validateConfinement(before: BigIntStats[], after: BigIntStats[], volumeBefore: BigIntStats | undefined, volumeAfter: BigIntStats | undefined): void {
    if (!equal(volumeBefore && this.volumeIdentity(volumeBefore), volumeAfter && this.volumeIdentity(volumeAfter))) fail();
    if (volumeBefore && this.matchesSelectedDirectory(volumeBefore)) fail('EHEADCONFLICT');
    if (!before.every((stat, index) => equal(identity(stat), identity(after[index])) && stat.mode === after[index].mode && stat.uid === after[index].uid && stat.nlink === after[index].nlink)) fail();
    if (before.slice(1).some(stat => stat.dev === before[0].dev && stat.ino === before[0].ino)) fail('EHEADCONFLICT');
    if (this.matchesSelectedDirectory(before[2])) fail('EHEADCONFLICT');
    const pairs = new Set<string>();
    for (const directory of this.directories) {
      const pair = `${directory.identity.device}:${directory.identity.inode}`; if (pairs.has(pair)) fail();
      pairs.add(pair);
    }
    const H = this.directories.find(directory => directory.locator === path.posix.dirname(this.request.expectedToken.locator))!;
    if (this.directories.filter(item => item.locator === '.memory-owners' || item.locator === '.memory-owners/owners').some(item =>
      item.identity.device === H.identity.device && item.identity.inode === H.identity.inode)) fail('EHEADCONFLICT');
  }
  private matchesSelectedDirectory(stat: BigIntStats): boolean {
    return this.directories.some(directory => directory.identity.device === String(stat.dev) && directory.identity.inode === String(stat.ino));
  }
  private async canonicalVolume(): Promise<BigIntStats | undefined> {
    try {
      const stat = await fs.lstat(this.absolute('volumes'), { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
      return stat;
    } catch (cause) {
      if (causeCode(cause) === 'ENOENT') return undefined;
      throw cause;
    }
  }
  private volumeIdentity(stat: BigIntStats) {
    return { identity: identity(stat), mode: scalar(stat.mode, 20), uid: scalar(stat.uid, 20), links: scalar(stat.nlink, 20), directory: stat.isDirectory() };
  }
  private admitAncestor(item: string): void { admitEvidenceAncestor(item, this.directories, fail); }
  private paths(): void {
    this.source = this.absolute(this.request.expectedToken.locator); this.destination = this.absolute(this.request.destinationLocator);
    const side = (target: string, suffix: string) => path.join(path.dirname(target), `.${digest(path.basename(target))}.${suffix}`);
    this.sourceJournal = side(this.source, 'memory-write.json'); this.destinationJournal = side(this.destination, 'memory-write.json');
    this.sourceSidecar = side(this.source, 'memory-owner.json'); this.destinationSidecar = side(this.destination, 'memory-owner.json');
    this.registry = this.absolute(`.memory-owners/owners/${this.request.expectedToken.ownerId}.json`);
    for (const target of [this.source, this.destination, this.sourceSidecar, this.destinationSidecar, this.sourceJournal, this.destinationJournal, this.registry, ...this.stagePaths()]) {
      if (Buffer.byteLength(target) + 1 > PATH_LIMIT || target.split(path.sep).some(component => Buffer.byteLength(component) > 255)) fail('EHEADRESOURCE');
    }
  }
  private stagePaths(): string[] {
    return ['PREPARED_RENAME', 'LINKED_RENAME', 'MOVED_RENAME', 'DESTINATION_METADATA_RENAME', 'METADATA_RENAME'].map(state => this.stage(this.sourceJournal, state))
      .concat(this.stage(this.destinationJournal, 'FINAL_RENAME'), this.stage(this.registry, 'REGISTRY'));
  }
  private reserve(): void {
    const projected = new Map(this.directories.map(item => [item.locator, [...item.names]]));
    const add = (target: string) => projected.get(this.relative(path.dirname(target)))!.push(path.basename(target));
    for (const target of [this.sourceJournal, this.destinationJournal, this.destination, this.destinationSidecar]) add(target);
    for (const stage of this.stagePaths()) add(stage);
    this.budget.reserve(projected, this.relative(path.dirname(this.source)));
  }
  private child(target: string): Child {
    const parent = this.directories.find(item => item.locator === this.relative(path.dirname(target)))!;
    const child = parent.children.find(item => item.name === path.basename(target)); if (!child || child.directory || child.links !== '1') fail();
    return child;
  }
  private expectedBinding(): Omit<Binding, 'contentBytes'> {
    const token = this.request.expectedToken;
    return { userId: token.userId, ownerId: token.ownerId, operationId: this.request.operationId, sourceLocator: token.locator,
      destinationLocator: this.request.destinationLocator, oldRevision: token.revision, newRevision: String(BigInt(token.revision) + 1n),
      contentHash: token.contentHash, originalSourceIdentity: token.fileIdentity };
  }
  private async initialize(): Promise<void> {
    if (process.platform !== 'linux' && process.platform !== 'darwin') fail('EHEADCONFLICT');
    const token = this.request.expectedToken;
    if (token.userId !== this.scope.userId || token.tenantRoot !== this.scope.tenantRoot) fail('EHEADCONFLICT');
    this.paths(); await this.confined();
    this.residual = [this.sourceJournal, this.destinationJournal].some(target => this.directories
      .find(item => item.locator === this.relative(path.dirname(target)))!.names.includes(path.basename(target)));
    this.reserve();
    const destinationJournal = await this.optional(this.destinationJournal), sourceJournal = await this.optional(this.sourceJournal);
    if (destinationJournal || sourceJournal) {
      for (const [target, item] of [[this.destinationJournal, destinationJournal], [this.sourceJournal, sourceJournal]] as const) if (item) this.bindContainingDevice(target, item.identity);
      this.restoreRecords(destinationJournal, sourceJournal);
      this.binding = this.record.binding;
      if (!equal(this.binding, { ...this.expectedBinding(), contentBytes: this.binding.contentBytes })) fail('EHEADCONFLICT');
      await this.recover(); this.preflight(); return;
    }
    this.admitFreshHead();
    await this.absent(this.destination);
    this.rejectStages();
    const snapshot = await this.reader(this.budget); if (!equal(snapshot.token, token)) fail('EHEADCONFLICT');
    this.binding = { ...this.expectedBinding(), contentBytes: Buffer.byteLength(snapshot.content) };
    const head = await this.read(this.source, this.binding.contentBytes, '1', false), sidecar = await this.optional(this.sourceSidecar), registry = await this.optional(this.registry);
    if (!sidecar || !registry || head.digest !== this.binding.contentHash || !equal(head.identity, token.fileIdentity)) fail();
    this.validateMetadata(sidecar.raw, false); this.validateMetadata(registry.raw, false);
    for (const [target, item] of [[this.source, head], [this.sourceSidecar, sidecar], [this.registry, registry]] as const) this.bindContainingDevice(target, item.identity);
    this.files.set(this.source, head); await this.proof(true);
    this.record = { schema: 4, state: 'BASE_RENAME', binding: this.binding, baseline: { sourceSidecar: sidecar, registry,
      originalChildren: { head: this.child(this.source), sourceSidecar: this.child(this.sourceSidecar), registry: this.child(this.registry) }, namespace: this.directories.map(commitment) } };
    validateRecord(this.record); this.preflight();
    const base = await this.write(this.sourceJournal, serialize(this.record), 'partial-base'); await this.sync(path.dirname(this.source)); await this.barrier('base-durable');
    const originalSourceJournal = artifactHistory(base);
    const reservation: ReservationRecord = { schema: 4, state: 'RESERVED_RENAME', binding: this.binding, originalSourceJournal };
    const reserved = await this.write(this.destinationJournal, serialize(reservation), 'partial-reservation'); await this.sync(path.dirname(this.source)); await this.barrier('reservation-durable');
    await this.publish({ ...this.record, state: 'PREPARED_RENAME', originalSourceJournal, reservation: artifactHistory(reserved),
      currentHead: { identity: head.identity, links: '1' } }, 'partial-prepared', 'prepared-durable');
  }
  private admitFreshHead(): void {
    const H = this.directories.find(item => item.locator === this.relative(path.dirname(this.source)))!;
    for (const target of [this.destination, this.destinationSidecar, this.destinationJournal]) if (H.names.some(name => name.toLowerCase() === path.basename(target).toLowerCase())) fail('EHEADCONFLICT');
    if (!H.names.includes(path.basename(this.source)) || H.names.some(name => name !== path.basename(this.source) && name.toLowerCase() === path.basename(this.source).toLowerCase())) fail();
  }
  private restoreRecords(destinationJournal: Artifact | undefined, sourceJournal: Artifact | undefined): void {
    if (!destinationJournal) fail();
    const destinationRecord = parse(destinationJournal.raw);
    if (destinationRecord.state === 'FINAL_RENAME') {
      this.final = destinationRecord as FinalRecord; this.record = this.final.sourceFinalJournal.record;
      if (sourceJournal && (!equal(sourceJournal.identity, this.final.sourceFinalJournal.identity) || sourceJournal.raw !== serialize(this.record))) fail();
    } else {
      if (destinationRecord.state !== 'RESERVED_RENAME' || !sourceJournal) fail();
      const sourceRecord = parse(sourceJournal.raw);
      if (sourceRecord.state === 'FINAL_RENAME' || sourceRecord.state === 'RESERVED_RENAME' || sourceRecord.state === 'BASE_RENAME') fail();
      this.record = sourceRecord as SourceRecord;
      if (!equal(this.record.reservation, artifactHistory(destinationJournal)) || !equal(this.record.originalSourceJournal, destinationRecord.originalSourceJournal) || !equal(this.record.binding, destinationRecord.binding)) fail();
    }
  }
  private rejectStages(): void {
    for (const directory of this.directories) for (const name of directory.names) {
      if (name.toLowerCase().includes(`.rename-${this.request.operationId}`) ||
        [this.sourceJournal, this.destinationJournal, this.sourceSidecar, this.destinationSidecar, this.registry].some(target =>
          this.relative(path.dirname(target)) === directory.locator && name !== path.basename(target) && name.toLowerCase().startsWith(`${path.basename(target).toLowerCase()}.`))) fail();
    }
  }
  private preflight(): void {
    const baseline = this.record.baseline, binding = this.binding;
    const H = this.directories.find(item => item.locator === this.relative(path.dirname(this.source)))!, R = this.directories.find(item => item.locator === '.memory-owners/owners')!;
    const maximumFile = (device: string, size = '8192'): Identity => ({ device, size, inode: '9'.repeat(40), mtimeNs: `-${'9'.repeat(40)}`, ctimeNs: `-${'9'.repeat(40)}` });
    const future = maximumFile(H.identity.device), registryFuture = maximumFile(R.identity.device);
    const head = { ...binding.originalSourceIdentity, ctimeNs: `-${'9'.repeat(40)}` };
    const base: SourceRecord = { schema: 4, state: 'BASE_RENAME', binding, baseline };
    serialize(base);
    const originalSourceJournal = { digest: 'f'.repeat(64), identity: future }, reservation = { digest: 'f'.repeat(64), identity: future };
    serialize({ schema: 4, state: 'RESERVED_RENAME', binding, originalSourceJournal });
    let previous: State = 'BASE_RENAME', terminal!: SourceRecord;
    for (const state of ['PREPARED_RENAME', 'LINKED_RENAME', 'MOVED_RENAME', 'DESTINATION_METADATA_RENAME', 'METADATA_RENAME'] as State[]) {
      const record: SourceRecord = { schema: 4, state, binding, baseline, originalSourceJournal, reservation,
        prior: { state: previous, digest: 'f'.repeat(64), identity: future }, currentHead: { identity: state === 'PREPARED_RENAME' ? binding.originalSourceIdentity : head, links: state === 'LINKED_RENAME' ? '2' : '1' } };
      const raw = this.activeRaw(head), size = String(Buffer.byteLength(raw));
      if (state === 'DESTINATION_METADATA_RENAME' || state === 'METADATA_RENAME') record.destinationSidecar = artifact(raw, { ...future, size });
      if (state === 'METADATA_RENAME') record.newRegistry = artifact(raw, { ...registryFuture, size });
      validateRecord(record); serialize(record); terminal = record; previous = state;
    }
    const raw = serialize(terminal);
    serialize({ schema: 4, state: 'FINAL_RENAME', binding, sourceFinalJournal: { record: terminal, digest: digest(raw), identity: { ...future, size: String(Buffer.byteLength(raw)) } },
      prior: { state: 'RESERVED_RENAME', ...reservation } });
  }
  private validateMetadata(raw: string, destination: boolean): void {
    let metadata: unknown; try { metadata = JSON.parse(raw); } catch { fail(); }
    const expected = { schema: 1, state: 'ACTIVE', userId: this.binding.userId, ownerId: this.binding.ownerId,
      locator: destination ? this.binding.destinationLocator : this.binding.sourceLocator, revision: destination ? this.binding.newRevision : this.binding.oldRevision,
      contentHash: this.binding.contentHash, fileIdentity: destination ? this.record.currentHead!.identity : this.binding.originalSourceIdentity };
    if (!equal(metadata, expected)) fail();
  }
  private bindContainingDevice(target: string, captured: Identity): void {
    const parent = this.directories.find(item => item.locator === this.relative(path.dirname(target)))!;
    if (captured.device !== parent.identity.device) fail();
  }
  private async requireArtifact(target: string, expected: Artifact): Promise<void> {
    const actual = await this.optional(target); if (!actual || !equal(actual, expected)) fail();
    const parent = this.directories.find(item => item.locator === this.relative(path.dirname(target)))!;
    if (actual.identity.device !== parent.identity.device) fail();
  }
  private async recover(): Promise<void> {
    this.rejectStages(); this.residual = true;
    const record = this.record, baseline = record.baseline, head = record.currentHead!;
    const originalHead = baseline.originalChildren.head, originalSide = baseline.originalChildren.sourceSidecar, originalRegistry = baseline.originalChildren.registry;
    this.validateRecoveryOrigin(baseline, originalHead, originalSide, originalRegistry);
    const state = record.state;
    const sourceExpected = state === 'PREPARED_RENAME' || state === 'LINKED_RENAME';
    const destinationExpected = state !== 'PREPARED_RENAME';
    const inspectHead = async (target: string) => {
      const actual = await this.read(target, this.binding.contentBytes, head.links, false);
      if (!equal(actual.identity, head.identity) || actual.digest !== this.binding.contentHash || Buffer.byteLength(actual.raw) !== this.binding.contentBytes || actual.mode !== originalHead.mode || actual.uid !== originalHead.uid) fail();
      this.files.set(target, actual);
    };
    if (sourceExpected) await inspectHead(this.source); else await this.absent(this.source);
    if (destinationExpected) await inspectHead(this.destination); else await this.absent(this.destination);
    if (state === 'LINKED_RENAME' && !equal(this.files.get(this.source)!.identity, this.files.get(this.destination)!.identity)) fail();
    await this.recoverMetadata();
    this.restoreNamespace(baseline, originalHead, originalSide, originalRegistry);
    // Only after exact phase reconstruction may the already observed live arrays be authority.
    await this.proof(true);
  }
  private async recoverMetadata(): Promise<void> {
    const record = this.record, baseline = record.baseline;
    if (record.destinationSidecar) { this.validateMetadata(record.destinationSidecar.raw, true); await this.requireArtifact(this.destinationSidecar, record.destinationSidecar); }
    else await this.absent(this.destinationSidecar);
    if (record.newRegistry) { this.validateMetadata(record.newRegistry.raw, true); await this.requireArtifact(this.registry, record.newRegistry); }
    else await this.requireArtifact(this.registry, baseline.registry);
    const oldSidecar = await this.optional(this.sourceSidecar), sourceJournal = this.files.get(this.sourceJournal);
    if (oldSidecar && !equal(oldSidecar, baseline.sourceSidecar)) fail();
    if (!this.final && (!oldSidecar || !sourceJournal)) fail();
    if (this.final && oldSidecar && !sourceJournal) fail();
    if (this.final && sourceJournal && (sourceJournal.raw !== serialize(record) || !equal(sourceJournal.identity, this.final.sourceFinalJournal.identity))) fail();
  }
  private validateRecoveryOrigin(baseline: Baseline, originalHead: Child, originalSide: Child, originalRegistry: Child): void {
    const record = this.record;
    if (originalHead.name !== path.basename(this.source) || originalSide.name !== path.basename(this.sourceSidecar) || originalRegistry.name !== path.basename(this.registry) ||
      originalHead.directory || originalSide.directory || originalRegistry.directory || originalHead.links !== '1' || originalSide.links !== '1' || originalRegistry.links !== '1' ||
      !equal(originalHead.identity, this.binding.originalSourceIdentity) || !equal(originalSide.identity, baseline.sourceSidecar.identity) || !equal(originalRegistry.identity, baseline.registry.identity)) fail();
    for (const [target, item] of [[this.source, originalHead], [this.sourceSidecar, originalSide], [this.registry, originalRegistry]] as const) this.bindContainingDevice(target, item.identity);
    const H = this.directories.find(item => item.locator === this.relative(path.dirname(this.source)))!;
    const baseRaw = serialize({ schema: 4, state: 'BASE_RENAME', binding: this.binding, baseline });
    const origin = record.originalSourceJournal!;
    const reservationRaw = serialize({ schema: 4, state: 'RESERVED_RENAME', binding: this.binding, originalSourceJournal: origin });
    if (origin.digest !== digest(baseRaw) || origin.identity.size !== String(Buffer.byteLength(baseRaw)) || origin.identity.device !== H.identity.device ||
      record.reservation!.digest !== digest(reservationRaw) || record.reservation!.identity.size !== String(Buffer.byteLength(reservationRaw)) || record.reservation!.identity.device !== H.identity.device ||
      (record.state === 'PREPARED_RENAME' && !equal(record.prior, { state: 'BASE_RENAME', ...origin }))) fail();
    this.validateMetadata(baseline.sourceSidecar.raw, false); this.validateMetadata(baseline.registry.raw, false);
  }
  private restoreNamespace(baseline: Baseline, originalHead: Child, originalSide: Child, originalRegistry: Child): void {
    const originals = new Map<string, Child>([[this.source, originalHead], [this.sourceSidecar, originalSide], [this.registry, originalRegistry]]);
    const own = new Set(this.files.keys());
    if (baseline.namespace.length !== this.directories.length || new Set(baseline.namespace.map(item => item.locator)).size !== baseline.namespace.length) fail();
    for (const current of this.directories) {
      const expected = baseline.namespace.find(item => item.locator === current.locator); if (!expected) fail();
      const reconstructed = current.children.filter(child => !own.has(path.join(this.absolute(current.locator), child.name)) && !originals.has(path.join(this.absolute(current.locator), child.name)));
      for (const [target, child] of originals) if (this.relative(path.dirname(target)) === current.locator) reconstructed.push(child);
      reconstructed.sort((a, b) => ordinal(a.name, b.name));
      if (new Set(reconstructed.map(child => child.name)).size !== reconstructed.length || !equal(commitment({ ...current, names: reconstructed.map(child => child.name), children: reconstructed }), expected)) fail();
    }
  }
  private async absent(target: string): Promise<void> {
    try { await fs.lstat(target, { bigint: true }); } catch (cause) { if (causeCode(cause) === 'ENOENT') return;
      throw cause; }
    fail();
  }
  private async link(): Promise<void> {
    await this.barrier('before-link', true); this.active(); this.attempted = true;
    try { await fs.link(this.source, this.destination); }
    catch (cause) {
      if (causeCode(cause) === 'EEXIST') { this.linkConflict = true; this.attempted = false; }
      throw cause;
    }
    const source = await this.read(this.source, this.binding.contentBytes, '2', false), destination = await this.read(this.destination, this.binding.contentBytes, '2', false);
    if (!equal(source.identity, destination.identity) || !original(source.identity, this.binding.originalSourceIdentity) || source.digest !== this.binding.contentHash || destination.digest !== source.digest ||
      [source, destination].some(item => item.mode !== this.record.baseline.originalChildren.head.mode || item.uid !== this.record.baseline.originalChildren.head.uid)) fail();
    this.files.set(this.source, source); this.files.set(this.destination, destination);
    await this.transition(path.dirname(this.source), [path.basename(this.destination)], [], [path.basename(this.source)]); await this.barrier('after-link');
    await this.publish({ ...this.record, state: 'LINKED_RENAME', currentHead: { identity: destination.identity, links: '2' } }, 'partial-linked', 'linked-durable');
  }
  private async move(): Promise<void> {
    await this.proof(); const removedSource = this.files.get(this.source)!; this.active(); this.attempted = true; await fs.unlink(this.source); this.files.delete(this.source);
    const destination = await this.read(this.destination, this.binding.contentBytes, '1', false);
    if (!original(destination.identity, this.binding.originalSourceIdentity) || destination.digest !== this.binding.contentHash || destination.mode !== this.record.baseline.originalChildren.head.mode || destination.uid !== this.record.baseline.originalChildren.head.uid) fail();
    this.files.set(this.destination, destination);
    await this.transition(path.dirname(this.source), [], [path.basename(this.source)], [path.basename(this.destination)], new Map([[this.source, removedSource]])); await this.barrier('after-source-unlink');
    await this.publish({ ...this.record, state: 'MOVED_RENAME', currentHead: { identity: destination.identity, links: '1' } }, 'partial-moved', 'moved-durable');
  }
  private async metadata(): Promise<void> {
    if (this.record.state === 'MOVED_RENAME') {
      const sidecar = await this.write(this.destinationSidecar, this.activeRaw(this.record.currentHead!.identity), 'partial-destination-sidecar');
      await this.sync(path.dirname(this.destinationSidecar)); await this.barrier('after-destination-sidecar');
      await this.publish({ ...this.record, state: 'DESTINATION_METADATA_RENAME', destinationSidecar: sidecar }, 'partial-destination-metadata', 'destination-metadata-durable');
    }
    if (this.record.state === 'DESTINATION_METADATA_RENAME') {
      const registry = await this.replace(this.registry, this.activeRaw(this.record.currentHead!.identity), 'REGISTRY', 'partial-registry');
      await this.barrier('after-registry');
      await this.publish({ ...this.record, state: 'METADATA_RENAME', newRegistry: registry }, 'partial-metadata', 'metadata-durable');
    }
  }
  private async handoff(): Promise<void> {
    if (this.final) return;
    const source = this.files.get(this.sourceJournal)!;
    this.final = { schema: 4, state: 'FINAL_RENAME', binding: this.binding,
      sourceFinalJournal: { record: this.record, digest: source.digest, identity: source.identity }, prior: { state: 'RESERVED_RENAME', ...this.record.reservation! } };
    validateRecord(this.final);
    await this.replace(this.destinationJournal, this.final, 'FINAL_RENAME', 'partial-final'); await this.barrier('final-durable');
  }
  private async remove(target: string, before: RenamePublication, after: RenamePublication, last = false): Promise<void> {
    if (!this.files.has(target)) return;
    await this.barrier(before, true); const removedEvidence = this.files.get(target)!; this.active(); this.attempted = true;
    await fs.unlink(target); this.files.delete(target);
    await this.transition(path.dirname(target), [], [path.basename(target)], [], new Map([[target, removedEvidence]])); await this.barrier(after);
    await this.sync(path.dirname(target), last);
    if (!last) this.attempted = false;
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
    const error = Object.assign(new Error('Managed RENAME stopped; preserve phase evidence'), {
      code: this.outcomeCode(),
      cause: close ? close.cause : cause, operationId: this.request.operationId, phase: this.final ? 'FINAL_RENAME' : this.record?.state ?? 'initial', residual: this.residual });
    if (close) Object.assign(error, { closeCause: close.closeCause });
    if (this.committed) Object.assign(error, { committed: true, token: this.committed });
    return error;
  }
  async run(): Promise<OwnedFileMemoryToken> {
    try {
      await this.initialize();
      if (this.record.state === 'PREPARED_RENAME') await this.link();
      if (this.record.state === 'LINKED_RENAME') await this.move();
      await this.metadata();
      if (this.record.state !== 'METADATA_RENAME') fail();
      await this.handoff();
      await this.remove(this.sourceSidecar, 'before-old-sidecar', 'after-old-sidecar');
      await this.remove(this.sourceJournal, 'before-source-journal', 'after-source-journal');
      await this.remove(this.destinationJournal, 'before-final', 'after-final', true);
      if (!this.committed) fail();
      SecurityMonitor.logSecurityEvent({ type: 'DANGER_ZONE_OPERATION', severity: 'LOW', source: 'FileMemoryOwnedRename', details: `Managed memory RENAME known committed; invocation=${this.invocationId}` });
      await this.barrier('after-audit', true); await this.barrier('before-return', true); return this.committed;
    } catch (cause) {
      throw this.outcomeError(cause);
    }
  }
}
function artifactHistory(value: Artifact): Historical { return { digest: value.digest, identity: value.identity }; }

