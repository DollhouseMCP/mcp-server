/**
 * Unit tests for InMemoryChallengeStore
 *
 * Verifies the adapter correctly delegates to VerificationStore.
 *
 * Issue #1945
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { InMemoryChallengeStore } from '../../../src/state/InMemoryChallengeStore.js';

describe('InMemoryChallengeStore', () => {
  let store: InMemoryChallengeStore;

  afterEach(() => {
    store?.destroy();
  });

  it('should set, get, and verify challenges', () => {
    store = new InMemoryChallengeStore(0);

    store.set('c1', { code: 'secret', expiresAt: Date.now() + 60000, reason: 'test' });
    expect(store.get('c1')?.code).toBe('secret');
    expect(store.size()).toBe(1);

    expect(store.verify('c1', 'secret')).toBe(true);
    expect(store.size()).toBe(0);
  });

  it('should return false for wrong code and delete challenge', () => {
    store = new InMemoryChallengeStore(0);

    store.set('c1', { code: 'secret', expiresAt: Date.now() + 60000, reason: 'test' });
    expect(store.verify('c1', 'wrong')).toBe(false);
    expect(store.get('c1')).toBeUndefined();
  });

  it('should auto-expire on get', () => {
    store = new InMemoryChallengeStore(0);

    store.set('c1', { code: 'test', expiresAt: Date.now() - 1, reason: 'expired' });
    expect(store.get('c1')).toBeUndefined();
  });

  it('should clear all challenges', () => {
    store = new InMemoryChallengeStore(0);

    store.set('c1', { code: 'a', expiresAt: Date.now() + 60000, reason: 'test' });
    store.set('c2', { code: 'b', expiresAt: Date.now() + 60000, reason: 'test' });

    store.clear();
    expect(store.size()).toBe(0);
  });

  it('should cleanup expired challenges', () => {
    store = new InMemoryChallengeStore(0);

    store.set('active', { code: 'a', expiresAt: Date.now() + 60000, reason: 'active' });
    store.set('expired', { code: 'b', expiresAt: Date.now() - 1, reason: 'expired' });

    store.cleanup();
    expect(store.size()).toBe(1);
  });
});
