/**
 * Integration tests for GET /api/console/token/info (#1791).
 *
 * Verifies the endpoint returns masked token data, TOTP status,
 * and file path — the data source for the Auth tab.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Secret, TOTP } from 'otpauth';
import { ConsoleTokenStore } from '../../../../src/web/console/consoleToken.js';
import { createTokenRoutes } from '../../../../src/web/routes/tokenRoutes.js';
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

async function enrollTotp(store: ConsoleTokenStore): Promise<string> {
  const begin = store.beginTotpEnrollment();
  await store.confirmTotpEnrollment(begin.pendingId, currentTotpCode(begin.secret));
  return begin.secret;
}

async function buildApp(store: ConsoleTokenStore) {
  const app = express();
  app.use('/api/console/token', createTokenRoutes({ store }));
  app.use('/api/console/totp', createTotpRoutes({ store }));
  return app;
}

describe('GET /api/console/token/info', () => {
  let testDir: string;
  let store: ConsoleTokenStore;
  let token: string;
  let bearer: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'dollhouse-token-info-test-'));
    store = new ConsoleTokenStore(join(testDir, 'console-token.auth.json'));
    const entry = await store.ensureInitialized('Kermit');
    token = entry.token;
    bearer = `Bearer ${token}`;
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('requires authentication', async () => {
    const app = await buildApp(store);
    const res = await request(app).get('/api/console/token/info');
    expect(res.status).toBe(401);
  });

  it('returns masked tokens array', async () => {
    const app = await buildApp(store);
    const res = await request(app)
      .get('/api/console/token/info')
      .set('Authorization', bearer);
    expect(res.status).toBe(200);
    expect(res.body.tokens).toHaveLength(1);
    expect(res.body.tokens[0].tokenPreview).toMatch(/^[0-9a-f]{8}/);
    expect(res.body.tokens[0]).not.toHaveProperty('token');
  });

  it('returns token metadata fields', async () => {
    const app = await buildApp(store);
    const res = await request(app)
      .get('/api/console/token/info')
      .set('Authorization', bearer);
    const t = res.body.tokens[0];
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.name).toContain('Console:');
    expect(t.name).toContain('Kermit');
    expect(t.kind).toBe('console');
    expect(t.scopes).toEqual(['admin']);
    expect(t.createdAt).toBeTruthy();
    expect(t.createdVia).toBe('initial-setup');
  });

  it('returns TOTP status — not enrolled', async () => {
    const app = await buildApp(store);
    const res = await request(app)
      .get('/api/console/token/info')
      .set('Authorization', bearer);
    expect(res.body.totp).toEqual({
      enrolled: false,
      enrolledAt: null,
      backupCodesRemaining: 0,
    });
  });

  it('returns TOTP status — enrolled', async () => {
    await enrollTotp(store);
    const app = await buildApp(store);
    const res = await request(app)
      .get('/api/console/token/info')
      .set('Authorization', bearer);
    expect(res.body.totp.enrolled).toBe(true);
    expect(res.body.totp.enrolledAt).toBeTruthy();
    expect(res.body.totp.backupCodesRemaining).toBe(10);
  });

  it('serves the console during recovery and resumes protected approvals after confirming new enrollment', async () => {
    await writeFile(store.getFilePath(), '{');
    const recovered = await store.ensureInitialized('Kermit');
    const app = await buildApp(store);
    const newBearer = `Bearer ${recovered.token}`;
    const pending = {
      requestId: 'token-recovery', sessionId: 'test-session', operationDigest: 'test-digest',
      expiresAt: Date.now() + 60_000,
    };

    await request(app).get('/api/console/token/info').set('Authorization', bearer).expect(401);
    const info = await request(app).get('/api/console/token/info').set('Authorization', newBearer).expect(200);
    expect(info.body.totp).toMatchObject({ enrollmentState: 'recovering', enrolled: null });
    await expect(store.confirmApprovalFromDialog(pending, async () => ({ confirmed: true })))
      .resolves.toBe('unavailable');

    const begin = await request(app).post('/api/console/totp/enroll/begin').set('Authorization', newBearer).send({}).expect(200);
    const confirm = (code: string) => request(app).post('/api/console/totp/enroll/confirm')
      .set('Authorization', newBearer).send({ pendingId: begin.body.pendingId, code });
    await confirm('invalid').expect(400);
    await expect(store.lookupApprovalEnrollment()).resolves.toBe('unknown');
    await confirm(currentTotpCode(begin.body.secret)).expect(200);

    const enrolled = await request(app).get('/api/console/token/info').set('Authorization', newBearer).expect(200);
    expect(enrolled.body.totp.enrolled).toBe(true);
    expect(enrolled.body.totp).not.toHaveProperty('enrollmentState');
    await expect(store.confirmApprovalFromDialog(pending, async () => ({
      confirmed: true, code: currentTotpCode(begin.body.secret),
    }))).resolves.toBe('approved');
  });

  it('returns the token file path', async () => {
    const app = await buildApp(store);
    const res = await request(app)
      .get('/api/console/token/info')
      .set('Authorization', bearer);
    expect(res.body.filePath).toContain('console-token.auth.json');
  });

  it('does not leak the full token value', async () => {
    const app = await buildApp(store);
    const res = await request(app)
      .get('/api/console/token/info')
      .set('Authorization', bearer);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(token);
  });
});
