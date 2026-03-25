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
      const parsed = parseInt(req.query['limit'], 10);
      if (!isNaN(parsed)) options['limit'] = parsed;
    }
    if (typeof req.query['offset'] === 'string') {
      const parsed = parseInt(req.query['offset'], 10);
      if (!isNaN(parsed)) options['offset'] = parsed;
    }

    const result = metricsSink.query(options);
    res.json(result);
  });

  // GET /api/metrics/stream — SSE endpoint for real-time metric snapshots.
  // Currently unused by the built-in web console (which polls /api/metrics).
  // Retained for third-party consumers (Prometheus, Grafana agent, custom dashboards)
  // that benefit from push-based metric delivery.
  router.get('/metrics/stream', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(':connected\n\n');

    const client: SSEClient = { res };
    clients.add(client);

    // Keep-alive heartbeat — prevents proxies from closing idle connections
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 30_000);

    req.on('close', () => {
      clearInterval(heartbeat);
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
