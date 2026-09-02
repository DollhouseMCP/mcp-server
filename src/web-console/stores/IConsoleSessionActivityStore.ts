import { lt } from 'drizzle-orm';
import { sessionActivityEvents } from '../../database/schema/index.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { withSystemContext } from '../../database/admin.js';

/**
 * Retention sweeper for `session_activity_events`. The table has no per-row expiry, so
 * rows are pruned by age relative to the sweep time. This bounds an otherwise unbounded,
 * PII-bearing (message) telemetry table — the cascade on user deletion cannot be relied on
 * because account deletion is anonymize-tombstone, so the row is never actually removed.
 */
export const DEFAULT_SESSION_ACTIVITY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface IConsoleSessionActivityStore {
  /** Delete activity rows older than the retention window relative to `before`. Returns rows removed. */
  sweepExpired(before: Date): Promise<number>;
}

export class InMemoryConsoleSessionActivityStore implements IConsoleSessionActivityStore {
  private readonly rows: { readonly userId: string; readonly occurredAt: Date }[] = [];

  constructor(private readonly retentionMs: number = DEFAULT_SESSION_ACTIVITY_RETENTION_MS) {}

  seed(userId: string, occurredAt: Date): void {
    this.rows.push({ userId, occurredAt });
  }

  size(): number {
    return this.rows.length;
  }

  sweepExpired(before: Date): Promise<number> {
    const cutoff = before.getTime() - this.retentionMs;
    const kept = this.rows.filter(row => row.occurredAt.getTime() >= cutoff);
    const removed = this.rows.length - kept.length;
    this.rows.length = 0;
    this.rows.push(...kept);
    return Promise.resolve(removed);
  }
}

export class PostgresConsoleSessionActivityStore implements IConsoleSessionActivityStore {
  constructor(
    private readonly db: DatabaseInstance,
    private readonly retentionMs: number = DEFAULT_SESSION_ACTIVITY_RETENTION_MS,
  ) {}

  async sweepExpired(before: Date): Promise<number> {
    const cutoff = new Date(before.getTime() - this.retentionMs);
    const rows = await withSystemContext(this.db, tx =>
      tx.delete(sessionActivityEvents)
        .where(lt(sessionActivityEvents.occurredAt, cutoff))
        .returning({ id: sessionActivityEvents.id }),
    );
    return rows.length;
  }
}
