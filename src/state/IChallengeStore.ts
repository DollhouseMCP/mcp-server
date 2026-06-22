/**
 * Challenge Store Interface
 *
 * Persistence contract for verification challenge state.
 * Each store instance is bound to a single session at construction.
 *
 * Matches the public surface of VerificationStore from @dollhousemcp/safety,
 * enabling a clean swap from in-memory to file-backed or database-backed
 * implementations without changing consumers.
 *
 * Implementations:
 * - InMemoryChallengeStore: Adapter wrapping VerificationStore (today's behavior)
 * - FileChallengeStore: JSON files in ~/.dollhouse/state/
 * - (Phase 4) DatabaseChallengeStore: PostgreSQL rows
 *
 * @since v2.1.0 — Issue #1945
 */

import type { StoredChallenge } from '@dollhousemcp/safety';

/**
 * Persistence-only contract for verification challenges.
 */
export interface IChallengeStore {
  /**
   * Load persisted challenges from the backing store.
   * No-op for in-memory implementations.
   */
  initialize?(): Promise<void>;

  /**
   * Store a verification challenge.
   * @param challengeId - Unique challenge identifier (UUID v4)
   * @param challenge - The challenge to store
   */
  set(challengeId: string, challenge: StoredChallenge): void;

  /**
   * Retrieve a verification challenge.
   * Returns undefined if not found or expired.
   * Auto-deletes expired entries on access.
   * @param challengeId - Unique challenge identifier
   */
  get(challengeId: string): StoredChallenge | undefined;

  /**
   * Verify a challenge code.
   * Returns true if the code matches and hasn't expired.
   * Deletes the challenge after verification attempt (one-time use).
   * @param challengeId - Unique challenge identifier
   * @param code - The verification code to check
   */
  verify(challengeId: string, code: string): boolean;

  /**
   * Remove all expired challenges.
   */
  cleanup(): void;

  /**
   * Clear all challenges.
   */
  clear(): void;

  /**
   * Get the number of active (non-expired) challenges.
   */
  size(): number;

  /**
   * Stop any background cleanup timers and release resources.
   */
  destroy(): void;
}
