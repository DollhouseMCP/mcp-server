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
