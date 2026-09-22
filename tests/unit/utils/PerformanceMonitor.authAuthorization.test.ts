import { afterEach, describe, expect, it } from '@jest/globals';
import { PerformanceMonitor } from '../../../src/utils/PerformanceMonitor.js';

describe('PerformanceMonitor authorization outcome counters', () => {
  const monitors: PerformanceMonitor[] = [];

  afterEach(() => {
    for (const monitor of monitors) monitor.dispose();
    monitors.length = 0;
  });

  it('reports a defensible terminal-event denominator and fixed failure buckets', () => {
    const monitor = new PerformanceMonitor();
    monitors.push(monitor);
    monitor.startMonitoring();

    monitor.recordAuthAuthorizationFailure('no_scope_granted');
    monitor.recordAuthAuthorizationFailure('end_user_denied');

    expect(monitor.getAuthAuthorizationFailureStats()).toEqual({
      failureCount: 2,
      failuresByReason: {
        no_scope_granted: 1,
        end_user_denied: 1,
        oauth_error: 0,
        server_error: 0,
      },
    });
  });

  it('does not record outcomes while monitoring is stopped and reset clears counters', () => {
    const monitor = new PerformanceMonitor();
    monitors.push(monitor);
    monitor.recordAuthAuthorizationFailure('server_error');
    expect(monitor.getAuthAuthorizationFailureStats().failureCount).toBe(0);

    monitor.startMonitoring();
    monitor.recordAuthAuthorizationFailure('oauth_error');
    monitor.reset();
    expect(monitor.getAuthAuthorizationFailureStats().failureCount).toBe(0);
  });
});
