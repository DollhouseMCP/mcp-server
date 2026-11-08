import { filenameKey, foldedNameKey, slugNameKey } from './ElementNameKeys.js';
import { flattenIndexEntry } from './flattenIndexEntry.js';
import type { UnindexedEntry } from './IStorageLayer.js';
import type { ElementIndexEntry, ManifestDiffResult } from './types.js';

/** What I/O observed about a failed record; the table attributes it to the names it could hold. */
export type FailureEvidence = Pick<UnindexedEntry, 'reason' | 'name' | 'code' | 'contentRejected'>;
export type FileRecord =
  | { status: 'indexed'; nameKey: string; mtimeMs: number; sizeBytes?: number; entry: ElementIndexEntry; recheckPending?: true }
  | { status: 'recheck'; nameKey?: string; elementName?: string; mtimeMs?: number }
  | { status: 'failed'; failure: UnindexedEntry; nameKey?: string; mtimeMs?: number; sizeBytes?: number };
export type ScanOutcome =
  | { status: 'indexed'; entry: ElementIndexEntry; mtimeMs: number }
  | { status: 'unchanged'; mtimeMs: number; sizeBytes?: number }
  | { status: 'failed' | 'statFailed'; failure: FailureEvidence; mtimeMs?: number; sizeBytes?: number }
  | { status: 'absent' };
export interface ScanToken { readonly epoch: number }
export interface BlockedFile { nameKey: string; elementName?: string; mtimeMs: number }
export interface HydratedIndex { entries: ElementIndexEntry[]; blocked: Record<string, BlockedFile> }
export interface PersistableIndex extends HydratedIndex { generation: number }
export interface OwnershipChange { name: string; winner: string; losers: string[] }
export interface ScanPublication { diff: ManifestDiffResult; changedFailures: string[]; ownershipChanges: OwnershipChange[] }
interface ActiveScan extends ScanToken {
  sequence: number;
  touched: Map<string, boolean>;
  invalidatedDuringScan: boolean;
}
const emptyPublication = (): ScanPublication => ({ diff: { added: [], modified: [], removed: [], unchanged: [] }, changedFailures: [], ownershipChanges: [] });
export const nameKey = foldedNameKey;
export function sameFailure(previous: UnindexedEntry | undefined, current: UnindexedEntry): boolean {
  return previous?.name === current.name && previous.code === current.code && previous.reason === current.reason;
}

/** Owns file state and its publication rules; never performs I/O or logging. */
export class FileStateTable {
  private readonly records = new Map<string, FileRecord>();
  private readonly recordOrder = new Map<string, number>();
  private nextRecordOrder = 0;
  private readonly failedPaths = new Map<string, UnindexedEntry>();
  /** References whose state awaits a recheck: 'lost' (its file could not be observed), or 'concurrent' (saved by this process during a scan). */
  private readonly unsettledPaths = new Map<string, 'lost' | 'concurrent'>();
  private lostCount = 0;
  private get recheckCount(): number { return this.unsettledPaths.size; }
  private readonly byName = new Map<string, Set<string>>();
  private readonly bySlug = new Map<string, Set<string>>();
  private readonly recheckedAt = new Map<string, number>();
  private readonly reportedOwners = new Map<string, string>();
  private scan: ActiveScan | null = null;
  private epoch = 0;
  private directoryExists = false;
  private generation = 0;
  private confirmedEpoch = -1;
  private persistedGeneration = 0;
  private invalidationPending = false;
  private scanSequence = 0;
  private publishedSequence = 0;
  get pendingInvalidation(): boolean { return this.invalidationPending; }
  private succeeded = false;
  get everSucceeded(): boolean { return this.succeeded; }
  private scanStatus: 'none' | 'succeeded' | 'failed' = 'none';
  get lastScan(): 'none' | 'succeeded' | 'failed' { return this.scanStatus; }

  get(path: string): Readonly<FileRecord> | undefined { return this.records.get(path); }
  canReuseUnchanged(path: string, mtimeMs: number, sizeBytes: number): boolean {
    const record = this.records.get(path);
    if (!record || record.status === 'recheck') return false;
    if (record.status === 'indexed' ? record.recheckPending : !record.failure.contentRejected) return false;
    return record.mtimeMs === mtimeMs && record.sizeBytes !== undefined && record.sizeBytes === sizeBytes;
  }
  /** No record, or an indexed one with no recheck pending: nothing observed against the reference. */
  isSettled(path: string): boolean {
    const record = this.records.get(path);
    if (!record) return true;
    return record.status === 'indexed' && record.recheckPending !== true;
  }
  needsScan(): boolean { return this.scanStatus === 'none' || this.pendingInvalidation; }
  hasUnsavedChanges(): boolean { return this.generation !== this.persistedGeneration; }
  needsInitialWrite(): boolean {
    return this.everSucceeded && this.directoryExists && this.confirmedEpoch !== this.epoch;
  }
  entries(): ElementIndexEntry[] {
    return [...this.records.values()].flatMap(record => record.status === 'indexed' ? [record.entry] : []);
  }
  unindexed(): ReadonlyMap<string, UnindexedEntry> {
    return new Map(this.failedPaths);
  }
  isAuthoritative(): boolean {
    return this.scanStatus === 'succeeded' && !this.pendingInvalidation && this.recheckCount === 0;
  }
  /** The point a read observes from; only a scan begun after it can answer that read. */
  observationPoint(): number { return this.scanSequence; }
  /**
   * Whether the table answers a read begun at `point`. A scan begun after that point enumerated
   * after every change signalled before the read, so its publication answers the read even when a
   * change is signalled while it runs: that change is concurrent with the read and stays pending
   * for the next one. The layer's own save of a record during that scan is the same kind of
   * concurrent change. Only a record whose file could not be observed still refuses.
   */
  answersSince(point: number): boolean {
    return this.isAuthoritative()
      || this.scanStatus === 'succeeded' && this.lostCount === 0 && this.publishedSequence > point;
  }
  /** References whose own state is pending: a read of one of them cannot be answered from this table yet. */
  unsettled(): ReadonlySet<string> {
    return new Set(this.unsettledPaths.keys());
  }
  /** Cheap owner hint by folded name; it never certifies presence, absence or uniqueness. */
  getPathByName(name: string): string | undefined {
    const owner = this.ownerOf(nameKey(name));
    return owner !== undefined && this.records.get(owner)?.status === 'indexed' ? owner : undefined;
  }
  /** Every healthy entry the shared selector could accept for this identifier, in index order. */
  candidates(identifier: string): ElementIndexEntry[] {
    const paths = new Set<string>([identifier, ...this.byName.get(nameKey(identifier)) ?? [], ...this.bySlug.get(slugNameKey(identifier)) ?? []]);
    // Only the matched paths are visited, in index (insertion) order; never the whole table.
    return [...paths]
      .filter(path => this.records.has(path))
      .sort((left, right) => (this.recordOrder.get(left) ?? 0) - (this.recordOrder.get(right) ?? 0))
      .flatMap(path => {
        const record = this.records.get(path);
        return record?.status === 'indexed' ? [record.entry] : [];
      });
  }
  /** Whether this indexed record is the newest owner of its folded name. */
  isOwner(path: string): boolean {
    const record = this.records.get(path);
    return record?.status === 'indexed' && this.ownerOf(record.nameKey) === path;
  }
  /** A targeted recheck of a failed record is due once per cooldown, like a scan. */
  recheckDue(path: string, now: number, cooldownMs: number): boolean {
    const last = this.recheckedAt.get(path);
    return last === undefined || now - last >= cooldownMs;
  }
  markRechecked(path: string, now: number): void {
    if (this.records.get(path)?.status === 'failed') this.recheckedAt.set(path, now);
  }
  private ownerOf(key: string): string | undefined {
    const paths = this.byName.get(key);
    if (!paths) return undefined;
    let owner: string | undefined;
    for (const path of paths) {
      if (owner === undefined || this.outranks(path, owner)) owner = path;
    }
    return owner;
  }
  ownerEntries(): ElementIndexEntry[] {
    return [...this.byName.keys()].flatMap(key => {
      const path = this.ownerOf(key);
      const record = path === undefined ? undefined : this.records.get(path);
      return record?.status === 'indexed' ? [record.entry] : [];
    });
  }
  private collectOwnershipChanges(): OwnershipChange[] {
    const changes: OwnershipChange[] = [];
    const current = new Map<string, string>();
    for (const [key, paths] of this.byName) {
      const indexed = [...paths].filter(path => this.records.get(path)?.status === 'indexed');
      const winner = this.ownerOf(key);
      const record = winner === undefined ? undefined : this.records.get(winner);
      if (indexed.length < 2 || winner === undefined || record?.status !== 'indexed') continue;
      current.set(key, winner);
      if (this.reportedOwners.get(key) !== winner) {
        changes.push({ name: record.entry.name, winner, losers: indexed.filter(path => path !== winner).sort((a, b) => a.localeCompare(b)) });
      }
    }
    this.reportedOwners.clear();
    for (const [key, winner] of current) this.reportedOwners.set(key, winner);
    return changes;
  }
  private outranks(path: string, other: string): boolean {
    const rank = this.rankOf(path);
    const previous = this.rankOf(other);
    return rank > previous || (rank === previous && path > other);
  }
  private rankOf(path: string): number {
    const rank = this.records.get(path)?.mtimeMs;
    if (rank === undefined) throw new Error('File name ownership requires an observed modification time');
    return rank;
  }
  private identity(record: FileRecord | undefined): { nameKey?: string; elementName?: string; mtimeMs?: number } {
    if (!record) return {};
    let elementName: string | undefined;
    if (record.status === 'indexed') elementName = record.entry.name;
    else if (record.status === 'failed') elementName = record.failure.elementName;
    else elementName = record.elementName;
    return { nameKey: record.nameKey, elementName, mtimeMs: record.mtimeMs };
  }
  private replace(path: string, record: FileRecord | undefined, dirty = true): void {
    const previous = this.records.get(path);
    this.updateDerivedState(path, previous, record);
    const oldKey = this.identity(previous).nameKey;
    if (oldKey !== undefined) this.unlink(this.byName, oldKey, path);
    if (previous?.status === 'indexed') this.unlink(this.bySlug, slugNameKey(previous.entry.name), path);
    if (record) {
      // The records map keeps insertion order; candidates are returned in that order.
      if (!previous) this.recordOrder.set(path, this.nextRecordOrder++);
      this.records.set(path, record);
    } else {
      this.records.delete(path);
      this.recordOrder.delete(path);
    }
    const key = this.identity(record).nameKey;
    if (key !== undefined) {
      const paths = this.byName.get(key) ?? new Set<string>();
      paths.add(path);
      this.byName.set(key, paths);
    }
    if (record?.status === 'indexed') {
      const slug = slugNameKey(record.entry.name);
      const paths = this.bySlug.get(slug) ?? new Set<string>();
      paths.add(path);
      this.bySlug.set(slug, paths);
    }
    const oldIdentity = this.identity(previous);
    const newIdentity = this.identity(record);
    if (dirty && (previous?.status === 'indexed' || record?.status === 'indexed' ||
      oldIdentity.nameKey !== newIdentity.nameKey || oldIdentity.mtimeMs !== newIdentity.mtimeMs)) this.generation++;
  }
  private unlink(index: Map<string, Set<string>>, key: string, path: string): void {
    const paths = index.get(key);
    if (!paths) return;
    paths.delete(path);
    if (!paths.size) index.delete(key);
  }
  private updateDerivedState(path: string, previous: FileRecord | undefined, record: FileRecord | undefined): void {
    const unsettled = (value: FileRecord | undefined): 'lost' | 'concurrent' | undefined => {
      if (value?.status === 'recheck') return 'lost';
      return value?.status === 'indexed' && value.recheckPending === true ? 'concurrent' : undefined;
    };
    const before = unsettled(previous);
    const after = unsettled(record);
    this.lostCount += Number(after === 'lost') - Number(before === 'lost');
    if (after) this.unsettledPaths.set(path, after);
    else this.unsettledPaths.delete(path);
    if (record?.status === 'failed') this.failedPaths.set(path, record.failure);
    else { this.failedPaths.delete(path); this.recheckedAt.delete(path); }
  }
  private touch(path: string): void {
    if (this.scan && !this.scan.touched.has(path)) this.scan.touched.set(path, this.records.has(path));
  }
  applySaved(path: string, mtimeMs: number, entry: ElementIndexEntry): void {
    this.touch(path);
    this.replace(path, { status: 'indexed', nameKey: nameKey(entry.name), mtimeMs, sizeBytes: entry.sizeBytes, entry: flattenIndexEntry(entry) });
  }
  applyAbsent(path: string): void {
    this.touch(path);
    const previous = this.records.get(path);
    if (!previous) return;
    this.replace(path, { status: 'recheck', ...this.identity(previous) });
    this.invalidate();
  }
  applyFailure(path: string, evidence: FailureEvidence, mtimeMs?: number): boolean {
    this.touch(path);
    const wasKnown = this.records.has(path);
    const generation = this.generation;
    const repeated = this.setFailure(path, evidence, mtimeMs);
    if (!wasKnown && this.generation === generation) this.generation++;
    this.invalidate();
    return repeated;
  }
  /** The single attribution site: a failed record blocks its last indexed name and its filename key. */
  private setFailure(path: string, evidence: FailureEvidence, mtimeMs?: number, sizeBytes?: number): boolean {
    const previous = this.records.get(path);
    const elementName = this.identity(previous).elementName ?? previous?.nameKey;
    const key = filenameKey(path);
    const failure: UnindexedEntry = { ...evidence, elementName,
      candidateNames: elementName === undefined ? [key] : [elementName, key],
      unattributed: elementName === undefined || mtimeMs === undefined };
    const repeated = sameFailure(previous?.status === 'failed' ? previous.failure : undefined, failure);
    this.replace(path, { status: 'failed', failure, ...this.identity(previous), mtimeMs: mtimeMs ?? previous?.mtimeMs, sizeBytes });
    return repeated;
  }
  applyDeleted(path: string): void { this.touch(path); this.replace(path, undefined); }
  /** Whether the directory's current members are exactly the references this table holds. */
  holdsExactly(references: readonly string[]): boolean {
    return references.length === this.records.size && references.every(reference => this.records.has(reference));
  }
  invalidate(): void {
    this.invalidationPending = true;
    if (this.scan) this.scan.invalidatedDuringScan = true;
  }
  beginScan(): ScanToken {
    if (this.scan) throw new Error('A file scan is already active');
    this.scan = { epoch: this.epoch, sequence: ++this.scanSequence, touched: new Map(), invalidatedDuringScan: false };
    return { epoch: this.epoch };
  }
  isCurrent(token: ScanToken): boolean { return token.epoch === this.epoch && this.scan !== null; }
  hydrate(entries: ElementIndexEntry[], blocked: Record<string, BlockedFile> = {}): void {
    this.confirmedEpoch = this.epoch;
    for (const entry of entries) {
      if (this.records.has(entry.filePath) || this.scan?.touched.has(entry.filePath)) {
        this.generation++;
      } else {
        this.replace(entry.filePath, { status: 'indexed', nameKey: nameKey(entry.name), mtimeMs: entry.mtimeMs, sizeBytes: entry.sizeBytes, entry: flattenIndexEntry(entry) }, false);
      }
    }
    for (const [path, identity] of Object.entries(blocked)) {
      if (this.records.has(path) || this.scan?.touched.has(path)) this.generation++;
      else this.replace(path, { status: 'recheck', ...identity }, false);
    }
  }
  publishScan(token: ScanToken, outcomes: ReadonlyMap<string, ScanOutcome>): ScanPublication {
    return this.publish(token, outcomes, true);
  }
  publishRecheck(path: string, expected: Readonly<FileRecord>, outcome: ScanOutcome): boolean {
    if (this.records.get(path) !== expected) return false;
    this.touch(path);
    this.publishOutcome(path, outcome, emptyPublication());
    return true;
  }
  publishMissingDirectory(token: ScanToken): ScanPublication { return this.publish(token, new Map(), false); }
  private publish(token: ScanToken, outcomes: ReadonlyMap<string, ScanOutcome>, exists: boolean): ScanPublication {
    const result = emptyPublication();
    if (!this.isCurrent(token)) return result;
    const scan = this.scan!;
    const paths = new Set([...outcomes.keys(), ...this.records.keys(), ...scan.touched.keys()]);
    for (const path of paths) {
      const outcome = outcomes.get(path) ?? { status: 'absent' };
      if (scan.touched.has(path)) this.publishTouched(path, outcome, scan.touched.get(path)!, result.diff);
      else this.publishOutcome(path, outcome, result);
    }
    result.ownershipChanges = this.collectOwnershipChanges();
    this.scanStatus = 'succeeded';
    this.succeeded = true;
    this.directoryExists = exists;
    if (!exists) { this.persistedGeneration = this.generation; this.confirmedEpoch = -1; }
    this.invalidationPending = scan.invalidatedDuringScan || this.recheckCount > 0;
    this.publishedSequence = scan.sequence;
    this.scan = null;
    return result;
  }
  private publishTouched(path: string, outcome: ScanOutcome, known: boolean, diff: ManifestDiffResult): void {
    const record = this.records.get(path);
    if (!record) return;
    diff[known ? 'modified' : 'added'].push(path);
    const observedMtime = 'mtimeMs' in outcome ? outcome.mtimeMs : undefined;
    let observedSize: number | undefined;
    if (outcome.status === 'indexed') observedSize = outcome.entry.sizeBytes;
    else if ('sizeBytes' in outcome) observedSize = outcome.sizeBytes;
    if (record.status === 'indexed' && (record.mtimeMs !== observedMtime || record.sizeBytes !== observedSize)) {
      this.replace(path, { ...record, recheckPending: true });
    }
  }
  private publishOutcome(path: string, outcome: ScanOutcome, result: ScanPublication): void {
    const previous = this.records.get(path);
    if (outcome.status === 'absent') {
      if (previous && previous.status !== 'failed') result.diff.removed.push(path);
      this.replace(path, undefined);
      return;
    }
    if (outcome.status === 'unchanged') {
      result.diff.unchanged.push(path);
      return;
    }
    result.diff[previous ? 'modified' : 'added'].push(path);
    if (outcome.status === 'indexed') {
      this.replace(path, { status: 'indexed', nameKey: nameKey(outcome.entry.name), mtimeMs: outcome.mtimeMs, sizeBytes: outcome.entry.sizeBytes, entry: flattenIndexEntry(outcome.entry) });
    } else if (!this.setFailure(path, outcome.failure, outcome.mtimeMs, outcome.sizeBytes)) result.changedFailures.push(path);
  }
  failScan(token: ScanToken): void {
    if (!this.isCurrent(token)) return;
    this.scanStatus = 'failed';
    this.invalidationPending = this.scan?.invalidatedDuringScan === true;
    this.scan = null;
  }
  clear(): void {
    this.records.clear(); this.recordOrder.clear(); this.byName.clear(); this.bySlug.clear(); this.failedPaths.clear(); this.recheckedAt.clear(); this.reportedOwners.clear();
    this.unsettledPaths.clear(); this.lostCount = 0; this.epoch++;
    this.scan = null; this.invalidationPending = false;
    this.succeeded = false; this.scanStatus = 'none'; this.directoryExists = false;
    this.generation++;
    this.persistedGeneration = this.generation;
    this.confirmedEpoch = -1;
  }
  persistableSnapshot(): PersistableIndex | null {
    if (!this.everSucceeded || !this.directoryExists) return null;
    const entries = [...this.records.values()].flatMap(record =>
      record.status === 'indexed' && !record.recheckPending ? [record.entry] : []);
    const blocked: Record<string, BlockedFile> = {};
    for (const [path, record] of this.records) {
      if (record.status === 'indexed' && !record.recheckPending) continue;
      const identity = this.identity(record);
      if (identity.nameKey !== undefined && identity.mtimeMs !== undefined) {
        blocked[path] = { nameKey: identity.nameKey, elementName: identity.elementName, mtimeMs: identity.mtimeMs };
      }
    }
    return { entries, blocked, generation: this.generation };
  }
  markPersisted(generation: number): void {
    if (generation < this.persistedGeneration) return;
    this.persistedGeneration = generation;
    this.confirmedEpoch = this.epoch;
  }
}
