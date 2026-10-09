import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {
  assembleSecuredConsoleRouter, ConsoleModuleRegistry, HmacConsoleOpaqueValueService,
  InMemoryConsoleIdentityResolver, InMemoryAdminAuditWriter, InMemoryConsoleSessionStore,
  InMemoryIdempotencyStore, InMemoryRuntimeSessionControlStore, InMemoryConsoleTelemetryQuery, createOperationsModule,
} from '../../../../src/web-console/index.js';
import { InMemoryOperatorConfigStore } from '../../../../src/storage/operatorConfig/InMemoryOperatorConfigStore.js';
import type { ConsoleSessionRecord } from '../../../../src/web-console/stores/IConsoleSessionStore.js';

const NOW = new Date('2026-05-26T12:00:00Z');
const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const SUB = 'github_user-7';
const SESSION = 'opaque-operator-session';
const CAPABILITY = 'console:admin:operate' as const;
const METRICS_PATH = '/api/v1/admin/operate/metrics/http';
const SECRET = 'private-diagnostics-must-not-leak';
const opaqueValues = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 7));

async function buildApp(overrides: Partial<ConsoleSessionRecord>) {
  const sessionStore = new InMemoryConsoleSessionStore();
  await sessionStore.create({
    idHash: opaqueValues.hashOpaqueValue(SESSION), userId: USER_ID, authSub: SUB,
    csrfTokenHash: opaqueValues.hashOpaqueValue('csrf'), grantedCapabilities: ['console:self'],
    elevation: null, createdAt: new Date('2026-05-26T10:00:00Z'), lastUsedAt: NOW,
    idleExpiresAt: new Date('2026-05-26T13:00:00Z'),
    absoluteExpiresAt: new Date('2026-05-27T12:00:00Z'),
    revokedAt: null, lastIp: null, userAgent: null, ...overrides,
  });
  const source = jest.fn(() => ({
    available: true, version: 'test-version', rawPrivateDetail: SECRET,
    sessions: { active: 2, created: 4, pooled: 0, privateSessionId: SECRET },
    auth: { 'auth.validateToken': { count: 3, successCount: 2, errorCount: 1, avgMs: 50, rawError: SECRET }, [SECRET]: { count: 99 } },
    authAuthorization: { failureCount: 1, failuresByReason: { oauth_error: 1, rawError: SECRET } },
    memory: { rss: 123, secret: SECRET },
  }));
  const registry = new ConsoleModuleRegistry();
  registry.register(createOperationsModule({
    healthChecks: { database: () => true, authServer: () => true, gatekeeper: () => true, runtimeControl: () => true, securityInvalidation: () => true, apiMount: () => true },
    telemetry: new InMemoryConsoleTelemetryQuery(), operatorConfigStore: new InMemoryOperatorConfigStore(),
    httpMetrics: source, now: () => NOW,
  }));
  const audit = new InMemoryAdminAuditWriter();
  const app = express();
  app.use(assembleSecuredConsoleRouter(registry, {
    sessionStore, identityResolver: new InMemoryConsoleIdentityResolver([{ sub: SUB, userId: USER_ID, disabledAt: null, authzVersion: 2 }]),
    opaqueValues, consoleOrigin: 'https://console.example.test', adminAuditWriter: audit,
    idempotencyStore: new InMemoryIdempotencyStore(), runtimeStore: new InMemoryRuntimeSessionControlStore(), idleTimeoutMs: 60 * 60 * 1000, now: () => NOW,
  }));
  return { app, source, audit };
}

describe('HTTP diagnostics operator authorization (#3000)', () => {
  it.each([
    ['anonymous', false, {}, 401],
    ['ordinary console user without step-up', true, {}, 401],
    ['elevated administrator without operate capability', true, { grantedCapabilities: ['console:self', 'console:admin:accounts'], elevation: { capabilities: ['console:admin:accounts'], expiresAt: new Date('2026-05-26T12:30:00Z'), acr: 'urn:dollhouse:acr:admin-stepup', amr: ['otp'], authTime: new Date('2026-05-26T11:55:00Z') } }, 401],
    ['operator with expired step-up', true, { grantedCapabilities: ['console:self', CAPABILITY], elevation: { capabilities: [CAPABILITY], expiresAt: NOW, acr: 'urn:dollhouse:acr:admin-stepup', amr: ['otp'], authTime: new Date('2026-05-26T11:30:00Z') } }, 401],
  ] as const)('does not read metrics for %s', async (_label, cookie, overrides, status) => {
    const { app, source } = await buildApp(overrides);
    const call = request(app).get(METRICS_PATH);
    const response = cookie ? await call.set('Cookie', `dh_session=${SESSION}`) : await call;
    expect(response.status).toBe(status);
    expect(source).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain(SECRET);
  });

  it('allows only elevated operators, projects aggregates and writes the existing admin audit', async () => {
    const { app, source, audit } = await buildApp({
      grantedCapabilities: ['console:self', CAPABILITY],
      elevation: {
        capabilities: [CAPABILITY], expiresAt: new Date('2026-05-26T12:30:00Z'),
        acr: 'urn:dollhouse:acr:admin-stepup', amr: ['otp'], authTime: new Date('2026-05-26T11:55:00Z'),
      },
    });
    const response = await request(app).get(METRICS_PATH).set('Cookie', `dh_session=${SESSION}`);
    expect(response.status).toBe(200);
    expect(source).toHaveBeenCalledTimes(1);
    expect(response.body).toMatchObject({ available: true, sessions: { active: 2, created: 4 }, auth: { 'auth.validateToken': { count: 3, avgMs: 50 } }, authAuthorization: { failureCount: 1 } });
    expect(JSON.stringify(response.body)).not.toContain(SECRET);
    expect(audit.getEvents()).toEqual([expect.objectContaining({ operation: 'operate.metrics.http', capability: CAPABILITY, result: 'approved' })]);
  });
});
