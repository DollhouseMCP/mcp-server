import { describe, expect, it, jest } from '@jest/globals';

import { cacheProbe } from '../../../../src/web-console/setup/cachedProbe.js';

function setup(results: readonly (string | Error)[], ttlMs = 1000) {
  let clock = 0;
  let index = 0;
  const probe = jest.fn(() => {
    const next = results[Math.min(index++, results.length - 1)];
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  return { cached: cacheProbe(probe, ttlMs, () => clock), probe, advance: (ms: number) => { clock += ms; } };
}

describe('cacheProbe', () => {
  it('reuses a result until it is older than the limit, then runs again', async () => {
    const { cached, probe, advance } = setup(['first', 'second']);
    expect(await cached()).toBe('first');
    advance(999);
    expect(await cached()).toBe('first');
    expect(probe).toHaveBeenCalledTimes(1);
    advance(1);
    expect(await cached()).toBe('second');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('shares one run among callers that arrive while it is in flight', async () => {
    const { cached, probe } = setup(['only']);
    expect(await Promise.all([cached(), cached(), cached()])).toEqual(['only', 'only', 'only']);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('does not keep a run that throws, so the next caller tries again', async () => {
    const { cached, probe } = setup([new Error('boom'), 'recovered']);
    await expect(cached()).rejects.toThrow('boom');
    expect(await cached()).toBe('recovered');
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
