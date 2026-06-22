-- Phase 4.5 storage completion — Phase D.
--
-- auth_signing_keys stores AS signing key material that currently lives
-- in ~/.dollhouse/run/oauth-signing-key.json + cookie-signing-secret.bin.
-- DB-backed in DB-backend mode so:
--
--   (a) Container restart with persistent DB → keys survive →
--       mode-fingerprint doesn't reset on every restart →
--       previously-issued tokens remain valid → no surprise re-auth
--       (this is the bug Mick hit on the PoC: every container restart
--       regenerated the JWKS keyfile in tmpfs, the kid changed, and
--       all sessions got nuked).
--
--   (b) Multi-replica deployments → all replicas read the same active
--       signing key from the DB → tokens issued by replica A validate
--       on replica B → tokens portable across the replica set
--       (partially resolves the L-R8 multi-replica HA items from
--       §8.1 STATUS doc).
--
-- `kind` discriminates between:
--   'jwks'   — ECDSA signing keypair stored as a JWK (private + public)
--              for /token + /jwks endpoints
--   'cookie' — HMAC secret for signing interaction cookies (per-stream
--              ticket binding, consent CSRF, etc.)
--   'invite' — HMAC secret for invite, magic-link, and password-reset
--              token signatures.
--
-- Rotation marks the old row inactive WITHOUT deletion (audit trail);
-- rotated_at captures when. One row per (kind, active=true) at a time —
-- enforced by partial unique index.
--
-- No RLS — system-internal AS infrastructure, paired with auth_kv (also
-- no RLS). Operated only via system context.
--
-- Depends on: 0014_shared_cache.sql (numerical ordering only)

CREATE TABLE IF NOT EXISTS "auth_signing_keys" (
  "kid"        VARCHAR(255) PRIMARY KEY,
  "kind"       VARCHAR(32)  NOT NULL,
  "payload"    JSONB        NOT NULL,
  "active"     BOOLEAN      NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  "rotated_at" TIMESTAMPTZ
);
--> statement-breakpoint

-- Lookup for "the currently-active signing key of this kind"
-- — used on every token issuance + validation.
CREATE INDEX IF NOT EXISTS "idx_auth_signing_keys_kind_active"
  ON "auth_signing_keys" ("kind", "active");
--> statement-breakpoint

-- Enforce at most one active row per kind. The partial WHERE means rows
-- with active=FALSE are exempt from the uniqueness constraint, so the
-- audit trail of rotated keys can accumulate without colliding.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_auth_signing_keys_kind_active_unique"
  ON "auth_signing_keys" ("kind")
  WHERE "active" = TRUE;
