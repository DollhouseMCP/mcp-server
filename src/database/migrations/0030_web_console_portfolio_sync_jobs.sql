-- User-owned portfolio synchronization job queue for Milestone 4.
-- Jobs are private workflow state. Fenced claim_version leases prevent stale
-- workers from committing after a lease is reclaimed.

CREATE TABLE IF NOT EXISTS "portfolio_sync_jobs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "integration_id" UUID NOT NULL REFERENCES "user_integrations"("id") ON DELETE RESTRICT,
  "direction" TEXT NOT NULL,
  "conflict_policy" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "claim_version" BIGINT NOT NULL DEFAULT 0,
  "claimed_by_worker_id" TEXT,
  "lease_until" TIMESTAMPTZ,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "result_summary" JSONB,
  "operational_error_code" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "started_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  CONSTRAINT "portfolio_sync_jobs_direction_check"
    CHECK ("direction" IN ('pull', 'push', 'bidirectional')),
  CONSTRAINT "portfolio_sync_jobs_conflict_policy_check"
    CHECK ("conflict_policy" IN ('fail', 'prefer_local', 'prefer_remote')),
  CONSTRAINT "portfolio_sync_jobs_status_check"
    CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT "portfolio_sync_jobs_shape_check"
    CHECK (
      "claim_version" >= 0
      AND "attempt_count" >= 0
      AND ("claimed_by_worker_id" IS NULL OR (
        btrim("claimed_by_worker_id") <> ''
        AND char_length("claimed_by_worker_id") <= 128
      ))
      AND ("operational_error_code" IS NULL OR (
        btrim("operational_error_code") <> ''
        AND char_length("operational_error_code") <= 100
      ))
      AND ("result_summary" IS NULL OR (
        jsonb_typeof("result_summary") = 'object'
        AND char_length("result_summary"::text) <= 4096
      ))
      AND (
        ("status" = 'running'
          AND "claimed_by_worker_id" IS NOT NULL
          AND "lease_until" IS NOT NULL
          AND "completed_at" IS NULL)
        OR ("status" <> 'running'
          AND "claimed_by_worker_id" IS NULL
          AND "lease_until" IS NULL)
      )
      AND (
        ("status" IN ('succeeded', 'failed', 'cancelled') AND "completed_at" IS NOT NULL)
        OR ("status" NOT IN ('succeeded', 'failed', 'cancelled') AND "completed_at" IS NULL)
      )
      AND (
        ("status" = 'failed' AND "operational_error_code" IS NOT NULL)
        OR ("status" <> 'failed' AND "operational_error_code" IS NULL)
      )
    )
);
CREATE INDEX IF NOT EXISTS "idx_portfolio_sync_jobs_user"
  ON "portfolio_sync_jobs" ("user_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_portfolio_sync_jobs_user_pending_unique"
  ON "portfolio_sync_jobs" ("user_id")
  WHERE "status" IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS "idx_portfolio_sync_jobs_claimable"
  ON "portfolio_sync_jobs" ("status", "lease_until", "created_at");
CREATE INDEX IF NOT EXISTS "idx_portfolio_sync_jobs_integration"
  ON "portfolio_sync_jobs" ("integration_id");
ALTER TABLE "portfolio_sync_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portfolio_sync_jobs" FORCE ROW LEVEL SECURITY;

-- Sync execution workers must re-check user_integrations.status = 'connected'
-- before provider work because integrations are soft-deleted by revocation.
