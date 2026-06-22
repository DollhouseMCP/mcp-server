/**
 * Unit tests for SessionContainer (Issue #1948).
 *
 * Tests parent delegation, own-service priority, disposal isolation,
 * and root-only service guard.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { SessionContainer } = await import('../../../src/di/SessionContainer.js');

function createMockParent(services: Record<string, unknown> = {}) {
  return {
    resolve: jest.fn((name: string) => {
      if (name in services) return services[name];
      throw new Error(`Service not registered: ${name}`);
    }),
  };
}

describe('SessionContainer', () => {
  let parent: ReturnType<typeof createMockParent>;

  beforeEach(() => {
    parent = createMockParent({
      'SharedService': { name: 'shared' },
      'SessionActivationRegistry': { dispose: jest.fn() },
      'gatekeeper': { disposeSession: jest.fn() },
      'mcpAqlHandler': { cleanupSession: jest.fn() },
    });
  });

  describe('resolve()', () => {
    it('resolves own session-scoped services', () => {
      const child = new SessionContainer(parent, 'session-1');
      child.register('MyService', () => ({ value: 42 }));

      const result = child.resolve<{ value: number }>('MyService');
      expect(result.value).toBe(42);
      expect(parent.resolve).not.toHaveBeenCalled();
    });

    it('delegates to parent for unregistered services', () => {
      const child = new SessionContainer(parent, 'session-1');

      const result = child.resolve<{ name: string }>('SharedService');
      expect(result.name).toBe('shared');
      expect(parent.resolve).toHaveBeenCalledWith('SharedService');
    });

    it('caches session-scoped services (singleton within session)', () => {
      const child = new SessionContainer(parent, 'session-1');
      let callCount = 0;
      child.register('Counter', () => ({ count: ++callCount }));

      const first = child.resolve<{ count: number }>('Counter');
      const second = child.resolve<{ count: number }>('Counter');
      expect(first).toBe(second);
      expect(first.count).toBe(1);
    });

    it('session services take priority over parent services', () => {
      const child = new SessionContainer(parent, 'session-1');
      child.register('SharedService', () => ({ name: 'session-override' }));

      const result = child.resolve<{ name: string }>('SharedService');
      expect(result.name).toBe('session-override');
      expect(parent.resolve).not.toHaveBeenCalled();
    });
  });

  describe('register()', () => {
    it('throws for root-only services', () => {
      const child = new SessionContainer(parent, 'session-1');

      expect(() => child.register('LogManager', () => ({}))).toThrow(/root-only singleton/);
      expect(() => child.register('MetricsManager', () => ({}))).toThrow(/root-only singleton/);
      expect(() => child.register('FileLogSink', () => ({}))).toThrow(/root-only singleton/);
      expect(() => child.register('BackgroundValidator', () => ({}))).toThrow(/root-only singleton/);
      expect(() => child.register('PerformanceMonitor', () => ({}))).toThrow(/root-only singleton/);
      expect(() => child.register('FileWatchService', () => ({}))).toThrow(/root-only singleton/);
    });

    it('allows session-scoped services', () => {
      const child = new SessionContainer(parent, 'session-1');
      expect(() => child.register('ActivationStore', () => ({}))).not.toThrow();
      expect(() => child.register('GatekeeperSession', () => ({}))).not.toThrow();
      expect(() => child.register('ConfirmationStore', () => ({}))).not.toThrow();
    });
  });

  describe('dispose()', () => {
    it('disposes only session-scoped services', async () => {
      const disposeFn = jest.fn();
      const child = new SessionContainer(parent, 'session-1');
      child.register('SessionService', () => ({ dispose: disposeFn }));

      // Resolve to create the instance
      child.resolve('SessionService');

      await child.dispose();

      expect(disposeFn).toHaveBeenCalled();
    });

    it('does NOT dispose parent services', async () => {
      const parentDispose = jest.fn();
      const parentWithDisposable = createMockParent({
        'SharedService': { name: 'shared', dispose: parentDispose },
        'SessionActivationRegistry': { dispose: jest.fn() },
        'gatekeeper': { disposeSession: jest.fn() },
        'mcpAqlHandler': { cleanupSession: jest.fn() },
      });
      const child = new SessionContainer(parentWithDisposable, 'session-1');
      await child.dispose();

      // Parent's SharedService.dispose should NOT be called by child disposal
      expect(parentDispose).not.toHaveBeenCalled();
    });

    it('disposes services with close() method', async () => {
      const closeFn = jest.fn();
      const child = new SessionContainer(parent, 'session-1');
      child.register('CloseableService', () => ({ close: closeFn }));
      child.resolve('CloseableService');
      await child.dispose();
      expect(closeFn).toHaveBeenCalled();
    });

    it('disposes services with destroy() method', async () => {
      const destroyFn = jest.fn();
      const child = new SessionContainer(parent, 'session-1');
      child.register('DestroyableService', () => ({ destroy: destroyFn }));
      child.resolve('DestroyableService');
      await child.dispose();
      expect(destroyFn).toHaveBeenCalled();
    });

    it('calls cleanup on shared root services', async () => {
      const child = new SessionContainer(parent, 'session-1');
      await child.dispose();

      expect(parent.resolve).toHaveBeenCalledWith('SessionActivationRegistry');
      expect(parent.resolve).toHaveBeenCalledWith('gatekeeper');
      expect(parent.resolve).toHaveBeenCalledWith('mcpAqlHandler');

      const registry = parent.resolve('SessionActivationRegistry') as { dispose: jest.Mock };
      expect(registry.dispose).toHaveBeenCalledWith('session-1');

      const gatekeeper = parent.resolve('gatekeeper') as { disposeSession: jest.Mock };
      expect(gatekeeper.disposeSession).toHaveBeenCalledWith('session-1');

      const handler = parent.resolve('mcpAqlHandler') as { cleanupSession: jest.Mock };
      expect(handler.cleanupSession).toHaveBeenCalledWith('session-1');
    });

    it('handles disposal failures gracefully', async () => {
      const child = new SessionContainer(parent, 'session-1');
      child.register('FailingService', () => ({
        dispose: () => { throw new Error('disposal failed'); },
      }));
      child.resolve('FailingService');

      // Should not throw
      await child.dispose();
    });

    it('skips unresolved services during disposal', async () => {
      const child = new SessionContainer(parent, 'session-1');
      child.register('NeverResolved', () => ({ dispose: jest.fn() }));

      // Don't resolve — should not try to dispose
      await child.dispose();
      // No error = success
    });
  });

  describe('sessionId', () => {
    it('exposes the session ID', () => {
      const child = new SessionContainer(parent, 'my-session');
      expect(child.sessionId).toBe('my-session');
    });
  });
});
