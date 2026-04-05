/**
 * Integration tests for the TOTP enrollment HTTP routes (#1794).
 *
 * These tests spin up a real Express app with the TOTP router mounted and
 * a real ConsoleTokenStore backed by a temp file. They exercise the full
 * request path including the always-on auth middleware, body parsing,
 * and error responses.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Secret, TOTP } from 'otpauth';
import { ConsoleTokenStore } from '../../../../src/web/console/consoleToken.js';
import { createTotpRoutes } from '../../../../src/web/routes/totpRoutes.js';

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

async function buildApp(store: ConsoleTokenStore) {
  const app = express();
  app.use('/api/console/totp', createTotpRoutes({ store }));
  return app;
}

describe('createTotpRoutes', () => {
  let testDir: string;
  let store: ConsoleTokenStore;
  let token: string;
  let bearer: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'dollhouse-totp-routes-test-'));
    store = new ConsoleTokenStore(join(testDir, 'console-token.json'));
    const entry = await store.ensureInitialized('Kermit');
    token = entry.token;
    bearer = `Bearer ${token}`;
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('auth enforcement (always-on, regardless of feature flag)', () => {
    it('rejects GET /status without a token', async () => {
      const app = await buildApp(store);
      const res = await request(app).get('/api/console/totp/status');
      expect(res.status).toBe(401);
    });

    it('rejects POST /enroll/begin without a token', async () => {
      const app = await buildApp(store);
      const res = await request(app)
        .post('/api/console/totp/enroll/begin')
        .send({});
      expect(res.status).toBe(401);
    });

    it('rejects POST /disable without a token', async () => {
      const app = await buildApp(store);
      const res = await request(app)
        .post('/api/console/totp/disable')
        .send({ code: '123456' });
      expect(res.status).toBe(401);
    });

    it('accepts a valid bearer token', async () => {
      const app = await buildApp(store);
      const res = await request(app)
        .get('/api/console/totp/status')
        .set('Authorization', bearer);
      expect(res.status).toBe(200);
    });
  });

  describe('GET /status', () => {
    it('reports not-enrolled initially', async () => {
      const app = await buildApp(store);
      const res = await request(app)
        .get('/api/console/totp/status')
        .set('Authorization', bearer);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        enrolled: false,
        enrolledAt: null,
        backupCodesRemaining: 0,
      });
    });

    it('reflects enrollment state after confirm', async () => {
      const app = await buildApp(store);
      const begin = await request(app)
        .post('/api/console/totp/enroll/begin')
        .set('Authorization', bearer)
        .send({});
      await request(app)
        .post('/api/console/totp/enroll/confirm')
        .set('Authorization', bearer)
        .send({ pendingId: begin.body.pendingId, code: currentTotpCode(begin.body.secret) });

      const status = await request(app)
        .get('/api/console/totp/status')
        .set('Authorization', bearer);
      expect(status.body.enrolled).toBe(true);
      expect(status.body.backupCodesRemaining).toBe(10);
      expect(status.body.enrolledAt).toMatch(/^\d{4}-/);
    });
  });

  describe('POST /enroll/begin', () => {
    it('returns pendingId, secret, otpauth URI, and qr svg data URL', async () => {
      const app = await buildApp(store);
      const res = await request(app)
        .post('/api/console/totp/enroll/begin')
        .set('Authorization', bearer)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.pendingId).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.body.secret).toMatch(/^[A-Z2-7]+=*$/);
      expect(res.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
      expect(res.body.qrSvgDataUrl).toMatch(/^data:image\/svg\+xml;utf8,/);
      expect(res.body.expiresAt).toBeGreaterThan(Date.now());
    });

    it('accepts an optional label override', async () => {
      const app = await buildApp(store);
      const res = await request(app)
        .post('/api/console/totp/enroll/begin')
        .set('Authorization', bearer)
        .send({ label: 'My laptop' });
      expect(res.status).toBe(200);
      expect(res.body.otpauthUri).toContain('My%20laptop');
    });

    it('returns 409 when TOTP is already enrolled', async () => {
      const app = await buildApp(store);
      // Enroll first
      const begin = await request(app)
        .post('/api/console/totp/enroll/begin')
        .set('Authorization', bearer)
        .send({});
      await request(app)
        .post('/api/console/totp/enroll/confirm')
        .set('Authorization', bearer)
        .send({ pendingId: begin.body.pendingId, code: currentTotpCode(begin.body.secret) });

      // Second begin should fail
      const res = await request(app)
        .post('/api/console/totp/enroll/begin')
        .set('Authorization', bearer)
        .send({});
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already enrolled/i);
    });
  });

  describe('POST /enroll/confirm', () => {
    it('returns 400 when pendingId or code is missing', async () => {
      const app = await buildApp(store);
      const res1 = await request(app)
        .post('/api/console/totp/enroll/confirm')
        .set('Authorization', bearer)
        .send({ pendingId: 'abc' });
      expect(res1.status).toBe(400);

      const res2 = await request(app)
        .post('/api/console/totp/enroll/confirm')
        .set('Authorization', bearer)
        .send({ code: '123456' });
      expect(res2.status).toBe(400);
    });

    it('returns 400 on wrong code', async () => {
      const app = await buildApp(store);
      const begin = await request(app)
        .post('/api/console/totp/enroll/begin')
        .set('Authorization', bearer)
        .send({});

      const res = await request(app)
        .post('/api/console/totp/enroll/confirm')
        .set('Authorization', bearer)
        .send({ pendingId: begin.body.pendingId, code: '000000' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid totp/i);
    });

    it('returns enrolled=true and backup codes on success', async () => {
      const app = await buildApp(store);
      const begin = await request(app)
        .post('/api/console/totp/enroll/begin')
        .set('Authorization', bearer)
        .send({});

      const res = await request(app)
        .post('/api/console/totp/enroll/confirm')
        .set('Authorization', bearer)
        .send({ pendingId: begin.body.pendingId, code: currentTotpCode(begin.body.secret) });
      expect(res.status).toBe(200);
      expect(res.body.enrolled).toBe(true);
      expect(res.body.backupCodes).toHaveLength(10);
      expect(res.body.enrolledAt).toMatch(/^\d{4}-/);
    });
  });

  describe('POST /disable', () => {
    async function enroll(app: express.Express): Promise<{ secret: string; backupCodes: string[] }> {
      const begin = await request(app)
        .post('/api/console/totp/enroll/begin')
        .set('Authorization', bearer)
        .send({});
      const confirm = await request(app)
        .post('/api/console/totp/enroll/confirm')
        .set('Authorization', bearer)
        .send({ pendingId: begin.body.pendingId, code: currentTotpCode(begin.body.secret) });
      return { secret: begin.body.secret, backupCodes: confirm.body.backupCodes };
    }

    it('returns 400 when code is missing', async () => {
      const app = await buildApp(store);
      await enroll(app);
      const res = await request(app)
        .post('/api/console/totp/disable')
        .set('Authorization', bearer)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 400 on wrong code and leaves enrollment intact', async () => {
      const app = await buildApp(store);
      await enroll(app);
      const res = await request(app)
        .post('/api/console/totp/disable')
        .set('Authorization', bearer)
        .send({ code: '000000' });
      expect(res.status).toBe(400);
      expect(store.isTotpEnrolled()).toBe(true);
    });

    it('clears enrollment with a valid TOTP code', async () => {
      const app = await buildApp(store);
      const { secret } = await enroll(app);
      const res = await request(app)
        .post('/api/console/totp/disable')
        .set('Authorization', bearer)
        .send({ code: currentTotpCode(secret) });
      expect(res.status).toBe(200);
      expect(res.body.enrolled).toBe(false);
      expect(store.isTotpEnrolled()).toBe(false);
    });

    it('clears enrollment with a backup code', async () => {
      const app = await buildApp(store);
      const { backupCodes } = await enroll(app);
      const res = await request(app)
        .post('/api/console/totp/disable')
        .set('Authorization', bearer)
        .send({ code: backupCodes[0] });
      expect(res.status).toBe(200);
      expect(store.isTotpEnrolled()).toBe(false);
    });

    it('returns 400 when called before enrollment', async () => {
      const app = await buildApp(store);
      const res = await request(app)
        .post('/api/console/totp/disable')
        .set('Authorization', bearer)
        .send({ code: '123456' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not.*enrolled/i);
    });
  });
});
