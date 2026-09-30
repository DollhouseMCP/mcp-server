# Dormant bounded database archive observations

`DatabaseMemoryVolumeStore.list(owner, { entryLimit })` returns a shared
`MemoryVolumeObservation`, replacing the former unbounded array. The default
and hard maximum entry limit is 128; invalid limits fail before I/O. One
owner-scoped SQL statement observes the durable memory parent and up to
`entryLimit + 1` archive metadata rows, ordered by volume. Missing, foreign or
nonmemory owner authority throws `EVOLUMEOWNER`; an owned empty namespace is
an explicitly complete empty observation. Public parent visibility does not
confer archive ownership. Validated owner and active-user UUIDs are compared
canonically: hexadecimal case represents the same principal. Returned records
use canonical UUIDs, including exact-row creation receipts; different, malformed
or missing active-user identity is denied. This replaces the inconsistent
spelling-only check without changing cleanup predicates or authority.

`returnedCount` counts returned validated metadata declarations; `observedCount`
and `scannedCount` count bounded archive candidates, including an overflow
witness; `acceptedCount` includes validated witnesses not returned. Overflow
or invalid metadata makes `complete` false and `totalCount` unknown (`null`).
An exact total is supplied only for a complete single-statement enumeration.
Diagnostics use fixed reasons and messages, with at most 64 records and 128
characters per message; diagnostic truncation is explicit. These observations
read no archive payload and neither validate its bytes nor authorize cleanup.
The shared namespace scan cap is 1000; database enumeration observes at most
129 rows, while the later file listing applies its own bounded scan option.
There is no continuation or multi-page snapshot contract.

`read()` preserves record-or-null compatibility. Its single SQL projection
reports `octet_length(raw_content)` and returns payload through a `CASE` only
within `3 * MAX_YAML_SIZE` bytes. An existing oversized row throws
`EVOLUMEUNSAFE`, never disappears behind a size WHERE filter. Bounded content
then receives exact UTF-8, SHA-256, YAML/code-unit and entry-count checks.
Creation rejects non-round-tripping UTF-8 and excessive bytes before hashing
or inserting. Metadata validation rejects invalid UUIDs, digest/count/volume,
unrepresentable timestamps and reversed date ranges. Server-side precision flags
reject nonfinite or sub-millisecond PostgreSQL timestamps before driver Date
coercion; read, list, and create RETURNING all require these flags.

B2a is database safety parity and the shared metadata-observation contract.
File B1/B2b remain separate work; file owner proofs and database UUID/RLS/FK
proofs are distinct. This adds no runtime wiring, DELETING/tombstone protocol,
public browsing, retention, erasure, repair or cleanup authority. #2902 stays
open, and #2870/#2871/#2900/#2903 activation gates remain unchanged.
