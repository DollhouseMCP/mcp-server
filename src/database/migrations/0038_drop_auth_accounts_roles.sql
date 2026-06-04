-- Drop the legacy per-identity `auth_accounts.roles` column.
--
-- Console admin roles are now authoritative in the per-user `user_admin_roles`
-- table (resolved live by the console; MCP/OAuth tokens carry no `roles` claim,
-- and admin is a console-only, step-up-gated concept). Before dropping the
-- column, backfill any admin grant still recorded on a LINKED auth account into
-- `user_admin_roles` so existing admins keep their access. Unlinked accounts
-- (user_id IS NULL) carry no authoritative role and are skipped.

INSERT INTO user_admin_roles (user_id, role, granted_by_user_id)
SELECT DISTINCT aa.user_id, r.role, aa.user_id
FROM auth_accounts aa
CROSS JOIN LATERAL jsonb_array_elements_text(aa.roles) AS r(role)
WHERE aa.user_id IS NOT NULL
  AND r.role IN ('admin', 'account_admin', 'operator', 'auditor', 'security_admin')
  AND NOT EXISTS (
    SELECT 1 FROM user_admin_roles uar
    WHERE uar.user_id = aa.user_id
      AND uar.role = r.role
      AND uar.revoked_at IS NULL
  );

ALTER TABLE auth_accounts DROP COLUMN IF EXISTS roles;
