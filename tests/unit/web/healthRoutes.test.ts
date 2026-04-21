import express from 'express';
import request from 'supertest';
import { describe, expect, it } from '@jest/globals';

import { createHealthRoutes } from '../../../src/web/routes/healthRoutes.js';

describe('healthRoutes', () => {
  it('surfaces permission hook health in /api/health', async () => {
    const app = express();
    app.use('/api', createHealthRoutes({
      memorySink: { getStats: () => ({ entries: 1 }) } as any,
      metricsSink: { getStats: () => ({ series: 2 }) } as any,
      logClientCount: () => 0,
      metricsClientCount: () => 0,
      getPermissionHookAuditSummaryFn: async () => ({
        installedHosts: ['codex'],
        currentHosts: ['codex'],
        repairedHosts: [],
        needsRepairHosts: [],
        lastStartupRepair: {
          startedAt: '2026-04-21T20:00:00.000Z',
          completedAt: '2026-04-21T20:00:01.000Z',
          durationMs: 1000,
          repairedCount: 0,
          needsRepairCount: 0,
          hostResults: [],
        },
      }),
    }));

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.permissionHooks).toEqual(
      expect.objectContaining({
        status: 'ok',
        message: expect.any(String),
        installedHosts: ['codex'],
        currentHosts: ['codex'],
        needsRepairHosts: [],
      }),
    );
  });

  it('marks health as degraded when permission hook auditing fails', async () => {
    const app = express();
    app.use('/api', createHealthRoutes({
      memorySink: { getStats: () => ({ entries: 1 }) } as any,
      logClientCount: () => 0,
      metricsClientCount: () => 0,
      getPermissionHookAuditSummaryFn: async () => {
        throw new Error('boom');
      },
    }));

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.permissionHooks).toEqual(
      expect.objectContaining({
        status: 'error',
        message: expect.stringContaining('Failed to audit permission hook status'),
      }),
    );
  });
});
