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
  type JWTVerifyGetKey,
} from 'jose';
import { OidcAuthProvider } from '../../../src/auth/OidcAuthProvider.js';

const ISSUER = 'https://tenant.example.com/';
const AUDIENCE = 'mcp-resource';
const ALGORITHM = 'ES256';

async function mintTokenWithTyp(signKey: CryptoKey, typ: string | undefined): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const builder = new SignJWT({ scope: 'mcp' })
    .setProtectedHeader(typ ? { alg: ALGORITHM, kid: 'test-kid', typ }
                             : { alg: ALGORITHM, kid: 'test-kid' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject('alice')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600);
  return builder.sign(signKey);
}

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
    verifyJwks = createLocalJWKSet({ keys: [publicJwk] });

    // A second keypair for the signature-mismatch test.
    const wrong = await generateKeyPair(ALGORITHM, { extractable: true });
    const wrongJwk = await exportJWK(wrong.publicKey);
    wrongJwk.kid = 'test-kid'; // same kid so jose doesn't fail on lookup
    wrongJwk.alg = ALGORITHM;
    wrongJwk.use = 'sig';
    wrongJwks = createLocalJWKSet({ keys: [wrongJwk] });

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

  // Cycle-12 fix (M12-1): algorithms allowlist parity with EmbeddedAS
  // and LocalDev. The default allowlist excludes `none` and HS-family
  // algorithms; jose rejects them at verify-time even if a token were
  // crafted with one.
  describe('algorithms allowlist (M12-1)', () => {
    it('accepts a token signed with a default-allowlist algorithm (ES256)', async () => {
      const token = await mintToken();
      const result = await provider.validate(token);
      expect(result.ok).toBe(true);
    });

    it('rejects a token whose alg is outside a custom allowlist with reason="algorithm not allowed"', async () => {
      // Cycle-13 fix: jose throws JOSEAlgNotAllowed; the new typed
      // branch in OidcAuthProvider.validate maps it to a distinct
      // reason string. Pre-cycle-13 this fell through to the generic
      // 'token validation failed', losing operator-log specificity.
      const restrictedProvider = new OidcAuthProvider({
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksGetter: verifyJwks,
        algorithms: ['RS256'],
      });
      const token = await mintToken();
      const result = await restrictedProvider.validate(token);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('algorithm not allowed');
      }
    });
  });

  describe('cycle 19 / security-#6: opt-in RFC 9068 typ enforcement', () => {
    it('default (option off): accepts a token with no typ header (compat with most IdPs)', async () => {
      // The cycle 19 fix is opt-in. Default behavior must preserve
      // compat with Auth0/Okta/Keycloak/Cognito, which typically don't
      // stamp typ on access tokens.
      const token = await mintTokenWithTyp(signKey, undefined);
      const result = await provider.validate(token);
      expect(result.ok).toBe(true);
    });

    it('default (option off): accepts a token with typ:JWT (legacy stamp)', async () => {
      const token = await mintTokenWithTyp(signKey, 'JWT');
      const result = await provider.validate(token);
      expect(result.ok).toBe(true);
    });

    it('option on: accepts a token with typ:at+jwt (RFC 9068 compliant)', async () => {
      const strict = new OidcAuthProvider({
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksGetter: verifyJwks,
        requireAccessTokenTyp: true,
      });
      const token = await mintTokenWithTyp(signKey, 'at+jwt');
      const result = await strict.validate(token);
      expect(result.ok).toBe(true);
    });

    it('option on: REJECTS a token with no typ header (the security gain)', async () => {
      // Without typ, an id_token mistakenly used as an access token
      // could pass when typ-enforcement is off. With it on, the request
      // is refused. Documents the operator decision: enabling the
      // option requires the IdP to actually stamp typ.
      const strict = new OidcAuthProvider({
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksGetter: verifyJwks,
        requireAccessTokenTyp: true,
      });
      const token = await mintTokenWithTyp(signKey, undefined);
      const result = await strict.validate(token);
      expect(result.ok).toBe(false);
    });

    it('option on: REJECTS a token with typ:JWT (id-token-as-access-token defense)', async () => {
      // The actual attack: external IdP issues both id_tokens and
      // access tokens, both for our audience. id_tokens commonly carry
      // typ:JWT (or no typ). With the option on we refuse those.
      const strict = new OidcAuthProvider({
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksGetter: verifyJwks,
        requireAccessTokenTyp: true,
      });
      const token = await mintTokenWithTyp(signKey, 'JWT');
      const result = await strict.validate(token);
      expect(result.ok).toBe(false);
    });

    it('cycle 22 / cycle-21 security-LOW-1: typ-rejection reason matches EmbeddedAuthorizationServer "wrong token type"', async () => {
      // Operator log-grep across both providers must see consistent
      // text when typ validation fails. Pre-cycle-22, OidcAuthProvider
      // returned the generic "claim validation failed: typ" while
      // EmbeddedAuthorizationServer returned "wrong token type" for
      // the same condition. Same drift class as M11-1 reason-text
      // alignment work.
      const strict = new OidcAuthProvider({
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksGetter: verifyJwks,
        requireAccessTokenTyp: true,
      });
      const token = await mintTokenWithTyp(signKey, 'JWT');
      const result = await strict.validate(token);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('wrong token type');
      }
    });
  });
});
