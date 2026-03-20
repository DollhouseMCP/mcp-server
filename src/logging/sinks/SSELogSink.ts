/**
 * SSE-based real-time log viewer sink.
 *
 * Implements ILogSink and runs an opt-in Express HTTP server that:
 * - Serves a browser-based log viewer at GET /
 * - Streams log entries via SSE at GET /logs/stream
 * - Exposes a JSON query endpoint at GET /logs (delegates to MemoryLogSink)
 * - Provides a health endpoint at GET /health
 *
 * See docs/LOGGING-DESIGN.md §4.6 for the full design.
 */

import express from 'express';
import type { Request, Response } from 'express';
import type { Server } from 'http';
import type { ILogSink, UnifiedLogEntry, LogCategory, LogLevel } from '../types.js';
import { LOG_LEVEL_PRIORITY } from '../types.js';
import type { MemoryLogSink } from './MemoryLogSink.js';
import { getViewerHtml } from '../viewer/viewerHtml.js';

export interface SSELogSinkOptions {
  port: number;
  memorySink: MemoryLogSink;
}

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

export class SSELogSink implements ILogSink {
  private readonly app: ReturnType<typeof express>;
  private server: Server | null = null;
  private readonly clients = new Set<SSEClient>();
  private readonly memorySink: MemoryLogSink;
  private readonly port: number;
  private readonly startTime = Date.now();

  constructor(options: SSELogSinkOptions) {
    this.port = options.port;
    this.memorySink = options.memorySink;
    this.app = express();
    this.setupRoutes();
  }

  // ---------------------------------------------------------------------------
  // ILogSink
  // ---------------------------------------------------------------------------

  write(entry: UnifiedLogEntry): void {
    for (const client of this.clients) {
      if (this.matchesFilter(entry, client.filter)) {
        client.res.write(`data: ${JSON.stringify(entry)}\n\n`);
      }
    }
  }

  async flush(): Promise<void> {
    // No-op — SSE writes are immediate.
  }

  async close(): Promise<void> {
    // End all client connections
    for (const client of this.clients) {
      client.res.end();
    }
    this.clients.clear();

    // Shut down HTTP server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.server = this.app.listen(this.port, '127.0.0.1', () => {
        this.server!.unref();
        resolve();
      });
    });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  getPort(): number {
    if (!this.server) return this.port;
    const addr = this.server.address();
    if (addr && typeof addr === 'object') return addr.port;
    return this.port;
  }

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  private setupRoutes(): void {
    // Viewer HTML
    this.app.get('/', (_req: Request, res: Response) => {
      const actualPort = this.getPort();
      res.type('html').send(getViewerHtml(actualPort));
    });

    // SSE stream
    this.app.get('/logs/stream', (req: Request, res: Response) => {
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
      this.clients.add(client);

      // Backfill recent history so the viewer shows context on connect
      const history = this.memorySink.query({ category: 'all', limit: 500 });
      // Send oldest-first so the viewer displays in chronological order
      const entries = history.entries.slice().reverse();
      for (const entry of entries) {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      }

      req.on('close', () => {
        this.clients.delete(client);
      });
    });

    // JSON query (delegates to MemoryLogSink)
    this.app.get('/logs', (req: Request, res: Response) => {
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

      const result = this.memorySink.query(options);
      res.json(result);
    });

    // Health
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        clients: this.clientCount,
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Filter matching
  // ---------------------------------------------------------------------------

  private matchesFilter(entry: UnifiedLogEntry, filter: SSEClientFilter): boolean {
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
}
