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

Every listing directory read attempt shares one fixed 1000-unit budget, including
EOF, errors and initial/final/retry proofs. The owner-slot child set is enumerated
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
reports backend inspection work: file directory-read attempts including EOF,
errors and reproof versus database candidate rows. These units are neither
comparable archive counts nor bytes. The 128 return cap does not promise that
128 declarations fit the conservative proof budget.

Only bounded private metadata descriptors are read. Archived `payload.yaml` is
never opened or read by listing; metadata digest/count/length/date values are
unverified payload declarations. They are not publication receipts, public
history/access/expiry/reference decisions, or cleanup/erasure authority. Existing
verified reads and publication retain their full payload proof. No runtime DI,
rollover activation, cleanup protocol or deployment is introduced.
