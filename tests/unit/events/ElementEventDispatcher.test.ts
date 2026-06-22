import { describe, it, expect, beforeEach } from '@jest/globals';
import { ElementEventDispatcher, type ElementLifecycleEvent, type ElementEventPayload } from '../../../src/events/ElementEventDispatcher.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import type { SessionContext } from '../../../src/context/SessionContext.js';

function createPayload() {
  return {
    correlationId: 'test-correlation',
    elementType: ElementType.PERSONA as ElementType,
    elementId: 'element-123',
    filePath: 'personas/test.md',
    metadata: { name: 'Test Persona' }
  };
}

describe('ElementEventDispatcher', () => {
  let dispatcher: ElementEventDispatcher;

  beforeEach(() => {
    dispatcher = new ElementEventDispatcher();
  });

  it('emits synchronous events in registration order', () => {
    const events: ElementLifecycleEvent[] = [];
    dispatcher.on('element:load:start', () => events.push('element:load:start'));
    dispatcher.on('element:load:start', () => events.push('element:load:start#2'));

    dispatcher.emit('element:load:start', createPayload());

    expect(events).toEqual(['element:load:start', 'element:load:start#2']);
  });

  it('emits async events on next tick', async () => {
    const events: ElementLifecycleEvent[] = [];
    dispatcher.on('element:save:success', () => events.push('element:save:success'));

    dispatcher.emitAsync('element:save:success', createPayload());
    expect(events).toEqual([]); // not yet executed

    await new Promise(resolve => setImmediate(resolve));
    expect(events).toEqual(['element:save:success']);
  });

  it('supports unsubscribe semantics', () => {
    const events: ElementLifecycleEvent[] = [];
    const unsubscribe = dispatcher.on('element:cache:refresh', () => events.push('element:cache:refresh'));

    dispatcher.emit('element:cache:refresh', createPayload());
    unsubscribe();
    dispatcher.emit('element:cache:refresh', createPayload());

    expect(events).toEqual(['element:cache:refresh']);
  });
});

const TEST_SESSION: SessionContext = Object.freeze({
  userId: 'http-user-alice',
  sessionId: 'session-456',
  tenantId: null,
  transport: 'http' as const,
  createdAt: Date.now(),
});

describe('ElementEventDispatcher — session attribution', () => {
  it('emit() adds userId and sessionId when session is active', async () => {
    const tracker = new ContextTracker();
    const dispatcher = new ElementEventDispatcher(tracker);
    const ctx = tracker.createSessionContext('llm-request', TEST_SESSION);

    let received: ElementEventPayload | undefined;
    dispatcher.on('element:save:success', (payload) => {
      received = payload;
    });

    await tracker.runAsync(ctx, async () => {
      dispatcher.emit('element:save:success', createPayload());
    });

    expect(received?.userId).toBe('http-user-alice');
    expect(received?.sessionId).toBe('session-456');
  });

  it('emitAsync() captures session before setImmediate boundary', async () => {
    const tracker = new ContextTracker();
    const dispatcher = new ElementEventDispatcher(tracker);
    const ctx = tracker.createSessionContext('llm-request', TEST_SESSION);

    let received: ElementEventPayload | undefined;
    dispatcher.on('element:load:success', (payload) => {
      received = payload;
    });

    await tracker.runAsync(ctx, async () => {
      dispatcher.emitAsync('element:load:success', createPayload());
    });

    // Wait for setImmediate to fire
    await new Promise(resolve => setImmediate(resolve));

    expect(received?.userId).toBe('http-user-alice');
    expect(received?.sessionId).toBe('session-456');
  });

  it('emit() does not add session fields when no ContextTracker', () => {
    const dispatcher = new ElementEventDispatcher(); // no tracker

    let received: ElementEventPayload | undefined;
    dispatcher.on('element:delete:success', (payload) => {
      received = payload;
    });

    dispatcher.emit('element:delete:success', createPayload());

    expect(received?.userId).toBeUndefined();
    expect(received?.sessionId).toBeUndefined();
  });

  it('emit() does not add session fields when no session active', () => {
    const tracker = new ContextTracker();
    const dispatcher = new ElementEventDispatcher(tracker);

    let received: ElementEventPayload | undefined;
    dispatcher.on('element:activate', (payload) => {
      received = payload;
    });

    // No runAsync — no session in AsyncLocalStorage
    dispatcher.emit('element:activate', createPayload());

    expect(received?.userId).toBeUndefined();
    expect(received?.sessionId).toBeUndefined();
  });
});
