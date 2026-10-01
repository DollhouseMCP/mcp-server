/** Dormant historical receipts: no writer, coverage or current mutation authority. */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, integer, text, bigint, timestamp, boolean, check } from 'drizzle-orm/pg-core';

export const memoryHeadInvalidationRuns = pgTable('memory_head_invalidation_runs', {
  runId: uuid('run_id').primaryKey(),
  formatVersion: integer('format_version').notNull(),
  claim: text('claim').notNull(),
  requestSha256: text('request_sha256').notNull(),
  catalogSha256: text('catalog_sha256').notNull(),
  preManifestSha256: text('pre_manifest_sha256').notNull(),
  postManifestSha256: text('post_manifest_sha256').notNull(),
  maintenanceEvidenceSha256: text('maintenance_evidence_sha256').notNull(),
  candidateCommit: text('candidate_commit').notNull(),
  maintenanceEvidenceId: text('maintenance_evidence_id').notNull(),
  declaredContextId: text('declared_context_id').notNull(),
  databaseName: text('database_name').notNull(),
  effectiveRole: text('effective_role').notNull(),
  databaseOid: bigint('database_oid', { mode: 'number' }).notNull(),
  serverVersionNum: integer('server_version_num').notNull(),
  ownerCount: integer('owner_count').notNull(),
  tagCount: integer('tag_count').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
  canApply: boolean('can_apply').notNull(),
  canActivate: boolean('can_activate').notNull(),
}, table => [
  check('memory_head_invalidation_runs_run_id_check', sql`${table.runId} <> '00000000-0000-0000-0000-000000000000'::uuid`),
  check('memory_head_invalidation_runs_claim_check', sql`${table.formatVersion} = 1
    AND ${table.claim} = 'historical-exact-owner-set-invalidation' AND ${table.canApply} = false AND ${table.canActivate} = false`),
  check('memory_head_invalidation_runs_digests_check', sql`${table.requestSha256} ~ '^[a-f0-9]{64}$'
    AND ${table.catalogSha256} ~ '^[a-f0-9]{64}$' AND ${table.preManifestSha256} ~ '^[a-f0-9]{64}$'
    AND ${table.postManifestSha256} ~ '^[a-f0-9]{64}$' AND ${table.maintenanceEvidenceSha256} ~ '^[a-f0-9]{64}$'
    AND ${table.candidateCommit} ~ '^[a-f0-9]{40}$' AND ${table.candidateCommit} <> repeat('0', 40)`),
  check('memory_head_invalidation_runs_declarations_check', sql`octet_length(${table.maintenanceEvidenceId}) BETWEEN 1 AND 128
    AND octet_length(${table.declaredContextId}) BETWEEN 1 AND 128`),
  check('memory_head_invalidation_runs_attribution_check', sql`octet_length(${table.databaseName}) BETWEEN 1 AND 63
    AND octet_length(${table.effectiveRole}) BETWEEN 1 AND 63 AND ${table.databaseOid} BETWEEN 1 AND 4294967295
    AND ${table.serverVersionNum} > 0`),
  check('memory_head_invalidation_runs_counts_check', sql`${table.ownerCount} BETWEEN 0 AND 10000 AND ${table.tagCount} BETWEEN 0 AND 100000`),
  check('memory_head_invalidation_runs_times_check', sql`isfinite(${table.startedAt}) AND isfinite(${table.finishedAt})
    AND ${table.finishedAt} >= ${table.startedAt}`),
]);
