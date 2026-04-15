/**
 * In-Memory Challenge Store
 *
 * Adapter wrapping the existing VerificationStore from @dollhousemcp/safety.
 * Preserves today's in-memory behavior without modifying the external package.
 *
 * This is the default IChallengeStore implementation. Use FileChallengeStore
 * or DatabaseChallengeStore for persistence across restarts.
 *
 * @since v2.1.0 — Issue #1945
 */

import { VerificationStore } from '@dollhousemcp/safety';
import type { StoredChallenge } from '@dollhousemcp/safety';
import type { IChallengeStore } from './IChallengeStore.js';

export class InMemoryChallengeStore implements IChallengeStore {
  private readonly inner: VerificationStore;

  constructor(autoCleanupIntervalMs?: number) {
    this.inner = new VerificationStore(autoCleanupIntervalMs);
  }

  set(challengeId: string, challenge: StoredChallenge): void {
    this.inner.set(challengeId, challenge);
  }

  get(challengeId: string): StoredChallenge | undefined {
    return this.inner.get(challengeId);
  }

  verify(challengeId: string, code: string): boolean {
    return this.inner.verify(challengeId, code);
  }

  cleanup(): void {
    this.inner.cleanup();
  }

  clear(): void {
    this.inner.clear();
  }

  size(): number {
    return this.inner.size();
  }

  destroy(): void {
    this.inner.destroy();
  }
}
