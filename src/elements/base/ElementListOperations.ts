/**
 * ElementListOperations - list(), listFromDatabase(), listSummaries(), scanAndEvict().
 *
 * Owns the full list() and listFromDatabase() method bodies plus the
 * listSummaries() pass-through and the scanAndEvict() cache-maintenance helper.
 * Services that need to call subclass-overridable methods (parseContent,
 * parseMetadata, createElement) receive them via the ElementListHost interface
 * so late binding is preserved.
 * Extracted from BaseElementManager; no behaviour changed.
 */

import * as path from 'node:path';
import { IElement } from '../../types/elements/IElement.js';
import { ElementType } from '../../portfolio/types.js';
import { logger } from '../../utils/logger.js';
import { PortfolioManager } from '../../portfolio/PortfolioManager.js';
import { FileOperationsService } from '../../services/FileOperationsService.js';
import { type IStorageLayer, isWritableStorageLayer } from '../../storage/IStorageLayer.js';
import type { ElementIndexEntry } from '../../storage/types.js';
import type { ElementCache } from './ElementCache.js';
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
  load(filePath: string): Promise<T>;
  resolveAbsolutePath(filePath: string): string;
  getElementLabelCapitalized(): string;
  readonly constructor: { name: string };
}

export class ElementListOperations<T extends IElement> {
  constructor(
    private readonly host: ElementListHost<T>,
    private readonly cache: ElementCache<T>,
    private readonly portfolioManager: PortfolioManager,
    private readonly fileOperations: FileOperationsService,
    private readonly storageLayer: IStorageLayer,
    private readonly publicElementDiscovery: PublicElementDiscovery | undefined,
    private readonly getCurrentUserId: UserIdResolver | undefined,
  ) {}

  /**
   * List all available elements.
   * Identical to the former BaseElementManager.list() body.
   */
  async list(options?: { includePublic?: boolean }): Promise<T[]> {
    try {
      if (isWritableStorageLayer(this.storageLayer)) {
        return this.listFromDatabase(options);
      }

      await this.fileOperations.createDirectory(this.host.elementDir);

      try {
        const diff = await this.storageLayer.scan();
        for (const relPath of [...diff.modified, ...diff.removed]) {
          const absPath = path.join(this.host.elementDir, relPath);
          this.cache.uncacheByPath(absPath);
        }
      } catch { /* index unavailable — list() continues without cache optimisation */ }

      const files = await this.portfolioManager.listElements(this.host.elementType);

      const elements = await Promise.all(
        files.map(async (file) => {
          try {
            const absolutePath = this.host.resolveAbsolutePath(file);
            const cached = this.cache.getCachedByAbsolutePath(absolutePath);
            if (cached) return cached;
            return await this.host.load(file);
          } catch {
            return null;
          }
        }),
      );

      const userElements = elements.filter((e): e is Awaited<T> => e !== null) as T[];

      if (options?.includePublic && this.publicElementDiscovery) {
        try {
          const userFileNames = new Set(files.map(f => path.basename(f)));
          const sharedFiles = await this.publicElementDiscovery.discoverPublicElements(
            this.host.elementType, userFileNames,
          );
          const sharedElements = await Promise.all(
            sharedFiles.map(async (absPath) => {
              try {
                const content = await this.fileOperations.readElementFile(absPath, this.host.elementType, {
                  source: `${this.host.constructor.name}.list:shared`,
                });
                const parsed = this.host.parseContent(content);
                this.host.migrateMetadataDefaults(parsed.data, absPath);
                const metadata = await this.host.parseMetadata(parsed.data);
                return this.host.createElement(metadata, parsed.content);
              } catch {
                return null;
              }
            }),
          );
          for (const el of sharedElements) {
            if (el) userElements.push(el);
          }
        } catch {
          logger.debug(`[${this.host.constructor.name}] Shared-pool discovery failed; returning user elements only`);
        }
      }

      return userElements;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const label = this.host.getElementLabelCapitalized();
        logger.debug(`${label}s directory does not exist yet, returning empty array`);
        return [];
      }
      logger.error(`Failed to list ${this.host.elementType}s:`, error);
      return [];
    }
  }

  /**
   * Database-mode list: query summaries from storage layer, then load each element.
   */
  private async listFromDatabase(options?: { includePublic?: boolean }): Promise<T[]> {
    try {
      const diff = await this.storageLayer.scan();
      for (const id of [...diff.modified, ...diff.removed]) {
        this.cache.uncacheByPath(id);
      }

      const summaries = await this.storageLayer.listSummaries(options);

      let currentUserId = '';
      if (this.getCurrentUserId) {
        try {
          currentUserId = this.getCurrentUserId() ?? '';
        } catch (err) {
          logger.warn(
            `[${this.host.constructor.name}] getCurrentUserId threw during listFromDatabase; foreign-row cache eviction skipped`,
            { error: err instanceof Error ? err.message : String(err) },
          );
        }
      }

      const elements = await Promise.all(
        summaries.map(async (summary) => {
          try {
            const cached = this.cache.elements.get(summary.filePath);
            if (cached) return cached;
            return await this.host.load(summary.filePath);
          } catch {
            return null;
          }
        }),
      );

      if (options?.includePublic && currentUserId) {
        this.evictForeignRowsFromCache(summaries, currentUserId);
      }

      return elements.filter((e): e is Awaited<T> => e !== null) as T[];
    } catch (error) {
      logger.error(`Failed to list ${this.host.elementType}s from database:`, error);
      return [];
    }
  }

  private evictForeignRowsFromCache(summaries: ElementIndexEntry[], currentUserId: string): void {
    for (const summary of summaries) {
      if (summary.userId && summary.userId !== currentUserId) {
        this.cache.uncacheByPath(summary.filePath);
      }
    }
  }

  /**
   * List lightweight metadata summaries without loading full elements.
   */
  async listSummaries(options?: { includePublic?: boolean }): Promise<ElementIndexEntry[]> {
    if (!isWritableStorageLayer(this.storageLayer)) {
      await this.fileOperations.createDirectory(this.host.elementDir);
    }
    return this.storageLayer.listSummaries(options);
  }

  /**
   * Force a fresh disk scan and evict modified/removed cache entries.
   * Unlike list(), this does not load all elements — it only evicts stale ones.
   */
  async scanAndEvict(): Promise<void> {
    this.storageLayer.invalidate();
    try {
      const diff = await this.storageLayer.scan();
      for (const relPath of [...diff.modified, ...diff.removed]) {
        const absPath = path.join(this.host.elementDir, relPath);
        this.cache.uncacheByPath(absPath);
      }
    } catch { /* non-fatal — cache may be slightly stale, but activation proceeds */ }
  }
}
