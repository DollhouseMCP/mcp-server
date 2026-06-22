import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { DatabaseInstance } from '../../../database/connection.js';
import { withSystemContext } from '../../../database/admin.js';
import type { SessionActivityLevel } from '../../../database/schema/index.js';
import { sessionActivityEvents } from '../../../database/schema/index.js';
import type { UserActivityDto, UserActivityPageDto } from './SessionTelemetryDtos.js';

export interface ActivityQuery {
  readonly limit: number;
  readonly cursor: string | null;
  readonly level: string | null;
  readonly subsystem: string | null;
  readonly event: string | null;
}

export interface IOwnedActivityQuery {
  queryOwnedActivity(userId: string, sessionId: string, query: ActivityQuery): Promise<UserActivityPageDto>;
  streamOwnedActivity(userId: string, sessionId: string, query: ActivityQuery): AsyncIterable<UserActivityDto>;
}

export class InMemoryOwnedActivityQuery implements IOwnedActivityQuery {
  private readonly activity = new Map<string, readonly UserActivityDto[]>();

  constructor(options: {
    readonly activity?: Readonly<Record<string, readonly UserActivityDto[]>>;
  } = {}) {
    for (const [key, value] of Object.entries(options.activity ?? {})) {
      this.activity.set(key, value.map(item => ({ ...item })));
    }
  }

  seedOwnedActivity(userId: string, sessionId: string, activity: readonly UserActivityDto[]): void {
    this.activity.set(this.ownedActivityKey(userId, sessionId), activity.map(item => ({ ...item })));
  }

  queryOwnedActivity(userId: string, sessionId: string, query: ActivityQuery): Promise<UserActivityPageDto> {
    const itemsForSession = this.activity.get(this.ownedActivityKey(userId, sessionId)) ?? [];
    const filtered = itemsForSession.filter(item => matchesActivity(item, query));
    const start = query.cursor ? decodeCursor(query.cursor) : 0;
    const items = filtered.slice(start, start + query.limit).map(item => ({ ...item }));
    const next = start + items.length < filtered.length ? encodeCursor(start + items.length) : null;
    return Promise.resolve({
      items,
      page: {
        limit: query.limit,
        cursor: query.cursor,
        next_cursor: next,
      },
    });
  }

  async *streamOwnedActivity(
    userId: string,
    sessionId: string,
    query: ActivityQuery,
  ): AsyncIterable<UserActivityDto> {
    const page = await this.queryOwnedActivity(userId, sessionId, query);
    for (const item of page.items) yield item;
  }

  private ownedActivityKey(userId: string, sessionId: string): string {
    return `${userId}\u0000${sessionId}`;
  }
}

export class PostgresOwnedActivityQuery implements IOwnedActivityQuery {
  constructor(private readonly db: DatabaseInstance) {}

  async queryOwnedActivity(userId: string, sessionId: string, query: ActivityQuery): Promise<UserActivityPageDto> {
    const start = query.cursor ? decodeCursor(query.cursor) : 0;
    const rows = await withSystemContext(this.db, tx => tx
      .select({
        occurredAt: sessionActivityEvents.occurredAt,
        sessionId: sessionActivityEvents.sessionId,
        level: sessionActivityEvents.level,
        subsystem: sessionActivityEvents.subsystem,
        event: sessionActivityEvents.event,
        message: sessionActivityEvents.message,
        correlationId: sessionActivityEvents.correlationId,
        stableErrorCode: sessionActivityEvents.stableErrorCode,
      })
        .from(sessionActivityEvents)
        .where(and(...activityPredicates(userId, sessionId, query)))
        .orderBy(desc(sessionActivityEvents.occurredAt), desc(sessionActivityEvents.id))
        .limit(query.limit + 1)
        .offset(start));
    const pageRows = rows.slice(0, query.limit);
    return {
      items: pageRows.map(row => ({
        ts: toIso(row.occurredAt),
        session_id: row.sessionId,
        level: row.level,
        subsystem: row.subsystem,
        event: row.event,
        message: row.message,
        correlation_id: row.correlationId,
        stable_error_code: row.stableErrorCode,
      })),
      page: {
        limit: query.limit,
        cursor: query.cursor,
        next_cursor: rows.length > query.limit ? encodeCursor(start + query.limit) : null,
      },
    };
  }

  async *streamOwnedActivity(
    userId: string,
    sessionId: string,
    query: ActivityQuery,
  ): AsyncIterable<UserActivityDto> {
    const page = await this.queryOwnedActivity(userId, sessionId, query);
    for (const item of page.items) yield item;
  }
}

function matchesActivity(activity: UserActivityDto, query: ActivityQuery): boolean {
  return (!query.level || activity.level === query.level) &&
    (!query.subsystem || activity.subsystem === query.subsystem) &&
    (!query.event || activity.event === query.event);
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  const parsed = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function activityPredicates(userId: string, sessionId: string, query: ActivityQuery): SQL[] {
  const predicates: SQL[] = [
    eq(sessionActivityEvents.userId, userId),
    eq(sessionActivityEvents.sessionId, sessionId),
  ];
  if (query.level) predicates.push(eq(sessionActivityEvents.level, query.level as SessionActivityLevel));
  if (query.subsystem) predicates.push(eq(sessionActivityEvents.subsystem, query.subsystem));
  if (query.event) predicates.push(eq(sessionActivityEvents.event, query.event));
  return predicates;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
