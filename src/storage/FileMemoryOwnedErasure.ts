/** Internal dormant whole-owner protocol. Selector paths never confer authority. */
import { isDeepStrictEqual as equal } from 'node:util';
import type { FileMemorySnapshot, OwnedFileMemoryToken } from './FileMemoryOwnerSnapshots.js';
import { MEMORY_CONSTANTS } from '../elements/memories/constants.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { evidenceCauseCode, evidenceDigest, stableEvidenceChild, type HeadDirectory } from './FileMemoryOwnedHeadEvidence.js';
import { ErasureInspection, erasureSameDirectory, erasureNamesCapture, type ErasureDirectoryCapture } from './FileMemoryErasureInspection.js';
import { ERASURE_DOMAIN, ERASURE_NAMES_DOMAIN, ERASURE_NAMES_PROTOCOL, type ErasureProtocol, ERASURE_NODE_LIMIT, erasureFail, erasureJournalName, erasureNamesDigest,
  erasureInventoryDigest, erasureMaximumIdentity, erasurePack, erasureParseRecord, erasureParseSegment, erasureSegmentName, erasureSerialize, erasureStageName,
  erasureValidateRecord, type ErasureAnchor, type ErasureArchiveWitness, type ErasureArtifact,
  type ErasureBinding, type ErasureHeadPreparation, type ErasureManifest, type ErasureNamespace, type ErasureNode, type ErasureRecord, type ErasureSegment } from './FileMemoryErasureEvidence.js';

export type ErasurePublication = 'head-prepared-durable' | 'ready-durable' | 'segment-durable' | 'inventory-durable' |
  'action-prepared-durable' | 'before-owner-action' | 'after-owner-action' | 'action-durable' |
  'owner-root-removed-durable' | 'evidence-retiring-durable' | 'retire-action-prepared-durable' |
  'before-evidence-retirement' | 'after-evidence-retirement' | 'evidence-retired-durable' | 'after-audit' | 'before-return';
export interface ErasedOwnerEvidence extends ErasureBinding { readonly tenantRoot: string }
export interface EraseOwnedResult { readonly status: 'erased' | 'already-erased'; readonly evidence: ErasedOwnerEvidence }
export interface EraseOwnedRequest { readonly operationId: string; readonly deleteOperationId: string; readonly expectedToken: OwnedFileMemoryToken }
export interface RecoverOwnedErasureRequest { readonly operationId: string; readonly deleteOperationId: string; readonly ownerId: string }
export interface ErasureReplacementSnapshot extends FileMemorySnapshot {
  readonly registryEvidence: ErasureArtifact;
}

/** Complete stable child commitment, not a content hash of archive payloads. */
export function erasureNamespace(directory: ErasureDirectoryCapture, excluded: ReadonlySet<string> = new Set(), version: 1 | 2 = 1, kind: 'names' | 'full' = 'names'): ErasureNamespace {
  if (version === 1 && erasureNamesCapture(directory)) erasureFail();
  const names = directory.names.filter(name => !excluded.has(name));
  const children = erasureNamesCapture(directory) ? undefined : directory.children.filter(child => !excluded.has(child.name)).map(stableEvidenceChild);
  const namesOnly = version === 2 && kind === 'names';
  if (!namesOnly && erasureNamesCapture(directory)) erasureFail();
  const commitment = namesOnly ? names : children!;
  return { locator: directory.locator, device: directory.identity.device, inode: directory.identity.inode,
    mode: directory.mode, uid: directory.uid, childCount: commitment.length, ...(version === 2 ? { kind: namesOnly ? 'names' as const : 'full' as const } : {}),
    sha256: evidenceDigest(JSON.stringify([version === 1 ? ERASURE_DOMAIN : ERASURE_NAMES_DOMAIN, directory.locator, commitment])) };
}

/** Private evidence engine used only under the one coordinator operation's scope. */
export class FileMemoryOwnedErasure {
  private record!: ErasureRecord;
  private nodes: ErasureNode[] = [];
  private registryDirectory!: ErasureDirectoryCapture;
  private readonly authority = new Map<string, ErasureArtifact>();
  private fence?: { device: string; inode: string; mode: string; uid: string };
  private committed?: EraseOwnedResult;
  private headQualified = false;
  private archiveMutation = false;
  private readonly capturedErrors = new WeakMap<object, EraseOwnedResult>();
  constructor(private readonly inspection: ErasureInspection, private readonly binding: ErasureBinding,
    private readonly hook?: (publication: ErasurePublication) => Promise<void> | void,
    private readonly replacement?: (locator: string, inspection: ErasureInspection) => Promise<ErasureReplacementSnapshot>,
    private readonly capture: (result: EraseOwnedResult) => void = () => {}) {}
  isCapturedError(cause: unknown, result: EraseOwnedResult): boolean {
    return !!cause && typeof cause === 'object' && this.capturedErrors.get(cause) === result;
  }
  get hasQualifiedHeadDeletion(): boolean { return this.headQualified; }
  get protocol(): ErasureProtocol { return this.record ? { schema: this.record.schema, domain: this.record.domain } as ErasureProtocol : ERASURE_NAMES_PROTOCOL; }
  private sharedDirectory(locator: string, privateMode = true): Promise<ErasureDirectoryCapture> {
    return this.protocol.schema === 1 ? this.inspection.directory(locator, false, privateMode) : this.inspection.sharedDirectory(locator, privateMode);
  }
  private namespace(directory: ErasureDirectoryCapture, excluded: ReadonlySet<string> = new Set(), kind: 'names' | 'full' = 'names'): ErasureNamespace {
    return erasureNamespace(directory, excluded, this.protocol.schema, kind);
  }
  get workReport() { return Object.freeze({ actual: Object.freeze({ ...this.inspection.accounting.actual }),
    discovery: this.inspection.accounting.discoveryConsumed, reservedDirectoryReads: this.inspection.accounting.reservedDirectoryReads }); }
  private journalLocator(): string { return `.memory-owners/owners/${erasureJournalName(this.binding.ownerId)}`; }
  private sameProtocol(value: ErasureProtocol): void {
    if (value.schema !== this.record.schema || value.domain !== this.record.domain) erasureFail();
  }
  private sameBinding(value: ErasureBinding): void {
    for (const field of ['userId', 'ownerId', 'deleteOperationId', 'operationId'] as const) {
      if (value[field] !== this.binding[field]) erasureFail();
    }
  }
  private async barrier(publication: ErasurePublication, proof: () => Promise<void>): Promise<void> {
    await this.hook?.(publication); await proof();
  }
  private archiveExclusions(head: ErasureHeadPreparation, locator: string, next: string): Set<string> {
    const excluded = new Set([next]);
    if (locator === '.' && !head.locator.includes('/')) {
      excluded.add(head.locator);
      excluded.add(`.${evidenceDigest(head.locator)}.memory-owner.json`);
      excluded.add(`.${evidenceDigest(head.locator)}.memory-write.json`);
    }
    return excluded;
  }
  /** First missing component is witnessed by its genuine existing parent, without mkdir. */
  async archiveWitness(head: ErasureHeadPreparation): Promise<ErasureArchiveWitness> {
    const forbidden = await this.forbiddenIdentities(head);
    const locators = ['.', 'volumes', 'volumes/by-id', `volumes/by-id/${this.binding.ownerId}`];
    const existing: ErasureNamespace[] = [], physical = new Set<string>();
    let previous: ErasureDirectoryCapture | undefined;
    for (const [index, locator] of locators.entries()) {
      try { await this.inspection.lstat(locator); }
      catch (cause) {
        if (index === 0 || evidenceCauseCode(cause) !== 'ENOENT') throw cause;
        const parent = await this.sharedDirectory(locators[index - 1], index !== 1);
        this.canonicalSpelling(parent, locator.split('/').at(-1)!, false);
        if (!equal(this.namespace(parent, this.archiveExclusions(head, locators[index - 1], locator.split('/').at(-1)!)), existing[index - 1])) erasureFail();
        return { firstMissing: index, existing };
      }
      if (previous) this.canonicalSpelling(previous, locator.split('/').at(-1)!, true);
      const directory = index === 3 ? await this.inspection.directory(locator) : await this.sharedDirectory(locator, index !== 0);
      if (index < 3) this.canonicalSpelling(directory, locators[index + 1].split('/').at(-1)!);
      previous = directory;
      const key = `${directory.identity.device}:${directory.identity.inode}`;
      if (physical.has(key) || index > 0 && forbidden.has(key)) erasureFail(); physical.add(key);
      existing.push(this.namespace(directory, index < 3 ? this.archiveExclusions(head, locator, locators[index + 1].split('/').at(-1)!) : new Set(), index === 3 ? 'full' : 'names'));
    }
    return { firstMissing: null, existing };
  }
  private async forbiddenIdentities(head = this.record.head): Promise<Set<string>> {
    const fence = await this.inspection.lstat('.memory-fences');
    const observed = { device: String(fence.dev), inode: String(fence.ino), mode: String(fence.mode), uid: String(fence.uid) };
    if (!fence.isDirectory() || fence.isSymbolicLink() || fence.uid !== BigInt(process.getuid!()) ||
      this.fence && !equal(this.fence, observed)) erasureFail();
    this.fence = observed;
    return new Set([...head.namespace.map(item => `${item.device}:${item.inode}`), `${fence.dev}:${fence.ino}`]);
  }
  private canonicalSpelling(parent: ErasureDirectoryCapture, name: string, present?: boolean): void {
    if (present !== undefined && parent.names.includes(name) !== present || parent.names.some(item => item.toLowerCase() === name.toLowerCase() && item !== name)) erasureFail();
  }
  private async readJournal(): Promise<void> {
    const artifact = await this.inspection.record(this.journalLocator());
    this.record = erasureParseRecord(artifact.raw); this.sameBinding(this.record);
    this.authority.set(this.journalLocator(), artifact);
    this.registryDirectory = await this.sharedDirectory('.memory-owners/owners');
    const prefix = `${this.binding.ownerId}.erase`;
    const allowed = new Set([erasureJournalName(this.binding.ownerId)]);
    if (this.record.manifest) for (let ordinal = this.record.manifest.anchor?.ordinal ?? this.record.manifest.segments;
      ordinal < this.record.manifest.segments; ordinal++) allowed.add(erasureSegmentName(this.binding.ownerId, this.binding.operationId, ordinal));
    if (this.registryDirectory.names.some(name => name.toLowerCase().startsWith(prefix) && !allowed.has(name))) erasureFail();
    const registryLocator = `.memory-owners/owners/${this.binding.ownerId}.json`;
    try {
      const registry = await this.inspection.record(registryLocator);
      const raw = JSON.stringify({ schema: 1, state: 'HEAD_DELETED', userId: this.binding.userId,
        ownerId: this.binding.ownerId, operationId: this.binding.deleteOperationId });
      if (registry.raw !== raw || !equal(registry.identity, this.record.head.registry.identity) || registry.digest !== this.record.head.registry.digest) erasureFail();
      this.authority.set(registryLocator, registry);
    } catch (cause) {
      if (evidenceCauseCode(cause) !== 'ENOENT' || this.record.state !== 'RETIRE_ACTION_PREPARED' || this.record.retirement?.kind !== 'registry') throw cause;
    }
  }
  private captureChildren(observed: ErasureDirectoryCapture, ignored: ReadonlySet<string> = new Set()): unknown[] {
    return erasureNamesCapture(observed) ? observed.names.filter(name => !ignored.has(name)) :
      observed.children.filter(child => !ignored.has(child.name)).map(stableEvidenceChild);
  }
  private sameCaptureChildren(a: ErasureDirectoryCapture, b: ErasureDirectoryCapture): boolean {
    if (erasureNamesCapture(a) !== erasureNamesCapture(b)) erasureFail();
    return equal(this.captureChildren(a), this.captureChildren(b));
  }
  /** Drain a complete readonly chunk; retain every ordered failure, including sibling closes. */
  private proofFailures(results: readonly PromiseSettledResult<void>[]): void {
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw Object.assign(new AggregateError(failures, 'Erasure readonly proof observations failed',
      { cause: failures[0] }), { code: evidenceCauseCode(failures[0]) });
  }
  private async registryProof(captured?: ErasureDirectoryCapture): Promise<void> {
    const observed = captured ?? await this.sharedDirectory('.memory-owners/owners');
    if (!erasureSameDirectory(this.inspection.binding(this.registryDirectory), observed) ||
      !this.sameCaptureChildren(observed, this.registryDirectory)) erasureFail();
    const own = observed.names.filter(name => name.toLowerCase().startsWith(`${this.binding.ownerId}.erase`) ||
      name.toLowerCase().startsWith(`${this.binding.ownerId}.json`));
    const expected = [...this.authority.keys()].map(locator => locator.split('/').at(-1)!).sort();
    if (!equal(own, expected)) erasureFail();
    if (this.protocol.schema === 2) {
      const artifacts = [...this.authority];
      for (let offset = 0; offset < artifacts.length; offset += 16) {
        const results = await Promise.allSettled(artifacts.slice(offset, offset + 16).map(async ([locator, artifact]) => {
          const current = await this.inspection.record(locator);
          if (!equal(current.identity, artifact.identity) || current.digest !== artifact.digest ||
            current.mode !== artifact.mode || current.uid !== artifact.uid || current.links !== artifact.links) erasureFail();
        }));
        this.proofFailures(results);
      }
    } else {
      for (const [locator, artifact] of this.authority) {
        const current = await this.inspection.record(locator);
        if (!equal(current.identity, artifact.identity) || current.digest !== artifact.digest ||
          current.mode !== artifact.mode || current.uid !== artifact.uid || current.links !== artifact.links) erasureFail();
      }
    }
  }
  private async registryTransition(removed: string[], added: Map<string, ErasureArtifact>): Promise<void> {
    const observed = await this.sharedDirectory('.memory-owners/owners');
    if (!erasureSameDirectory(this.inspection.binding(this.registryDirectory), observed)) erasureFail();
    const ignored = new Set([...removed, ...added.keys()].map(locator => locator.split('/').at(-1)!));
    const before = this.captureChildren(this.registryDirectory, ignored);
    const after = this.captureChildren(observed, ignored);
    if (!equal(before, after)) erasureFail();
    for (const locator of removed) if (observed.names.includes(locator.split('/').at(-1)!)) erasureFail();
    for (const [locator, artifact] of added) {
      const name = locator.split('/').at(-1)!;
      const child = erasureNamesCapture(observed) ? observed.names.includes(name) ? await this.inspection.file(locator) : undefined : observed.children.find(item => item.name === name);
      if (!child || child.directory || !equal(child.identity, artifact.identity) ||
        child.mode !== artifact.mode || child.uid !== artifact.uid || child.links !== artifact.links) erasureFail();
    }
    if (erasureNamesCapture(observed) && added.size) await this.inspection.recheckDirectory(observed);
    for (const locator of removed) this.authority.delete(locator);
    for (const [locator, artifact] of added) this.authority.set(locator, artifact);
    this.registryDirectory = observed;
    await this.registryProof(observed);
  }
  private async publish(raw: string, locator: string, replace: boolean): Promise<ErasureArtifact> {
    const stage = `.memory-owners/owners/${erasureStageName(locator.split('/').at(-1)!, this.binding.operationId)}`;
    if (this.registryDirectory.names.includes(stage.split('/').at(-1)!) ||
      (replace ? !this.authority.has(locator) : this.registryDirectory.names.includes(locator.split('/').at(-1)!))) erasureFail();
    const artifact = await this.inspection.writeRecord(stage, raw, () => this.registryProof());
    await this.registryTransition([], new Map([[stage, artifact]]));
    await this.registryProof();
    await this.inspection.rename(stage, locator);
    const named = await this.inspection.record(locator);
    // Rename can change ctime; the freshly named descriptor binds subsequent authority.
    if (named.identity.device !== artifact.identity.device || named.identity.inode !== artifact.identity.inode ||
      named.identity.size !== artifact.identity.size || named.identity.mtimeNs !== artifact.identity.mtimeNs || named.digest !== artifact.digest) erasureFail();
    await this.registryTransition([stage], new Map([[locator, named]]));
    await this.inspection.syncDirectory(this.inspection.binding(this.registryDirectory), () => this.registryProof());
    return this.authority.get(locator)!;
  }
  private async acknowledge(next: ErasureRecord, publication: ErasurePublication): Promise<void> {
    erasureValidateRecord(next);
    await this.publish(erasureSerialize(next), this.journalLocator(), true);
    this.record = next;
    await this.barrier(publication, () => this.registryProof());
  }
  private async publishInventory(): Promise<void> {
    const archive = this.record.archive!;
    this.nodes = archive.firstMissing === null ? await this.inspection.inventory(this.binding.ownerId, await this.forbiddenIdentities()) : [];
    const groups = erasurePack(this.binding, this.nodes, this.protocol);
    this.validateWholeInventory({ nodes: this.nodes.length, segments: groups.length,
      sha256: erasureInventoryDigest(this.nodes), anchor: null });
    this.preflightInventory(groups.length);
    this.reserveSchedule(groups.length);
    await this.archiveProof(0);
    let successor: ErasureAnchor | null = null;
    // Immutable complete envelopes are published backwards; no self-referential size placeholders.
    for (let ordinal = groups.length - 1; ordinal >= 0; ordinal--) {
      const nodes = groups[ordinal];
      const segment: ErasureSegment = { ...this.protocol, ...this.binding, ordinal,
        total: groups.length, first: nodes[0].index, nodes, successor };
      const locator = `.memory-owners/owners/${erasureSegmentName(this.binding.ownerId, this.binding.operationId, ordinal)}`;
      const artifact = await this.publish(erasureSerialize(segment), locator, false);
      successor = { ordinal, identity: artifact.identity, digest: artifact.digest };
      await this.barrier('segment-durable', () => this.registryProof());
    }
    await this.acknowledge({ ...this.record, state: 'INVENTORY_READY', cursor: 0,
      manifest: { nodes: this.nodes.length, segments: groups.length, sha256: erasureInventoryDigest(this.nodes), anchor: successor } }, 'inventory-durable');
  }
  private preflightInventory(segments: number): void {
    const identity = erasureMaximumIdentity(), anchor = segments ? { ordinal: 4095, identity, digest: 'f'.repeat(64) } : null;
    const manifest = { nodes: 4096, segments: 4096, sha256: 'f'.repeat(64), anchor };
    const base = { ...this.record, manifest, cursor: 4096 };
    for (const state of ['INVENTORY_READY', 'OWNER_ROOT_REMOVED', 'EVIDENCE_RETIRING'] as const) erasureSerialize({ ...base, state });
    for (const node of this.nodes) {
      const parent = node.parent === null ? 'volumes/by-id' : this.locator(node.parent);
      const binding = { locator: parent, device: identity.device, inode: identity.inode, mode: '9'.repeat(20), uid: '9'.repeat(20) };
      erasureSerialize({ ...base, state: 'ACTION_PREPARED', action: { index: 4095, parent: binding,
        name: node.name, directory: node.directory, identity, mode: '9'.repeat(20), uid: '9'.repeat(20), links: '9'.repeat(20),
        beforeCount: 4095, beforeDigest: 'f'.repeat(64), afterCount: 4094, afterDigest: 'f'.repeat(64) } });
    }
    for (let ordinal = 0; ordinal < segments; ordinal++) {
      const name = erasureSegmentName(this.binding.ownerId, this.binding.operationId, ordinal);
      this.inspection.absolute(`.memory-owners/owners/${name}`);
      this.inspection.absolute(`.memory-owners/owners/${erasureStageName(name, this.binding.operationId)}`);
      erasureSerialize({ ...base, state: 'RETIRE_ACTION_PREPARED', retirement: { kind: 'segment', name,
        artifact: { identity, mode: '9'.repeat(20), uid: '9'.repeat(20), links: '1', digest: 'f'.repeat(64) },
        successor: { ordinal: 4095, identity, digest: 'f'.repeat(64) }, beforeCount: 4095, beforeDigest: 'f'.repeat(64),
        afterCount: 4094, afterDigest: 'f'.repeat(64) } });
    }
    erasureSerialize({ ...base, state: 'RETIRE_ACTION_PREPARED', retirement: { kind: 'registry', name: `${this.binding.ownerId}.json`,
      artifact: { identity, mode: '9'.repeat(20), uid: '9'.repeat(20), links: '1', digest: 'f'.repeat(64) }, successor: null,
      beforeCount: 4095, beforeDigest: 'f'.repeat(64), afterCount: 4094, afterDigest: 'f'.repeat(64) } });
  }
  private reserveSchedule(segments: number): void {
    const N = this.record.manifest?.nodes ?? this.nodes.length, K = this.record.manifest?.segments ?? segments;
    const R = this.record.head.namespace.find(item => item.locator === '.memory-owners/owners')!;
    // Foreign R children + registry + journal + immutable segments + one exclusive stage + EOF.
    const qR = R.childCount + K + 5;
    if (qR > 4096) erasureFail('EHEADRESOURCE');
    const headParent = this.record.head.locator.split('/').slice(0, -1).join('/') || '.';
    const qHead = this.record.head.namespace.reduce((sum, item) => sum + (item.locator === '.memory-owners/owners' ? qR :
      item.childCount + 1 + (item.locator === headParent ? 2 : 0)), 0);
    const qReplacementHead = this.record.head.namespace.find(item => item.locator === headParent)!.childCount + 3;
    const qReplacement = 2 * qReplacementHead + qR;
    const witness = this.record.archive!;
    const qPrefix = witness.existing.slice(0, 3).reduce((sum, item, index) => sum + item.childCount + 1 +
      (index + 1 < witness.existing.length ? 1 : 0) + (item.locator === '.' && headParent === '.' ? 3 : 0), 0) +
      (witness.firstMissing === null ? 0 : witness.existing[witness.firstMissing - 1].childCount + 1 +
        (witness.firstMissing === 1 && headParent === '.' ? 3 : 0));
    const qPrefixRoot = witness.existing[0].childCount + 1 + (witness.existing.length > 1 ? 1 : 0) +
      (headParent === '.' ? 3 : 0);
    let directories = this.nodes.filter(node => node.directory).length;
    // Within one critical proof, the head namespace's complete root/R observations also prove
    // archive-root and registry policies. Every subsequent proof captures fresh observations.
    const M = (cursor: number, directoryCount: number) => qHead + qPrefix - qPrefixRoot + qReplacement + directoryCount + Math.max(0, N - cursor - 1);
    // Each complete proof's tree component is N-cursor-1 surviving child entries plus one EOF per surviving directory.
    // Each transition's complete R capture also proves its immediate artifact policy.
    // Staged publication7R plus durable hook1R; inventory acknowledgement8R.
    let reads = M(0, directories) + 8 * K * qR + 8 * qR;
    const parentChildren = new Map<number, number>();
    for (const node of this.nodes) if (node.parent !== null) parentChildren.set(node.parent, (parentChildren.get(node.parent) ?? 0) + 1);
    for (const node of this.nodes) {
      const current = M(node.index, directories);
      if (node.directory) directories--;
      const next = M(node.index + 1, directories);
      const qBefore = node.parent === null ? witness.existing[2].childCount + 2 : (parentChildren.get(node.parent) ?? 0) + 1;
      if (node.parent !== null) parentChildren.set(node.parent, qBefore - 2);
      // Prepare+before-action2 current proofs; after-action/post/sync5 next proofs;
      // parent censuses2 before+5 after; two acknowledgements16R.
      reads += 2 * current + 5 * next + 2 * qBefore + 5 * (qBefore - 1) + 16 * qR;
    }
    const removed = M(N, 0);
    // Independent retiring authority; each segment6 absence proofs+22R, tombstone6+14R,
    // final unlink/sync/return6 absence proofs+1R. Empty witness qualification4 proofs+8R.
    reads += removed + 8 * qR + K * (6 * removed + 22 * qR) + 6 * removed + 14 * qR + 6 * removed + qR;
    if (N === 0) reads += 4 * removed + 8 * qR;
    if (!Number.isSafeInteger(reads)) erasureFail('EHEADRESOURCE');
    const W = 2 * N + 3 * K + 5, Y = W + N + K + 3;
    // Root-action parent proofs and evidence-retirement parent proofs use full shared
    // directory observations, including one lstat per child rather than names alone.
    const rootParentChildStats = this.nodes.some(node => node.parent === null) ?
      7 * (witness.existing[2].childCount + 1) : 0;
    const fullSharedChildStats = rootParentChildStats + 5 * (K + 1) * (qR - 1);
    this.reserveFiniteOperations(reads, W, Y, N, K, 7 * N + 6 * K + 20, 'owner-and-evidence', fullSharedChildStats);
  }
  private reserveFiniteOperations(reads: number, W: number, Y: number, N: number, K: number, proofs: number,
    phase: 'head-tail' | 'owner-and-evidence', fullSharedChildStats = 0): void {
    const namesOnly = this.protocol.schema === 2;
    // Every current proof/publication census remains. V2 bounds complete observation calls,
    // rather than charging a child lstat for every unrelated name read.
    const captures = proofs * (this.record.head.namespace.length + N + 7) + 8 * W + 7 * N + 5 * (K + 1) + 20;
    const recordProofs = proofs + 8 * W + 2 * (K + 3) + 10;
    const L = namesOnly ? recordProofs * (K + 3) + 3 * proofs + 2 * W + 3 * K + 2 * (N + 1) + 20 :
      reads * (K + 2) + 2 * W + 3 * K + 2 * (N + 1) + 3 * proofs;
    const fileOpens = L + W + N * proofs + proofs + (namesOnly ? 2 * W : 0);
    const directoryOpens = 2 * (namesOnly ? captures : reads) + Y;
    const lstats = namesOnly ? 2 * captures + 3 * N * proofs + 2 * L + 8 * W + 5 * proofs + 20 * (N + K + 1) + fullSharedChildStats :
      4 * reads + 2 * L + 2 * W + 20 * (N + K + 1);
    this.inspection.accounting.reserve([{ weight: 1, repetitions: reads }], phase);
    this.inspection.accounting.reserveOperations({ directoryReads: reads, censuses: namesOnly ? captures : reads, lstats,
      directoryOpens, fileOpens, descriptorStats: 2 * (directoryOpens + fileOpens), recordReads: 8193 * L,
      recordReadBytes: 8193 * L, recordWrites: 8192 * W, recordWriteBytes: 8192 * W,
      fileSyncs: W, directorySyncs: Y, closes: directoryOpens + fileOpens,
      mutations: 2 * W + N + K + 2, chainValidations: K * (K + N + 2),
      replacementHeadReads: proofs * (3 * MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE + 1),
      replacementHeadReadBytes: proofs * (3 * MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE + 1), archiveMutationAttempts: N }, phase);
  }
  private locator(index: number): string {
    const components: string[] = []; let current = this.nodes[index];
    const seen = new Set<number>();
    while (current) {
      if (seen.has(current.index)) erasureFail(); seen.add(current.index); components.unshift(current.name);
      if (current.parent === null) break;
      current = this.nodes[current.parent];
    }
    if (!current || components[0] !== this.binding.ownerId) erasureFail();
    return `volumes/by-id/${components.join('/')}`;
  }
  private validateWholeInventory(manifest: ErasureManifest = this.record.manifest!): void {
    const physical = new Set<string>();
    if (this.nodes.length > ERASURE_NODE_LIMIT || this.nodes.length !== manifest.nodes) erasureFail();
    if (this.record.archive!.firstMissing === null ? !this.nodes.length : this.nodes.length !== 0) erasureFail();
    for (const [index, node] of this.nodes.entries()) {
      if (node.index !== index || node.parent === null && index !== this.nodes.length - 1 ||
        node.parent !== null && (!this.nodes[node.parent]?.directory || node.parent <= index)) erasureFail();
      const key = `${node.identity.device}:${node.identity.inode}`;
      if (physical.has(key) || node.identity.device !== this.inspection.device) erasureFail(); physical.add(key);
      const locator = this.locator(index);
      if (locator.split('/').length - 3 > 16) erasureFail('EHEADRESOURCE');
      this.inspection.absolute(locator);
      const children = this.nodes.filter(item => item.parent === index).map(item => item.name).sort();
      if (new Set(children).size !== children.length || children.length !== node.childCount ||
        erasureNamesDigest(children) !== node.sha256) erasureFail();
    }
    if (erasureInventoryDigest(this.nodes) !== manifest.sha256) erasureFail();
    if (this.nodes.length) {
      const root = this.nodes.at(-1)!, bound = this.record.archive!.existing[3];
      if (!root.directory || root.parent !== null || root.name !== this.binding.ownerId || root.identity.device !== bound.device ||
        root.identity.inode !== bound.inode || root.mode !== bound.mode || root.uid !== bound.uid) erasureFail();
    }
  }
  /** Authenticate every immutable successor; never authorize through a vanished predecessor. */
  private async loadInventory(): Promise<void> {
    const manifest = this.record.manifest!;
    this.nodes = []; let anchor: ErasureAnchor | null = manifest.anchor;
    if (manifest.nodes === 0) { this.validateWholeInventory(); return; }
    if (!anchor || anchor.ordinal !== 0) erasureFail();
    const physical = new Set<string>();
    for (let ordinal = 0; ordinal < manifest.segments; ordinal++) {
      if (!anchor || anchor.ordinal !== ordinal) erasureFail();
      this.inspection.accounting.charge('chainValidations');
      const artifact = await this.inspection.record(`.memory-owners/owners/${erasureSegmentName(this.binding.ownerId, this.binding.operationId, ordinal)}`);
      if (!equal(artifact.identity, anchor.identity) || artifact.digest !== anchor.digest) erasureFail();
      const key = `${artifact.identity.device}:${artifact.identity.inode}`;
      if (physical.has(key)) erasureFail(); physical.add(key);
      const segment = erasureParseSegment(artifact.raw); this.sameBinding(segment); this.sameProtocol(segment);
      if (segment.ordinal !== ordinal || segment.total !== manifest.segments || segment.first !== this.nodes.length) erasureFail();
      this.authority.set(`.memory-owners/owners/${erasureSegmentName(this.binding.ownerId, this.binding.operationId, ordinal)}`, artifact);
      this.nodes.push(...segment.nodes); anchor = segment.successor;
    }
    if (anchor !== null) erasureFail(); this.validateWholeInventory();
    if (this.record.action) {
      const action = this.record.action, node = this.nodes[this.record.cursor!];
      const parent = node.parent === null ? 'volumes/by-id' : this.locator(node.parent);
      if (action.name !== node.name || action.directory !== node.directory || action.parent.locator !== parent ||
        action.identity.device !== node.identity.device || action.identity.inode !== node.identity.inode ||
        action.mode !== node.mode || action.uid !== node.uid || (!node.directory && action.links !== node.links)) erasureFail();
    }
  }
  private async proveArchive(cursor: number, capturedRoot?: ErasureDirectoryCapture): Promise<void> {
    const witness = this.record.archive!;
    const forbidden = await this.forbiddenIdentities();
    let missingParent: ErasureDirectoryCapture | undefined;
    for (const [index, namespace] of witness.existing.entries()) {
      if (index === 3) continue;
      const observed = index === 0 && capturedRoot ? capturedRoot :
        await this.sharedDirectory(namespace.locator, index !== 0);
      if (!erasureSameDirectory(namespace, observed)) erasureFail();
      if (index > 0 && forbidden.has(`${observed.identity.device}:${observed.identity.inode}`)) erasureFail();
      const names = ['volumes', 'by-id', this.binding.ownerId];
      const total = this.record.manifest?.nodes ?? (this.record.state === 'ERASURE_READY' ? 1 : this.nodes.length);
      this.canonicalSpelling(observed, names[index], index + 1 < witness.existing.length && (index !== 2 || cursor < total));
      // Next canonical chain identity is independently bound; every unrelated child remains committed.
      if (!equal(this.namespace(observed, this.archiveExclusions(this.record.head, namespace.locator, names[index])), namespace)) erasureFail();
      if (index + 1 === witness.firstMissing) missingParent = observed;
    }
    if (witness.firstMissing !== null) {
      const locators = ['.', 'volumes', 'volumes/by-id', `volumes/by-id/${this.binding.ownerId}`];
      try { await this.inspection.lstat(locators[witness.firstMissing]); }
      catch (cause) {
        if (evidenceCauseCode(cause) !== 'ENOENT') throw cause;
        const parent = await this.sharedDirectory(locators[witness.firstMissing - 1], witness.firstMissing !== 1);
        this.canonicalSpelling(parent, locators[witness.firstMissing].split('/').at(-1)!, false);
        if (!missingParent || !equal(parent.identity, missingParent.identity) || parent.mode !== missingParent.mode ||
          parent.uid !== missingParent.uid || parent.links !== missingParent.links || !this.sameCaptureChildren(parent, missingParent)) erasureFail();
        return;
      }
      erasureFail();
    }
    if (this.protocol.schema === 2) {
      const remainingNodes = this.nodes.slice(cursor);
      for (let offset = 0; offset < remainingNodes.length; offset += 16) {
        const results = await Promise.allSettled(remainingNodes.slice(offset, offset + 16).map(async node => {
          if (forbidden.has(`${node.identity.device}:${node.identity.inode}`)) erasureFail();
          const locator = this.locator(node.index);
          if (node.directory) {
            const observed = await this.inspection.directory(locator);
            if (observed.identity.device !== node.identity.device || observed.identity.inode !== node.identity.inode ||
              observed.mode !== node.mode || observed.uid !== node.uid) erasureFail();
            const remaining = this.nodes.filter(child => child.parent === node.index && child.index >= cursor).map(child => child.name).sort();
            if (!equal(observed.names, remaining)) erasureFail();
          } else {
            const observed = await this.inspection.file(locator);
            if (!equal(observed.identity, node.identity) || observed.mode !== node.mode || observed.uid !== node.uid || observed.links !== node.links) erasureFail();
          }
        }));
        this.proofFailures(results);
      }
    } else {
      for (const node of this.nodes.slice(cursor)) {
        if (forbidden.has(`${node.identity.device}:${node.identity.inode}`)) erasureFail();
        const locator = this.locator(node.index);
        if (node.directory) {
          const observed = await this.inspection.directory(locator);
          if (observed.identity.device !== node.identity.device || observed.identity.inode !== node.identity.inode ||
            observed.mode !== node.mode || observed.uid !== node.uid) erasureFail();
          const remaining = this.nodes.filter(child => child.parent === node.index && child.index >= cursor).map(child => child.name).sort();
          if (!equal(observed.names, remaining)) erasureFail();
        } else {
          const observed = await this.inspection.file(locator);
          if (!equal(observed.identity, node.identity) || observed.mode !== node.mode || observed.uid !== node.uid || observed.links !== node.links) erasureFail();
        }
      }
    }
    if (cursor === (this.record.manifest?.nodes ?? this.nodes.length)) {
      try { await this.inspection.lstat(`volumes/by-id/${this.binding.ownerId}`); }
      catch (cause) { if (evidenceCauseCode(cause) === 'ENOENT') return; throw cause; }
      erasureFail();
    }
  }
  private async proveNamespaces(): Promise<ReadonlyMap<string, ErasureDirectoryCapture>> {
    const selected = new Set([this.binding.ownerId + '.json', erasureJournalName(this.binding.ownerId)]);
    if (this.record.manifest) for (let ordinal = 0; ordinal < this.record.manifest.segments; ordinal++) {
      selected.add(erasureSegmentName(this.binding.ownerId, this.binding.operationId, ordinal));
    }
    const observations: { namespace: ErasureNamespace; observed: ErasureDirectoryCapture }[] = [];
    for (const namespace of this.record.head.namespace) {
      const observed = await this.sharedDirectory(namespace.locator, namespace.locator.startsWith('.memory-owners'));
      if (!erasureSameDirectory(namespace, observed)) erasureFail();
      observations.push({ namespace, observed });
    }
    const replacement = await this.proveHead();
    for (const { namespace, observed } of observations) {
      let excluded = new Set<string>();
      if (namespace.locator === '.memory-owners/owners') excluded = selected;
      if (namespace.locator === '.memory-owners/owners' && replacement?.token.ownership === 'owned') {
        const name = `${replacement.token.ownerId}.json`, artifact = replacement.registryEvidence;
        const child = erasureNamesCapture(observed) ? observed.names.includes(name) ? await this.inspection.file(`.memory-owners/owners/${name}`) : undefined : observed.children.find(item => item.name === name);
        if (!child || !equal(child.identity, artifact.identity) || child.mode !== artifact.mode || child.uid !== artifact.uid || child.links !== artifact.links) erasureFail();
        if (erasureNamesCapture(observed)) await this.inspection.recheckDirectory(observed);
        excluded.add(name);
      }
      const parts = this.record.head.locator.split('/'), name = parts.pop()!, parent = parts.join('/') || '.';
      if (namespace.locator === parent) excluded = new Set([...excluded, name,
        `.${evidenceDigest(name)}.memory-owner.json`, `.${evidenceDigest(name)}.memory-write.json`]);
      if (!equal(this.namespace(observed, excluded), namespace)) erasureFail();
    }
    return new Map(observations.map(({ observed }) => [observed.locator, observed]));
  }
  private async optionalHeadChild(locator: string): Promise<import('node:fs').BigIntStats | undefined> {
    try { return await this.inspection.lstat(locator); }
    catch (cause) { if (evidenceCauseCode(cause) === 'ENOENT') return undefined; throw cause; }
  }
  private async proveHead(): Promise<ErasureReplacementSnapshot | undefined> {
    const locator = this.record.head.locator, parts = locator.split('/'), name = parts.pop()!, parent = parts.join('/');
    const sibling = (suffix: string) => `${parent ? `${parent}/` : ''}.${evidenceDigest(name)}.${suffix}`;
    const journal = sibling('memory-write.json');
    if (await this.optionalHeadChild(journal)) {
      if (this.record.state !== 'HEAD_PREPARED') erasureFail();
      const artifact = await this.inspection.record(journal);
      if (!equal(artifact.identity, this.record.head.intent.identity) || artifact.digest !== this.record.head.intent.digest) erasureFail();
      const intent = JSON.parse(artifact.raw) as { state?: unknown; binding?: Partial<ErasureBinding> & { locator?: unknown } };
      if (intent.state !== 'TERMINAL' || intent.binding?.userId !== this.binding.userId || intent.binding.ownerId !== this.binding.ownerId ||
        intent.binding.operationId !== this.binding.deleteOperationId || intent.binding.locator !== locator) erasureFail();
    }
    const head = await this.optionalHeadChild(locator), sidecar = await this.optionalHeadChild(sibling('memory-owner.json'));
    if (!head && !sidecar) return;
    if (!head && sidecar && this.record.state === 'HEAD_PREPARED') {
      const artifact = await this.inspection.record(sibling('memory-owner.json'));
      if (!equal(artifact.identity, this.record.head.sidecar.identity) || artifact.digest !== this.record.head.sidecar.digest) erasureFail();
      return;
    }
    if (!head || !sidecar || !this.replacement || head.isSymbolicLink() || !head.isFile()) erasureFail();
    const snapshot = await this.replacement(locator, this.inspection);
    const current = { device: String(head.dev), inode: String(head.ino), size: String(head.size),
      mtimeNs: String(head.mtimeNs), ctimeNs: String(head.ctimeNs) };
    if (snapshot.token.ownership !== 'owned' || snapshot.token.ownerId === this.binding.ownerId ||
      snapshot.token.userId !== this.binding.userId || snapshot.token.tenantRoot !== this.inspection.root ||
      !equal(snapshot.token.fileIdentity, current) || equal(current, this.record.head.originalHeadIdentity)) erasureFail();
    return snapshot;
  }
  private async completeHeadPreparation(): Promise<void> {
    const headParent = this.record.head.locator.split('/').slice(0, -1).join('/') || '.';
    const R = this.record.head.namespace.find(item => item.locator === '.memory-owners/owners')!;
    const qR = R.childCount + 5;
    if (qR > 4096) erasureFail('EHEADRESOURCE');
    const qH = this.record.head.namespace.find(item => item.locator === headParent)!.childCount + 3;
    const P = this.record.head.namespace.reduce((sum, item) => sum + (item.locator === '.memory-owners/owners' ? qR :
      item.childCount + 1 + (item.locator === headParent ? 2 : 0)), 0) + 2 * qH + qR;
    // Two exact retirement prefixes6P each, final H qualification3P, witness guards2P;
    // READY acknowledgement10R, at most six bounded canonical prefix censuses and discovery4096.
    // A genuine replacement sidecar can require one additional standalone owned-head observation.
    this.reserveFiniteOperations(17 * P + 2 * qH + qR + 10 * qR + 7 * 4096, 1, 4, 2, 0, 18, 'head-tail');
    const proof = async () => { const captured = await this.proveNamespaces(); await this.registryProof(captured.get('.memory-owners/owners')); };
    const name = this.record.head.locator.split('/').at(-1)!;
    const siblings = [`.${evidenceDigest(name)}.memory-owner.json`, `.${evidenceDigest(name)}.memory-write.json`];
    for (const [index, basename] of siblings.entries()) {
      const locator = `${headParent === '.' ? '' : `${headParent}/`}${basename}`;
      await proof();
      const present = await this.optionalHeadChild(locator);
      if (present) {
        const current = await this.inspection.record(locator), expected = index === 0 ? this.record.head.sidecar : this.record.head.intent;
        if (!equal(current.identity, expected.identity) || current.digest !== expected.digest) {
          if (index !== 0 || !await this.proveHead()) erasureFail();
        } else await this.inspection.remove(locator, false);
      }
      await proof();
      const parent = this.record.head.namespace.find(item => item.locator === headParent)!;
      await this.inspection.syncDirectory(parent, proof); await proof();
    }
    await this.inspection.syncDirectory(this.record.head.namespace.find(item => item.locator === headParent)!, proof);
    this.headQualified = true;
    await proof(); const archive = await this.archiveWitness(this.record.head); await proof();
    await this.acknowledge({ ...this.record, state: 'ERASURE_READY', archive }, 'ready-durable');
  }
  private async qualifyReadyHead(): Promise<void> {
    const parent = this.record.head.locator.split('/').slice(0, -1).join('/') || '.';
    const K = this.record.manifest?.segments ?? 0;
    const R = this.record.head.namespace.find(item => item.locator === '.memory-owners/owners')!, qR = R.childCount + K + 5;
    const qH = this.record.head.namespace.find(item => item.locator === parent)!.childCount + 3;
    if (qR > 4096) erasureFail('EHEADRESOURCE');
    const P = this.record.head.namespace.reduce((sum, item) => sum + (item.locator === '.memory-owners/owners' ? qR :
      item.childCount + 1 + (item.locator === parent ? 2 : 0)), 0) + 2 * qH + qR;
    this.reserveFiniteOperations(3 * P + 7 * 4096, 0, 1, 0, K, 3, 'head-tail');
    const proof = async () => { const captured = await this.proveNamespaces(); await this.registryProof(captured.get('.memory-owners/owners')); };
    await this.inspection.syncDirectory(this.record.head.namespace.find(item => item.locator === parent)!, proof);
    this.headQualified = true;
  }
  private async archiveProof(cursor: number): Promise<void> {
    const captured = await this.proveNamespaces();
    await this.registryProof(captured.get('.memory-owners/owners'));
    await this.proveArchive(cursor, captured.get('.'));
  }
  private async parentCommitment(cursor: number, after: boolean): Promise<HeadDirectory> {
    const node = this.nodes[cursor], locator = this.locator(cursor);
    const parent = node.parent === null ? 'volumes/by-id' : this.locator(node.parent);
    const observed = await this.inspection.directory(parent);
    const action = this.record.action;
    if (action) {
      if (!erasureSameDirectory(action.parent, observed) || observed.names.length !== (after ? action.afterCount : action.beforeCount) ||
        erasureNamesDigest(observed.names) !== (after ? action.afterDigest : action.beforeDigest)) erasureFail();
    } else if (!observed.names.includes(locator.split('/').at(-1)!)) erasureFail();
    return observed;
  }
  private async prepareAction(): Promise<void> {
    const cursor = this.record.cursor!, node = this.nodes[cursor];
    await this.archiveProof(cursor);
    const parent = await this.parentCommitment(cursor, false), current = await this.inspection.lstat(this.locator(cursor));
    const identity = { device: String(current.dev), inode: String(current.ino), size: String(current.size),
      mtimeNs: String(current.mtimeNs), ctimeNs: String(current.ctimeNs) };
    if (identity.device !== node.identity.device || identity.inode !== node.identity.inode ||
      String(current.mode) !== node.mode || String(current.uid) !== node.uid || current.isDirectory() !== node.directory) erasureFail();
    const after = parent.names.filter(name => name !== node.name);
    await this.acknowledge({ ...this.record, state: 'ACTION_PREPARED', action: { index: cursor,
      parent: this.inspection.binding(parent), name: node.name, directory: node.directory, identity,
      mode: String(current.mode), uid: String(current.uid), links: String(current.nlink),
      beforeCount: parent.names.length, beforeDigest: erasureNamesDigest(parent.names),
      afterCount: after.length, afterDigest: erasureNamesDigest(after) } }, 'action-prepared-durable');
  }
  private async executeAction(): Promise<void> {
    const cursor = this.record.cursor!, action = this.record.action!, locator = this.locator(cursor);
    let present = true;
    try { await this.inspection.lstat(locator); }
    catch (cause) { if (evidenceCauseCode(cause) !== 'ENOENT') throw cause; present = false; }
    if (present) {
      const prove = async () => {
        await this.archiveProof(cursor); await this.parentCommitment(cursor, false);
        const child = await this.inspection.lstat(locator);
        const identity = { device: String(child.dev), inode: String(child.ino), size: String(child.size),
          mtimeNs: String(child.mtimeNs), ctimeNs: String(child.ctimeNs) };
        if (!equal(identity, action.identity) || String(child.mode) !== action.mode || String(child.uid) !== action.uid ||
          String(child.nlink) !== action.links || child.isDirectory() !== action.directory || child.isSymbolicLink()) erasureFail();
      };
      await this.barrier('before-owner-action', prove);
      await this.inspection.remove(locator, action.directory, true);
      this.archiveMutation = true;
      await this.barrier('after-owner-action', async () => { await this.archiveProof(cursor + 1); await this.parentCommitment(cursor, true); });
    }
    const postProof = async () => { await this.archiveProof(cursor + 1); await this.parentCommitment(cursor, true); };
    await postProof(); await this.inspection.syncDirectory(action.parent, postProof);
    const { action: _retired, ...record } = this.record;
    await this.acknowledge({ ...record, state: cursor + 1 === this.nodes.length ? 'OWNER_ROOT_REMOVED' : 'INVENTORY_READY', cursor: cursor + 1 },
      cursor + 1 === this.nodes.length ? 'owner-root-removed-durable' : 'action-durable');
  }
  private async proveRemoved(): Promise<void> {
    await this.archiveProof(this.record.manifest!.nodes);
  }
  private async loadSuffix(): Promise<void> {
    const manifest = this.record.manifest!;
    let anchor = manifest.anchor;
    const pending = this.record.retirement;
    if (pending?.kind === 'segment') {
      const locator = `.memory-owners/owners/${pending.name}`;
      try { await this.inspection.lstat(locator); }
      catch (cause) { if (evidenceCauseCode(cause) !== 'ENOENT') throw cause; anchor = pending.successor; }
    }
    const physical = new Set<string>();
    for (let ordinal = anchor?.ordinal ?? manifest.segments; ordinal < manifest.segments; ordinal++) {
      if (!anchor || anchor.ordinal !== ordinal) erasureFail();
      this.inspection.accounting.charge('chainValidations');
      const locator = `.memory-owners/owners/${erasureSegmentName(this.binding.ownerId, this.binding.operationId, ordinal)}`;
      const artifact = await this.inspection.record(locator), segment = erasureParseSegment(artifact.raw);
      this.sameBinding(segment); this.sameProtocol(segment);
      if (!equal(artifact.identity, anchor.identity) || artifact.digest !== anchor.digest ||
        segment.ordinal !== ordinal || segment.total !== manifest.segments) erasureFail();
      const key = `${artifact.identity.device}:${artifact.identity.inode}`;
      if (physical.has(key)) erasureFail(); physical.add(key);
      this.authority.set(locator, artifact); anchor = segment.successor;
    }
    if (anchor !== null) erasureFail();
  }
  private async prepareRetirement(): Promise<void> {
    await this.proveRemoved();
    const anchor = this.record.manifest!.anchor;
    const name = anchor ? erasureSegmentName(this.binding.ownerId, this.binding.operationId, anchor.ordinal) : `${this.binding.ownerId}.json`;
    const locator = `.memory-owners/owners/${name}`, artifact = await this.inspection.record(locator);
    const successor = anchor ? erasureParseSegment(artifact.raw).successor : null;
    const before = this.registryDirectory.names, after = before.filter(item => item !== name);
    if (after.length !== before.length - 1) erasureFail();
    await this.acknowledge({ ...this.record, state: 'RETIRE_ACTION_PREPARED', retirement: {
      kind: anchor ? 'segment' : 'registry', name, artifact: { identity: artifact.identity,
        mode: artifact.mode, uid: artifact.uid, links: artifact.links, digest: artifact.digest }, successor,
      beforeCount: before.length, beforeDigest: erasureNamesDigest(before),
      afterCount: after.length, afterDigest: erasureNamesDigest(after) } }, 'retire-action-prepared-durable');
  }
  private async retirementParent(after: boolean): Promise<void> {
    const pending = this.record.retirement!, observed = await this.inspection.directory('.memory-owners/owners');
    if (observed.names.length !== (after ? pending.afterCount : pending.beforeCount) ||
      erasureNamesDigest(observed.names) !== (after ? pending.afterDigest : pending.beforeDigest)) erasureFail();
  }
  private async executeRetirement(): Promise<boolean> {
    const pending = this.record.retirement!, locator = `.memory-owners/owners/${pending.name}`;
    let present = true;
    try { await this.inspection.lstat(locator); }
    catch (cause) { if (evidenceCauseCode(cause) !== 'ENOENT') throw cause; present = false; }
    if (present) {
      await this.barrier('before-evidence-retirement', async () => {
        await this.proveRemoved(); await this.retirementParent(false);
        const artifact = await this.inspection.record(locator);
        if (!equal(artifact.identity, pending.artifact.identity) || artifact.digest !== pending.artifact.digest ||
          artifact.mode !== pending.artifact.mode || artifact.uid !== pending.artifact.uid || artifact.links !== pending.artifact.links) erasureFail();
      });
      await this.inspection.remove(locator, false);
      await this.registryTransition([locator], new Map());
    }
    const postProof = async () => { await this.proveRemoved(); await this.retirementParent(true); };
    await this.barrier('after-evidence-retirement', postProof);
    await this.inspection.syncDirectory(this.inspection.binding(this.registryDirectory), postProof);
    if (pending.kind === 'registry') return true;
    const { retirement: _retired, ...record } = this.record;
    await this.acknowledge({ ...record, state: 'EVIDENCE_RETIRING', manifest: { ...record.manifest!, anchor: pending.successor } }, 'evidence-retired-durable');
    return false;
  }
  private async finalRetirement(recovered: boolean): Promise<EraseOwnedResult> {
    const journal = this.journalLocator();
    const finalProof = async () => {
      await this.proveRemoved();
      if (this.registryDirectory.names.some(name => name !== erasureJournalName(this.binding.ownerId) &&
        (name.toLowerCase().startsWith(`${this.binding.ownerId}.erase`) || name.toLowerCase().startsWith(`${this.binding.ownerId}.json`)))) erasureFail();
      const current = await this.inspection.record(journal), expected = this.authority.get(journal)!;
      if (!equal(current.identity, expected.identity) || current.raw !== erasureSerialize(this.record)) erasureFail();
    };
    await finalProof();
    await this.inspection.remove(journal, false); await this.registryTransition([journal], new Map());
    const absenceProof = async () => {
      await this.proveRemoved();
      if (this.registryDirectory.names.some(name => name.toLowerCase().startsWith(`${this.binding.ownerId}.erase`) ||
        name.toLowerCase().startsWith(`${this.binding.ownerId}.json`))) erasureFail();
    };
    await this.inspection.syncDirectory(this.inspection.binding(this.registryDirectory), absenceProof);
    this.committed = Object.freeze({ status: recovered ? 'already-erased' : 'erased',
      evidence: Object.freeze({ ...this.binding, tenantRoot: this.inspection.root }) });
    this.capture(this.committed);
    SecurityMonitor.logSecurityEvent({ type: 'DANGER_ZONE_OPERATION', severity: 'LOW', source: 'FileMemoryOwnedErasure',
      details: 'Attributed owner archive tree and temporary erasure evidence retired' });
    await this.barrier('after-audit', absenceProof); await this.barrier('before-return', absenceProof);
    return this.committed;
  }
  async run(recovered: boolean, headQualified = false, expected?: OwnedFileMemoryToken): Promise<EraseOwnedResult> {
    try {
      this.headQualified = headQualified;
      await this.readJournal();
      if (expected && (expected.locator !== this.record.head.locator || !equal(expected.fileIdentity, this.record.head.originalHeadIdentity))) erasureFail();
      if (this.record.state === 'HEAD_PREPARED') await this.completeHeadPreparation();
      if (this.record.manifest) {
        if (this.record.state === 'EVIDENCE_RETIRING' || this.record.state === 'RETIRE_ACTION_PREPARED') await this.loadSuffix();
        else await this.loadInventory();
      }
      if (!this.headQualified) await this.qualifyReadyHead();
      if (this.record.state === 'ERASURE_READY') await this.publishInventory();
      else this.reserveSchedule(this.record.manifest!.segments);
      await this.registryProof();
      if (this.record.state === 'INVENTORY_READY' && this.record.manifest!.nodes === 0) {
        const proof = () => this.archiveProof(0);
        await proof();
        const parent = this.record.archive!.existing.at(-1)!;
        await this.inspection.syncDirectory(parent, proof);
        await this.acknowledge({ ...this.record, state: 'OWNER_ROOT_REMOVED' }, 'owner-root-removed-durable');
      }
      for (let remaining = this.nodes.length; this.record.state === 'INVENTORY_READY' || this.record.state === 'ACTION_PREPARED'; remaining--) {
        if (remaining <= 0) erasureFail();
        if (this.record.state === 'INVENTORY_READY') await this.prepareAction();
        await this.executeAction();
      }
      if (this.record.state === 'OWNER_ROOT_REMOVED') {
        await this.proveRemoved();
        await this.acknowledge({ ...this.record, state: 'EVIDENCE_RETIRING' }, 'evidence-retiring-durable');
      }
      for (let remaining = this.record.manifest!.segments + 1; remaining > 0; remaining--) {
        if (this.record.state === 'EVIDENCE_RETIRING') await this.prepareRetirement();
        if (this.record.state !== 'RETIRE_ACTION_PREPARED') erasureFail();
        if (await this.executeRetirement()) return await this.finalRetirement(recovered && !this.archiveMutation);
      }
      erasureFail();
    } catch (cause) {
      const error = Object.assign(new Error('Owner erasure stopped; preserve its bounded authority and residual evidence'), {
        code: this.committed ? 'EOWNERERASED' : this.inspection.accounting.actual.mutations ? 'EERASURECOMMITUNKNOWN' : 'EERASURERESIDUAL', cause,
        archiveMutationAttempted: this.inspection.accounting.actual.archiveMutationAttempts > 0,
        ...(this.hasQualifiedHeadDeletion ? { headDeleted: true } : {}), ...(this.committed ? { result: this.committed } : {}) });
      if (this.committed) this.capturedErrors.set(error, this.committed);
      throw error;
    }
  }
}
