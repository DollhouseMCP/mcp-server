import { describe, test, expect, beforeEach } from '@jest/globals';
import { MemoryLogSink } from '../../../../src/logging/sinks/MemoryLogSink.js';
import type { UnifiedLogEntry } from '../../../../src/logging/types.js';

function makeEntry(overrides: Partial<UnifiedLogEntry> = {}): UnifiedLogEntry {
  return {
    id: 'LOG-1234-0',
    timestamp: '2026-02-10T15:30:00.000Z',
    category: 'application',
    level: 'info',
    source: 'TestSource',
    message: 'Test message',
    ...overrides,
  };
}

function createSink(capacities: Partial<{
  appCapacity: number;
  securityCapacity: number;
  perfCapacity: number;
  telemetryCapacity: number;
}> = {}): MemoryLogSink {
  return new MemoryLogSink({
    appCapacity: capacities.appCapacity ?? 100,
    securityCapacity: capacities.securityCapacity ?? 100,
    perfCapacity: capacities.perfCapacity ?? 100,
    telemetryCapacity: capacities.telemetryCapacity ?? 100,
  });
}

describe('MemoryLogSink', () => {
  let sink: MemoryLogSink;

  beforeEach(() => {
    sink = createSink();
  });

  // -----------------------------------------------------------------------
  // ILogSink contract
  // -----------------------------------------------------------------------

  describe('ILogSink contract', () => {
    test('write() routes entries to the correct per-category queue', () => {
      sink.write(makeEntry({ category: 'application' }));
      sink.write(makeEntry({ category: 'security' }));
      sink.write(makeEntry({ category: 'performance' }));
      sink.write(makeEntry({ category: 'telemetry' }));

      const stats = sink.getStats();
      expect(stats.application.size).toBe(1);
      expect(stats.security.size).toBe(1);
      expect(stats.performance.size).toBe(1);
      expect(stats.telemetry.size).toBe(1);
    });

    test('flush() resolves without error and does not clear entries', async () => {
      sink.write(makeEntry());
      await expect(sink.flush()).resolves.toBeUndefined();
      expect(sink.getStats().application.size).toBe(1);
    });

    test('close() clears all queues', async () => {
      sink.write(makeEntry({ category: 'application' }));
      sink.write(makeEntry({ category: 'security' }));
      await sink.close();

      const stats = sink.getStats();
      expect(stats.application.size).toBe(0);
      expect(stats.security.size).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Eviction
  // -----------------------------------------------------------------------

  describe('eviction', () => {
    test('oldest entries are evicted when queue exceeds capacity', () => {
      const small = createSink({ appCapacity: 3 });
      for (let i = 0; i < 5; i++) {
        small.write(makeEntry({ id: `LOG-${i}`, category: 'application' }));
      }

      const result = small.query({ category: 'application' });
      expect(result.total).toBe(3);
      // Oldest (LOG-0, LOG-1) should be gone; newest first in result
      const ids = result.entries.map(e => e.id);
      expect(ids).not.toContain('LOG-0');
      expect(ids).not.toContain('LOG-1');
      expect(ids).toContain('LOG-2');
      expect(ids).toContain('LOG-3');
      expect(ids).toContain('LOG-4');
    });

    test('eviction in one category does not affect others', () => {
      const small = createSink({ appCapacity: 2, securityCapacity: 100 });
      for (let i = 0; i < 5; i++) {
        small.write(makeEntry({ id: `APP-${i}`, category: 'application' }));
        small.write(makeEntry({ id: `SEC-${i}`, category: 'security' }));
      }

      expect(small.getStats().application.size).toBe(2);
      expect(small.getStats().security.size).toBe(5);
    });
  });

  // -----------------------------------------------------------------------
  // Query filtering
  // -----------------------------------------------------------------------

  describe('query filtering', () => {
    test('category=all returns entries from all categories', () => {
      sink.write(makeEntry({ category: 'application' }));
      sink.write(makeEntry({ category: 'security' }));

      const result = sink.query({ category: 'all' });
      expect(result.total).toBe(2);
    });

    test('no options returns all entries (default category=all)', () => {
      sink.write(makeEntry({ category: 'application' }));
      sink.write(makeEntry({ category: 'security' }));

      const result = sink.query();
      expect(result.total).toBe(2);
    });

    test('specific category returns only that category', () => {
      sink.write(makeEntry({ category: 'application' }));
      sink.write(makeEntry({ category: 'security' }));

      const result = sink.query({ category: 'security' });
      expect(result.total).toBe(1);
      expect(result.entries[0].category).toBe('security');
    });

    test('level filter returns entries at or above specified level', () => {
      sink.write(makeEntry({ level: 'debug', id: 'D' }));
      sink.write(makeEntry({ level: 'info', id: 'I' }));
      sink.write(makeEntry({ level: 'warn', id: 'W' }));
      sink.write(makeEntry({ level: 'error', id: 'E' }));

      const result = sink.query({ level: 'warn' });
      expect(result.total).toBe(2);
      const ids = result.entries.map(e => e.id);
      expect(ids).toContain('W');
      expect(ids).toContain('E');
    });

    test('source filter is case-insensitive substring match', () => {
      sink.write(makeEntry({ source: 'PersonaManager', id: 'PM' }));
      sink.write(makeEntry({ source: 'AgentManager', id: 'AM' }));
      sink.write(makeEntry({ source: 'TemplateManager', id: 'TM' }));

      const result = sink.query({ source: 'manager' });
      expect(result.total).toBe(3);

      const result2 = sink.query({ source: 'PERSONA' });
      expect(result2.total).toBe(1);
      expect(result2.entries[0].id).toBe('PM');
    });

    test('message filter is case-insensitive substring match', () => {
      sink.write(makeEntry({ message: 'Cache miss for persona', id: 'A' }));
      sink.write(makeEntry({ message: 'Portfolio synced', id: 'B' }));

      const result = sink.query({ message: 'cache' });
      expect(result.total).toBe(1);
      expect(result.entries[0].id).toBe('A');
    });

    test('since filter returns entries strictly after the timestamp', () => {
      sink.write(makeEntry({ timestamp: '2026-02-10T10:00:00.000Z', id: 'A' }));
      sink.write(makeEntry({ timestamp: '2026-02-10T12:00:00.000Z', id: 'B' }));
      sink.write(makeEntry({ timestamp: '2026-02-10T14:00:00.000Z', id: 'C' }));

      const result = sink.query({ since: '2026-02-10T12:00:00.000Z' });
      expect(result.total).toBe(1);
      expect(result.entries[0].id).toBe('C');
    });

    test('until filter returns entries strictly before the timestamp', () => {
      sink.write(makeEntry({ timestamp: '2026-02-10T10:00:00.000Z', id: 'A' }));
      sink.write(makeEntry({ timestamp: '2026-02-10T12:00:00.000Z', id: 'B' }));
      sink.write(makeEntry({ timestamp: '2026-02-10T14:00:00.000Z', id: 'C' }));

      const result = sink.query({ until: '2026-02-10T12:00:00.000Z' });
      expect(result.total).toBe(1);
      expect(result.entries[0].id).toBe('A');
    });

    test('correlationId filter returns only matching entries', () => {
      sink.write(makeEntry({ id: 'A', correlationId: 'REQ-123' }));
      sink.write(makeEntry({ id: 'B', correlationId: 'REQ-456' }));
      sink.write(makeEntry({ id: 'C', correlationId: 'REQ-123' }));
      sink.write(makeEntry({ id: 'D' })); // no correlationId

      const result = sink.query({ correlationId: 'REQ-123' });
      expect(result.total).toBe(2);
      const ids = result.entries.map(e => e.id);
      expect(ids).toContain('A');
      expect(ids).toContain('C');
      expect(ids).not.toContain('B');
      expect(ids).not.toContain('D');
    });

    test('correlationId filter combined with other filters', () => {
      sink.write(makeEntry({ id: 'A', correlationId: 'REQ-123', level: 'error' }));
      sink.write(makeEntry({ id: 'B', correlationId: 'REQ-123', level: 'info' }));
      sink.write(makeEntry({ id: 'C', correlationId: 'REQ-456', level: 'error' }));

      const result = sink.query({ correlationId: 'REQ-123', level: 'error' });
      expect(result.total).toBe(1);
      expect(result.entries[0].id).toBe('A');
    });

    test('multiple filters applied conjunctively (AND)', () => {
      sink.write(makeEntry({ level: 'error', source: 'PersonaManager', message: 'Load failed', id: 'A' }));
      sink.write(makeEntry({ level: 'error', source: 'AgentManager', message: 'Load failed', id: 'B' }));
      sink.write(makeEntry({ level: 'info', source: 'PersonaManager', message: 'Load succeeded', id: 'C' }));

      const result = sink.query({ level: 'error', source: 'persona', message: 'failed' });
      expect(result.total).toBe(1);
      expect(result.entries[0].id).toBe('A');
    });
  });

  // -----------------------------------------------------------------------
  // Pagination
  // -----------------------------------------------------------------------

  describe('pagination', () => {
    beforeEach(() => {
      for (let i = 0; i < 10; i++) {
        sink.write(makeEntry({
          id: `LOG-${i}`,
          timestamp: `2026-02-10T${String(i).padStart(2, '0')}:00:00.000Z`,
        }));
      }
    });

    test('limit defaults to 50', () => {
      const result = sink.query();
      expect(result.limit).toBe(50);
    });

    test('limit is clamped to [1, 10000]', () => {
      expect(sink.query({ limit: 0 }).limit).toBe(1);
      expect(sink.query({ limit: -5 }).limit).toBe(1);
      expect(sink.query({ limit: 20000 }).limit).toBe(10000);
    });

    test('offset defaults to 0', () => {
      const result = sink.query();
      expect(result.offset).toBe(0);
    });

    test('offset clamped to >= 0', () => {
      const result = sink.query({ offset: -3 });
      expect(result.offset).toBe(0);
    });

    test('limit and offset paginate correctly', () => {
      const page1 = sink.query({ limit: 3, offset: 0 });
      expect(page1.entries).toHaveLength(3);
      expect(page1.total).toBe(10);
      expect(page1.hasMore).toBe(true);

      const page2 = sink.query({ limit: 3, offset: 3 });
      expect(page2.entries).toHaveLength(3);
      expect(page2.hasMore).toBe(true);

      const lastPage = sink.query({ limit: 3, offset: 9 });
      expect(lastPage.entries).toHaveLength(1);
      expect(lastPage.hasMore).toBe(false);
    });

    test('hasMore correctly reflects remaining entries', () => {
      const exact = sink.query({ limit: 10 });
      expect(exact.hasMore).toBe(false);

      const under = sink.query({ limit: 9 });
      expect(under.hasMore).toBe(true);
    });

    test('offset beyond total returns empty entries with correct total', () => {
      const result = sink.query({ offset: 100 });
      expect(result.entries).toHaveLength(0);
      expect(result.total).toBe(10);
      expect(result.hasMore).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Sort order
  // -----------------------------------------------------------------------

  describe('sort order', () => {
    test('results returned newest-first', () => {
      sink.write(makeEntry({ timestamp: '2026-02-10T01:00:00.000Z', id: 'OLD' }));
      sink.write(makeEntry({ timestamp: '2026-02-10T03:00:00.000Z', id: 'NEW' }));
      sink.write(makeEntry({ timestamp: '2026-02-10T02:00:00.000Z', id: 'MID' }));

      const result = sink.query();
      expect(result.entries.map(e => e.id)).toEqual(['NEW', 'MID', 'OLD']);
    });

    test('multi-category query merges and sorts correctly', () => {
      sink.write(makeEntry({ timestamp: '2026-02-10T01:00:00.000Z', category: 'application', id: 'A1' }));
      sink.write(makeEntry({ timestamp: '2026-02-10T03:00:00.000Z', category: 'security', id: 'S1' }));
      sink.write(makeEntry({ timestamp: '2026-02-10T02:00:00.000Z', category: 'performance', id: 'P1' }));

      const result = sink.query({ category: 'all' });
      expect(result.entries.map(e => e.id)).toEqual(['S1', 'P1', 'A1']);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    test('empty sink returns zero results', () => {
      const result = sink.query();
      expect(result.entries).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    test('entries with identical timestamps are both included', () => {
      const ts = '2026-02-10T12:00:00.000Z';
      sink.write(makeEntry({ timestamp: ts, id: 'A' }));
      sink.write(makeEntry({ timestamp: ts, id: 'B' }));

      const result = sink.query();
      expect(result.total).toBe(2);
      expect(result.entries).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // getStats()
  // -----------------------------------------------------------------------

  describe('getStats()', () => {
    test('returns size and capacity for each category', () => {
      const s = createSink({ appCapacity: 50, securityCapacity: 200, perfCapacity: 75, telemetryCapacity: 30 });
      s.write(makeEntry({ category: 'application' }));
      s.write(makeEntry({ category: 'application' }));
      s.write(makeEntry({ category: 'security' }));

      const stats = s.getStats();
      expect(stats.application).toEqual({ size: 2, capacity: 50, evictions: 0 });
      expect(stats.security).toEqual({ size: 1, capacity: 200, evictions: 0 });
      expect(stats.performance).toEqual({ size: 0, capacity: 75, evictions: 0 });
      expect(stats.telemetry).toEqual({ size: 0, capacity: 30, evictions: 0 });
    });
  });
});
