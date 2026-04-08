/**
 * Regression & integration tests for Auth tab route mounting in standalone
 * --web mode (#1825).
 *
 * The bug: when `startWebServer()` was called without a `tokenStore`, the
 * TOTP and token management routes were never mounted — every Auth tab
 * endpoint fell through to the SPA fallback and returned 404.
 *
 * These tests verify that:
 *   1. Routes ARE mounted and respond correctly when tokenStore is provided.
 *   2. Routes return 404 when tokenStore is omitted (regression baseline).
 *   3. ConsoleTokenStore initializes correctly from scratch — the path
 *      standalone --web mode now takes after the fix.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Secret, TOTP } from 'otpauth';
import { ConsoleTokenStore } from '../../../src/web/console/consoleToken.js';
import { createTotpRoutes } from '../../../src/web/routes/totpRoutes.js';
import { createTokenRoutes } from '../../../src/web/routes/tokenRoutes.js';
import { createAuthMiddleware } from '../../../src/web/middleware/authMiddleware.js';

/** Generate a current TOTP code from a base32 secret. */
function currentTotpCode(base32Secret: string): string {
  const totp = new TOTP({
    issuer: 'DollhouseMCP',
    label: 'test',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(base32Secret),
  });
  return totp.generate();
}

/** Enroll TOTP on a store and return the secret for code generation. */
async function enrollTotp(store: ConsoleTokenStore): Promise<string> {
  const begin = store.beginTotpEnrollment();
  await store.confirmTotpEnrollment(begin.pendingId, currentTotpCode(begin.secret));
  return begin.secret;
}

/**
 * Build an Express app that mirrors the route-mounting logic from
 * `startWebServer()` in `src/web/server.ts`. When `tokenStore` is
 * provided the auth middleware + TOTP + token routes are mounted;
 * when omitted, they are skipped — exactly the gate at server.ts:220.
 */
function buildApp(tokenStore?: ConsoleTokenStore): express.Express {
  const app = express();

  if (tokenStore) {
    const authMiddleware = createAuthMiddleware({
      store: tokenStore,
      enabled: true,
      publicPathPrefixes: ['/api/health', '/api/setup/version'],
      label: 'test',
    });
    app.use('/api', authMiddleware);
    app.use('/api/console/totp', createTotpRoutes({ store: tokenStore }));
    app.use('/api/console/token', createTokenRoutes({ store: tokenStore }));
  }

  // SPA fallback — unmatched /api routes return 404, same as server.ts:358
  app.get('/{*path}', (req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: `API route not found: ${req.path}` });
      return;
    }
    res.status(200).send('SPA fallback');
  });

  return app;
}

describe('Auth tab routes in standalone --web mode (#1825)', () => {
  let testDir: string;
  let store: ConsoleTokenStore;
  let token: string;
  let bearer: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'dollhouse-web-mode-auth-test-'));
    store = new ConsoleTokenStore(join(testDir, 'console-token.auth.json'));
    const entry = await store.ensureInitialized('Kermit');
    token = entry.token;
    bearer = `Bearer ${token}`;
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // ── Regression: routes missing without tokenStore ─────────────────────

  describe('regression: without tokenStore (the bug)', () => {
    it('GET /api/console/totp/status returns 404', async () => {
      const app = buildApp(/* no tokenStore */);
      const res = await request(app).get('/api/console/totp/status');
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/API route not found/);
    });

    it('GET /api/console/token/info returns 404', async () => {
      const app = buildApp(/* no tokenStore */);
      const res = await request(app).get('/api/console/token/info');
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/API route not found/);
    });
  });

  // ── Fix: routes work with tokenStore ──────────────────────────────────

  describe('with tokenStore (the fix)', () => {
    it('GET /api/console/totp/status returns 200 with valid token', async () => {
      const app = buildApp(store);
      const res = await request(app)
        .get('/api/console/totp/status')
        .set('Authorization', bearer);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('enrolled');
    });

    it('GET /api/console/totp/status rejects without token', async () => {
      const app = buildApp(store);
      const res = await request(app).get('/api/console/totp/status');
      expect(res.status).toBe(401);
    });

    it('GET /api/console/token/info returns 200 with valid token', async () => {
      const app = buildApp(store);
      const res = await request(app)
        .get('/api/console/token/info')
        .set('Authorization', bearer);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('tokens');
    });

    it('GET /api/console/token/info rejects without token', async () => {
      const app = buildApp(store);
      const res = await request(app).get('/api/console/token/info');
      expect(res.status).toBe(401);
    });

    it('POST /api/console/totp/enroll/begin starts enrollment', async () => {
      const app = buildApp(store);
      const res = await request(app)
        .post('/api/console/totp/enroll/begin')
        .set('Authorization', bearer);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('secret');
      expect(res.body).toHaveProperty('pendingId');
    });

    it('POST /api/console/token/rotate requires TOTP enrollment', async () => {
      const app = buildApp(store);
      const res = await request(app)
        .post('/api/console/token/rotate')
        .set('Authorization', bearer)
        .send({ confirmationCode: '123456' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('TOTP_REQUIRED');
    });
  });

  // ── Integration: standalone init path ─────────────────────────────────

  describe('standalone --web tokenStore initialization', () => {
    it('creates and initializes a ConsoleTokenStore from scratch', async () => {
      // This mirrors the exact code path added in the fix at index.ts:844-849
      const freshStore = new ConsoleTokenStore(join(testDir, 'fresh-token.auth.json'));
      const entry = await freshStore.ensureInitialized('TestPuppet');

      expect(entry).toBeDefined();
      expect(entry.token).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.name).toContain('TestPuppet');
      expect(entry.kind).toBe('console');
      expect(entry.scopes).toEqual(['admin']);
    });

    it('initialized store works with route mounting', async () => {
      // Full path: create store → init → mount routes → make request
      const freshStore = new ConsoleTokenStore(join(testDir, 'route-test-token.auth.json'));
      const entry = await freshStore.ensureInitialized('RoutePuppet');
      const app = buildApp(freshStore);

      const res = await request(app)
        .get('/api/console/totp/status')
        .set('Authorization', `Bearer ${entry.token}`);
      expect(res.status).toBe(200);
      expect(res.body.enrolled).toBe(false);
    });

    it('initialized store persists across re-reads', async () => {
      const tokenFile = join(testDir, 'persist-test-token.auth.json');
      const store1 = new ConsoleTokenStore(tokenFile);
      const entry1 = await store1.ensureInitialized('First');

      // Simulate server restart: new store instance, same file
      const store2 = new ConsoleTokenStore(tokenFile);
      const entry2 = await store2.ensureInitialized('Second');

      // Should return the same token (not create a new one)
      expect(entry2.token).toBe(entry1.token);
      expect(entry2.id).toBe(entry1.id);
    });

    it('full auth flow works end-to-end after standalone init', async () => {
      const freshStore = new ConsoleTokenStore(join(testDir, 'e2e-token.auth.json'));
      const entry = await freshStore.ensureInitialized('E2EPuppet');
      const app = buildApp(freshStore);
      const freshBearer = `Bearer ${entry.token}`;

      // 1. Check TOTP not enrolled
      const statusRes = await request(app)
        .get('/api/console/totp/status')
        .set('Authorization', freshBearer);
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.enrolled).toBe(false);

      // 2. Begin TOTP enrollment
      const beginRes = await request(app)
        .post('/api/console/totp/enroll/begin')
        .set('Authorization', freshBearer);
      expect(beginRes.status).toBe(200);
      const { secret, pendingId } = beginRes.body;

      // 3. Confirm enrollment with valid code
      const confirmRes = await request(app)
        .post('/api/console/totp/enroll/confirm')
        .set('Authorization', freshBearer)
        .send({ pendingId, code: currentTotpCode(secret) });
      expect(confirmRes.status).toBe(200);

      // 4. Verify TOTP is now enrolled
      const statusRes2 = await request(app)
        .get('/api/console/totp/status')
        .set('Authorization', freshBearer);
      expect(statusRes2.status).toBe(200);
      expect(statusRes2.body.enrolled).toBe(true);

      // 5. Token info still works
      const infoRes = await request(app)
        .get('/api/console/token/info')
        .set('Authorization', freshBearer);
      expect(infoRes.status).toBe(200);
      expect(infoRes.body.totp.enrolled).toBe(true);
    });
  });
});
