/**
 * Integration tests for the console token rotation HTTP route (#1795).
 *
 * These tests spin up a real Express app with the token router mounted and
 * a real ConsoleTokenStore backed by a temp file. They exercise the full
 * request path including the always-on auth middleware, body parsing,
 * rate limiting, and error responses.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Secret, TOTP } from 'otpauth';
import { ConsoleTokenStore } from '../../../../src/web/console/consoleToken.js';
import { createTokenRoutes } from '../../../../src/web/routes/tokenRoutes.js';

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

interface BuildAppOptions {
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
}

async function buildApp(store: ConsoleTokenStore, options: BuildAppOptions = {}) {
  const app = express();
  app.use('/api/console/token', createTokenRoutes({ store, ...options }));
  return app;
}

/**
 * Enroll TOTP on a store and return the secret for code generation.
 * Shared helper at module scope to avoid per-test function re-creation.
 */
async function enrollTotp(store: ConsoleTokenStore): Promise<string> {
  const begin = store.beginTotpEnrollment();
  await store.confirmTotpEnrollment(begin.pendingId, currentTotpCode(begin.secret));
  return begin.secret;
}

describe('createTokenRoutes', () => {
  let testDir: string;
  let store: ConsoleTokenStore;
  let token: string;
  let bearer: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'dollhouse-token-routes-test-'));
    store = new ConsoleTokenStore(join(testDir, 'console-token.auth.json'));
    const entry = await store.ensureInitialized('Kermit');
    token = entry.token;
    bearer = `Bearer ${token}`;
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('auth enforcement (always-on)', () => {
    it('rejects POST /rotate without a token', async () => {
      const app = await buildApp(store);
      const res = await request(app)
        .post('/api/console/token/rotate')
        .send({ confirmationCode: '123456' });
      expect(res.status).toBe(401);
    });

    it('rejects POST /rotate with an invalid token', async () => {
      const app = await buildApp(store);
      const res = await request(app)
        .post('/api/console/token/rotate')
        .set('Authorization', 'Bearer bad')
        .send({ confirmationCode: '123456' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /rotate', () => {
    it('returns 400 when confirmationCode is missing', async () => {
      const app = await buildApp(store);
      const res = await request(app)
        .post('/api/console/token/rotate')
        .set('Authorization', bearer)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MISSING_FIELDS');
    });

    it('returns 403 when TOTP is not enrolled', async () => {
      const app = await buildApp(store);
      const res = await request(app)
        .post('/api/console/token/rotate')
        .set('Authorization', bearer)
        .send({ confirmationCode: '123456' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('TOTP_REQUIRED');
    });

    it('returns 400 when confirmation code is wrong', async () => {
      const secret = await enrollTotp(store);
      const app = await buildApp(store);
      const res = await request(app)
        .post('/api/console/token/rotate')
        .set('Authorization', bearer)
        .send({ confirmationCode: '000000' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_TOTP_CODE');
    });

    it('rotates successfully and returns the new token inline', async () => {
      const secret = await enrollTotp(store);
      const app = await buildApp(store);
      const res = await request(app)
        .post('/api/console/token/rotate')
        .set('Authorization', bearer)
        .send({ confirmationCode: currentTotpCode(secret) });
      expect(res.status).toBe(200);
      expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
      expect(res.body.token).not.toBe(token);
      expect(res.body.rotatedAt).toBeTruthy();
      expect(res.body.graceUntil).toBeGreaterThan(Date.now());
    });

    it('new token can authenticate after rotation', async () => {
      const secret = await enrollTotp(store);
      const app = await buildApp(store);
      const res = await request(app)
        .post('/api/console/token/rotate')
        .set('Authorization', bearer)
        .send({ confirmationCode: currentTotpCode(secret) });

      // Use the new token to try another rotation request (should 400, not 401)
      const res2 = await request(app)
        .post('/api/console/token/rotate')
        .set('Authorization', `Bearer ${res.body.token}`)
        .send({});
      expect(res2.status).toBe(400); // MISSING_FIELDS, not 401
      expect(res2.body.code).toBe('MISSING_FIELDS');
    });

    it('old token still works during grace window', async () => {
      const secret = await enrollTotp(store);
      const app = await buildApp(store);
      await request(app)
        .post('/api/console/token/rotate')
        .set('Authorization', bearer)
        .send({ confirmationCode: currentTotpCode(secret) });

      // Old token should still authenticate
      const res = await request(app)
        .post('/api/console/token/rotate')
        .set('Authorization', bearer)
        .send({});
      // Should be 400 (MISSING_FIELDS), not 401 — proves old token authenticated
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MISSING_FIELDS');
    });
  });

  describe('rate limiting', () => {
    it('rejects after exhausting the rate limit', async () => {
      const secret = await enrollTotp(store);
      const app = await buildApp(store, { rateLimitMax: 2, rateLimitWindowMs: 60_000 });

      // Burn through the rate limit with wrong codes
      for (let i = 0; i < 2; i++) {
        await request(app)
          .post('/api/console/token/rotate')
          .set('Authorization', bearer)
          .send({ confirmationCode: '000000' });
      }

      // Next request should be rate-limited
      const res = await request(app)
        .post('/api/console/token/rotate')
        .set('Authorization', bearer)
        .send({ confirmationCode: currentTotpCode(secret) });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('RATE_LIMITED');
    });
  });
});
