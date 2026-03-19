/**
 * Unit tests for Resilience Metrics Tracker
 *
 * Tests the in-memory metrics collection for agent resilience patterns.
 * Part of Issue #526 (Agent Execution Resilience).
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  ResilienceMetricsTracker,
  resilienceMetrics,
  getResilienceMetrics,
  resetResilienceMetrics,
} from '../../../../src/elements/agents/resilienceMetrics.js';

describe('ResilienceMetricsTracker', () => {
  let tracker: ResilienceMetricsTracker;

  beforeEach(() => {
    tracker = new ResilienceMetricsTracker();
  });

  // ==========================================================================
  // Initial state
  // ==========================================================================

  it('starts with all counters at zero', () => {
    const snapshot = tracker.getSnapshot();
    expect(snapshot).toEqual({
      autoContinuations: 0,
      autoRestarts: 0,
      stepRetries: 0,
      resilienceLimitsReached: 0,
      circuitBreakerTrips: 0,
      successAfterResilience: 0,
      failureAfterResilience: 0,
    });
  });

  // ==========================================================================
  // Recording individual metrics
  // ==========================================================================

  describe('recording metrics', () => {
    it('records auto-continuations', () => {
      tracker.recordAutoContinuation();
      tracker.recordAutoContinuation();
      expect(tracker.getSnapshot().autoContinuations).toBe(2);
    });

    it('records auto-restarts', () => {
      tracker.recordAutoRestart();
      expect(tracker.getSnapshot().autoRestarts).toBe(1);
    });

    it('records step retries', () => {
      tracker.recordStepRetry();
      tracker.recordStepRetry();
      tracker.recordStepRetry();
      expect(tracker.getSnapshot().stepRetries).toBe(3);
    });

    it('records resilience limits reached', () => {
      tracker.recordResilienceLimit();
      expect(tracker.getSnapshot().resilienceLimitsReached).toBe(1);
    });

    it('records circuit breaker trips', () => {
      tracker.recordCircuitBreakerTrip();
      tracker.recordCircuitBreakerTrip();
      expect(tracker.getSnapshot().circuitBreakerTrips).toBe(2);
    });

    it('records success after resilience', () => {
      tracker.recordCompletionAfterResilience(true);
      expect(tracker.getSnapshot().successAfterResilience).toBe(1);
      expect(tracker.getSnapshot().failureAfterResilience).toBe(0);
    });

    it('records failure after resilience', () => {
      tracker.recordCompletionAfterResilience(false);
      expect(tracker.getSnapshot().successAfterResilience).toBe(0);
      expect(tracker.getSnapshot().failureAfterResilience).toBe(1);
    });
  });

  // ==========================================================================
  // Reset
  // ==========================================================================

  describe('reset', () => {
    it('clears all counters', () => {
      tracker.recordAutoContinuation();
      tracker.recordAutoRestart();
      tracker.recordStepRetry();
      tracker.recordResilienceLimit();
      tracker.recordCircuitBreakerTrip();
      tracker.recordCompletionAfterResilience(true);
      tracker.recordCompletionAfterResilience(false);

      tracker.reset();

      const snapshot = tracker.getSnapshot();
      expect(snapshot.autoContinuations).toBe(0);
      expect(snapshot.autoRestarts).toBe(0);
      expect(snapshot.stepRetries).toBe(0);
      expect(snapshot.resilienceLimitsReached).toBe(0);
      expect(snapshot.circuitBreakerTrips).toBe(0);
      expect(snapshot.successAfterResilience).toBe(0);
      expect(snapshot.failureAfterResilience).toBe(0);
    });
  });

  // ==========================================================================
  // Snapshot immutability
  // ==========================================================================

  describe('snapshot immutability', () => {
    it('returns a new snapshot object each time', () => {
      const snap1 = tracker.getSnapshot();
      const snap2 = tracker.getSnapshot();
      expect(snap1).toEqual(snap2);
      expect(snap1).not.toBe(snap2);
    });

    it('snapshot is not affected by subsequent recordings', () => {
      tracker.recordAutoContinuation();
      const snap = tracker.getSnapshot();
      tracker.recordAutoContinuation();
      expect(snap.autoContinuations).toBe(1);
      expect(tracker.getSnapshot().autoContinuations).toBe(2);
    });
  });

  // ==========================================================================
  // Module-level exports
  // ==========================================================================

  describe('module-level exports', () => {
    beforeEach(() => {
      resetResilienceMetrics();
    });

    it('getResilienceMetrics returns singleton snapshot', () => {
      const snapshot = getResilienceMetrics();
      expect(snapshot.autoContinuations).toBe(0);
    });

    it('resetResilienceMetrics clears singleton', () => {
      resilienceMetrics.recordAutoContinuation();
      expect(getResilienceMetrics().autoContinuations).toBe(1);
      resetResilienceMetrics();
      expect(getResilienceMetrics().autoContinuations).toBe(0);
    });

    it('resilienceMetrics singleton is the same instance', () => {
      resilienceMetrics.recordStepRetry();
      expect(getResilienceMetrics().stepRetries).toBe(1);
    });
  });
});
