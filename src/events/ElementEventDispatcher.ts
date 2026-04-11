import { EventEmitter } from 'node:events';
import { ElementType } from '../portfolio/types.js';
import { IElement, IElementMetadata } from '../types/elements/IElement.js';
import type { ContextTracker } from '../security/encryption/ContextTracker.js';

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
  /** Session user identity, auto-populated from SessionContext when available. */
  userId?: string;
  /** Session identifier, auto-populated from SessionContext when available. */
  sessionId?: string;
}

export type ElementEventHandler = (payload: ElementEventPayload) => void | Promise<void>;

/**
 * Lightweight dispatcher for element lifecycle events.
 * Provides minimal EventEmitter wrapper with immutable payload semantics.
 *
 * DI-MANAGED: Instantiated by the DI container with ContextTracker injected.
 * Session attribution (userId/sessionId) is auto-populated from SessionContext
 * at emit time. For emitAsync, session is captured before the setImmediate
 * boundary to prevent AsyncLocalStorage context loss.
 */
export class ElementEventDispatcher {
  private readonly emitter = new EventEmitter();

  constructor(private readonly contextTracker?: ContextTracker) {}

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
   * Session attribution is read from AsyncLocalStorage via ContextTracker.
   */
  emit(event: ElementLifecycleEvent, payload: ElementEventPayload): void {
    const session = this.contextTracker?.getSessionContext();
    this.emitter.emit(event, {
      ...payload,
      ...(session ? { userId: session.userId, sessionId: session.sessionId } : {}),
    });
  }

  /**
   * Emit asynchronously to decouple observers.
   * Session is captured BEFORE setImmediate — AsyncLocalStorage context
   * is lost across the boundary.
   */
  emitAsync(event: ElementLifecycleEvent, payload: ElementEventPayload): void {
    const session = this.contextTracker?.getSessionContext();
    const cloned: ElementEventPayload = {
      ...payload,
      ...(session ? { userId: session.userId, sessionId: session.sessionId } : {}),
    };
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
}
