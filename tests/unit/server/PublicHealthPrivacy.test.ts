import { describe, it, expect, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { createStreamableHttpRuntime } from '../../../src/server/StreamableHttpServer.js';
import { PACKAGE_VERSION } from '../../../src/generated/version.js';
import { logger } from '../../../src/utils/logger.js';
import { PerformanceMonitor } from '../../../src/utils/PerformanceMonitor.js';

// Drive actual transport handlers without making an MCP session or starting monitoring timers.
describe('Public HTTP health privacy (#3000)', () => {
  it.each([true, false])('exposes no telemetry on any public discovery/probe route when ready=%p', async ready => {
    const monitor = new PerformanceMonitor();
    const auth = jest.spyOn(monitor, 'getAuthOpStats');
    const outcomes = jest.spyOn(monitor, 'getAuthAuthorizationFailureStats');
    const runtime = await createStreamableHttpRuntime(async () => ({ contextSessionId: 'public-health-test', dispose: async () => {} }), {
      host: '127.0.0.1', port: 0, mcpPath: '/mcp', sessionPoolSize: 0,
      registerSignalHandlers: false, sessionIdleTimeoutMs: 0,
      performanceMonitor: monitor,
      oauthProvider: { createRouter: () => express.Router(), isReadyForTraffic: async () => ready },
    });
    try {
      const health = await request(runtime.app).get('/healthz');
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ ok: true, version: PACKAGE_VERSION });
      const readiness = await request(runtime.app).get('/readyz');
      expect(readiness.status).toBe(ready ? 200 : 503);
      expect(readiness.body).toEqual({ ready, version: PACKAGE_VERSION });
      const discovery = await request(runtime.app).get('/');
      expect(discovery.status).toBe(200);
      expect(discovery.body).toEqual({
        name: 'dollhousemcp', version: PACKAGE_VERSION, transport: 'streamable-http',
        mcpPath: '/mcp', connectorUrl: '/mcp', health: '/healthz', readiness: '/readyz',
      });
      expect(auth).not.toHaveBeenCalled();
      expect(outcomes).not.toHaveBeenCalled();
      expect(runtime.getOperationalMetrics()).toMatchObject({ available: true, sessions: { active: 0 } });
      expect(auth).toHaveBeenCalledTimes(1);
      expect(outcomes).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.close();
    }
  });
  it('returns only status/version when readiness and a diagnostic listener throw private errors', async () => {
    const warning = jest.spyOn(logger, 'warn').mockImplementation(() => { throw new Error('private-warning-listener'); });
    const runtime = await createStreamableHttpRuntime(async () => ({ contextSessionId: 'readiness-error-test', dispose: async () => {} }), {
      host: '127.0.0.1', port: 0, mcpPath: '/mcp', sessionPoolSize: 0,
      registerSignalHandlers: false, sessionIdleTimeoutMs: 0,
      oauthProvider: { createRouter: () => express.Router(), isReadyForTraffic: async () => { throw new Error('private-readiness-detail'); } },
    });
    try {
      const response = await request(runtime.app).get('/readyz');
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ ready: false, version: PACKAGE_VERSION });
      expect(response.text).not.toContain('private');
      expect(warning).toHaveBeenCalledWith('Readiness probe failed');
    } finally {
      warning.mockRestore();
      await runtime.close();
    }
  });

});
