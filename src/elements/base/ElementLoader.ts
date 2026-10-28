/**
 * ElementLoader - Load pipeline for element managers.
 *
 * Owns the full load() method body, the invalid-element tracking map,
 * the suppressed-path set, and the two snapshot helpers used by delete().
 * Services that need to call subclass-overridable methods (parseContent,
 * parseMetadata, createElement, afterLoad, onLoadError) receive them via
 * the ElementLoaderHost interface so late binding is preserved.
 * Extracted from BaseElementManager; no behaviour changed.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { BoundedDiagnosticMap } from './BoundedDiagnosticMap.js';
import { IElement } from '../../types/elements/IElement.js';
import { ElementType } from '../../portfolio/types.js';
import { logger } from '../../utils/logger.js';
import { SecureYamlParser } from '../../security/secureYamlParser.js';
import { FileOperationsService } from '../../services/FileOperationsService.js';
import { type IStorageLayer, type IWritableStorageLayer, isWritableStorageLayer } from '../../storage/IStorageLayer.js';
import type { InvalidElementRecord } from './BaseElementManager.js';
import type { ElementCache, CachePublicationLease } from './ElementCache.js';
import type { ElementEventCoordinator } from './ElementEventCoordinator.js';

/** Partial type alias for the static ELEMENT_TYPE_TO_CONTEXT map passed in from the base class. */
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
    private readonly fileOperations: FileOperationsService,
    private readonly storageLayer: IStorageLayer,
    private readonly elementTypeToContext: ElementTypeToContext,
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
  getInvalidElement(name: string, getFileExtension: () => string, normalizeFilename: (n: string) => string): InvalidElementRecord | undefined {
    for (const record of this.getInvalidElements()) {
      const { filePath } = record;
      if (filePath === name) return record;
      const basename = path.basename(filePath, getFileExtension());
      if (basename === name || normalizeFilename(basename) === normalizeFilename(name)) {
        return record;
      }
    }
    return undefined;
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
   * Load an element from file or database.
   * Identical to the former BaseElementManager.load() body.
   */
  async load(filePath: string): Promise<T> {
    return this.cache.withDirectoryPin(lease => this.loadAndCache(filePath, lease));
  }

  private async loadAndCache(filePath: string, lease: CachePublicationLease): Promise<T> {
    const { relativePath, absolutePath } = await this.host.normalizeAndValidatePath(filePath);
    const correlationId = randomUUID();

    this.events.eventDispatcher.emit(
      'element:load:start',
      this.events.createEventPayload({ correlationId, filePath: relativePath }),
    );

    try {
      const content = await this.readContent(relativePath, absolutePath);
      const parsed = this.host.parseContent(content);
      this.host.migrateMetadataDefaults(parsed.data, relativePath);
      const metadata = await this.host.parseMetadata(parsed.data);
      const element = this.host.createElement(metadata, parsed.content);
      this.host.captureLoadedContent?.(element, content, relativePath);

      if (this.host.afterLoad) {
        await this.host.afterLoad(element, relativePath, parsed);
      }

      this.cache.cacheElement(element, relativePath, lease);

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
    const { relativePath, absolutePath } = await this.host.normalizeAndValidatePath(filePath);
    const content = await this.readContent(relativePath, absolutePath);
    return this.loadDefinitionFromContent(content, relativePath);
  }

  /** Hydrate the exact bytes paired with a guarded update snapshot. */
  async loadDefinitionFromContent(content: string, relativePath: string): Promise<T> {
    const parsed = this.host.parseContent(content);
    this.host.migrateMetadataDefaults(parsed.data, relativePath);
    const metadata = await this.host.parseMetadata(parsed.data);
    return this.host.createElement(metadata, parsed.content);
  }

  /** Hydrate a same-read snapshot completely without reading storage or publishing cache state. */
  async hydrateDefinitionFromContent(content: string, relativePath: string, options?: { suppressLoadPolicy?: boolean; quietMemory?: boolean }): Promise<T> {
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
  }

  private async readContent(relativePath: string, absolutePath: string): Promise<string> {
    if (isWritableStorageLayer(this.storageLayer)) {
      return this.storageLayer.readContent(relativePath);
    }
    return this.fileOperations.readElementFile(absolutePath, this.host.elementType, {
      source: `${this.host.constructor?.name ?? 'ElementLoader'}.load`,
    });
  }

  /** Record a storage-reported failure without reading or caching the element. */
  recordUnreadableElement(relativePath: string, error: Error): void {
    this.handleLoadError(error, relativePath, path.join(this.host.elementDir, relativePath), randomUUID());
  }

  private handleLoadError(
    error: unknown,
    relativePath: string,
    absolutePath: string,
    correlationId: string,
  ): void {
    const namespace = this.cache.getNamespace();
    const isFileNotFound = (error as NodeJS.ErrnoException).code === 'ENOENT';
    let isRepeatError = false;

    if (isFileNotFound) {
      this.clearInvalidRecord(relativePath);
    } else {
      const reason = error instanceof Error ? error.message : String(error);
      const records = this.invalidElements.get(namespace) ?? new Map<string, InvalidElementRecord>();
      this.invalidElements.set(namespace, records);
      const existing = records.get(relativePath);
      isRepeatError = existing?.reason === reason;

      records.set(relativePath, {
        filePath: relativePath,
        reason,
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

  /**
   * Load an element snapshot from file for validation (e.g., canDelete guard).
   * Newly read validation snapshots are not published into the shared cache.
   */
  async loadElementSnapshot(absolutePath: string, relativePath: string): Promise<T> {
    const cached = this.cache.getCachedByAbsolutePath(absolutePath);
    if (cached) return cached;

    const raw = await this.fileOperations.readElementFile(absolutePath, this.host.elementType, {
      source: 'ElementLoader.loadElementSnapshot',
    });
    const contentContext = this.elementTypeToContext[this.host.elementType];
    const parsed = SecureYamlParser.safeMatter(raw, undefined, { contentContext });
    this.host.migrateMetadataDefaults(parsed.data, relativePath);
    const metadata = await this.host.parseMetadata(parsed.data);
    const element = this.host.createElement(metadata, parsed.content);
    return element;
  }

  /**
   * Load an element snapshot from the database for validation (e.g., canDelete guard).
   */
  async loadElementSnapshotFromDb(relativePath: string): Promise<T> {
    const cached = this.cache.getCachedByPath(relativePath);
    if (cached) return cached;

    const raw = await (this.storageLayer as IWritableStorageLayer).readContent(relativePath);
    const parsed = this.host.parseContent(raw);
    this.host.migrateMetadataDefaults(parsed.data, relativePath);
    const metadata = await this.host.parseMetadata(parsed.data);
    const element = this.host.createElement(metadata, parsed.content);
    return element;
  }
}
