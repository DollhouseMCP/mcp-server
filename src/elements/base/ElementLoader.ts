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
import * as path from 'path';
import { IElement } from '../../types/elements/IElement.js';
import { ElementType } from '../../portfolio/types.js';
import { logger } from '../../utils/logger.js';
import { SecureYamlParser } from '../../security/secureYamlParser.js';
import { FileOperationsService } from '../../services/FileOperationsService.js';
import { type IStorageLayer, type IWritableStorageLayer, isWritableStorageLayer } from '../../storage/IStorageLayer.js';
import type { InvalidElementRecord } from './BaseElementManager.js';
import type { ElementCache } from './ElementCache.js';
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
  createElement(metadata: T['metadata'], content: string): T;
  afterLoad?(element: T, filePath: string, parsedData?: { data: Record<string, unknown>; content: string }): Promise<void>;
  onLoadError?(filePath: string, error: unknown): void;
  getElementLabel(): string;
  getElementLabelCapitalized(): string;
  normalizeAndValidatePath(filePath: string): Promise<{ relativePath: string; absolutePath: string }>;
}

export class ElementLoader<T extends IElement> {
  /** Elements that exist on disk but failed validation during load. */
  private readonly invalidElements = new Map<string, InvalidElementRecord>();
  /**
   * Tracks file paths whose load failure has already been logged at error level.
   * Repeated failures with the same reason are demoted to debug.
   */
  private readonly suppressedLoadPaths = new Set<string>();

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
    return this.suppressedLoadPaths.has(filePath);
  }

  /**
   * Returns elements that exist on disk but failed validation during load.
   */
  getInvalidElements(): InvalidElementRecord[] {
    return [...this.invalidElements.values()];
  }

  /**
   * Check if a specific file failed validation during load.
   * Used by get_element to distinguish "not found" from "invalid".
   */
  getInvalidElement(name: string, getFileExtension: () => string, normalizeFilename: (n: string) => string): InvalidElementRecord | undefined {
    for (const [filePath, record] of this.invalidElements) {
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
    this.invalidElements.delete(relativePath);
    this.suppressedLoadPaths.delete(relativePath);
  }

  /**
   * Load an element from file or database.
   * Identical to the former BaseElementManager.load() body.
   */
  async load(filePath: string): Promise<T> {
    const { relativePath, absolutePath } = await this.host.normalizeAndValidatePath(filePath);
    const correlationId = randomUUID();

    this.events.eventDispatcher.emit(
      'element:load:start',
      this.events.createEventPayload({ correlationId, filePath: relativePath }),
    );

    try {
      const content = isWritableStorageLayer(this.storageLayer)
        ? await (this.storageLayer as IWritableStorageLayer).readContent(relativePath)
        : await this.fileOperations.readElementFile(absolutePath, this.host.elementType, {
            source: `${this.host.constructor?.name ?? 'ElementLoader'}.load`,
          });

      const parsed = this.host.parseContent(content);
      this.host.migrateMetadataDefaults(parsed.data, relativePath);
      const metadata = await this.host.parseMetadata(parsed.data);
      const element = this.host.createElement(metadata, parsed.content);

      if (this.host.afterLoad) {
        await this.host.afterLoad(element, relativePath, parsed);
      }

      this.cache.cacheElement(element, relativePath);

      this.invalidElements.delete(relativePath);
      this.suppressedLoadPaths.delete(relativePath);

      logger.info(`${this.host.getElementLabelCapitalized()} loaded: ${element.metadata.name}`);

      this.events.eventDispatcher.emitAsync(
        'element:load:success',
        this.events.createEventPayload({ correlationId, filePath: relativePath, element }),
      );

      return element;
    } catch (error) {
      const isFileNotFound = (error as NodeJS.ErrnoException).code === 'ENOENT';
      let isRepeatError = false;

      if (!isFileNotFound) {
        const reason = error instanceof Error ? error.message : String(error);
        const existing = this.invalidElements.get(relativePath);
        isRepeatError = existing?.reason === reason;

        this.invalidElements.set(relativePath, {
          filePath: relativePath,
          reason,
          failedAt: isRepeatError ? existing!.failedAt : new Date().toISOString(),
        });
      }

      if (isRepeatError) {
        this.suppressedLoadPaths.add(relativePath);
        logger.debug(`Suppressed repeated load error for ${this.host.getElementLabel()} ${relativePath}`);
      } else {
        this.suppressedLoadPaths.delete(relativePath);
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
      throw error;
    }
  }

  /**
   * Load an element snapshot from file for validation (e.g., canDelete guard).
   * Uses a direct file read rather than going through the full load() pipeline.
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
    this.cache.cacheElement(element, relativePath);
    return element;
  }

  /**
   * Load an element snapshot from the database for validation (e.g., canDelete guard).
   */
  async loadElementSnapshotFromDb(relativePath: string): Promise<T> {
    const cached = this.cache.elements.get(relativePath);
    if (cached) return cached;

    const raw = await (this.storageLayer as IWritableStorageLayer).readContent(relativePath);
    const parsed = this.host.parseContent(raw);
    this.host.migrateMetadataDefaults(parsed.data, relativePath);
    const metadata = await this.host.parseMetadata(parsed.data);
    const element = this.host.createElement(metadata, parsed.content);
    this.cache.cacheElement(element, relativePath);
    return element;
  }
}
