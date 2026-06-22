/**
 * Unit tests for ContextTracker session-context methods
 *
 * Tests the three new methods added in Phase 1 Step 1.1:
 * - getSessionContext()
 * - requireSessionContext()
 * - createSessionContext()
 *
 * The existing ContextTracker.test.ts remains unmodified.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ContextTracker } from '../../../../src/security/encryption/ContextTracker.js';
import { SessionContextRequiredError } from '../../../../src/context/ContextPolicy.js';
import type { SessionContext } from '../../../../src/context/SessionContext.js';

const TEST_SESSION: SessionContext = Object.freeze({
  userId: 'tracker-test-user',
  sessionId: 'tracker-test-session',
  tenantId: null,
  transport: 'stdio' as const,
  createdAt: 2000000,
});

describe('ContextTracker — session methods', () => {
  let tracker: ContextTracker;

  beforeEach(() => {
    tracker = new ContextTracker();
    tracker.clearContext();
  });

  describe('createSessionContext', () => {
    it('should create context with session attached', () => {
      const ctx = tracker.createSessionContext('llm-request', TEST_SESSION);

      expect(ctx.type).toBe('llm-request');
      expect(ctx.session).toBeDefined();
      expect(ctx.session?.userId).toBe('tracker-test-user');
    });

    it('should freeze the session object', () => {
      const ctx = tracker.createSessionContext('background-task', TEST_SESSION);
      expect(Object.isFrozen(ctx.session)).toBe(true);
    });

    it('should generate requestId and timestamp', () => {
      const ctx = tracker.createSessionContext('test', TEST_SESSION);
      expect(ctx.requestId).toBeDefined();
      expect(ctx.timestamp).toBeGreaterThan(0);
    });

    it('should accept optional metadata', () => {
      const ctx = tracker.createSessionContext('test', TEST_SESSION, {
        tool: 'test-tool',
      });
      expect(ctx.metadata?.tool).toBe('test-tool');
    });

    it('should shallow-copy session before freezing', () => {
      const mutableSession: SessionContext = {
        userId: 'mutable',
        sessionId: 'mutable-session',
        tenantId: null,
        transport: 'stdio',
        createdAt: 3000000,
      };
      const ctx = tracker.createSessionContext('test', mutableSession);

      // The stored session should be a separate frozen copy
      expect(ctx.session?.userId).toBe('mutable');
      expect(Object.isFrozen(ctx.session)).toBe(true);
    });
  });

  describe('getSessionContext', () => {
    it('should return undefined when no context is active', () => {
      expect(tracker.getSessionContext()).toBeUndefined();
    });

    it('should return undefined when context has no session', () => {
      const ctx = tracker.createContext('llm-request');
      tracker.run(ctx, () => {
        expect(tracker.getSessionContext()).toBeUndefined();
      });
    });

    it('should return session when context has one', async () => {
      const ctx = tracker.createSessionContext('background-task', TEST_SESSION);
      let result: SessionContext | undefined;

      await tracker.runAsync(ctx, async () => {
        result = tracker.getSessionContext();
      });

      expect(result?.userId).toBe('tracker-test-user');
      expect(result?.sessionId).toBe('tracker-test-session');
    });

    it('should return undefined after context exits', async () => {
      const ctx = tracker.createSessionContext('test', TEST_SESSION);
      await tracker.runAsync(ctx, async () => {
        expect(tracker.getSessionContext()).toBeDefined();
      });
      expect(tracker.getSessionContext()).toBeUndefined();
    });

    it('should propagate through nested async calls', async () => {
      const ctx = tracker.createSessionContext('llm-request', TEST_SESSION);

      const innerCheck = async (): Promise<SessionContext | undefined> => {
        return tracker.getSessionContext();
      };

      let result: SessionContext | undefined;
      await tracker.runAsync(ctx, async () => {
        result = await innerCheck();
      });

      expect(result?.userId).toBe('tracker-test-user');
    });
  });

  describe('requireSessionContext', () => {
    it('should throw when no context is active', () => {
      expect(() => tracker.requireSessionContext()).toThrow(
        SessionContextRequiredError
      );
    });

    it('should throw when context has no session', () => {
      const ctx = tracker.createContext('llm-request');
      tracker.run(ctx, () => {
        expect(() => tracker.requireSessionContext()).toThrow(
          SessionContextRequiredError
        );
      });
    });

    it('should include caller in error when provided', () => {
      try {
        tracker.requireSessionContext('TestCaller.method');
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect((err as SessionContextRequiredError).message).toContain(
          'TestCaller.method'
        );
      }
    });

    it('should return session when one is active', async () => {
      const ctx = tracker.createSessionContext('test', TEST_SESSION);
      let result: SessionContext | undefined;

      await tracker.runAsync(ctx, async () => {
        result = tracker.requireSessionContext();
      });

      expect(result?.userId).toBe('tracker-test-user');
    });
  });

  describe('backward compatibility', () => {
    it('createContext should still work without session', () => {
      const ctx = tracker.createContext('llm-request', { tool: 'foo' });
      expect(ctx.session).toBeUndefined();
      expect(ctx.type).toBe('llm-request');
      expect(ctx.metadata?.tool).toBe('foo');
    });

    it('existing run() works with session-less context', () => {
      const ctx = tracker.createContext('background-task');
      let captured;
      tracker.run(ctx, () => {
        captured = tracker.getContext();
      });
      expect(captured).toEqual(ctx);
    });

    it('isLLMContext still works with session context', async () => {
      const ctx = tracker.createSessionContext('llm-request', TEST_SESSION);
      let isLLM = false;

      await tracker.runAsync(ctx, async () => {
        isLLM = tracker.isLLMContext();
      });

      expect(isLLM).toBe(true);
    });

    it('getCorrelationId works with session context', async () => {
      const ctx = tracker.createSessionContext('llm-request', TEST_SESSION);
      let correlationId: string | undefined;

      await tracker.runAsync(ctx, async () => {
        correlationId = tracker.getCorrelationId();
      });

      expect(correlationId).toBeDefined();
      expect(correlationId).toBe(ctx.requestId);
    });
  });
});
