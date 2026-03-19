/**
 * Resilience Evaluator for Agent Execution
 *
 * Pure functions that evaluate resilience policies to determine recovery actions
 * when agents hit step limits or encounter execution failures.
 *
 * Design: All functions are pure (no side effects, no I/O). The MCPAQLHandler
 * is responsible for acting on the returned ResilienceAction.
 *
 * The CircuitBreakerState class is the one exception to purity — it holds
 * singleton state that tracks agents whose resilience limits were recently
 * exhausted.  When an agent trips the breaker and is re-executed within the
 * cooldown window, the evaluator forces an immediate pause instead of allowing
 * further auto-continuation or retry loops.
 *
 * @since v2.1.0 - Agent Execution Resilience (Issue #526)
 */

import type { AgentResiliencePolicy, ResilienceAction } from './types.js';

// =============================================================================
// Constants
// =============================================================================

/** Default resilience policy — all 'pause', matching pre-#526 behavior */
export const DEFAULT_RESILIENCE_POLICY: Required<AgentResiliencePolicy> = {
  onStepLimitReached: 'pause',
  onExecutionFailure: 'pause',
  maxRetries: 3,
  maxContinuations: 10,
  retryBackoff: 'exponential',
  preserveState: true,
};

/** Base delay for backoff calculations (milliseconds) */
export const BACKOFF_BASE_MS = 1000;

/** Maximum backoff delay cap (milliseconds) — 30 seconds */
export const BACKOFF_MAX_MS = 30_000;

/** Exponential base used in backoff calculations */
export const EXPONENTIAL_BASE = 2;

/** Cooldown window for the circuit breaker (milliseconds) — 5 minutes */
export const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000;

// =============================================================================
// Circuit Breaker
// =============================================================================

/**
 * Tracks agents that have recently exhausted their resilience limits.
 *
 * When an agent hits maxContinuations or maxRetries and is forced to pause,
 * the circuit breaker records a "trip". If the same agent is re-executed and
 * triggers resilience evaluation again within the cooldown window, the breaker
 * fires and forces an immediate pause — preventing tight re-execution loops
 * of broken agents.
 */
export class CircuitBreakerState {
  private trips = new Map<string, { tripCount: number; lastTrippedAt: number }>();

  /**
   * Record that an agent exhausted its resilience limits.
   * Increments the trip count and updates the timestamp.
   */
  trip(agentName: string): void {
    const existing = this.trips.get(agentName);
    this.trips.set(agentName, {
      tripCount: (existing?.tripCount ?? 0) + 1,
      lastTrippedAt: Date.now(),
    });
  }

  /**
   * Check whether an agent's circuit breaker is currently tripped.
   *
   * Returns true if the agent was tripped within the given cooldown window,
   * meaning it should be immediately paused rather than allowed to retry/continue.
   */
  isTripped(agentName: string, cooldownMs: number): boolean {
    const entry = this.trips.get(agentName);
    if (!entry) return false;
    return (Date.now() - entry.lastTrippedAt) < cooldownMs;
  }

  /**
   * Clear circuit breaker state for a specific agent.
   * Call this when an agent completes successfully to reset its breaker.
   */
  reset(agentName: string): void {
    this.trips.delete(agentName);
  }

  /**
   * Clear all circuit breaker state. Primarily for testing.
   */
  resetAll(): void {
    this.trips.clear();
  }

  /**
   * Get the trip record for an agent (read-only, for diagnostics).
   * Returns undefined if the agent has no trip history.
   */
  getState(agentName: string): { tripCount: number; lastTrippedAt: number } | undefined {
    const entry = this.trips.get(agentName);
    return entry ? { ...entry } : undefined;
  }
}

/** Singleton circuit breaker instance shared across all resilience evaluations */
export const circuitBreaker = new CircuitBreakerState();

// =============================================================================
// Resilience Context
// =============================================================================

/**
 * Context needed to evaluate a resilience decision.
 * Kept minimal — only what the evaluator needs.
 */
export interface ResilienceContext {
  /** What triggered the evaluation */
  trigger: 'step_limit' | 'execution_failure';
  /** Current continuation count for this execution chain */
  continuationCount: number;
  /** Current retry count for this specific step */
  retryCount: number;
  /** Step outcome that triggered the evaluation (for failure triggers) */
  stepOutcome?: 'success' | 'failure' | 'partial';
  /** Agent name for circuit breaker tracking (optional for backward compatibility) */
  agentName?: string;
}

// =============================================================================
// Evaluation Functions
// =============================================================================

/**
 * Evaluate a resilience policy given the trigger context.
 *
 * Returns a ResilienceAction describing what recovery action to take.
 * The action 'pause' means "do nothing special" (legacy behavior).
 */
export function evaluateResiliencePolicy(
  policy: AgentResiliencePolicy | undefined,
  context: ResilienceContext
): ResilienceAction {
  const resolved = resolvePolicy(policy);

  if (context.trigger === 'step_limit') {
    return evaluateStepLimitResilience(resolved, context);
  }

  return evaluateFailureResilience(resolved, context);
}

/**
 * Merge a partial policy with defaults to get a fully resolved policy.
 */
export function resolvePolicy(
  policy: AgentResiliencePolicy | undefined
): Required<AgentResiliencePolicy> {
  if (!policy) return { ...DEFAULT_RESILIENCE_POLICY };
  return { ...DEFAULT_RESILIENCE_POLICY, ...policy };
}

/**
 * Calculate backoff delay in milliseconds for a given retry count and strategy.
 *
 * @param strategy - The backoff strategy: 'none' (0ms), 'linear', or 'exponential'
 * @param retryCount - The current retry attempt number (0-based)
 * @param jitter - When true, multiplies the delay by a random factor between 0.5
 *   and 1.5 to decorrelate concurrent retries. The jittered result is still
 *   capped at BACKOFF_MAX_MS. Default: false.
 * @returns Backoff delay in milliseconds
 */
export function calculateBackoff(
  strategy: 'none' | 'linear' | 'exponential',
  retryCount: number,
  jitter: boolean = false
): number {
  let delay: number;

  switch (strategy) {
    case 'none':
      delay = 0;
      break;
    case 'linear':
      delay = Math.min(BACKOFF_BASE_MS * (retryCount + 1), BACKOFF_MAX_MS);
      break;
    case 'exponential':
      delay = Math.min(BACKOFF_BASE_MS * Math.pow(EXPONENTIAL_BASE, retryCount), BACKOFF_MAX_MS);
      break;
  }

  if (jitter && delay > 0) {
    const jitterFactor = 0.5 + Math.random(); // range [0.5, 1.5)
    delay = Math.min(Math.floor(delay * jitterFactor), BACKOFF_MAX_MS);
  }

  return delay;
}

// =============================================================================
// Internal Evaluation Logic
// =============================================================================

function evaluateStepLimitResilience(
  policy: Required<AgentResiliencePolicy>,
  context: ResilienceContext
): ResilienceAction {
  // Circuit breaker check — immediately pause if recently tripped
  if (context.agentName && circuitBreaker.isTripped(context.agentName, CIRCUIT_BREAKER_COOLDOWN_MS)) {
    return {
      action: 'pause',
      reason: 'Circuit breaker: agent recently exhausted resilience limits — forcing immediate pause to prevent re-execution loop',
      continuationCount: context.continuationCount,
      maxContinuations: policy.maxContinuations,
    };
  }

  const { onStepLimitReached, maxContinuations } = policy;

  // Default behavior — pause
  if (onStepLimitReached === 'pause') {
    return {
      action: 'pause',
      reason: 'Resilience policy: pause on step limit (default behavior)',
      continuationCount: context.continuationCount,
      maxContinuations,
    };
  }

  // Check continuation cap (0 = unlimited)
  if (maxContinuations > 0 && context.continuationCount >= maxContinuations) {
    // Trip the circuit breaker so re-execution within cooldown is blocked
    if (context.agentName) {
      circuitBreaker.trip(context.agentName);
    }
    return {
      action: 'pause',
      reason: `Resilience limit reached: ${context.continuationCount}/${maxContinuations} continuations exhausted`,
      continuationCount: context.continuationCount,
      maxContinuations,
    };
  }

  // Auto-continue or restart
  if (onStepLimitReached === 'continue') {
    return {
      action: 'continue',
      reason: `Auto-continuing: step limit reached, continuation ${context.continuationCount + 1}${maxContinuations > 0 ? `/${maxContinuations}` : ''}`,
      continuationCount: context.continuationCount + 1,
      maxContinuations,
    };
  }

  // restart
  return {
    action: 'restart',
    reason: `Auto-restarting: step limit reached, restart ${context.continuationCount + 1}${maxContinuations > 0 ? `/${maxContinuations}` : ''}`,
    continuationCount: context.continuationCount + 1,
    maxContinuations,
  };
}

function evaluateFailureResilience(
  policy: Required<AgentResiliencePolicy>,
  context: ResilienceContext
): ResilienceAction {
  // Circuit breaker check — immediately pause if recently tripped
  if (context.agentName && circuitBreaker.isTripped(context.agentName, CIRCUIT_BREAKER_COOLDOWN_MS)) {
    return {
      action: 'pause',
      reason: 'Circuit breaker: agent recently exhausted resilience limits — forcing immediate pause to prevent re-execution loop',
      retryCount: context.retryCount,
    };
  }

  const { onExecutionFailure, maxRetries, retryBackoff } = policy;

  // Default behavior — pause
  if (onExecutionFailure === 'pause') {
    return {
      action: 'pause',
      reason: 'Resilience policy: pause on execution failure (default behavior)',
      retryCount: context.retryCount,
    };
  }

  // retry
  if (onExecutionFailure === 'retry') {
    if (context.retryCount >= maxRetries) {
      // Trip the circuit breaker so re-execution within cooldown is blocked
      if (context.agentName) {
        circuitBreaker.trip(context.agentName);
      }
      return {
        action: 'pause',
        reason: `Retry limit reached: ${context.retryCount}/${maxRetries} retries exhausted`,
        retryCount: context.retryCount,
      };
    }

    const backoffMs = calculateBackoff(retryBackoff, context.retryCount);
    return {
      action: 'retry',
      reason: `Retrying failed step: attempt ${context.retryCount + 1}/${maxRetries}${backoffMs > 0 ? ` (backoff: ${backoffMs}ms)` : ''}`,
      backoffMs,
      retryCount: context.retryCount + 1,
    };
  }

  // restart-fresh — check continuation cap
  const { maxContinuations } = policy;
  if (maxContinuations > 0 && context.continuationCount >= maxContinuations) {
    // Trip the circuit breaker so re-execution within cooldown is blocked
    if (context.agentName) {
      circuitBreaker.trip(context.agentName);
    }
    return {
      action: 'pause',
      reason: `Resilience limit reached: ${context.continuationCount}/${maxContinuations} continuations exhausted`,
      continuationCount: context.continuationCount,
      maxContinuations,
    };
  }

  return {
    action: 'restart',
    reason: `Restarting fresh after failure: restart ${context.continuationCount + 1}${maxContinuations > 0 ? `/${maxContinuations}` : ''}`,
    continuationCount: context.continuationCount + 1,
    maxContinuations,
  };
}
