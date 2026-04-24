import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createUnifiedAuthMiddleware } from '../../../src/auth/authMiddleware.js';
import type { IAuthProvider, AuthResult } from '../../../src/auth/IAuthProvider.js';

function createMockProvider(validateFn: (token: string) => Promise<AuthResult>): IAuthProvider {
  return {
    name: 'mock',
    validate: validateFn,
  };
}

function createTestApp(provider: IAuthProvider, publicPaths?: string[]): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', createUnifiedAuthMiddleware({ provider, publicPaths }));
  app.get('/api/data', (_req, res) => {
    res.json({ data: 'protected', claims: res.locals.authClaims });
  });
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('createUnifiedAuthMiddleware', () => {
  describe('missing token', () => {
    it('should return 401 when no Authorization header is present', async () => {
      const provider = createMockProvider(async () => ({ ok: true, claims: { sub: 'user' } }));
      const app = createTestApp(provider);

      const res = await request(app).get('/api/data');
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Authentication required');
    });
  });

  describe('invalid token', () => {
    it('should return 401 for a token that fails validation', async () => {
      const provider = createMockProvider(async () => ({ ok: false, reason: 'bad signature' }));
      const app = createTestApp(provider);

      const res = await request(app)
        .get('/api/data')
        .set('Authorization', 'Bearer bad-token');
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('bad signature');
    });
  });

  describe('valid token', () => {
    it('should pass through and attach claims to res.locals', async () => {
      const provider = createMockProvider(async () => ({
        ok: true,
        claims: { sub: 'alice', displayName: 'Alice', email: 'alice@example.com' },
      }));
      const app = createTestApp(provider);

      const res = await request(app)
        .get('/api/data')
        .set('Authorization', 'Bearer valid-token');
      expect(res.status).toBe(200);
      expect(res.body.claims.sub).toBe('alice');
      expect(res.body.claims.displayName).toBe('Alice');
      expect(res.body.claims.email).toBe('alice@example.com');
    });
  });

  describe('query parameter fallback', () => {
    it('should accept token from query parameter', async () => {
      const provider = createMockProvider(async () => ({
        ok: true,
        claims: { sub: 'bob' },
      }));
      const app = createTestApp(provider);

      const res = await request(app).get('/api/data?token=valid-token');
      expect(res.status).toBe(200);
      expect(res.body.claims.sub).toBe('bob');
    });
  });

  describe('public paths', () => {
    it('should bypass auth for public paths', async () => {
      const validateFn = jest.fn(async () => ({ ok: false, reason: 'should not be called' }) as AuthResult);
      const provider = createMockProvider(validateFn);
      const app = createTestApp(provider, ['/api/health']);

      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(validateFn).not.toHaveBeenCalled();
    });

    it('should still require auth for non-public paths', async () => {
      const provider = createMockProvider(async () => ({ ok: false, reason: 'denied' }));
      const app = createTestApp(provider, ['/api/health']);

      const res = await request(app)
        .get('/api/data')
        .set('Authorization', 'Bearer token');
      expect(res.status).toBe(401);
    });
  });

  describe('bearer prefix', () => {
    it('should reject Authorization header without Bearer prefix', async () => {
      const provider = createMockProvider(async () => ({ ok: true, claims: { sub: 'user' } }));
      const app = createTestApp(provider);

      const res = await request(app)
        .get('/api/data')
        .set('Authorization', 'Basic dXNlcjpwYXNz');
      expect(res.status).toBe(401);
    });
  });
});
