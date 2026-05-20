import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createUnifiedAuthMiddleware, withJwtFallthrough } from '../../../src/auth/authMiddleware.js';
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

  describe('header-only auth (query-string fallback removed in §8.1)', () => {
    it('rejects requests that try to authenticate via ?token= query parameter', async () => {
      const validateFn = jest.fn(async () => ({
        ok: true,
        claims: { sub: 'bob' },
      }) as AuthResult);
      const provider = createMockProvider(validateFn);
      const app = createTestApp(provider);

      const res = await request(app).get('/api/data?token=valid-token');
      expect(res.status).toBe(401);
      // The provider should NOT have been called — the middleware never
      // extracted a token from the query string.
      expect(validateFn).not.toHaveBeenCalled();
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

/**
 * Phase 9 R1 / H1 regression: a unified-auth middleware mounted on /api
 * before the web console's console-token middleware MUST fall through
 * (instead of 401-ing) on requests that aren't JWT-shaped — otherwise
 * the legitimate 64-hex console token the browser injects gets rejected
 * before the console-token middleware ever runs.
 */
// Build an app where the unified middleware is wrapped + a downstream
// "fallback" middleware sets a sentinel header so the test can tell
// whether the request reached it.
function createChainedApp(
  provider: IAuthProvider,
): express.Express {
  const app = express();
  app.use(express.json());
  const strict = createUnifiedAuthMiddleware({ provider });
  app.use('/api', withJwtFallthrough(strict));
  app.use('/api', (_req, res, next) => {
    res.setHeader('x-fallback-reached', 'true');
    next();
  });
  app.get('/api/data', (_req, res) => {
    res.json({ data: 'ok', claims: res.locals.authClaims });
  });
  return app;
}

describe('withJwtFallthrough', () => {
  it('falls through to next middleware when no Authorization header is present', async () => {
    const provider = createMockProvider(async () => ({ ok: true, claims: { sub: 'user' } }));
    const app = createChainedApp(provider);

    const res = await request(app).get('/api/data');
    expect(res.headers['x-fallback-reached']).toBe('true');
    // Strict middleware never set claims because we never reached it.
    expect(res.body.claims).toBeUndefined();
  });

  it('falls through when the Bearer is a 64-hex console token (not JWT-shaped)', async () => {
    const provider = createMockProvider(async () => {
      throw new Error('strict middleware should never run for console tokens');
    });
    const app = createChainedApp(provider);

    const consoleToken = 'a'.repeat(64); // 64 hex chars, no dots
    const res = await request(app)
      .get('/api/data')
      .set('Authorization', `Bearer ${consoleToken}`);
    expect(res.headers['x-fallback-reached']).toBe('true');
  });

  it('falls through on a non-Bearer Authorization header', async () => {
    const provider = createMockProvider(async () => {
      throw new Error('strict middleware should never run for non-Bearer auth');
    });
    const app = createChainedApp(provider);
    const res = await request(app)
      .get('/api/data')
      .set('Authorization', 'Basic dXNlcjpwYXNz');
    expect(res.headers['x-fallback-reached']).toBe('true');
  });

  it('delegates a JWT-shaped Bearer to the strict middleware (success path)', async () => {
    const provider = createMockProvider(async () => ({
      ok: true,
      claims: { sub: 'alice' },
    }));
    const app = createChainedApp(provider);

    // Three base64url segments separated by dots — JWT shape.
    const jwtShaped = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.signature';
    const res = await request(app)
      .get('/api/data')
      .set('Authorization', `Bearer ${jwtShaped}`);
    expect(res.status).toBe(200);
    expect(res.body.claims?.sub).toBe('alice');
  });

  it('forged JWT (right shape, wrong signature) still gets 401 — no bypass', async () => {
    const provider = createMockProvider(async () => ({ ok: false, reason: 'bad signature' }));
    const app = createChainedApp(provider);

    const forgedJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdHRhY2tlciJ9.forged';
    const res = await request(app)
      .get('/api/data')
      .set('Authorization', `Bearer ${forgedJwt}`);
    // The fallback middleware was never reached because the strict
    // middleware took over and 401'd. This is the critical assertion:
    // a JWT-shaped token can't bypass strict validation by piggybacking
    // on the fallthrough.
    expect(res.status).toBe(401);
    expect(res.headers['x-fallback-reached']).toBeUndefined();
  });
});
