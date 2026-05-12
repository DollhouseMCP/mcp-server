/**
 * ISigningKeyStore
 *
 * Storage for AS signing key material. Replaces the filesystem persistence
 * in `src/auth/embedded-as/persistKeys.ts` (JWKS) and `cookieSecret.ts`
 * (cookie HMAC secret) when the DB backend is selected.
 *
 * Two distinct kinds discriminated by `kind`:
 *   - `'jwks'`   — ECDSA signing keypair stored as a JWK (private + public)
 *                  for `/token` issuance + `/jwks` publication.
 *   - `'cookie'` — HMAC secret for signing interaction cookies (per-stream
 *                  ticket binding, consent CSRF, etc.)
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

export type SigningKeyKind = 'jwks' | 'cookie';

/**
 * A stored signing key. `payload` shape depends on `kind`:
 *   - `'jwks'`   → a full JWK object: `{ kty, crv, alg, kid, x, y, d, ... }`
 *                  with `d` (private component) included. Public-only
 *                  consumers strip `d` before publishing on /jwks.
 *   - `'cookie'` → `{ secret: <base64-encoded-bytes>, length: number }`
 *                  for the HMAC secret.
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
   * Atomically install a new active key, marking any existing active key
   * of the same kind as inactive (with `rotatedAt = now`). The new key
   * is recorded with `active = true`, `createdAt = now`.
   *
   * If a key with the given kid already exists, throws — the caller is
   * expected to generate fresh material. Rotation does not re-use kids.
   */
  rotate(write: SigningKeyWrite): Promise<SigningKey>;

  /**
   * Permanently delete keys older than the given epoch ms. Used during
   * lifecycle cleanup to bound the audit tail; only inactive (rotated)
   * keys are eligible. Returns the count removed.
   */
  pruneRotatedBefore(beforeEpochMs: number): Promise<number>;
}
