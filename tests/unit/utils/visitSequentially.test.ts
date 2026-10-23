import { describe, expect, it } from '@jest/globals';
import { visitSequentially } from '../../../src/utils/visitSequentially.js';

describe('visitSequentially', () => {
  it('preserves live membership and order across a suspended visit', async () => {
    const values = new Set(['first', 'removed']);
    const visited: string[] = [];
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const pending = visitSequentially(values.values(), async value => {
      visited.push(value);
      await barrier;
    });
    expect(visited).toEqual(['first']);
    values.delete('removed');
    values.add('added');
    release();
    await pending;
    expect(visited).toEqual(['first', 'added']);
  });

  it('stops on rejection and preserves the thrown value', async () => {
    const failure = { reason: 'opaque failure' };
    const iterator = [1, 2].values();
    await expect(visitSequentially(iterator, async () => { throw failure; })).rejects.toBe(failure);
    expect(iterator.next().value).toBe(2);
  });
});
