import { sessionActivityEvents } from '../../../database/schema/index.js';
import type { DatabaseInstance } from '../../../database/connection.js';
import { withSystemContext } from '../../../database/admin.js';
import type { ConsolePortfolioElementType } from '../../stores/IPortfolioElementStore.js';

/**
 * Metadata-only record that a portfolio element was deleted through the console.
 * Console portfolio deletion is an intentional hard delete (it mirrors the canonical
 * `delete_element` semantics — see PortfolioService.deleteElement), so this event is the
 * forensic trail of what was removed. It carries the element's `contentHash`, never its
 * content, so no user-authored content is retained.
 */
export interface PortfolioElementDeletedEvent {
  readonly type: 'console.portfolio.element.deleted.v1';
  readonly userId: string;
  /** Stable, non-PII per-console-session handle (hex of the session id hash). */
  readonly consoleSessionId: string;
  readonly elementType: ConsolePortfolioElementType;
  readonly canonicalName: string;
  /**
   * The deleted element's SHA-256 content digest (64 lowercase hex), or null. The activity message
   * renders it with a `sha256:` prefix, so a store that changes the digest algorithm must update
   * {@link portfolioDeletionActivityMessage} accordingly.
   */
  readonly contentHash: string | null;
  readonly correlationId: string | null;
  readonly occurredAt: Date;
}

export interface IPortfolioActivityEventSink {
  recordElementDeleted(event: PortfolioElementDeletedEvent): Promise<void>;
}

/**
 * Metadata-only, content-free summary line for the activity log. `contentHash` is the portfolio
 * store's SHA-256 hex digest (validated as 64 lowercase hex), so the `sha256:` prefix is accurate.
 */
export function portfolioDeletionActivityMessage(event: PortfolioElementDeletedEvent): string {
  const target = `${event.elementType}/${event.canonicalName}`;
  return event.contentHash ? `Deleted ${target} (sha256:${event.contentHash})` : `Deleted ${target}`;
}

export class InMemoryPortfolioActivityEventSink implements IPortfolioActivityEventSink {
  private readonly events: PortfolioElementDeletedEvent[] = [];

  recordElementDeleted(event: PortfolioElementDeletedEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }

  listEvents(): readonly PortfolioElementDeletedEvent[] {
    return [...this.events];
  }
}

export class PostgresPortfolioActivityEventSink implements IPortfolioActivityEventSink {
  constructor(private readonly db: DatabaseInstance) {}

  async recordElementDeleted(event: PortfolioElementDeletedEvent): Promise<void> {
    await withSystemContext(this.db, async (tx) => {
      await tx.insert(sessionActivityEvents).values({
        userId: event.userId,
        sessionId: event.consoleSessionId,
        occurredAt: event.occurredAt,
        level: 'info',
        subsystem: 'portfolio',
        event: event.type,
        message: portfolioDeletionActivityMessage(event),
        correlationId: event.correlationId,
        stableErrorCode: null,
      });
    });
  }
}
