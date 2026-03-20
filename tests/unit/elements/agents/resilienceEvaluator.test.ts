/**
 * Unit tests for Resilience Evaluator
 *
 * Tests the pure evaluation logic for agent resilience policies.
 * Part of Issue #526 (Agent Execution Resilience).
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  evaluateResiliencePolicy,
  resolvePolicy,
  calculateBackoff,
  DEFAULT_RESILIENCE_POLICY,
  CircuitBreakerState,
  circuitBreaker,
  CIRCUIT_BREAKER_COOLDOWN_MS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  EXPONENTIAL_BASE,
} from '../../../../src/elements/agents/resilienceEvaluator.js';
import type { AgentResiliencePolicy } from '../../../../src/elements/agents/types.js';
import type { ResilienceContext } from '../../../../src/elements/agents/resilienceEvaluator.js';

describe('resilienceEvaluator', () => {

  beforeEach(() => {
    // Reset singleton circuit breaker between tests
    circuitBreaker.resetAll();
  });

  // ==========================================================================
  // resolvePolicy
  // ==========================================================================

  describe('resolvePolicy', () => {
    it('returns defaults when policy is undefined', () => {
      const resolved = resolvePolicy(undefined);
      expect(resolved).toEqual(DEFAULT_RESILIENCE_POLICY);
    });

    it('merges partial policy with defaults', () => {
      const partial: AgentResiliencePolicy = { onStepLimitReached: 'continue' };
      const resolved = resolvePolicy(partial);
      expect(resolved.onStepLimitReached).toBe('continue');
      expect(resolved.onExecutionFailure).toBe('pause');
      expect(resolved.maxRetries).toBe(3);
      expect(resolved.maxContinuations).toBe(10);
      expect(resolved.retryBackoff).toBe('exponential');
      expect(resolved.preserveState).toBe(true);
    });

    it('preserves all provided fields', () => {
      const full: AgentResiliencePolicy = {
        onStepLimitReached: 'restart',
        onExecutionFailure: 'retry',
        maxRetries: 5,
        maxContinuations: 20,
        retryBackoff: 'linear',
        preserveState: false,
      };
      const resolved = resolvePolicy(full);
      expect(resolved).toEqual(full);
    });
  });

  // ==========================================================================
  // calculateBackoff
  // ==========================================================================

  describe('calculateBackoff', () => {
    it('returns 0 for "none" strategy', () => {
      expect(calculateBackoff('none', 0)).toBe(0);
      expect(calculateBackoff('none', 5)).toBe(0);
      expect(calculateBackoff('none', 100)).toBe(0);
    });

    it('calculates linear backoff', () => {
      expect(calculateBackoff('linear', 0)).toBe(1000);
      expect(calculateBackoff('linear', 1)).toBe(2000);
      expect(calculateBackoff('linear', 2)).toBe(3000);
    });

    it('caps linear backoff at 30 seconds', () => {
      expect(calculateBackoff('linear', 100)).toBe(30_000);
    });

    it('calculates exponential backoff', () => {
      expect(calculateBackoff('exponential', 0)).toBe(1000);
      expect(calculateBackoff('exponential', 1)).toBe(2000);
      expect(calculateBackoff('exponential', 2)).toBe(4000);
      expect(calculateBackoff('exponential', 3)).toBe(8000);
    });

    it('caps exponential backoff at 30 seconds', () => {
      expect(calculateBackoff('exponential', 10)).toBe(30_000);
    });
  });

  // ==========================================================================
  // evaluateResiliencePolicy — step limit trigger
  // ==========================================================================

  describe('step limit resilience', () => {
    const stepLimitContext: ResilienceContext = {
      trigger: 'step_limit',
      continuationCount: 0,
      retryCount: 0,
    };

    it('returns pause when policy is undefined (default behavior)', () => {
      const result = evaluateResiliencePolicy(undefined, stepLimitContext);
      expect(result.action).toBe('pause');
    });

    it('returns pause when onStepLimitReached is "pause"', () => {
      const result = evaluateResiliencePolicy(
        { onStepLimitReached: 'pause' },
        stepLimitContext
      );
      expect(result.action).toBe('pause');
    });

    it('returns continue when onStepLimitReached is "continue"', () => {
      const result = evaluateResiliencePolicy(
        { onStepLimitReached: 'continue' },
        stepLimitContext
      );
      expect(result.action).toBe('continue');
      expect(result.continuationCount).toBe(1);
    });

    it('returns restart when onStepLimitReached is "restart"', () => {
      const result = evaluateResiliencePolicy(
        { onStepLimitReached: 'restart' },
        stepLimitContext
      );
      expect(result.action).toBe('restart');
      expect(result.continuationCount).toBe(1);
    });

    it('pauses when maxContinuations is reached', () => {
      const result = evaluateResiliencePolicy(
        { onStepLimitReached: 'continue', maxContinuations: 5 },
        { ...stepLimitContext, continuationCount: 5 }
      );
      expect(result.action).toBe('pause');
      expect(result.reason).toContain('5/5');
      expect(result.reason).toContain('exhausted');
    });

    it('allows unlimited continuations when maxContinuations is 0', () => {
      const result = evaluateResiliencePolicy(
        { onStepLimitReached: 'continue', maxContinuations: 0 },
        { ...stepLimitContext, continuationCount: 100 }
      );
      expect(result.action).toBe('continue');
      expect(result.continuationCount).toBe(101);
    });

    it('includes continuation count in reason', () => {
      const result = evaluateResiliencePolicy(
        { onStepLimitReached: 'continue', maxContinuations: 10 },
        { ...stepLimitContext, continuationCount: 3 }
      );
      expect(result.action).toBe('continue');
      expect(result.reason).toContain('4/10');
    });

    it('increments continuation count correctly for restart', () => {
      const result = evaluateResiliencePolicy(
        { onStepLimitReached: 'restart', maxContinuations: 10 },
        { ...stepLimitContext, continuationCount: 7 }
      );
      expect(result.action).toBe('restart');
      expect(result.continuationCount).toBe(8);
      expect(result.maxContinuations).toBe(10);
    });
  });

  // ==========================================================================
  // evaluateResiliencePolicy — execution failure trigger
  // ==========================================================================

  describe('execution failure resilience', () => {
    const failureContext: ResilienceContext = {
      trigger: 'execution_failure',
      continuationCount: 0,
      retryCount: 0,
      stepOutcome: 'failure',
    };

    it('returns pause when policy is undefined (default behavior)', () => {
      const result = evaluateResiliencePolicy(undefined, failureContext);
      expect(result.action).toBe('pause');
    });

    it('returns pause when onExecutionFailure is "pause"', () => {
      const result = evaluateResiliencePolicy(
        { onExecutionFailure: 'pause' },
        failureContext
      );
      expect(result.action).toBe('pause');
    });

    it('returns retry with backoff when onExecutionFailure is "retry"', () => {
      const result = evaluateResiliencePolicy(
        { onExecutionFailure: 'retry' },
        failureContext
      );
      expect(result.action).toBe('retry');
      expect(result.retryCount).toBe(1);
      expect(result.backoffMs).toBe(1000); // exponential, attempt 0
    });

    it('increases backoff on subsequent retries', () => {
      const result = evaluateResiliencePolicy(
        { onExecutionFailure: 'retry', retryBackoff: 'exponential' },
        { ...failureContext, retryCount: 2 }
      );
      expect(result.action).toBe('retry');
      expect(result.backoffMs).toBe(4000); // 1000 * 2^2
      expect(result.retryCount).toBe(3);
    });

    it('pauses when maxRetries is reached', () => {
      const result = evaluateResiliencePolicy(
        { onExecutionFailure: 'retry', maxRetries: 3 },
        { ...failureContext, retryCount: 3 }
      );
      expect(result.action).toBe('pause');
      expect(result.reason).toContain('3/3');
      expect(result.reason).toContain('exhausted');
    });

    it('uses linear backoff when configured', () => {
      const result = evaluateResiliencePolicy(
        { onExecutionFailure: 'retry', retryBackoff: 'linear' },
        { ...failureContext, retryCount: 2 }
      );
      expect(result.backoffMs).toBe(3000); // 1000 * (2+1)
    });

    it('uses no backoff when configured', () => {
      const result = evaluateResiliencePolicy(
        { onExecutionFailure: 'retry', retryBackoff: 'none' },
        { ...failureContext, retryCount: 2 }
      );
      expect(result.backoffMs).toBe(0);
    });

    it('returns restart for "restart-fresh"', () => {
      const result = evaluateResiliencePolicy(
        { onExecutionFailure: 'restart-fresh' },
        failureContext
      );
      expect(result.action).toBe('restart');
      expect(result.continuationCount).toBe(1);
    });

    it('pauses restart-fresh when maxContinuations reached', () => {
      const result = evaluateResiliencePolicy(
        { onExecutionFailure: 'restart-fresh', maxContinuations: 3 },
        { ...failureContext, continuationCount: 3 }
      );
      expect(result.action).toBe('pause');
      expect(result.reason).toContain('exhausted');
    });
  });

  // ==========================================================================
  // DEFAULT_RESILIENCE_POLICY
  // ==========================================================================

  describe('DEFAULT_RESILIENCE_POLICY', () => {
    it('has all fields set to safe defaults', () => {
      expect(DEFAULT_RESILIENCE_POLICY).toEqual({
        onStepLimitReached: 'pause',
        onExecutionFailure: 'pause',
        maxRetries: 3,
        maxContinuations: 10,
        retryBackoff: 'exponential',
        preserveState: true,
      });
    });

    it('results in pause for all triggers when used as-is', () => {
      const stepResult = evaluateResiliencePolicy(DEFAULT_RESILIENCE_POLICY, {
        trigger: 'step_limit',
        continuationCount: 0,
        retryCount: 0,
      });
      expect(stepResult.action).toBe('pause');

      const failResult = evaluateResiliencePolicy(DEFAULT_RESILIENCE_POLICY, {
        trigger: 'execution_failure',
        continuationCount: 0,
        retryCount: 0,
      });
      expect(failResult.action).toBe('pause');
    });
  });

  // ==========================================================================
  // calculateBackoff — jitter
  // ==========================================================================

  describe('calculateBackoff with jitter', () => {
    it('returns 0 for "none" strategy even with jitter', () => {
      expect(calculateBackoff('none', 0, true)).toBe(0);
    });

    it('applies jitter to linear backoff within expected range', () => {
      // Run multiple times to verify jitter varies the result
      const results = new Set<number>();
      for (let i = 0; i < 20; i++) {
        results.add(calculateBackoff('linear', 1, true));
      }
      // Linear retry 1 = 2000ms base. Jitter range: [1000, 3000)
      for (const r of results) {
        expect(r).toBeGreaterThanOrEqual(BACKOFF_BASE_MS); // 2000 * 0.5
        expect(r).toBeLessThanOrEqual(BACKOFF_MAX_MS);
      }
    });

    it('applies jitter to exponential backoff within expected range', () => {
      const results = new Set<number>();
      for (let i = 0; i < 20; i++) {
        results.add(calculateBackoff('exponential', 2, true));
      }
      // Exponential retry 2 = 4000ms base. Jitter range: [2000, 6000)
      for (const r of results) {
        expect(r).toBeGreaterThanOrEqual(BACKOFF_BASE_MS * Math.pow(EXPONENTIAL_BASE, 2) * 0.5);
        expect(r).toBeLessThanOrEqual(BACKOFF_MAX_MS);
      }
    });

    it('caps jittered backoff at BACKOFF_MAX_MS', () => {
      // High retry count → base delay already at cap → jitter can't exceed cap
      const result = calculateBackoff('exponential', 20, true);
      expect(result).toBeLessThanOrEqual(BACKOFF_MAX_MS);
    });
  });

  // ==========================================================================
  // CircuitBreakerState
  // ==========================================================================

  describe('CircuitBreakerState', () => {
    let breaker: CircuitBreakerState;

    beforeEach(() => {
      breaker = new CircuitBreakerState();
    });

    it('reports not tripped for unknown agent', () => {
      expect(breaker.isTripped('unknown-agent', 60_000)).toBe(false);
    });

    it('reports tripped after trip() within cooldown', () => {
      breaker.trip('test-agent');
      expect(breaker.isTripped('test-agent', 60_000)).toBe(true);
    });

    it('reports not tripped after cooldown expires', () => {
      breaker.trip('test-agent');
      // Simulate time passing by checking with 0ms cooldown
      expect(breaker.isTripped('test-agent', 0)).toBe(false);
    });

    it('increments trip count on repeated trips', () => {
      breaker.trip('test-agent');
      breaker.trip('test-agent');
      breaker.trip('test-agent');
      const state = breaker.getState('test-agent');
      expect(state?.tripCount).toBe(3);
    });

    it('resets a specific agent', () => {
      breaker.trip('agent-a');
      breaker.trip('agent-b');
      breaker.reset('agent-a');
      expect(breaker.isTripped('agent-a', 60_000)).toBe(false);
      expect(breaker.isTripped('agent-b', 60_000)).toBe(true);
    });

    it('resetAll clears all agents', () => {
      breaker.trip('agent-a');
      breaker.trip('agent-b');
      breaker.resetAll();
      expect(breaker.isTripped('agent-a', 60_000)).toBe(false);
      expect(breaker.isTripped('agent-b', 60_000)).toBe(false);
    });

    it('getState returns undefined for unknown agent', () => {
      expect(breaker.getState('unknown')).toBeUndefined();
    });

    it('getState returns a defensive copy', () => {
      breaker.trip('test-agent');
      const state1 = breaker.getState('test-agent');
      const state2 = breaker.getState('test-agent');
      expect(state1).toEqual(state2);
      expect(state1).not.toBe(state2); // Different object references
    });
  });

  // ==========================================================================
  // Circuit breaker integration with evaluateResiliencePolicy
  // ==========================================================================

  describe('circuit breaker in evaluateResiliencePolicy', () => {
    it('forces pause when circuit breaker is tripped for step limit', () => {
      circuitBreaker.trip('looping-agent');
      const result = evaluateResiliencePolicy(
        { onStepLimitReached: 'continue', maxContinuations: 100 },
        { trigger: 'step_limit', continuationCount: 0, retryCount: 0, agentName: 'looping-agent' }
      );
      expect(result.action).toBe('pause');
      expect(result.reason).toContain('Circuit breaker');
    });

    it('forces pause when circuit breaker is tripped for failure', () => {
      circuitBreaker.trip('failing-agent');
      const result = evaluateResiliencePolicy(
        { onExecutionFailure: 'retry', maxRetries: 10 },
        { trigger: 'execution_failure', continuationCount: 0, retryCount: 0, agentName: 'failing-agent' }
      );
      expect(result.action).toBe('pause');
      expect(result.reason).toContain('Circuit breaker');
    });

    it('does not trip circuit breaker when agentName is not provided', () => {
      // Without agentName, circuit breaker check is skipped (backward compat)
      circuitBreaker.trip('some-agent');
      const result = evaluateResiliencePolicy(
        { onStepLimitReached: 'continue', maxContinuations: 100 },
        { trigger: 'step_limit', continuationCount: 0, retryCount: 0 }
      );
      expect(result.action).toBe('continue');
    });

    it('trips circuit breaker when maxContinuations exhausted', () => {
      const result = evaluateResiliencePolicy(
        { onStepLimitReached: 'continue', maxContinuations: 5 },
        { trigger: 'step_limit', continuationCount: 5, retryCount: 0, agentName: 'capped-agent' }
      );
      expect(result.action).toBe('pause');
      // Verify the breaker was tripped
      expect(circuitBreaker.isTripped('capped-agent', CIRCUIT_BREAKER_COOLDOWN_MS)).toBe(true);
    });

    it('trips circuit breaker when maxRetries exhausted', () => {
      const result = evaluateResiliencePolicy(
        { onExecutionFailure: 'retry', maxRetries: 3 },
        { trigger: 'execution_failure', continuationCount: 0, retryCount: 3, agentName: 'retry-agent' }
      );
      expect(result.action).toBe('pause');
      expect(circuitBreaker.isTripped('retry-agent', CIRCUIT_BREAKER_COOLDOWN_MS)).toBe(true);
    });

    it('allows normal operation when breaker is not tripped', () => {
      const result = evaluateResiliencePolicy(
        { onStepLimitReached: 'continue', maxContinuations: 10 },
        { trigger: 'step_limit', continuationCount: 0, retryCount: 0, agentName: 'healthy-agent' }
      );
      expect(result.action).toBe('continue');
    });
  });

  // ==========================================================================
  // Constants
  // ==========================================================================

  describe('constants', () => {
    it('exports expected constant values', () => {
      expect(BACKOFF_BASE_MS).toBe(1000);
      expect(BACKOFF_MAX_MS).toBe(30_000);
      expect(EXPONENTIAL_BASE).toBe(2);
      expect(CIRCUIT_BREAKER_COOLDOWN_MS).toBe(5 * 60 * 1000);
    });
  });
});
