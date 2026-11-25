/**
 * Shared complete listings, partial collection reports, and cache eviction.
 *
 * Combines storage completeness with individual load failures for each operation.
 * Services that need to call subclass-overridable methods (parseContent,
 * parseMetadata, createElement) receive them via the ElementListHost interface
 * so late binding is preserved.
 */

import { evictingNameEvidence, type NameEvidenceSource } from './ElementNameEvidence.js';
import * as path from 'node:path';
import { IElement } from '../../types/elements/IElement.js';
import { ElementType } from '../../portfolio/types.js';
import { ElementIndeterminateError, type ElementReadError, elementReadFailure, GuardedReadConflict, indexedReadFailure } from './ElementReadError.js';
import { collectionSurvivors, requireCompleteCollection, type CollectionReport, type CollectionFailure } from './CollectionReport.js';
import {
  type IStorageLayer,
  type StorageScanOptions,
  type StorageCollectionSnapshot,
} from '../../storage/IStorageLayer.js';
import type { ElementIndexEntry } from '../../storage/types.js';
import { type ElementCache, evictChangedReferences } from './ElementCache.js';
import type { PublicElementDiscovery } from '../../collection/shared-pool/PublicElementDiscovery.js';
import type { UserIdResolver } from '../../database/UserContext.js';

/**
 * Host interface: the list operations call back into BaseElementManager for
 * methods that subclasses may override (template-method pattern), plus stable
 * utility methods.
 */
export interface ElementListHost<T extends IElement> {
  readonly elementType: ElementType;
  readonly elementDir: string;
  parseContent(content: string): { data: Record<string, unknown>; content: string };
  migrateMetadataDefaults(data: Record<string, unknown>, filePath: string): void;
  parseMetadata(data: any): Promise<T['metadata']>;
  createElement(metadata: T['metadata'], content: string): T;
  /** Read an indexed storage reference through the loader (never classified as caller text). */
  load(reference: string): Promise<T>;
  resolveAbsolutePath(filePath: string): string;
  getElementLabelCapitalized(): string;
  readonly constructor: { name: string };
}

export class ElementListOperations<T extends IElement> {
  constructor(
    private readonly host: ElementListHost<T>,
    private readonly cache: ElementCache<T>,
    private readonly storageLayer: IStorageLayer,
    private readonly publicElementDiscovery: PublicElementDiscovery | undefined,
    private readonly getCurrentUserId: UserIdResolver | undefined,
  ) {
    this.evictingSource = evictingNameEvidence(storageLayer, cache);
  }

  /** The storage layer's reads with the one evicting rule applied to every collection snapshot. */
  private readonly evictingSource: NameEvidenceSource;

  async list(options?: { includePublic?: boolean }): Promise<T[]> {
    return requireCompleteCollection(await this.listReport(options));
  }

  listReport(options?: { includePublic?: boolean }, select?: (entry: ElementIndexEntry) => boolean): Promise<CollectionReport<T>> {
    return this.collectReport(() => this.readCollectionEvicting(options),
      async reference => this.cache.getCachedByPath(reference) ?? this.host.load(reference), options, select);
  }

  /**
   * The one collection read for a manager: the snapshot's changed and removed references are
   * evicted before anyone uses it, so a later cache-first read cannot serve what it saw change.
   */
  async readCollectionEvicting(options?: { includePublic?: boolean }): Promise<StorageCollectionSnapshot> {
    return this.evictingSource.readCollection(options);
  }


  /** The index scan, with what it saw change evicted. */
  async scanEvicting(options?: StorageScanOptions): Promise<void> {
    try {
      this.evictChanged(await this.storageLayer.scan(options));
    } catch (cause) {
      throw this.readFailure(cause);
    }
  }

  /** Fresh definition discovery never publishes hydrated instances; what its snapshot saw change is evicted. */
  discoverReport(loadDefinition: (reference: string) => Promise<T>): Promise<CollectionReport<T>> {
    return this.collectReport(() => this.readCollectionEvicting(), loadDefinition);
  }

  private async collectReport(snapshotForRead: () => Promise<StorageCollectionSnapshot>,
    load: (reference: string) => Promise<T>, options?: { includePublic?: boolean },
    select?: (entry: ElementIndexEntry) => boolean): Promise<CollectionReport<T>> {
    const items: T[] = [];
    const failures: CollectionFailure[] = [];
    try {
      const snapshot = await snapshotForRead();
      failures.push(...this.snapshotFailures(snapshot));
      const entries = select ? snapshot.entries.filter(select) : snapshot.entries;
      const loaded = await Promise.all(entries.map(async entry => {
        try {
          return await load(entry.filePath);
        } catch (cause) {
          failures.push({ reference: entry.filePath, elementName: entry.name, error: this.readFailure(cause, entry.filePath) });
          return undefined;
        }
      }));
      for (const element of loaded) if (element) items.push(element);
      if (options?.includePublic && !snapshot.includesPublic) {
        await this.addPublicElements(snapshot.entries.map(entry => entry.filePath), items, failures);
      }
      const currentUserId = options?.includePublic && snapshot.includesPublic ? this.getCurrentUserId?.() : undefined;
      if (currentUserId) this.evictForeignRowsFromCache(snapshot.entries, currentUserId);
    } catch (cause) {
      failures.push({ error: this.readFailure(cause) });
    }
    const report = { items, failures, complete: failures.length === 0 };
    return { ...report, items: collectionSurvivors(report, item => item.metadata.name) };
  }

  private readFailure(cause: unknown, reference?: string): ElementReadError {
    const error = elementReadFailure(cause, reference);
    if (error instanceof GuardedReadConflict) throw error;
    return error;
  }

  private snapshotFailures(snapshot: StorageCollectionSnapshot): CollectionFailure[] {
    const failures: CollectionFailure[] = [];
    for (const [reference, failure] of snapshot.unindexed) {
      failures.push({ reference, elementName: failure.elementName, candidateNames: failure.candidateNames,
        shadowsSurvivors: failure.shadowsSurvivors, error: this.readFailure(indexedReadFailure(reference, failure)) });
    }
    if (!snapshot.complete && failures.length === 0) {
      failures.push({ error: new ElementIndeterminateError('Element index is not authoritative') });
    }
    return failures;
  }

  private async addPublicElements(files: string[], items: T[], failures: CollectionFailure[]): Promise<void> {
    const discovery = this.publicElementDiscovery;
    if (!discovery) return;
    const userFileNames = new Set(files.map(file => path.basename(file)));
    const sharedFiles = await discovery.discoverPublicElements(this.host.elementType, userFileNames);
    await Promise.all(sharedFiles.map(async reference => {
      try {
        const content = await discovery.readPublicElement(this.host.elementType, reference);
        const parsed = this.host.parseContent(content);
        this.host.migrateMetadataDefaults(parsed.data, reference);
        const metadata = await this.host.parseMetadata(parsed.data);
        items.push(this.host.createElement(metadata, parsed.content));
      } catch (cause) {
        const publicReference = discovery.publicReference(this.host.elementType, reference);
        failures.push({ reference: publicReference, error: this.readFailure(cause, publicReference) });
      }
    }));
  }

  private evictForeignRowsFromCache(summaries: ElementIndexEntry[], currentUserId: string): void {
    for (const summary of summaries) {
      if (summary.userId && summary.userId !== currentUserId) this.cache.uncacheByPath(summary.filePath);
    }
  }

  async listSummaries(options?: { includePublic?: boolean }): Promise<ElementIndexEntry[]> {
    return requireCompleteCollection(await this.summaryReport(options));
  }

  /** Index entries and failed records without hydrating a definition: the count and status surface. */
  async summaryReport(options?: { includePublic?: boolean }): Promise<CollectionReport<ElementIndexEntry>> {
    try {
      const snapshot = await this.storageLayer.readCollection(options);
      this.evictChanged(snapshot.diff);
      const failures = this.snapshotFailures(snapshot);
      const report = { items: snapshot.entries, failures, complete: failures.length === 0 };
      return { ...report, items: collectionSurvivors(report, entry => entry.name) };
    } catch (cause) {
      return { items: [], failures: [{ error: this.readFailure(cause) }], complete: false };
    }
  }

  private evictChanged(diff: { modified: string[]; removed: string[] }): void {
    evictChangedReferences(this.cache, diff);
  }

  /**
   * The layer's collection-read freshness without loading definitions: a scan begun after this call
   * (or, inside the cooldown, one membership enumeration), and every reference it reports changed
   * evicted. Used where invalidate-then-scan would re-read every unchanged member. Enforcement passes
   * `freshAfterInFlight`, so a scan already running when it began is followed by one of its own.
   */
  async refreshCollection(options?: StorageScanOptions): Promise<void> {
    try {
      this.evictChanged(await this.storageLayer.refreshCollection(options));
    } catch (cause) {
      throw this.readFailure(cause);
    }
  }

  async scanAndEvict(options?: StorageScanOptions): Promise<void> {
    this.storageLayer.invalidate();
    try {
      this.evictChanged(await this.storageLayer.scan(options));
    } catch (cause) {
      throw this.readFailure(cause);
    }
  }
}
