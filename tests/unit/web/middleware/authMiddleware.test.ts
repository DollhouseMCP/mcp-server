/**
 * Unit tests for the console auth middleware (#1780).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAuthMiddleware } from '../../../../src/web/middleware/authMiddleware.js';
import { ConsoleTokenStore } from '../../../../src/web/console/consoleToken.js';

async function buildApp(options: {
  enabled: boolean;
  token: string;
  publicPaths?: string[];
  store: ConsoleTokenStore;
}) {
  const app = express();
  app.use('/api', createAuthMiddleware({
    store: options.store,
    enabled: options.enabled,
    publicPathPrefixes: options.publicPaths,
  }));
  app.get('/api/protected', (_req, res) => res.json({ ok: true }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/setup/version', (_req, res) => res.json({ version: '1' }));
  return app;
}

describe('createAuthMiddleware', () => {
  let testDir: string;
  let store: ConsoleTokenStore;
  let token: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'dollhouse-auth-mw-test-'));
    store = new ConsoleTokenStore(join(testDir, 'console-token.json'));
    const entry = await store.ensureInitialized('Kermit');
    token = entry.token;
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('when enabled is false (Phase 1 default)', () => {
    it('allows requests without any token', async () => {
      const app = await buildApp({ enabled: false, token, store });
      const res = await request(app).get('/api/protected');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('allows requests with a bogus token', async () => {
      const app = await buildApp({ enabled: false, token, store });
      const res = await request(app)
        .get('/api/protected')
        .set('Authorization', 'Bearer bogus');
      expect(res.status).toBe(200);
    });
  });

  describe('when enabled is true', () => {
    it('rejects requests with no Authorization header', async () => {
      const app = await buildApp({ enabled: true, token, store });
      const res = await request(app).get('/api/protected');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Authentication required');
      expect(res.body.reason).toBe('missing_token');
    });

    it('rejects requests with a wrong token', async () => {
      const app = await buildApp({ enabled: true, token, store });
      const res = await request(app)
        .get('/api/protected')
        .set('Authorization', 'Bearer wrong-token-value-32-characters-long-at-least-here');
      expect(res.status).toBe(401);
      expect(res.body.reason).toBe('invalid_token');
    });

    it('accepts requests with a valid Bearer token', async () => {
      const app = await buildApp({ enabled: true, token, store });
      const res = await request(app)
        .get('/api/protected')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('accepts a valid token via ?token= query parameter (SSE fallback)', async () => {
      const app = await buildApp({ enabled: true, token, store });
      const res = await request(app).get(`/api/protected?token=${token}`);
      expect(res.status).toBe(200);
    });

    it('rejects an empty Bearer value', async () => {
      const app = await buildApp({ enabled: true, token, store });
      const res = await request(app)
        .get('/api/protected')
        .set('Authorization', 'Bearer ');
      expect(res.status).toBe(401);
      expect(res.body.reason).toBe('missing_token');
    });

    it('rejects Bearer header with wrong prefix', async () => {
      const app = await buildApp({ enabled: true, token, store });
      const res = await request(app)
        .get('/api/protected')
        .set('Authorization', `Basic ${token}`);
      expect(res.status).toBe(401);
    });
  });

  describe('public path allowlist', () => {
    it('skips auth for exact prefix matches', async () => {
      const app = await buildApp({
        enabled: true,
        token,
        store,
        publicPaths: ['/api/health', '/api/setup/version'],
      });

      const health = await request(app).get('/api/health');
      expect(health.status).toBe(200);

      const version = await request(app).get('/api/setup/version');
      expect(version.status).toBe(200);
    });

    it('still enforces auth for non-public routes when allowlist is present', async () => {
      const app = await buildApp({
        enabled: true,
        token,
        store,
        publicPaths: ['/api/health'],
      });

      const res = await request(app).get('/api/protected');
      expect(res.status).toBe(401);
    });

    it('does not treat a partial prefix as a match (prevents /api/healthy bypass)', async () => {
      const app = await buildApp({
        enabled: true,
        token,
        store,
        publicPaths: ['/api/health'],
      });
      // /api/health-check is NOT /api/health nor a child of /api/health
      // but matches the prefix /api/health. Our middleware requires either
      // exact match or prefix + '/', so this should NOT bypass auth.
      app.get('/api/health-check', (_req, res) => res.json({ protected: true }));
      const res = await request(app).get('/api/health-check');
      expect(res.status).toBe(401);
    });
  });

  describe('response body', () => {
    it('includes a hint about the token file location on 401', async () => {
      const app = await buildApp({ enabled: true, token, store });
      const res = await request(app).get('/api/protected');
      expect(res.body.hint).toContain(store.getFilePath());
      expect(res.body.hint).toContain('Authorization: Bearer');
    });
  });
});
