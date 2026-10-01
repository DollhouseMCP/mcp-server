# Database memory tag invalidation

## Partial function and trigger catalog proof

`verifyDatabaseMemoryInvalidationCatalog(tx)` is a dormant PG17-only helper that
uses one bounded metadata statement on the caller's transaction. It checks the
five exact reviewed 0056/0057 function bodies and execution-shape descriptors,
their three user-trigger attachments, and absence of additional user triggers
on the three relevant public tables. Expected bodies are pinned in source and
checked byte-for-byte against migration artifacts; instance OIDs do not enter
the digest of the complete validated portable descriptors.

Ordinary roles may provide this metadata proof; missing, oversized, ambiguous or
changed observations refuse without raw database errors. The caller controls
isolation and timeouts. No own transaction, lock, role or search-path change is
made. `provesExecutionResolution`, `canBackfill`, `canApply` and `canActivate`
remain false: unqualified references in those bodies still require a separately
qualified execution context, including temporary-schema shadowing. This proves
no table/policy/ledger contract, global inventory, quiescence, commit or current
maintenance authority. No runtime registration or executor is added.

## Dormant historical receipt schema

Migration 0058 adds `memory_head_invalidation_runs` for future operator receipts,
with a non-nil run UUID, versioned historical claim, request/catalog/pre/post manifest and
maintenance digests, bounded declared context and observed database/actor attribution,
counts and finite ordered timestamps. It stores no owner manifests or payloads.
`can_apply` and `can_activate` must always be false. Declarations and observed database
identifiers do not prove restore detection, quiescence or current coverage.
The schema accepts any PostgreSQL UUID except nil and excludes the Git null
commit sentinel; it does not prove external run identity or nonzero commit existence.

ENABLE and FORCE RLS with no policies protect rows despite bootstrap DML grants.
Superuser/BYPASSRLS bypass and whole-table privileges need separate proof; RLS does
not protect TRUNCATE or REFERENCES. No role/grant change, writer/API, executor,
backfill or activation is introduced. Installing this schema is not coverage.

Migration 0057 makes direct `element_tags` INSERT/UPDATE/DELETE invalidate each affected memory head: `storage_revision` advances and `memory_entries_out_of_sync` becomes true. Moving a tag invalidates both distinct memory owners once, in `(element_id, user_id)` order. Visible nonmemory parents retain existing behavior; a memory/nonmemory move invalidates only the memory side. Whole-head saves read the final revision after tag and entry triggers and qualification, returning it only after commit.

The trigger uses invoker privileges and FORCE RLS. A memory parent must match the tag tenant and current tenant. INSERT/UPDATE rejects absent or invisible parents because their type and ownership cannot be proved; this tightens legacy behavior for invisible nonmemory targets too. Visible mismatched memory parents fail with SQLSTATE 23503, including DELETE. A missing/invisible parent on DELETE is permitted for parent/account cascades and cleanup of inaccessible legacy references. No foreign head is mutated. Existing malformed references to visible foreign memories can prevent deletion/account erasure until separately reviewed operator cleanup; installing the trigger does not repair them.

Stable parent order does not eliminate direct tag-row → parent versus whole-head parent → tag lock inversion. PostgreSQL aborts the losing transaction. Guarded saves expose 40P01/40001 as `EHEADCONFLICT`; callers refresh/reconcile explicitly, never blindly retry stale content. Legacy/direct callers retain PostgreSQL errors and need the later writer-routing qualification in #2906.

## Preexisting data and activation gate

This migration installs safeguards only. It contains no all-row UPDATE or backfill. Existing clean memory rows may have already-stale tag projections; installing a trigger cannot qualify their tokens. #2904 stays open for a separately reviewed bounded invalidation slice, and #2907 activation remains blocked. Reconciliation apply belongs to #2905; ordinary writer routing and rollover remain unenabled.

The next slice must implement and qualify all of these requirements before execution:

1. Quiesce every legacy/cooperating writer for the maintenance window; record candidate version, writer inventory, restore/rollback procedure, expected locks, WAL/space bounds and bounded statement/lock timeouts. Preserve archives on application rollback; no destructive down-migration.
2. Independently enumerate the complete tenant/owner inventory through an audited operator path. FORCE RLS tenant-local counts are not global coverage proof. Audit mismatched `element_tags` parent tenants, including public and private parents, and separately review their cleanup; do not assign foreign data to a new owner or bypass RLS in the application trigger.
3. Freeze a durable deployment-specific owner manifest and its counts/hash. Include every preexisting memory owner, including already-dirty rows. A read-only per-tenant count is a dry-run input, never a completion marker. Set explicit row/byte/time caps and resumable pagination; refuse incomplete enumeration.
4. For each bounded tenant batch, atomically mark manifest owners dirty and bump their revision together with an idempotence ledger keyed by deployment and owner. A ledger-proven completed owner must never be bumped twice on retry. `UPDATE ... WHERE dirty=false` alone is insufficient: ordinary writers can clean rows between retries. Handle deleted/recreated owners explicitly using durable UUIDs; changing inventory invalidates the completion proposal.
5. Independently verify manifest/ledger and authoritative all-tenant coverage, mismatch cleanup, expected dirty state and revision advancement before writing a durable completion marker tied to candidate/schema/manifest. Counts from a tenant-scoped migration connection cannot prove this. Failures preserve resumable evidence and block activation.
6. Keep normal guarded writers disabled until all-writer integration, locked reconciliation, archive phantom protection, rollback and the shared #2870/#2871 release checks are qualified. Merging this foundation does not authorize production migration, backfill, reconciliation, deployment or activation.

The PostgreSQL integration qualification uses a non-superuser, non-BYPASSRLS application role and asserts FORCE RLS, direct I/U/D, ABA, moves, tenant denial, cascades, rollback, final tokens and a controlled lock inversion. It must run with a reachable isolated test database; unavailable PostgreSQL is a failure, not a skipped qualification.

## Dormant bounded operator census (#2904-A)

`DatabaseMemoryLegacyTagAuditor.inspect(limits)` is an unwired diagnostic foundation. It observes memory owners and global tag-parent references in one fresh `REPEATABLE READ READ ONLY` transaction. It does not scan every memory entry, modify data, repair malformed references, produce a maintenance receipt, or authorize backfill, reconciliation, cleanup or activation.

The effective `CURRENT_USER` must be a superuser or have `BYPASSRLS`, retain SELECT privileges, and prove that row security is inactive for both inspected tables. Table ownership alone is insufficient under FORCE RLS. The auditor also checks the expected base tables, FORCE RLS catalog, revision/dirty and UUID identity columns, deterministic projection primary keys and enabled invoker tag trigger. This is a limited structural prerequisite check; it does not attest migration-ledger completion, schema version 57, foreign-key coverage or the trigger function source. A tenant-scoped connection cannot obtain a complete global report.

Explicit positive limits are captured before database access: at most 10,000 memory owners, 100,000 tags, 16 MiB of projected/output bytes, 20 attribution samples, five seconds per SQL statement and a 30-second report-validity deadline checked between statements. The deadline is not a hard execution/cancellation bound: pool acquisition, transaction setup/commit, network waits and the internal test barrier can exceed it. An expired report is unknown; transport/operator execution limits remain separate. Queries inspect a deterministic bounded prefix plus one overflow row; PostgreSQL statement timeouts also bound expensive scans/sorts. The census counts orphan tag parents and mismatched memory tenants for both public and private parents. It never returns names, tag values or raw content.

Reports distinguish `complete`, `incomplete` and sanitized `unknown`. Row/byte coverage caps yield incomplete coverage with no completed manifest digest. Truncating attribution samples alone does not invalidate otherwise complete aggregate coverage. Query, privilege, schema or deadline failures yield unknown and no counts/digest. Private owner UUID/revision/dirty attribution and mismatch samples require protected handling; they must not enter routine logs. A complete owner-manifest SHA-256 identifies this diagnostic projection only, and is neither a durable deployment marker nor proof that later inventory is unchanged. Every outcome explicitly sets `canBackfill`, `canApply` and `canActivate` to false.

Migration 0057 was installed in the approved September 30 controlled deployment (schema 57; #2461 deployment receipt). That installation did not execute this global census, backfill or completion protocol. The remaining #2904 maintenance slices still require separate protocol review and execution authorization, including quiescence/phantoms, durable provenance, bounded resumability and independently verified completion. This read-only foundation does not settle those decisions.

Real isolated PostgreSQL qualification covers privileged and BYPASSRLS visibility, ordinary effective roles/table owners under FORCE RLS, malformed private/public references, deterministic caps, sample truncation, concurrent writes across the single snapshot, real read-only/statement-timeout refusals and unchanged head revisions. No production connection or default integration global setup is required.

## Pure supplied-owner verification

`captureDatabaseMemoryOwnerManifest` captures canonical UUID identities, positive
signed-bigint decimal revisions and boolean dirty flags. Its synchronous result
is deeply frozen and protected. `verifyDatabaseMemoryOwnerInvalidation` compares
two independently validated supplied sets: exact tenant/owner membership,
exactly one revision advance and every returned owner dirty, including already
dirty inputs. Empty sets are valid; duplicate/rebound identities are refused.

Each set is capped at 10,000 owners; versioned UTF-8 JSON projection envelopes
(including counts, tuples, delimiters and false authority flags) are capped at
16 MiB. Their bytes/hash exclude returned hash/byte-count metadata. Fixed UUID
and revision sizes make the owner cap tighter than the byte cap. Encoding uses
lowercase UUIDs, owner/tenant code-unit ordering and fixed tuple/key ordering.

These hashes identify supplied values only. A truncated input cannot establish
database completeness, and a matching return set proves neither SQL execution
nor commit. All results retain `canBackfill:false`, `canApply:false` and
`canActivate:false`. No database access, durable receipt, catalog attestation,
runtime wiring or maintenance execution is added; those slices remain held.
