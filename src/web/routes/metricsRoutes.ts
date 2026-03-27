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
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';

interface SSEClient {
  res: Response;
}

export interface MetricsRoutesResult {
  router: Router;
  onSnapshot: (snapshot: MetricSnapshot) => void;
  clientCount: () => number;
}

function parseMetricsQueryOptions(query: Request['query']): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (typeof query['names'] === 'string' && query['names']) {
    options['names'] = UnicodeValidator.normalize(query['names']).normalizedContent.split(',').map(s => s.trim());
  }
  if (typeof query['source'] === 'string' && query['source']) {
    options['source'] = UnicodeValidator.normalize(query['source']).normalizedContent;
  }
  if (typeof query['type'] === 'string' && query['type']) {
    options['type'] = UnicodeValidator.normalize(query['type']).normalizedContent as MetricType;
  }
  for (const field of ['since', 'until'] as const) {
    if (typeof query[field] === 'string' && query[field]) {
      options[field] = query[field];
    }
  }
  if (typeof query['latest'] === 'string') {
    options['latest'] = query['latest'] !== 'false';
  }
  for (const field of ['limit', 'offset'] as const) {
    if (typeof query[field] === 'string') {
      const parsed = Number.parseInt(query[field], 10);
      if (!Number.isNaN(parsed)) options[field] = parsed;
    }
  }
  return options;
}

export function createMetricsRoutes(metricsSink: MemoryMetricsSink): MetricsRoutesResult {
  const router = Router();
  const clients = new Set<SSEClient>();

  // GET /api/metrics — JSON query
  router.get('/metrics', (req: Request, res: Response) => {
    const result = metricsSink.query(parseMetricsQueryOptions(req.query));
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
