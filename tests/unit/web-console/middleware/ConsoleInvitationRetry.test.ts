import { logger } from '../../../../src/utils/logger.js';
import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {
  assembleSecuredConsoleRouter, ConsoleModuleRegistry, HmacConsoleOpaqueValueService,
  InMemoryConsoleIdentityResolver, InMemoryAdminAuditWriter, InMemoryConsoleSessionStore,
  InMemoryIdempotencyStore, InMemoryRuntimeSessionControlStore, type ConsoleRouteDefinition,
} from '../../../../src/web-console/index.js';
import { AccountAdminInviteService } from '../../../../src/web-console/modules/account-admin/AccountAdminInviteService.js';
import { executeWithConsoleIdempotency } from '../../../../src/web-console/middleware/ConsoleIdempotency.js';
import type { ConsoleRequest } from '../../../../src/web-console/platform/ConsolePlatformTypes.js';
import { ConsoleInvitationContentionError } from '../../../../src/web-console/stores/ConsoleStoreValidation.js';
import type { IAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/IAuthStorageLayer.js';
import type { IAccountAdminMutationTransactionRunner } from '../../../../src/web-console/modules/account-admin/AccountAdminMutationTransaction.js';

it.each([false, true])('permits same-key retry through the secured invite service after contention (failed audit: %s)', async failAudit => {
  const now = new Date();
  const origin = 'https://console.example.test';
  const userId = randomUUID();
  const sub = 'github_123';
  const capability = 'console:admin:accounts' as const;
  const opaque = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 1));
  const sessions = new InMemoryConsoleSessionStore();
  const sessionHash = opaque.hashOpaqueValue('session');
  await sessions.create({ idHash: sessionHash, userId, authSub: sub,
    csrfTokenHash: opaque.hashOpaqueValue('csrf'), grantedCapabilities: ['console:self', capability],
    elevation: { capabilities: [capability], acr: 'urn:dollhouse:acr:admin-stepup', amr: ['otp'],
      authTime: now, expiresAt: new Date(now.getTime() + 900000) },
    createdAt: now, lastUsedAt: now, idleExpiresAt: new Date(now.getTime() + 3600000),
    absoluteExpiresAt: new Date(now.getTime() + 3600000), revokedAt: null, lastIp: null, userAgent: null });
  const audit = new InMemoryAdminAuditWriter();
  if (failAudit) jest.spyOn(audit, 'write').mockRejectedValueOnce(new Error('audit failed with sensitive database detail'));
  const issuer = { issueInvite: jest.fn(async () => ({ userId: randomUUID(), primarySub: 'local_invited',
    inviteUrl: 'https://console.example.test/manual-link', expiresAt: new Date(now.getTime() + 900000) })) };
  issuer.issueInvite.mockRejectedValueOnce(new ConsoleInvitationContentionError());
  const transactionRunner: IAccountAdminMutationTransactionRunner = {
    run: async operation => operation({ writeAdminAuditEvent: (event: Parameters<typeof audit.write>[0]) => audit.write(event) } as never),
  };
  const service = new AccountAdminInviteService({ inviteIssuer: issuer, now: () => now,
    authStorage: { getBootstrapState: async () => ({ completed: true }) } as unknown as IAuthStorageLayer,
    transactionRunner });
  const route: ConsoleRouteDefinition = { method: 'POST', path: '/api/v1/admin/accounts/users/invite',
    audience: 'admin', requiredCapability: capability, elevation: 'admin_30m', privacyClass: 'account_metadata',
    idempotency: 'required', auditOperation: 'accounts.users.invite', auditExecution: 'handler_transaction',
    privacyProjector: value => value, handler: req => service.invite(req, route) };
  const registry = new ConsoleModuleRegistry();
  registry.register({ id: 'invite_retry', apiVersion: 'v1', capabilities: [capability],
    auditOperations: [{ id: 'accounts.users.invite' }], routes: [route] });
  const idempotency = new InMemoryIdempotencyStore();
  const reportInternalError = jest.fn((_error: unknown, _correlationId: string) => { throw new Error('diagnostic sink unavailable'); });
  const logError = jest.spyOn(logger, 'error').mockImplementation(() => {});
  const app = express().use(express.json()).use(assembleSecuredConsoleRouter(registry, {
    reportInternalError, sessionStore: sessions, identityResolver: new InMemoryConsoleIdentityResolver([{ sub, userId, disabledAt: null,
      authzVersion: 1, roles: ['admin'] }]), opaqueValues: opaque, consoleOrigin: origin, adminAuditWriter: audit,
    idempotencyStore: idempotency, runtimeStore: new InMemoryRuntimeSessionControlStore(), idleTimeoutMs: 3600000, now: () => now,
  }));
  const key = randomUUID();
  const send = () => request(app).post(route.path).set('Origin', origin).set('X-Console-Request', '1')
    .set('X-CSRF-Token', 'csrf').set('Idempotency-Key', key).set('Cookie', ['dh_session=session', 'dh_csrf=csrf'])
    .send({ username: 'invited', email: 'invited@example.test' });
  const failed = await send();
  expect(failed.status).toBe(503);
  expect(failed.body.code).toBe('invitation_busy');
  expect(failed.text).not.toContain('duplicate');
  expect(failed.text).not.toContain('55P03');
  expect(reportInternalError).toHaveBeenCalledTimes(failAudit ? 1 : 0);
  if (failAudit) {
    expect(reportInternalError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Mandatory administrative audit failed during invitation contention' }), expect.any(String));
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('Mandatory administrative audit failed'));
    expect(JSON.stringify(logError.mock.calls)).not.toContain('sensitive database detail');
    expect(reportInternalError.mock.calls[0][0]).not.toHaveProperty('cause');
    expect(failed.text).not.toContain('sensitive database detail');
  }
  logError.mockRestore();
  expect(await idempotency.find(sessionHash, key, now)).toBeNull();
  expect((await send()).status).toBe(201);
  expect((await send()).status).toBe(201);
  expect(issuer.issueInvite).toHaveBeenCalledTimes(2);
  expect(audit.getEvents()).toEqual(expect.arrayContaining([expect.objectContaining({ result: 'approved' })]));
});

it('does not release ambiguous exceptions, arbitrary wrappers or ordinary 503 results', async () => {
  const route = { method: 'POST', path: '/api/v1/admin/accounts/users/invite', idempotency: 'required' } as ConsoleRouteDefinition;
  for (const outcome of [new Error('unknown outcome'), new AggregateError([new ConsoleInvitationContentionError()], 'unrelated wrapper'), { status: 503 }]) {
    const key = randomUUID();
    const store = new InMemoryIdempotencyStore();
    const req = { originalUrl: route.path, params: {}, query: {}, body: {}, headers: { 'idempotency-key': key },
      consoleAuthentication: { sessionIdHash: Buffer.alloc(32, 2) } } as unknown as ConsoleRequest;
    let calls = 0;
    const execute = () => executeWithConsoleIdempotency(route, req, store, async () => {
      calls++;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }, new Date());
    if (outcome instanceof Error) {
      await expect(execute()).rejects.toBe(outcome);
      expect(await execute()).toMatchObject({ kind: 'problem', problem: { status: 409 } });
    } else {
      expect(await execute()).toMatchObject({ kind: 'result', result: { status: 503 } });
      expect(await execute()).toMatchObject({ kind: 'result', interceptedAuditResult: 'replayed', result: { status: 503 } });
    }
    expect(calls).toBe(1);
  }
});
