import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveHttpSessionUserIdentity, startStreamableHttpServer, setHttpModeActive } from '../../../src/index.js';
import { createUnifiedAuthMiddleware } from '../../../src/auth/authMiddleware.js';
import { LocalDevAuthProvider } from '../../../src/auth/LocalDevAuthProvider.js';
import { env } from '../../../src/config/env.js';
import { DollhouseContainer } from '../../../src/di/Container.js';

const fallbackUserId = randomUUID();
function resolver(userId: string = randomUUID()) {
  return { resolveUserForSub: jest.fn<(sub: string, displayName?: string) => Promise<string>>().mockResolvedValue(userId) };
}

describe('configured database memory HTTP identity admission', () => {
  it('refuses auth-disabled configured HTTP before portfolio/bootstrap qualification', async () => {
    const guarded = env.DOLLHOUSE_DATABASE_MEMORY_GUARDED; const auth = env.DOLLHOUSE_AUTH_ENABLED;
    const prepare = jest.spyOn(DollhouseContainer.prototype, 'preparePortfolio');
    try {
      env.DOLLHOUSE_DATABASE_MEMORY_GUARDED = true; env.DOLLHOUSE_AUTH_ENABLED = false;
      await expect(startStreamableHttpServer()).rejects.toThrow('requires verified authentication');
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      env.DOLLHOUSE_DATABASE_MEMORY_GUARDED = guarded; env.DOLLHOUSE_AUTH_ENABLED = auth; prepare.mockRestore();
    }
  });

  it.each([undefined, { sub: '' }, { sub: '   ' }])('refuses absent or empty verified claims before DB resolution', async claims => {
    const service = resolver();
    await expect(resolveHttpSessionUserIdentity(claims, {
      requiresAuthenticatedDatabaseIdentity: true, userIdentityService: service, fallbackUserId,
    })).rejects.toThrow('requires a verified subject');
    expect(service.resolveUserForSub).not.toHaveBeenCalled();
  });

  it('refuses missing DB resolution and invalid resolved UUID instead of using the fallback', async () => {
    await expect(resolveHttpSessionUserIdentity({ sub: 'signed-subject' }, {
      requiresAuthenticatedDatabaseIdentity: true, fallbackUserId,
    })).rejects.toThrow('DB identity resolution');
    const service = resolver('path-safe-subject');
    await expect(resolveHttpSessionUserIdentity({ sub: 'signed-subject' }, {
      requiresAuthenticatedDatabaseIdentity: true, userIdentityService: service, fallbackUserId,
    })).rejects.toThrow('Invalid userId');
    expect(service.resolveUserForSub).toHaveBeenCalledTimes(1);
  });

  it('preserves ordinary auth-disabled fallback and file-mode subject resolution', async () => {
    await expect(resolveHttpSessionUserIdentity(undefined, {
      requiresAuthenticatedDatabaseIdentity: false, fallbackUserId,
    })).resolves.toEqual({ userId: fallbackUserId, resolvedDbUserId: false });
    await expect(resolveHttpSessionUserIdentity({ sub: 'ordinary-user' }, {
      requiresAuthenticatedDatabaseIdentity: false, fallbackUserId,
    })).resolves.toEqual({ userId: 'ordinary-user', resolvedDbUserId: false });
  });

  it.each(['AuthMiddleware', 'UserIdentityService'])('refuses the actual runtime startup without %s before creating any session', async missing => {
    const createServerForHttpSession = jest.fn();
    const registrations = new Map<string, unknown>([
      ['DatabaseTenantMemoryRegistry', {}],
      ['AuthMiddleware', (_req: unknown, _res: unknown, next: () => void) => next()],
      ['UserIdentityService', resolver()],
    ]);
    registrations.delete(missing);
    const container = {
      hasRegistration: (name: string) => registrations.has(name),
      resolve: (name: string) => registrations.get(name), createServerForHttpSession,
    } as unknown as DollhouseContainer;
    try {
      await expect(startStreamableHttpServer({}, { container })).rejects.toThrow('requires authentication middleware and DB identity resolution');
      expect(createServerForHttpSession).not.toHaveBeenCalled();
    } finally { setHttpModeActive(false); }
  });

  it('accepts only middleware-verified signed subjects and resolves their DB identity before session delivery', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'configured-http-subject-'));
    try {
      const provider = new LocalDevAuthProvider({ keyFilePath: path.join(directory, 'keys.json') });
      const tenant = randomUUID(); const service = resolver(tenant);
      const app = express();
      app.use(createUnifiedAuthMiddleware({ provider }));
      const createSession = jest.fn<(userId: string | undefined) => void>();
      app.post('/mcp', async (_req, res) => {
        const identity = await resolveHttpSessionUserIdentity(res.locals.authClaims, {
          requiresAuthenticatedDatabaseIdentity: true, userIdentityService: service, fallbackUserId,
        });
        createSession(identity.userId);
        res.json(identity);
      });
      expect((await request(app).post('/mcp')).status).toBe(401);
      expect((await request(app).post('/mcp').set('Authorization', 'Bearer invalid')).status).toBe(401);
      expect(service.resolveUserForSub).not.toHaveBeenCalled(); expect(createSession).not.toHaveBeenCalled();
      const token = await provider.issue('actual-signed-subject', { scopes: ['mcp'] });
      const response = await request(app).post('/mcp').set('Authorization', `Bearer ${token}`);
      expect(response.status).toBe(200); expect(response.body).toEqual({ userId: tenant, resolvedDbUserId: true });
      expect(service.resolveUserForSub).toHaveBeenCalledTimes(1);
      expect(service.resolveUserForSub).toHaveBeenCalledWith('actual-signed-subject', undefined);
      expect(createSession).toHaveBeenCalledTimes(1); expect(createSession).toHaveBeenCalledWith(tenant);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});
