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

The dormant executor and its operational prerequisites must qualify all of these requirements before execution:

1. Quiesce every legacy/cooperating writer for the maintenance window; record candidate version, writer inventory, restore/rollback procedure, expected locks, WAL/space bounds and bounded statement/lock timeouts. Preserve archives on application rollback; no destructive down-migration.
2. Independently enumerate the complete tenant/owner inventory through an audited operator path. FORCE RLS tenant-local counts are not global coverage proof. Audit mismatched `element_tags` parent tenants, including public and private parents, and separately review their cleanup; do not assign foreign data to a new owner or bypass RLS in the application trigger.
3. Within one explicitly quiescent, DML-excluding atomic maintenance transaction, freshly capture the complete bounded global owner/tag inventory and audit malformed references. Include every memory owner, including already-dirty rows. The selected first pass caps owners at 10,000, tags at 100,000 and encoded owner projections at 16 MiB; over-cap or incomplete coverage refuses the whole transaction rather than paginating successful mutation. Diagnostic census reports are separate, read-only inputs and never completion authority.
4. Atomically mark all captured heads dirty and advance every revision exactly once, including already-dirty heads. Compare the exact returned tenant/owner set and +1 revisions against the captured set inside that same transaction. Publish only pre/post manifest digests and counts in the historical receipt, not retained UUID manifests or a per-owner batching ledger. Same-run replay must bind the original request and receipt; unknown commit requires receipt reconciliation before retry, never a blind second revision bump. The executor is implemented but dormant and unwired; its qualification and operational prerequisites remain pending.
5. The atomic receipt records historical invalidation only and always has false apply/activation flags. It cannot prove later inventory, restore continuity, current schema/resolution, malformed-reference coverage or readiness. Fresh locked apply/activation qualification, reviewed mismatch cleanup and shared release gates remain mandatory. Known precommit failure rolls back the attempt; unknown commit requires receipt reconciliation and makes no rollback claim. Incomplete/unknown outcomes block activation. There is no selected resumable paginated backfill or historical completion marker that authorizes current execution.
6. Keep normal guarded writers disabled until all-writer integration, locked reconciliation, archive phantom protection, rollback and the shared #2870/#2871 release checks are qualified. Merging this foundation does not authorize production migration, backfill, reconciliation, deployment or activation.

The PostgreSQL integration qualification uses a non-superuser, non-BYPASSRLS application role and asserts FORCE RLS, direct I/U/D, ABA, moves, tenant denial, cascades, rollback, final tokens and a controlled lock inversion. It must run with a reachable isolated test database; unavailable PostgreSQL is a failure, not a skipped qualification.

## Dormant bounded operator census (#2904-A)

`DatabaseMemoryLegacyTagAuditor.inspect(limits)` is an unwired diagnostic foundation. It observes memory owners and global tag-parent references in one fresh `REPEATABLE READ READ ONLY` transaction. It does not scan every memory entry, modify data, repair malformed references, produce a maintenance receipt, or authorize backfill, reconciliation, cleanup or activation.

The effective `CURRENT_USER` must be a superuser or have `BYPASSRLS`, retain SELECT privileges, and prove that row security is inactive for both inspected tables. Table ownership alone is insufficient under FORCE RLS. The auditor also checks the expected base tables, FORCE RLS catalog, revision/dirty and UUID identity columns, deterministic projection primary keys and enabled invoker tag trigger. This is a limited structural prerequisite check; it does not attest migration-ledger completion, schema version 57, foreign-key coverage or the trigger function source. A tenant-scoped connection cannot obtain a complete global report.

Explicit positive limits are captured before database access: at most 10,000 memory owners, 100,000 tags, 16 MiB of projected/output bytes, 20 attribution samples, five seconds per SQL statement and a 30-second report-validity deadline checked between statements. The deadline is not a hard execution/cancellation bound: pool acquisition, transaction setup/commit, network waits and the internal test barrier can exceed it. An expired report is unknown; transport/operator execution limits remain separate. Queries inspect a deterministic bounded prefix plus one overflow row; PostgreSQL statement timeouts also bound expensive scans/sorts. The census counts orphan tag parents and mismatched memory tenants for both public and private parents. It never returns names, tag values or raw content.

Reports distinguish `complete`, `incomplete` and sanitized `unknown`. Row/byte coverage caps yield incomplete coverage with no completed manifest digest. Truncating attribution samples alone does not invalidate otherwise complete aggregate coverage. Query, privilege, schema or deadline failures yield unknown and no counts/digest. Private owner UUID/revision/dirty attribution and mismatch samples require protected handling; they must not enter routine logs. A complete owner-manifest SHA-256 identifies this diagnostic projection only, and is neither a durable deployment marker nor proof that later inventory is unchanged. Every outcome explicitly sets `canBackfill`, `canApply` and `canActivate` to false.

Migration 0057 was installed in the approved September 30 controlled deployment (schema 57; #2461 deployment receipt). That installation did not execute this global census or atomic invalidation protocol. The remaining #2904 maintenance slices still require separate execution authorization and qualification of quiescence/phantoms, historical provenance, same-run replay/unknown commits and fresh current-state proof. Diagnostic census completeness does not implement or authorize that executor.

Real isolated PostgreSQL qualification covers privileged and BYPASSRLS visibility, ordinary effective roles/table owners under FORCE RLS, malformed private/public references, deterministic caps, sample truncation, concurrent writes across the single snapshot, real read-only/statement-timeout refusals and unchanged head revisions. No production connection or default integration global setup is required.

## Dormant maintenance receipt, policy and ledger observation

`verifyDatabaseMemoryMaintenanceCatalog(tx)` makes one bounded PG17 metadata
observation on a caller-owned transaction. It checks the exact 0058 receipt
columns, seven CHECKs, PK/index, no defaults/triggers/rewrite rules or policies;
required subject RLS flags and nine operation policies; and the exact hash/time
declarations for migrations 0056–0058. Expected descriptors come from reviewed
committed artifacts, never from live values. Ledger hashes use complete UTF-8
migration bytes before statement-breakpoint splitting; checkout pins those
three artifacts to LF. Matching ledger rows are historical declarations, not
proof that a migration executed or that its data coverage remains current.

Policy and receipt CHECK dependencies are inspected before normalization:
at most 16 raw rows each plus an overflow sentinel. Only exact permitted
`pg_class` relation/column dependencies qualify; explicit operator, function,
type, collation or foreign-relation dependencies refuse. Legitimate overlapping
UPDATE USING/WITH CHECK column dependencies may normalize to their exact union.
Other bounds are five relations, 21 receipt columns, two ledger columns, eight
receipt constraints, one index, nine policies and three ledger declarations,
each with an extra existence sentinel; expression projections cap at 4096
UTF-8 bytes. Bounds do not promise a hard query-duration/cancellation limit.

`observeDatabaseMemoryMaintenanceCatalog(tx)` invokes the existing function/
trigger and structure verifiers itself before this observation. Its multiple
SELECTs do not prove a coherent snapshot under arbitrary READ COMMITTED.
Both APIs return frozen fixed refusals without raw database errors or payloads,
and explicitly deny backfill, apply, activation, complete catalog, execution
resolution and coherent-snapshot authority. No BEGIN, SET, lock, role/grant,
writer, API, ledger write or executor is introduced. Ordinary roles with the
existing catalog and ledger permissions can qualify; no superuser gate is
invented. Locale/provider behavior, effective search path/temp shadowing,
replication mode and later global coverage/locks remain separate prerequisites.

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

## Partial required-structure observation

`verifyDatabaseMemoryInvalidationStructure(tx)` observes the PG17 catalog in one
statement on a caller-owned transaction. It verifies required columns, two
revision/dirty defaults, three primary keys and their backing indexes, five
foreign keys, and the positive revision check on `public.elements`,
`public.element_tags` and `public.memory_entries`. `public.users.id` is checked
only as their tenant-reference endpoint. All four relations must be ordinary
permanent nonpartition tables with no inbound or outbound inheritance edge.

Builtin type namespaces/typmods, nullability, generation/identity flags,
noninherited constraint semantics, exact ordered keys and cascade actions are
pinned to migrations 0000/0001/0003/0056. PK indexes must bind their actual
constraint/table identities, use btree and builtin ordered UUID/text opclasses,
and have ordinary key options and collations. The four collatable required
columns use `pg_catalog.default`; all other required attributes have collation
zero. This does not prove global locale/provider behavior. Visibility-specific
collation refusal is unit-qualified because dependent RLS policies prevent an
isolated ALTER; CI exercises visibility nullability and live collation drift on
raw_content, element_type (the same varchar width) and tag without changing policies.

Each FK additionally binds its actual selected unique reference index to the
referenced relation and single UUID key. The index must have immediate, valid,
ready/live btree uniqueness, default builtin UUID opclass, no includes,
expressions/predicate, collation zero and ordinary options. All three one-entry
FK comparison vectors must resolve to builtin UUID equality backed by the exact
`pg_catalog.uuid_eq(uuid,uuid)` boolean signature. This checks the selected
supporting index even for `users`; it requires neither a particular users index
name nor a complete users PK/index inventory. Arbitrary builtin implementation
changes remain unqualified.

Each scoped FK also requires exactly four internal RI triggers: insert/update
checks on its child and cascade-delete/no-action-update on its parent. Their
constraint/index/relation bindings, builtin zero-argument trigger functions,
normal-origin enablement, nondeferred flags and empty argument/column/WHEN/
transition-table state are checked and hashed. The observation is capped at
five triggers per FK. Missing-trigger refusal is unit-qualified; legal CI DDL
qualifies disabled child and replica-only parent triggers without dropping the
FK. This does not qualify the caller’s session_replication_role or confer
execution authority.

The positive CHECK must retain the migrated inheritable semantics (`connoinherit=false`),
even though current inheritance edges are independently refused. Its exact rendering
also requires no explicit operator/function
dependency on its constraint in `pg_depend`: PG17 omits dependencies on pinned
builtins, while custom operators/functions retain dependencies. This rejects a
custom same-spelling `>` operator that deparses identically. The helper neither
changes search_path nor parses expression trees; it does not attest arbitrary
changes to builtin catalog implementations.

Descriptor collections have fixed caps with overflow sentinels. Nested key
vectors and rendered expressions are bounded before projection; missing join
targets retain null/refusal evidence rather than disappearing. The immutable
result contains a deterministic portable contract digest, excluding instance
OIDs. Refusals expose only fixed codes, never raw SQL, driver errors or causes.
Ordinary roles may observe this metadata; the helper changes no roles, locks,
timeouts, isolation settings or database contents.

This structure component is a required-field projection, not full catalog
attestation. Its unrelated columns/indexes/checks and effective relation/function
search-path resolution remain unqualified. Receipt structure, required RLS/
policies and the three ledger declarations are observed by the separate dormant
maintenance component above; composition does not turn them into authority. A single
snapshot does not protect against later DDL or provide an execution token.
`canBackfill`, `canApply`, `canActivate`, `provesCompleteCatalog` and
`provesExecutionResolution` are always false. Global malformed-reference
qualification, bounded atomic invalidation and historical receipt/replay belong
to the explicit maintenance executor below; #2904 stays open until its remaining
qualification and operator prerequisites are satisfied.

Unit/artifact tests qualify portable matching, bounds and fixed refusals.
Required PG17 CI tests exercise actual migrations and ordinary-role READ ONLY
calls plus legal transactionally rolled-back DDL drift. Catalog flags that
cannot be changed through supported DDL are unit-only observations. This slice
requires no local database creation or existing service/credential changes.

## Dormant atomic maintenance executor

`DatabaseMemoryAtomicInvalidator` requires an explicitly supplied top-level
postgres-js connection. It is not registered in runtime DI, exposed through an
API, or enabled by configuration. Requests bind the canonical non-nil run UUID,
candidate commit, expected reviewed catalog digest, declared maintenance evidence
and context, and intended database name/OID in a versioned deterministic hash.
Declarations are attribution; they do not prove quiescence or restore continuity.

The executor configures its transaction with `SET LOCAL`, then acquires ordered
EXCLUSIVE locks on the receipt, elements, tags and entries tables before its first
snapshot-producing query. It checks current global visibility, privileges,
including SELECT and UPDATE on all four locked tables and receipt INSERT.
UPDATE is the supported lock-capable privilege for every fixed EXCLUSIVE lock;
the supplied connection's privileges are caller setup, and the executor grants
nothing. BYPASSRLS or superuser visibility is separately required. PostgreSQL 17
[LOCK privileges](https://www.postgresql.org/docs/17/sql-lock.html#SQL-LOCK-NOTES)
permit only ACCESS SHARE with SELECT alone; weakening to SHARE would not fix that.
It also checks
replication role, relation/function resolution and absence of elements rewrite
rules, then invokes the catalog components itself. A fresh global census refuses
incomplete coverage or malformed tag references. Fixed limits are 10,000 owners,
100,000 tags and 16 MiB of projected metadata. Every captured memory head is made
dirty with exactly one revision increment, including already-dirty heads. The
exact returned owner set is verified before inserting the existing historical
receipt in the same transaction. Content, tags, entries and archives are not
rewritten. Memory-volume exclusion and current reconciliation authority are not
claimed.

Matching same-run replay validates all 21 persisted receipt fields and declared
bindings after fresh context/catalog proof, then performs no invalidation. A
conflicting request refuses. `committed` is returned only after the outer driver
transaction acknowledges COMMIT. Deliberate refusal is `aborted` only when the
private invocation sentinel survives the inspected driver's acknowledged
ROLLBACK path. Other driver/connection failures remain `unknown`, never automatic
retry. These semantics are pinned to the reviewed postgres-js/Drizzle versions.
Raw SQL or transport failures can remain unknown even when the driver attempted
rollback; the API intentionally returns `reason:null` rather than raw errors or
unqualified phase diagnostics. A lock timeout is not automatically classified as
a known abort. Tracked fresh resolution is required to settle such uncertainty.

Unknown resolution requires the same retained private invocation state and an
independent supplied root connection. Outer rejection marks abandonment; the
callback checks it before locks and after awaited prewrite barriers. Resolution
stays unknown until that callback is privately drained, then its exclusion locks
serialize any outstanding backend finalization. A resolver's own refusal does
not establish that the original operation aborted. Proven receipt/absence clears
the local unresolved guard; any retry is a separate explicit call. Cold/untracked
resolution refuses, so this API does not implement operator restart recovery or
accept caller assertions that a prior transaction terminated. The executor never
terminates another backend or waits indefinitely for callback drainage.

Operator maintenance still requires cooperative DML/DDL quiescence: table locks
do not freeze functions or roles, and legacy child-first writes can deadlock with
the fixed lock order. Timeouts preserve uncertainty rather than steal locks.
Historical receipts always have `canApply=false` and `canActivate=false`; new
heads or later writes can invalidate their relevance. No receipt authorizes
#2905 apply, #2906 writer integration or #2907 activation.

Unit tests qualify the private outcome/drain envelope and receipt validation.
Real commit/replay qualification uses a uniquely owned database on the existing
required CI PG17 service, with exact ownership and cleanup. No local database,
new role/password or cluster grant is created. Normal nonrequired integration
runs skip this resource-owning suite; `DOLLHOUSE_REQUIRE_TEST_DATABASE=1` selects
all cases and fails if the CI harness or PostgreSQL is unavailable. Injected publication loss after a
real commit is distinguished from an actual network-level lost COMMIT
acknowledgement.
The ordinary-role fixture temporarily grants only normal DML privileges on the
four tables in that exclusively owned database to the existing app role, then
revokes them. This isolates FORCE RLS/global-visibility refusal from missing ACL
denial; it changes no shared database, role membership or production access.
An existing temporary same-name table is safe when the pinned search path still
resolves the required relation to public; the executor checks effective binding,
rather than treating every temporary relation as a refusal.

### Dormant same-parent file-memory RENAME

The managed RENAME entrypoints are being qualified as one executor with exact forward recovery. They require a current owned token, a caller-generated operation UUID and a different case-folded basename in the same existing canonical parent. They preserve content bytes/hash, owner ID and owner archive namespace, and reserve exactly one revision increment. Moving A to B and back to A therefore cannot revive the old token. Cross-parent and case-only renames remain unsupported. Runtime writer activation and deployment are separate prerequisites.

The schema-4 phase chain is BASE, destination RESERVED, PREPARED, LINKED, MOVED, DESTINATION_METADATA, METADATA and destination FINAL. Only complete, exact supported combinations forward automatically. BASE-only/asymmetric reservation, partial records, temporary stages and each mutation-before-next-record gap remain preserved/manual. Destination publication uses a no-replace hard link; the destination sidecar is created exclusively. FINAL embeds the strictly canonical terminal METADATA object and the original reservation identity, without a reciprocal digest cycle. Ordered removal is old source sidecar, source journal, then FINAL. Only the final successful directory sync and descriptor close allow a synchronous current-invocation token capture. Later audit or lease-release failures may carry that genuine token; a clean retry never reconstructs a historical receipt and instead requires a fresh destination read.

Every proof observes complete fresh names, all selected directory identities and every tracked artifact's exact bytes/identity/type/link count. Full foreign-child comparisons remain at transitions, actual hooks and critical publication/retirement/sync/audit/return checkpoints. Persisted namespace commitments include the complete original normalized child sequence; recovery reconstructs it only after exact own-artifact proof, restoring the original head, sidecar and registry descriptors for supported own deltas. Digests alone grant no authority. The original foreign baseline is never reset during a live operation. Unobserved transient interference is not an atomicity guarantee.

Before any RENAME artifact, every locator component must fit 255 UTF-8 bytes, reserved root destination names are refused, and freshly captured sidecar/registry ACTIVE records must exactly bind to the expected token. Physical identity checks across all captured source ancestors exclude the reserved ownership/fence and canonical archive-volume namespaces, including case-insensitive aliases; a genuinely distinct uppercase directory on a case-sensitive filesystem remains eligible. The archive-volume check adds two no-follow lstat observations, accepting only stable present directory identity or stable ENOENT; it adds no name scans. Legacy adoption can still produce a token for an archive payload and add a sidecar; RENAME refuses that token before moving payload bytes and does not claim that adoption left a canonical archive. All phase and FINAL maximum templates must fit 8,192 bytes using actual original metadata/path/device values and validated future widths. Name scans charge entry and EOF attempts, with an operation-specific projected weight P of at most 4,096 and an unchanged conservative total ceiling of 194P (794,624 attempts), retained across discovery and forward work. The audited reservation is retained discovery plus 130P + 29qH + 3qR; admitted head/ancestor and registry/ownership-parent roles are physically distinct, so qH + qR is at most P and the complete bound is at most 160P. Local Node 24 populated and crash tests do not establish hosted Node 20/22 qualification, a product owner-count limit or a latency SLA. The complete RENAME suite runs in a separate mandatory serial CI process with its existing case deadlines; ordinary, CREATE and archive cleanup groups remain independently required. No permissions, directory creation, lease takeover or automatic orphan handling are supplied by RENAME.
