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
 * Implementations (all three ship in §8.1):
 *   - InMemoryAuthStorageLayer — non-durable; tests + the explicit
 *     "I know what I'm doing" dev opt-in.
 *   - FilesystemAuthStorageLayer — durable JSON + JSONL under the
 *     platform-correct state dir, atomic writes via fileLockManager.
 *     The default for solo / small-team deployments.
 *   - PostgresAuthStorageLayer — Drizzle-backed; recommended for
 *     hosted / multi-instance deployments.
 *
 * Backends are selected via `createAuthStorage` and exercised by an
 * identical contract test (`tests/integration/auth/storage-parity.test.ts`)
 * to guarantee substitutability.
 *
 * @module auth/embedded-as/storage/IAuthStorageLayer
 */

/**
 * Account credentials. **Never** include this in any serialization that
 * leaves the storage layer — it carries password hashes and other
 * authentication-bearing material. The field is typed as a typed shape
 * (not `unknown` / `Record<string, unknown>`) precisely so static
 * analysis can flag accidental inclusion in JSON dumps, audit log
 * payloads, or upstream-profile responses.
 *
 * Earlier code stored `passwordHash` inside `rawProfile`, which had two
 * problems:
 *   1. `rawProfile` was documented as "audit-only snapshot" — a future
 *      audit-export or operator-tooling path would have leaked the hash.
 *   2. The field type was `Record<string, unknown>`, so writing the hash
 *      here was syntactically indistinguishable from any other profile
 *      attribute. Splitting it onto its own typed field makes the
 *      "credential" boundary structural rather than convention-based.
 */
export interface StoredAccountCredentials {
  /** Argon2id hash for local-password method. Never included in tokens or audit. */
  passwordHash?: string;
}

export interface StoredAccount {
  /** `${provider}_${externalSub}` — the account identity in JWT `sub`. */
  sub: string;
  provider: string;
  externalSub: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
  /**
   * Audit-only snapshot of the most recent upstream profile. Never
   * carries credentials — those go on `credentials` below. Safe to
   * include in audit-event payloads + operator dumps.
   */
  rawProfile?: Record<string, unknown>;
  /** Authentication-bearing material. Must not leak into audit / claims / logs. */
  credentials?: StoredAccountCredentials;
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
  // (Removed `roles`: admin is a console-only concept stored per-user in
  // user_admin_roles. Auth accounts no longer carry authorization roles, and
  // tokens carry no `roles` claim.)
}

/**
 * Bootstrap state for multi-user mode (must-fix #22, spec L923).
 *
 * Multi-user methods (local-account, magic-link, github) MUST refuse to
 * accept authentication traffic until an operator has run the bootstrap
 * CLI to claim the first admin identity. This eliminates the race where
 * an attacker who can reach the AS could authenticate before the
 * legitimate operator and become the admin.
 *
 * The bootstrap CLI sets:
 *   - `completed: true`
 *   - `adminSub`: the JWT `sub` that will receive `roles: ['admin']`
 *     when they authenticate (e.g. `github_12345`, `magic-link_<hash>`,
 *     `local_alice`).
 *   - `adminMethod`: which IAuthMethod owns the pre-claimed identity.
 *     Used by the gate middleware to render the right "next step"
 *     message in the 503 body when bootstrap is incomplete.
 *
 * Trivial-consent and OIDC-bridge modes have no bootstrap concept; the
 * gate is skipped entirely for them.
 */
export interface BootstrapState {
  completed: boolean;
  adminSub?: string;
  /**
   * The IAuthMethod id that owns the pre-claimed admin identity. Matches
   * the `id` field on the concrete method classes (e.g. `LocalAccountMethod.id`
   * is `'local-password'`, not `'local-account'`, despite the class name).
   */
  adminMethod?: 'local-password' | 'magic-link' | 'github';
  completedAt?: number;
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
  /**
   * Maximum number of events to return. When omitted, the storage
   * layer applies its default cap (1000). The audit log is append-
   * only and grows unbounded over deployment lifetime; an admin
   * call without a `since` window could otherwise pull the entire
   * table into Node process memory. Cycle-12 fix.
   *
   * Pass `0` to explicitly disable the cap (return all matching
   * events). Use only for diagnostic / archive-export workflows
   * where the full audit history is needed and the caller has
   * verified the table size is bounded.
   */
  limit?: number;
}

/**
 * Default cap for `listIdentityEvents` when no limit is supplied.
 * Tunable via the filter; chosen to be large enough for one-shot
 * incident triage but small enough to prevent OOM on a long-running
 * deployment.
 */
export const DEFAULT_IDENTITY_EVENTS_LIMIT = 1000;

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

  // --- Bootstrap state (must-fix #22, spec L923) ---

  /**
   * Read the multi-user bootstrap state. Returns
   * `{ completed: false }` when no bootstrap has been recorded;
   * implementations MUST NOT treat absence as completion.
   */
  getBootstrapState(): Promise<BootstrapState>;

  /**
   * Record that the operator has bootstrapped the AS by claiming the
   * given admin identity. Idempotent: re-running with the same
   * `adminSub` is a no-op; running with a DIFFERENT `adminSub` after
   * the first bootstrap MUST fail (admin transfer is a separate
   * operation that should leave a clear audit trail and require
   * explicit force).
   *
   * Called by the `dollhouse-admin-bootstrap` CLI. Implementations
   * persist the state via the same durable storage path as everything
   * else — filesystem and Postgres survive restart; in-memory does not
   * (acceptable: in-memory mode is dev-only and re-bootstrapping on
   * each boot is the expected dev workflow).
   */
  markBootstrapComplete(
    adminSub: string,
    adminMethod: 'local-password' | 'magic-link' | 'github',
  ): Promise<void>;

  /**
   * Atomically stamp `lastAuthAt` (and `updatedAt`) on the account row
   * without re-writing the rest of it. Used by the InteractionRouter on
   * every successful login so that `extraTokenClaims` can emit the
   * `auth_time` claim (spec L927).
   *
   * Why a dedicated method: a `getAccount → upsertAccount(...existing,
   * lastAuthAt)` round-trip races against concurrent logins for the same
   * sub (two browser tabs, parallel OAuth flows). Lost-update on
   * `lastAuthAt` is benign — both writes land on now-ish — but the
   * round-trip also re-writes `displayName` and `rawProfile`, which a
   * fresh GitHub login may have just updated. A targeted update avoids
   * that hazard. Returns true if a row was found and updated, false if
   * the sub did not exist.
   */
  updateAccountLastAuth(sub: string, lastAuthAt: number): Promise<boolean>;

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

  genericGet(model: string, id: string): Promise<unknown>;
  genericSet(model: string, id: string, payload: unknown, expiresInSec?: number): Promise<void>;
  genericDestroy(model: string, id: string): Promise<void>;

  /**
   * Mark a record consumed by stamping `consumed: <epochMillis>` on its
   * payload while keeping the record findable. oidc-provider's Adapter
   * contract distinguishes consume from destroy: consumed records MUST
   * stay returnable from `find()` so the grant handlers can detect
   * replay (`payload.consumed`) and trigger family revocation per
   * OAuth 2.1 §6.1. An earlier shape that delete-on-consume bypassed
   * this entirely — replays returned `not found` and the family-revoke
   * path was never reached.
   *
   * Behavior: read-modify-write of the existing payload, preserving
   * the original TTL. Returns true when this call performed the mark
   * (first consume), false when the record was already consumed or
   * does not exist. Backends with row-level CAS (Postgres) implement
   * this as a single statement so two concurrent consumes can't both
   * report success.
   */
  genericConsume(model: string, id: string): Promise<boolean>;

  /**
   * Atomic "insert if not present" — returns true when a new record was
   * created, false when one already existed at the given (model, id).
   * Used by InviteTokenStore to enforce single-use across restart and
   * across processes (the in-memory consumed-Set evaporates on restart,
   * letting captured invites replay within their TTL).
   *
   * Backends:
   *   - InMemory: single-thread atomic check-and-set on the Map.
   *   - Filesystem: under the same lock that guards genericSet.
   *   - Postgres: INSERT ... ON CONFLICT DO NOTHING RETURNING id.
   *     Two concurrent inserts with the same id cannot both report
   *     success.
   */
  genericInsertIfAbsent(
    model: string,
    id: string,
    payload: unknown,
    expiresInSec?: number,
  ): Promise<boolean>;

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

  /**
   * Sweep all expired generic K/V entries. Runs the equivalent of
   *   DELETE FROM <kv> WHERE expires_at IS NOT NULL AND expires_at < NOW()
   * on each backend. Returns the number of rows deleted.
   *
   * Why this exists: lazy-expiry on `genericGet` / `genericConsume` only
   * cleans up rows that are individually fetched. Sessions whose owner
   * never returns, abandoned interactions, and revoked refresh-token
   * payloads accumulate forever otherwise. Operators on long-running
   * deployments should call this on a timer (every 1-6 hours) — the
   * recommended wiring is via LifecycleService.
   *
   * Idempotent and safe to call concurrently; backends serialize
   * naturally (Postgres MVCC, in-process Map iteration, filesystem
   * directory lock).
   */
  sweepExpiredKv(): Promise<number>;

  /** Optional secondary indexes oidc-provider expects when those features are enabled. */
  genericFindByUserCode?(userCode: string): Promise<unknown>;
  genericFindByUid?(uid: string): Promise<unknown>;
  genericRevokeByGrantId?(grantId: string): Promise<void>;

  // --- Sign-in allowlist (gates GitHub OAuth, magic-link, local-password) ---

  /**
   * List all allowlist entries. Used by the MCP-AQL admin read-allowlist
   * operation. Order is implementation-defined; callers that need a stable
   * order should sort by `createdAt` (also stable).
   */
  allowlistList(): Promise<AuthAllowlistEntry[]>;

  /**
   * Look up a single allowlist entry by id. Returns null if not found.
   * Used by the MCP-AQL admin update/delete operations to validate the
   * target exists before issuing the mutation.
   */
  allowlistFind(id: string): Promise<AuthAllowlistEntry | null>;

  /**
   * Insert a new allowlist entry. Returns the persisted row (including the
   * generated `id` and `createdAt`). The `value` is lowercased by the
   * storage layer; callers may pass mixed case. Throws on duplicate
   * `(kind, value)` — the unique index enforces this in Postgres and the
   * filesystem/in-memory layers reject equivalently.
   *
   * `createdBy` is the admin sub who issued the add. Pass `null` for the
   * seed-file path (no human admin attribution).
   */
  allowlistAdd(input: AllowlistAddInput): Promise<AuthAllowlistEntry>;

  /**
   * Update mutable fields on an existing entry. Only `note` is mutable —
   * `kind`/`value` changes require remove + recreate so the audit trail
   * has a clean delete/add pair instead of an opaque "edited" event.
   * Returns the updated row, or null if `id` was not found.
   */
  allowlistUpdate(id: string, patch: AllowlistUpdatePatch): Promise<AuthAllowlistEntry | null>;

  /**
   * Remove an allowlist entry by id. Returns true if a row was deleted,
   * false if the id did not exist. Lockout protection (refuse delete that
   * would leave zero allowed admins) is the responsibility of the caller —
   * storage is mechanical.
   */
  allowlistRemove(id: string): Promise<boolean>;

  /**
   * Gate-path check: does the active allowlist match ANY of the provided
   * identity values? Called on every sign-in completion (GitHub callback,
   * magic-link consume, local-password invite redeem) before the upsert.
   *
   * Pass only the identity values you have. The check is OR across the
   * three kinds — passing email + githubUsername returns true if either
   * is on the list. Values should be lowercased by the caller; storage
   * matches case-sensitively against the (already-lowercased) stored
   * values.
   *
   * Returns false when the allowlist is empty regardless of `required`
   * flag — the caller layer combines this result with
   * `DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED` to compute the gate decision.
   * Bootstrap-admin-always-passes is also a caller-layer concern.
   *
   * Implementations:
   *   - InMemory + Filesystem: linear scan over the loaded entries.
   *   - Postgres: indexed lookup via the unique (kind, value) index.
   */
  allowlistMatchesIdentity(values: AllowlistMatchValues): Promise<boolean>;
}

/**
 * Sign-in allowlist entry as persisted. The Drizzle schema in
 * `src/database/schema/authAllowlist.ts` mirrors this shape.
 */
export interface AuthAllowlistEntry {
  id: string;
  kind: AuthAllowlistKind;
  value: string;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
}

/** Match-key kind discriminator. Constrained at the DB layer to these three values. */
export type AuthAllowlistKind = 'email' | 'github_username' | 'github_id';

/** Input shape for `allowlistAdd`. `id` and `createdAt` are storage-assigned. */
export interface AllowlistAddInput {
  kind: AuthAllowlistKind;
  value: string;
  note?: string | null;
  createdBy?: string | null;
}

/** Mutable fields on an allowlist entry. */
export interface AllowlistUpdatePatch {
  note?: string | null;
}

/**
 * Identity values passed to `allowlistMatchesIdentity`. All optional — pass
 * only what you have. Values should be lowercased by the caller. For
 * `githubId` (numeric in upstream API), pass it as a string for index-key
 * uniformity with the stored values.
 */
export interface AllowlistMatchValues {
  email?: string;
  githubUsername?: string;
  githubId?: string;
}
