/**
 * IAuthStorageLayer
 *
 * Persistence contract for the embedded authorization server. Higher-level
 * than oidc-provider's Adapter interface: semantic methods for the
 * operations that need atomicity guarantees (refresh rotation, code
 * single-use), generic K/V for everything else (Session, Grant, Interaction,
 * BackchannelAuthenticationRequest, RegistrationAccessToken, ReplayDetection).
 *
 * The OidcProviderAdapter (C4) translates between oidc-provider's Adapter
 * calls and these methods, so oidc-provider types never leak out of
 * src/auth/embedded-as/.
 *
 * Implementations:
 *   - InMemoryAuthStorageLayer (C3) — solo-dev default, per-key mutex
 *   - SqliteAuthStorageLayer / PostgresAuthStorageLayer — when the auth
 *     schema lands; out of scope for the §8.1 PR
 *
 * Per-account-key design (must-fix #18): account records are keyed on
 * `(provider, externalSub)` — never on email. `sub` in StoredAccount is
 * formatted `${provider}:${externalSub}` for embedding in JWTs.
 *
 * @module auth/embedded-as/storage/IAuthStorageLayer
 */

export interface StoredAccount {
  /** `${provider}_${externalSub}` — the account identity in JWT `sub`. */
  sub: string;
  provider: string;
  externalSub: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
  /** Audit-only snapshot of the most recent upstream profile. */
  rawProfile?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface StoredAuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  resource?: string;
  scope: string;
  sub: string;
  expiresAt: number;
}

export interface StoredRefreshToken {
  /** Cryptographic token value used as the lookup key. */
  token: string;
  /** Family lineage; rotation produces a new token under the same family. */
  familyId: string;
  clientId: string;
  sub: string;
  resource?: string;
  scope: string;
  expiresAt: number;
}

export type RotationResult =
  | { kind: 'rotated'; successor: StoredRefreshToken }
  | { kind: 'reuse-detected'; familyId: string }
  | { kind: 'unknown' };

export interface IdentityAuditEvent {
  /** e.g. 'auth.social.identity_changed', 'auth.local.brute_force_suspected'. */
  type: string;
  sub?: string;
  provider?: string;
  externalSub?: string;
  details?: Record<string, unknown>;
  timestamp: number;
}

/**
 * Storage contract. All methods are async and idempotent where noted.
 * Atomic operations (rotateRefreshToken, consumeAuthorizationCode) MUST
 * serialize concurrent calls for the same key — the InMemory implementation
 * uses per-key mutexes; DB implementations use row locks or RETURNING-clause
 * compare-and-swap.
 */
export interface IAuthStorageLayer {
  // --- Accounts (must-fix #18) ---

  findAccountByExternalId(provider: string, externalSub: string): Promise<StoredAccount | null>;
  upsertAccount(account: StoredAccount): Promise<void>;
  getAccount(sub: string): Promise<StoredAccount | null>;

  // --- Authorization codes (atomic single-use) ---

  storeAuthorizationCode(code: StoredAuthCode): Promise<void>;
  /** Atomic: returns and deletes the code; returns null if already consumed or expired. */
  consumeAuthorizationCode(code: string): Promise<StoredAuthCode | null>;

  // --- Refresh tokens (must-fix #11: atomic rotation + reuse detection) ---

  storeRefreshToken(token: StoredRefreshToken): Promise<void>;
  /**
   * Atomic: marks `token` consumed and inserts `successor` in one transaction.
   * If `token` was already consumed, returns reuse-detected; the caller MUST
   * revoke the entire family (handled by the AS, not here).
   * If `token` is unknown or expired, returns unknown.
   */
  rotateRefreshToken(token: string, successor: StoredRefreshToken): Promise<RotationResult>;
  revokeRefreshTokenFamily(familyId: string): Promise<void>;

  // --- Audit (must-fix #21) ---

  recordIdentityEvent(event: IdentityAuditEvent): Promise<void>;

  // --- Generic K/V backing oidc-provider's Adapter for non-semantic models ---
  // Models routed here: Session, Grant, Interaction, BackchannelAuthenticationRequest,
  // RegistrationAccessToken, ReplayDetection, PushedAuthorizationRequest.

  genericGet(model: string, id: string): Promise<unknown | null>;
  genericSet(model: string, id: string, payload: unknown, expiresInSec?: number): Promise<void>;
  genericDestroy(model: string, id: string): Promise<void>;

  /** Optional secondary indexes oidc-provider expects when those features are enabled. */
  genericFindByUserCode?(userCode: string): Promise<unknown | null>;
  genericFindByUid?(uid: string): Promise<unknown | null>;
  genericRevokeByGrantId?(grantId: string): Promise<void>;
}
