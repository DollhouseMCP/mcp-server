-- Cycle-16 fix (HIGH): partial expression index for genericRevokeByGrantId.
--
-- genericRevokeByGrantId fires the SQL:
--   DELETE FROM auth_kv
--   WHERE (model = 'Grant' AND id = ?)
--      OR payload->>'grantId' = ?
-- The first OR branch is covered by the auth_kv primary key. The second
-- branch — selecting tokens, sessions, codes, and other AS state that
-- references a specific grant via payload->>'grantId' — had no supporting
-- index, so it sequentially scanned the entire auth_kv table. Under the
-- H14 identity-change handler (GitHub user verifies a new email),
-- genericRevokeByGrantId is called per grant; multiple sequential scans
-- against a months-old auth_kv table can take seconds and hold shared
-- locks that stall concurrent inserts.
--
-- Partial index excludes Grant rows (which the PK + idx_auth_kv_grant_account
-- already cover) so writes to Grant rows don't hit two indexes.
--
-- Depends on: 0009_auth_tables.sql
-- §8.1 Cycle 16

CREATE INDEX IF NOT EXISTS "idx_auth_kv_grant_id_ref"
  ON "auth_kv" ((payload->>'grantId'))
  WHERE "model" != 'Grant' AND payload ? 'grantId';

-- Cycle-16 fix (HIGH): replace idx_auth_kv_expires with a partial
-- variant that excludes the (large) population of TTL-less rows.
--
-- The original index (0009_auth_tables.sql) covered every auth_kv row
-- including those with expires_at IS NULL (which are inherently
-- non-expiring). A periodic sweep query
--   DELETE FROM auth_kv WHERE expires_at IS NOT NULL AND expires_at < NOW()
-- benefits from a partial index that already filters out NULL rows;
-- without the partial qualifier the planner has to evaluate the IS NOT
-- NULL predicate against every indexed row.
--
-- Drop and recreate is O(n) on auth_kv build time but cheap on a small
-- table. For very large existing deployments the recreation is still
-- short relative to the lifetime of the deployment.

DROP INDEX IF EXISTS "idx_auth_kv_expires";
CREATE INDEX IF NOT EXISTS "idx_auth_kv_expires" ON "auth_kv" ("expires_at")
  WHERE "expires_at" IS NOT NULL;
