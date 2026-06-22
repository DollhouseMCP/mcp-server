import {
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  SignJWT,
  errors as joseErrors,
  type JWK,
} from 'jose';

import type {
  AuthClaims,
  AuthResult,
  IssueOptions,
} from '../IAuthProvider.js';
import {
  type SigningKeyset,
  type StoredKeyPair,
} from './persistKeys.js';
import type {
  ISigningKeyStore,
  SigningKey,
} from '../../storage/signingKeys/ISigningKeyStore.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';

export const ALGORITHM = 'ES256';
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 3600;
export const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600;
export const DEFAULT_AUTH_CODE_TTL_SECONDS = 5 * 60;
export const DEFAULT_INTERACTION_TTL_SECONDS = 10 * 60;
export const DEFAULT_SESSION_TTL_SECONDS = 14 * 24 * 3600;
export const DEFAULT_CLIENT_ID = 'dollhouse-claude-connector';

export interface EmbeddedASInitializedState {
  keyset: SigningKeyset;
  publicSigningKey: CryptoKey;
  privateSigningKey: CryptoKey;
}

export class EmbeddedASTokens {
  constructor(
    private readonly ensureInitialized: () => Promise<EmbeddedASInitializedState>,
    private readonly getIssuer: () => string,
    private readonly getResource: () => string,
    private readonly signingKeyStore?: ISigningKeyStore,
  ) {}

  async validate(token: string): Promise<AuthResult> {
    if (this.signingKeyStore) {
      return await this.validateWithStore(token);
    }
    const { publicSigningKey, keyset } = await this.ensureInitialized();
    try {
      const { payload, protectedHeader } = await jwtVerify(token, publicSigningKey, {
        issuer: this.getIssuer(),
        audience: this.getResource(),
        algorithms: [ALGORITHM],
        typ: 'at+jwt',
        crit: {},
      });
      return logEmbeddedTokenValidationResult(
        buildEmbeddedAsAuthResult(payload, protectedHeader, keyset.kid),
        'EmbeddedASTokens.validate',
      );
    } catch (error) {
      return logEmbeddedTokenValidationResult(
        { ok: false, reason: mapEmbeddedAsVerifyError(error) },
        'EmbeddedASTokens.validate',
      );
    }
  }

  async issue(sub: string, options?: IssueOptions): Promise<string> {
    const { keyset, privateSigningKey } = this.signingKeyStore
      ? await this.loadActiveSigningStateFromStore()
      : await this.ensureInitialized();
    const ttl = options?.ttlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
    const scope = options?.scopes?.join(' ') || 'mcp';

    return new SignJWT({
      azp: DEFAULT_CLIENT_ID,
      scope,
      name: options?.displayName ?? sub,
    })
      .setProtectedHeader({ alg: ALGORITHM, kid: keyset.kid, typ: 'at+jwt' })
      .setIssuer(this.getIssuer())
      .setAudience(this.getResource())
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .sign(privateSigningKey);
  }

  private async validateWithStore(token: string): Promise<AuthResult> {
    await this.ensureInitialized();
    try {
      const protectedHeader = decodeProtectedHeader(token);
      if (!protectedHeader.kid) {
        return logEmbeddedTokenValidationResult(
          { ok: false, reason: 'token missing kid header' },
          'EmbeddedASTokens.validateWithStore',
        );
      }
      const key = await requiredSigningKeyStore(this.signingKeyStore).getByKid(protectedHeader.kid);
      if (!(key?.kind === 'jwks' && key.retiredAt === undefined)) {
        return logEmbeddedTokenValidationResult(
          { ok: false, reason: 'unknown key id' },
          'EmbeddedASTokens.validateWithStore',
        );
      }
      const keyset = signingKeyToKeyset(key);
      const { publicSigningKey } = await importSigningKeys(keyset);
      const { payload } = await jwtVerify(token, publicSigningKey, {
        issuer: this.getIssuer(),
        audience: this.getResource(),
        algorithms: [ALGORITHM],
        typ: 'at+jwt',
        crit: {},
      });
      return logEmbeddedTokenValidationResult(
        buildEmbeddedAsAuthResult(payload, protectedHeader, keyset.kid),
        'EmbeddedASTokens.validateWithStore',
      );
    } catch (error) {
      return logEmbeddedTokenValidationResult(
        { ok: false, reason: mapEmbeddedAsVerifyError(error) },
        'EmbeddedASTokens.validateWithStore',
      );
    }
  }

  private async loadActiveSigningStateFromStore(): Promise<EmbeddedASInitializedState> {
    await this.ensureInitialized();
    const active = await requiredSigningKeyStore(this.signingKeyStore).getActive('jwks');
    if (!active || active.retiredAt !== undefined) {
      throw new Error('No active JWKS signing key is available for token issuance');
    }
    const keyset = signingKeyToKeyset(active);
    const { publicSigningKey, privateSigningKey } = await importSigningKeys(keyset);
    return {
      keyset,
      publicSigningKey,
      privateSigningKey,
    };
  }
}

export async function loadPublicSigningJwksFromStore(
  store: ISigningKeyStore,
): Promise<{ keys: JWK[] }> {
  const keys = await store.listByKind('jwks');
  return {
    keys: keys
      .filter(key => key.kind === 'jwks' && key.retiredAt === undefined)
      .map(key => stripPrivate(signingKeyToKeyset(key).jwks.keys[0])),
  };
}

function claimsFromPayload(payload: Record<string, unknown>): AuthClaims {
  return {
    sub: String(payload.sub),
    displayName: typeof payload.name === 'string' ? payload.name : undefined,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    tenantId: typeof payload.tenant_id === 'string' ? payload.tenant_id : null,
    scopes: typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : undefined,
    roles: Array.isArray(payload.roles)
      ? payload.roles.filter((r): r is string => typeof r === 'string')
      : undefined,
    exp: typeof payload.exp === 'number' ? payload.exp : undefined,
  };
}

function buildEmbeddedAsAuthResult(
  payload: Record<string, unknown>,
  protectedHeader: { kid?: string },
  activeKid: string,
): AuthResult {
  if (!protectedHeader.kid) {
    return { ok: false, reason: 'token missing kid header' };
  }
  if (protectedHeader.kid !== activeKid) {
    return { ok: false, reason: 'unknown key id' };
  }
  if (!payload.sub) {
    return { ok: false, reason: 'token missing sub claim' };
  }
  const scopeClaim = typeof payload.scope === 'string' ? payload.scope : '';
  const scopes = new Set(scopeClaim.split(/\s+/).filter(Boolean));
  if (!scopes.has('mcp')) {
    return { ok: false, reason: 'token missing mcp scope' };
  }
  return { ok: true, claims: claimsFromPayload(payload) };
}

function mapEmbeddedAsVerifyError(error: unknown): string {
  if (error instanceof joseErrors.JWTExpired) {
    return 'token expired';
  }
  if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
    return 'invalid signature';
  }
  if (error instanceof joseErrors.JOSEAlgNotAllowed) {
    return 'algorithm not allowed';
  }
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    const claim = error.claim;
    if (claim === 'aud') return 'invalid audience';
    if (claim === 'iss') return 'invalid issuer';
    if (claim === 'typ') return 'wrong token type';
    return `claim validation failed: ${claim}`;
  }
  return 'token validation failed';
}

const PRIVATE_JWK_FIELDS: ReadonlySet<string> = new Set([
  'd',
  'p', 'q', 'dp', 'dq', 'qi',
  'k',
  'oth',
]);

export function stripPrivate(jwk: JWK): JWK {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(jwk)) {
    if (!PRIVATE_JWK_FIELDS.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

export async function importSigningKeys(keyset: SigningKeyset): Promise<{
  publicSigningKey: CryptoKey;
  privateSigningKey: CryptoKey;
}> {
  const privateJwk = keyset.jwks.keys[0];
  return {
    publicSigningKey: (await importJWK(stripPrivate(privateJwk), ALGORITHM)) as CryptoKey,
    privateSigningKey: (await importJWK(privateJwk, ALGORITHM)) as CryptoKey,
  };
}

function signingKeyToKeyset(key: SigningKey): SigningKeyset {
  const stored = key.payload as unknown as Partial<StoredKeyPair>;
  if (!stored.kid || !stored.privateKey || !stored.publicKey) {
    throw new Error(`Stored JWKS signing key '${key.kid}' is malformed`);
  }
  return {
    kid: stored.kid,
    jwks: {
      keys: [{
        ...stored.privateKey,
        kid: stored.kid,
        alg: ALGORITHM,
        use: 'sig',
      }],
    },
  };
}

function requiredSigningKeyStore(store: ISigningKeyStore | undefined): ISigningKeyStore {
  if (!store) throw new Error('Signing key store is required');
  return store;
}

function logEmbeddedTokenValidationResult(result: AuthResult, source: string): AuthResult {
  if (!result.ok) {
    SecurityMonitor.logSecurityEvent({
      type: 'TOKEN_VALIDATION_FAILURE',
      severity: 'MEDIUM',
      source,
      details: 'Embedded authorization server token validation failed',
      additionalData: { reason: result.reason },
    });
  }
  return result;
}
