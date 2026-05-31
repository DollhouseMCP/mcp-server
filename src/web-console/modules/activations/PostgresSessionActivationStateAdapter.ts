import { and, asc, eq } from 'drizzle-orm';

import { withSystemContext } from '../../../database/admin.js';
import type { DatabaseInstance } from '../../../database/connection.js';
import {
  sessionActivationEvents,
  sessionActivationRecords,
} from '../../../database/schema/index.js';
import type { ConsoleActivatableElementType } from './ActivationTypes.js';
import type { ISessionActivationEventSink, SessionActivationChangedEvent } from './ActivationEvents.js';
import type {
  ISessionActivationStateAdapter,
  SessionActivationChangeResult,
  SessionActivationRecord,
} from './SessionActivationStateAdapter.js';

export class PostgresSessionActivationStateAdapter implements ISessionActivationStateAdapter {
  constructor(
    private readonly db: DatabaseInstance,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(sessionId: string): Promise<readonly SessionActivationRecord[]> {
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(sessionActivationRecords)
        .where(eq(sessionActivationRecords.sessionId, sessionId))
        .orderBy(asc(sessionActivationRecords.activatedAt), asc(sessionActivationRecords.elementType), asc(sessionActivationRecords.elementName)),
    );
    return rows.map(row => fromRecordRow(row));
  }

  async activate(
    sessionId: string,
    type: ConsoleActivatableElementType,
    name: string,
  ): Promise<SessionActivationChangeResult> {
    const activatedAt = this.now();
    const rows = await withSystemContext(this.db, tx =>
      tx.insert(sessionActivationRecords).values({
        sessionId,
        elementType: type,
        elementName: name,
        activatedAt,
      }).onConflictDoNothing({
        target: [
          sessionActivationRecords.sessionId,
          sessionActivationRecords.elementType,
          sessionActivationRecords.elementName,
        ],
      }).returning(),
    );
    if (rows[0]) {
      return {
        record: fromRecordRow(rows[0]),
        changed: true,
      };
    }
    const existing = await this.find(sessionId, type, name);
    return {
      record: existing ?? { type, name, activatedAt },
      changed: false,
    };
  }

  async deactivate(sessionId: string, type: ConsoleActivatableElementType, name: string): Promise<boolean> {
    const rows = await withSystemContext(this.db, tx =>
      tx.delete(sessionActivationRecords)
        .where(recordIdentity(sessionId, type, name))
        .returning({ sessionId: sessionActivationRecords.sessionId }),
    );
    return rows.length > 0;
  }

  private async find(
    sessionId: string,
    type: ConsoleActivatableElementType,
    name: string,
  ): Promise<SessionActivationRecord | null> {
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(sessionActivationRecords)
        .where(recordIdentity(sessionId, type, name))
        .limit(1),
    );
    return rows[0] ? fromRecordRow(rows[0]) : null;
  }
}

export class PostgresSessionActivationEventSink implements ISessionActivationEventSink {
  constructor(private readonly db: DatabaseInstance) {}

  async recordActivationChanged(event: SessionActivationChangedEvent): Promise<void> {
    await withSystemContext(this.db, tx =>
      tx.insert(sessionActivationEvents).values({
        userId: event.userId,
        sessionId: event.sessionId,
        elementType: event.elementType,
        elementName: event.elementName,
        action: event.action,
        occurredAt: event.occurredAt,
      }),
    );
  }
}

function recordIdentity(
  sessionId: string,
  type: ConsoleActivatableElementType,
  name: string,
) {
  return and(
    eq(sessionActivationRecords.sessionId, sessionId),
    eq(sessionActivationRecords.elementType, type),
    eq(sessionActivationRecords.elementName, name),
  );
}

function fromRecordRow(row: typeof sessionActivationRecords.$inferSelect): SessionActivationRecord {
  return {
    type: row.elementType,
    name: row.elementName,
    activatedAt: new Date(row.activatedAt),
  };
}
