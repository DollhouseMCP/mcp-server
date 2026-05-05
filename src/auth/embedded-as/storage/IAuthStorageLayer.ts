/**
 * IAuthStorageLayer
 *
 * Typed K/V persistence backend for the embedded authorization server.
 * Two responsibilities:
 *
 *   1. Semantic account model (must-fix #18: keyed on
 *      `(provider, externalSub)`) plus the identity-change audit log
 *      (must-fix #21). Methods + storage layer own this directly.
 *
 *   2. Generic K/V escape hatch (genericGet/Set/Destroy) that
 *      OidcProviderAdapter translates oidc-provider's Adapter calls
 *      into. All ephemeral OAuth state — Session, Grant, Interaction,
 *      AuthorizationCode, RefreshToken, AccessToken,
 *      RegistrationAccessToken, ReplayDetection,
 *      BackchannelAuthenticationRequest — flows through this path.
 *
 * Atomicity for refresh-token rotation and authorization-code single-use
 * lives inside oidc-provider itself, not in this interface. An earlier
 * draft of this interface defined `rotateRefreshToken`,
 * `revokeRefreshTokenFamily`, `consumeAuthorizationCode`,
 * `storeRefreshToken`, `storeAuthorizationCode` with strong "MUST be
 * atomic" wording — but no code path actually called them; oidc-provider
 * drives rotation through the generic Adapter contract. Removing those
 * methods (C9) eliminated dead code that misleadingly advertised
 * atomicity guarantees the runtime did not provide.
 *
 * Implementations:
 *   - InMemoryAuthStorageLayer (C3) — solo-dev default
 *   - SqliteAuthStorageLayer / PostgresAuthStorageLayer — when the auth
 *     schema lands; out of scope for the §8.1 PR
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
  /**
   * Epoch ms of the most recent successful authentication. Sourced by the
   * extraTokenClaims hook to populate the `auth_time` claim on issued
   * tokens; future step-up enforcement compares against scope-specific
   * max-age windows. Updated by finishInteractionWithIdentity on every
   * interactionFinished login.
   */
  lastAuthAt?: number;
}

export interface IdentityAuditEvent {
  /** e.g. 'auth.social.identity_changed', 'auth.local.brute_force_suspected'. */
  type: string;
  sub?: string;
  provider?: string;
  externalSub?: string;
  details?: Record<string, unknown>;
  timestamp: number;
}

export interface IdentityEventFilter {
  /** Only events of this type. Exact-match. */
  type?: string;
  /** Only events for this account sub. Exact-match. */
  sub?: string;
  /** Only events at or after this epoch ms. */
  since?: number;
}

/**
 * Storage contract. All methods are async. The semantic account methods
 * are owned by the IAuthMethod implementations; the generic methods are
 * owned by OidcProviderAdapter (the only caller).
 */
export interface IAuthStorageLayer {
  // --- Accounts (must-fix #18) ---

  findAccountByExternalId(provider: string, externalSub: string): Promise<StoredAccount | null>;
  upsertAccount(account: StoredAccount): Promise<void>;
  getAccount(sub: string): Promise<StoredAccount | null>;

  // --- Audit (must-fix #21) ---

  /**
   * Append an identity audit event. Storage is append-only by contract; do
   * not amend or delete events after they land. Backends may rotate or
   * archive at the operator's discretion outside this interface.
   */
  recordIdentityEvent(event: IdentityAuditEvent): Promise<void>;

  /**
   * Query the audit log. Used by tests, operator-facing audit consumption,
   * and by methods that need to reason about prior events (e.g. anomaly
   * detection consuming `auth.social.identity_changed`). Filters compose
   * with AND semantics; returns events sorted by timestamp ascending.
   */
  listIdentityEvents(filter?: IdentityEventFilter): Promise<IdentityAuditEvent[]>;

  // --- Grants (Phase 5 H14: revoke-on-identity-change) ---

  /**
   * Return grant ids associated with the given account sub. Used by the
   * identity-change handler to revoke stale refresh families when a social
   * account's verified email mapping moves between logins. Implementations
   * may scan the Grant model in storage; backends with proper indexes
   * should query directly.
   */
  findGrantsByAccountId(sub: string): Promise<string[]>;

  // --- Generic K/V backing oidc-provider's Adapter ---
  // Models routed here: Session, Grant, Interaction, AuthorizationCode,
  // RefreshToken, AccessToken, RegistrationAccessToken, ReplayDetection,
  // PushedAuthorizationRequest, BackchannelAuthenticationRequest.

  genericGet(model: string, id: string): Promise<unknown | null>;
  genericSet(model: string, id: string, payload: unknown, expiresInSec?: number): Promise<void>;
  genericDestroy(model: string, id: string): Promise<void>;

  /**
   * Bulk-delete all entries for the given models. Used on mode-switch
   * invalidation (must-fix #14): when the AS detects its operating mode
   * has changed since last run, it clears OAuth-state models so prior
   * tokens / sessions / interactions cannot be reused.
   *
   * Returns the number of entries deleted. Backends with native bulk
   * delete (Postgres `DELETE WHERE model IN (...)`) should issue one
   * statement; in-memory and filesystem backends iterate.
   */
  clearGenericByModels(models: readonly string[]): Promise<number>;

  /** Optional secondary indexes oidc-provider expects when those features are enabled. */
  genericFindByUserCode?(userCode: string): Promise<unknown | null>;
  genericFindByUid?(uid: string): Promise<unknown | null>;
  genericRevokeByGrantId?(grantId: string): Promise<void>;
}
