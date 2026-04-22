/**
 * Health API route for the unified dev console.
 *
 * GET /api/health — Aggregated health: uptime, sink stats, SSE client counts
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { homedir } from 'node:os';
import type { MemoryLogSink } from '../../logging/sinks/MemoryLogSink.js';
import type { MemoryMetricsSink } from '../../metrics/sinks/MemoryMetricsSink.js';
import {
  getPermissionHookAuditSummary,
  summarizePermissionHookHealth,
  type PermissionHookAuditSummary,
} from '../../utils/permissionHooks.js';

export interface HealthRoutesOptions {
  memorySink: MemoryLogSink;
  metricsSink?: MemoryMetricsSink;
  logClientCount: () => number;
  metricsClientCount: () => number;
  permissionHooksHomeDir?: string;
  getPermissionHookAuditSummaryFn?: (homeDir: string) => Promise<PermissionHookAuditSummary>;
}

export function createHealthRoutes(options: HealthRoutesOptions): Router {
  const router = Router();
  const startTime = Date.now();

  router.get('/health', async (_req: Request, res: Response) => {
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

    try {
      const permissionHookAudit = await (options.getPermissionHookAuditSummaryFn ?? getPermissionHookAuditSummary)(
        options.permissionHooksHomeDir ?? homedir(),
      );
      health['permissionHooks'] = {
        ...summarizePermissionHookHealth(permissionHookAudit),
        installedHosts: permissionHookAudit.installedHosts,
        currentHosts: permissionHookAudit.currentHosts,
        needsRepairHosts: permissionHookAudit.needsRepairHosts,
        diagnosticsPath: permissionHookAudit.diagnosticsPath,
        lastDiagnostic: permissionHookAudit.lastDiagnostic,
        lastStartupRepair: permissionHookAudit.lastStartupRepair,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      health['status'] = 'degraded';
      health['permissionHooks'] = {
        status: 'error',
        message: `Failed to audit permission hook status: ${message}`,
      };
    }

    res.json(health);
  });

  return router;
}
