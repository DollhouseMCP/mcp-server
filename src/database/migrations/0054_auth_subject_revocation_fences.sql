ALTER TABLE "users"
	ADD COLUMN IF NOT EXISTS "authz_changed_at" timestamp with time zone NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS "auth_subject_revocation_fences" (
	"subject_hash" varchar(64) PRIMARY KEY NOT NULL,
	"revoked_at" timestamp with time zone NOT NULL,
	"reason" varchar(32) NOT NULL,
	CONSTRAINT "auth_subject_revocation_fences_reason_check"
		CHECK ("reason" IN ('identity_unlinked', 'account_deleted'))
);

-- System authority only. The hosted grant pass gives the application role DML
-- on new tables by default, so forced RLS with no app policy keeps revocation
-- fences immutable from the lower-privilege request path while system/admin
-- connections retain their intended authority.
ALTER TABLE "auth_subject_revocation_fences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_subject_revocation_fences" FORCE ROW LEVEL SECURITY;
