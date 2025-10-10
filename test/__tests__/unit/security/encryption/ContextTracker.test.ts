/**
 * Unit tests for ContextTracker
 *
 * Tests AsyncLocalStorage-based context tracking for LLM request detection
 *
 * Part of Issue #1321 Phase 2
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ContextTracker } from '../../../../../src/security/encryption/ContextTracker.js';

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

      expect(() => {
        ContextTracker.run(context, () => {
          throw new Error('Test error');
        });
      }).toThrow('Test error');
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

      await ContextTracker.runAsync(context, async () => {
        const ctx1 = ContextTracker.getContext();

        // Simulate async operation
        await new Promise((resolve) => setTimeout(resolve, 10));

        const ctx2 = ContextTracker.getContext();

        expect(ctx1).toEqual(ctx2);
        expect(ctx1).toEqual(context);
      });
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

      ContextTracker.run(context, () => {
        expect(ContextTracker.isLLMContext()).toBe(true);
      });
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

      ContextTracker.run(outerContext, () => {
        expect(ContextTracker.isLLMContext()).toBe(false);

        ContextTracker.run(innerContext, () => {
          expect(ContextTracker.isLLMContext()).toBe(true);
        });

        // Should revert to outer context
        expect(ContextTracker.isLLMContext()).toBe(false);
      });
    });

    it('should handle nested async contexts', async () => {
      const outerContext = ContextTracker.createContext('test');
      const innerContext = ContextTracker.createContext('llm-request');

      await ContextTracker.runAsync(outerContext, async () => {
        const ctx1 = ContextTracker.getContext();

        await ContextTracker.runAsync(innerContext, async () => {
          const ctx2 = ContextTracker.getContext();
          expect(ctx2).toEqual(innerContext);
        });

        const ctx3 = ContextTracker.getContext();
        expect(ctx3).toEqual(ctx1);
      });
    });
  });

  describe('context isolation', () => {
    it('should isolate contexts between concurrent operations', async () => {
      const context1 = ContextTracker.createContext('background-task', { id: '1' });
      const context2 = ContextTracker.createContext('llm-request', { id: '2' });

      const promise1 = ContextTracker.runAsync(context1, async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return ContextTracker.getContext()?.metadata?.id;
      });

      const promise2 = ContextTracker.runAsync(context2, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return ContextTracker.getContext()?.metadata?.id;
      });

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1).toBe('1');
      expect(result2).toBe('2');
    });
  });
});
