import { describe, expect, it } from '@jest/globals';

import { InMemoryConsoleSessionActivityStore } from '../../../../src/web-console/stores/IConsoleSessionActivityStore.js';

const NOW = new Date('2026-07-07T12:00:00.000Z');
const USER = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const DAY_MS = 24 * 60 * 60 * 1000;

describe('InMemoryConsoleSessionActivityStore', () => {
  it('sweeps rows older than the retention window and keeps newer ones', async () => {
    const store = new InMemoryConsoleSessionActivityStore(30 * DAY_MS);
    store.seed(USER, new Date(NOW.getTime() - 40 * DAY_MS));
    store.seed(USER, new Date(NOW.getTime() - 31 * DAY_MS));
    store.seed(USER, new Date(NOW.getTime() - 10 * DAY_MS));
    store.seed(USER, NOW);

    const removed = await store.sweepExpired(NOW);

    expect(removed).toBe(2);
    expect(store.size()).toBe(2);
  });

  it('keeps rows exactly at the retention boundary', async () => {
    const store = new InMemoryConsoleSessionActivityStore(30 * DAY_MS);
    store.seed(USER, new Date(NOW.getTime() - 30 * DAY_MS));

    const removed = await store.sweepExpired(NOW);

    expect(removed).toBe(0);
    expect(store.size()).toBe(1);
  });
});
