import { describe, expect, it } from '@jest/globals';
import { ActivationSet } from '../../../src/state/ActivationSet.js';
import { PendingActivationDeletions } from '../../../src/state/PendingActivationDeletions.js';

const record = (name: string) => ({ name, activatedAt: '2026-10-21T00:00:00Z' });

describe('PendingActivationDeletions', () => {
  it('enrolls exact record objects only for the resolved locator and caller session', () => {
    const tracker = new PendingActivationDeletions();
    const session = new ActivationSet();
    const pending = tracker.begin(session, 'one.md');
    const otherSession = tracker.begin(new ActivationSet(), 'one.md');
    const otherLocator = tracker.begin(session, 'two.md');
    const accepted = record('alias');
    tracker.register(session, 'one.md', 'One', accepted);
    expect([...pending.activations.get('One')!]).toEqual([accepted]);
    expect([...pending.activations.get('One')!][0]).toBe(accepted);
    expect(otherSession.activations.size).toBe(0);
    expect(otherLocator.activations.size).toBe(0);
  });

  it('closes overlapping entries independently and excludes postcommit activation', () => {
    const tracker = new PendingActivationDeletions();
    const session = new ActivationSet();
    const first = tracker.begin(session, 'one.md');
    const second = tracker.begin(session, 'one.md');
    const before = record('before');
    tracker.register(session, 'one.md', 'One', before);
    first.settle();
    const after = record('after');
    tracker.register(session, 'one.md', 'One', after);
    expect([...first.activations.get('One')!]).toEqual([before]);
    expect([...second.activations.get('One')!]).toEqual([before, after]);
    second.settle();
    const next = tracker.begin(session, 'one.md');
    first.settle();
    second.settle();
    tracker.register(session, 'one.md', 'Recreated', after);
    expect([...next.activations.get('Recreated')!]).toEqual([after]);
  });
  it('captures exact live keys at commit and preserves later activations', () => {
    const tracker = new PendingActivationDeletions();
    const session = new ActivationSet();
    const pending = tracker.begin(session, 'persona.md');
    session.add('Console Persona');
    tracker.register(session, 'persona.md', 'Console Persona');
    const clear = pending.captureLive();
    pending.settle();
    session.add('Console Persona');
    expect(clear[0]()).toBe(false);
    expect(session.has('Console Persona')).toBe(true);
    const next = tracker.begin(session, 'persona.md');
    tracker.register(session, 'persona.md', 'Console Persona');
    expect(next.captureLive()[0]()).toBe(true);
    expect(session.size).toBe(0);
  });

  it('reports pending work only for its session until the last overlap settles', () => {
    const tracker = new PendingActivationDeletions();
    const session = new ActivationSet();
    const other = new ActivationSet();
    expect(tracker.hasPendingDeletions(session)).toBe(false);
    const first = tracker.begin(session, 'one.md');
    const second = tracker.begin(session, 'one.md');
    expect(tracker.hasPendingDeletions(session)).toBe(true);
    expect(tracker.hasPendingDeletions(other)).toBe(false);
    first.settle();
    expect(tracker.hasPendingDeletions(session)).toBe(true);
    second.settle();
    expect(tracker.hasPendingDeletions(session)).toBe(false);
  });

});
