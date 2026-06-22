import { describe, it, expect, jest } from '@jest/globals';
import { SessionContainerRegistry } from '../../../src/di/SessionContainerRegistry.js';

describe('SessionContainerRegistry', () => {
  it('should register, resolve, and unregister session containers', () => {
    const registry = new SessionContainerRegistry(() => undefined);
    const container = { sessionId: 'session-a' } as any;

    registry.register('session-a', container);
    expect(registry.get('session-a')).toBe(container);

    registry.unregister('session-a');
    expect(registry.get('session-a')).toBeUndefined();
  });

  it('should resolve the active container from ContextTracker session context', () => {
    const getSessionContext = jest.fn(() => ({
      sessionId: 'session-a',
      userId: 'user-a',
      tenantId: null,
      transport: 'http' as const,
      createdAt: Date.now(),
    }));
    const registry = new SessionContainerRegistry(() => ({ getSessionContext }) as any);
    const container = { sessionId: 'session-a' } as any;

    registry.register('session-a', container);

    expect(registry.getActiveContainer()).toBe(container);
  });

  it('should return undefined when no session context is active', () => {
    const registry = new SessionContainerRegistry(() => ({
      getSessionContext: () => undefined,
    }) as any);

    expect(registry.getActiveContainer()).toBeUndefined();
  });
});
