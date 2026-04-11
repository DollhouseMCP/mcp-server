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
 * REFACTOR NOTE:
 * Converted from static class to instance-based for DI architecture compatibility.
 * ContextTracker now uses instance methods instead of static methods, allowing
 * proper lifecycle management and testability within DI container.
 *
 * @module ContextTracker
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import type { SessionContext } from '../../context/SessionContext.js';
import { SessionContextRequiredError } from '../../context/ContextPolicy.js';

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

  /**
   * Session context associated with this execution.
   * Optional for backward compatibility — callers not yet using sessions
   * may omit this field without any behavioural change.
   */
  session?: SessionContext;
}

/**
 * Context tracker using AsyncLocalStorage
 *
 * Maintains execution context across async operations to detect
 * LLM request handling and prevent pattern decryption in those contexts.
 *
 * DI-COMPATIBLE: Instance-based service for dependency injection.
 */
export class ContextTracker {
  private readonly storage = new AsyncLocalStorage<ExecutionContext>();

  /**
   * Create a new ContextTracker instance
   */
  constructor() {
    logger.debug('ContextTracker initialized');
  }

  /**
   * Run a function within a specific execution context
   *
   * @param context - Execution context to set
   * @param fn - Function to run within the context
   * @returns Result of the function
   */
  run<T>(context: ExecutionContext, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  /**
   * Run an async function within a specific execution context
   *
   * @param context - Execution context to set
   * @param fn - Async function to run within the context
   * @returns Promise resolving to the function result
   */
  async runAsync<T>(
    context: ExecutionContext,
    fn: () => Promise<T>
  ): Promise<T> {
    return this.storage.run(context, fn);
  }

  /**
   * Get the current execution context
   *
   * @returns Current context or undefined if no context is set
   */
  getContext(): ExecutionContext | undefined {
    return this.storage.getStore();
  }

  /**
   * Check if currently in an LLM request context
   *
   * @returns true if in LLM request context, false otherwise
   */
  isLLMContext(): boolean {
    const context = this.getContext();
    return context?.type === 'llm-request';
  }

  /**
   * Create a new execution context object
   *
   * @param type - Context type
   * @param metadata - Optional metadata
   * @returns New execution context
   */
  createContext(
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
   * Generate a unique request ID using cryptographically secure random bytes
   *
   * @returns Unique request ID
   */
  private generateRequestId(): string {
    // Use cryptographically secure random bytes instead of Math.random()
    const randomId = randomBytes(4).toString('hex');
    return `${Date.now()}-${randomId}`;
  }

  /**
   * Get the current correlation ID (request-level identifier).
   * Returns undefined when no context is active (e.g. background timers).
   */
  getCorrelationId(): string | undefined {
    return this.getContext()?.requestId;
  }

  /**
   * Clear the current context (useful for testing)
   */
  clearContext(): void {
    // AsyncLocalStorage doesn't have a direct clear method
    // Context is automatically cleared when execution exits
  }

  /**
   * Get the SessionContext from the current execution context, if any.
   *
   * @returns The SessionContext if one is stored in the current context,
   *          or undefined if no context is active or no session was set.
   */
  getSessionContext(): SessionContext | undefined {
    return this.getContext()?.session;
  }

  /**
   * Get the SessionContext from the current execution context, throwing if
   * no session is present.
   *
   * Use this when a real user identity is required (e.g., audit logging,
   * per-user rate limits). Use getSessionOrSystem() from ContextPolicy for
   * paths that can safely fall back to a system identity.
   *
   * @param caller - Optional caller identifier for error messages
   * @throws {SessionContextRequiredError} When no session context is active
   * @returns The active SessionContext
   */
  requireSessionContext(caller?: string): SessionContext {
    const session = this.getSessionContext();
    if (session === undefined) {
      throw new SessionContextRequiredError(caller);
    }
    return session;
  }

  /**
   * Create an ExecutionContext with an associated SessionContext.
   *
   * The SessionContext is shallow-copied and Object.freeze()'d before storage
   * to prevent downstream mutation of session identity.
   *
   * @param type - Context type (same values as createContext)
   * @param session - The SessionContext to associate with this execution
   * @param metadata - Optional additional metadata
   * @returns New ExecutionContext with frozen session attached
   */
  createSessionContext(
    type: ExecutionContext['type'],
    session: SessionContext,
    metadata?: Record<string, unknown>
  ): ExecutionContext {
    return {
      type,
      requestId: this.generateRequestId(),
      timestamp: Date.now(),
      metadata,
      session: Object.freeze({ ...session }),
    };
  }

  /**
   * Dispose of the context tracker and clean up resources
   * Implements cleanup for proper DI lifecycle management
   */
  async dispose(): Promise<void> {
    this.clearContext();
    logger.debug('ContextTracker disposed');
  }
}
