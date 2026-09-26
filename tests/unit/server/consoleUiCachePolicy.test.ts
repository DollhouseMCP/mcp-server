import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { setHttpModeActive } from '../../../src/index.js';
import { createStreamableHttpRuntime } from '../../../src/server/StreamableHttpServer.js';

const CACHE_POLICY = 'no-store, max-age=0, must-revalidate';

describe('hosted console static cache policy', () => {
  beforeAll(() => setHttpModeActive(true));
  afterAll(() => setHttpModeActive(false));

  it('covers the HTML shell, module graph, CSS, conditional requests, and missing assets', async () => {
    const runtime = await createStreamableHttpRuntime(
      async () => ({ dispose: async () => {} }),
      {
        host: '127.0.0.1',
        port: 0,
        rateLimitMaxRequests: 0,
        sessionIdleTimeoutMs: 0,
        sessionPoolSize: 0,
        registerSignalHandlers: false,
        webConsoleApiV1: { router: express.Router(), markMounted: () => {} },
      },
    );

    try {
      for (const path of [
        '/ui/',
        '/ui/index.html',
        '/ui/app.js',
        '/ui/connect.js',
        '/ui/connect-catalog.js',
        '/ui/connect-extra-clients.js',
        '/ui/connect.css',
        '/ui/vendor/purify.min.js',
      ]) {
        const response = await request(runtime.app).get(path);
        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe(CACHE_POLICY);
      }

      const app = await request(runtime.app).get('/ui/app.js');
      const notModified = await request(runtime.app).get('/ui/app.js').set('If-None-Match', app.headers.etag);
      expect(notModified.status).toBe(304);
      expect(notModified.headers['cache-control']).toBe(CACHE_POLICY);

      const head = await request(runtime.app).head('/ui/connect.js');
      expect(head.status).toBe(200);
      expect(head.headers['cache-control']).toBe(CACHE_POLICY);

      const missing = await request(runtime.app).get('/ui/missing-module.js');
      expect(missing.status).toBe(404);
      expect(missing.headers['cache-control']).toBe(CACHE_POLICY);

      const unrelated = await request(runtime.app).get('/version');
      expect(unrelated.status).toBe(200);
      expect(unrelated.headers['cache-control']).not.toBe(CACHE_POLICY);
    } finally {
      await runtime.close();
    }
  });
});
