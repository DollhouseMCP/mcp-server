/**
 * Metrics API routes for the unified dev console.
 *
 * Mounts on the existing Express app to provide:
 * - GET /api/metrics        — JSON query (delegates to MemoryMetricsSink)
 * - GET /api/metrics/stream — SSE endpoint, pushes each new snapshot
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { MemoryMetricsSink } from '../../metrics/sinks/MemoryMetricsSink.js';
import type { MetricSnapshot, MetricType } from '../../metrics/types.js';

interface SSEClient {
  res: Response;
}

export interface MetricsRoutesResult {
  router: Router;
  onSnapshot: (snapshot: MetricSnapshot) => void;
  clientCount: () => number;
}

export function createMetricsRoutes(metricsSink: MemoryMetricsSink): MetricsRoutesResult {
  const router = Router();
  const clients = new Set<SSEClient>();

  // GET /api/metrics — JSON query
  router.get('/metrics', (req: Request, res: Response) => {
    const options: Record<string, unknown> = {};

    if (typeof req.query['names'] === 'string' && req.query['names']) {
      options['names'] = req.query['names'].split(',').map(s => s.trim());
    }
    if (typeof req.query['source'] === 'string' && req.query['source']) {
      options['source'] = req.query['source'];
    }
    if (typeof req.query['type'] === 'string' && req.query['type']) {
      options['type'] = req.query['type'] as MetricType;
    }
    if (typeof req.query['since'] === 'string' && req.query['since']) {
      options['since'] = req.query['since'];
    }
    if (typeof req.query['until'] === 'string' && req.query['until']) {
      options['until'] = req.query['until'];
    }
    if (typeof req.query['latest'] === 'string') {
      options['latest'] = req.query['latest'] !== 'false';
    }
    if (typeof req.query['limit'] === 'string') {
      options['limit'] = parseInt(req.query['limit'], 10);
    }
    if (typeof req.query['offset'] === 'string') {
      options['offset'] = parseInt(req.query['offset'], 10);
    }

    const result = metricsSink.query(options);
    res.json(result);
  });

  // GET /api/metrics/stream — SSE endpoint
  router.get('/metrics/stream', (_req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(':connected\n\n');

    const client: SSEClient = { res };
    clients.add(client);

    _req.on('close', () => {
      clients.delete(client);
    });
  });

  function onSnapshot(snapshot: MetricSnapshot): void {
    const data = JSON.stringify(snapshot);
    for (const client of clients) {
      client.res.write(`data: ${data}\n\n`);
    }
  }

  return {
    router,
    onSnapshot,
    clientCount: () => clients.size,
  };
}
