/**
 * Unit tests for ContextTracker
 *
 * Tests AsyncLocalStorage-based context tracking for LLM request detection
 *
 * Part of Issue #1321 Phase 2
 * DI REFACTOR: Adapted for instance-based architecture
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ContextTracker } from '../../../../src/security/encryption/ContextTracker.js';

// FIX: Helpers to reduce nesting depth in tests (moved to module scope)
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper that throws error - avoids deep nesting in test
const throwError = () => {
  throw new Error('Test error');
};

describe('ContextTracker', () => {
  // DI REFACTOR: Create instance for each test
  let tracker: ContextTracker;

  // Helper to check if in LLM context - avoids deep nesting
  // NOTE: Must be inside describe block to access tracker instance
  let checkIsLLMContext: () => boolean;

  beforeEach(() => {
    // Create fresh instance before each test
    tracker = new ContextTracker();

    // Initialize helper function with current instance
    checkIsLLMContext = () => tracker.isLLMContext();

    // Clear any existing context
    tracker.clearContext();
  });

  describe('createContext', () => {
    it('should create context with correct type', () => {
      const context = tracker.createContext('llm-request');

      expect(context.type).toBe('llm-request');
      expect(context.requestId).toBeDefined();
      expect(context.timestamp).toBeGreaterThan(0);
    });

    it('should create context with metadata', () => {
      const metadata = { userId: '123', operation: 'test' };
      const context = tracker.createContext('background-task', metadata);

      expect(context.metadata).toEqual(metadata);
    });

    it('should generate unique request IDs', () => {
      const context1 = tracker.createContext('llm-request');
      const context2 = tracker.createContext('llm-request');

      expect(context1.requestId).not.toBe(context2.requestId);
    });
  });

  describe('run', () => {
    it('should set context for synchronous function', () => {
      const context = tracker.createContext('llm-request');
      let capturedContext;

      tracker.run(context, () => {
        capturedContext = tracker.getContext();
      });

      expect(capturedContext).toEqual(context);
    });

    it('should clear context after function completes', () => {
      const context = tracker.createContext('llm-request');

      tracker.run(context, () => {
        expect(tracker.getContext()).toEqual(context);
      });

      // Context should be cleared after run completes
      expect(tracker.getContext()).toBeUndefined();
    });

    it('should return function result', () => {
      const context = tracker.createContext('test');

      const result = tracker.run(context, () => {
        return 42;
      });

      expect(result).toBe(42);
    });

    it('should propagate exceptions', () => {
      const context = tracker.createContext('test');

      // FIX: Use module-scope helper to reduce nesting depth
      const throwingFn = () => tracker.run(context, throwError);

      expect(throwingFn).toThrow('Test error');
    });
  });

  describe('runAsync', () => {
    it('should set context for async function', async () => {
      const context = tracker.createContext('background-task');
      let capturedContext;

      await tracker.runAsync(context, async () => {
        capturedContext = tracker.getContext();
      });

      expect(capturedContext).toEqual(context);
    });

    it('should maintain context across async operations', async () => {
      const context = tracker.createContext('background-task');

      // FIX: Extract async function to reduce nesting depth
      const testAsyncContext = async () => {
        const ctx1 = tracker.getContext();
        await delay(10);
        const ctx2 = tracker.getContext();

        expect(ctx1).toEqual(ctx2);
        expect(ctx1).toEqual(context);
      };

      await tracker.runAsync(context, testAsyncContext);
    });

    it('should return promise result', async () => {
      const context = tracker.createContext('test');

      const result = await tracker.runAsync(context, async () => {
        return 'async-result';
      });

      expect(result).toBe('async-result');
    });

    it('should propagate async exceptions', async () => {
      const context = tracker.createContext('test');

      await expect(
        tracker.runAsync(context, async () => {
          throw new Error('Async error');
        })
      ).rejects.toThrow('Async error');
    });
  });

  describe('getContext', () => {
    it('should return undefined when no context is set', () => {
      expect(tracker.getContext()).toBeUndefined();
    });

    it('should return current context when set', () => {
      const context = tracker.createContext('llm-request');

      tracker.run(context, () => {
        expect(tracker.getContext()).toEqual(context);
      });
    });
  });

  describe('isLLMContext', () => {
    it('should return false when no context is set', () => {
      expect(tracker.isLLMContext()).toBe(false);
    });

    it('should return true for llm-request context', () => {
      const context = tracker.createContext('llm-request');

      // FIX: Use module-scope helper to reduce nesting depth
      const result = tracker.run(context, checkIsLLMContext);
      expect(result).toBe(true);
    });

    it('should return false for non-LLM contexts', () => {
      const contexts = [
        tracker.createContext('background-task'),
        tracker.createContext('test'),
        tracker.createContext('unknown'),
      ];

      for (const context of contexts) {
        tracker.run(context, () => {
          expect(tracker.isLLMContext()).toBe(false);
        });
      }
    });
  });

  describe('nested contexts', () => {
    it('should handle nested context correctly', () => {
      const outerContext = tracker.createContext('background-task');
      const innerContext = tracker.createContext('llm-request');

      // FIX: Extract nested context functions to reduce nesting depth
      const testInnerContext = () => {
        expect(tracker.isLLMContext()).toBe(true);
      };

      const testOuterContext = () => {
        expect(tracker.isLLMContext()).toBe(false);
        tracker.run(innerContext, testInnerContext);
        expect(tracker.isLLMContext()).toBe(false);
      };

      tracker.run(outerContext, testOuterContext);
    });

    it('should handle nested async contexts', async () => {
      const outerContext = tracker.createContext('test');
      const innerContext = tracker.createContext('llm-request');

      // FIX: Extract nested async functions to reduce nesting depth
      const testInnerAsync = async () => {
        const ctx2 = tracker.getContext();
        expect(ctx2).toEqual(innerContext);
      };

      const testOuterAsync = async () => {
        const ctx1 = tracker.getContext();
        await tracker.runAsync(innerContext, testInnerAsync);
        const ctx3 = tracker.getContext();
        expect(ctx3).toEqual(ctx1);
      };

      await tracker.runAsync(outerContext, testOuterAsync);
    });
  });

  describe('getCorrelationId', () => {
    it('should return undefined with no context', () => {
      expect(tracker.getCorrelationId()).toBeUndefined();
    });

    it('should return requestId inside context', () => {
      const context = tracker.createContext('llm-request');

      const result = tracker.run(context, () => tracker.getCorrelationId());

      expect(result).toBe(context.requestId);
      expect(result).toBeDefined();
    });

    it('should return undefined after context exits', () => {
      const context = tracker.createContext('llm-request');

      tracker.run(context, () => {
        expect(tracker.getCorrelationId()).toBeDefined();
      });

      expect(tracker.getCorrelationId()).toBeUndefined();
    });
  });

  describe('context isolation', () => {
    it('should isolate contexts between concurrent operations', async () => {
      const context1 = tracker.createContext('background-task', { id: '1' });
      const context2 = tracker.createContext('llm-request', { id: '2' });

      // FIX: Extract async functions to reduce nesting depth
      const delayAndGetId = async (ms: number) => {
        await delay(ms);
        return tracker.getContext()?.metadata?.id;
      };

      const promise1 = tracker.runAsync(context1, () => delayAndGetId(20));
      const promise2 = tracker.runAsync(context2, () => delayAndGetId(10));

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1).toBe('1');
      expect(result2).toBe('2');
    });
  });
});
