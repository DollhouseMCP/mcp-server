# Cache operation counting

Test-only instrumentation for element storage and cache behavior. No production
hooks, fake storage results, timing assertions, or dependencies are introduced.

## Coverage

All six element types are covered for #3122. The original 120 assertions remain:
36 three-element list cases and 84 policy-refresh cases for personas, skills and
ensembles. New cases add 28 agent policy-refresh assertions and 504 manager
operations: `list`, `findByName`, and `get_element_details` through the real `ElementCRUDHandler.getElementDetails(name, type)`.
Each uses both file and PostgreSQL backends, 0/1/10 elements, cold/warm caches,
and unchanged/edit/delete scenarios (only unchanged for an empty portfolio).
Templates and memories do not
bear policies and therefore have no policy-refresh rows.

Of the new manager cases, 420 assert exact measured tuples for personas, skills,
ensembles, agents and templates; 84 memory cases **record counts without asserting
them**. Memory storage changes independently of this harness.
`MEMORY_COUNT_MODE` in `LegacyCounts.ts` is the single switch from `'record'` to
`'assert'`; the measured tuples in `MeasuredCounts.ts` provide the reference if that
switch is changed later. Memory operation errors still fail the test.

`extended-baseline.counts.test.ts` prints a readable memory table and creates
`<system temp>/dollhouse-counts-<unique>/measurements.json`. Jest prints its exact
path as `Counting report:`. The JSON includes every new row and all eight count
columns; report files live outside the repository and are not committed.
`MeasuredCounts.ts` is the measured reference data, not a runtime report.
To update a row in a later PR, run the extended suite, take its tuple from the
printed report, replace it under its key, and explain the change in the PR.

Every operation is measured in a fresh fixture after seeding and a priming list.
Cold cases call public `clearCache`; warm cases retain the primed cache. Lookup
always targets element 0, including the edited/deleted element. Details rows drive the server's `get_element_details` handler and its type-specific
strategy, including its missing-element response. The `details` operation replaces
the earlier synthetic lookup-plus-load sequence.

The `file/*/N/edit/warm/findByName` rows (non-memory types, N > 0) return the
pre-edit cached object with zero reads. The corresponding `delete/warm/findByName`
rows return the deleted object; a subsequent direct load would reject with ENOENT.
These characterize the known stale-lookup defect tracked under #2799, not desired
behavior: a fix should change these rows (fresh reads, no stale object or subsequent
ENOENT branch). The details rows exercise the handler separately and do not perform
that synthetic subsequent load. Warm persona `details` rows on both backends also
retain stale edit/delete objects (#2799); cold persona details and other types'
details detect deletion and reject with `ElementNotFoundError`. Empty portfolios
also reject with that typed error. A coherence fix should change these persona
rows and their expected successful stale response. Memory seed/edit/delete use public
`MemoryManager.create`, `findByName`, `save`, and `delete` on the same manager;
non-memory edits/deletes use separate storage writers. No memory storage, head,
or lifecycle internals are spied on or edited.

## API

`OperationCounter` exposes:

- `client(url)`: a real postgres.js client with `debug` and returned-value hooks.
  Inject it with `drizzle(client, { schema })` before constructing storage layers.
  SQL submission is counted once, including inside transactions. Normal Drizzle
  array results and PostgreSQL RLS behavior are retained. Close with `client.end()`.
- `observeFiles(fileOperations, predicate)`: delegates the actual `readFile` call,
  counts successful selected reads and UTF-8 bytes, excluding failed missing-file
  probes, and preserves rejection.
  Both manifest discovery and ElementLoader use this seam. Returns a restore function.
- `observeYaml()`: counts `SecureYamlParser.safeMatter` and direct `parse`/`parseRawYaml`
  entries (including rejected inputs), preserving validation and results. A nesting
  guard excludes internal wrapper validation and index extraction from loader
  counts. This covers agents' direct parser path and raw memory YAML/index parsing
  without spying on memory internals. `indexParses` counts only FrontmatterParser;
  memory's raw-YAML index parsing is included in `yamlParses` instead.
- `observePureYaml(serializationService)`: counts the shared `parsePureYaml` entry
  for pure-YAML documents such as memories, delegating the real parse.
- `observeIndexParses()`: separately counts `FrontmatterParser.extractMetadata`
  entry calls used by file index discovery. The real parser still runs; neither
  observer counts its internal `SecureYamlParser.parse` call again.
  `DatabaseStorageLayer.writeContent` also calls `FrontmatterParser.extractMetadata`
  and would increment `indexParses` if writes were measured. DB read measurements
  show zero because writes precede `counter.reset()`.
- `snapshot()`: a detached counts object; `reset()` clears counters, not caches.
  Reset only after awaited setup/mutation work completes. Restore observers in
  `finally`; do not install overlapping YAML observers or use concurrent tests.

Counters separate SELECT/INSERT/UPDATE/DELETE referencing `elements`,
`memory_entries`, or `element_tags` from BEGIN/COMMIT/ROLLBACK, SAVEPOINT/RELEASE,
SET and set_config setup. Other SQL is recorded separately. The classifier targets
the direct statements emitted by the existing Drizzle stores, not arbitrary SQL
scripts or stored-procedure effects. Trigger-internal statements are not client
round trips. Returned `raw_content` bytes use UTF-8, never JavaScript string length;
other columns and outbound parameters do not add body bytes.

`cacheFixture(mode, dbOptions)` composes real managers through the existing DI
storage factory. The original 120 cases retain their three database-backed types. Extended cases
opt into database stores for all six types. `seed`, `put`, `remove`, `activate`,
`details`, `refresh`, `managers`, `counter`, and `dispose` form the fixture API. DB mutations
use a separate real writer instance so edits/deletes do not alter the reader's
index before its scan. File mutations use fixed mtimes. DB fixture writes use fixed past/future update
timestamps so incremental scans do not depend on sub-millisecond clock rounding. File scan cooldown is zero
in this fixture to make manifest checking independent of scheduling. Database type
discovery is primed before measurements. The fixture disables file watching and
automatic external-change reloads through their public environment settings, then
restores the prior settings on disposal or initialization failure. This keeps host
configuration from adding background reads. No watcher, TTL expiry or eviction
timing is part of this baseline.

Coverage limits: ensembles use `elements: []`, so member policy closure is not
measured. Fixed `updatedAt` values deliberately avoid same-millisecond `NOW()`
misses; they do not characterize that defect. The warm DB delete
case characterizes a known stale-cache defect (#2799): the list excludes the deleted row while its exact
previously loaded object remains cached.

## Legacy measurements

`LegacyCounts.ts` retains the original exact numbers measured with the persona
lookup fix from #3120, including setup statements and zero values. They characterize
that behavior, not desired performance. The tests prime a known-row scan and cache
first; cold cases clear both manager cache and index. Warm cases retain both,
including across the external edit/delete. Seeding, activation and writes are
outside the measured operation.

Body sizes B are **92** bytes/persona, **90**/skill, **106**/ensemble. Editing body 0
reduces it by 2 bytes. Each list starts with three elements; deletion removes one
unedited body. Counts below apply to each of the three types; other SQL is zero.

| Operation | Temperature | Scenario | Data SQL | Setup SQL | Raw bytes | File reads | File bytes | Loader parses | Index parses |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| DB list | cold | initial | 6 | 20 | 3B | 0 | 0 | 3 | 0 |
| DB list | warm | initial | 3 | 8 | 0 | 0 | 0 | 0 | 0 |
| DB list | cold | edit | 6 | 20 | 3B−2 | 0 | 0 | 3 | 0 |
| DB list | warm | edit | 4 | 12 | B−2 | 0 | 0 | 1 | 0 |
| DB list | cold | delete | 5 | 16 | 2B | 0 | 0 | 2 | 0 |
| DB list | warm | delete | 3 | 8 | 0 | 0 | 0 | 0 | 0 |
| File list | cold | initial | 0 | 0 | 0 | 6 | 6B | 3 | 3 |
| File list | warm | initial | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| File list | cold | edit | 0 | 0 | 0 | 6 | 6B−4 | 3 | 3 |
| File list | warm | edit | 0 | 0 | 0 | 2 | 2B−4 | 1 | 1 |
| File list | cold | delete | 0 | 0 | 0 | 4 | 4B | 2 | 2 |
| File list | warm | delete | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Policy refresh uses the public enforcement entry
`getActiveElementsForPolicy({ allowCoalescing: false })`, which calls
`collectActiveElementsForPolicy({ freshAfterInFlight: true })`. It scans all three
indexes. In DB mode, for skills/ensembles, both cold and warm refreshes cost:

| Initially active | Scenario | Data SQL | Setup SQL | Raw bytes | Loader parses | Index parses |
|---:|---|---:|---:|---:|---:|---:|
| 0 | initial | 3 | 12 | 0 | 0 | 0 |
| 1 | initial | 4 | 16 | B | 1 | 0 |
| 10 | initial | 13 | 52 | 10B | 10 | 0 |
| 1 | edit | 4 | 16 | B−2 | 1 | 0 |
| 10 | edit | 13 | 52 | 10B−2 | 10 | 0 |
| 1 | delete | 3 | 12 | 0 | 0 | 0 |
| 10 | delete | 12 | 48 | 9B | 9 | 0 |

Every refresh above reads zero file bytes. Ten warm active skills/ensembles still
reread all ten bodies: this is the legacy wipe-on-refresh baseline.

For personas, initial and edit rows match the table above. Delete rows also probe
the deleted activation by UUID before name fallback, adding one data statement and
four setup statements without returning body bytes:

| Initially active | Scenario | Data SQL | Setup SQL | Raw bytes | Loader parses | Index parses |
|---:|---|---:|---:|---:|---:|---:|
| 1 | delete | 4 | 16 | 0 | 0 | 0 |
| 10 | delete | 13 | 52 | 9B | 9 | 0 |

All three types return N elements, or N−1 after deletion.

### File policy refresh

File `invalidate()` resets only the scan cooldown and preserves the manifest.
Warm unchanged files therefore require no body reads or parses. An edited file
is read/parsed once by the index and once by the loader; a cold refresh (cache and
index cleared) does that for every remaining file. All three types return N
elements, or N−1 after deletion. SQL and raw-content bytes are zero.
Loader parses (`yamlParses`) and index parses (`indexParses`) are separate entry
counts; their sum includes both parsing paths without counting nested validation.

| Initially active N | Temperature | Scenario | File reads | File bytes | Loader parses | Index parses | Elements returned |
|---:|---|---|---:|---:|---:|---:|---:|
| 0 | cold/warm | initial | 0 | 0 | 0 | 0 | 0 |
| 1 or 10 | cold | initial | 2N | 2NB | N | N | N |
| 1 or 10 | warm | initial | 0 | 0 | 0 | 0 | N |
| 1 or 10 | cold | edit | 2N | 2NB−4 | N | N | N |
| 1 or 10 | warm | edit | 2 | 2B−4 | 1 | 1 | N |
| 1 or 10 | cold | delete | 2(N−1) | 2(N−1)B | N−1 | N−1 | N−1 |
| 1 or 10 | warm | delete | 0 | 0 | 0 | 0 | N−1 |

A deleted file persona is probed by storage identity first: reading `<name>.md`
fails with ENOENT before name fallback also misses. File delete rows exclude that
failed probe because `fileReads` and `fileBytes` count only successful reads.

Both backends had the same persona lookup defect: the activation set holds the
storage identity, which the name lookup could not resolve. This is fixed under
#3120. These expectations describe the fixed behavior; on a tree without that
fix, persona rows fail.

## Extended measured rows

`MeasuredCounts.ts` contains the exact tuple for every extended case. The column
order is data SQL, setup SQL, other SQL, raw-content bytes, file reads, file bytes,
YAML parses, index parses. Agent fixtures are 90 bytes and template fixtures
93 bytes; editing either removes two bytes. Agent refresh in database mode adds
its own scan to the three indexed policy managers: 10 active agents cost 14 data
statements and 56 setup statements in both cold and warm unchanged cases.

Warm database name lookup still reads one body. Details costs follow each type's real handler strategy. Warm file lookup can instead return the cached object without checking
an external edit/delete. Listing scans and notices changes separately. Memory
warm edits differ because they are made through the public manager and its cache
publication, rather than a raw external writer. Database memory listing also executes a
`memory_entries` aggregate query to populate entry counts. These are observed costs, not budgets.
