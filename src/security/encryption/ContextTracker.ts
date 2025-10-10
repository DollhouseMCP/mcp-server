/**
 * Context Tracking for LLM Request Detection
 *
 * Part of Issue #1321 Phase 2: Memory Security Architecture
 *
 * PURPOSE:
 * Tracks execution context to detect if code is running within an LLM request
 * handler. Uses AsyncLocalStorage to maintain context across async operations.
 *
 * SECURITY:
 * - Prevents pattern decryption in LLM contexts
 * - Ensures patterns never leak to LLM responses
 * - Provides audit trail for context checks
 *
 * @module ContextTracker
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '../../utils/logger.js';

/**
 * Execution context information
 */
export interface ExecutionContext {
  /** Context type (llm-request, background-task, test, etc.) */
  type: 'llm-request' | 'background-task' | 'test' | 'unknown';

  /** Request ID for correlation */
  requestId?: string;

  /** Timestamp when context was created */
  timestamp: number;

  /** Additional context metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Context tracker using AsyncLocalStorage
 *
 * Maintains execution context across async operations to detect
 * LLM request handling and prevent pattern decryption in those contexts.
 */
export class ContextTracker {
  private static storage = new AsyncLocalStorage<ExecutionContext>();

  /**
   * Run a function within a specific execution context
   *
   * @param context - Execution context to set
   * @param fn - Function to run within the context
   * @returns Result of the function
   */
  static run<T>(context: ExecutionContext, fn: () => T): T {
    logger.debug('Setting execution context', {
      type: context.type,
      requestId: context.requestId,
    });

    return this.storage.run(context, fn);
  }

  /**
   * Run an async function within a specific execution context
   *
   * @param context - Execution context to set
   * @param fn - Async function to run within the context
   * @returns Promise resolving to the function result
   */
  static async runAsync<T>(
    context: ExecutionContext,
    fn: () => Promise<T>
  ): Promise<T> {
    logger.debug('Setting async execution context', {
      type: context.type,
      requestId: context.requestId,
    });

    return this.storage.run(context, fn);
  }

  /**
   * Get the current execution context
   *
   * @returns Current context or undefined if no context is set
   */
  static getContext(): ExecutionContext | undefined {
    return this.storage.getStore();
  }

  /**
   * Check if currently in an LLM request context
   *
   * @returns true if in LLM request context, false otherwise
   */
  static isLLMContext(): boolean {
    const context = this.getContext();
    const isLLM = context?.type === 'llm-request';

    if (context) {
      logger.debug('Checked LLM context', {
        type: context.type,
        isLLM,
        requestId: context.requestId,
      });
    }

    return isLLM;
  }

  /**
   * Create a new execution context object
   *
   * @param type - Context type
   * @param metadata - Optional metadata
   * @returns New execution context
   */
  static createContext(
    type: ExecutionContext['type'],
    metadata?: Record<string, unknown>
  ): ExecutionContext {
    return {
      type,
      requestId: this.generateRequestId(),
      timestamp: Date.now(),
      metadata,
    };
  }

  /**
   * Generate a unique request ID
   *
   * @returns Unique request ID
   */
  private static generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Clear the current context (useful for testing)
   */
  static clearContext(): void {
    // AsyncLocalStorage doesn't have a direct clear method
    // Context is automatically cleared when execution exits
    logger.debug('Context cleared (will be garbage collected)');
  }
}
