/**
 * Log API routes for the unified dev console.
 *
 * Mounts on the existing Express app to provide:
 * - GET /api/logs       — JSON query (delegates to MemoryLogSink)
 * - GET /api/logs/stream — SSE real-time stream (supports server-side filtering via query params)
 * - GET /api/logs/stats  — Queue sizes and capacities
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { MemoryLogSink } from '../../logging/sinks/MemoryLogSink.js';
import type { UnifiedLogEntry, LogCategory, LogLevel } from '../../logging/types.js';
import { LOG_LEVEL_PRIORITY } from '../../logging/types.js';

interface SSEClientFilter {
  category?: LogCategory;
  level?: LogLevel;
  source?: string;
  correlationId?: string;
}

interface SSEClient {
  res: Response;
  filter: SSEClientFilter;
}

export interface LogRoutesResult {
  router: Router;
  broadcast: (entry: UnifiedLogEntry) => void;
  clientCount: () => number;
}

function parseLogQueryOptions(query: Request['query']): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  const stringFields = ['category', 'level', 'source', 'message', 'correlationId', 'since', 'until'] as const;
  for (const field of stringFields) {
    if (typeof query[field] === 'string' && query[field]) {
      options[field] = query[field];
    }
  }
  for (const field of ['limit', 'offset'] as const) {
    if (typeof query[field] === 'string') {
      const parsed = Number.parseInt(query[field], 10);
      if (!Number.isNaN(parsed)) options[field] = parsed;
    }
  }
  return options;
}

function parseSseFilter(query: Request['query']): SSEClientFilter {
  const filter: SSEClientFilter = {};
  if (typeof query['category'] === 'string' && query['category']) {
    filter.category = query['category'] as LogCategory;
  }
  if (typeof query['level'] === 'string' && query['level']) {
    filter.level = query['level'] as LogLevel;
  }
  if (typeof query['source'] === 'string' && query['source']) {
    filter.source = query['source'];
  }
  if (typeof query['correlationId'] === 'string' && query['correlationId']) {
    filter.correlationId = query['correlationId'];
  }
  return filter;
}

export function createLogRoutes(memorySink: MemoryLogSink): LogRoutesResult {
  const router = Router();
  const clients = new Set<SSEClient>();

  // GET /api/logs — JSON query
  router.get('/logs', (req: Request, res: Response) => {
    const result = memorySink.query(parseLogQueryOptions(req.query));
    res.json(result);
  });

  // GET /api/logs/stream — SSE endpoint
  router.get('/logs/stream', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(':connected\n\n');

    const filter = parseSseFilter(req.query);
    const client: SSEClient = { res, filter };
    clients.add(client);

    // Backfill recent history (oldest-first for chronological order).
    // Capped at 500 entries to avoid blocking the event loop on connect.
    const history = memorySink.query({ category: 'all', limit: 500 });
    const entries = history.entries.slice().reverse();
    for (const entry of entries) {
      if (matchesFilter(entry, filter)) {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      }
    }

    // Keep-alive heartbeat — prevents proxies from closing idle connections
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 30_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(client);
    });
  });

  // GET /api/logs/stats — Queue sizes/capacities
  router.get('/logs/stats', (_req: Request, res: Response) => {
    res.json(memorySink.getStats());
  });

  function broadcast(entry: UnifiedLogEntry): void {
    for (const client of clients) {
      if (matchesFilter(entry, client.filter)) {
        client.res.write(`data: ${JSON.stringify(entry)}\n\n`);
      }
    }
  }

  return {
    router,
    broadcast,
    clientCount: () => clients.size,
  };
}

function matchesFilter(entry: UnifiedLogEntry, filter: SSEClientFilter): boolean {
  if (filter.category && entry.category !== filter.category) {
    return false;
  }
  if (filter.level && LOG_LEVEL_PRIORITY[entry.level] < LOG_LEVEL_PRIORITY[filter.level]) {
    return false;
  }
  if (filter.source) {
    const needle = filter.source.toLowerCase();
    if (!entry.source.toLowerCase().includes(needle)) {
      return false;
    }
  }
  if (filter.correlationId && entry.correlationId !== filter.correlationId) {
    return false;
  }
  return true;
}
