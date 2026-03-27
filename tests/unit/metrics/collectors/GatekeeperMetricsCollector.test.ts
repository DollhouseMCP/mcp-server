import { describe, test, expect } from '@jest/globals';
import { GatekeeperMetricsCollector } from '../../../../src/metrics/collectors/GatekeeperMetricsCollector.js';
import { GatekeeperMetricsTracker } from '../../../../src/metrics/GatekeeperMetricsTracker.js';
import type { CounterEntry, GaugeEntry, MetricEntry } from '../../../../src/metrics/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findByName(entries: MetricEntry[], name: string): MetricEntry[] {
  return entries.filter(e => e.name === name);
}

function findOne(entries: MetricEntry[], name: string): MetricEntry {
  const matches = findByName(entries, name);
  expect(matches).toHaveLength(1);
  return matches[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GatekeeperMetricsCollector', () => {
  test('emits correct metric names with zero activity', () => {
    const tracker = new GatekeeperMetricsTracker();
    const collector = new GatekeeperMetricsCollector(tracker);
    const entries = collector.collect();

    const total = findOne(entries, 'gatekeeper.decisions_total') as CounterEntry;
    expect(total.value).toBe(0);
    expect(total.type).toBe('counter');

    const allowed = findOne(entries, 'gatekeeper.allowed_total') as CounterEntry;
    expect(allowed.value).toBe(0);

    const denied = findOne(entries, 'gatekeeper.denied_total') as CounterEntry;
    expect(denied.value).toBe(0);

    const confirmed = findOne(entries, 'gatekeeper.confirmations_requested_total') as CounterEntry;
    expect(confirmed.value).toBe(0);
  });

  test('counters reflect recorded decisions', () => {
    const tracker = new GatekeeperMetricsTracker();
    tracker.record({ allowed: true, permissionLevel: 'auto' });
    tracker.record({ allowed: false, permissionLevel: 'restricted', confirmationPending: true });
    tracker.record({ allowed: true, permissionLevel: 'elevated' });

    const collector = new GatekeeperMetricsCollector(tracker);
    const entries = collector.collect();

    expect((findOne(entries, 'gatekeeper.decisions_total') as CounterEntry).value).toBe(3);
    expect((findOne(entries, 'gatekeeper.allowed_total') as CounterEntry).value).toBe(2);
    expect((findOne(entries, 'gatekeeper.denied_total') as CounterEntry).value).toBe(1);
    expect((findOne(entries, 'gatekeeper.confirmations_requested_total') as CounterEntry).value).toBe(1);
  });

  test('emits per-policy-source gauges', () => {
    const tracker = new GatekeeperMetricsTracker();
    tracker.record({ allowed: true, permissionLevel: 'auto', policySource: 'default' });
    tracker.record({ allowed: true, permissionLevel: 'auto', policySource: 'default' });
    tracker.record({ allowed: false, permissionLevel: 'restricted', policySource: 'element' });

    const collector = new GatekeeperMetricsCollector(tracker);
    const entries = collector.collect();

    const sourceEntries = findByName(entries, 'gatekeeper.by_policy_source') as GaugeEntry[];
    expect(sourceEntries.length).toBe(2);

    const defaultSource = sourceEntries.find(e => e.labels?.['policy_source'] === 'default');
    expect(defaultSource?.value).toBe(2);

    const elementSource = sourceEntries.find(e => e.labels?.['policy_source'] === 'element');
    expect(elementSource?.value).toBe(1);
  });

  test('emits per-permission-level gauges', () => {
    const tracker = new GatekeeperMetricsTracker();
    tracker.record({ allowed: true, permissionLevel: 'auto', policySource: 'default' });
    tracker.record({ allowed: false, permissionLevel: 'restricted', policySource: 'element' });
    tracker.record({ allowed: true, permissionLevel: 'auto', policySource: 'default' });

    const collector = new GatekeeperMetricsCollector(tracker);
    const entries = collector.collect();

    const levelEntries = findByName(entries, 'gatekeeper.by_permission_level') as GaugeEntry[];
    expect(levelEntries.length).toBe(2);

    const autoLevel = levelEntries.find(e => e.labels?.['permission_level'] === 'auto');
    expect(autoLevel?.value).toBe(2);

    const restrictedLevel = levelEntries.find(e => e.labels?.['permission_level'] === 'restricted');
    expect(restrictedLevel?.value).toBe(1);
  });

  test('no per-source or per-level gauges when tracker has zero decisions', () => {
    const tracker = new GatekeeperMetricsTracker();
    const collector = new GatekeeperMetricsCollector(tracker);
    const entries = collector.collect();

    // Only the 4 base counters, no dynamic gauges
    expect(entries).toHaveLength(4);
  });

  test('returns empty array when tracker throws', () => {
    const brokenTracker = {
      getMetrics: (): never => { throw new Error('broken'); },
    } as unknown as GatekeeperMetricsTracker;

    const collector = new GatekeeperMetricsCollector(brokenTracker);
    expect(collector.collect()).toEqual([]);
  });

  test('collector name and description are set', () => {
    const tracker = new GatekeeperMetricsTracker();
    const collector = new GatekeeperMetricsCollector(tracker);
    expect(collector.name).toBe('gatekeeper-metrics');
    expect(collector.description).toBeTruthy();
  });
});
