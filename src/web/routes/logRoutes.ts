/**
 * Log API routes for the unified dev console.
 *
 * Mounts on the existing Express app to provide:
 * - GET /api/logs       — JSON query (delegates to MemoryLogSink)
 * - GET /api/logs/stream — SSE real-time stream with per-client filtering
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

export function createLogRoutes(memorySink: MemoryLogSink): LogRoutesResult {
  const router = Router();
  const clients = new Set<SSEClient>();

  // GET /api/logs — JSON query
  router.get('/logs', (req: Request, res: Response) => {
    const options: Record<string, unknown> = {};
    if (typeof req.query['category'] === 'string' && req.query['category']) {
      options['category'] = req.query['category'];
    }
    if (typeof req.query['level'] === 'string' && req.query['level']) {
      options['level'] = req.query['level'];
    }
    if (typeof req.query['source'] === 'string' && req.query['source']) {
      options['source'] = req.query['source'];
    }
    if (typeof req.query['message'] === 'string' && req.query['message']) {
      options['message'] = req.query['message'];
    }
    if (typeof req.query['correlationId'] === 'string' && req.query['correlationId']) {
      options['correlationId'] = req.query['correlationId'];
    }
    if (typeof req.query['limit'] === 'string') {
      options['limit'] = parseInt(req.query['limit'], 10);
    }
    if (typeof req.query['offset'] === 'string') {
      options['offset'] = parseInt(req.query['offset'], 10);
    }
    if (typeof req.query['since'] === 'string' && req.query['since']) {
      options['since'] = req.query['since'];
    }
    if (typeof req.query['until'] === 'string' && req.query['until']) {
      options['until'] = req.query['until'];
    }

    const result = memorySink.query(options);
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

    const filter: SSEClientFilter = {};
    if (typeof req.query['category'] === 'string' && req.query['category']) {
      filter.category = req.query['category'] as LogCategory;
    }
    if (typeof req.query['level'] === 'string' && req.query['level']) {
      filter.level = req.query['level'] as LogLevel;
    }
    if (typeof req.query['source'] === 'string' && req.query['source']) {
      filter.source = req.query['source'];
    }
    if (typeof req.query['correlationId'] === 'string' && req.query['correlationId']) {
      filter.correlationId = req.query['correlationId'];
    }

    const client: SSEClient = { res, filter };
    clients.add(client);

    // Backfill recent history (oldest-first for chronological order)
    const history = memorySink.query({ category: 'all', limit: 5000 });
    const entries = history.entries.slice().reverse();
    for (const entry of entries) {
      if (matchesFilter(entry, filter)) {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      }
    }

    req.on('close', () => {
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
