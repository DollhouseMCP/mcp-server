import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import {
  assembleSecuredConsoleRouter, ConsoleModuleRegistry, HmacConsoleOpaqueValueService,
  InMemoryConsoleIdentityResolver, InMemoryAdminAuditWriter, InMemoryConsoleSessionStore,
  InMemoryIdempotencyStore, InMemoryRuntimeSessionControlStore,
} from '../../../src/web-console/index.js';
import type { IIdempotencyStore } from '../../../src/web-console/stores/IIdempotencyStore.js';
import type { ConsoleAdminRole } from '../../../src/web-console/stores/IConsoleAccountAdminStore.js';
import { capabilitiesForRoles } from '../../../src/web-console/modules/account-admin/AccountAdminRoleAuthority.js';
import { createDurableInvitationAdminModule } from '../../../src/web-console/modules/account-admin/DurableInvitationAdminModule.js';
import { createDurableInvitationAdminAuditFactory } from '../../../src/web-console/modules/account-admin/DurableInvitationAdminAudit.js';
import type { DurableInvitationAdminOptions } from '../../../src/web-console/modules/account-admin/DurableInvitationAdminService.js';
import { InMemoryRateLimitStore } from '../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';

export const invitationAdminPath = '/api/v1/admin/accounts/invitations';
export const invitationAdminBody = () => ({ username: `admin-invite-${randomUUID()}`,
  display_name: ' Rene\u0301e Example ', email: `${randomUUID()}@Example.test`, intended_roles: ['operator'], ttl_hours: 24 });
export const invitationAuditKey = { keyId: 'invitation-admin-test', key: Buffer.alloc(32, 7) };

export async function invitationAdminHarness(options: Partial<DurableInvitationAdminOptions> & Pick<DurableInvitationAdminOptions, 'store'>,
  role: ConsoleAdminRole = 'admin', elevated = true, userId = randomUUID(), idempotency: IIdempotencyStore = new InMemoryIdempotencyStore(),
  module?: ReturnType<typeof createDurableInvitationAdminModule>) {
  const now = new Date();
  const origin = 'https://console.example.test';
  const opaque = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 1));
  const sessions = new InMemoryConsoleSessionStore();
  const sessionHash = opaque.hashOpaqueValue('session');
  const capabilities = capabilitiesForRoles([role]);
  await sessions.create({ idHash: sessionHash, userId, authSub: 'github_123',
    csrfTokenHash: opaque.hashOpaqueValue('csrf'), grantedCapabilities: ['console:self', ...capabilities],
    elevation: { capabilities, acr: 'urn:dollhouse:acr:admin-stepup', amr: ['otp'],
      authTime: new Date(now.getTime() - (elevated ? 0 : 1800000)), expiresAt: new Date(now.getTime() + (elevated ? 900000 : -60000)) },
    createdAt: new Date(now.getTime() - 1800000), lastUsedAt: now, idleExpiresAt: new Date(now.getTime() + 3600000),
    absoluteExpiresAt: new Date(now.getTime() + 3600000), revokedAt: null, lastIp: null, userAgent: null });
  const auditWriter = new InMemoryAdminAuditWriter();
  const configured = { auditWriter, rateLimits: new InMemoryRateLimitStore(), publicBaseUrl: origin,
    auditFactory: createDurableInvitationAdminAuditFactory({ resolve: async () => invitationAuditKey }), ...options };
  const registry = new ConsoleModuleRegistry();
  registry.register(module ?? createDurableInvitationAdminModule(configured));
  const app = express().use(express.json({ limit: '2kb' })).use(assembleSecuredConsoleRouter(registry, {
    sessionStore: sessions, identityResolver: new InMemoryConsoleIdentityResolver([{ sub: 'github_123', userId, disabledAt: null,
      authzVersion: 1, roles: [role] }]), opaqueValues: opaque, consoleOrigin: origin,
    adminAuditWriter: configured.auditWriter, idempotencyStore: idempotency,
    runtimeStore: new InMemoryRuntimeSessionControlStore(), idleTimeoutMs: 3600000, now: () => now,
  }));
  const send = (method: 'post' | 'get', suffix = '', body?: object | string, headers: Record<string, string> = {}) =>
    request(app)[method](invitationAdminPath + suffix).set('Origin', origin).set('X-Console-Request', '1')
      .set('X-CSRF-Token', 'csrf').set('Cookie', ['dh_session=session', 'dh_csrf=csrf'])
      .set(headers).send(body);
  return { app, send, registry, idempotency, auditWriter, userId, configured };
}
