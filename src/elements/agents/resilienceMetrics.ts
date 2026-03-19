/**
 * Resilience Metrics Tracker
 *
 * Provides observability into agent execution resilience actions:
 * auto-continuations past step limits, step retries, auto-restarts,
 * circuit breaker trips, and outcome tracking after resilience fires.
 *
 * Issue #526: Visibility into how often resilience actions fire and
 * whether they lead to successful completions.
 */

import { logger } from '../../utils/logger.js';

// ============================================================================
// Metrics snapshot interface
// ============================================================================

/**
 * Snapshot of resilience metrics counters.
 * Non-persisted, in-memory counters reset on server restart.
 */
export interface ResilienceMetricsSnapshot {
  /** Total auto-continuations triggered (agent continued past step limit) */
  autoContinuations: number;
  /** Total auto-restarts triggered (agent restarted after failure) */
  autoRestarts: number;
  /** Total step retries triggered (individual step retried after error) */
  stepRetries: number;
  /** Times maxContinuations/maxRetries exhausted, forcing a pause */
  resilienceLimitsReached: number;
  /** Times circuit breaker engaged (repeated failures tripped breaker) */
  circuitBreakerTrips: number;
  /** Executions that completed successfully after at least one resilience action */
  successAfterResilience: number;
  /** Executions that failed/aborted after at least one resilience action */
  failureAfterResilience: number;
}

// ============================================================================
// Metrics tracker
// ============================================================================

/**
 * Lightweight in-memory tracker for agent resilience patterns.
 * Issue #526: Provides observability into auto-continue, retry, and
 * circuit breaker behaviour during agent execution.
 */
export class ResilienceMetricsTracker {
  private _autoContinuations = 0;
  private _autoRestarts = 0;
  private _stepRetries = 0;
  private _resilienceLimitsReached = 0;
  private _circuitBreakerTrips = 0;
  private _successAfterResilience = 0;
  private _failureAfterResilience = 0;

  private static readonly LOG_INTERVAL = 25;

  recordAutoContinuation(): void {
    this._autoContinuations++;
    this.maybeLogSnapshot();
  }

  recordAutoRestart(): void {
    this._autoRestarts++;
    this.maybeLogSnapshot();
  }

  recordStepRetry(): void {
    this._stepRetries++;
    this.maybeLogSnapshot();
  }

  recordResilienceLimit(): void {
    this._resilienceLimitsReached++;
    this.maybeLogSnapshot();
  }

  recordCircuitBreakerTrip(): void {
    this._circuitBreakerTrips++;
    this.maybeLogSnapshot();
  }

  recordCompletionAfterResilience(success: boolean): void {
    if (success) {
      this._successAfterResilience++;
    } else {
      this._failureAfterResilience++;
    }
    this.maybeLogSnapshot();
  }

  getSnapshot(): ResilienceMetricsSnapshot {
    return {
      autoContinuations: this._autoContinuations,
      autoRestarts: this._autoRestarts,
      stepRetries: this._stepRetries,
      resilienceLimitsReached: this._resilienceLimitsReached,
      circuitBreakerTrips: this._circuitBreakerTrips,
      successAfterResilience: this._successAfterResilience,
      failureAfterResilience: this._failureAfterResilience,
    };
  }

  /** Reset all counters (for testing). */
  reset(): void {
    this._autoContinuations = 0;
    this._autoRestarts = 0;
    this._stepRetries = 0;
    this._resilienceLimitsReached = 0;
    this._circuitBreakerTrips = 0;
    this._successAfterResilience = 0;
    this._failureAfterResilience = 0;
  }

  private get _totalActions(): number {
    return (
      this._autoContinuations +
      this._autoRestarts +
      this._stepRetries +
      this._resilienceLimitsReached +
      this._circuitBreakerTrips
    );
  }

  private maybeLogSnapshot(): void {
    if (
      this._totalActions > 0 &&
      this._totalActions % ResilienceMetricsTracker.LOG_INTERVAL === 0
    ) {
      logger.info('Resilience metrics snapshot', {
        ...this.getSnapshot(),
      });
    }
  }
}

/** Module-level singleton instance (Issue #526) */
export const resilienceMetrics = new ResilienceMetricsTracker();

/**
 * Get the current resilience metrics snapshot.
 * Issue #526: Programmatic access for monitoring/diagnostics.
 */
export function getResilienceMetrics(): ResilienceMetricsSnapshot {
  return resilienceMetrics.getSnapshot();
}

/**
 * Reset resilience metrics (for testing only).
 * @internal
 */
export function resetResilienceMetrics(): void {
  resilienceMetrics.reset();
}
