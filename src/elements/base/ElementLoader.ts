/**
 * ElementLoader - Load pipeline for element managers.
 *
 * Owns the full load() method body, the invalid-element tracking map,
 * the suppressed-path set, and the two snapshot helpers used by delete().
 * Services that need to call subclass-overridable methods (parseContent,
 * parseMetadata, createElement, afterLoad, onLoadError) receive them via
 * the ElementLoaderHost interface so late binding is preserved.
 * Every stored-reference failure it meets is classified into the read contract (ElementReadError).
 */

import { randomUUID } from 'node:crypto';
import { ElementMissingError, ElementReadError, clientReadFailureReason, elementReadFailure, isRejectedDefinition } from './ElementReadError.js';
import { assertExactReferenceEvidence, couldHoldElementName } from './ElementNameEvidence.js';
import { BoundedDiagnosticMap } from '../../utils/BoundedDiagnosticMap.js';
import { IElement } from '../../types/elements/IElement.js';
import { ElementType } from '../../portfolio/types.js';
import { logger } from '../../utils/logger.js';
import type { IStorageLayer } from '../../storage/IStorageLayer.js';
import type { InvalidElementRecord } from './BaseElementManager.js';
import { type ElementCache, type CachePublicationLease, evictChangedReferences } from './ElementCache.js';
import type { ElementEventCoordinator } from './ElementEventCoordinator.js';

/** Content context per element type, consumed by the persister's guarded parse. */
export type ElementTypeToContext = Partial<Record<ElementType, 'persona' | 'skill' | 'template' | 'agent' | 'memory'>>;


/**
 * Host interface: the loader calls back into BaseElementManager for
 * methods that subclasses may override (template-method pattern).
 */
export interface ElementLoaderHost<T extends IElement> {
  readonly elementType: ElementType;
  readonly elementDir: string;
  parseContent(content: string): { data: Record<string, unknown>; content: string };
  migrateMetadataDefaults(data: Record<string, unknown>, filePath: string): void;
  parseMetadata(data: any): Promise<T['metadata']>;
  createElement(metadata: T['metadata'], content: string, options?: { quietMemory?: boolean }): T;
  captureLoadedContent?(element: T, content: string, filePath: string): void;
  afterLoad?(element: T, filePath: string, parsedData?: { data: Record<string, unknown>; content: string }, options?: { suppressLoadPolicy?: boolean }): Promise<void>;
  onLoadError?(filePath: string, error: unknown): void;
  getElementLabel(): string;
  getElementLabelCapitalized(): string;
  normalizeAndValidatePath(filePath: string): Promise<{ relativePath: string; absolutePath: string }>;
}

// Diagnostic buckets are reconstructible: an evicted caller's next failed load
// records the failure again. Bound namespace churn without retaining every user.
export const MAX_LOAD_FAILURE_NAMESPACES = 128;

export class ElementLoader<T extends IElement> {
  /** Elements that exist on disk but failed validation during load. */
  private readonly invalidElements = new BoundedDiagnosticMap<Map<string, InvalidElementRecord>>(MAX_LOAD_FAILURE_NAMESPACES);
  /**
   * Tracks file paths whose load failure has already been logged at error level.
   * Repeated failures with the same reason are demoted to debug.
   */
  private readonly suppressedLoadPaths = new BoundedDiagnosticMap<Set<string>>(MAX_LOAD_FAILURE_NAMESPACES);

  constructor(
    private readonly host: ElementLoaderHost<T>,
    private readonly cache: ElementCache<T>,
    private readonly events: ElementEventCoordinator<T>,
    private readonly storageLayer: IStorageLayer,
  ) {}

  /**
   * Returns true if the most recent load() failure for this path was suppressed
   * because it was a repeat of an already-logged error.
   */
  isLoadErrorSuppressed(filePath: string): boolean {
    return this.suppressedLoadPaths.get(this.cache.getNamespace())?.has(filePath) ?? false;
  }

  /**
   * Returns elements that exist on disk but failed validation during load.
   */
  getInvalidElements(): InvalidElementRecord[] {
    return [...(this.invalidElements.get(this.cache.getNamespace())?.values() ?? [])];
  }

  /**
   * Check if a specific file failed validation during load.
   * Used by get_element to distinguish "not found" from "invalid".
   */
  getInvalidElement(name: string): InvalidElementRecord | undefined {
    // Failed loads carry no metadata name, so attribution uses the shared filename rule.
    return this.getInvalidElements().find(record => couldHoldElementName(record.filePath, [], name));
  }

  /**
   * Clear the invalid-element and suppressed-path tracking for a given path.
   * Called on successful load or when an external change is detected.
   */
  clearInvalidRecord(relativePath: string): void {
    const namespace = this.cache.getNamespace();
    this.deleteScopedPath(this.invalidElements, namespace, relativePath);
    this.deleteScopedPath(this.suppressedLoadPaths, namespace, relativePath);
  }

  clear(): void {
    this.invalidElements.clear();
    this.suppressedLoadPaths.clear();
  }

  private deleteScopedPath<S extends { delete(key: string): boolean; readonly size: number }>(
    scopes: Map<string, S>, namespace: string, relativePath: string,
  ): void {
    const paths = scopes.get(namespace);
    paths?.delete(relativePath);
    if (paths?.size === 0) scopes.delete(namespace);
  }

  /**
   * The read contract: every failure of this stored reference, path policy included, is classified.
   * A cached instance is served only while the storage layer vouches it is current; otherwise the
   * stored bytes are read and published (the database never vouches, so every read reads the row).
   */
  async load(filePath: string): Promise<T> {
    return this.cache.withDirectoryPin(async lease => {
      try { return await this.loadAndCache(await this.host.normalizeAndValidatePath(filePath), lease); }
      catch (cause) { throw elementReadFailure(cause, filePath); }
    });
  }

  private async loadAndCache(paths: { relativePath: string; absolutePath: string }, lease: CachePublicationLease): Promise<T> {
    const { relativePath, absolutePath } = paths;
    const correlationId = randomUUID();
    try {
      await this.prepareCachedRead(relativePath);
      const cached = await this.currentCached(relativePath);
      if (cached) return cached;
      this.events.eventDispatcher.emit(
        'element:load:start',
        this.events.createEventPayload({ correlationId, filePath: relativePath }),
      );
      // Observed before the bytes are read: a later change makes the check fail, never pass stale.
      const version = await this.storageLayer.readCacheVersion(relativePath);
      const content = await this.readContent(relativePath);
      const parsed = this.host.parseContent(content);
      this.host.migrateMetadataDefaults(parsed.data, relativePath);
      const metadata = await this.host.parseMetadata(parsed.data);
      const element = this.host.createElement(metadata, parsed.content);
      this.host.captureLoadedContent?.(element, content, relativePath);

      if (this.host.afterLoad) {
        await this.host.afterLoad(element, relativePath, parsed);
      }

      this.cache.cacheElement(element, relativePath, lease, version);

      this.clearInvalidRecord(relativePath);

      logger.info(`${this.host.getElementLabelCapitalized()} loaded: ${element.metadata.name}`);

      this.events.eventDispatcher.emitAsync(
        'element:load:success',
        this.events.createEventPayload({ correlationId, filePath: relativePath, element }),
      );

      return element;
    } catch (error) {
      this.handleLoadError(error, relativePath, absolutePath, correlationId);
      throw error;
    }
  }

  /**
   * Load and parse an element definition without running post-load hooks or
   * mutating the shared element cache. Callers use this for discovery and
   * security-sensitive reads that must hydrate their own state snapshot.
   */
  async loadDefinition(filePath: string): Promise<T> {
    try {
      const { relativePath } = await this.host.normalizeAndValidatePath(filePath);
      const content = await this.readContent(relativePath);
      return await this.loadDefinitionFromContent(content, relativePath);
    } catch (cause) {
      throw elementReadFailure(cause, filePath);
    }
  }

  private async prepareCachedRead(reference: string): Promise<void> {
    const index = await this.storageLayer.readIndexedPath([reference], { candidates: false });
    if (index.authoritative) {
      assertExactReferenceEvidence(reference, true, index.failures);
      return;
    }
    const snapshot = await this.storageLayer.readCollection();
    evictChangedReferences(this.cache, snapshot.diff);
    if (snapshot.unindexed.has(reference)) this.cache.uncacheByPath(reference);
    assertExactReferenceEvidence(reference, snapshot.authoritative, snapshot.unindexed, snapshot.unsettled);
  }

  /** Hydrate the exact bytes paired with a guarded update snapshot. */
  async loadDefinitionFromContent(content: string, relativePath: string): Promise<T> {
    try {
      const parsed = this.host.parseContent(content);
      this.host.migrateMetadataDefaults(parsed.data, relativePath);
      const metadata = await this.host.parseMetadata(parsed.data);
      return this.host.createElement(metadata, parsed.content);
    } catch (cause) {
      throw elementReadFailure(cause, relativePath);
    }
  }

  /** Hydrate a same-read snapshot completely without reading storage or publishing cache state. */
  async hydrateDefinitionFromContent(content: string, relativePath: string, options?: { suppressLoadPolicy?: boolean; quietMemory?: boolean }): Promise<T> {
    try {
      const parsed = this.host.parseContent(content);
      this.host.migrateMetadataDefaults(parsed.data, relativePath);
      const metadata = await this.host.parseMetadata(parsed.data);
      const element = this.host.createElement(metadata, parsed.content, options);
      this.host.captureLoadedContent?.(element, content, relativePath);
      if (parsed.data.extensions && typeof parsed.data.extensions === 'object' && !Array.isArray(parsed.data.extensions)) {
        element.extensions = structuredClone(parsed.data.extensions as Record<string, unknown>);
      }
      if (this.host.afterLoad) await this.host.afterLoad(element, relativePath, parsed, options);
      return element;
    } catch (cause) {
      throw elementReadFailure(cause, relativePath);
    }
  }

  /** Every layer reads a reference under the storage reference policy; the file layer audits the read. */
  private async readContent(relativePath: string): Promise<string> {
    try {
      return await this.storageLayer.readContent(relativePath);
    } catch (cause) {
      // Only the storage definition-read contract establishes absence of this reference.
      if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') throw new ElementMissingError(relativePath, cause);
      throw elementReadFailure(cause, relativePath);
    }
  }

  private handleLoadError(
    error: unknown,
    relativePath: string,
    absolutePath: string,
    correlationId: string,
  ): void {
    const namespace = this.cache.getNamespace();
    const isFileNotFound = error instanceof ElementMissingError;
    let isRepeatError = false;

    if (isFileNotFound) {
      this.clearInvalidRecord(relativePath);
    } else {
      const reason = error instanceof Error ? error.message : String(error);
      const records = this.invalidElements.get(namespace) ?? new Map<string, InvalidElementRecord>();
      this.invalidElements.set(namespace, records);
      const existing = records.get(relativePath);
      isRepeatError = existing?.reason === reason;

      const readError = elementReadFailure(error, relativePath);
      const clientSafeReason = readError instanceof ElementReadError
        ? readError.failures.find(failure => failure.reference === relativePath)?.reason : undefined;
      records.set(relativePath, {
        filePath: relativePath,
        reason,
        clientSafeReason: clientSafeReason ?? clientReadFailureReason(readError),
        contentRejected: isRejectedDefinition(readError),
        failedAt: isRepeatError ? existing!.failedAt : new Date().toISOString(),
      });
    }

    if (isRepeatError) {
      const suppressed = this.suppressedLoadPaths.get(namespace) ?? new Set<string>();
      suppressed.add(relativePath);
      this.suppressedLoadPaths.set(namespace, suppressed);
      logger.debug(`Suppressed repeated load error for ${this.host.getElementLabel()} ${relativePath}`);
    } else {
      this.deleteScopedPath(this.suppressedLoadPaths, namespace, relativePath);
      this.events.eventDispatcher.emitAsync(
        'element:load:error',
        this.events.createEventPayload({ correlationId, filePath: relativePath, error }),
      );
      logger.error(`Failed to load ${this.host.getElementLabel()} from ${absolutePath}:`, error);
      if (this.host.onLoadError) {
        try {
          this.host.onLoadError(relativePath, error);
        } catch (hookErr) {
          logger.warn(`onLoadError hook threw (swallowed): ${String(hookErr)}`);
        }
      }
    }
  }

  /** The cached instance for a reference, when the storage layer vouches it is still current. */
  private async currentCached(reference: string): Promise<T | undefined> {
    if (this.storageLayer.cachedInstanceCurrency === 'unverifiable') return undefined;
    const cached = this.cache.getCachedByPath(reference);
    return cached && await this.storageLayer.isCachedReferenceCurrent(reference, this.cache.versionOf(cached)) ? cached : undefined;
  }

  /**
   * A lookup by exact storage reference, by the storage layer's cachedInstanceCurrency: on an
   * unverifiable layer the instance already resolved for the reference is kept; otherwise the load,
   * which serves a cached instance only while it is vouched current and replaces it only after a
   * successful read.
   */
  async loadByReference(reference: string, load: (reference: string) => Promise<T>): Promise<T> {
    const resolved = this.storageLayer.cachedInstanceCurrency === 'unverifiable' ? this.cache.getCachedByPath(reference) : undefined;
    return resolved ?? load(reference);
  }

  /**
   * Load an element snapshot from file for validation (e.g., canDelete guard).
   * Newly read validation snapshots are not published into the shared cache.
   */
  async loadElementSnapshot(reference: string): Promise<T> {
    try {
      const cached = await this.currentCached(reference);
      if (cached) return cached;

      const raw = await this.readContent(reference);
      const parsed = this.host.parseContent(raw);
      this.host.migrateMetadataDefaults(parsed.data, reference);
      const metadata = await this.host.parseMetadata(parsed.data);
      return this.host.createElement(metadata, parsed.content);
    } catch (cause) {
      throw elementReadFailure(cause, reference);
    }
  }
}
