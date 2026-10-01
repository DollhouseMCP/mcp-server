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
