import { describe, expect, it, jest } from '@jest/globals';
import { lt } from 'drizzle-orm';
import { sessionActivityEvents } from '../../../../src/database/schema/index.js';
import type { DatabaseInstance } from '../../../../src/database/connection.js';

const withSystemContextMock = jest.fn((db: unknown, cb: (tx: unknown) => unknown) => cb(db));
jest.unstable_mockModule('../../../../src/database/admin.js', () => ({
  withSystemContext: withSystemContextMock,
}));

const { PostgresConsoleSessionActivityStore } = await import(
  '../../../../src/web-console/stores/IConsoleSessionActivityStore.js'
);
const { PostgresPortfolioActivityEventSink } = await import(
  '../../../../src/web-console/modules/portfolio/PortfolioActivityEvents.js'
);

const NOW = new Date('2026-07-07T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const CONTENT_HASH = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const CORRELATION_ID = '22222222-2222-4222-8222-222222222222';

describe('PostgresConsoleSessionActivityStore.sweepExpired', () => {
  it('deletes rows strictly older than before-minus-retention and returns the removed count', async () => {
    let captured: { table?: unknown; predicate?: unknown } = {};
    const db = {
      delete: (table: unknown) => ({
        where: (predicate: unknown) => ({
          returning: () => {
            captured = { table, predicate };
            return Promise.resolve([{ id: '1' }, { id: '2' }]);
          },
        }),
      }),
    };
    const store = new PostgresConsoleSessionActivityStore(db as unknown as DatabaseInstance, 30 * DAY_MS);

    const removed = await store.sweepExpired(NOW);

    expect(removed).toBe(2);
    expect(captured.table).toBe(sessionActivityEvents);
    // Pins both the operator (strictly-less-than, not <=) and the cutoff math.
    expect(captured.predicate).toEqual(
      lt(sessionActivityEvents.occurredAt, new Date(NOW.getTime() - 30 * DAY_MS)),
    );
  });
});

describe('PostgresPortfolioActivityEventSink.recordElementDeleted', () => {
  it('inserts a metadata-only activity row carrying the hash, never the content', async () => {
    let inserted: { table?: unknown; row?: Record<string, unknown> } = {};
    const db = {
      insert: (table: unknown) => ({
        values: (row: Record<string, unknown>) => {
          inserted = { table, row };
          return Promise.resolve();
        },
      }),
    };
    const sink = new PostgresPortfolioActivityEventSink(db as unknown as DatabaseInstance);

    await sink.recordElementDeleted({
      type: 'console.portfolio.element.deleted.v1',
      userId: USER_ID,
      consoleSessionId: 'a'.repeat(64),
      elementType: 'skills',
      canonicalName: 'review-helper',
      contentHash: CONTENT_HASH,
      correlationId: CORRELATION_ID,
      occurredAt: NOW,
    });

    expect(inserted.table).toBe(sessionActivityEvents);
    expect(inserted.row).toMatchObject({
      userId: USER_ID,
      sessionId: 'a'.repeat(64),
      occurredAt: NOW,
      level: 'info',
      subsystem: 'portfolio',
      event: 'console.portfolio.element.deleted.v1',
      message: `Deleted skills/review-helper (sha256:${CONTENT_HASH})`,
      correlationId: CORRELATION_ID,
      stableErrorCode: null,
    });
    expect(JSON.stringify(inserted.row)).not.toContain('Owner private content');
  });
});
