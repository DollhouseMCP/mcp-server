import { describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Secret, TOTP } from 'otpauth';

import { mountAdminTotpInteractionRoutes } from '../../../../../src/auth/embedded-as/totp/AdminTotpInteractionRoutes.js';
import {
  ADMIN_TOTP_PARAMETERS,
  AdminTotpService,
} from '../../../../../src/auth/embedded-as/totp/AdminTotpService.js';
import { InMemoryAuthStorageLayer } from '../../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { InMemoryRateLimitStore } from '../../../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import { AeadSecretEncryptionService } from '../../../../../src/web-console/security/SecretEncryption.js';
import { InMemoryConsoleIdentityResolver } from '../../../../../src/web-console/identity/InMemoryConsoleIdentityResolver.js';
import { InMemoryConsoleFactorStore } from '../../../../../src/web-console/stores/InMemoryConsoleFactorStore.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const OTHER_USER_ID = '118f3d47-73ae-7f10-a0de-0742618d4fb1';
const AUTH_SUB = 'local_admin';
const OTHER_AUTH_SUB = 'local_other';
const NOW = new Date('2026-05-27T12:00:00.000Z');

function buildFixture(options: { disabled?: boolean; unauthenticated?: boolean; rateLimitStore?: InMemoryRateLimitStore } = {}) {
  const storage = new InMemoryAuthStorageLayer();
  const factors = new InMemoryConsoleFactorStore();
  let currentSub: string | null = options.unauthenticated ? null : AUTH_SUB;
  const service = new AdminTotpService({
    authStorage: storage,
    factorStore: factors,
    secretEncryption: new AeadSecretEncryptionService({
      keyId: 'test-key',
      key: Buffer.alloc(32, 7),
    }),
    now: () => NOW,
  });
  const app = express();
  mountAdminTotpInteractionRoutes(app, {
    storage,
    totpService: service,
    identityResolver: new InMemoryConsoleIdentityResolver([{
      sub: AUTH_SUB,
      userId: USER_ID,
      disabledAt: options.disabled ? new Date('2026-05-27T11:00:00.000Z') : null,
      authzVersion: 1,
    }, {
      sub: OTHER_AUTH_SUB,
      userId: OTHER_USER_ID,
      disabledAt: null,
      authzVersion: 1,
    }]),
    rateLimitStore: options.rateLimitStore,
    ensureInitialized: () => Promise.resolve({
      provider: {
        Session: {
          get() { return Promise.resolve(currentSub ? { accountId: currentSub } : {}); },
        },
      },
    }),
  });
  return {
    app,
    service,
    factors,
    storage,
    setSessionSub(sub: string | null) { currentSub = sub; },
  };
}

describe('AdminTotpInteractionRoutes', () => {
  it('enrollment confirm creates an active factor and one-time backup codes', async () => {
    const { app, service, factors } = buildFixture();

    const enroll = await request(app).get('/auth/totp/enroll?label=Admin%20Console');
    expect(enroll.status).toBe(200);
    const pendingId = match(enroll.text, /name="pending_id" value="([^"]+)"/);
    const csrf = match(enroll.text, /name="csrf_token" value="([^"]+)"/);
    const secret = match(enroll.text, /<code>([A-Z2-7]+)<\/code>/);

    const confirmed = await request(app)
      .post('/auth/totp/enroll/confirm')
      .type('form')
      .send({ pending_id: pendingId, csrf_token: csrf, code: totpCodeAt(secret) });

    expect(confirmed.status).toBe(200);
    const backupCodes = [...confirmed.text.matchAll(/<code>([0-9A-Z]+)<\/code>/g)].map((m) => m[1]);
    expect(backupCodes).toHaveLength(10);
    await expect(factors.getTotpStatus(USER_ID)).resolves.toMatchObject({ enrolled: true });
    await expect(service.prove(USER_ID, backupCodes[0])).resolves.toMatchObject({ ok: true, method: 'backup' });
    await expect(service.prove(USER_ID, backupCodes[0])).resolves.toEqual({ ok: false });
  });

  it('disable confirm requires a valid proof before disabling the factor', async () => {
    const { app, factors } = buildFixture();
    const enroll = await request(app).get('/auth/totp/enroll?label=Admin%20Console');
    const pendingId = match(enroll.text, /name="pending_id" value="([^"]+)"/);
    const enrollCsrf = match(enroll.text, /name="csrf_token" value="([^"]+)"/);
    const secret = match(enroll.text, /<code>([A-Z2-7]+)<\/code>/);
    await request(app)
      .post('/auth/totp/enroll/confirm')
      .type('form')
      .send({ pending_id: pendingId, csrf_token: enrollCsrf, code: totpCodeAt(secret) });

    const disable = await request(app).get('/auth/totp/disable');
    const disableId = match(disable.text, /name="disable_id" value="([^"]+)"/);
    const disableCsrf = match(disable.text, /name="csrf_token" value="([^"]+)"/);
    const failed = await request(app)
      .post('/auth/totp/disable/confirm')
      .type('form')
      .send({ disable_id: disableId, csrf_token: disableCsrf, code: '000000' });

    expect(failed.status).toBe(400);
    await expect(factors.getTotpStatus(USER_ID)).resolves.toMatchObject({ enrolled: true });

    const nextCsrf = match(failed.text, /name="csrf_token" value="([^"]+)"/);
    const disabled = await request(app)
      .post('/auth/totp/disable/confirm')
      .type('form')
      .send({ disable_id: disableId, csrf_token: nextCsrf, code: totpCodeAt(secret) });

    expect(disabled.status).toBe(200);
    await expect(factors.getTotpStatus(USER_ID)).resolves.toMatchObject({ enrolled: false });
  });

  it('rejects missing and cross-user route CSRF tokens', async () => {
    const fixture = buildFixture();
    const enroll = await request(fixture.app).get('/auth/totp/enroll?label=Admin%20Console');
    const pendingId = match(enroll.text, /name="pending_id" value="([^"]+)"/);
    const csrf = match(enroll.text, /name="csrf_token" value="([^"]+)"/);
    const secret = match(enroll.text, /<code>([A-Z2-7]+)<\/code>/);

    const missing = await request(fixture.app)
      .post('/auth/totp/enroll/confirm')
      .type('form')
      .send({ pending_id: pendingId, code: totpCodeAt(secret) });
    expect(missing.status).toBe(403);

    fixture.setSessionSub(OTHER_AUTH_SUB);
    const crossUser = await request(fixture.app)
      .post('/auth/totp/enroll/confirm')
      .type('form')
      .send({ pending_id: pendingId, csrf_token: csrf, code: totpCodeAt(secret) });
    expect(crossUser.status).toBe(403);
  });

  it('requires an authenticated enabled principal for TOTP routes', async () => {
    await expect(request(buildFixture({ unauthenticated: true }).app).get('/auth/totp/enroll'))
      .resolves.toMatchObject({ status: 401 });
    await expect(request(buildFixture({ disabled: true }).app).get('/auth/totp/enroll'))
      .resolves.toMatchObject({ status: 401 });
  });

  it('surfaces route-level enrollment validation and replay failures', async () => {
    const { app } = buildFixture();
    await expect(request(app).get('/auth/totp/enroll?label=%3Cscript%3E'))
      .resolves.toMatchObject({ status: 400, body: { error: 'invalid_label' } });

    const enroll = await request(app).get('/auth/totp/enroll?label=Admin%20Console');
    const pendingId = match(enroll.text, /name="pending_id" value="([^"]+)"/);
    const csrf = match(enroll.text, /name="csrf_token" value="([^"]+)"/);
    const secret = match(enroll.text, /<code>([A-Z2-7]+)<\/code>/);
    const first = await request(app)
      .post('/auth/totp/enroll/confirm')
      .type('form')
      .send({ pending_id: pendingId, csrf_token: csrf, code: totpCodeAt(secret) });
    expect(first.status).toBe(200);

    await expect(request(app).get('/auth/totp/enroll?label=Admin%20Console'))
      .resolves.toMatchObject({ status: 409, body: { error: 'already_enrolled' } });
    const replay = await request(app)
      .post('/auth/totp/enroll/confirm')
      .type('form')
      .send({ pending_id: pendingId, csrf_token: csrf, code: totpCodeAt(secret) });
    expect(replay.status).toBe(403);
  });

  it('rate-limits enrollment and disable proof failures', async () => {
    const enrollFixture = buildFixture({ rateLimitStore: new InMemoryRateLimitStore() });
    const enroll = await request(enrollFixture.app).get('/auth/totp/enroll?label=Admin%20Console');
    const pendingId = match(enroll.text, /name="pending_id" value="([^"]+)"/);
    const csrf = match(enroll.text, /name="csrf_token" value="([^"]+)"/);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(enrollFixture.app)
        .post('/auth/totp/enroll/confirm')
        .type('form')
        .send({ pending_id: pendingId, csrf_token: csrf, code: '000000' });
    }
    await expect(request(enrollFixture.app)
      .post('/auth/totp/enroll/confirm')
      .type('form')
      .send({ pending_id: pendingId, csrf_token: csrf, code: '000000' }))
      .resolves.toMatchObject({ status: 429 });

    const disableFixture = buildFixture({ rateLimitStore: new InMemoryRateLimitStore() });
    const enrolled = await enrollFactor(disableFixture.app);
    const disable = await request(disableFixture.app).get('/auth/totp/disable');
    const disableId = match(disable.text, /name="disable_id" value="([^"]+)"/);
    let disableCsrf = match(disable.text, /name="csrf_token" value="([^"]+)"/);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await request(disableFixture.app)
        .post('/auth/totp/disable/confirm')
        .type('form')
        .send({ disable_id: disableId, csrf_token: disableCsrf, code: '000000' });
      disableCsrf = /name="csrf_token" value="([^"]+)"/.exec(failed.text)?.[1] ?? disableCsrf;
    }
    await expect(request(disableFixture.app)
      .post('/auth/totp/disable/confirm')
      .type('form')
      .send({ disable_id: disableId, csrf_token: disableCsrf, code: totpCodeAt(enrolled.secret) }))
      .resolves.toMatchObject({ status: 429 });
  });

  it('disables via backup code and records method detail', async () => {
    const { app, storage, factors } = buildFixture();
    const enrolled = await enrollFactor(app);
    const disable = await request(app).get('/auth/totp/disable');
    const disableId = match(disable.text, /name="disable_id" value="([^"]+)"/);
    const disableCsrf = match(disable.text, /name="csrf_token" value="([^"]+)"/);

    const disabled = await request(app)
      .post('/auth/totp/disable/confirm')
      .type('form')
      .send({ disable_id: disableId, csrf_token: disableCsrf, code: enrolled.backupCodes[0] });

    expect(disabled.status).toBe(200);
    await expect(factors.getTotpStatus(USER_ID)).resolves.toMatchObject({ enrolled: false });
    await expect(storage.listIdentityEvents({ type: 'auth.admin_totp.disabled' }))
      .resolves.toMatchObject([{ details: { method: 'backup' } }]);
  });
});

async function enrollFactor(app: express.Express): Promise<{ secret: string; backupCodes: string[] }> {
  const enroll = await request(app).get('/auth/totp/enroll?label=Admin%20Console');
  const pendingId = match(enroll.text, /name="pending_id" value="([^"]+)"/);
  const csrf = match(enroll.text, /name="csrf_token" value="([^"]+)"/);
  const secret = match(enroll.text, /<code>([A-Z2-7]+)<\/code>/);
  const confirmed = await request(app)
    .post('/auth/totp/enroll/confirm')
    .type('form')
    .send({ pending_id: pendingId, csrf_token: csrf, code: totpCodeAt(secret) });
  const backupCodes = [...confirmed.text.matchAll(/<code>([0-9A-Z]+)<\/code>/g)].map((m) => m[1]);
  return { secret, backupCodes };
}

function totpCodeAt(base32Secret: string): string {
  const totp = new TOTP({
    issuer: ADMIN_TOTP_PARAMETERS.issuer,
    label: 'Admin Console',
    algorithm: ADMIN_TOTP_PARAMETERS.algorithm,
    digits: ADMIN_TOTP_PARAMETERS.digits,
    period: ADMIN_TOTP_PARAMETERS.periodSeconds,
    secret: Secret.fromBase32(base32Secret),
  });
  return totp.generate({ timestamp: NOW.getTime() });
}

function match(value: string, pattern: RegExp): string {
  const found = pattern.exec(value);
  expect(found).not.toBeNull();
  return found?.[1] ?? '';
}
