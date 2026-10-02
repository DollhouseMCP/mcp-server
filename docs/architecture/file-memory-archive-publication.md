# Dormant file archive publication (#2902-A)

`FileMemoryVolumeStore` is an unwired local POSIX primitive. It does not activate
rollover, public archive browsing/listing, recovery, deletion, retention or database
parity. Those remain #2902-B/C, #2900, #2903 and the shared #2870/#2871 gates.

A caller supplies an exact owned head token. The store obtains fresh agreeing
ACTIVE head/sidecar/registry proof inside the same tracked operation, including
write-journal guards. RESERVED, stale, cross-user and forged operation scopes fail
closed. Input strings, dates and tokens are copied and validated before awaits.
YAML is limited to `MAX_YAML_SIZE` JavaScript UTF-16 code units; raw UTF-8 is limited
to three times that limit, preserving valid multibyte content. Lone surrogates,
invalid counts (outside 0..2147483647), unsafe numbers, invalid/reversed dates and
mismatched YAML entry counts are rejected before archive artifacts.

## Publication and evidence

The exclusively created layout is
`volumes/by-id/<owner UUID>/v<number>/g-<generation UUID>/{payload.yaml,metadata.json}`.
Private volume and generation directory dev/inode identities are captured
immediately after exclusive mkdir, before content bytes. Files are created with
exclusive/no-follow flags and mode 0600. Writer handles are fsynced and their full
identities captured; bounded reopened descriptors must match those original
writer identities, exact bytes, SHA, YAML, count and strict metadata. The captured canonical tenant root retains the existing root mode contract (0755
is accepted); archive namespace directories require private current-UID modes.
The complete publication proof checks ancestor identities and exact namespace
spelling plus aliases of the actual volume number before and after readback. It
runs after the final premarker barrier and after each postcommit callback; the
final complete proof is the last awaited operation before return. Symlinks,
hardlinks, aliases, extra children
and replacement fail closed. Directory iteration has explicit limits: 100000
namespace siblings, two slot/generation children, zero marker children.

The exact frozen receipt is prepared before publication. **Successful return from
non-recursive exclusive `mkdir(vN/COMMITTED, 0700)` is the sole commit event.**
Immediately after successful marker creation, the operation captures its private
directory identity before any callback; both postcommit proofs require that identity.
This is private postcommit evidence and does not change the precommit receipt.
Capture failure is already committed and retains the preverified receipt.
The marker is an empty directory; later verification does not establish a second
commit point. Receipt directory identities use dev/inode because the marker
changes volume timestamps. File identities include size/ctime/mtime from original
writer descriptors. Metadata cannot identify its own inode.

Up to 1000 collisions may advance the actual volume number, including the last
safe number. Only fully verified same-owner committed slots qualify. A partial,
unsafe, oversized namespace or unknown slot blocks; it is never skipped, removed
or reused. Premarker failures after reservation retain operationId and residualPath
as `EARCHIVEUNCOMMITTED`. Once marker invocation begins, a failure without successful
return is `EARCHIVECOMMITUNKNOWN`, without an assertion that commit did not happen.
No automatic rollback or cleanup occurs. Exact receipts alone never authorize
cleanup of potentially referenced archives.

## Outer transaction composition

Standalone `createExclusive` retains successful receipts outside the tenant
transaction so a fence-release failure cannot discard them. Marker-success is
recorded before postcommit hooks/readback; a failure there throws
`EARCHIVECOMMITTED` carrying the preverified exact receipt. Aggregate/cause traversal
preserves these outcomes and guards cyclic error graphs.

Caller-owned transactions must wrap their **outer** boundary and retain every
successful create. An inner operation cannot catch a later fence-release failure:

```ts
await retainCommittedFileArchives(retain => coordinator.withTenantTransaction(async lease => {
  const archive = await volumes.createExclusiveInTransaction(lease, expectedHead, input);
  retain(archive);
  await anotherAuditedStoreOperation(lease); // may fail or have an unknown outcome
}));
```

If publication itself throws a committed outcome, the outer wrapper discovers its
receipt even though `retain` was not reached. If a later operation fails, the error
retains earlier archive receipts and the original later cause/residual. It asserts
only those archive commit events, never that the entire transaction committed or
rolled back. `createExclusiveAtScope` supports audited composition already inside
`perform`; it does not acquire a nested operation or fence.

## Supported model and qualification

This is cooperating-process, local POSIX process-interruption safety. Node path
APIs do not promise protection against hostile same-UID replacement. Identity
checks detect out-of-band changes and fail closed. No Windows, network filesystem,
multihost or power-loss durability is claimed. Real SIGKILL tests stop before
generation creation, after it, during payload/metadata bytes, before marker and
after successful marker. Premarker objects remain partial; committed objects retain
exact evidence. Read-only observation does not steal an orphan tenant lease;
operator-controlled recovery remains #2900. No public archive scanner is supplied
by the publication slice.

## Dormant verified observation (#2902-B1)

### Internal inspection-budget prerequisite (#2902-B2b-1)

`FileMemoryDirectoryScanBudget` is a caller-owned, optional resource bound for
the existing owned-head proof. Its immutable limit is validated before awaits
(1–1,000). Initial and final head-directory scans, owner-registry artifact scans
and stability retries spend the same monotonic budget. It adds no list API,
runtime wiring, fence acquisition, filesystem mutation or ownership authority.
Omitted-budget callers retain their existing 100,000-entry per-scan path and checks.

One unit is reserved synchronously **before each `Dir.read()` attempt**, including
an entry, EOF or a read error; reservations are never refunded. Concurrent readers
share those reservations. After exhaustion no additional read is issued, even to
probe EOF. Consequently N names require N+1 units to establish a finished scan.
These are conservative read-attempt units, distinct from observed archive entries
or a future list's returned count. Exhaustion is `EHEADRESOURCE`, never absence or
successful owner proof. Directories close on failure; if close also fails, an
aggregate retains both causes and the primary typed error code.

Metadata listing remains a separate slice. Its future ancestor/archive reproofs
must use this same budget, without hidden 100,000-entry scans or free EOF probes.

`read(expectedOwnedHead, volume)` captures tenant root and user once, acquires no
fence and writes nothing. `readAtScope` instead consumes the current tracked
operation capability without nesting `perform` or acquiring another fence.
`readInTransaction` queues a tracked read in an existing caller-owned transaction
and drains accepted work even when its outer callback omits await. All forms
require an exact clean ACTIVE owner/head/sidecar/registry proof before and
after observation. RESERVED, DELETING/unsupported lifecycle state, pending write
artifacts and changed owner/head evidence fail closed.

The result is explicitly `found | absent`. Stable absence of the exact namespace
or volume is proved with bounded before/after namespace evidence. A partial,
corrupt, oversized, aliased or changing object is a typed failure, never an absent
archive. Found content uses bounded no-follow/nonblocking descriptors, raw-byte
bounds before allocation, exact UTF-8, YAML/code-unit/hash/count/metadata checks,
and repeated ancestor, generation, marker and file identity proofs. The marker
identity is captured before reading content; same-byte file replacements and empty
marker ABA replacements are rejected. Final proof follows the last fault barrier.
The cooperating local POSIX model remains an observational bound, not a
transactional multi-file snapshot against arbitrary out-of-band mutation.

These are immutable **storage observations**, not creation receipts, cleanup
permissions or public archive-history results. Committed but unindexed bytes may
be observed for diagnostics; future public access still requires fresh visibility,
current reference, expiry and tombstone policy. There is no cache or automatic
adoption of archive content. Metadata listing and bounded database read/list parity
remain B2; exact protected cleanup remains C. Runtime DI, rollover, browsing,
erasure, retention and production activation remain unwired and gated.

### Dormant bounded file metadata observations

`FileMemoryVolumeStore.list`, `listInTransaction` and `listAtScope` observe
metadata declarations only. A standalone call captures one tenant/user scope,
acquires no fence and writes nothing; tracked composition uses one existing
ACTIVE operation. The exact owned-head and pending-artifact proof remains
required, including its bounded active-head reads.

Listing separates portfolio proof work from archive inspection. The private
proof counter charges the first owner/ancestor/by-id scan, with at most 4096
attempts per census and 8192 aggregate distinct physical-slot weights. Existing
complete initial scans establish evidence without extra admission directory
reads; discovery is bounded at 81920 attempts. One reservation retains consumed
work and adds the exact remaining schedule: two owner observations (each up to
three stability attempts), four namespace reproofs and the missing-parent scans.
The conservative proof ceiling is 327680 attempts. Full captured directory
identity/child-set drift refuses immediately; it cannot grant a new baseline or
quota. The scanner adds two named lstat checks per successful census; these are
separate from directory-read units and bounded by the finite proof schedule.

A separate unchanged 1000-attempt archive budget includes the initial plus four
final owner-volume-root censuses, candidate validation and returned declaration
reproofs. Both counters reserve before each EOF/error/read and never reset or
refund. Ordinary omitted-budget owner scanners retain their existing semantics. The owner-slot child set is enumerated
completely and compared again; unchanged directory inode alone is insufficient.
Global authority/alias proof exhaustion refuses the observation rather than
trusting first-N names. No public lower-budget option exists.

At most 128 declarations are returned in numeric order. Partial, malformed,
unsafe or aliased candidates remain untouched and make the report incomplete.
Returned declarations have their directory/marker/metadata identities and exact
metadata bytes re-proved after the final observation hook; no later user callback
runs. This is a bounded observation, not a transactional filesystem snapshot.
`totalCount` is null whenever incomplete, including entry-limit truncation.
`observedCount` counts candidate slots, `acceptedCount` initially qualified
metadata declarations and `returnedCount` returned declarations. `scannedCount`
reports backend inspection work: the exact sum of file proof and archive
directory-read attempts including EOF,
errors and reproof versus database candidate rows. These units are neither
comparable archive counts nor bytes. The 128 return cap does not promise that
128 declarations fit the conservative proof budget.

Only bounded private metadata descriptors are read. Archived `payload.yaml` is
never opened or read by listing; metadata digest/count/length/date values are
unverified payload declarations. They are not publication receipts, public
history/access/expiry/reference decisions, or cleanup/erasure authority. Existing
verified reads and publication retain their full payload proof. No runtime DI,
rollover activation, cleanup protocol or deployment is introduced.

## Dormant database exact unreferenced cleanup

`DatabaseMemoryVolumeStore.removeUnreferenced(expectedHead, receipt)` captures the
current database head token and exact row/user/owner/number/digest receipt. One
READ COMMITTED tenant transaction locks the current clean parent before freshly
qualifying raw/indexed reference declarations. Any declaration of the target
number blocks deletion, even with a different digest. Logical seven-field index
paths remain `volumes/<owner>/vNNNN.yaml`; they are declarations, not physical file
unlink paths. Malformed, mixed, incomplete or disagreeing references refuse.

The bounded owner metadata inventory is a snapshot admission observation, not a
held-stable inventory. No archive locking SELECT, global lock, UPDATE grant or
policy is required. Atomic exact-predicate DELETE protects the target row; zero
rows triggers a fresh number-slot observation to distinguish replacement from
current absence. Parent locking excludes cooperating head/index publication and
FK insertion; arbitrary future privileged writes and later observations are not
promised absent. Legacy writers remain subject to the all-writer activation gate.

Limits are 8 MiB raw UTF-8 plus the existing legacy YAML code-unit bound, 2 MiB
indexed metadata, 10,000 archive metadata rows and 16 MiB encoded projection.
SQL timestamp precision flags prevent submillisecond truncation from qualifying
references. No archive payload is materialized by this cleanup proof.

`removed` is returned only after acknowledged transaction commit; `absent` means
current observed absence, not historical removal. Refusal and unknown outcomes
never claim rollback from an arbitrary error marker. Exact failure causes are
non-enumerable, outside routine sanitized status/reason diagnostics. Unknown
commit requires fresh reconciliation; no automatic retry. Existing boolean
`removeCreated` is not this protected cleanup authority.

This database slice does not complete file parity, owner erasure or retention.
File cleanup still needs fresh same-operation head/reference evidence, pending
publication exclusion and exact durable multi-unlink recovery. Runtime wiring,
maintenance execution and activation remain separate gates.

The 1-second lock timeout and 5-second statement timeout apply to individual SQL
statements, not the complete transaction. Test-only interleaving barriers are
not production deadlines. No total transaction deadline guarantee is claimed.

## Dormant file exact unreferenced cleanup

`FileMemoryVolumeStore.removeUnreferenced(expectedOwnedToken, durableTargetEvidence)` and
its in-transaction form use one tracked operation and lease. A narrow
`FileMemoryOwnerSnapshots.snapshotOwnedAtScope` seam returns raw content and its
owned token from the same read, compares the fresh expected token and rechecks
ACTIVE. The raw head is file reference authority; it has no separate database
projection. All seven logical fields are validated, and any declaration of the
target number blocks removal even if its digest differs. Logical paths never
become unlink paths. The selected archive object cannot also be that head.

`FileMemoryArchiveCleanupEvidence` contains every durable publication target
field except publication `operationId`. That ID is runtime correlation: schema-1
publication metadata does not store it and COMMITTED is an empty directory.
Cleanup normalizes input, intent authority and removed-result evidence without
reading or retaining that unverified field. Publication receipts remain unchanged.
The cleanup intent has its own independently generated operation ID. The earlier
“exact receipt” wording could not truthfully authenticate all publication fields.

Cleanup binds this exact durable target, payload/metadata bytes and full file
identities, full empty marker identity, relevant private directory lineage and
complete fresh canonical names. Namespace commitments cover unchanged names
and counts, with exact selected basenames enforced separately for each residual
prefix. They do not promise unrelated-child metadata stability. Directory stable
identity survives retry; full live directory metadata is bound within each
invocation and changes only through verified own transitions.

The exclusive, immutable `vN.cleanup.json` sits outside `vN`. It is written through
its own descriptor, synced and closed, then its parent is qualified, synced and
closed. It is never overwritten or advanced with mutable phases. Recovery admits
only the ordered absence prefixes: marker, payload, metadata, generation, slot.
Every remaining object still binds original evidence. Partial, malformed,
contradictory, foreign or ambiguous residues remain preserved for manual handling.
Each retry uses a fresh current head token; persisted head evidence is provenance,
not authority. Newly referenced volumes block a retry.

`removed` means this invocation performed the final slot rmdir and completed the
qualified owner-directory sync and close. Its genuine durable target evidence is captured before
later hooks, audit or lease release; later failures retain it and exact
non-enumerable causes. Physical removal with failed final sync/close is unknown.
Fresh observation of an already absent slot returns `absent`, never historical
removal. Attributable immutable intent retirement is also synced/closed; a late
failure retains known removal where this invocation reached its boundary.

Target archive read, allocation/publication and metadata listing refuse or
diagnose pending/unknown target-derived cleanup residue. Listing remains honestly
incomplete. Ordinary head snapshots, adoption, conditional UPDATE and owned
CREATE gain no global cleanup guard; cleanup must still read current head authority
while its valid intent exists. This is local cooperating-process crash safety,
not hostile-filesystem or power-loss atomicity.

The complete immutable record is bounded to 8 KiB, with supported numeric fields
at most 40 characters. One operation-private counter retains bounded discovery,
reserves once and charges entries, EOF and failures without reset/refund. Physical
families are deduplicated for a 4,096-entry projected envelope, discovery is
bounded by 8,192 attempts, and the reviewed 17-proof maximum derives a hard
2,109,440-attempt ceiling. These are resource support bounds, not latency promises.
Actual work includes fresh head reads, byte hashes and stats; populated capacity
and real crash/interleaving qualification are required before activation.

This executor remains unwired. Protected cleanup parity does not complete
retention, owner erasure, reconciliation, every-writer integration or activation.
