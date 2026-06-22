/**
 * Local Development Authentication Provider
 *
 * Issues and validates self-signed ES256 JWTs using an auto-generated
 * ECDSA key pair stored locally. Designed for development and testing —
 * no external dependencies, no network calls.
 *
 * Key pair lifecycle:
 * - Generated on first use and written to disk (mode 0600)
 * - Reused across server restarts from the same key file
 * - Key file location: DOLLHOUSE_AUTH_LOCAL_KEY_FILE or ~/.dollhouse/run/auth-keypair.json
 *
 * Tokens use standard JWT claims (iss, sub, aud, exp, iat) and are
 * validated with the same key pair that signed them. Swapping to a
 * production OIDC provider replaces this class via DI — no consumer
 * code changes.
 *
 * @module auth/LocalDevAuthProvider
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SignJWT, jwtVerify, importJWK, exportJWK, generateKeyPair, errors as joseErrors } from 'jose';
import { logger } from '../utils/logger.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import type { IAuthProvider, AuthResult, AuthClaims, IssueOptions } from './IAuthProvider.js';

const ISSUER = 'dollhousemcp-local';
const AUDIENCE = 'dollhousemcp';
const DEFAULT_TTL_SECONDS = 86400; // 24 hours
const ALGORITHM = 'ES256';

export interface LocalDevAuthProviderOptions {
  /** Path to the key pair file. Auto-generated if missing. */
  keyFilePath: string;
}

/**
 * Extract scopes from either the spec-standard `scope` claim
 * (space-separated string per RFC 8693 §4.2) or the legacy `scopes`
 * array claim emitted by older issuance code.
 */
function extractScopes(payload: Record<string, unknown>): string[] | undefined {
  if (typeof payload.scope === 'string') {
    return payload.scope.split(/\s+/).filter(Boolean);
  }
  if (Array.isArray(payload.scopes)) {
    return payload.scopes.filter((s): s is string => typeof s === 'string');
  }
  return undefined;
}

/**
 * Build an AuthResult from a successfully-verified JWT payload. Returns
 * an error result when required claims (typ, sub, mcp scope) are
 * missing or wrong-shaped. Extracted from validate() to keep that
 * function's cognitive complexity ≤15 (S3776).
 */
function buildLocalAuthResult(
  payload: Record<string, unknown>,
  protectedHeader: { typ?: string },
): AuthResult {
  // RFC 9068: access tokens carry `typ: at+jwt` so an id_token (or any
  // other JWT signed by the same key) can't be replayed as an access
  // token. Mirror the embedded AS's enforcement.
  if (protectedHeader.typ && protectedHeader.typ !== 'at+jwt') {
    return { ok: false, reason: 'invalid token type' };
  }
  if (!payload.sub || typeof payload.sub !== 'string') {
    return { ok: false, reason: 'token missing sub claim' };
  }

  // Cycle-16 fix: validate the spec-standard `scope` (RFC 8693 §4.2,
  // space-separated string) AND legacy `scopes` (array) for tokens
  // issued by older versions of this provider. Both forms decode to
  // the same string array internally. New issuance uses `scope`
  // exclusively so a token issued under DOLLHOUSE_AUTH_PROVIDER=local
  // can be verified by the embedded AS (which requires `scope`).
  const scopes = extractScopes(payload);
  if (!scopes?.includes('mcp')) {
    return { ok: false, reason: 'token missing mcp scope' };
  }

  const claims: AuthClaims = {
    sub: payload.sub,
    displayName: typeof payload.display_name === 'string' ? payload.display_name : undefined,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    tenantId: typeof payload.tenant_id === 'string' ? payload.tenant_id : null,
    scopes,
    roles: Array.isArray(payload.roles)
      ? payload.roles.filter((r): r is string => typeof r === 'string')
      : undefined,
    exp: typeof payload.exp === 'number' ? payload.exp : undefined,
  };
  return { ok: true, claims };
}

/**
 * Map a jose JWT-verification error to a stable, operator-friendly
 * reason string. Cycle-10 fix (H10-3): use jose's typed errors rather
 * than substring-matching .message — substrings like 'exp' / 'signature'
 * collide with unrelated error text and produce misleading reasons in
 * operator logs. Extracted from validate() for the cognitive-complexity
 * refactor; behaviour is identical to the inline cascade it replaced.
 */
function mapJwtVerifyError(error: unknown): string {
  if (error instanceof joseErrors.JWTExpired) {
    return 'token expired';
  }
  if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
    return 'invalid signature';
  }
  // Cycle-13 fix: parity with OidcAuthProvider — distinct reason for
  // alg-rejection so operator triage doesn't fold it into the generic
  // "token validation failed" bucket.
  if (error instanceof joseErrors.JOSEAlgNotAllowed) {
    return 'algorithm not allowed';
  }
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    const claim = error.claim;
    if (claim === 'aud') return 'invalid audience';
    if (claim === 'iss') return 'invalid issuer';
    return `claim validation failed: ${claim ?? 'unknown'}`;
  }
  return 'token validation failed';
}

export class LocalDevAuthProvider implements IAuthProvider {
  readonly name = 'local-dev';

  private readonly keyFilePath: string;
  private privateKey: CryptoKey | Uint8Array | null = null;
  private publicKey: CryptoKey | Uint8Array | null = null;
  private initialized = false;

  constructor(options: LocalDevAuthProviderOptions) {
    this.keyFilePath = options.keyFilePath;
  }

  async validate(token: string): Promise<AuthResult> {
    await this.ensureInitialized();

    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.publicKey!, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: [ALGORITHM],
      });
      return buildLocalAuthResult(payload, protectedHeader);
    } catch (error) {
      return { ok: false, reason: mapJwtVerifyError(error) };
    }
  }

  async issue(sub: string, options?: IssueOptions): Promise<string> {
    await this.ensureInitialized();

    const ttl = options?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const builder = new SignJWT({
      ...(options?.displayName ? { display_name: options.displayName } : {}),
      ...(options?.email ? { email: options.email } : {}),
      ...(options?.scopes?.length ? { scope: options.scopes.join(' ') } : {}),
    })
      .setProtectedHeader({ alg: ALGORITHM, typ: 'at+jwt' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`);

    return builder.sign(this.privateKey!);
  }

  /** Ensure key pair is loaded or generated. */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      const raw = await fs.readFile(this.keyFilePath, 'utf-8');
      const stored = JSON.parse(raw) as { privateKey: Record<string, unknown>; publicKey: Record<string, unknown> };
      this.privateKey = await importJWK(stored.privateKey, ALGORITHM) as CryptoKey;
      this.publicKey = await importJWK(stored.publicKey, ALGORITHM) as CryptoKey;
      logger.info(`[LocalDevAuthProvider] Loaded key pair from ${this.keyFilePath}`);
    } catch {
      await this.generateAndStoreKeyPair();
    }

    this.initialized = true;
  }

  private async generateAndStoreKeyPair(): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair(ALGORITHM, { extractable: true });
    this.privateKey = privateKey;
    this.publicKey = publicKey;

    const exported = {
      privateKey: await exportJWK(privateKey),
      publicKey: await exportJWK(publicKey),
      generatedAt: new Date().toISOString(),
    };

    await fs.mkdir(path.dirname(this.keyFilePath), { recursive: true });
    await fs.writeFile(this.keyFilePath, JSON.stringify(exported, null, 2), { mode: 0o600 });

    logger.info(`[LocalDevAuthProvider] Generated new ES256 key pair at ${this.keyFilePath}`);
    SecurityMonitor.logSecurityEvent({
      type: 'PORTFOLIO_INITIALIZATION',
      severity: 'LOW',
      source: 'LocalDevAuthProvider',
      details: `Generated new authentication key pair at ${this.keyFilePath}`,
    });
  }
}
