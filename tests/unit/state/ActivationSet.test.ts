import { describe, expect, it } from '@jest/globals';
import { ActivationSet } from '../../../src/state/ActivationSet.js';

describe('ActivationSet deletion lifetime', () => {
  it('preserves a newer activation, including reactivation of an existing key', () => {
    const active = new ActivationSet();
    active.add('P');
    const clear = active.captureDeletion('P');
    active.add('P');
    expect(clear()).toBe(false);
    expect(active.has('P')).toBe(true);
  });

  it('handles delete and recreate without retaining inactive keys', () => {
    const active = new ActivationSet();
    active.add('P');
    const clear = active.captureDeletion('P');
    active.delete('P');
    active.add('P');
    expect(clear()).toBe(false);
    active.clear();
    expect(clear()).toBe(true);
    active.add('P');
    expect(clear()).toBe(false);
  });

  it('clears only the captured key and does not cross sessions', () => {
    const first = new ActivationSet();
    const second = new ActivationSet();
    first.add('P').add('Q');
    second.add('P');
    const clear = first.captureDeletion('P');
    second.add('P');
    expect(clear()).toBe(true);
    expect([...first]).toEqual(['Q']);
    expect([...second]).toEqual(['P']);
  });

  it('preserves live Set iteration across mutations', () => {
    const active = new ActivationSet();
    active.add('P').add('Q');
    const iterator = active.values();
    expect(iterator.next().value).toBe('P');
    active.delete('Q');
    active.add('R');
    expect(iterator.next().value).toBe('R');
    expect(iterator.next().done).toBe(true);
  });
});
