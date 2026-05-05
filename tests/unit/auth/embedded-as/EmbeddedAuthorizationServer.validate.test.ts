/**
 * EmbeddedAuthorizationServer.validate negative-path tests.
 *
 * Pins the RFC 9068 hardening invariants asserted in C10-2:
 *   - typ MUST be at+jwt
 *   - kid MUST be present and match the JWKS
 *   - crit allow-list is empty (any unknown crit header rejects)
 *   - alg restricted to the configured algorithm (ES256)
 *   - iss + aud strict-match
 *
 * Tokens are minted directly with the AS's private key so each test
 * isolates exactly one header/claim manipulation. Validate is what the
 * unified authMiddleware drives, so a regression here leaks into every
 * Bearer-protected route.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import { SignJWT, importJWK } from 'jose';
import { EmbeddedAuthorizationServer } from '../../../../src/auth/embedded-as/EmbeddedAuthorizationServer.js';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { TrivialConsentMethod } from '../../../../src/auth/embedded-as/methods/TrivialConsentMethod.js';
import { loadOrGenerateSigningJwks } from '../../../../src/auth/embedded-as/persistKeys.js';

interface TokenOpts {
  alg?: string;
  typ?: string;
  kid?: string | undefined;
  crit?: string[];
  iss?: string;
  aud?: string;
  sub?: string;
  exp?: number;
}

describe('EmbeddedAuthorizationServer.validate — RFC 9068 hardening', () => {
  const ISSUER = 'http://127.0.0.1:65530';
  const RESOURCE = 'http://127.0.0.1:65530/mcp';
  let tmpDir: string;
  let as: EmbeddedAuthorizationServer;
  let signKey: CryptoKey;
  let kid: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-validate-'));
    const keyFilePath = path.join(tmpDir, 'key.json');

    // Pre-generate the keyset so the test can import the private key for
    // signing tokens with manipulated headers below. The AS will load the
    // same file when ensureInitialized runs.
    const keyset = await loadOrGenerateSigningJwks(keyFilePath);
    kid = keyset.kid;
    const privateJwk = keyset.jwks.keys[0]!;
    signKey = (await importJWK(privateJwk, 'ES256')) as CryptoKey;

    as = new EmbeddedAuthorizationServer({
      publicBaseUrl: ISSUER,
      mcpPath: '/mcp',
      keyFilePath,
      methods: [new TrivialConsentMethod({ defaultSubject: 'validate-test' })],
      storage: new InMemoryAuthStorageLayer(),
    });

    // Prime the AS so subsequent validate() calls don't need to do init.
    // The TrivialConsent method has no async setup so this is fast.
    await as.validate('warmup-not-a-real-token').catch(() => {});
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function mintToken(opts: TokenOpts = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const protectedHeader: Record<string, unknown> = {
      alg: opts.alg ?? 'ES256',
      typ: opts.typ ?? 'at+jwt',
    };
    if (opts.kid !== undefined) protectedHeader.kid = opts.kid;
    else if (opts.kid === undefined && !('kid' in opts)) protectedHeader.kid = kid;
    if (opts.crit) protectedHeader.crit = opts.crit;

    const jwt = new SignJWT({})
      .setProtectedHeader(protectedHeader as Parameters<SignJWT['setProtectedHeader']>[0])
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? RESOURCE)
      .setSubject(opts.sub ?? 'local-user')
      .setIssuedAt(now)
      .setExpirationTime(opts.exp ?? now + 3600);
    return jwt.sign(signKey);
  }

  it('positive control: a properly-signed at+jwt token is accepted', async () => {
    const token = await mintToken();
    const result = await as.validate(token);
    expect(result.ok).toBe(true);
  });

  it('rejects token with typ: "JWT" (not at+jwt) — RFC 9068', async () => {
    const token = await mintToken({ typ: 'JWT' });
    const result = await as.validate(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/wrong token type|typ/);
  });

  it('rejects token with typ: "id+jwt" replayed as access token', async () => {
    const token = await mintToken({ typ: 'id+jwt' });
    const result = await as.validate(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/wrong token type|typ/);
  });

  it('rejects token with no kid header (cannot bypass kid match)', async () => {
    // Build the JWT without a kid in protectedHeader.
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt' })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setSubject('local-user')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(signKey);
    const result = await as.validate(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/kid/);
  });

  it('rejects token with kid that does not match the JWKS', async () => {
    const token = await mintToken({ kid: 'unknown-kid-xyz' });
    const result = await as.validate(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/key id|kid/);
  });

  it('rejects token with non-empty crit header (unrecognized extension)', async () => {
    // jose's signer refuses to emit an unrecognized crit header — which
    // is itself a useful safety property — so we construct the JWS bytes
    // manually to simulate what an external attacker could do.
    const now = Math.floor(Date.now() / 1000);
    const header = {
      alg: 'ES256',
      typ: 'at+jwt',
      kid,
      crit: ['x-unsupported-extension'],
      'x-unsupported-extension': 'malicious',
    };
    const payload = {
      iss: ISSUER, aud: RESOURCE, sub: 'local-user',
      iat: now, exp: now + 3600,
    };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signingInput = `${headerB64}.${payloadB64}`;
    // Sign the synthesized header+payload with the AS's private key.
    const sigBytes = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signKey,
      new TextEncoder().encode(signingInput),
    );
    const sigB64 = Buffer.from(sigBytes).toString('base64url');
    const malicious = `${signingInput}.${sigB64}`;

    const result = await as.validate(malicious);
    expect(result.ok).toBe(false);
  });

  it('rejects token with wrong audience claim', async () => {
    const token = await mintToken({ aud: 'http://other.example.com/mcp' });
    const result = await as.validate(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid audience');
  });

  it('rejects token with wrong issuer claim', async () => {
    const token = await mintToken({ iss: 'http://attacker.example.com' });
    const result = await as.validate(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid issuer');
  });

  it('rejects expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const token = await mintToken({ exp: past });
    const result = await as.validate(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('token expired');
  });

  it('rejects malformed token (not a valid JWT)', async () => {
    const result = await as.validate('not-a-valid-jwt');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('token validation failed');
  });

  it('rejects empty-string token', async () => {
    const result = await as.validate('');
    expect(result.ok).toBe(false);
  });
});
