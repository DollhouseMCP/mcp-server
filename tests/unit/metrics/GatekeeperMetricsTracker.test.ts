import { describe, test, expect } from '@jest/globals';
import { GatekeeperMetricsTracker } from '../../../src/metrics/GatekeeperMetricsTracker.js';

describe('GatekeeperMetricsTracker', () => {
  test('starts with zero counts', () => {
    const tracker = new GatekeeperMetricsTracker();
    const m = tracker.getMetrics();
    expect(m.totalDecisions).toBe(0);
    expect(m.allowed).toBe(0);
    expect(m.denied).toBe(0);
    expect(m.confirmationsPending).toBe(0);
    expect(m.byPolicySource.size).toBe(0);
    expect(m.byPermissionLevel.size).toBe(0);
  });

  test('records an allowed decision', () => {
    const tracker = new GatekeeperMetricsTracker();
    tracker.record({ allowed: true, permissionLevel: 'auto' });
    const m = tracker.getMetrics();
    expect(m.totalDecisions).toBe(1);
    expect(m.allowed).toBe(1);
    expect(m.denied).toBe(0);
  });

  test('records a denied decision', () => {
    const tracker = new GatekeeperMetricsTracker();
    tracker.record({ allowed: false, permissionLevel: 'restricted' });
    const m = tracker.getMetrics();
    expect(m.totalDecisions).toBe(1);
    expect(m.allowed).toBe(0);
    expect(m.denied).toBe(1);
  });

  test('tracks confirmation pending separately from allowed/denied', () => {
    const tracker = new GatekeeperMetricsTracker();
    // A denied decision that requires confirmation
    tracker.record({ allowed: false, permissionLevel: 'elevated', confirmationPending: true });
    // An allowed decision with no confirmation
    tracker.record({ allowed: true, permissionLevel: 'auto', confirmationPending: false });
    const m = tracker.getMetrics();
    expect(m.totalDecisions).toBe(2);
    expect(m.confirmationsPending).toBe(1);
  });

  test('confirmationPending undefined does not increment counter', () => {
    const tracker = new GatekeeperMetricsTracker();
    tracker.record({ allowed: true, permissionLevel: 'auto' });
    expect(tracker.getMetrics().confirmationsPending).toBe(0);
  });

  test('aggregates by policy source', () => {
    const tracker = new GatekeeperMetricsTracker();
    tracker.record({ allowed: true, permissionLevel: 'auto', policySource: 'default' });
    tracker.record({ allowed: true, permissionLevel: 'auto', policySource: 'default' });
    tracker.record({ allowed: false, permissionLevel: 'restricted', policySource: 'element' });
    const m = tracker.getMetrics();
    expect(m.byPolicySource.get('default')).toBe(2);
    expect(m.byPolicySource.get('element')).toBe(1);
  });

  test('missing policySource defaults to "unknown"', () => {
    const tracker = new GatekeeperMetricsTracker();
    tracker.record({ allowed: true, permissionLevel: 'auto' });
    expect(tracker.getMetrics().byPolicySource.get('unknown')).toBe(1);
  });

  test('aggregates by permission level', () => {
    const tracker = new GatekeeperMetricsTracker();
    tracker.record({ allowed: true, permissionLevel: 'auto' });
    tracker.record({ allowed: true, permissionLevel: 'auto' });
    tracker.record({ allowed: false, permissionLevel: 'restricted' });
    tracker.record({ allowed: true, permissionLevel: 'elevated' });
    const m = tracker.getMetrics();
    expect(m.byPermissionLevel.get('auto')).toBe(2);
    expect(m.byPermissionLevel.get('restricted')).toBe(1);
    expect(m.byPermissionLevel.get('elevated')).toBe(1);
  });

  test('getMetrics returns defensive copies of maps', () => {
    const tracker = new GatekeeperMetricsTracker();
    tracker.record({ allowed: true, permissionLevel: 'auto', policySource: 'default' });
    const m1 = tracker.getMetrics();
    m1.byPolicySource.set('injected', 999);
    m1.byPermissionLevel.set('injected', 999);
    const m2 = tracker.getMetrics();
    expect(m2.byPolicySource.has('injected')).toBe(false);
    expect(m2.byPermissionLevel.has('injected')).toBe(false);
  });

  test('mixed sequence of decisions accumulates correctly', () => {
    const tracker = new GatekeeperMetricsTracker();
    tracker.record({ allowed: true, permissionLevel: 'auto', policySource: 'default' });
    tracker.record({ allowed: false, permissionLevel: 'restricted', policySource: 'element', confirmationPending: true });
    tracker.record({ allowed: true, permissionLevel: 'elevated', policySource: 'default' });
    tracker.record({ allowed: false, permissionLevel: 'restricted', policySource: 'element' });
    tracker.record({ allowed: true, permissionLevel: 'auto', policySource: 'default', confirmationPending: true });

    const m = tracker.getMetrics();
    expect(m.totalDecisions).toBe(5);
    expect(m.allowed).toBe(3);
    expect(m.denied).toBe(2);
    expect(m.confirmationsPending).toBe(2);
    expect(m.byPolicySource.get('default')).toBe(3);
    expect(m.byPolicySource.get('element')).toBe(2);
    expect(m.byPermissionLevel.get('auto')).toBe(2);
    expect(m.byPermissionLevel.get('restricted')).toBe(2);
    expect(m.byPermissionLevel.get('elevated')).toBe(1);
  });
});
