-- Remove the never-produced 'cancelled' portfolio-sync job status.
-- No cancel operation exists to emit it (the store exposes only create/claim/renew/
-- complete/fail), so the value is dropped from both status CHECK constraints. Nothing
-- ever wrote 'cancelled', so no rows carry it and no data migration is required. If a
-- real cancel path is added later, re-introduce the value together with its transition.

ALTER TABLE "portfolio_sync_jobs"
  DROP CONSTRAINT IF EXISTS "portfolio_sync_jobs_status_check";
ALTER TABLE "portfolio_sync_jobs"
  ADD CONSTRAINT "portfolio_sync_jobs_status_check"
    CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed'));

ALTER TABLE "portfolio_sync_jobs"
  DROP CONSTRAINT IF EXISTS "portfolio_sync_jobs_shape_check";
ALTER TABLE "portfolio_sync_jobs"
  ADD CONSTRAINT "portfolio_sync_jobs_shape_check"
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
        ("status" IN ('succeeded', 'failed') AND "completed_at" IS NOT NULL)
        OR ("status" NOT IN ('succeeded', 'failed') AND "completed_at" IS NULL)
      )
      AND (
        ("status" = 'failed' AND "operational_error_code" IS NOT NULL)
        OR ("status" <> 'failed' AND "operational_error_code" IS NULL)
      )
    );
