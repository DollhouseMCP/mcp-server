import {
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { ExternalSigningKey } from 'oidc-provider';
import type { JWK } from 'jose';
import type { ISigningKeyStore, SigningKey } from '../../storage/signingKeys/ISigningKeyStore.js';
import { SigningKeyLifecycleConflictError } from '../../storage/signingKeys/signingKeyLifecycle.js';
import type { StoredKeyPair } from './persistKeys.js';
import { assertAuthorizationGenerationMatches } from './EmbeddedASTokens.js';

const ALGORITHM = 'ES256';
const PRIVATE_JWK_FIELDS = new Set(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth']);

interface LifecycleSigningKeyOptions {
  readonly store: ISigningKeyStore;
  readonly keysetJwk: JWK;
  readonly expectedKid: string;
  readonly expectedGenerationFingerprint: string;
}

/**
 * oidc-provider signing adapter that holds the store lifecycle lease only for
 * the cryptographic signature itself. Adapter/database work happens outside
 * this boundary, so a one-connection PostgreSQL pool cannot deadlock while a
 * mode transition still waits for every in-flight signature to finish.
 */
export class OidcLifecycleSigningKey extends ExternalSigningKey {
  private readonly store: ISigningKeyStore;
  private readonly expectedKid: string;
  private readonly expectedGenerationFingerprint: string;
  private readonly publicJwk: JWK;
  private readonly publicKey: KeyObject;

  constructor(options: LifecycleSigningKeyOptions) {
    super();
    this.store = options.store;
    this.expectedKid = options.expectedKid;
    this.expectedGenerationFingerprint = options.expectedGenerationFingerprint;
    this.publicJwk = stripPrivate(options.keysetJwk);
    this.publicKey = createPublicKey({
      key: this.publicJwk as JsonWebKey,
      format: 'jwk',
    });
  }

  override get kid(): string {
    return this.expectedKid;
  }

  override get alg(): string {
    return ALGORITHM;
  }

  override get kty(): string {
    return String(this.publicJwk.kty);
  }

  override get crv(): string | undefined {
    return this.publicJwk.crv;
  }

  override get x(): string | undefined {
    return this.publicJwk.x;
  }

  override get y(): string | undefined {
    return this.publicJwk.y;
  }

  override keyObject(): KeyObject {
    return this.publicKey;
  }

  override async sign(data: Uint8Array): Promise<Uint8Array> {
    return this.store.withActiveKey('jwks', async active => {
      if (active.kid !== this.expectedKid) {
        throw new SigningKeyLifecycleConflictError(
          `JWKS signing key '${this.expectedKid}' was retired before oidc-provider completed signing`,
        );
      }
      assertAuthorizationGenerationMatches(active, this.expectedGenerationFingerprint);
      const privateKey = privateKeyFromStoredPayload(active);
      return signBytes('sha256', Buffer.from(data), {
        key: privateKey,
        dsaEncoding: 'ieee-p1363',
      });
    });
  }
}

function privateKeyFromStoredPayload(key: SigningKey): KeyObject {
  const stored = key.payload as unknown as Partial<StoredKeyPair>;
  if (stored.kid !== key.kid || !stored.privateKey || !stored.publicKey) {
    throw new Error(`Stored JWKS signing key '${key.kid}' is malformed`);
  }
  return createPrivateKey({
    key: stored.privateKey as JsonWebKey,
    format: 'jwk',
  });
}

function stripPrivate(jwk: JWK): JWK {
  return Object.fromEntries(
    Object.entries(jwk).filter(([key]) => !PRIVATE_JWK_FIELDS.has(key)),
  ) as JWK;
}
