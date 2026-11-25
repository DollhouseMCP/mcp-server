/** Shared file I/O lifecycle; FileStateTable owns every record and publication rule. */
import { sanitizeStorageError } from './StorageScanError.js';
import { acceptedExtensions, couldHoldElementName } from './ElementNameKeys.js';
import { isContentRejection } from '../security/contentRejection.js';
import { PathValidator, type PathRefusalDetail, pathRefusalDetail } from '../security/pathValidator.js';
import { ValidationError } from '../security/errors.js';
import { assertUnsanitizedReference } from '../security/InputValidator.js';
import { mapStorageItems } from './mapStorageItems.js';
import * as path from 'node:path';
import { isAbsentPathError } from '../services/FileOperationsService.js';
import { logger } from '../utils/logger.js';
import { readFileIndex } from './FileIndexReader.js';
import { DirectoryStateCache } from './DirectoryStateCache.js';
import { FileStateTable, type FailureEvidence, type ScanOutcome, type ScanPublication, type ScanToken } from './FileStateTable.js';
import type { IndexPersistence } from './MemoryIndexPersistence.js';
import type { IStorageBackend } from './IStorageBackend.js';
import type { CollectionChangeObservation, FreshCollectionSnapshot, IndexedPathResult, IStorageLayer, StorageCacheVersion, StorageReference, StorageScanOptions, UnindexedEntry } from './IStorageLayer.js';
import { mergeManifestDiffResults, type ElementIndexEntry, type ManifestDiffResult } from './types.js';
import { BoundedDiagnosticMap } from '../utils/BoundedDiagnosticMap.js';

/** Refusal diagnostics kept per layer; caller references can reach them, so the maps are bounded. */
const MAX_REFUSAL_DIAGNOSTICS = 512;
/** Distinct names one failed record's could-hold answers are kept for before the memo restarts. */
const MAX_COULD_HOLD_MEMO = 256;
export const EMPTY_DIFF = (): ManifestDiffResult => ({ added: [], modified: [], removed: [], unchanged: [] });
export interface DirScanState {
  table: FileStateTable;
  lastScanAt: number;
  scanError?: unknown;
  scanInProgress: Promise<ManifestDiffResult> | null;
  persistence?: IndexPersistence;
  hydrationStarted: boolean;
}
function failureOf(error: unknown, root: string, relativePath: string): FailureEvidence {
  const code = (error as NodeJS.ErrnoException)?.code;
  const safe = sanitizeStorageError(error, root, path.join(root, relativePath));
  return { reason: safe instanceof Error ? safe.message : String(safe),
    name: error instanceof Error ? error.name : typeof error,
    ...(isContentRejection(error) ? { contentRejected: true as const } : {}),
    ...(code === undefined ? {} : { code }) };
}
export abstract class FileStorageLayerBase<S extends DirScanState = DirScanState> implements IStorageLayer {
  private readonly failedRechecks = new WeakMap<S, Map<string, Promise<void>>>();
  private readonly couldHoldMemo = new WeakMap<UnindexedEntry, Map<string, boolean>>();
  /**
   * The validator's detail for the last reference-policy refusal of each stored path; the index logs it.
   * Caller references reach it too, so it is bounded, and an entry goes once the path passes the policy.
   */
  private readonly refusalDetails = new BoundedDiagnosticMap<PathRefusalDetail>(MAX_REFUSAL_DIAGNOSTICS);
  /** Direct reads already reported at error level, so a repeated refusal of the same reference demotes. */
  private readonly reportedReadRefusals = new BoundedDiagnosticMap<true>(MAX_REFUSAL_DIAGNOSTICS);
  protected abstract readonly fileExtension: string;

  resolveReference(reference: string): Promise<StorageReference> {
    return Promise.resolve(this.isExactStorageReference(reference, this.fileExtension)
      ? { kind: 'identity', storageIdentity: reference, requested: reference }
      : { kind: 'name', name: reference });
  }

  readonly cachedInstanceCurrency = 'currency-check' as const;

  holdsReference(reference: string): boolean | undefined {
    const table = this.getState(this.directory).table;
    if (table.get(reference) !== undefined) return true;
    return table.needsScan() ? undefined : false;
  }

  /**
   * The layer decides what a reference is. One it holds as any record is a reference
   * whatever its syntax (a stored 'save-50%25.md'). Otherwise only the form this layer builds is
   * one: a relative path with '/' separators and the type's extension, with no path syntax
   * ('x/../a.md', './a.md', 'a//a.md', 'C:/a.md', '%2e.md') and no backslash. Any other text is a
   * name, or refused as path syntax.
   */
  isExactStorageReference(reference: string, fileExtension: string): boolean {
    if (this.holdsReference(reference) === true) return true;
    if (reference.includes('\\') || PathValidator.isPathSyntax(reference, fileExtension)) return false;
    const extension = path.extname(reference).toLowerCase();
    return acceptedExtensions(fileExtension.toLowerCase()).includes(extension);
  }

  /**
   * The layer vouches for a cached instance while the record it observed is settled (never one it
   * saw fail or left unsettled) and the file still has the size and mtime observed before the
   * instance's bytes were read. A failed stat is no verdict: the loader then reads and classifies.
   */
  async isCachedReferenceCurrent(reference: string, version: StorageCacheVersion | undefined): Promise<boolean> {
    if (!version) return false;
    // A record this layer saw fail or left unsettled is never vouched for.
    if (!this.getState(this.directory).table.isSettled(reference)) return false;
    const current = await this.readCacheVersion(reference);
    return current?.mtimeMs === version.mtimeMs && current.sizeBytes === version.sizeBytes;
  }

  /** One stat of the reference: its (mtime, size), or none when it cannot be observed. */
  async readCacheVersion(reference: string): Promise<StorageCacheVersion | undefined> {
    const { stats } = await this.backend.statMany(this.directory, [reference]);
    const meta = stats.get(reference);
    return meta === undefined ? undefined : { mtimeMs: meta.mtimeMs, sizeBytes: meta.sizeBytes };
  }

  protected collectionEntries(state: S): ElementIndexEntry[] { return state.table.entries(); }

  /**
   * Whether a failed record may stand in for a listed name. Element files are distinct elements:
   * only a record whose name the layer has parsed can be another copy of a listed name; a
   * never-parsed record's filename key is a hint for absence answers, not a competing copy.
   */
  protected failureShadowsSurvivors(failure: UnindexedEntry): boolean { return !failure.unattributed; }

  /**
   * Failed records carry the layer's verdict wherever they are read (collection snapshots and name
   * lookups alike), so a listing and a lookup by name decide from the same evidence.
   */
  private withVerdicts(failures: ReadonlyMap<string, UnindexedEntry>): ReadonlyMap<string, UnindexedEntry> {
    return new Map([...failures].map(([reference, failure]) =>
      [reference, { ...failure, shadowsSurvivors: this.failureShadowsSurvivors(failure) }]));
  }

  async readCollection() {
    const dir = this.directory;
    const state = this.getState(dir);
    let diff = EMPTY_DIFF();
    const since = state.table.observationPoint();
    return this.dirStates.scanAndRead(state, async () => {
      diff = await this.freshScan(dir, state, since, {});
      return diff;
    }, () => {
      const authoritative = state.table.answersSince(since);
      return { entries: this.collectionEntries(state), unindexed: this.withVerdicts(state.table.unindexed()),
        authoritative, complete: authoritative && state.table.unindexed().size === 0, includesPublic: false, diff,
        unsettled: state.table.unsettled() };
    });
  }

  /** The fresh inventory of a file layer is its collection read; a layer with a dedicated inventory overrides it. */
  async readFreshCollection(_options?: { preserveDuplicates?: boolean }): Promise<FreshCollectionSnapshot> {
    const snapshot = await this.readCollection();
    return { entries: snapshot.entries, unindexed: snapshot.unindexed };
  }

  /** The collection-read freshness without the entries: what a refresh of cached instances needs. */
  refreshCollection(options: StorageScanOptions = {}): Promise<ManifestDiffResult> {
    const dir = this.directory;
    const state = this.getState(dir);
    const since = state.table.observationPoint();
    return this.dirStates.use(state, () => this.freshScan(dir, state, since, options));
  }

  /**
   * A scan that answers a read begun at `since`: one membership comparison inside the cooldown,
   * the scan when one is due, and one more when the only scan joined began before the read and was
   * invalidated. `freshAfterInFlight` also waits out a scan already running and scans after it.
   */
  private async freshScan(dir: string, state: S, since: number, options: StorageScanOptions): Promise<ManifestDiffResult> {
    await this.observeMembership(dir, state);
    let diff = await this.scanState(dir, state, options);
    if (!state.table.answersSince(since) && state.table.needsScan()) {
      diff = mergeManifestDiffResults(diff, await this.scanState(dir, state, {}));
    }
    return diff;
  }

  /**
   * A collection read reports the members the directory holds now, as a per-call enumeration does;
   * the scan cooldown bounds only re-reading unchanged members. Inside the cooldown one enumeration
   * is compared with the table, and any difference schedules the scan, which reports its own
   * failures, an enumeration failure included. A scan that began meanwhile enumerates after this
   * observation started, so it already answers for it and is left uninvalidated.
   */
  private async observeMembership(dir: string, state: S): Promise<void> {
    const observedScanAt = state.lastScanAt;
    // Only a published table has members to compare; a failed scan's error stands for its cooldown.
    if (state.table.lastScan !== 'succeeded' || state.scanInProgress || state.table.needsScan()
      || Date.now() - observedScanAt >= this.scanCooldownMs) return;
    const members = await this.enumerate(dir).catch(() => undefined);
    if (state.scanInProgress || state.lastScanAt !== observedScanAt || state.table.needsScan()) return;
    if (!members || !state.table.holdsExactly(members)) state.table.invalidate();
  }

  /**
   * The membership observation a listing makes, run before a warm miss is answered: inside the scan
   * cooldown one enumeration compares the directory with the table; past it the table is due a
   * scan. A changed or due table is invalidated (changed), so the lookup certifies once more from a
   * fresh collection read, which evicts what it finds changed. It applies no rows itself.
   */
  observeCollectionChange(): Promise<CollectionChangeObservation> {
    const dir = this.directory;
    const state = this.getState(dir);
    return this.dirStates.use(state, async () => {
      if (state.table.lastScan !== 'succeeded' || state.scanInProgress || state.table.needsScan()) return { changed: false };
      if (Date.now() - state.lastScanAt >= this.scanCooldownMs) {
        state.table.invalidate();
        return { changed: true };
      }
      await this.observeMembership(dir, state);
      return { changed: state.table.needsScan() };
    });
  }

  protected disposed = false;
  dispose(): Promise<void> { this.disposed = true; return Promise.resolve(); }
  protected assertActive(): void {
    if (this.disposed) throw new Error('Storage layer disposed');
  }
  protected constructor(protected readonly backend: IStorageBackend, protected readonly dirStates: DirectoryStateCache<S>,
    private readonly scanCooldownMs = 1000,
    private readonly onFailedRecordRecovered?: (reference: string) => void) {}
  protected abstract get directory(): string;
  protected abstract extendState(dir: string, base: DirScanState): S;
  protected abstract readonly scanLabel: string;
  protected abstract enumerate(dir: string): Promise<string[]>;
  /** Extract metadata from content using the already observed file stat. */
  protected abstract readIndexEntry(content: string, relPath: string, stats: Map<string, { mtimeMs: number; sizeBytes: number }>): ElementIndexEntry;
  protected abstract logCooldown(dir: string, remainingMs: number): void;
  protected abstract logDiskScan(dir: string, fileCount: number, diff: ManifestDiffResult): void;
  protected getState(dir = this.directory): S {
    this.assertActive();
    let state = this.dirStates.get(dir);
    if (!state) {
      state = this.extendState(dir, { table: new FileStateTable(), lastScanAt: 0, scanInProgress: null, hydrationStarted: false });
      this.dirStates.set(dir, state);
    }
    return state;
  }
  abstract listSummaries(options?: { includePublic?: boolean; preserveDuplicates?: boolean; freshMetadata?: boolean }): Promise<ElementIndexEntry[]>;
  abstract getIndexedPaths(): Promise<string[]>;
  async notifySaved(relativePath: string, absolutePath: string): Promise<void> {
    if (this.disposed) return;
    const state = this.getState();
    return this.dirStates.use(state, async () => {
      let observedMtime: number | undefined;
      try {
        const meta = await this.backend.stat(absolutePath);
        observedMtime = meta.mtimeMs;
        const content = await this.readEntryContent(this.directory, relativePath);
        if (this.disposed) return;
        state.table.applySaved(relativePath, meta.mtimeMs, this.readIndexEntry(content, relativePath, new Map([[relativePath, meta]])));
      } catch (error) {
        if (this.disposed) return;
        if (isAbsentPathError(error)) state.table.applyAbsent(relativePath);
        else {
          const failure = failureOf(error, this.directory, relativePath);
          this.logFailure(this.directory, relativePath, failure, state.table.applyFailure(relativePath, failure, observedMtime));
        }
      }
      this.requestPersistence(state);
    });
  }
  notifyDeleted(relativePath: string): void {
    if (this.disposed) return;
    this.forgetRefusal(this.directory, relativePath);
    const state = this.getState();
    state.table.applyDeleted(relativePath);
    this.requestPersistence(state);
  }
  protected requestPersistence(state: S): void {
    if (this.disposed) return;
    if ((state.table.hasUnsavedChanges() || state.table.needsInitialWrite()) && state.table.everSucceeded) {
      state.persistence?.request(() => state.table.persistableSnapshot(), generation => state.table.markPersisted(generation));
    }
  }
  async scan(options: StorageScanOptions = {}): Promise<ManifestDiffResult> {
    const dir = this.directory;
    const state = this.getState(dir);
    return this.dirStates.use(state, () => this.scanState(dir, state, options));
  }
  protected async scanState(currentDir: string, state: S, options: StorageScanOptions): Promise<ManifestDiffResult> {
    this.assertActive();
    const existingScan = state.scanInProgress;
    if (existingScan) {
      if (!options.freshAfterInFlight) return existingScan;

      let initialDiff: ManifestDiffResult | undefined;
      try {
        initialDiff = await existingScan;
      } catch {
        // Give the trailing scan an independent chance to recover.
      }

      const successor = state.scanInProgress;
      const trailingDiff = successor && successor !== existingScan
        ? await successor
        : await this.startScan(currentDir, state);
      return initialDiff ? mergeManifestDiffResults(initialDiff, trailingDiff) : trailingDiff;
    }

    const elapsed = Date.now() - state.lastScanAt;
    if (elapsed < this.scanCooldownMs && !state.table.needsScan()) {
      if (state.table.lastScan === 'failed') throw state.scanError;
      this.logCooldown(currentDir, this.scanCooldownMs - elapsed);
      return EMPTY_DIFF();
    }
    return this.startScan(currentDir, state);
  }
  protected startScan(dir: string, state: S): Promise<ManifestDiffResult> {
    return this.dirStates.runScan(state, () => this.performScanForDir(dir, state));
  }
  readIndexedPath(names: readonly string[], options: { candidates?: boolean } = {}): Promise<IndexedPathResult> {
    const dir = this.directory;
    const state = this.getState(dir);
    return this.dirStates.use(state, async () => {
      // A table that is authoritative now answers without waiting on a routine scan; one that is
      // invalidated (an enforcement scan, an observed change) waits for the scan to answer.
      if (state.scanInProgress && !state.table.isAuthoritative()) await state.scanInProgress;
      const known = names.some(name => state.table.get(name)?.status === 'indexed' || state.table.getPathByName(name));
      // A record that could hold a requested name is rechecked on every lookup, so a repair is seen
      // at once; the unattributed net cast for an unknown name is bounded by the scan cooldown.
      const rechecks = [...state.table.unindexed()].flatMap(([reference, failure]) => {
        const targeted = names.some(name => this.failureCouldHold(reference, failure, name));
        return targeted || !known && failure.unattributed ? [{ reference, targeted }] : [];
      });
      await mapStorageItems(rechecks, ({ reference, targeted }) => this.recheckFailedPath(dir, state, reference, targeted));
      const result = await readFileIndex(this.dirStates, state, names,
        () => options.candidates === false ? [] : this.preferredCandidates(state, names));
      return { ...result, failures: this.withVerdicts(result.failures) };
    });
  }
  /**
   * Whether a failed record could hold a name, memoised on the failure record itself: a scan or a
   * recheck replaces the record, so its answers are recomputed exactly when its evidence changes.
   */
  private failureCouldHold(reference: string, failure: UnindexedEntry, name: string): boolean {
    let memo = this.couldHoldMemo.get(failure);
    if (!memo || memo.size >= MAX_COULD_HOLD_MEMO) {
      memo = new Map();
      this.couldHoldMemo.set(failure, memo);
    }
    let holds = memo.get(name);
    if (holds === undefined) {
      holds = couldHoldElementName(reference, failure.candidateNames, name);
      memo.set(name, holds);
    }
    return holds;
  }
  /** Preferred names are alternatives: the first name with any candidate answers, like the path hint. */
  private preferredCandidates(state: S, names: readonly string[]): ElementIndexEntry[] {
    for (const name of names) {
      const entries = this.candidateEntries(state, name);
      if (entries.length) return entries;
    }
    return [];
  }
  /** Healthy entries one name could select; subclasses apply their ownership rule here. */
  protected candidateEntries(state: S, name: string): ElementIndexEntry[] {
    return state.table.candidates(name);
  }
  /**
   * Every storage read honours the loader's reference policy byte for byte, so the index never
   * holds an entry the loader refuses: the reference is never rewritten (a character the input
   * sanitiser would strip refuses it), and the path must stay inside the directory.
   */
  protected async readEntryContent(dir: string, relativePath: string): Promise<string> {
    return this.backend.readFile(await this.assertEntryReference(dir, relativePath));
  }
  /** The reference policy itself, before any storage access; the refusal's detail is kept for the index log. */
  private async assertEntryReference(dir: string, relativePath: string): Promise<string> {
    const absolutePath = path.join(dir, relativePath);
    try {
      assertUnsanitizedReference(relativePath);
      await PathValidator.validateElementPathOnly(absolutePath, dir, { quiet: true });
    } catch (error) {
      if (typeof (error as NodeJS.ErrnoException).code === 'string') throw error;
      this.refusalDetails.set(refusalKey(dir, relativePath), pathRefusalDetail(error) ?? { path: absolutePath, allowedDir: dir });
      throw new ValidationError(error instanceof Error ? error.message : 'Invalid path');
    }
    // The path passes the policy now (it is indexed, absent or about to be read): its old refusal is gone.
    this.forgetRefusal(dir, relativePath);
    return absolutePath;
  }
  private recheckFailedPath(dir: string, state: S, reference: string, targeted: boolean): Promise<void> {
    let pending = this.failedRechecks.get(state);
    if (!pending) { pending = new Map(); this.failedRechecks.set(state, pending); }
    const active = pending.get(reference);
    if (active) return active;
    const operation = this.performFailedRecheck(dir, state, reference, targeted).finally(() => pending.delete(reference));
    pending.set(reference, operation);
    return operation;
  }
  private async performFailedRecheck(dir: string, state: S, reference: string, targeted: boolean): Promise<void> {
    const expected = state.table.get(reference);
    if (expected?.status !== 'failed' || !targeted && !state.table.recheckDue(reference, Date.now(), this.scanCooldownMs)) return;
    let outcome: ScanOutcome;
    let mtimeMs: number | undefined;
    let sizeBytes: number | undefined;
    try {
      const meta = await this.backend.stat(path.join(dir, reference));
      mtimeMs = meta.mtimeMs; sizeBytes = meta.sizeBytes;
      if (state.table.canReuseUnchanged(reference, mtimeMs, sizeBytes)) { state.table.markRechecked(reference, Date.now()); return; }
      const content = await this.readEntryContent(dir, reference);
      outcome = { status: 'indexed', mtimeMs, entry: this.readIndexEntry(content, reference, new Map([[reference, meta]])) };
    } catch (error) {
      outcome = isAbsentPathError(error) ? { status: 'absent' }
        : { status: 'failed', mtimeMs, sizeBytes, failure: failureOf(error, dir, reference) };
    }
    this.assertActive();
    state.table.markRechecked(reference, Date.now());
    if (!state.table.publishRecheck(reference, expected, outcome)) return;
    if (outcome.status === 'failed') {
      const previous = expected.status === 'failed' ? expected.failure : undefined;
      this.logFailure(dir, reference, outcome.failure, previous?.name === outcome.failure.name && previous.reason === outcome.failure.reason);
    }
    if (outcome.status === 'indexed' || outcome.status === 'absent') this.onFailedRecordRecovered?.(reference);
    this.requestPersistence(state);
  }
  /** One reference's bytes under the scan's reference policy; ENOENT is the backend's own absence. */
  async readContent(reference: string): Promise<string> {
    this.assertActive();
    const dir = this.directory;
    try {
      return await this.readEntryContent(dir, reference);
    } catch (error) {
      if (error instanceof ValidationError) {
        const key = refusalKey(dir, reference);
        this.logRefusal(reference, error.message, this.refusalDetails.get(key), this.reportedReadRefusals.has(key));
        this.reportedReadRefusals.set(key, true);
      }
      throw error;
    }
  }
  getPathByName(name: string): string | undefined { return this.getState().table.getPathByName(name); }
  hasCompletedScan(): boolean {
    const table = this.getState().table;
    return table.everSucceeded && !table.pendingInvalidation;
  }
  invalidate(): void { this.getState().table.invalidate(); }
  clear(): void {
    if (this.disposed) return;
    for (const state of this.dirStates.values()) {
      const snapshot = state.table.hasUnsavedChanges() ? state.table.persistableSnapshot() : null;
      if (snapshot) state.persistence?.request(() => snapshot, () => {});
      state.table.clear(); state.lastScanAt = 0; state.scanError = undefined;
    }
    this.refusalDetails.clear();
    this.reportedReadRefusals.clear();
  }
  private hydrate(state: S, token: ScanToken): Promise<void> | undefined {
    if (!state.persistence || state.hydrationStarted) return undefined;
    state.hydrationStarted = true;
    return state.persistence.read().then(entries => {
      if (!this.disposed && entries && state.table.isCurrent(token)) state.table.hydrate(entries.entries, entries.blocked);
    }).catch((error: unknown) => {
      logger.debug(`${this.scanLabel}: cannot read persisted index; rebuilding from disk`, {
        error: error instanceof Error ? error.name : typeof error,
      });
    });
  }
  protected async performScanForDir(dir: string, state: S): Promise<ManifestDiffResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      this.assertActive();
      const result = await this.scanCurrentEpoch(dir, state);
      this.assertActive();
      if (result) return result;
    }
    throw new Error('Storage scan repeatedly invalidated by cache clearing');
  }
  private async scanCurrentEpoch(dir: string, state: S): Promise<ManifestDiffResult | undefined> {
    const token = state.table.beginScan();
    try {
      const hydration = this.hydrate(state, token);
      if (hydration) await hydration;
      if (!await this.backend.directoryExists(dir)) {
        this.assertActive();
        if (!state.table.isCurrent(token)) return undefined;
        const result = state.table.publishMissingDirectory(token);
        state.persistence?.cancelPending();
        return this.finishScan(dir, state, result, 0);
      }
      const paths = await this.enumerate(dir);
      const { stats, failures } = await this.backend.statMany(dir, paths);
      const outcomes = new Map<string, ScanOutcome>(paths.map(relativePath => [relativePath, { status: 'absent' }]));
      for (const [relativePath, error] of failures) outcomes.set(relativePath, { status: 'statFailed', failure: failureOf(error, dir, relativePath) });
      await mapStorageItems([...stats], async ([relativePath, meta]) => {
        if (state.table.canReuseUnchanged(relativePath, meta.mtimeMs, meta.sizeBytes)) {
          const previous = state.table.get(relativePath);
          outcomes.set(relativePath, previous?.status === 'failed'
            ? { status: 'failed', failure: previous.failure, mtimeMs: meta.mtimeMs, sizeBytes: meta.sizeBytes }
            : { status: 'unchanged', mtimeMs: meta.mtimeMs, sizeBytes: meta.sizeBytes });
          return;
        }
        try {
          const content = await this.readEntryContent(dir, relativePath);
          outcomes.set(relativePath, { status: 'indexed', mtimeMs: meta.mtimeMs, entry: this.readIndexEntry(content, relativePath, stats) });
        } catch (error) {
          const outcome: ScanOutcome = isAbsentPathError(error) ? { status: 'absent' }
            : { status: 'failed', mtimeMs: meta.mtimeMs, sizeBytes: meta.sizeBytes, failure: failureOf(error, dir, relativePath) };
          outcomes.set(relativePath, outcome);
        }
      });
      this.assertActive();
      if (!state.table.isCurrent(token)) return undefined;
      const result = state.table.publishScan(token, outcomes);
      return this.finishScan(dir, state, result, paths.length);
    } catch (error) {
      this.assertActive();
      if (!state.table.isCurrent(token)) return undefined;
      state.table.failScan(token);
      const failure = sanitizeStorageError(error, dir);
      state.lastScanAt = Date.now(); state.scanError = failure;
      throw failure;
    }
  }
  private finishScan(dir: string, state: S, result: ScanPublication, count: number): ManifestDiffResult {
    this.assertActive();
    for (const change of result.ownershipChanges) {
      logger.warn(`${this.scanLabel}: duplicate name ${JSON.stringify(change.name)}; using ${JSON.stringify(change.winner)} over ${change.losers.map(loser => JSON.stringify(loser)).join(', ')}`);
    }
    const unindexed = state.table.unindexed();
    const changedFailures = new Set(result.changedFailures);
    for (const [relativePath, failure] of unindexed) {
      this.logFailure(dir, relativePath, failure, !changedFailures.has(relativePath));
    }
    const changes = [...result.diff.added, ...result.diff.modified];
    if (result.diff.removed.length || changes.some(relativePath => !unindexed.has(relativePath) || changedFailures.has(relativePath))) {
      this.logDiskScan(dir, count, result.diff);
    }
    state.lastScanAt = Date.now(); state.scanError = undefined;
    this.requestPersistence(state);
    return result.diff;
  }
  /**
   * A reference-policy refusal is a security signal: the index reports it at error level with the
   * validator's own detail once per distinct failure; a parse or storage failure stays at warn.
   * Repeats of an unchanged failure demote to debug either way.
   */
  private logFailure(dir: string, relativePath: string, failure: FailureEvidence, repeated: boolean): void {
    const detail = failure.name === 'ValidationError' ? this.refusalDetails.get(refusalKey(dir, relativePath)) : undefined;
    if (detail) {
      this.logRefusal(relativePath, failure.reason, detail, repeated);
      return;
    }
    logger[repeated ? 'debug' : 'warn'](`${this.scanLabel}: failed to index ${relativePath}`, {
      error: failure.name, ...(failure.code === undefined ? {} : { code: failure.code }),
    });
  }
  private forgetRefusal(dir: string, relativePath: string): void {
    const key = refusalKey(dir, relativePath);
    this.refusalDetails.delete(key);
    this.reportedReadRefusals.delete(key);
  }
  private logRefusal(relativePath: string, reason: string, detail: PathRefusalDetail | undefined, repeated: boolean): void {
    logger[repeated ? 'debug' : 'error'](`${this.scanLabel}: refused ${relativePath}: ${reason}`, detail ?? {});
  }
}
function refusalKey(dir: string, relativePath: string): string {
  return path.join(dir, relativePath);
}
