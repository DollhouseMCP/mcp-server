-- Stable user integration error reasons for display-safe OAuth/provider triage.

ALTER TABLE "user_integrations"
  ADD COLUMN IF NOT EXISTS "error_reason" TEXT;

ALTER TABLE "user_integrations"
  DROP CONSTRAINT IF EXISTS "user_integrations_error_reason_check";
ALTER TABLE "user_integrations"
  ADD CONSTRAINT "user_integrations_error_reason_check"
    CHECK (
      ("status" = 'error'
        AND "error_reason" IN (
          'token_exchange_failed',
          'revocation_failed',
          'scope_denied',
          'provider_unavailable'
        ))
      OR ("status" <> 'error' AND "error_reason" IS NULL)
    );
