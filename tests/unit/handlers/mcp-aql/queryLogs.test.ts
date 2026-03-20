/**
 * Unit tests for CRUDE-routed query_logs operation (Issue #528)
 *
 * Tests the migration of query_logs from standalone LogTools into the
 * unified CRUDE pipeline: OperationRouter → OperationPolicies → MCPAQLHandler dispatch.
 */

import { describe, it, expect } from '@jest/globals';
import {
  OPERATION_ROUTES,
  getRoute,
} from '../../../../src/handlers/mcp-aql/OperationRouter.js';
import {
  getDefaultPermissionLevel,
} from '../../../../src/handlers/mcp-aql/policies/OperationPolicies.js';
import { PermissionLevel } from '../../../../src/handlers/mcp-aql/GatekeeperTypes.js';
import { MemoryLogSink } from '../../../../src/logging/sinks/MemoryLogSink.js';
import type { UnifiedLogEntry } from '../../../../src/logging/types.js';

function makeEntry(overrides: Partial<UnifiedLogEntry> = {}): UnifiedLogEntry {
  return {
    id: `LOG-${Date.now()}-${Math.random()}`,
    timestamp: new Date().toISOString(),
    category: 'application',
    level: 'info',
    source: 'TestSource',
    message: 'test message',
    ...overrides,
  };
}

describe('query_logs CRUDE migration (Issue #528)', () => {
  describe('OperationRouter', () => {
    it('should route query_logs to READ endpoint', () => {
      const route = getRoute('query_logs');
      expect(route).toBeDefined();
      expect(route!.endpoint).toBe('READ');
    });

    it('should route query_logs to Logging.query handler', () => {
      const route = getRoute('query_logs');
      expect(route!.handler).toBe('Logging.query');
    });

    it('should include query_logs in OPERATION_ROUTES', () => {
      expect(OPERATION_ROUTES).toHaveProperty('query_logs');
    });

    it('should have a description for query_logs', () => {
      const route = getRoute('query_logs');
      expect(route!.description).toBeTruthy();
      expect(route!.description!.length).toBeGreaterThan(10);
    });
  });

  describe('OperationPolicies', () => {
    it('should have AUTO_APPROVE policy for query_logs', () => {
      const level = getDefaultPermissionLevel('query_logs');
      expect(level).toBe(PermissionLevel.AUTO_APPROVE);
    });

    it('should derive AUTO_APPROVE from READ endpoint for query_logs', () => {
      // query_logs is on the READ endpoint — no explicit override needed
      // AUTO_APPROVE is derived from the endpoint routing
      const route = getRoute('query_logs');
      expect(route?.endpoint).toBe('READ');
      expect(getDefaultPermissionLevel('query_logs')).toBe(PermissionLevel.AUTO_APPROVE);
    });
  });

  describe('dispatchLogging behavior (via MemoryLogSink.query)', () => {
    let memorySink: MemoryLogSink;

    beforeEach(() => {
      memorySink = new MemoryLogSink({
        appCapacity: 100,
        securityCapacity: 100,
        perfCapacity: 100,
        telemetryCapacity: 100,
      });
    });

    it('should return LogQueryResult shape with _type tag', () => {
      memorySink.write(makeEntry({ message: 'hello' }));
      const result = memorySink.query({});
      const tagged = { _type: 'LogQueryResult', ...result };

      expect(tagged).toHaveProperty('_type', 'LogQueryResult');
      expect(tagged).toHaveProperty('entries');
      expect(tagged).toHaveProperty('total');
      expect(tagged).toHaveProperty('hasMore');
      expect(tagged).toHaveProperty('limit');
      expect(tagged).toHaveProperty('offset');
    });

    it('should return all entries when no filters provided', () => {
      memorySink.write(makeEntry({ message: 'one' }));
      memorySink.write(makeEntry({ message: 'two' }));
      const result = memorySink.query({});
      expect(result.entries).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('should filter by category', () => {
      memorySink.write(makeEntry({ category: 'security', message: 'sec' }));
      memorySink.write(makeEntry({ category: 'application', message: 'app' }));
      const result = memorySink.query({ category: 'security' });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].message).toBe('sec');
    });

    it('should filter by minimum level', () => {
      memorySink.write(makeEntry({ level: 'debug', message: 'dbg' }));
      memorySink.write(makeEntry({ level: 'info', message: 'inf' }));
      memorySink.write(makeEntry({ level: 'warn', message: 'wrn' }));
      memorySink.write(makeEntry({ level: 'error', message: 'err' }));
      const result = memorySink.query({ level: 'warn' });
      expect(result.entries).toHaveLength(2);
      const messages = result.entries.map(e => e.message);
      expect(messages).toContain('wrn');
      expect(messages).toContain('err');
    });

    it('should filter by source (case-insensitive substring)', () => {
      memorySink.write(makeEntry({ source: 'MCPLogger', message: 'mcp' }));
      memorySink.write(makeEntry({ source: 'CacheManager', message: 'cache' }));
      const result = memorySink.query({ source: 'mcplogger' });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].message).toBe('mcp');
    });

    it('should filter by message (case-insensitive substring)', () => {
      memorySink.write(makeEntry({ message: 'Request blocked by firewall' }));
      memorySink.write(makeEntry({ message: 'Request succeeded' }));
      const result = memorySink.query({ message: 'blocked' });
      expect(result.entries).toHaveLength(1);
    });

    it('should filter by correlationId', () => {
      memorySink.write(makeEntry({ correlationId: 'abc-123', message: 'correlated' }));
      memorySink.write(makeEntry({ message: 'uncorrelated' }));
      const result = memorySink.query({ correlationId: 'abc-123' });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].message).toBe('correlated');
    });

    it('should respect limit and offset pagination', () => {
      for (let i = 0; i < 20; i++) {
        memorySink.write(makeEntry({
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          message: `entry-${i}`,
        }));
      }
      const result = memorySink.query({ limit: 5, offset: 5 });
      expect(result.entries).toHaveLength(5);
      expect(result.offset).toBe(5);
      expect(result.total).toBe(20);
      expect(result.hasMore).toBe(true);
    });

    it('should sort entries newest-first', () => {
      memorySink.write(makeEntry({ timestamp: '2026-01-01T00:00:00Z', message: 'oldest' }));
      memorySink.write(makeEntry({ timestamp: '2026-01-03T00:00:00Z', message: 'newest' }));
      memorySink.write(makeEntry({ timestamp: '2026-01-02T00:00:00Z', message: 'middle' }));
      const result = memorySink.query({});
      expect(result.entries[0].message).toBe('newest');
      expect(result.entries[1].message).toBe('middle');
      expect(result.entries[2].message).toBe('oldest');
    });

    it('should default limit to 50 and offset to 0', () => {
      const result = memorySink.query({});
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
    });

    it('should clamp limit to max 500', () => {
      const result = memorySink.query({ limit: 9999 });
      expect(result.limit).toBe(500);
    });

    it('should clamp limit to min 1', () => {
      const result = memorySink.query({ limit: 0 });
      expect(result.limit).toBe(1);
    });

    it('should return empty result when no entries match', () => {
      const result = memorySink.query({});
      expect(result.entries).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });
  });
});
