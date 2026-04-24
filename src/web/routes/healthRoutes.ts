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

  router.get('/health', (_req: Request, res: Response) => {
    const health: Record<string, unknown> = {
      status: 'ok',
      // process.uptime() returns seconds-since-process-start as a float. Always
      // > 0 by the time any handler runs, so no sub-second flake (the prior
      // Math.floor(Date.now() - startTime) / 1000 would return 0 when a request
      // arrived within 1s of route registration).
      uptime: process.uptime(),
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
