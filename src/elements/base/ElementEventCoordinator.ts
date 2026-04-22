/**
 * ElementEventCoordinator - Event emission and file-watcher management.
 *
 * Owns the EventDispatcher reference, the auto-reload flag, and the
 * watcher cleanup handle. Provides createEventPayload() and
 * handleExternalChange() so BaseElementManager doesn't need to know
 * about watcher internals.
 * Extracted from BaseElementManager; no behaviour changed.
 */

import { randomUUID } from 'node:crypto';
import { accessSync } from 'node:fs';
import * as path from 'path';
import { ElementEventDispatcher, ElementEventPayload } from '../../events/ElementEventDispatcher.js';
import { FileWatchService } from '../../services/FileWatchService.js';
import { IElement } from '../../types/elements/IElement.js';
import { ElementType } from '../../portfolio/types.js';
import { logger } from '../../utils/logger.js';
import type { ElementCache } from './ElementCache.js';
import type { IStorageLayer } from '../../storage/IStorageLayer.js';

/**
 * Host interface: coordinator calls back into BaseElementManager to
 * trigger a reload and to access elementDir/elementType for logging.
 */
export interface ElementEventCoordinatorHost<T extends IElement> {
  readonly elementDir: string;
  readonly elementType: ElementType;
  load(filePath: string): Promise<T>;
  getElementLabel(): string;
}

export class ElementEventCoordinator<T extends IElement> {
  private watcherCleanup?: () => void;

  constructor(
    private readonly dispatcher: ElementEventDispatcher,
    private readonly autoReloadOnExternalChange: boolean,
    private readonly host: ElementEventCoordinatorHost<T>,
    private readonly cache: ElementCache<T>,
    private readonly storageLayer: IStorageLayer,
    fileWatchService: FileWatchService | undefined,
    elementDir: string,
  ) {
    if (fileWatchService) {
      this.watcherCleanup = fileWatchService.watchDirectory(
        elementDir,
        (relativePath) => this.handleExternalChange(relativePath),
      );
    }
  }

  get eventDispatcher(): ElementEventDispatcher {
    return this.dispatcher;
  }

  /**
   * Creates a standardized event payload for element lifecycle events.
   */
  createEventPayload(params: {
    correlationId: string;
    filePath?: string;
    element?: T;
    error?: unknown;
  }): ElementEventPayload {
    const elementId = params.element?.id;
    const generation = elementId !== undefined ? this.cache.getGeneration(elementId) : undefined;
    return {
      correlationId: params.correlationId,
      elementType: this.host.elementType,
      elementId,
      filePath: params.filePath,
      metadata: ElementEventDispatcher.snapshotMetadata(params.element),
      generation,
      error: params.error,
    };
  }

  /**
   * Called by the FileWatchService when an external file change is detected.
   * Invalidates the cache entry and optionally reloads the element.
   */
  handleExternalChange(relativePath: string): void {
    this.cache.uncacheByPath(relativePath);
    this.storageLayer.invalidate();

    const correlationId = randomUUID();
    this.dispatcher.emitAsync(
      'element:external-change',
      this.createEventPayload({ correlationId, filePath: relativePath }),
    );

    if (this.autoReloadOnExternalChange) {
      const absolutePath = path.resolve(this.host.elementDir, relativePath);
      try {
        accessSync(absolutePath);
      } catch (fsError) {
        logger.debug('External change detected for deleted file, skipping reload', {
          elementType: this.host.elementType,
          filePath: relativePath,
          code: fsError instanceof Error && 'code' in fsError
            ? (fsError as NodeJS.ErrnoException).code
            : undefined,
        });
        return;
      }
      void this.host.load(relativePath).catch((error) => {
        logger.warn('Auto reload after external change failed', {
          elementType: this.host.elementType,
          filePath: relativePath,
          error: error instanceof Error ? error.message : error,
        });
      });
    }
  }

  dispose(): void {
    this.watcherCleanup?.();
    this.watcherCleanup = undefined;
  }
}
