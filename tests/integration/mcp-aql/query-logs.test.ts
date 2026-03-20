/**
 * Integration tests for CRUDE-routed query_logs operation (Issue #528)
 *
 * Tests the full round-trip through handleRead():
 * 1. Operation routes through OperationRouter
 * 2. Gatekeeper auto-approves (READ + AUTO_APPROVE policy)
 * 3. MCPAQLHandler dispatches to Logging.query
 * 4. MemoryLogSink.query() returns filtered, paginated results
 * 5. Response includes _type: 'LogQueryResult' tag
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { MemoryLogSink } from '../../../src/logging/sinks/MemoryLogSink.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';
import type { UnifiedLogEntry } from '../../../src/logging/types.js';
import type { OperationResult } from '../../../src/handlers/mcp-aql/types.js';

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

describe('query_logs CRUDE Integration (Issue #528)', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;
  let memorySink: MemoryLogSink;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('mcp-aql-query-logs');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize server
    preConfirmAllOperations(container);

    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
    memorySink = container.resolve<MemoryLogSink>('MemoryLogSink');
  });

  afterEach(async () => {
    await server.dispose();
    await env.cleanup();
  });

  it('should return structured LogQueryResult through handleRead', async () => {
    memorySink.write(makeEntry({ message: 'integration test entry' }));

    const result = await mcpAqlHandler.handleRead({
      operation: 'query_logs',
      params: {},
    }) as OperationResult;

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data._type).toBe('LogQueryResult');
      expect(data).toHaveProperty('entries');
      expect(data).toHaveProperty('total');
      expect(data).toHaveProperty('hasMore');
      expect(data).toHaveProperty('limit');
      expect(data).toHaveProperty('offset');
    }
  });

  it('should return entries written to MemoryLogSink', async () => {
    memorySink.write(makeEntry({ message: 'first' }));
    memorySink.write(makeEntry({ message: 'second' }));

    const result = await mcpAqlHandler.handleRead({
      operation: 'query_logs',
      params: {},
    }) as OperationResult;

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      const entries = data.entries as UnifiedLogEntry[];
      // At least our 2 entries (server startup may add more)
      expect(entries.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('should filter by category', async () => {
    memorySink.write(makeEntry({ category: 'security', message: 'sec-entry' }));
    memorySink.write(makeEntry({ category: 'application', message: 'app-entry' }));

    const result = await mcpAqlHandler.handleRead({
      operation: 'query_logs',
      params: { category: 'security' },
    }) as OperationResult;

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      const entries = data.entries as UnifiedLogEntry[];
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries.every(e => e.category === 'security')).toBe(true);
    }
  });

  it('should filter by minimum level', async () => {
    memorySink.write(makeEntry({ level: 'debug', message: 'dbg' }));
    memorySink.write(makeEntry({ level: 'error', message: 'err' }));

    const result = await mcpAqlHandler.handleRead({
      operation: 'query_logs',
      params: { level: 'error' },
    }) as OperationResult;

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      const entries = data.entries as UnifiedLogEntry[];
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries.every(e => e.level === 'error')).toBe(true);
    }
  });

  it('should silently ignore invalid param types (runtime validation)', async () => {
    memorySink.write(makeEntry({ category: 'security', message: 'valid entry' }));

    // Pass invalid types: category as number, level as boolean, limit as string
    const result = await mcpAqlHandler.handleRead({
      operation: 'query_logs',
      params: {
        category: 12345,       // should be string — silently dropped
        level: true,           // should be string — silently dropped
        limit: 'not-a-number', // should be number — silently dropped
        unknown_field: 'foo',  // unknown key — silently stripped
      },
    }) as OperationResult;

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      // With all filters dropped, returns all entries (defaults apply)
      expect(data._type).toBe('LogQueryResult');
      expect(data.limit).toBe(50); // default, since invalid limit was dropped
    }
  });

  it('should reject invalid category values', async () => {
    memorySink.write(makeEntry({ category: 'application', message: 'app' }));
    memorySink.write(makeEntry({ category: 'security', message: 'sec' }));

    // 'nonexistent' is a string but not a valid LogCategory — should be dropped
    const result = await mcpAqlHandler.handleRead({
      operation: 'query_logs',
      params: { category: 'nonexistent' },
    }) as OperationResult;

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      // Invalid category dropped, so no category filter → returns all entries
      const entries = data.entries as UnifiedLogEntry[];
      expect(entries.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('should respect limit and offset pagination', async () => {
    for (let i = 0; i < 10; i++) {
      memorySink.write(makeEntry({
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        message: `page-entry-${i}`,
      }));
    }

    const result = await mcpAqlHandler.handleRead({
      operation: 'query_logs',
      params: { limit: 3, offset: 0 },
    }) as OperationResult;

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.limit).toBe(3);
      expect(data.offset).toBe(0);
      const entries = data.entries as UnifiedLogEntry[];
      expect(entries.length).toBeLessThanOrEqual(3);
    }
  });
});
