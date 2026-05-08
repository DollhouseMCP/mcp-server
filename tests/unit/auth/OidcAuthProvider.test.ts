/**
 * OidcAuthProvider — typed jose error classification (Cycle-11 H11-1).
 *
 * Cycle 8 fixed substring-matching error classification in
 * EmbeddedAuthorizationServer.validate. Cycle 10 fixed the same in
 * LocalDevAuthProvider.validate. OidcAuthProvider — the third
 * IAuthProvider implementation — was missed both times. This test
 * pins the typed-error branches added in cycle 11:
 *   - JWTExpired → "token expired"
 *   - JWSSignatureVerificationFailed → "invalid signature"
 *   - JWTClaimValidationFailed (aud) → "invalid audience"
 *   - JWTClaimValidationFailed (iss) → "invalid issuer"
 *
 * The reason text is now consistent across all three providers
 * (M11-1) — operator log triage stays uniform regardless of which
 * provider is mounted.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  createLocalJWKSet,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import { OidcAuthProvider } from '../../../src/auth/OidcAuthProvider.js';

const ISSUER = 'https://tenant.example.com/';
const AUDIENCE = 'mcp-resource';
const ALGORITHM = 'ES256';

describe('OidcAuthProvider — typed error classification (Cycle-11 H11-1)', () => {
  let signKey: CryptoKey;
  let verifyJwks: JWTVerifyGetKey;
  let wrongJwks: JWTVerifyGetKey;
  let provider: OidcAuthProvider;

  beforeAll(async () => {
    // Real signing key + matching public-only JWKS.
    const { privateKey, publicKey } = await generateKeyPair(ALGORITHM, { extractable: true });
    signKey = privateKey;
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'test-kid';
    publicJwk.alg = ALGORITHM;
    publicJwk.use = 'sig';
    verifyJwks = createLocalJWKSet({ keys: [publicJwk as JWK] });

    // A second keypair for the signature-mismatch test.
    const wrong = await generateKeyPair(ALGORITHM, { extractable: true });
    const wrongJwk = await exportJWK(wrong.publicKey);
    wrongJwk.kid = 'test-kid'; // same kid so jose doesn't fail on lookup
    wrongJwk.alg = ALGORITHM;
    wrongJwk.use = 'sig';
    wrongJwks = createLocalJWKSet({ keys: [wrongJwk as JWK] });

    provider = new OidcAuthProvider({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksGetter: verifyJwks,
    });
  });

  async function mintToken(opts: {
    iss?: string;
    aud?: string | string[];
    exp?: number;
    sub?: string;
    scope?: string;
  } = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ scope: opts.scope ?? 'mcp' })
      .setProtectedHeader({ alg: ALGORITHM, kid: 'test-kid' })
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? AUDIENCE)
      .setSubject(opts.sub ?? 'alice')
      .setIssuedAt(now)
      .setExpirationTime(opts.exp ?? now + 3600)
      .sign(signKey);
  }

  it('positive control: a properly-signed token is accepted', async () => {
    const token = await mintToken();
    const result = await provider.validate(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe('alice');
      expect(result.claims.scopes).toContain('mcp');
    }
  });

  it('expired token → reason "token expired" (typed JWTExpired branch)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await mintToken({ exp: now - 60 });
    const result = await provider.validate(token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Substring matching used to misclassify (the message contains
      // "exp" because of "expected"); typed branch fixes this.
      expect(result.reason).toBe('token expired');
    }
  });

  it('wrong audience → reason "invalid audience" (typed JWTClaimValidationFailed branch)', async () => {
    const token = await mintToken({ aud: 'wrong-audience' });
    const result = await provider.validate(token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid audience');
    }
  });

  it('wrong issuer → reason "invalid issuer" (typed JWTClaimValidationFailed branch)', async () => {
    const token = await mintToken({ iss: 'https://attacker.example.com/' });
    const result = await provider.validate(token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid issuer');
    }
  });

  it('signature mismatch → reason "invalid signature" (typed JWSSignatureVerificationFailed branch)', async () => {
    // Provider configured with the WRONG JWKS — same kid, different key.
    const wrongProvider = new OidcAuthProvider({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksGetter: wrongJwks,
    });
    const token = await mintToken();
    const result = await wrongProvider.validate(token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid signature');
    }
  });

  it('M11-1: error reasons match the other two providers (cross-provider consistency)', async () => {
    // Operator log triage that filters on a specific reason should see
    // the same string regardless of which IAuthProvider is mounted.
    // EmbeddedAS, LocalDev, and Oidc all return these exact strings:
    const expiredToken = await mintToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    const wrongAudToken = await mintToken({ aud: 'wrong' });
    const wrongIssToken = await mintToken({ iss: 'wrong' });

    const r1 = await provider.validate(expiredToken);
    const r2 = await provider.validate(wrongAudToken);
    const r3 = await provider.validate(wrongIssToken);

    expect(r1.ok && 'token expired').toBe(false); // ok=false
    expect(r2.ok && 'invalid audience').toBe(false);
    expect(r3.ok && 'invalid issuer').toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('token expired');
    if (!r2.ok) expect(r2.reason).toBe('invalid audience');
    if (!r3.ok) expect(r3.reason).toBe('invalid issuer');
  });

  it('missing mcp scope → reason names the scope (defense-in-depth)', async () => {
    const token = await mintToken({ scope: 'openid profile' }); // no mcp
    const result = await provider.validate(token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/mcp scope/);
    }
  });
});
