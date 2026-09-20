ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "activation_state" TEXT NOT NULL DEFAULT 'active';

ALTER TABLE "users"
  ADD CONSTRAINT "users_activation_state_check"
  CHECK ("activation_state" IN ('active', 'pending_activation'));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "account_invitations" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "email_original" TEXT NOT NULL,
  "email_normalized" TEXT NOT NULL,
  "inviter_user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "intended_display_name" TEXT,
  "intended_username" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "current_generation" INTEGER NOT NULL DEFAULT 1,
  "accepted_at" TIMESTAMPTZ,
  "revoked_at" TIMESTAMPTZ,
  "expired_at" TIMESTAMPTZ,
  "correlation_id" UUID NOT NULL,
  "version" BIGINT NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "account_invitations_state_check" CHECK ("state" IN ('pending', 'accepted', 'expired', 'revoked')),
  CONSTRAINT "account_invitations_generation_check" CHECK ("current_generation" > 0),
  CONSTRAINT "account_invitations_version_check" CHECK ("version" > 0),
  CONSTRAINT "account_invitations_email_check" CHECK (btrim("email_original") <> '' AND btrim("email_normalized") <> ''),
  CONSTRAINT "account_invitations_username_check" CHECK (btrim("intended_username") <> ''),
  CONSTRAINT "account_invitations_state_timestamps_check" CHECK (
    ("state" = 'pending' AND "accepted_at" IS NULL AND "revoked_at" IS NULL AND "expired_at" IS NULL)
    OR ("state" = 'accepted' AND "accepted_at" IS NOT NULL AND "revoked_at" IS NULL AND "expired_at" IS NULL)
    OR ("state" = 'revoked' AND "accepted_at" IS NULL AND "revoked_at" IS NOT NULL AND "expired_at" IS NULL)
    OR ("state" = 'expired' AND "accepted_at" IS NULL AND "revoked_at" IS NULL AND "expired_at" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_account_invitations_pending_email_unique"
  ON "account_invitations" ("email_normalized") WHERE "state" = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS "idx_account_invitations_pending_user_unique"
  ON "account_invitations" ("user_id") WHERE "state" = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS "idx_account_invitations_id_user_unique"
  ON "account_invitations" ("id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_account_invitations_user"
  ON "account_invitations" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_account_invitations_expiry_state"
  ON "account_invitations" ("state", "updated_at");
ALTER TABLE "account_invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_invitations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "account_invitation_generations" (
  "invitation_id" UUID NOT NULL REFERENCES "account_invitations"("id") ON DELETE RESTRICT,
  "generation" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "credential_hash" BYTEA NOT NULL,
  "issued_at" TIMESTAMPTZ NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "credential_consumed_at" TIMESTAMPTZ,
  "accepted_at" TIMESTAMPTZ,
  "revoked_at" TIMESTAMPTZ,
  "expired_at" TIMESTAMPTZ,
  "superseded_at" TIMESTAMPTZ,
  "version" BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY ("invitation_id", "generation"),
  CONSTRAINT "account_invitation_generations_number_check" CHECK ("generation" > 0),
  CONSTRAINT "account_invitation_generations_hash_check" CHECK (octet_length("credential_hash") = 32),
  CONSTRAINT "account_invitation_generations_version_check" CHECK ("version" > 0),
  CONSTRAINT "account_invitation_generations_expiry_check" CHECK ("expires_at" > "issued_at"),
  CONSTRAINT "account_invitation_generations_state_check" CHECK ("state" IN ('pending', 'accepted', 'expired', 'revoked', 'superseded')),
  CONSTRAINT "account_invitation_generations_state_timestamps_check" CHECK (
    ("state" = 'pending' AND "accepted_at" IS NULL AND "revoked_at" IS NULL AND "expired_at" IS NULL AND "superseded_at" IS NULL)
    OR ("state" = 'accepted' AND "accepted_at" IS NOT NULL AND "revoked_at" IS NULL AND "expired_at" IS NULL AND "superseded_at" IS NULL)
    OR ("state" = 'revoked' AND "accepted_at" IS NULL AND "revoked_at" IS NOT NULL AND "expired_at" IS NULL AND "superseded_at" IS NULL)
    OR ("state" = 'expired' AND "accepted_at" IS NULL AND "revoked_at" IS NULL AND "expired_at" IS NOT NULL AND "superseded_at" IS NULL)
    OR ("state" = 'superseded' AND "accepted_at" IS NULL AND "revoked_at" IS NULL AND "expired_at" IS NULL AND "superseded_at" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_account_invitation_generations_hash_unique"
  ON "account_invitation_generations" ("credential_hash");
CREATE INDEX IF NOT EXISTS "idx_account_invitation_generations_expiry"
  ON "account_invitation_generations" ("state", "expires_at");
ALTER TABLE "account_invitation_generations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_invitation_generations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "account_invitation_intended_roles" (
  "invitation_id" UUID NOT NULL REFERENCES "account_invitations"("id") ON DELETE RESTRICT,
  "role" TEXT NOT NULL,
  PRIMARY KEY ("invitation_id", "role"),
  CONSTRAINT "account_invitation_intended_roles_role_check"
    CHECK ("role" IN ('admin', 'account_admin', 'operator', 'auditor', 'security_admin'))
);
ALTER TABLE "account_invitation_intended_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_invitation_intended_roles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "account_invitation_claim_assertions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "invitation_id" UUID NOT NULL,
  "generation" INTEGER NOT NULL,
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "claim_owner_hash" BYTEA NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'open',
  "email_verified_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "expires_at" TIMESTAMPTZ NOT NULL,
  "last_exchanged_at" TIMESTAMPTZ NOT NULL,
  "completed_at" TIMESTAMPTZ,
  "revoked_at" TIMESTAMPTZ,
  "expired_at" TIMESTAMPTZ,
  "version" BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT "account_invitation_claim_generation_fk"
    FOREIGN KEY ("invitation_id", "generation")
    REFERENCES "account_invitation_generations"("invitation_id", "generation") ON DELETE RESTRICT,
  CONSTRAINT "account_invitation_claim_user_fk"
    FOREIGN KEY ("invitation_id", "user_id")
    REFERENCES "account_invitations"("id", "user_id") ON DELETE RESTRICT,
  CONSTRAINT "account_invitation_claim_owner_hash_check" CHECK (octet_length("claim_owner_hash") = 32),
  CONSTRAINT "account_invitation_claim_state_check" CHECK ("state" IN ('open', 'completed', 'revoked', 'expired')),
  CONSTRAINT "account_invitation_claim_version_check" CHECK ("version" > 0),
  CONSTRAINT "account_invitation_claim_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "account_invitation_claim_state_timestamps_check" CHECK (
    ("state" = 'open' AND "completed_at" IS NULL AND "revoked_at" IS NULL AND "expired_at" IS NULL)
    OR ("state" = 'completed' AND "completed_at" IS NOT NULL AND "revoked_at" IS NULL AND "expired_at" IS NULL)
    OR ("state" = 'revoked' AND "completed_at" IS NULL AND "revoked_at" IS NOT NULL AND "expired_at" IS NULL)
    OR ("state" = 'expired' AND "completed_at" IS NULL AND "revoked_at" IS NULL AND "expired_at" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_account_invitation_claim_generation_unique"
  ON "account_invitation_claim_assertions" ("invitation_id", "generation");
CREATE INDEX IF NOT EXISTS "idx_account_invitation_claim_user"
  ON "account_invitation_claim_assertions" ("user_id", "created_at");
ALTER TABLE "account_invitation_claim_assertions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_invitation_claim_assertions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "account_invitation_delivery_attempts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "invitation_id" UUID NOT NULL,
  "generation" INTEGER NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "state" TEXT NOT NULL,
  "provider" TEXT,
  "provider_message_id" TEXT,
  "failure_class" TEXT,
  "sanitized_detail" JSONB,
  "correlation_id" UUID NOT NULL,
  "requested_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "started_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "version" BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT "account_invitation_delivery_generation_fk"
    FOREIGN KEY ("invitation_id", "generation")
    REFERENCES "account_invitation_generations"("invitation_id", "generation") ON DELETE RESTRICT,
  CONSTRAINT "account_invitation_delivery_attempt_number_check" CHECK ("attempt_number" > 0),
  CONSTRAINT "account_invitation_delivery_state_check"
    CHECK ("state" IN ('not_attempted', 'submitting', 'submitted', 'failed', 'unknown')),
  CONSTRAINT "account_invitation_delivery_version_check" CHECK ("version" > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_account_invitation_delivery_attempt_unique"
  ON "account_invitation_delivery_attempts" ("invitation_id", "generation", "attempt_number");
CREATE INDEX IF NOT EXISTS "idx_account_invitation_delivery_state"
  ON "account_invitation_delivery_attempts" ("state", "requested_at");
ALTER TABLE "account_invitation_delivery_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_invitation_delivery_attempts" FORCE ROW LEVEL SECURITY;
