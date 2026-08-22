/**
 * ISigningKeyStore
 *
 * Storage for AS signing key material. Replaces the filesystem persistence
 * in `src/auth/embedded-as/persistKeys.ts` (JWKS) and `cookieSecret.ts`
 * (cookie HMAC secret) when the DB backend is selected.
 *
 * Key material is discriminated by `kind`:
 *   - `'jwks'`   — ECDSA signing keypair stored as a JWK (private + public)
 *                  for `/token` issuance + `/jwks` publication.
 *   - `'cookie'` — HMAC secret for signing interaction cookies (per-stream
 *                  ticket binding, consent CSRF, etc.)
 *   - `'invite'` — HMAC secret for invite, magic-link, and password-reset
 *                  token signatures.
 *
 * Exactly one row per kind is `active` at a time. `rotate()` marks the
 * current active row inactive and inserts a new active row in the same
 * transaction — for the Postgres backend this is enforced by a partial
 * unique index `(kind) WHERE active = TRUE`. Audit trail of rotated keys
 * accumulates without deletion.
 *
 * Why this exists: in filesystem mode with a non-persistent run dir
 * (tmpfs, ephemeral container storage), every restart regenerates the
 * JWKS keyfile → fresh `kid` → mode-fingerprint mismatch in
 * `EmbeddedAuthorizationServer.initialize()` → all OAuth state wiped →
 * users must re-authenticate. DB-backed keys survive container restart
 * AND let multiple replicas share signing material (the `L-R8-*`
 * multi-replica HA items).
 *
 * Three backends (InMemory + Filesystem + Postgres), backend selected by
 * `createSigningKeyStore`. Pairs with the auth storage backend selector
 * (`DOLLHOUSE_AUTH_STORAGE_BACKEND`) since signing keys are AS-internal,
 * not element-storage state.
 *
 * @module storage/signingKeys/ISigningKeyStore
 */

export type SigningKeyKind = 'jwks' | 'cookie' | 'invite';

/**
 * A stored signing key. `payload` shape depends on `kind`:
 *   - `'jwks'`   → a full JWK object: `{ kty, crv, alg, kid, x, y, d, ... }`
 *                  with `d` (private component) included. Public-only
 *                  consumers strip `d` before publishing on /jwks.
 *   - `'cookie'` → `{ secret: <base64-encoded-bytes>, length: number }`
 *                  for the HMAC secret.
 *   - `'invite'` → `{ secret: <base64-encoded-bytes>, length: number }`
 *                  for invite-token HMAC signatures.
 */
export interface SigningKey {
  /** Stable identifier. For `'jwks'` this is the JWK `kid`; for `'cookie'` opaque. */
  kid: string;
  kind: SigningKeyKind;
  payload: Record<string, unknown>;
  active: boolean;
  createdAt: number;
  /** Null/undefined while active; populated when the key is rotated out. */
  rotatedAt?: number;
  /** Populated when an operator explicitly retires the key from verification. */
  retiredAt?: number;
}

/**
 * Write-side new-key payload. The implementation stamps `createdAt` and
 * sets `active=true` on the new row, AND marks any existing active row
 * of the same kind inactive (with `rotatedAt = now`).
 */
export interface SigningKeyWrite {
  kid: string;
  kind: SigningKeyKind;
  payload: Record<string, unknown>;
}

/** Complete key-ring replacement performed during an authorization mode change. */
export interface SigningKeyModeTransition {
  /** Stable UUID reused by retries of the same logical mode transition. */
  transitionId: string;
  /**
   * Generation expected to own the active key ring. Undefined is accepted only
   * for a legacy ring that predates generation markers.
   */
  expectedGenerationFingerprint?: string;
  /** Generation installed by this transition. */
  targetGenerationFingerprint: string;
  /**
   * Fresh keys to install. Omit cookie or invite when that kind is supplied
   * by an operator-managed secret outside this store.
   */
  replacements: readonly SigningKeyWrite[];
  /** Shared retirement/creation timestamp, primarily for deterministic tests. */
  transitionedAt?: number;
}

export interface SigningKeyModeTransitionResult {
  /** Stable identity of the installed generation, including idempotent retries. */
  transitionId: string;
  /** True when this generation was already installed by another caller/retry. */
  alreadyApplied: boolean;
  /** Previously-verifying keys retired by the transition. */
  retired: readonly SigningKey[];
  /** Fresh active keys installed by the transition. */
  installed: readonly SigningKey[];
}

/**
 * Storage contract for signing keys. All methods async.
 *
 * Atomicity guarantees per backend:
 *   - InMemory: single-thread reference swaps on the in-process Map.
 *   - Filesystem: under `FileLockManager` lock, write the keys.json file
 *     with the updated key set in one atomic-write-temp-rename.
 *   - Postgres: `rotate()` issues a single transaction containing both
 *     UPDATE (mark old inactive) and INSERT (new active). The partial
 *     unique index `(kind) WHERE active = TRUE` enforces the invariant
 *     even if two writers race.
 */
export interface ISigningKeyStore {
  /**
   * Read the currently-active key for the given kind. Returns `null` when
   * no active key exists (first-start case — caller generates one and
   * calls `rotate()`).
   */
  getActive(kind: SigningKeyKind): Promise<SigningKey | null>;

  /**
   * Read a specific key by kid. Used during JWT validation when a token
   * carries a `kid` that may not be the currently-active one (rotation
   * grace window).
   */
  getByKid(kid: string): Promise<SigningKey | null>;

  /**
   * List all keys of a kind, both active and rotated, ordered by
   * `createdAt` descending. Used for /jwks publication (which serves
   * the active key plus a rotation-grace window of recently-rotated
   * public keys).
   */
  listByKind(kind: SigningKeyKind): Promise<SigningKey[]>;

  /**
   * Run an operation while the selected active key is protected from rotate,
   * retire, delete, and authorization-mode transition. Intended for issuing a
   * credential and completing its externally visible delivery atomically with
   * respect to key lifecycle changes.
   */
  withActiveKey<T>(
    kind: SigningKeyKind,
    operation: (key: SigningKey) => Promise<T>,
  ): Promise<T>;

  /**
   * Atomically install a new active key, marking any existing active key
   * of the same kind as inactive (with `rotatedAt = now`). The new key
   * is recorded with `active = true`, `createdAt = now`.
   *
   * If a key with the given kid already exists, throws — the caller is
   * expected to generate fresh material. Rotation does not re-use kids.
   */
  rotate(write: SigningKeyWrite): Promise<SigningKey>;

  /**
   * Assert that a prebound key is still the active key. PostgreSQL performs
   * this check with the caller's existing transaction and lifecycle advisory
   * lock so a one-connection pool never opens a nested transaction.
   */
  assertActiveKey(
    kid: string,
    kind: SigningKeyKind,
    transactionContext?: unknown,
  ): Promise<SigningKey>;

  /**
   * Atomically invalidate all still-verifying JWKS, cookie, and invite keys,
   * then install every applicable replacement. Implementations must expose no
   * intermediate state in which only part of the old authorization mode has
   * been invalidated or only part of the new mode has been installed.
   */
  transitionAuthorizationMode(
    transition: SigningKeyModeTransition,
  ): Promise<SigningKeyModeTransitionResult>;

  /**
   * Mark a key inactive and retired. Active keys may be retired for emergency
   * compromise response, leaving the kind with no active key until rotation.
   * Returns null when the kid does not exist.
   */
  retire(kid: string, retiredAt?: number): Promise<SigningKey | null>;

  /**
   * Permanently remove key material for a retired inactive key. Implementations
   * MUST reject active or merely-rotated keys unless `force` is true.
   */
  delete(kid: string, options?: { readonly force?: boolean }): Promise<boolean>;

  /**
   * Permanently delete keys older than the given epoch ms. Used during
   * lifecycle cleanup to bound the audit tail; only inactive (rotated)
   * keys are eligible. Returns the count removed.
   */
  pruneRotatedBefore(beforeEpochMs: number): Promise<number>;
}
