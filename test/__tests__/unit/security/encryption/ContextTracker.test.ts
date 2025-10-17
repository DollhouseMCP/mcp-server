/**
 * Unit tests for ContextTracker
 *
 * Tests AsyncLocalStorage-based context tracking for LLM request detection
 *
 * Part of Issue #1321 Phase 2
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ContextTracker } from '../../../../../src/security/encryption/ContextTracker.js';

// FIX: Helpers to reduce nesting depth in tests (moved to module scope)
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper that throws error - avoids deep nesting in test
const throwError = () => {
  throw new Error('Test error');
};

// Helper to check if in LLM context - avoids deep nesting
const checkIsLLMContext = () => ContextTracker.isLLMContext();

describe('ContextTracker', () => {
  beforeEach(() => {
    // Clear any existing context
    ContextTracker.clearContext();
  });

  describe('createContext', () => {
    it('should create context with correct type', () => {
      const context = ContextTracker.createContext('llm-request');

      expect(context.type).toBe('llm-request');
      expect(context.requestId).toBeDefined();
      expect(context.timestamp).toBeGreaterThan(0);
    });

    it('should create context with metadata', () => {
      const metadata = { userId: '123', operation: 'test' };
      const context = ContextTracker.createContext('background-task', metadata);

      expect(context.metadata).toEqual(metadata);
    });

    it('should generate unique request IDs', () => {
      const context1 = ContextTracker.createContext('llm-request');
      const context2 = ContextTracker.createContext('llm-request');

      expect(context1.requestId).not.toBe(context2.requestId);
    });
  });

  describe('run', () => {
    it('should set context for synchronous function', () => {
      const context = ContextTracker.createContext('llm-request');
      let capturedContext;

      ContextTracker.run(context, () => {
        capturedContext = ContextTracker.getContext();
      });

      expect(capturedContext).toEqual(context);
    });

    it('should clear context after function completes', () => {
      const context = ContextTracker.createContext('llm-request');

      ContextTracker.run(context, () => {
        expect(ContextTracker.getContext()).toEqual(context);
      });

      // Context should be cleared after run completes
      expect(ContextTracker.getContext()).toBeUndefined();
    });

    it('should return function result', () => {
      const context = ContextTracker.createContext('test');

      const result = ContextTracker.run(context, () => {
        return 42;
      });

      expect(result).toBe(42);
    });

    it('should propagate exceptions', () => {
      const context = ContextTracker.createContext('test');

      // FIX: Use module-scope helper to reduce nesting depth
      const throwingFn = () => ContextTracker.run(context, throwError);

      expect(throwingFn).toThrow('Test error');
    });
  });

  describe('runAsync', () => {
    it('should set context for async function', async () => {
      const context = ContextTracker.createContext('background-task');
      let capturedContext;

      await ContextTracker.runAsync(context, async () => {
        capturedContext = ContextTracker.getContext();
      });

      expect(capturedContext).toEqual(context);
    });

    it('should maintain context across async operations', async () => {
      const context = ContextTracker.createContext('background-task');

      // FIX: Extract async function to reduce nesting depth
      const testAsyncContext = async () => {
        const ctx1 = ContextTracker.getContext();
        await delay(10);
        const ctx2 = ContextTracker.getContext();

        expect(ctx1).toEqual(ctx2);
        expect(ctx1).toEqual(context);
      };

      await ContextTracker.runAsync(context, testAsyncContext);
    });

    it('should return promise result', async () => {
      const context = ContextTracker.createContext('test');

      const result = await ContextTracker.runAsync(context, async () => {
        return 'async-result';
      });

      expect(result).toBe('async-result');
    });

    it('should propagate async exceptions', async () => {
      const context = ContextTracker.createContext('test');

      await expect(
        ContextTracker.runAsync(context, async () => {
          throw new Error('Async error');
        })
      ).rejects.toThrow('Async error');
    });
  });

  describe('getContext', () => {
    it('should return undefined when no context is set', () => {
      expect(ContextTracker.getContext()).toBeUndefined();
    });

    it('should return current context when set', () => {
      const context = ContextTracker.createContext('llm-request');

      ContextTracker.run(context, () => {
        expect(ContextTracker.getContext()).toEqual(context);
      });
    });
  });

  describe('isLLMContext', () => {
    it('should return false when no context is set', () => {
      expect(ContextTracker.isLLMContext()).toBe(false);
    });

    it('should return true for llm-request context', () => {
      const context = ContextTracker.createContext('llm-request');

      // FIX: Use module-scope helper to reduce nesting depth
      const result = ContextTracker.run(context, checkIsLLMContext);
      expect(result).toBe(true);
    });

    it('should return false for non-LLM contexts', () => {
      const contexts = [
        ContextTracker.createContext('background-task'),
        ContextTracker.createContext('test'),
        ContextTracker.createContext('unknown'),
      ];

      for (const context of contexts) {
        ContextTracker.run(context, () => {
          expect(ContextTracker.isLLMContext()).toBe(false);
        });
      }
    });
  });

  describe('nested contexts', () => {
    it('should handle nested context correctly', () => {
      const outerContext = ContextTracker.createContext('background-task');
      const innerContext = ContextTracker.createContext('llm-request');

      // FIX: Extract nested context functions to reduce nesting depth
      const testInnerContext = () => {
        expect(ContextTracker.isLLMContext()).toBe(true);
      };

      const testOuterContext = () => {
        expect(ContextTracker.isLLMContext()).toBe(false);
        ContextTracker.run(innerContext, testInnerContext);
        expect(ContextTracker.isLLMContext()).toBe(false);
      };

      ContextTracker.run(outerContext, testOuterContext);
    });

    it('should handle nested async contexts', async () => {
      const outerContext = ContextTracker.createContext('test');
      const innerContext = ContextTracker.createContext('llm-request');

      // FIX: Extract nested async functions to reduce nesting depth
      const testInnerAsync = async () => {
        const ctx2 = ContextTracker.getContext();
        expect(ctx2).toEqual(innerContext);
      };

      const testOuterAsync = async () => {
        const ctx1 = ContextTracker.getContext();
        await ContextTracker.runAsync(innerContext, testInnerAsync);
        const ctx3 = ContextTracker.getContext();
        expect(ctx3).toEqual(ctx1);
      };

      await ContextTracker.runAsync(outerContext, testOuterAsync);
    });
  });

  describe('context isolation', () => {
    it('should isolate contexts between concurrent operations', async () => {
      const context1 = ContextTracker.createContext('background-task', { id: '1' });
      const context2 = ContextTracker.createContext('llm-request', { id: '2' });

      // FIX: Extract async functions to reduce nesting depth
      const delayAndGetId = async (ms: number) => {
        await delay(ms);
        return ContextTracker.getContext()?.metadata?.id;
      };

      const promise1 = ContextTracker.runAsync(context1, () => delayAndGetId(20));
      const promise2 = ContextTracker.runAsync(context2, () => delayAndGetId(10));

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1).toBe('1');
      expect(result2).toBe('2');
    });
  });
});
