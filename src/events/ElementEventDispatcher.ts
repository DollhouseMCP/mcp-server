import { EventEmitter } from 'node:events';
import { ElementType } from '../portfolio/types.js';
import { IElement, IElementMetadata } from '../types/elements/IElement.js';

export type ElementLifecycleEvent =
  | 'element:load:start'
  | 'element:load:success'
  | 'element:load:error'
  | 'element:save:start'
  | 'element:save:success'
  | 'element:save:error'
  | 'element:delete:start'
  | 'element:delete:success'
  | 'element:delete:error'
  | 'element:activate'
  | 'element:deactivate'
  | 'element:cache:refresh'
  | 'element:cache:evict'
  | 'element:external-change'
  | 'element:lock-timeout';

export interface ElementEventPayload {
  correlationId: string;
  elementType: ElementType;
  elementId?: string;
  filePath?: string;
  metadata?: Partial<IElementMetadata>;
  generation?: number;
  error?: unknown;
  extra?: Record<string, unknown>;
}

export type ElementEventHandler = (payload: ElementEventPayload) => void | Promise<void>;

/**
 * Lightweight dispatcher for element lifecycle events.
 * Provides minimal EventEmitter wrapper with immutable payload semantics.
 */
export class ElementEventDispatcher {
  private readonly emitter = new EventEmitter();
  private static shared: ElementEventDispatcher | null = null;

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   */
  on(event: ElementLifecycleEvent, handler: ElementEventHandler): () => void {
    this.emitter.on(event, handler);
    return () => {
      this.emitter.off(event, handler);
    };
  }

  /**
   * Subscribe once.
   */
  once(event: ElementLifecycleEvent, handler: ElementEventHandler): () => void {
    this.emitter.once(event, handler);
    return () => {
      this.emitter.off(event, handler);
    };
  }

  /**
   * Emit synchronously (used for start/veto events).
   */
  emit(event: ElementLifecycleEvent, payload: ElementEventPayload): void {
    this.emitter.emit(event, { ...payload });
  }

  /**
   * Emit asynchronously to decouple observers.
   */
  emitAsync(event: ElementLifecycleEvent, payload: ElementEventPayload): void {
    const cloned = { ...payload };
    setImmediate(() => {
      this.emitter.emit(event, cloned);
    });
  }

  /**
   * Utility helper to snapshot minimal metadata from element instances.
   */
  static snapshotMetadata(element?: IElement): Partial<IElementMetadata> | undefined {
    if (!element) return undefined;
    const snapshot: Partial<IElementMetadata> & { category?: string } = {
      name: element.metadata?.name,
      description: element.metadata?.description,
      author: element.metadata?.author,
      version: element.metadata?.version,
    };
    // Add category if it exists (not part of base interface but some elements have it)
    if ((element.metadata as any)?.category) {
      snapshot.category = (element.metadata as any).category;
    }
    return snapshot;
  }

  /**
   * Shared singleton dispatcher used when managers don't inject their own.
   */
  static getSharedDispatcher(): ElementEventDispatcher {
    if (!this.shared) {
      this.shared = new ElementEventDispatcher();
    }
    return this.shared;
  }
}
