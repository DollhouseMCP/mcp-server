import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { flattenIndexEntry } from './flattenIndexEntry.js';
import type { UnindexedEntry } from './IStorageLayer.js';
import type { ElementIndexEntry, ManifestDiffResult } from './types.js';

export type FileRecord =
  | { status: 'indexed'; nameKey: string; mtimeMs: number; sizeBytes?: number; entry: ElementIndexEntry; recheckPending?: true }
  | { status: 'recheck'; nameKey?: string; mtimeMs?: number }
  | { status: 'failed'; failure: UnindexedEntry; nameKey?: string; mtimeMs?: number };
export type ScanOutcome =
  | { status: 'indexed'; entry: ElementIndexEntry; mtimeMs: number }
  | { status: 'unchanged'; mtimeMs: number; sizeBytes?: number }
  | { status: 'failed' | 'statFailed'; failure: UnindexedEntry; mtimeMs?: number; sizeBytes?: number }
  | { status: 'absent' };
export interface ScanToken { readonly epoch: number }
export interface BlockedFile { nameKey: string; mtimeMs: number }
export interface HydratedIndex { entries: ElementIndexEntry[]; blocked: Record<string, BlockedFile> }
export interface PersistableIndex extends HydratedIndex { generation: number }
export interface OwnershipChange { name: string; winner: string; losers: string[] }
export interface ScanPublication { diff: ManifestDiffResult; changedFailures: string[]; ownershipChanges: OwnershipChange[] }
interface ActiveScan extends ScanToken {
  touched: Map<string, boolean>;
  invalidatedDuringScan: boolean;
}
const emptyPublication = (): ScanPublication => ({ diff: { added: [], modified: [], removed: [], unchanged: [] }, changedFailures: [], ownershipChanges: [] });
export const nameKey = (name: string): string => UnicodeValidator.normalize(name).normalizedContent.toLowerCase().trim();
export function sameFailure(previous: UnindexedEntry | undefined, current: UnindexedEntry): boolean {
  return previous?.name === current.name && previous.code === current.code && previous.reason === current.reason;
}

/** Owns file state and its publication rules; never performs I/O or logging. */
export class FileStateTable {
  private readonly records = new Map<string, FileRecord>();
  private readonly failedPaths = new Map<string, UnindexedEntry>();
  private nonServingCount = 0;
  private recheckCount = 0;
  private readonly byName = new Map<string, Set<string>>();
  private readonly reportedOwners = new Map<string, string>();
  private scan: ActiveScan | null = null;
  private epoch = 0;
  private directoryExists = false;
  private generation = 0;
  private confirmedEpoch = -1;
  private persistedGeneration = 0;
  private invalidationPending = false;
  get pendingInvalidation(): boolean { return this.invalidationPending; }
  private succeeded = false;
  get everSucceeded(): boolean { return this.succeeded; }
  private scanStatus: 'none' | 'succeeded' | 'failed' = 'none';
  get lastScan(): 'none' | 'succeeded' | 'failed' { return this.scanStatus; }

  get(path: string): Readonly<FileRecord> | undefined { return this.records.get(path); }
  canReuseUnchanged(path: string, mtimeMs: number, sizeBytes: number): boolean {
    const record = this.records.get(path);
    if (record?.status !== 'indexed' || record.recheckPending) return false;
    return record.mtimeMs === mtimeMs && record.sizeBytes !== undefined && record.sizeBytes === sizeBytes;
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
    return this.scanStatus === 'succeeded' && !this.pendingInvalidation && this.nonServingCount === 0;
  }
  getPathByName(name: string): string | undefined {
    const owner = this.ownerOf(nameKey(name));
    return owner !== undefined && this.records.get(owner)?.status === 'indexed' ? owner : undefined;
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
  private identity(record: FileRecord | undefined): { nameKey?: string; mtimeMs?: number } {
    return record ? { nameKey: record.nameKey, mtimeMs: record.mtimeMs } : {};
  }
  private replace(path: string, record: FileRecord | undefined, dirty = true): void {
    const previous = this.records.get(path);
    this.updateDerivedState(path, previous, record);
    const oldKey = this.identity(previous).nameKey;
    if (oldKey !== undefined) {
      const paths = this.byName.get(oldKey)!;
      paths.delete(path);
      if (!paths.size) this.byName.delete(oldKey);
    }
    if (record) this.records.set(path, record);
    else this.records.delete(path);
    const key = this.identity(record).nameKey;
    if (key !== undefined) {
      const paths = this.byName.get(key) ?? new Set<string>();
      paths.add(path);
      this.byName.set(key, paths);
    }
    const oldIdentity = this.identity(previous);
    const newIdentity = this.identity(record);
    if (dirty && (previous?.status === 'indexed' || record?.status === 'indexed' ||
      oldIdentity.nameKey !== newIdentity.nameKey || oldIdentity.mtimeMs !== newIdentity.mtimeMs)) this.generation++;
  }
  private updateDerivedState(path: string, previous: FileRecord | undefined, record: FileRecord | undefined): void {
    const nonServing = (value: FileRecord | undefined): number => Number(value !== undefined &&
      (value.status !== 'indexed' || value.recheckPending === true));
    const recheck = (value: FileRecord | undefined): number => Number(value?.status === 'recheck' ||
      (value?.status === 'indexed' && value.recheckPending === true));
    this.nonServingCount += nonServing(record) - nonServing(previous);
    this.recheckCount += recheck(record) - recheck(previous);
    if (record?.status === 'failed') this.failedPaths.set(path, record.failure);
    else this.failedPaths.delete(path);
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
  applyFailure(path: string, failure: UnindexedEntry, mtimeMs?: number): boolean {
    this.touch(path);
    const wasKnown = this.records.has(path);
    const generation = this.generation;
    const repeated = this.setFailure(path, failure, mtimeMs);
    if (!wasKnown && this.generation === generation) this.generation++;
    this.invalidate();
    return repeated;
  }
  private setFailure(path: string, failure: UnindexedEntry, mtimeMs?: number): boolean {
    const previous = this.records.get(path);
    const repeated = sameFailure(previous?.status === 'failed' ? previous.failure : undefined, failure);
    this.replace(path, { status: 'failed', failure, ...this.identity(previous), mtimeMs: mtimeMs ?? previous?.mtimeMs });
    return repeated;
  }
  applyDeleted(path: string): void { this.touch(path); this.replace(path, undefined); }
  invalidate(): void {
    this.invalidationPending = true;
    if (this.scan) this.scan.invalidatedDuringScan = true;
  }
  beginScan(): ScanToken {
    if (this.scan) throw new Error('A file scan is already active');
    this.scan = { epoch: this.epoch, touched: new Map(), invalidatedDuringScan: false };
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
    } else if (!this.setFailure(path, outcome.failure, outcome.mtimeMs)) result.changedFailures.push(path);
  }
  failScan(token: ScanToken): void {
    if (!this.isCurrent(token)) return;
    this.scanStatus = 'failed';
    this.invalidationPending = this.scan?.invalidatedDuringScan === true;
    this.scan = null;
  }
  clear(): void {
    this.records.clear(); this.byName.clear(); this.failedPaths.clear(); this.reportedOwners.clear();
    this.nonServingCount = 0; this.recheckCount = 0; this.epoch++;
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
        blocked[path] = { nameKey: identity.nameKey, mtimeMs: identity.mtimeMs };
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
