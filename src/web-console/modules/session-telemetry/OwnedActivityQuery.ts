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
