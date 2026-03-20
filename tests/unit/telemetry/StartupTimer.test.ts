/**
 * Unit tests for StartupTimer — Issue #706
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { StartupTimer } from '../../../src/telemetry/StartupTimer.js';

describe('StartupTimer', () => {
  let timer: StartupTimer;

  beforeEach(() => {
    timer = new StartupTimer();
  });

  it('should track phase timing', () => {
    timer.startPhase('test_phase', true);
    timer.endPhase('test_phase');

    const report = timer.getReport();
    expect(report.phases).toHaveLength(1);
    expect(report.phases[0].name).toBe('test_phase');
    expect(report.phases[0].critical).toBe(true);
    expect(report.phases[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should separate critical and deferred phases', () => {
    timer.startPhase('critical_1', true);
    timer.endPhase('critical_1');
    timer.startPhase('deferred_1', false);
    timer.endPhase('deferred_1');

    const report = timer.getReport();
    expect(report.phases).toHaveLength(2);
    expect(report.criticalPathMs).toBeGreaterThanOrEqual(0);
    expect(report.deferredMs).toBeGreaterThanOrEqual(0);
  });

  it('should accumulate durations for critical path', () => {
    timer.startPhase('a', true);
    timer.endPhase('a');
    timer.startPhase('b', true);
    timer.endPhase('b');

    const report = timer.getReport();
    const totalCritical = report.phases
      .filter(p => p.critical)
      .reduce((sum, p) => sum + p.durationMs, 0);
    expect(report.criticalPathMs).toBe(totalCritical);
  });

  it('should record connectAtMs via markConnect()', () => {
    expect(timer.getReport().connectAtMs).toBeNull();
    timer.markConnect();
    const report = timer.getReport();
    expect(report.connectAtMs).not.toBeNull();
    expect(report.connectAtMs).toBeGreaterThanOrEqual(0);
  });

  it('should be idempotent on endPhase()', () => {
    timer.startPhase('idempotent', true);
    timer.endPhase('idempotent');
    const firstDuration = timer.getReport().phases[0].durationMs;

    // Second endPhase should be a no-op
    timer.endPhase('idempotent');
    const secondDuration = timer.getReport().phases[0].durationMs;
    expect(secondDuration).toBe(firstDuration);
  });

  it('should no-op endPhase() for unknown phase', () => {
    timer.endPhase('nonexistent');
    expect(timer.getReport().phases).toHaveLength(0);
  });

  it('should auto-close un-ended phases in getReport()', () => {
    timer.startPhase('open', false);
    // Do NOT call endPhase

    const report = timer.getReport();
    expect(report.phases).toHaveLength(1);
    expect(report.phases[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should track totalMs from construction', () => {
    const report = timer.getReport();
    expect(report.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('should overwrite phase when startPhase is called twice with same name', () => {
    timer.startPhase('dup', true);
    timer.endPhase('dup');

    // Overwrite with a new start — replaces the entry
    timer.startPhase('dup', false);
    timer.endPhase('dup');

    const report = timer.getReport();
    // Map key is the same, so only 1 entry
    expect(report.phases).toHaveLength(1);
    // The overwritten phase should be deferred (false), not critical
    expect(report.phases[0].critical).toBe(false);
    expect(report.phases[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should return zero for criticalPathMs when no critical phases exist', () => {
    timer.startPhase('only_deferred', false);
    timer.endPhase('only_deferred');

    const report = timer.getReport();
    expect(report.criticalPathMs).toBe(0);
    expect(report.deferredMs).toBeGreaterThanOrEqual(0);
  });

  it('should handle multiple phases in order', () => {
    timer.startPhase('first', true);
    timer.endPhase('first');
    timer.startPhase('second', false);
    timer.endPhase('second');
    timer.startPhase('third', true);
    timer.endPhase('third');

    const report = timer.getReport();
    expect(report.phases).toHaveLength(3);
    expect(report.phases.map(p => p.name)).toEqual(['first', 'second', 'third']);
  });
});
