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
  /** Override scope claim. Defaults to 'mcp' so the positive controls pass. */
  scope?: string | null;
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

    // scope: 'mcp' by default; null suppresses the claim entirely so the
    // missing-scope negative-path test can exercise the H6 reject path.
    const claims: Record<string, unknown> = {};
    if (opts.scope === undefined) {
      claims.scope = 'mcp';
    } else if (opts.scope !== null) {
      claims.scope = opts.scope;
    }
    const jwt = new SignJWT(claims)
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
    // Cycle-8 fix: assert the SHAPE of claims, not just that
    // validation passed. A regression in `claimsFromPayload` that
    // dropped fields would otherwise pass this test silently.
    if (result.ok) {
      // Cycle-8 fix: assert the SHAPE of claims, not just that
      // validation passed. A regression in `claimsFromPayload` that
      // dropped fields would otherwise pass this test silently.
      // AuthClaims fields per src/auth/IAuthProvider.ts: sub,
      // displayName, email, tenantId, scopes, roles, exp.
      expect(result.claims.sub).toBe('local-user');
      expect(typeof result.claims.exp).toBe('number');
      // scopes derived from the `scope` claim — `mcp` must be there
      // since validate() rejected the no-mcp-scope path otherwise.
      expect(result.claims.scopes).toContain('mcp');
    }
  });

  it('cycle 19 / test-B1 (L-R8-3): issue() mints a fully-shaped at+jwt that round-trips through validate()', async () => {
    // The L-R8-3 known-limitation row tracked that the startup-token
    // issue path was end-to-end-tested only — no unit test pinned the
    // claim shape. A regression dropping `azp`, `displayName` →
    // `name`, `scope`, `typ`, or `kid` would pass 11k+ unit tests.
    // Cycle 19 closes the gap.
    const token = await as.issue('alice', {
      ttlSeconds: 600,
      scopes: ['mcp', 'profile'],
      displayName: 'Alice Anderson',
    });

    // Decode without verifying first to inspect the protected header.
    const [headerB64] = token.split('.');
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    expect(header.alg).toBe('ES256');
    expect(header.typ).toBe('at+jwt');
    expect(typeof header.kid).toBe('string');
    expect(header.kid.length).toBeGreaterThan(0);

    // Now feed it through validate() to confirm the issuer/audience/sub
    // round-trip and the claim mapping in claimsFromPayload.
    const result = await as.validate(token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.sub).toBe('alice');
    expect(result.claims.displayName).toBe('Alice Anderson');
    expect(result.claims.scopes).toEqual(['mcp', 'profile']);
    expect(typeof result.claims.exp).toBe('number');

    // azp is on the raw JWT payload but not surfaced in AuthClaims —
    // decode the payload directly to assert it.
    const [, payloadB64] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    expect(payload.azp).toBe('dollhouse-claude-connector');
    expect(payload.iss).toBe(ISSUER);
    expect(payload.aud).toBe(RESOURCE);
  });

  it('cycle 19 / test-B1: issue() defaults — sub becomes displayName when omitted; scope defaults to mcp', async () => {
    // Pins the default-shape contract so a regression that drops the
    // scope default OR changes the displayName fallback fails loudly.
    const token = await as.issue('bob');

    const result = await as.validate(token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.sub).toBe('bob');
    expect(result.claims.displayName).toBe('bob'); // sub fallback
    expect(result.claims.scopes).toEqual(['mcp']); // default scope
  });

  it('cycle 19 / test-B3: positive control with name + roles claims maps through claimsFromPayload', async () => {
    // Cycle 8's fix added algorithm-rejection negative tests but the
    // positive-control still only asserted sub/exp/scopes. Round 5
    // added the roles-bearing admin path (must-fix #22 + assertHasRole
    // middleware) and `claimsFromPayload` was extended to map `name`
    // and `roles`. Cycle 19 reviewer caught: a regression in those
    // mappings is invisible to the existing positive control because
    // the existing mintToken doesn't inject those claims.
    //
    // This test mints a token carrying the admin-shape claims and
    // asserts displayName + roles flow through. A regression that
    // breaks claimsFromPayload's roles mapping (which the
    // assertHasRole middleware depends on) would now fail loudly.
    const now = Math.floor(Date.now() / 1000);
    const richToken = await new SignJWT({
      scope: 'mcp',
      name: 'Alice Admin',
      roles: ['admin', 'auditor'],
      email: 'alice@example.com',
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setSubject('local-user')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(signKey);

    const result = await as.validate(richToken);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.sub).toBe('local-user');
    expect(result.claims.displayName).toBe('Alice Admin');
    expect(result.claims.roles).toEqual(['admin', 'auditor']);
    expect(result.claims.email).toBe('alice@example.com');
    expect(result.claims.scopes).toContain('mcp');
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

  // Cycle-13 fix: JOSEAlgNotAllowed branch added for cross-provider
  // parity. A revert would return 'token validation failed' (generic)
  // instead of 'algorithm not allowed' — silent loss of operator-log
  // specificity. validate() pins ES256 in algorithms, so an HS256
  // token (algorithm-confusion attack shape) triggers this branch.
  it('rejects token with disallowed algorithm → reason "algorithm not allowed"', async () => {
    const { createHmac } = await import('node:crypto');
    const now = Math.floor(Date.now() / 1000);
    // HS256-shaped token. The validator's algorithms allowlist refuses
    // it before signature verification.
    const header = { alg: 'HS256', typ: 'at+jwt', kid };
    const payload = {
      iss: ISSUER, aud: RESOURCE, sub: 'attacker',
      iat: now, exp: now + 3600, scope: 'mcp',
    };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', 'arbitrary-secret-bytes')
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');
    const result = await as.validate(`${headerB64}.${payloadB64}.${sig}`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('algorithm not allowed');
    }
  });

  // Cycle-12 fix (MISSING-COVERAGE-HIGH from cycle-12 review): the
  // JWSSignatureVerificationFailed branch added in cycle 11 had no
  // test. A revert of the branch returned 'token validation failed'
  // (generic) instead of 'invalid signature' — silent loss of
  // operator log specificity. This test pins the typed-error
  // classification by signing a token with the AS's claims but
  // a different ES256 key (matching alg + kid → reaches signature
  // verification → fails there).
  it('rejects token signed with a different key → reason "invalid signature" (typed JWSSignatureVerificationFailed)', async () => {
    const { generateKeyPair } = await import('jose');
    const { privateKey: wrongKey } = await generateKeyPair('ES256', { extractable: true });
    const now = Math.floor(Date.now() / 1000);
    // Same kid as the AS expects — signature verification will be
    // attempted (not rejected at kid-match).
    const tampered = await new SignJWT({ scope: 'mcp' })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setSubject('alice')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(wrongKey);
    const result = await as.validate(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Cycle-11 / M11-1: aligned reason text across all 3 providers.
      expect(result.reason).toBe('invalid signature');
    }
  });

  it('rejects token with alg: HS256 (algorithm-confusion attack)', async () => {
    // Classic alg-confusion: an attacker takes the AS's published public
    // key and uses its bytes as an HMAC-SHA256 secret to sign a forged
    // token. A naive validator that doesn't pin the algorithm allow-list
    // would accept the HMAC signature, since the same key material
    // satisfies both 'algorithms' inputs to jose.jwtVerify. The hardened
    // validator rejects any alg outside the configured ES256-only list.
    const { createHmac } = await import('node:crypto');
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'HS256', typ: 'at+jwt', kid };
    const payload = {
      iss: ISSUER, aud: RESOURCE, sub: 'attacker',
      iat: now, exp: now + 3600,
    };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', 'arbitrary-secret-bytes')
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');
    const result = await as.validate(`${headerB64}.${payloadB64}.${sig}`);
    expect(result.ok).toBe(false);
  });

  it('rejects token with alg: none (RFC 8725 §3.1)', async () => {
    // The "no signature" attack: an attacker submits an unsigned token
    // and hopes the validator skips signature verification when alg=none.
    // The hardened validator rejects the alg before reaching the
    // signature check.
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'none', typ: 'at+jwt', kid };
    const payload = {
      iss: ISSUER, aud: RESOURCE, sub: 'attacker',
      iat: now, exp: now + 3600,
    };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    // Per RFC 7515 §6.1, alg:none tokens have an empty signature segment.
    const result = await as.validate(`${headerB64}.${payloadB64}.`);
    expect(result.ok).toBe(false);
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

  it('rejects token without the mcp scope (H6 defense in depth)', async () => {
    // Tokens we issue always carry the mcp scope via the resourceIndicators
    // wiring; this test proves the validator REJECTS a token that somehow
    // lacks it (e.g. a future code path that mints a token without the
    // resource-server scope, or a key-rotation bug).
    const noScope = await mintToken({ scope: null });
    const noScopeResult = await as.validate(noScope);
    expect(noScopeResult.ok).toBe(false);
    if (!noScopeResult.ok) expect(noScopeResult.reason).toMatch(/mcp scope/);

    const wrongScope = await mintToken({ scope: 'openid profile' });
    const wrongScopeResult = await as.validate(wrongScope);
    expect(wrongScopeResult.ok).toBe(false);

    // Sanity: the same shape with the mcp scope is accepted.
    const ok = await mintToken({ scope: 'openid mcp' });
    const okResult = await as.validate(ok);
    expect(okResult.ok).toBe(true);
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
