-- Keyset-pagination indexes for the Family-B console list surfaces that scale with
-- the tenant/session population (see API contract §5.3). Each index matches the exact
-- ORDER BY + row-value cursor predicate of its query so pagination stays O(limit),
-- independent of table size, instead of the prior full-scan + sort under a hard cap.

-- Users directory: `ORDER BY created_at ASC, id ASC` over live accounts, cursor `(created_at, id) > ?`.
CREATE INDEX IF NOT EXISTS "idx_users_created_at_id_active"
  ON "users" ("created_at", "id")
  WHERE "deleted_at" IS NULL;

-- Cross-user operational sessions: `WHERE status=? ORDER BY last_active_at DESC, session_id DESC`,
-- cursor `(last_active_at, session_id) < ?`. `lease_until > now()` stays a residual filter.
CREATE INDEX IF NOT EXISTS "idx_runtime_session_presence_active_ordering"
  ON "runtime_session_presence" ("status", "last_active_at" DESC, "session_id" DESC);

-- Admin unlinked-logins directory: `WHERE user_id IS NULL ORDER BY created_at ASC, sub ASC`,
-- cursor `(created_at, sub) > ?`. Backs the identity-link picker.
CREATE INDEX IF NOT EXISTS "idx_auth_accounts_unlinked"
  ON "auth_accounts" ("created_at", "sub")
  WHERE "user_id" IS NULL;
