/**
 * assertHasRole — H7 unit tests.
 *
 * Locks the contract for the role-gating middleware:
 *   - 401 when authClaims missing (no auth ran)
 *   - 403 when authClaims present but role not in claims
 *   - next() when role IS present
 *   - 403 body echoes required_role for diagnostics
 *
 * Doesn't go through Express routing — exercises the middleware
 * directly with mock req/res/next. Same approach the existing
 * authMiddleware tests use for fast unit-level coverage.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import { assertHasRole } from '../../../src/auth/assertHasRole.js';
import type { AuthClaims } from '../../../src/auth/IAuthProvider.js';

function makeReq(): Request {
  return {} as Request;
}

function makeRes(claims?: AuthClaims): { res: Response; status: jest.Mock; json: jest.Mock } {
  const status = jest.fn().mockReturnThis();
  const json = jest.fn();
  const res = {
    locals: claims ? { authClaims: claims } : {},
    status,
    json,
  } as unknown as Response;
  return { res, status, json };
}

function makeNext(): jest.Mock {
  return jest.fn();
}

describe('assertHasRole', () => {
  it('calls next() when authClaims contains the required role', () => {
    const claims: AuthClaims = {
      sub: 'github_42',
      iss: 'http://test',
      aud: 'mcp',
      iat: 0,
      exp: 0,
      roles: ['admin'],
    };
    const { res } = makeRes(claims);
    const next = makeNext();
    assertHasRole('admin')(makeReq(), res, next as unknown as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('responds 403 when authClaims is present but role is missing', () => {
    const claims: AuthClaims = {
      sub: 'github_42',
      iss: 'http://test',
      aud: 'mcp',
      iat: 0,
      exp: 0,
      roles: ['user'],
    };
    const { res, status, json } = makeRes(claims);
    const next = makeNext();
    assertHasRole('admin')(makeReq(), res, next as unknown as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      error: expect.stringMatching(/forbidden/i),
      required_role: 'admin',
    });
  });

  it('responds 403 when roles claim is undefined', () => {
    const claims: AuthClaims = {
      sub: 'github_42',
      iss: 'http://test',
      aud: 'mcp',
      iat: 0,
      exp: 0,
      // roles intentionally omitted
    };
    const { res, status } = makeRes(claims);
    const next = makeNext();
    assertHasRole('admin')(makeReq(), res, next as unknown as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it('responds 401 when authClaims is absent (auth middleware did not run)', () => {
    const { res, status, json } = makeRes(); // no claims
    const next = makeNext();
    assertHasRole('admin')(makeReq(), res, next as unknown as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      error: expect.stringMatching(/authentication/i),
      required_role: 'admin',
    });
  });

  it('responds 403 when roles claim is a non-array (guard against malformed provider output)', () => {
    // Round 6 review fixup: the AuthClaims type is string[] | undefined,
    // but assertHasRole is exported and any future IAuthProvider may
    // mis-populate. The guard must yield a clean 403, not a 500.
    const malformed = {
      sub: 'github_42',
      iss: 'http://test',
      aud: 'mcp',
      iat: 0,
      exp: 0,
      // Cast to bypass TS — simulates a runtime mishap.
      roles: 'admin' as unknown as string[],
    };
    const { res, status } = makeRes(malformed);
    const next = makeNext();
    assertHasRole('admin')(makeReq(), res, next as unknown as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it('responds 403 when roles claim is an object (guard against malformed provider output)', () => {
    const malformed = {
      sub: 'github_42',
      iss: 'http://test',
      aud: 'mcp',
      iat: 0,
      exp: 0,
      roles: { admin: true } as unknown as string[],
    };
    const { res, status } = makeRes(malformed);
    const next = makeNext();
    assertHasRole('admin')(makeReq(), res, next as unknown as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });
});
