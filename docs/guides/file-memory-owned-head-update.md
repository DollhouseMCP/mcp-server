# Dormant file memory head update protocol

The `FileMemoryOwnerSnapshots.updateOwnedHead` path conditionally replaces one **existing owned** head at its current locator. It is not wired into production memory saves. Activation depends on the all-writer gate in [#2870](https://github.com/DollhouseMCP/mcp-server/issues/2870): every cooperating scanner and writer must honor owner sidecars, the tenant fence, and write journals. An older writer that ignores these records is unsafe after adoption.

The update validates the prior owner token under one tenant transaction, writes a private replacement temp, publishes a fixed `.<head-hash>.memory-write.json` journal, then atomically renames the temp over the head. It verifies the **post-rename** file identity before publishing the new owner registry and sidecar. The journal is removed only after the head and both ACTIVE records agree; its removal is the commit point. A save of identical content still advances the revision.

The three UPDATE metadata replacements stage at operation-bound names: `.<head-hash>.memory-write.json.update-<operationId>.tmp` for the PUBLISHED journal, `<ownerUUID>.json.update-<operationId>.tmp` for the ACTIVE registry, and `.<head-hash>.memory-owner.json.update-<operationId>.tmp` for the ACTIVE sidecar. Each is created exclusively as a private file, synced, and checked against exact bytes and the writer's file identity before rename. Adoption keeps its existing separate replacement format. A partial or preexisting stage blocks ordinary reads and writes; its deterministic name supports later inspection, **not** automatic resumption or deletion. The fixed journal's exact unlink remains the UPDATE commit point.

Standalone reads and writes refuse a present journal or matching orphan temp, including malformed or partially written records. They do not repair or delete anything. Failures after a head rename and before journal removal report `EHEADCOMMITUNKNOWN`; a failure after journal removal, including tenant-fence release failure, reports `committed: true` with the new token. A stale prior token reports `EHEADCONFLICT`; revision exhaustion requires recovery instead of a stale-token retry. A lost successful response can be resolved by taking a new snapshot, then using its token for any later write. An enclosing multi-operation transaction serializes work but does not roll back an already committed head update if a later operation fails.

If recovery artifacts appear, **stop all writers** before inspecting them. A valid prepared journal plus unchanged old head is different from a published new head, but the first implementation does not automatically choose abort or completion. Preserve the journal, head, owner records, and all matching temps for read-only classification. Do not remove a lock by age or PID, or delete an unfamiliar temp. Repair, create/rename/delete, archives, and production wiring are separate work.

This protocol covers cooperating processes on a local POSIX filesystem and process interruption. It does not claim power-loss durability, cross-filesystem rename, noncooperating writers, or an automatic repair path.

## Read-only interruption diagnostics

`FileMemoryOwnerSnapshots.inspectInterruptedOwnedHead(locator)` is a dormant diagnostic API. It reuses the existing confined path and same-descriptor head, owner-record, and journal readers; it neither acquires a tenant fence nor creates a lock directory. It returns a phase description, never a snapshot token, lease, cleanup receipt, raw YAML, or permission to repair. Ordinary reads and writes continue to fail closed on matching artifacts. A diagnostic does not sanitize or rewrite a legacy head; stricter evidence checks may return unknown for metadata an older read path can parse.

The finite outcomes are `clean-consistent`, `pre-journal-orphan-candidate`, `prepared-not-published`, `renamed-before-published-journal`, `published-before-registry`, `registry-advanced`, `metadata-advanced-before-unlink`, `blocked-by-fence`, `unstable-or-unknown`, and `unknown-manual-review`. Only exact, stable head/sidecar/registry/journal evidence gets a named phase. `clean-consistent` means a fresh normal read *may* obtain a token; it does not attribute an earlier lost response. An unexpected or partial artifact, missing head, unsafe path, differing identity, invalid metadata, or changing observation remains unknown. The response exposes at most 32 names of bound, expected artifacts. Unexpected names are withheld with `artifactNamesRedacted=true` while their complete count remains available; unbound owner evidence returns no identifiers and `artifactCount=null`. `artifactNamesTruncated` marks a bounded list, while `evidenceComplete=false` means a trusted collection did not complete, not that no artifacts exist.

An existing tenant lease, even without a valid owner file, returns `blocked-by-fence`; a changing lease returns `unstable-or-unknown`. The API never clears a lock or infers a dead owner from its age or PID. After a crash, an operator must stop all writers and follow the separately reviewed manual lease procedure before interpreting underlying evidence. Two matching read-only passes are not an atomic transaction against running writers. Verified repair is tracked separately under [#2900](https://github.com/DollhouseMCP/mcp-server/issues/2900); there is no runtime wiring or repair authorization here.

## Dormant finalization of a fully published update

The first #2900 repair slice accepts only an exact `PUBLISHED_WRITE` journal whose new head and both ACTIVE owner records already agree (`metadata-advanced-before-unlink`). An operator must first stop all cooperating writers and separately handle an orphan tenant lease; the earlier diagnostic is only a hint. `finalizePublishedOwnedUpdate` obtains a **fresh** tenant transaction, re-reads and validates the canonical path, complete journal/head/records/artifacts and normal-save YAML/control/gatekeeper rules under one tracked operation, then rechecks exact bytes and descriptor identities before unlinking only that fixed journal. It never rewrites the head or owner metadata, clears another temp, adopts, or attempts an earlier-phase forward/abort repair.

Successful journal unlink is the repair commit point. The new token is captured before unlink; later verification, hook or fence-release failures retain it in a committed outcome. A failed unlink reports commit-unknown rather than asserting rollback. If a later call sees a clean owner triple with no journal, it reports `already-clean-no-attribution`: it cannot prove that the supplied operation committed. Other phases and any mismatched, partial or unsafe evidence remain fail-closed for manual review. This internal API is not wired to production calls and does not itself authorize live data repair or all-writer activation.

## Dormant forward completion from a fixed PUBLISHED journal

`forwardPublishedOwnedUpdate` extends maintenance recovery to the ordered states
`old registry / old sidecar` and `new registry / old sidecar`. Under one fresh
lease and one tracked operation, it verifies the exact bound PUBLISHED journal,
published head, ACTIVE records, and complete matching artifact namespace. It
validates the existing YAML with normal-save structure, control-field and
gatekeeper rules before changing metadata; it preserves the source bytes.

The executor advances only the registry, then the sidecar, through exclusive
private `update-<operationId>.tmp` staging. It may reuse exactly one complete
stage for the next ordered record after fresh bounded no-follow descriptor reads
prove exact serialized bytes and stable full identity. Before each rename it
rechecks the whole evidence; after rename it rereads the ordered state. Partial,
malformed, duplicate, aliased, legacy random, foreign, wrong-order, or changing
stages remain preserved for manual review. Ordinary reads and diagnostics still
block every stage; a diagnostic label grants no repair authority.

After both records agree, the same tracked operation invokes the private
finalizer. Exact fixed-journal unlink remains the only commit point; committed
tokens survive later read, hook and fence-release errors, while clean retries
have no historical attribution. PREPARED journals (including staged PUBLISHED
replacements), abort, adoption, create, rename, delete and archive work remain
outside this slice. All writers must be stopped and any orphan lease separately
handled before fresh acquisition. This dormant API performs no lock stealing
and does not authorize production maintenance or ordinary writer activation.

## Dormant recovery of an already-renamed PREPARED head

`forwardPreparedRenamedOwnedUpdate` accepts the fixed PREPARED journal only
when the new head retains the prepared temp's exact device/inode/size/mtime
and digest (rename ctime may differ), that head temp is absent, and both ACTIVE
owner records still exactly describe the old head. It does not publish a head
from an old-head/temp state or choose an abort.

Under one fresh lease and one tracked operation, it validates source YAML and
complete bound evidence, then exclusively stages the exact PUBLISHED journal
using the existing operation-bound name. Exactly one complete matching journal
stage may be reused after fresh descriptor and namespace proof. Partial,
malformed, aliased, foreign or changing evidence is preserved for manual review;
ordinary reads and diagnostics continue to block every stage. After rename,
the fixed journal must retain the staged bytes and file identity, allowing only
rename ctime, while head and old metadata remain unchanged.

Fresh PUBLISHED evidence then enters the existing private forward completion
and finalizer in the same operation. Only successful exact journal unlink
commits; later faults retain the committed token, and clean retries have no
historical attribution. All writers must be stopped and orphan leases handled
separately. The API is dormant and grants no production maintenance or runtime
activation authority; abort, adoption and other lifecycle transitions remain
separate work. Original old-head forward publication is described below.

## Dormant recovery of an original old-head PREPARED update

`forwardPreparedOwnedUpdate` additionally accepts a fixed PREPARED journal
whose old head and both ACTIVE owner records retain their original bound
identities, while its complete prepared head temp retains the original
journal-bound descriptor identity and exact source bytes. A matching digest
alone cannot authorize publication. Metadata stages, duplicate or foreign
artifacts, aliases and changing evidence remain manual-review states.

The method validates YAML, control characters and gatekeeper policy before
mutation. Under one fresh lease and tracked operation, it rechecks the complete
evidence immediately before renaming that exact temp to the head. Fresh proof
must bind the renamed head to the temp's bytes and device/inode/size/mtime
(only rename ctime may differ), prove the temp absent, and preserve the fixed
journal and old owner records. The already-renamed PREPARED transition and
PUBLISHED completion then run in that same operation. Successful exact final
journal unlink remains the sole commit; earlier runtime failures preserve
pending evidence, and later failures retain the committed token.

This extends forward completion only. It chooses no abort, steals no lease,
adds no ownership protocol, and enables no runtime maintenance or activation.
All writers must be quiescent and orphan handling must occur separately. Clean
and already-published retries use the existing completion rules and carry no
historical attribution after an already-clean observation.

## Dormant abort-intent codec

`FileMemoryAbortIntentCodec` defines strict schema-2 `ABORTING_WRITE` values.
It retains the original PREPARED operation, old/new revisions and hashes, exact
old-head and prepared-temp identities, and hashes plus identities of the
original PREPARED journal and both old ACTIVE records. Owner and operation UUID
spelling, Unicode/case-sensitive actual locators, and decimal descriptor fields
are preserved. Parse and serialization enforce exact UTF-8, exact field sets,
the operation-bound temp name, and an 8192-byte ceiling.

This pure codec performs no filesystem I/O and grants no deletion, ownership,
cleanup or recovery authority. Existing schema-1 readers and forward APIs remain
unchanged and reject the new variant. No abort executor or runtime wiring is
implemented. The separately reviewed executor must publish and freshly prove
durable intent before removing the exact original temp; only successful exact
intent-journal unlink may establish a known-aborted result. Clean retries carry
no historical attribution. Old head and owner records, archive generations and
references remain unchanged. All existing activation and operator gates remain.

## Dormant explicit pre-publication abort

`abortPreparedOwnedUpdate` accepts only an explicit request bound to an exact
original old-head PREPARED update, or its exact schema-2 `ABORTING_WRITE` retry.
It uses a fresh tenant lease and one tracked operation; the InTransaction form
requires the caller's fresh lease and retention of its result across outer
failure. All writers must be quiescent, and any orphan lease handled separately.
No automatic orphan removal or production maintenance is enabled.

Before deleting anything, the executor exclusively stages the exact intent at
`<fixed-journal>.abort-<operationId>.tmp`, syncs/closes it, and freshly proves its
bounded private no-follow/nonblocking one-link descriptor and full namespace.
One complete exact next stage may be reused; partial, malformed, foreign,
duplicate, aliased or changing artifacts remain preserved. It rechecks the
whole original evidence before renaming the stage over the fixed journal and
binds the resulting intent bytes and inode to that stage (rename ctime only).
Successful rename with failed readback still means pending/unknown, not aborted.

Exact persisted old-head/ACTIVE-record bindings must remain unchanged. Under
that verified intent, it unlinks only the original descriptor-bound head temp,
then freshly proves its complete absence. Missing-temp PREPARED does not grant
this authority. An extra intent stage after fixed-intent publication remains
unknown evidence; it is never removed opportunistically.

Successful exact final intent-journal unlink is the sole known-aborted commit.
Its frozen receipt binds the operation to the unchanged old owned token and is
captured before optional hooks, observation or audit. Later failures retain it
as `EHEADABORTED`; an uncertain final unlink yields `EABORTCOMMITUNKNOWN`.
Earlier runtime failures preserve pending evidence and the original cause.
Clean retries return `already-clean-no-attribution`, without historical proof.

The abort publishes no head, increments no revision, and deletes no owner
record, archive generation or reference. It grants no archive cleanup authority.
Renamed PREPARED and PUBLISHED states require existing forward recovery instead.
Ordinary readers/diagnostics and schema-1 forward parsing remain unchanged and
block intent evidence. Audit records contain bounded outcomes, not tokens/YAML.
An independent audit-only invocation UUID distinguishes same-window attempts;
this bounded telemetry is not durable audit storage. The known-aborted event is
attempted immediately after receipt capture, before callbacks and final proofs.
Guarantees cover the current cooperating-process POSIX interruption model,
without claiming hostile-writer atomicity, multihost safety or power-loss recovery.

### Ordinary adoption publication outcomes

`adoptUnowned` retains its existing publication sequence in both legacy-fence
and coordinator calling modes. Immediately after the final ACTIVE-sidecar
replacement succeeds, it captures a frozen revision-1 owned token, including
the nested file identity, before the publication callback. This captures the
existing publication outcome; it does not establish later usability or add a
new filesystem revalidation proof.

A later callback, tracked-operation finalization or lease-release failure is
`EHEADADOPTED` with that genuine invocation's token and original direct cause.
Only internal synchronous capture authorizes this wrapping; thrown marker
properties never create a receipt. Before capture, adopted-looking thrown
values become `EADOPTIONPENDING` with their original direct cause and no outward
token/adopted flag; ordinary precommit failures retain their existing behavior.
Throwing marker accessors cannot replace the original cause.
Token-bound private error identity avoids
wrapping the same classified failure multiple times through coordinator error
collection. `adoptUnownedInTransaction` uses the caller's existing lease; callers
must retain a successful returned receipt across their own later outer failures.
The final-sidecar phase itself repairs no earlier RESERVED state. The preparation
phases below handle their exact supported states; no head or archive is rewritten.

### Dormant RESERVED adoption recovery

The existing recovery APIs also accept an exact matching RESERVED sidecar and
already-existing RESERVED registry, revision 1, under unchanged head evidence.
They first exclusively stage the exact ACTIVE registry at
`<registry>.adopt-<ownerId>.tmp`; only a freshly proved complete next stage may
be reused. Partial, random, aliased, duplicate or wrong-order stages are preserved.
The pair-publication phase itself requires existing private ancestors and creates
no directories. Exact missing-ancestor preparation is described below.

Registry staging/rename changes the owners directory's size/mtime/ctime. The
transition retains its device/inode and freshly checked private ownership/type,
the parent directory's complete identity, exact head/sidecar bindings and complete
relevant namespaces. Published registry raw bytes and stage inode/size/mtime
are freshly proved (rename ctime only), then fresh full directory/ACTIVE-registry
evidence is carried into the unchanged strict final-sidecar executor. No baseline
is silently recaptured. Both phases share one operation, lease and scan budget.

Registry publication alone is not adoption commit. An attempted registry rename
without successful return is `EADOPTIONPENDING` with fixed
`phase: 'registry-publication-unknown'`; successful registry progress followed by
failure uses `phase: 'registry-published'`. Both retain the original direct cause
without adopted flag/token, and never claim the original registry is unchanged.
Phase comes only from actual invocation-local progress, not thrown markers.
Final-sidecar rename retains the existing commit-unknown/known-adopted boundary.

`recoverReservedAdoption({ locator, ownerId })` explicitly completes an unchanged
revision-1 head with matching RESERVED records, or an agreeing ACTIVE registry
and RESERVED sidecar.
It captures validated primitive request values before any await, retains exact
actual locator spelling, and uses one fresh tenant lease and tracked operation.
All writers must be quiescent; operator handling of orphan leases is separate.
An absent registry is also supported only when the exact revision-one RESERVED
sidecar, unchanged head and both private owner ancestors already exist. A fresh
complete absence/alias census and original evidence proof precede direct exclusive
no-follow registry creation. Complete writes are checked, authority is rechecked
after awaits before every subsequent mutation, and bounded readback must match
both exact RESERVED bytes and the created descriptor identity. Expected owners
directory metadata changes retain its inode/private checks and the parent's full
identity; exact original evidence is carried into the RESERVED-pair executor.
No head bytes, missing directories or archives are changed.

An actual creation attempt followed by open/write/sync/close failure is pending
with `phase: 'registry-creation-unknown'`. Successful complete creation followed
by later failure uses `phase: 'registry-created'`, until actual registry activation
advances the existing phase. Both retain the original direct cause without an
adopted flag/token. A secondary close failure is separately exposed as `closeCause`
only when a primary failure already occurred. A close-only failure remains the
direct cause. Phases come from this invocation, never thrown properties.
Partial final registry files are preserved for manual handling; complete exact
RESERVED records resume through ordinary pair recovery without attributing the
previous invocation. Final sidecar publication remains the sole adoption commit.

Directory preparation for exact missing-ancestor states is described below.
Ordinary adoption's publication behavior remains separate. No runtime caller or
automatic repair is enabled.

Recovery uses one private resource budget with a read-only discovery pass before
any repair mutation. Distinct physical directory slots project the complete
observed names plus only this request's possible parent, child, registry and
stage names. Each census and aggregate projected peak P are bounded at 4096,
including EOF. T/O/R must be distinct physical slots; the head parent H may be T
or separate, but cannot alias O/R. Missing slots supply counts, never authority.
Discovery D is retained. Every invocation reserves the source-derived maximum
supported-path suffix `51T + 47O + 40H + 69R`, conservatively covering state or
directory disappearance before the original first proof. D is at most P and
the suffix at most 91P, so the hard total ceiling is 376832. There is no refund,
reset, quota enlargement, cached authority or removed proof. Frozen slot weights
reject growth at its first observed census; entries, EOF and failed reads all
consume the same monotonic counter. Local 100/250/1000 root/nested qualification
does not establish a hosted concurrency or performance ceiling.

Private owner ancestors and complete relevant
head/registry namespaces must agree. Exhaustion never proves absence. The exact
next ACTIVE sidecar is exclusively staged and synced at
`<sidecar>.adopt-<ownerId>.tmp`. A complete matching stage can be freshly verified
and reused through a bounded private no-follow/nonblocking one-link descriptor
plus named identity proof. Partial, random, duplicate, aliased or changing stages
remain preserved for manual review.

Successful final stage-to-sidecar rename is the sole known-adoption commit. A
frozen original-head owned token is captured synchronously before audit, hooks
or readback. Publication must retain exact stage bytes and descriptor identity
(rename ctime excepted); subsequent proofs retain the fresh full identity and
unchanged head/registry bytes and identities. ACTIVE authority is checked after
each final await. Later read, hook, audit, budget or fence-release failures retain
the genuine captured token as `EHEADADOPTED`. Thrown objects cannot manufacture
that attribution. A failed attempted rename yields `EADOPTIONCOMMITUNKNOWN`;
other refusals yield `EADOPTIONPENDING` with cause and preserved residual evidence.
Clean retries return `already-clean-no-attribution` without a completion token.

Audit outcomes use an independent telemetry-only invocation UUID; they contain
no owner/user identifiers, locator, token or YAML. Known-adopted audit precedes
all postcommit proofs, and clean-retry audit is also followed by fresh proof.
Telemetry is bounded rather than durable history. Recovery rewrites no head,
increments no revision, and touches no archive, reference or unbound artifact.
Ordinary reads and diagnostics retain their existing behavior.

Recovery also supports a missing `owners` child beneath an existing canonical,
private `.memory-owners` parent when the original revision-1 RESERVED sidecar
and head remain exact. Creation uses
exclusive, nonrecursive `mkdir(0700)`; no existing directory permissions change.
Complete stable tenant and parent sibling sets reject canonical case aliases
and `owners.*` residue. All observation and later recovery phases share one
invocation-owned scan budget.

`owners-directory-creation-unknown` begins immediately before mkdir. A readonly,
no-follow, nonblocking descriptor must prove the new private directory agrees
with its named identity, and close successfully, before the local phase becomes
`owners-directory-created`. Capture/open/close errors preserve the direct cause;
a secondary close failure is exposed separately as `closeCause`. Neither phase
attributes adoption. The empty child, original head/sidecar, full tenant identity
and complete tenant/parent sets remain bound through exclusive registry creation,
pair recovery and final publication. Only the parent metadata caused by this mkdir
and child metadata caused by subsequent registry writes may advance; private
ancestry and directory inode bindings remain strict. Final ACTIVE-sidecar rename
remains the sole adoption commit, with existing known-adopted outcome retention.
For a head directly in the tenant root, only the exact descriptor-proved sidecar
stage addition and final rename may advance root metadata. Each own transition
captures fresh full root identity before hooks or audit listeners; subsequent
proofs enforce that identity until the next own transition. Committed audit is
attempted even if immediate postrename topology proof fails, preserving the
original direct cause if the audit listener also fails.
The created child's complete census remains bound too: initially empty, then
only the exact registry and its descriptor-proved current stage. Registry
creation/stage/rename refresh child full identity immediately before hooks;
sidecar transitions cannot relax it. Registry transitions cannot relax root
identity. Foreign child files and same-names metadata ABA remain preserved and
refused, including partial hooks before any subsequent write or sync.

This descriptor capture follows mkdir under the cooperating, quiescent local
POSIX process-crash model. It does not claim an atomically returned mkdir inode,
hostile filesystem atomicity or power-loss durability. Unknown directories and
partial records remain preserved; no cleanup, lease takeover or runtime wiring
is introduced.

Recovery also supports both ownership ancestors missing after ordinary adoption
has published its exact revision-1 RESERVED sidecar. It first exclusively creates
the canonical `.memory-owners` parent, using the same mandatory private descriptor,
named-identity and successful-close capture. Local
`ownership-parent-creation-unknown` begins before mkdir;
`ownership-parent-created` begins immediately after capture and close, before
fallible root-transition observation. Primary and secondary close causes retain
the existing direct-cause contract. Neither phase attributes adoption.

Only this own parent mkdir may advance tenant-root metadata at this point;
device/inode/type/mode/UID and the complete original sibling set plus the exact
canonical parent remain bound. The new parent must be empty and match its captured
identity. Fresh full root identity is captured before the post-parent hook, then
reproved afterward. Original head/sidecar and that captured context pass directly
into child recovery without a new evidence baseline or scan-budget reset.
Casefold-equal parent aliases reject; other root siblings, including
`.memory-owners.*`, remain unchanged and uninterpreted. Tenant-root privacy policy
is unchanged. Later child/registry progress may supersede the parent phase, but
only final ACTIVE-sidecar rename commits adoption. A crash leaving the exact
private empty parent resumes through child recovery with fresh authority and no
previous-invocation attribution. Existing partial records remain manual; no
recursive directory creation, normalization, cleanup or lease takeover is added.

## Dormant exclusive CREATE and forward recovery

`FileMemoryOwnerSnapshots.createOwned({ operationId, locator, content })` creates
a new owned revision-1 head. `createOwnedInTransaction(context, request)` uses
one existing tracked operation instead of acquiring a nested lease. The request
has exactly these three fields; its operation ID is a lowercase v4 UUID. Existing
content validation retains its UTF-16 code-unit limit and UTF-8 round-trip checks.
No production writer or dependency-injection path invokes these methods.

CREATE exclusively writes a private adjacent content stage, syncs and closes it,
and persists a bounded schema-3 intent in the existing per-head write-journal
namespace. Canonical publication uses POSIX `link(stage, head)` with no replacement
or rename fallback. A real EEXIST conflict preserves the foreign target and own
residue. Existing targets, even with identical bytes, never yield a reconstructed
creation receipt; obtain fresh owned evidence and use conditional UPDATE instead.

`PREPARED_CREATE` binds the exact stage identity and nlink=1 with an absent head.
`LINKED_CREATE` binds persisted post-link full identities at both names and
nlink=2. `PUBLISHED_CREATE` binds the actual post-unlink head identity and nlink=1,
with no stage. Exact tenant, owner, locator, operation and content bindings are
required on every forward retry. Owner metadata completes through exclusive
private writes; all file and containing-directory sync/close barriers are required.
Successful final qualified directory sync **and close** commits CREATE. The
current invocation captures its frozen token synchronously before later hooks,
audit or lease release can fail. Those later failures retain `EHEADCOMMITTED` and
that genuine receipt; forged or previous-invocation receipts cannot attribute a
new commit.

Ordinary reads retain their existing phase-specific refusals: PREPARED has no
head (ENOENT), LINKED's two-link head fails the existing identity guard
(EHEADCONFLICT), and the canonical-only pending phases refuse their journal
(EOWNERRECOVERY). No successful ordinary snapshot is exposed while CREATE is
pending; no uniform refusal code is promised across these states.

Before commitment, proved residual phases return `EOWNERRECOVERY` with the direct
original cause; unproved attempted publication/removal or final durability returns
`EHEADCOMMITUNKNOWN`. A primary null/undefined remains distinguishable from no
primary failure, and an actual secondary close failure is retained as `closeCause`.
No caller may interpret either refusal as permission to remove residue.

Recovery deliberately preserves partial/pre-intent content, partial intent,
exclusive intent-replacement stages, and crashes after link or stage unlink but
before the corresponding new identity is persisted. Those cases require separately
qualified manual handling. Intent unlink without proved final directory durability
does not produce a receipt, and a later clean retry conflicts with the existing head.

CREATE uses a private two-dimensional budget; the shared observation/listing
budget remains unchanged. Each census and aggregate projected peak full-proof
cardinality are capped at 4096 attempts including EOF. Initial discovery and a
recovery baseline proof share an 8192-attempt allowance. Every subsequent census
also has the 4096 cap, and all actual reads charge one retained monotonic operation
counter, including errors. Before CREATE mkdir or head staging, the exact
remaining phase schedule reserves its full allowance from captured distinct
slot cardinalities and fixed own-name additions. The full fresh protocol uses
59P + 15q(head-parent) + 2q(owners), plus ownership-directory preparation, where
P is the projected full-proof cost and q the primary/optional-ancestor census
cost. Recovery reserves only its remaining suffix and retains discovery/proof
consumption. The conservative operation ceiling is 454656 attempts (111 × 4096);
the actual reservation remains the smaller phase-derived allowance. No refund,
reset, cached census, truncated proof or first-N absence claim is allowed.

New CREATE records use schema5, with a domain-separated SHA-256 commitment and
child count for each complete canonical directory baseline. The encoding binds
locator/device/inode/mode/uid and every ordinal child tuple, preserving the
existing directory-child normalization and full file identity semantics. Recovery
first validates exact phase-owned artifacts, then reconstructs the baseline from
a fresh complete census by excluding only those validated artifact paths. It
checks the original count and commitment before accepting a live baseline. A
digest alone never supplies authority. The original full baseline remains bound throughout the invocation; scoped
observations never replace its child evidence. Strict schema3 records continue through schema3 phases; they
are not reinterpreted as compact records. Schema4 remains reserved for RENAME.

These CREATE-private limits do not change shared APIs: ordinary unbudgeted
owner scans allow 100000 entries per directory. Archive listing and RESERVED
adoption recovery now use their separate private proof envelopes; archive listing
retains its 1000-attempt archive-work counter, and other supplied shared observation
budgets retain their 1000-attempt cumulative bound. Successful CREATE capacity qualification does not
qualify those operations or establish complete lifecycle activation readiness.

All three complete phase envelopes must fit the unchanged 8 KiB intent cap
before CREATE mutations. Unknown future identity fields reserve the supported
32-character numeric width, including fresh-stage mtime/device and timestamp
signs; actual captured numeric evidence is checked against that width.
Placeholders grant no authority and are never persisted. Existing ownership
directories are recaptured against original discovery and their parents synced
and closed, so retry cannot omit durability of a prior interrupted mkdir.
Whole child sets, canonical spelling, descriptor identities, private modes and
live ACTIVE authority remain bound after awaited callbacks. The prior schema3
representation exceeded 8 KiB for a representative ten-owner fixture; that was
a fixture-specific serialized-evidence failure, not a product owner-count limit.
Schema5 removes portfolio cardinality from persisted record size while retaining
bounded fresh filesystem work. [#2974](https://github.com/DollhouseMCP/mcp-server/issues/2974)
still requires representative qualification and separately tracks shared listing
and recovery capacity before lifecycle activation.
The earlier always-full 1000-memory CREATE performed approximately 228000 fresh
directory read attempts and child observations locally. The checkpointed schedule
retains every fresh name census and its read accounting while reducing repeated
observations of unrelated child metadata; hosted qualification remains pending. Fresh child indexing removes
quadratic descriptor lookup, but it does not reduce any census or I/O barrier.
Within each full directory census, at most sixteen independent readonly child
lstat observations run concurrently. Names and returned descriptors retain
ordinal order; every launched batch settles before proceeding. The first
ordinal rejection is preserved exactly, and no next batch starts after failure.
A failed batch may perform up to fifteen additional readonly observations compared
with serial fail-fast behavior (twelve more than the previous four-observation
batch). Directory before/after checks, mutations, hooks and durability operations retain
their existing order. Full child observation remains inside the directory
before/after identity checks.
Local correctness under the existing test timeout is not a hosted throughput,
concurrency, latency or operation-memory qualification. The explicit practical
performance gate remains open in [#2974](https://github.com/DollhouseMCP/mcp-server/issues/2974#issuecomment-5940492445).

Unrelated non-directory children retain exact full metadata in the canonical
baseline. Admission, recovery and each own namespace transition compare complete
fresh child evidence. Ordinary internal proofs instead inspect complete fresh
names, full selected-directory identity and all tracked artifact bytes, identity
and link counts. They neither substitute old children for fresh observations nor
change the foreign baseline. Full comparisons run after actual callbacks, before
head publication, before intent removal, at all three final directory-sync proofs,
after audit listeners and immediately before successful return. Genuine receipt
capture still requires successful final sync and close.

This schedule changes when unrelated metadata-only drift is refused and which
residue may already exist when refusal occurs. Persistent drift is rejected at full checkpoints; successful return cannot bypass
them; a metadata-only change restored between those
observations is not claimed observed. All name/collision, target, own-artifact and
selected-directory proofs remain fresh at the existing internal barriers.
Capacity tests retain their full workloads, ten-second case bounds and safety
assertions. Expensive diagnostic snapshot serialization and RSS sampling run only
with `DOLLHOUSE_CREATE_RICH_METRICS=1`; census, child-observation and budget counts
remain enabled independently.
Directory children persist stable device/inode/type/mode/UID; size, timestamps and
nlink are freshly bound during each invocation and may advance only across exact
own child-set transitions. An isolated APFS observation confirmed directory nlink
can change when adding a regular file, so no OS-based nlink formula is assumed.
Cross-invocation same-inode directory timestamp/nlink-only drift is not proved
absent. This is the existing cooperating-local-filesystem observation model,
not protection against an arbitrary hostile filesystem or a power-loss guarantee.

## Dormant exact head DELETE and forward recovery

`FileMemoryOwnerSnapshots.deleteOwned({ operationId, expectedToken })` and
`deleteOwnedInTransaction(context, request)` delete an exactly owned file head
under the existing active tenant operation. They are not wired into runtime
writers. An active operation lease is distinct from the original owner metadata
being ACTIVE: recovery proves its own exact DELETING artifacts instead of relaxing
ordinary owned-head reads.

The exclusive canonical per-head journal records BASE, REGISTRY_DELETING,
PAIR_DELETING, HEAD_REMOVED and TERMINAL. Registry and adjacent metadata become
DELETING durably before unlinking the original head. The terminal registry is a
minimal HEAD_DELETED record containing tenant user, old owner UUID and deletion
operation UUID. Exact adjacent metadata and journal retirement require qualified
parent-directory sync and successful close. Only this invocation's actual head
unlink followed by that final boundary yields `head-deleted` evidence with its
proved locator. Recovery after head absence yields `already-head-deleted`
observation without locator, content hash or revision; it is not a reconstructed
historical deletion receipt.

A captured current outcome survives later audit or coordinator-release failure as
`EHEADDELETED` with the genuine result and exact direct cause. Uncaptured failures
cannot inherit prior or forged outcome markers. Partial journals, replacement
stages and mutation-before-next-complete-record gaps are preserved for manual
recovery; neither absence nor matching terminal JSON advances an incomplete
phase. A clean terminal retry requires both old head and sidecar absent, or a
fresh ordinary owned-head read proving a different memory owner UUID. It never
unlinks that replacement. Device/inode reuse alone does not contradict a genuinely
different owner: the shortcut refuses the exact full original head identity, then
requires the fresh ordinary owned/different-UUID proof for a replacement.

All old-owner archive states remain untouched, including committed, unindexed,
partial, temporary, malformed and pending-cleanup objects. DELETE performs no
archive census and claims only head deletion with erasure pending. The minimal
tombstone predates head-artifact retirement and cannot authorize owner erasure
following restart. [#2903's durable retirement-authority prerequisite](https://github.com/DollhouseMCP/mcp-server/issues/2903#issuecomment-5945940657)
requires separately proved retirement-complete authority before exhaustive erasure
and tombstone retirement; current observations are not that capability.

Request capture rejects platforms other than Linux and Darwin before acquiring a
tenant fence. With the actual canonical scope, admission bounds each absolute generated path plus NUL
to 4,096 or 1,024 UTF-8 bytes respectively before DELETE artifacts or source
mutation, bounds components to 255 bytes, and rejects canonical archive
ancestry or its captured physical aliases without archive enumeration. All five
complete journal envelopes must fit 8 KiB before the first artifact. The private
retained read budget reserves `D + 109P + 20qH + 6qR`, at most 130P under the admitted
physical-role disjointness, with P at most 4,096 and a 532,480-attempt ceiling.
Every EOF and failed read is charged; recovery retains its discovery charge and
cannot reset the quota. Fresh names, selected identities, full own artifacts and
full foreign-baseline checkpoints remain mandatory. Directory evidence has the
same cooperating-local-filesystem and cross-invocation limitations described
above. Process-interruption qualification does not prove power-loss durability.

All nine populated DELETE capacity scenarios separately bound serial
fixture construction and baseline capture to 10 seconds. Actual fresh deletion or
interruption/recovery and all preservation verification then share one 10-second
lifecycle bound. This explicitly
relaxes the previous 10-second whole-scenario test policy; it does not change the
operation's proofs, read budgets, workload or deadlines. Diagnostics retain total
elapsed time and report lifecycle elapsed time from the test boundary. The same
approved setup/lifecycle boundary applies to all six fresh and three interrupted
recovery scenarios; CI job timeout remains unchanged.

The same separately bounded 10-second setup and 10-second lifecycle policy also
applies to the one RESERVED-adoption recovery case with 4,096 unrelated files:
initial fixture, unchanged `Promise.all` noise-file creation and residual baseline
capture precede the recovery/refusal and all evidence verification. Its shared
invocation read cap and expected resource refusal remain unchanged. The nearby
post-publication exhaustion injection retains its existing test boundary.

The common POSIX fence acquisition path now also admits canonical `volumes`,
`.memory-fences` and tenant-root separation before any fence-parent mkdir attempt
and before each lease mkdir, including retries. Stable physical aliases among
these roles, or unsafe present canonical directories, refuse without a callback
or lease write. Missing `volumes` remains supported and admission never creates
it. This deliberately strengthens both generic per-locator and tenant fence
admission. For example, standalone archive publication against a symbolic
`volumes` namespace now refuses earlier with `EHEADCONFLICT`, before its callback
and lease attempts; archive-level checks inside an already legitimate transaction
still return `EARCHIVEUNSAFE`. The earlier error boundary is deliberate. The read-only sandwich binds existing device/inode, type, mode and UID;
it permits cooperating lease changes to directory times, size and link count,
and validates optional namespaces created by cooperating publishers while it
observes. Existing namespaces cannot disappear or be replaced.
The acquisition deadline is checked again after admission and never extended.
DELETE additionally compares canonical volume/fence identity in its fresh
confinement observation, including when invoked in an existing transaction.
These checks protect cooperating local POSIX operations and detect observed
namespace changes; pathname checks cannot atomically exclude hostile mount swaps
or arbitrary same-UID topology writers. They do not undo an earlier legitimate
lease acquisition if topology changes later. Release and manual orphan-lease
handling remain unchanged.

DELETE reuses the internal phase-independent owned-head evidence primitives for
canonical observation, descriptor reads/closes, full directory transitions and
exclusive writes. Its full foreign baseline, five-state protocol, reservation,
partial hooks and current-outcome branding remain executor-owned; it does not
adopt RENAME's operation-specific targeted transition semantics.

Prelease fence admission also observes the optional `.memory-owners` directory and, only after that ancestor is observed as an actual nonsymlink directory, its optional `owners` registry directory. A present unsafe managed owner/registry type or a physical identity alias between either directory and `.memory-fences` is refused with `EHEADCONFLICT` before parent or lease mkdir attempts. Missing owner ancestors are not traversed. These fixed readonly observations add no census, adoption or archive write authority; exact unrelated observation failures propagate. Stable existing identity/type/mode/UID checks and validated cooperating missing-to-present creation remain, without freezing mutable child metadata or extending acquisition deadlines. Each admission now awaits the root/volume/fence/owner observation batch and then conditionally the registry observation before returning; this adds a readonly observation boundary. With both owner directories present there are ten admission lstat calls per check (thirty admission calls across normal acquisition, ten per retry); with the owner ancestor absent there are eight (twenty-four admission calls across normal acquisition). Existing restricted-directory and lease-initialization stats remain additional calls. This initial cooperating POSIX separation check does not prove immunity to subsequent hostile topology changes.
