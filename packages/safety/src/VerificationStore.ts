/**
 * Verification challenge storage
 *
 * Server-side storage for verification challenges. Challenges expire
 * after a configurable time period.
 *
 * @since v1.0.0
 */

import { StoredChallenge } from './types.js';

/**
 * In-memory verification store
 */
export class VerificationStore {
  private challenges = new Map<string, StoredChallenge>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(autoCleanupIntervalMs: number = 60000) {
    // Auto-cleanup expired challenges every minute by default
    if (autoCleanupIntervalMs > 0) {
      this.cleanupInterval = setInterval(() => {
        this.cleanup();
      }, autoCleanupIntervalMs);

      // Ensure cleanup interval doesn't prevent process exit
      if (this.cleanupInterval.unref) {
        this.cleanupInterval.unref();
      }
    }
  }

  /**
   * Store a verification challenge
   */
  set(challengeId: string, challenge: StoredChallenge): void {
    this.challenges.set(challengeId, challenge);
  }

  /**
   * Retrieve a verification challenge
   * Returns undefined if not found or expired
   */
  get(challengeId: string): StoredChallenge | undefined {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) {
      return undefined;
    }

    // Check if expired
    if (Date.now() > challenge.expiresAt) {
      this.challenges.delete(challengeId);
      return undefined;
    }

    return challenge;
  }

  /**
   * Verify a challenge code
   * Returns true if the code matches and hasn't expired
   */
  verify(challengeId: string, code: string): boolean {
    const challenge = this.get(challengeId);
    if (!challenge) {
      return false;
    }

    const matches = challenge.code === code;

    // Delete challenge after verification attempt (one-time use)
    this.challenges.delete(challengeId);

    return matches;
  }

  /**
   * Remove expired challenges
   */
  cleanup(): void {
    const now = Date.now();
    for (const [id, challenge] of this.challenges.entries()) {
      if (now > challenge.expiresAt) {
        this.challenges.delete(id);
      }
    }
  }

  /**
   * Clear all challenges (useful for testing)
   */
  clear(): void {
    this.challenges.clear();
  }

  /**
   * Get number of active challenges
   */
  size(): number {
    return this.challenges.size;
  }

  /**
   * Stop auto-cleanup interval
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}
