/** Dormant exact head DELETE; archives remain erasure-pending, ambiguous gaps manual. */
import { constants, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { FileMemoryDirectoryScanLimitError } from './FileMemoryDirectoryScanBudget.js';
import type { OwnedFileMemoryToken, FileMemorySnapshot } from './FileMemoryOwnerSnapshots.js';
import { MEMORY_CONSTANTS } from '../elements/memories/constants.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import type { FileMemoryOperationScope } from './FileMemoryTransactionCoordinator.js';

import { evidenceCauseCode as causeCode, evidenceDigest as digest, evidenceOrdinal as ordinal, evidenceDecimal as decimal,
  OwnedHeadEvidenceBudget, evidenceScalar, evidenceIdentity, evidenceKeys as keys, evidenceValidIdentity as validIdentity,
  evidenceOriginalIdentity as original, canonicalEvidence, stableEvidenceChild as stable, inspectEvidenceNames,
  withEvidenceFileClose, observeEvidenceDirectory, readEvidenceFile, applyEvidenceDirectoryTransition,
  applyEvidenceAncestorTransition, admitEvidenceAncestor, writeEvidenceFile,
  observeEvidenceCanonicalVolume, evidenceVolumeIdentity, captureEvidenceConfinement,
  type HeadIdentity as Identity, type HeadArtifact as Artifact, type HeadChild as Child,
  type HeadDirectory as Directory, type HeadDirectoryNames as DirectoryNames } from './FileMemoryOwnedHeadEvidence.js';

export interface DeleteOwnedRequest { readonly operationId: string; readonly expectedToken: OwnedFileMemoryToken }
export interface DeletedOwnerEvidence { readonly tenantRoot: string; readonly userId: string; readonly ownerId: string; readonly operationId: string }
export interface HeadDeletedEvidence extends DeletedOwnerEvidence { readonly locator: string }
export type DeleteOwnedResult = { readonly status: 'head-deleted'; readonly erasure: 'pending'; readonly evidence: HeadDeletedEvidence } | { readonly status: 'already-head-deleted'; readonly erasure: 'pending'; readonly evidence: DeletedOwnerEvidence };
export type DeletePublication = 'partial-base' | 'partial-deleting-registry' | 'partial-registry-phase' |
  'partial-deleting-sidecar' | 'partial-pair-phase' | 'partial-head-phase' | 'partial-terminal-registry' | 'partial-terminal-phase' |
  'base-durable' | 'registry-durable' | 'pair-durable' | 'head-durable' | 'terminal-durable' |
  'after-registry' | 'after-sidecar' | 'before-head-unlink' | 'after-head-unlink' | 'after-terminal-registry' |
  'before-sidecar-retirement' | 'after-sidecar-retirement' | 'before-intent-retirement' | 'after-intent-retirement' |
  'after-audit' | 'before-return';
type State = 'BASE' | 'REGISTRY_DELETING' | 'PAIR_DELETING' | 'HEAD_REMOVED' | 'TERMINAL';
interface Commitment { locator: string; device: string; inode: string; mode: string; uid: string; childCount: number; domain: string; sha256: string }
interface Historical { digest: string; identity: Identity }
interface Binding { userId: string; ownerId: string; operationId: string; locator: string; revision: string; contentHash: string; contentBytes: number; originalHeadIdentity: Identity }
interface Baseline { sidecar: Artifact; registry: Artifact; originalChildren: { head: Child; sidecar: Child; registry: Child }; namespace: Commitment[] }
interface Intent { schema: 1; state: State; binding: Binding; baseline: Baseline; prior?: Historical & { state: State }; registry?: Historical; sidecar?: Historical }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const DOMAIN = 'dollhouse.delete.schema1.full-children.v1';
const RAW_HEAD_LIMIT = 3 * MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE;
const LIMIT = 8192, MAX_REVISION = 9223372036854775807n;
function fail(code = 'EOWNERRECOVERY'): never { throw Object.assign(new Error('Managed DELETE evidence is unsafe or changed'), { code }); }
function scalar(value: bigint, width = 40): string { return evidenceScalar(value, width, fail); }
function identity(stat: BigIntStats): Identity { return evidenceIdentity(stat, fail); }
function validLocator(value: unknown): value is string {
  return typeof value === 'string' && !!value && Buffer.byteLength(value) <= 1024 && Buffer.from(value).toString('utf8') === value &&
    !value.includes('\\') && !value.includes('\0') && !path.win32.isAbsolute(value) &&
    !/^\.[0-9a-f]{64}\.memory-(?:owner\.json|write)(?:\.|$)/iu.test(path.posix.basename(value)) && value.split('/').every(part => !!part && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255) && !path.isAbsolute(value);
}

export function captureDeleteRequest(input: DeleteOwnedRequest): DeleteOwnedRequest {
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new TypeError('Managed DELETE supports Linux and Darwin only');
  if (!keys(input, ['operationId', 'expectedToken'])) throw new TypeError('DELETE requires exactly operationId and expectedToken');
  const { operationId, expectedToken: token } = input;
  if (typeof operationId !== 'string' || !UUID.test(operationId) ||
    !keys(token, ['backend', 'ownership', 'userId', 'tenantRoot', 'locator', 'ownerId', 'revision', 'contentHash', 'fileIdentity']) ||
    token.backend !== 'file' || token.ownership !== 'owned' || !UUID.test(token.ownerId) || !HASH.test(token.contentHash) || !validIdentity(token.fileIdentity) ||
    !validLocator(token.locator) || !decimal(token.revision, 19) || BigInt(token.revision) < 1n || BigInt(token.revision) > MAX_REVISION ||
    typeof token.userId !== 'string' || !token.userId || Buffer.byteLength(token.userId) > 128 || typeof token.tenantRoot !== 'string' ||
    ['.memory-owners', '.memory-fences', 'volumes'].includes(token.locator.split('/')[0])) throw new TypeError('Unsupported managed DELETE request');
  return Object.freeze({ operationId, expectedToken: Object.freeze({ ...token, fileIdentity: Object.freeze({ ...token.fileIdentity }) }) });
}
const states: State[] = ['BASE', 'REGISTRY_DELETING', 'PAIR_DELETING', 'HEAD_REMOVED', 'TERMINAL'];
const fieldOrder = ['schema', 'state', 'binding', 'baseline', 'prior', 'registry', 'sidecar', 'raw', 'digest', 'identity',
  'userId', 'ownerId', 'operationId', 'locator', 'revision', 'contentHash', 'contentBytes', 'originalHeadIdentity',
  'originalChildren', 'head', 'namespace', 'name', 'device', 'inode', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'links',
  'directory', 'childCount', 'domain', 'sha256'];
function canonical(value: unknown): unknown { return canonicalEvidence(value, fieldOrder, fail); }
function serialize(record: Intent): string {
  const raw = JSON.stringify(canonical(record));
  if (Buffer.byteLength(raw) > LIMIT) fail('EHEADRESOURCE');
  return raw;
}
function artifact(raw: string, captured: Identity): Artifact { return { raw, digest: digest(raw), identity: captured }; }
function commitment(directory: Directory): Commitment {
  const children = directory.children.map(stable).map(child => [child.name, child.directory, child.identity.device, child.identity.inode,
    child.identity.size, child.identity.mtimeNs, child.identity.ctimeNs, child.mode, child.uid, child.links]);
  return { locator: directory.locator, device: directory.identity.device, inode: directory.identity.inode, mode: directory.mode, uid: directory.uid,
    childCount: children.length, domain: DOMAIN, sha256: digest(JSON.stringify([DOMAIN, directory.locator, directory.identity.device, directory.identity.inode, directory.mode, directory.uid, children])) };
}
class DeleteBudget extends OwnedHeadEvidenceBudget {
  reserve(slots: Map<string, string[]>, head: string): void {
    const { P, q } = this.reserveWeights(slots);
    // Forward primitives75P, barriers24P, baseline1P, original reader9P.
    // Physical head/ancestor versus ownership/registry disjointness proves qH+qR<=P.
    this.ceiling = this.consumed + 109 * P + 20 * q(head) + 6 * q('.memory-owners/owners');
    if (this.limit > 532480) throw new FileMemoryDirectoryScanLimitError();
  }
  async read(directory: import('node:fs').Dir) {
    this.chargeRead(); return await directory.read();
  }
  scan(target: string, inspect: (name: string) => void): Promise<void> {
    return inspectEvidenceNames(target, inspect, directory => this.read(directory), 'DELETE directory inspection and close failed');
  }

}
export class FileMemoryOwnedDelete {
  private readonly budget = new DeleteBudget();
  private directories: Directory[] = [];
  private readonly files = new Map<string, Artifact & { links: '1' | '2'; mode: string; uid: string }>();
  private record!: Intent; private binding!: Binding;
  private source = ''; private sourceJournal = ''; private sourceSidecar = ''; private registry = '';
  private readonly closeFailures = new WeakMap<object, { cause: unknown; closeCause: unknown }>();
  private readonly capturedErrors = new WeakMap<object, DeleteOwnedResult>();
  isCapturedError(cause: unknown, result: DeleteOwnedResult): boolean { return !!cause && typeof cause === 'object' && this.capturedErrors.get(cause) === result; }
  private result(current: boolean): DeleteOwnedResult {
    const evidence = { tenantRoot: this.scope.tenantRoot, userId: this.binding.userId, ownerId: this.binding.ownerId, operationId: this.binding.operationId };
    return current ? Object.freeze({ status: 'head-deleted', erasure: 'pending', evidence: Object.freeze({ ...evidence, locator: this.binding.locator }) }) : Object.freeze({ status: 'already-head-deleted', erasure: 'pending', evidence: Object.freeze(evidence) });
  }
  private attempted = false; private residual = false; private headUnlinked = false; private committed?: DeleteOwnedResult;
  constructor(private readonly scope: FileMemoryOperationScope, private readonly request: DeleteOwnedRequest,
    private readonly active: () => void, private readonly fresh: (budget: DeleteBudget) => Promise<FileMemorySnapshot>,
    private readonly replacement: (budget: DeleteBudget) => Promise<FileMemorySnapshot>,
    private readonly hook?: (phase: DeletePublication) => Promise<void> | void,
    private readonly capture: (result: DeleteOwnedResult) => void = () => {}) {}
  private absolute(locator: string): string { return locator === '.' ? this.scope.tenantRoot : path.join(this.scope.tenantRoot, locator); }
  private relative(target: string): string { return path.relative(this.scope.tenantRoot, target).split(path.sep).join('/') || '.'; }
  private closed<T>(handle: fs.FileHandle, body: () => Promise<T>): Promise<T> {
    return withEvidenceFileClose(handle, body, (cause, closeCause) => {
      const error = new Error('DELETE operation and close failed'); this.closeFailures.set(error, { cause, closeCause }); return error;
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
      target !== this.source), before)) fail();
    this.active();
  }
  private async transition(target: string, add: string[] = [], remove: string[] = [], changed: string[] = []): Promise<void> {
    const index = this.directories.findIndex(item => item.locator === this.relative(target)), before = this.directories[index], after = await this.observe(before.locator, true);
    applyEvidenceDirectoryTransition(this.directories, index, before, after, { add, remove, changed }, fail);
    await this.transitionAncestor(target, index);
    await this.proof();
  }
  private async transitionAncestor(target: string, index: number): Promise<void> {
    const ancestorIndex = this.directories.findIndex(item => this.absolute(item.locator) === path.dirname(target));
    if (ancestorIndex >= 0 && ancestorIndex !== index) {
      const ancestor = this.directories[ancestorIndex], fresh = await this.observe(ancestor.locator, true), name = path.basename(target);
      applyEvidenceAncestorTransition(this.directories, ancestorIndex, ancestor, fresh, name, fail);
    }
  }
  private async barrier(phase: DeletePublication, mandatory = false): Promise<void> { await this.hook?.(phase); await this.proof(mandatory || !!this.hook); }
  private async sync(target: string, final = false): Promise<void> {
    await this.proof(final); const expected = this.directories.find(item => item.locator === this.relative(target))!;
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    await this.closed(handle, async () => {
      const matches = async () => { const stat = await handle.stat({ bigint: true }); if (!stat.isDirectory() || !equal(identity(stat), expected.identity) || scalar(stat.mode, 20) !== expected.mode || scalar(stat.uid, 20) !== expected.uid) fail(); };
      await matches(); await this.proof(final); this.active(); await handle.sync(); await matches(); await this.proof(final);
    });
    if (final) {
      this.committed = this.result(this.headUnlinked);
      this.capture(this.committed);
    } else this.active();
  }
  private write(target: string, raw: string, partial: DeletePublication): Promise<Artifact> {
    return writeEvidenceFile(target, raw, LIMIT, {
      active: () => this.active(), proof: () => this.proof(), markResidual: () => { this.residual = true; },
      closed: (handle, body) => this.closed(handle, body), read: (name, maximum) => this.read(name, maximum),
      track: (name, evidence) => { this.files.set(name, evidence); },
      transition: (name, add, remove, changed) => this.transition(name, add, remove, changed),
      partialBarrier: () => this.barrier(partial),
      containingDevice: name => this.directories.find(item => item.locator === this.relative(path.dirname(name)))!.identity.device,
      fail,
    });
  }
  private stage(target: string, state: string): string { return `${target}.delete-${this.request.operationId}.${state}.tmp`; }
  private async replace(target: string, record: Intent | string, state: string, partial: DeletePublication): Promise<Artifact> {
    const old = this.files.get(target); if (!old) fail();
    const stage = this.stage(target, state), staged = await this.write(stage, typeof record === 'string' ? record : serialize(record), partial);
    await this.proof(); this.active(); this.attempted = true; await fs.rename(stage, target);
    const published = await this.read(target, LIMIT);
    if (published.raw !== staged.raw || !original(published.identity, staged.identity)) fail();
    this.files.delete(stage); this.files.set(target, published);
    await this.transition(path.dirname(target), [], [path.basename(stage)], [path.basename(target)]); await this.sync(path.dirname(target));
    this.attempted = false; return artifact(published.raw, published.identity);
  }
  private confined(): Promise<void> {
    return captureEvidenceConfinement({
      sourceLocator: () => this.request.expectedToken.locator, tenantRoot: () => this.scope.tenantRoot,
      absolute: locator => this.absolute(locator), canonicalVolume: () => this.canonicalVolume(),
      reset: () => { this.directories = []; }, admit: item => this.admitAncestor(item),
      observe: item => this.observe(item, true), append: directory => { this.directories.push(directory); },
      validate: (before, after, volumeBefore, volumeAfter) => this.validateConfinement(before, after, volumeBefore, volumeAfter), fail,
    });
  }
  private validateConfinement(before: BigIntStats[], after: BigIntStats[], volumeBefore?: BigIntStats, volumeAfter?: BigIntStats): void {
    if (!equal(volumeBefore && this.volumeIdentity(volumeBefore), volumeAfter && this.volumeIdentity(volumeAfter))) fail();
    if (volumeBefore && volumeBefore.dev === before[2].dev && volumeBefore.ino === before[2].ino) fail('EHEADCONFLICT');
    if (volumeBefore && this.directories.some(directory =>
      directory.identity.device === String(volumeBefore.dev) && directory.identity.inode === String(volumeBefore.ino))) fail('EHEADCONFLICT');
    if (!before.every((stat, index) => equal(identity(stat), identity(after[index])) && stat.mode === after[index].mode && stat.uid === after[index].uid && stat.nlink === after[index].nlink)) fail();
    if (before.slice(1).some(stat => stat.dev === before[0].dev && stat.ino === before[0].ino) ||
      this.directories.some(directory => directory.identity.device === String(before[2].dev) && directory.identity.inode === String(before[2].ino))) fail('EHEADCONFLICT');
    this.validateDirectorySeparation();
  }
  private validateDirectorySeparation(): void {
    const pairs = new Set<string>();
    for (const directory of this.directories) {
      const pair = `${directory.identity.device}:${directory.identity.inode}`; if (pairs.has(pair)) fail();
      pairs.add(pair);
    }
    const H = this.directories.find(directory => directory.locator === path.posix.dirname(this.request.expectedToken.locator))!;
    if (this.directories.filter(item => item.locator === '.memory-owners' || item.locator === '.memory-owners/owners').some(item =>
      item.identity.device === H.identity.device && item.identity.inode === H.identity.inode)) fail('EHEADCONFLICT');
  }
  private canonicalVolume(): Promise<BigIntStats | undefined> {
    return observeEvidenceCanonicalVolume(this.absolute('volumes'), fail);
  }
  private volumeIdentity(stat: BigIntStats) { return evidenceVolumeIdentity(stat, fail); }
  private admitAncestor(item: string): void { admitEvidenceAncestor(item, this.directories, fail); }
  private paths(): void {
    this.source = this.absolute(this.request.expectedToken.locator);
    const side = (target: string, suffix: string) => path.join(path.dirname(target), `.${digest(path.basename(target))}.${suffix}`);
    this.sourceJournal = side(this.source, 'memory-write.json');
    this.sourceSidecar = side(this.source, 'memory-owner.json');
    this.registry = this.absolute(`.memory-owners/owners/${this.request.expectedToken.ownerId}.json`);
  }
  private child(target: string): Child {
    const parent = this.directories.find(item => item.locator === this.relative(path.dirname(target)));
    const child = parent?.children.find(item => item.name === path.basename(target));
    if (!child) fail();
    return child;
  }
  private metadataRaw(terminal = false): string {
    const original = this.binding.originalHeadIdentity;
    const fileIdentity = { device: original.device, inode: original.inode, size: original.size, mtimeNs: original.mtimeNs, ctimeNs: original.ctimeNs };
    return terminal ? JSON.stringify({ schema: 1, state: 'HEAD_DELETED', userId: this.binding.userId,
      ownerId: this.binding.ownerId, operationId: this.binding.operationId }) :
      JSON.stringify({ schema: 1, state: 'DELETING', userId: this.binding.userId, ownerId: this.binding.ownerId,
        operationId: this.binding.operationId, locator: this.binding.locator, revision: this.binding.revision,
        contentHash: this.binding.contentHash, fileIdentity });
  }
  private history(target: string): Historical {
    const value = this.files.get(target);
    if (!value) fail();
    return { digest: value.digest, identity: value.identity };
  }
  private expectedBinding(): Omit<Binding, 'contentBytes'> {
    const token = this.request.expectedToken;
    return { userId: token.userId, ownerId: token.ownerId, operationId: this.request.operationId, locator: token.locator,
      revision: token.revision, contentHash: token.contentHash, originalHeadIdentity: { ...token.fileIdentity } };
  }
  private generatedPaths(): string[] {
    return [this.sourceJournal, ...states.slice(1).map(state => this.stage(this.sourceJournal, state)),
      this.stage(this.registry, 'DELETING'), this.stage(this.registry, 'HEAD_DELETED'), this.stage(this.sourceSidecar, 'DELETING')];
  }
  private admitPaths(): void {
    let maximum = 0;
    if (process.platform === 'darwin') maximum = 1024;
    else if (process.platform === 'linux') maximum = 4096;
    const targets = [this.source, this.sourceJournal, this.sourceSidecar, this.registry,
      this.absolute('.memory-owners'), this.absolute('.memory-owners/owners'), this.absolute('.memory-fences'), this.absolute('volumes'), ...this.generatedPaths()];
    if (!maximum || targets.some(target => Buffer.byteLength(target) + 1 > maximum ||
      target.split(path.sep).some(component => Buffer.byteLength(component) > 255))) fail('EHEADRESOURCE');
  }
  private reserve(): void {
    const projected = new Map(this.directories.map(item => [item.locator, [...item.names]]));
    const add = (target: string) => projected.get(this.relative(path.dirname(target)))!.push(path.basename(target));
    for (const target of this.generatedPaths()) add(target);
    this.budget.reserve(projected, this.relative(path.dirname(this.source)));
  }
  private rejectStages(): void {
    const headParent = this.directories.find(item => item.locator === this.relative(path.dirname(this.source)))!;
    const prefix = `.${digest(path.basename(this.source))}.memory-`;
    if (headParent.names.some(name => name.toLowerCase().startsWith(prefix) && name !== path.basename(this.sourceSidecar) && name !== path.basename(this.sourceJournal))) fail();
    const registryParent = this.directories.find(item => item.locator === '.memory-owners/owners')!;
    const name = path.basename(this.registry);
    if (registryParent.names.some(value => value.toLowerCase().startsWith(name.toLowerCase()) && value !== name)) fail();
  }
  private async optional(target: string, limit = LIMIT, privateFile = true): Promise<Artifact | undefined> {
    try {
      const value = await this.read(target, limit, '1', privateFile);
      this.files.set(target, value);
      return artifact(value.raw, value.identity);
    }
    catch (cause) {
      if (causeCode(cause) === 'ENOENT') return undefined;
      throw cause;
    }
  }
  private async absent(target: string): Promise<void> {
    try { await fs.lstat(target, { bigint: true }); }
    catch (cause) {
      if (causeCode(cause) === 'ENOENT') return;
      throw cause;
    }
    fail();
  }
  private validateActive(raw: string): void {
    const value = JSON.parse(raw) as { state: string };
    const token = this.request.expectedToken;
    if (!keys(value, ['schema', 'state', 'userId', 'ownerId', 'locator', 'revision', 'contentHash', 'fileIdentity']) ||
      !equal(value, { schema: 1, state: 'ACTIVE', userId: token.userId, ownerId: token.ownerId, locator: token.locator,
        revision: token.revision, contentHash: token.contentHash, fileIdentity: token.fileIdentity })) fail();
  }
  private originalDevices(head: Identity, sidecar: Artifact, registry: Artifact, namespace?: readonly Commitment[]): void {
    const parent = this.relative(path.dirname(this.source));
    const H = namespace ? namespace.find(item => item.locator === parent)?.device : this.directories.find(item => item.locator === parent)?.identity.device;
    const R = namespace ? namespace.find(item => item.locator === '.memory-owners/owners')?.device : this.directories.find(item => item.locator === '.memory-owners/owners')?.identity.device;
    if (head.device !== H || sidecar.identity.device !== H || registry.identity.device !== R) fail();
  }
  private validateRecord(record: Intent): void {
    const index = states.indexOf(record?.state);
    const extras = index === 0 ? [] : ['prior', 'registry', ...(index >= 2 ? ['sidecar'] : [])];
    if (record?.schema !== 1 || index < 0 || !keys(record, ['schema', 'state', 'binding', 'baseline', ...extras]) ||
      !keys(record.binding, ['userId', 'ownerId', 'operationId', 'locator', 'revision', 'contentHash', 'contentBytes', 'originalHeadIdentity'])) fail();
    this.validateBinding(record);
    this.validateBaseline(record);
    this.validateNamespace(record);
    this.validateHistory(record, index);
    serialize(record);
  }
  private validateBinding(record: Intent): void {
    const { contentBytes, ...binding } = record.binding;
    if (!equal(binding, this.expectedBinding()) || !Number.isSafeInteger(contentBytes) || contentBytes < 0 || contentBytes > RAW_HEAD_LIMIT ||
      record.binding.originalHeadIdentity.size !== String(contentBytes)) fail();
  }
  private validateBaseline(record: Intent): void {
    const base = record.baseline;
    if (!keys(base, ['sidecar', 'registry', 'originalChildren', 'namespace']) || !keys(base.originalChildren, ['head', 'sidecar', 'registry']) ||
      !Array.isArray(base.namespace) || base.namespace.length !== this.directories.length) fail();
    for (const value of [base.sidecar, base.registry]) {
      if (!keys(value, ['raw', 'digest', 'identity']) || typeof value.raw !== 'string' || digest(value.raw) !== value.digest ||
        !validIdentity(value.identity) || value.identity.size !== String(Buffer.byteLength(value.raw))) fail();
      this.validateActive(value.raw);
    }
    this.originalDevices(record.binding.originalHeadIdentity, base.sidecar, base.registry);
    this.validateOriginalChildren(record);
  }
  private validateOriginalChildren(record: Intent): void {
    const base = record.baseline;
    const targets = { head: this.source, sidecar: this.sourceSidecar, registry: this.registry };
    for (const key of ['head', 'sidecar', 'registry'] as const) {
      const child = base.originalChildren[key];
      if (!keys(child, ['name', 'identity', 'mode', 'uid', 'links', 'directory']) || child.name !== path.basename(targets[key]) || child.directory ||
        !validIdentity(child.identity) || !decimal(child.mode, 20) || !decimal(child.uid, 20) || child.links !== '1' ||
        !equal(child.identity, key === 'head' ? record.binding.originalHeadIdentity : base[key].identity)) fail();
    }
  }
  private validateNamespace(record: Intent): void {
    const base = record.baseline;
    for (const item of base.namespace) if (!keys(item, ['locator', 'device', 'inode', 'mode', 'uid', 'childCount', 'domain', 'sha256']) ||
      (item.locator !== '.' && !validLocator(item.locator)) || !decimal(item.device, 40) || !decimal(item.inode, 40) || !decimal(item.mode, 20) ||
      !decimal(item.uid, 20) || !Number.isInteger(item.childCount) || item.childCount < 0 || item.childCount > 4095 || item.domain !== DOMAIN || !HASH.test(item.sha256)) fail();
    this.originalDevices(record.binding.originalHeadIdentity, base.sidecar, base.registry, base.namespace);
  }
  private validateHistory(record: Intent, index: number): void {
    if (index > 0) {
      if (!keys(record.prior, ['state', 'digest', 'identity']) || record.prior!.state !== states[index - 1] || !HASH.test(record.prior!.digest) || !validIdentity(record.prior!.identity) || BigInt(record.prior!.identity.size) > BigInt(LIMIT)) fail();
      for (const value of [record.registry, ...(index >= 2 ? [record.sidecar] : [])]) {
        if (!keys(value, ['digest', 'identity']) || !HASH.test(value!.digest) || !validIdentity(value!.identity)) fail();
      }
    }
  }
  private preflight(): void {
    const H = this.directories.find(item => item.locator === this.relative(path.dirname(this.source)))!, R = this.directories.find(item => item.locator === '.memory-owners/owners')!;
    const maximum = (device: string, size = '8192'): Identity => ({ device, size, inode: '9'.repeat(40), mtimeNs: `-${'9'.repeat(40)}`, ctimeNs: `-${'9'.repeat(40)}` });
    let prior: Intent = { schema: 1, state: 'BASE', binding: this.binding, baseline: this.record.baseline };
    this.validateRecord(prior); serialize(prior);
    for (const state of states.slice(1)) {
      const registryRaw = this.metadataRaw(state === 'TERMINAL'), sidecarRaw = this.metadataRaw();
      const next: Intent = { schema: 1, state, binding: this.binding, baseline: this.record.baseline,
        prior: { state: prior.state, digest: 'f'.repeat(64), identity: maximum(H.identity.device) },
        registry: { digest: digest(registryRaw), identity: maximum(R.identity.device, String(Buffer.byteLength(registryRaw))) },
        ...(states.indexOf(state) >= 2 ? { sidecar: { digest: digest(sidecarRaw), identity: maximum(H.identity.device, String(Buffer.byteLength(sidecarRaw))) } } : {}) };
      this.validateRecord(next); serialize(next); prior = next;
    }
  }
  private isTerminalRegistry(raw: string): boolean {
    const token = this.request.expectedToken;
    return raw === JSON.stringify({ schema: 1, state: 'HEAD_DELETED', userId: token.userId, ownerId: token.ownerId, operationId: this.request.operationId });
  }
  private validateReplacementArtifacts(head: Artifact | undefined, sidecar: Artifact | undefined): void {
    if (!head || !sidecar || equal(head.identity, this.request.expectedToken.fileIdentity)) fail();
  }
  private async observeTerminalReplacement(): Promise<void> {
    const token = this.request.expectedToken;
    const head = await this.optional(this.source, RAW_HEAD_LIMIT, false), sidecar = await this.optional(this.sourceSidecar);
    if (head || sidecar) {
      this.validateReplacementArtifacts(head, sidecar);
      const replacement = await this.replacement(this.budget); this.active();
      if (replacement.token.ownership !== 'owned' || replacement.token.ownerId === token.ownerId) fail();
    }
    await this.proof(true); this.binding = { ...this.expectedBinding(), contentBytes: Number(token.fileIdentity.size) };
  }
  private async initialize(): Promise<boolean> {
    const token = this.request.expectedToken;
    if (token.userId !== this.scope.userId || token.tenantRoot !== this.scope.tenantRoot || process.platform === 'win32' || !process.getuid) fail('EHEADCONFLICT');
    this.paths(); this.admitPaths(); await this.confined();
    this.residual = this.directories.find(item => item.locator === this.relative(path.dirname(this.source)))!.names.includes(path.basename(this.sourceJournal));
    this.reserve(); this.rejectStages();
    const journal = await this.optional(this.sourceJournal), registry = await this.optional(this.registry);
    if (!registry) fail();
    if (!journal && this.isTerminalRegistry(registry.raw)) {
      await this.observeTerminalReplacement(); return false;
    }
    if (journal) {
      if (journal.identity.device !== this.directories.find(item => item.locator === this.relative(path.dirname(this.sourceJournal)))!.identity.device) fail();
      const record = JSON.parse(journal.raw) as Intent;
      this.validateRecord(record); if (serialize(record) !== journal.raw) fail();
      this.record = record; this.binding = record.binding;
      await this.recover(); this.preflight(); return true;
    }
    const snapshot = await this.fresh(this.budget); this.active();
    if (!equal(snapshot.token, token)) fail('EHEADCONFLICT');
    const head = await this.read(this.source, RAW_HEAD_LIMIT, '1', false), sidecar = await this.optional(this.sourceSidecar);
    if (!sidecar || !equal(head.identity, token.fileIdentity) || digest(head.raw) !== token.contentHash) fail();
    this.validateActive(sidecar.raw); this.validateActive(registry.raw); this.originalDevices(head.identity, sidecar, registry); this.files.set(this.source, head);
    this.binding = { ...this.expectedBinding(), contentBytes: Buffer.byteLength(head.raw) };
    this.record = { schema: 1, state: 'BASE', binding: this.binding, baseline: { sidecar, registry,
      originalChildren: { head: this.child(this.source), sidecar: this.child(this.sourceSidecar), registry: this.child(this.registry) }, namespace: this.directories.map(commitment) } };
    this.validateRecord(this.record); this.preflight(); await this.proof(true);
    await this.write(this.sourceJournal, serialize(this.record), 'partial-base'); await this.sync(path.dirname(this.source)); await this.barrier('base-durable'); return true;
  }
  private async recover(): Promise<void> {
    const index = states.indexOf(this.record.state), baseline = this.record.baseline;
    if (index < 3) {
      const head = await this.read(this.source, RAW_HEAD_LIMIT, '1', false);
      if (!equal(head.identity, this.binding.originalHeadIdentity) || digest(head.raw) !== this.binding.contentHash || head.mode !== baseline.originalChildren.head.mode || head.uid !== baseline.originalChildren.head.uid || head.links !== baseline.originalChildren.head.links) fail();
      this.files.set(this.source, head);
    } else await this.absent(this.source);
    await this.requireRecoveredArtifact(this.registry, index === 0 ? baseline.registry : this.record.registry!, index === 0 ? baseline.registry.raw : this.metadataRaw(index === 4));
    const sidecar = await this.optional(this.sourceSidecar);
    if (sidecar) await this.requireRecoveredArtifact(this.sourceSidecar, index < 2 ? baseline.sidecar : this.record.sidecar!, index < 2 ? baseline.sidecar.raw : this.metadataRaw());
    else if (index !== 4) fail();
    this.validateRecoveredNamespace(baseline);
    await this.proof(true);
  }
  private async requireRecoveredArtifact(target: string, expected: Artifact | Historical, raw: string): Promise<void> {
    const value = await this.optional(target);
    if (value?.raw !== raw || value.digest !== expected.digest || !equal(value.identity, expected.identity) ||
        value.identity.device !== this.directories.find(item => item.locator === this.relative(path.dirname(target)))!.identity.device) fail();
  }
  private validateRecoveredNamespace(baseline: Baseline): void {
    const originals = new Map<string, Child>([[this.source, baseline.originalChildren.head], [this.sourceSidecar, baseline.originalChildren.sidecar], [this.registry, baseline.originalChildren.registry]]);
    for (const current of this.directories) {
      const expected = baseline.namespace.find(item => item.locator === current.locator); if (!expected) fail();
      const reconstructed = current.children.filter(child => !this.files.has(path.join(this.absolute(current.locator), child.name)) && !originals.has(path.join(this.absolute(current.locator), child.name)));
      for (const [target, child] of originals) if (this.relative(path.dirname(target)) === current.locator) reconstructed.push(child);
      reconstructed.sort((a, b) => ordinal(a.name, b.name));
      if (new Set(reconstructed.map(item => item.name)).size !== reconstructed.length || !equal(commitment({ ...current, children: reconstructed, names: reconstructed.map(item => item.name) }), expected)) fail();
    }
  }
  private async publishPhase(state: State, partial: DeletePublication, durable: DeletePublication): Promise<void> {
    const next: Intent = { schema: 1, state, binding: this.binding, baseline: this.record.baseline,
      prior: { state: this.record.state, ...this.history(this.sourceJournal) }, registry: this.history(this.registry),
      ...(states.indexOf(state) >= 2 ? { sidecar: this.history(this.sourceSidecar) } : {}) };
    this.validateRecord(next); await this.replace(this.sourceJournal, next, state, partial); this.record = next; await this.barrier(durable);
  }
  private async remove(target: string, before: DeletePublication, after: DeletePublication): Promise<void> {
    await this.barrier(before, true); this.active(); this.attempted = true; await fs.unlink(target);
    this.files.delete(target); await this.transition(path.dirname(target), [], [path.basename(target)]); await this.barrier(after);
    await this.sync(path.dirname(target)); this.attempted = false;
  }
  private async forward(): Promise<void> {
    if (this.record.state === 'BASE') {
      await this.replace(this.registry, this.metadataRaw(), 'DELETING', 'partial-deleting-registry'); await this.barrier('after-registry');
      await this.publishPhase('REGISTRY_DELETING', 'partial-registry-phase', 'registry-durable');
    }
    if (this.record.state === 'REGISTRY_DELETING') {
      await this.replace(this.sourceSidecar, this.metadataRaw(), 'DELETING', 'partial-deleting-sidecar'); await this.barrier('after-sidecar');
      await this.publishPhase('PAIR_DELETING', 'partial-pair-phase', 'pair-durable');
    }
    if (this.record.state === 'PAIR_DELETING') {
      await this.barrier('before-head-unlink', true); await this.proof(); this.active(); this.attempted = true; await fs.unlink(this.source); this.headUnlinked = true;
      this.files.delete(this.source); await this.transition(path.dirname(this.source), [], [path.basename(this.source)]); await this.barrier('after-head-unlink');
      await this.sync(path.dirname(this.source)); this.attempted = false;
      await this.publishPhase('HEAD_REMOVED', 'partial-head-phase', 'head-durable');
    }
    if (this.record.state === 'HEAD_REMOVED') {
      await this.replace(this.registry, this.metadataRaw(true), 'HEAD_DELETED', 'partial-terminal-registry'); await this.barrier('after-terminal-registry');
      await this.publishPhase('TERMINAL', 'partial-terminal-phase', 'terminal-durable');
    }
    if (this.files.has(this.sourceSidecar)) await this.remove(this.sourceSidecar, 'before-sidecar-retirement', 'after-sidecar-retirement');
    await this.barrier('before-intent-retirement', true); this.active(); this.attempted = true; await fs.unlink(this.sourceJournal);
    this.files.delete(this.sourceJournal); await this.transition(path.dirname(this.source), [], [path.basename(this.sourceJournal)]); await this.barrier('after-intent-retirement');
    await this.sync(path.dirname(this.source), true); this.attempted = false;
  }
  private outcomeCode(): string {
    if (this.committed) return 'EHEADDELETED';
    if (this.attempted) return 'EHEADCOMMITUNKNOWN';
    if (this.residual) return 'EOWNERRECOVERY';
    return 'EHEADCONFLICT';
  }
  private failureError(cause: unknown): Error {
    const secondary = cause && typeof cause === 'object' ? this.closeFailures.get(cause) : undefined;
    const error = Object.assign(new Error('Managed DELETE stopped; preserve phase evidence'), {
      code: this.outcomeCode(), cause: secondary ? secondary.cause : cause,
      ...(secondary ? { closeCause: secondary.closeCause } : {}),
      ...(this.committed ? { headDeleted: true, result: this.committed } : {}) });
    if (this.committed) this.capturedErrors.set(error, this.committed);
    return error;
  }
  async run(): Promise<DeleteOwnedResult> {
    try {
      const pending = await this.initialize();
      if (!pending) return this.result(false);
      await this.forward();
      SecurityMonitor.logSecurityEvent({ type: 'DANGER_ZONE_OPERATION', severity: 'LOW', source: 'FileMemoryOwnedDelete', details: 'Exact head deleted; owner erasure remains pending' });
      await this.barrier('after-audit', true); await this.barrier('before-return', true); return this.committed!;
    } catch (cause) {
      throw this.failureError(cause);
    }
  }
}
