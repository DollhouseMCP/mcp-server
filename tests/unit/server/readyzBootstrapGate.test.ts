/**
 * Round 5 / H3: /readyz consults the embedded AS bootstrap state.
 *
 * When the embedded AS is in multi-user mode and bootstrap is
 * incomplete, every /authorize hits the gate's 503. /readyz must
 * surface that state so Kubernetes / load balancers stop sending
 * traffic to the pod until the operator runs the bootstrap CLI.
 *
 * Lean test: stand up the runtime with a stub oauthProvider exposing
 * isReadyForTraffic, drive that flag via the test, and assert the
 * /readyz response shape. Doesn't need the full container — the
 * /readyz handler doesn't touch any session state.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import {
  createStreamableHttpRuntime,
  type StreamableHttpRuntimeHandle,
} from '../../../src/server/StreamableHttpServer.js';
import { setHttpModeActive } from '../../../src/index.js';

describe('/readyz — H3 bootstrap gate consultation', () => {
  beforeAll(() => setHttpModeActive(true));
  afterAll(() => setHttpModeActive(false));

  async function buildRuntime(
    isReadyForTraffic?: () => Promise<boolean>,
  ): Promise<StreamableHttpRuntimeHandle> {
    return createStreamableHttpRuntime(
      // Session factory — never invoked for /readyz; minimal stub.
      async () => ({ dispose: async () => undefined }),
      {
        host: '127.0.0.1',
        port: 0,
        mcpPath: '/mcp',
        rateLimitMaxRequests: 0,
        sessionIdleTimeoutMs: 0,
        sessionPoolSize: 0,
        registerSignalHandlers: false,
        oauthProvider: isReadyForTraffic ? {
          createRouter: () => express.Router(),
          isReadyForTraffic,
        } : undefined,
      },
    );
  }

  it('returns 200 when no oauthProvider is wired (legacy / non-AS deployments)', async () => {
    const runtime = await buildRuntime();
    try {
      const res = await request(runtime.app).get('/readyz');
      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it('returns 200 when oauthProvider reports ready=true', async () => {
    const runtime = await buildRuntime(async () => true);
    try {
      const res = await request(runtime.app).get('/readyz');
      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it('returns 503 with reason=bootstrap_required when oauthProvider reports ready=false', async () => {
    const runtime = await buildRuntime(async () => false);
    try {
      const res = await request(runtime.app).get('/readyz');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        ready: false,
        reason: 'bootstrap_required',
        transport: 'streamable-http',
      });
    } finally {
      await runtime.close();
    }
  });

  it('flips between 503 and 200 when bootstrap completes mid-run', async () => {
    // Pins the operator workflow: pod boots, /readyz=503, operator
    // runs bootstrap CLI, /readyz becomes 200, k8s starts routing
    // traffic. Locks the no-restart-required behavior — the AS
    // re-reads bootstrap state on every /readyz hit.
    let bootstrapped = false;
    const runtime = await buildRuntime(async () => bootstrapped);
    try {
      let res = await request(runtime.app).get('/readyz');
      expect(res.status).toBe(503);
      bootstrapped = true;
      res = await request(runtime.app).get('/readyz');
      expect(res.status).toBe(200);
    } finally {
      await runtime.close();
    }
  });
});
