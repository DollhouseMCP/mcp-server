-- Historical operator receipts only. Installing this table establishes no coverage.
CREATE TABLE "memory_head_invalidation_runs" (
  "run_id" UUID PRIMARY KEY,
  "format_version" INTEGER NOT NULL,
  "claim" TEXT NOT NULL,
  "request_sha256" TEXT NOT NULL,
  "catalog_sha256" TEXT NOT NULL,
  "pre_manifest_sha256" TEXT NOT NULL,
  "post_manifest_sha256" TEXT NOT NULL,
  "maintenance_evidence_sha256" TEXT NOT NULL,
  "candidate_commit" TEXT NOT NULL,
  "maintenance_evidence_id" TEXT NOT NULL,
  "declared_context_id" TEXT NOT NULL,
  "database_name" TEXT NOT NULL,
  "effective_role" TEXT NOT NULL,
  "database_oid" BIGINT NOT NULL,
  "server_version_num" INTEGER NOT NULL,
  "owner_count" INTEGER NOT NULL,
  "tag_count" INTEGER NOT NULL,
  "started_at" TIMESTAMPTZ NOT NULL,
  "finished_at" TIMESTAMPTZ NOT NULL,
  "can_apply" BOOLEAN NOT NULL,
  "can_activate" BOOLEAN NOT NULL,
  CONSTRAINT "memory_head_invalidation_runs_claim_check" CHECK (
    format_version = 1 AND claim = 'historical-exact-owner-set-invalidation'
    AND can_apply = false AND can_activate = false),
  CONSTRAINT "memory_head_invalidation_runs_digests_check" CHECK (
    request_sha256 ~ '^[a-f0-9]{64}$' AND catalog_sha256 ~ '^[a-f0-9]{64}$'
    AND pre_manifest_sha256 ~ '^[a-f0-9]{64}$' AND post_manifest_sha256 ~ '^[a-f0-9]{64}$'
    AND maintenance_evidence_sha256 ~ '^[a-f0-9]{64}$' AND candidate_commit ~ '^[a-f0-9]{40}$'),
  CONSTRAINT "memory_head_invalidation_runs_declarations_check" CHECK (
    octet_length(maintenance_evidence_id) BETWEEN 1 AND 128
    AND octet_length(declared_context_id) BETWEEN 1 AND 128),
  CONSTRAINT "memory_head_invalidation_runs_attribution_check" CHECK (
    octet_length(database_name) BETWEEN 1 AND 63 AND octet_length(effective_role) BETWEEN 1 AND 63
    AND database_oid BETWEEN 1 AND 4294967295 AND server_version_num > 0),
  CONSTRAINT "memory_head_invalidation_runs_counts_check" CHECK (
    owner_count BETWEEN 0 AND 10000 AND tag_count BETWEEN 0 AND 100000),
  CONSTRAINT "memory_head_invalidation_runs_times_check" CHECK (
    isfinite(started_at) AND isfinite(finished_at) AND finished_at >= started_at)
);
--> statement-breakpoint
-- Bootstrap may grant ordinary DML ACLs; default-deny RLS protects receipt rows.
-- Superuser/BYPASSRLS and whole-table privileges require separate operator proof.
ALTER TABLE "memory_head_invalidation_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memory_head_invalidation_runs" FORCE ROW LEVEL SECURITY;
