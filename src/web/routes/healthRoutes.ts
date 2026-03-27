/**
 * Health API route for the unified dev console.
 *
 * GET /api/health — Aggregated health: uptime, sink stats, SSE client counts
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { MemoryLogSink } from '../../logging/sinks/MemoryLogSink.js';
import type { MemoryMetricsSink } from '../../metrics/sinks/MemoryMetricsSink.js';

export interface HealthRoutesOptions {
  memorySink: MemoryLogSink;
  metricsSink?: MemoryMetricsSink;
  logClientCount: () => number;
  metricsClientCount: () => number;
}

export function createHealthRoutes(options: HealthRoutesOptions): Router {
  const router = Router();
  const startTime = Date.now();

  router.get('/health', (_req: Request, res: Response) => {
    const health: Record<string, unknown> = {
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      logs: {
        stats: options.memorySink.getStats(),
        sseClients: options.logClientCount(),
      },
    };

    if (options.metricsSink) {
      health['metrics'] = {
        stats: options.metricsSink.getStats(),
        sseClients: options.metricsClientCount(),
      };
    }

    res.json(health);
  });

  return router;
}
