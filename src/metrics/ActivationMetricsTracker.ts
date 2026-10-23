import type { UserIdResolver } from '../database/UserContext.js';
import { logger } from '../utils/logger.js';

export const MAX_RETAINED_ACTIVATION_WARNINGS = 4096;

/** Root-container lifetime, shared by all HTTP sessions. No session keys. */
export class ActivationMetricsTracker {
  private readonly warned = new Set<string>();
  private retainedTotal = 0;

  constructor(private readonly resolveUserId: UserIdResolver) {}

  retain(elementType: string, reference: string): string {
    const userId = this.resolveUserId();
    const key = JSON.stringify([userId, elementType, reference]);
    const notice = `Retained stale ${elementType} reference ${JSON.stringify(reference)}. ` +
      'Explicitly deactivate that exact reference to clear it.';
    if (!this.warned.has(key)) {
      // Oldest-first eviction bounds deduplication. An evicted key may warn/count again.
      if (this.warned.size >= MAX_RETAINED_ACTIVATION_WARNINGS) {
        const oldest = this.warned.values().next().value;
        if (oldest !== undefined) this.warned.delete(oldest);
      }
      this.warned.add(key);
      this.retainedTotal++;
      logger.warn('[Activation] Retained stale activation reference; explicitly deactivate the exact reference to clear it.',
        { userId, elementType, reference });
    }
    return notice;
  }

  /** Explicit deactivation/deletion starts a new warning lifetime for this key. */
  forget(elementType: string, reference: string): void {
    this.warned.delete(JSON.stringify([this.resolveUserId(), elementType, reference]));
  }

  getMetrics(): number {
    return this.retainedTotal;
  }
}
