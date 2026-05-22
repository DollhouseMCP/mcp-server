import { describe, expect, it } from '@jest/globals';
import { InMemoryRateLimitStore } from '../../../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';

describe('InMemoryRateLimitStore', () => {
  it('updates state with version bumps and reset', async () => {
    const store = new InMemoryRateLimitStore();
    await store.update<{ count: number }>('scope', 'key', (prev) => ({
      state: { count: (prev?.count ?? 0) + 1 },
    }));
    await store.update<{ count: number }>('scope', 'key', (prev) => ({
      state: { count: (prev?.count ?? 0) + 1 },
    }));

    expect(await store.get<{ count: number }>('scope', 'key')).toEqual({
      state: { count: 2 },
      version: 2,
    });

    await store.reset('scope', 'key');
    expect(await store.get('scope', 'key')).toBeNull();
  });

  it('sweeps expired entries only', async () => {
    const store = new InMemoryRateLimitStore();
    await store.update('scope', 'expired', () => ({ state: { ok: false } }), { expiresAt: Date.now() - 1 });
    await store.update('scope', 'active', () => ({ state: { ok: true } }), { expiresAt: Date.now() + 60_000 });

    await store.sweep();

    expect(await store.get('scope', 'expired')).toBeNull();
    expect(await store.get('scope', 'active')).not.toBeNull();
  });
});
