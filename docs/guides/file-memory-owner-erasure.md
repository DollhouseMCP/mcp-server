# Dormant file-memory owner erasure

This guide describes the internal #2903 implementation under development. It is not qualified for production, connected to ordinary writers, or authorization to erase live data. Source review and local safety tests are in progress; final hosted qualification and the populated-test timing policy remain pending.

Head-only DELETE is already a separate dormant operation. It establishes the old owner's deletion barrier, removes the head and retires its selected head metadata, while preserving archives and reporting erasure pending. Its minimal `HEAD_DELETED` registry and returned result do not authorize whole-owner erasure. The new executor composes head retirement and archive erasure within one tracked tenant operation; it does not acquire nested leases or reinterpret a caller's locator as authority.

## Versioned unrelated-data checks

New operations use explicit schema 2 and the `dollhouse.owner-erasure.schema2.names.v1` domain. Shared directories retain complete bounded name censuses, current spelling/alias/stray checks and exact admitted name transitions at every existing checkpoint. Their unrelated children are committed by name rather than by metadata identity. A different owner's file may change metadata or be replaced at the same basename without blocking selected-owner erasure; the executor never follows, adopts or deletes that unrelated child. Unrelated name additions/removals, unsafe selected ancestors, selected-family aliases and cross-namespace physical aliases still refuse.

Every surviving selected archive object remains eagerly inspected with its full required identity, permissions and link evidence before the next selected action. The version change does not defer detection of a modified future selected object. Selected evidence, genuine replacement-owner records and added stage/canonical objects remain independently bound; awaited selected observations are followed by the required full named-parent interval recheck.

Schema 1 records retain their original full unrelated-child metadata commitments and recovery policy. Exact version/domain/kind dispatch rejects mixed or unknown authority; recovery never upgrades old evidence, changes its hash meaning or rebinds a changed foreign baseline. Legacy recovery publications remain schema 1. Same-layout versioning adds no directory or registry migration.

## Durable authority and recovery

Before retiring the old sidecar or DELETE journal, the composed operation publishes `HEAD_PREPARED` from exact durable TERMINAL DELETE evidence. After exact retirement and a successful head-parent sync and close, it publishes and qualifies `ERASURE_READY`. Recovery verifies the selected surviving records or their permitted retirement prefix. A genuinely different replacement owner at the same head name remains protected.

The executor inventories the complete old UUID namespace with no-follow observations. It accepts supported private regular files and directories even when their archive metadata is malformed or unknown: indexed and unindexed archives, incomplete generations, partial payloads, temporary files and other attributable private descendants. Inventory does not read payload bytes, parse their YAML, or follow paths declared in their metadata. Symlinks, hardlinks, special files, cross-device objects, unsafe names, permission failures and ambiguous replacements remain explicit residuals. There is no permission escalation or recursive removal command.

A missing archive namespace is valid when the fixed chain `volumes/by-id/<old UUID>` has a proved missing component. The record binds the existing ancestors and the first missing component. Recovery and evidence retirement reprove that witness; they create no directories. New appearance or replacement of the chain is a residual, not permission to capture a new inventory. An existing empty owner directory is a different case and uses the normal exact directory-removal action.

A complete bounded manifest precedes archive destruction. Incomplete segment or stage preparation currently remains a manual residual with bytes preserved; recovery does not recompute already published inventory identities. One durable `ACTION_PREPARED` record selects each postorder unlink or empty-directory removal, with exact before and after parent-name commitments. Retry may remove the same exact surviving object or qualify its authorized current absence. It never reconstructs a historical syscall receipt or silently accepts replacement bytes.

Before manifest records disappear, `EVIDENCE_RETIRING` supplies independent authority for their retirement. Authenticated successor anchors allow recovery after a predecessor was removed. Exact remaining names, current head retirement and owner absence remain required. No record embeds its own filesystem identity, and no permanent content or hash history is retained to manufacture completion evidence.

## Outcomes

`erased` means this invocation reached complete qualified absence and captured its result after the final registry-parent sync and successful close. `already-erased` requires surviving valid durable authority and freshly proved completion; it does not attribute an earlier invocation's syscall. A later audit or lease-release failure may retain only a genuinely captured result.

A known head deletion can coexist with pending or residual archive erasure. Unsupported inventory, incomplete publication, changed identity, unknown mutation or failed durability must preserve actionable evidence and report the actual outcome. No incomplete result means privacy erasure is complete.

After the final attribution journal is removed, a crash before result delivery leaves no durable per-owner acknowledgment record. A later request cannot infer historical completion from arbitrary UUID or path absence. It needs an existing outer durable purge authority, or reports unproven/manual acknowledgment. Account purge must not report completion while attributable bytes remain; its production integration and activation gate are later work.

## Conditional admission limits

The current engineering limits are admission caps, not a guarantee that every capped topology fits:

- At most 4,096 selected objects, including the owner root, and depth at most 16 below it.
- Every basename must round-trip through UTF-8 and fit 255 bytes. Complete record envelopes fit 8,192 UTF-8 bytes, including escaped names and reserved future identity widths.
- Generated absolute paths include their terminating NUL within the platform envelope: 4,096 bytes on Linux or 1,024 bytes on Darwin.
- Every complete directory census supports at most 4,095 names plus EOF. The registry parent's maximum simultaneous family includes unrelated owner records, the erasure journal, segments, stages and actual publication overlap. Segment count is therefore conditional on the existing family and packing.
- Discovery has a global 4,096-read-attempt ceiling. A successful complete tree with N objects and d directories costs `N - 1 + d` discovery reads: one per edge and one EOF per directory. A tree can satisfy the object cap and still exceed this discovery bound.

Reads reserve actual attempts before awaiting, including EOF and failures. Discovery is retained when reserving the remaining invocation schedule; work is not refunded or reset between phases. Opens, stats, record bytes, writes, syncs and closes are separate work dimensions. Head-specific budget formulas do not authorize erasure traversal. Repeated parent censuses and manifest-chain proofs can be quadratic; practical support requires the actual implementation's measured qualification.

Admission occurs before archive destruction and before the relevant evidence staging. If head DELETE has already committed when archive admission fails, the outcome remains known head deletion with erasure residual; it is not an all-or-nothing rollback.

## Operating boundary

The supported model is cooperating local POSIX writers, one filesystem and process interruption. Windows, network filesystems, multiple hosts, hostile same-UID topology changes and power-loss guarantees are not established. Reads and inspection do not adopt owners or remove leases. Age, token age, PID absence or acquisition timeout never authorize lease takeover. A blocked orphan lease requires the separately reviewed manual procedure under proved all-writer quiescence and fresh evidence.

Whole-owner erasure is distinct from later mixed-expiry retention, every-writer routing, database reconciliation and guarded activation. Retention must preserve unexpired entries through immutable replacement, conditional index publication and exact physical cleanup. No foundation merge enables ordinary production erasure or rollover.

## Dormant API and work accounting

The dormant storage API is `FileMemoryOwnerSnapshots.eraseOwned({ operationId, deleteOperationId, expectedToken })`. Recovery uses `recoverOwnedErasure({ ownerId, operationId, deleteOperationId })`. Their `InTransaction` equivalents take the lease context first. There is no account-purge or CLI wiring, and this guide supplies no live-data execution example. Standalone calls acquire one tracked operation; the transaction forms use the existing lease without a nested public operation.

`afterErasureWork` reports actual executor counters, discovery reads and reserved directory reads, plus optional separate head read counts. Callback and lease I/O are outside executor work counts; reports do not claim historical durable I/O.

The current source derives each invocation's reservation from its captured topology. Let `N` be selected objects, `K` immutable segments, and `qR` the committed unrelated registry children plus `K + 5` slots. Those slots cover the selected old registry, journal, segment family, exclusive stage, a genuine replacement registry and EOF; `qR` must fit 4,096. Segment packing reserves the complete largest future successor identity and escaped UTF-8 representation, and journal/action/retirement envelopes are checked before their relevant staging.

A fresh critical proof has scan weight `M(c,d)`: all head namespaces, the archive prefix, accounted replacement-head observations, and `N - c - 1` surviving child entries plus `d` directory EOFs. The complete root and registry observations serve their several policies within that one proof; each later proof, hook continuation and sync boundary observes them afresh. A registry transition similarly uses its complete post-transition observation for its immediate artifact policy, retaining every exact record readback.

The remaining directory-read schedule reserves an initial `M`, `8KqR` for segment publications and `8qR` for the inventory acknowledgment. Each object reserves two current and five next critical proofs, two before and five after parent censuses, and `16qR` for its two acknowledgments. Independent evidence retirement adds one removed-owner proof plus `8qR`; each segment adds six such proofs plus `22qR`, the old registry adds six plus `14qR`, and final journal retirement adds six plus `qR`. Empty-inventory qualification adds four removed-owner proofs plus `8qR`. Recovery uses authenticated remaining segments and retains conservative applicable allowances; it never recaptures a new inventory.

With reserved directory reads `B`, publication allowance `W = 2N + 3K + 5`, sync allowance `Y = W + N + K + 3`, and proof allowance `p = 7N + 6K + 20`, legacy recovery retains the conservative record-observation allowance `L = B(K + 2) + 2W + 3K + 2(N + 1) + 3p`. Schema 2 instead bounds actual observation calls: `C = p(h + N + 7) + 8W + 7N + 5(K + 1) + 20`, where `h` is the captured head-namespace count, and `T = p + 8W + 2(K + 3) + 10`. Its conservative record-observation allowance is `L = T(K + 3) + 3p + 2W + 3K + 2(N + 1) + 20`. A shared name observation performs no unrelated-child lstats, but still binds the complete containing-directory interval and closes actual descriptors. Separate finite guards cover directory/file opens, named/descriptor stats, attempted record bytes, writes, syncs, mandatory closes and mutations. These are conservative upper bounds, not exact predicted counts: the `+7` capture slots cover fixed prefix, replacement-name and missing-parent observations; unused record-observation and capture allowances also cover additional independently bound replacement-registry and direct head/fence/absence observations. Actual charged work is reported separately. Mandatory directory-read reservations and all current full census checkpoints are unchanged. Actual counters are charged before awaits, including failed attempts and EOF. Cleanup refusal cannot bypass an actual descriptor close; primary, admission and close failures remain distinguishable.

HEAD_PREPARED recovery separately reserves 17 complete head-namespace proofs and up to 18 actual replacement observations, including the extra sidecar-mismatch path. READY qualification has its own three-proof head allowance. Existing ordinary ownership metadata remains limited to 4,096 UTF-8 bytes even though erasure evidence envelopes allow 8,192. These are finite admission ceilings, not latency guarantees or proof that every capped tree is supported.

Final qualification is pending. The initial flat, 100-foreign-owner, two-volume case completed in 3.35 seconds. The original 1,000-owner/two-volume case failed the unchanged whole-test 10-second deadline; after reviewed same-proof observation reuse it still failed, with later cumulative completion at 14.83 seconds. The never-before-run 1,000-owner/ten-volume diagnostic on transition-local reuse also failed that deadline: operation 44.48 seconds, all verification 1.40 seconds, cumulative completion 47.30 seconds. Post-timeout completion and preservation assertions are diagnostics, not qualified passes. The full twelve-case population has not been qualified.

The twelve new capacity cases retain their whole-case ten-second deadline, including fixture setup and all verification; no earlier DELETE/adoption timing approval transfers. No 90-second or CI-isolation amendment is selected. Version 2 safety/compatibility checks passed locally, but its largest 1,000-flat/ten-volume case also failed the unchanged ten-second bound: setup 1.49 seconds, operation 15.90 seconds, verification 1.47 seconds and later cumulative completion 18.87 seconds. Name-read attempts stayed at 2,532,170 while executor lstats dropped to 77,669. Late completion is not a qualified pass; the twelve-case population and final hosted qualification remain incomplete. Historical failures and exact-source evidence remain in the qualification records. No merge, activation or live-data erasure is authorized by these local results.

### Read scheduling in the current candidate

V2 verifies selected registry artifacts and every surviving selected archive
object in fixed batches of at most 16 readonly observations. The canonical
ancestor checks and every shared-directory name, alias, and stray-artifact
checkpoint retain their positions. Each observation retains its complete
no-follow descriptor and named identity interval. A proof waits for all started
observations and their mandatory closes before it returns or permits mutation.
V1 recovery retains its original serial observation loops.

A failed V2 batch can attempt later readonly observations before an earlier
failure is known. One failure propagates unchanged; multiple failures form a
bounded aggregate in original order, with the first reason retained as its
cause and refusal code. Later sibling close failures remain visible. This
changes failure scheduling, without increasing the total admission ceilings
or dropping a proof. The two loops allow at most 32 observation handles plus
one enclosing directory-sync handle; the existing child-stat fanout permits
at most 256 child-stat requests within those batches. Full-directory censuses
retain their default native buffers; V2 shared-directory censuses use the
reviewed fixed 4,096-entry native buffer. These bounds describe this protocol,
not unrelated descriptors held by the process.

The buffered candidate's largest qualification case still failed the unchanged
whole-case 10-second limit, completing late at 17.606 seconds. A separate
instrumented Node/tsx diagnostic completed its operation in 11.589 seconds,
including 1.612 seconds for the head tail and 9.961 seconds for erasure. That
diagnostic used a different execution environment from Jest's VM and had
unquantified instrumentation and cache effects. It establishes no capacity
pass or projected latency for the new scheduling candidate. At that historical checkpoint, the scheduling source passed three focused fanout
tests and 62 affected lifecycle/process tests in separate runs. Its largest
capacity qualification failed the then-current whole-case 10-second limit: 14.847 seconds of late
completion, including 11.885 seconds for the operation and 1.500 seconds for
verification. The late assertions are not a pass. Eleven other capacity cases had not yet run at that historical checkpoint.


### Approved populated qualification allowance

The two 1,000-owner/ten-volume cases (flat and nested) have an explicitly
approved 45-second whole-case allowance; the other ten cases retain 30 seconds. Each still includes genuine setup, baseline capture,
the operation, every verification and cleanup in one case. There is no phase
reset or fixture split. The 100/250/1,000-owner flat/nested and 2/10-volume
workloads, read caps, proof checkpoints and assertions are unchanged. All
unrelated timeouts and the workflow's 900-second job limits remain unchanged.

The allowance provides practical shared-CI headroom over the retained 14.847-second
local scenario; it is neither a production latency promise nor a measured
worst-case bound. The earlier 10-second failures remain historical failures.
Their late diagnostics report total time before cleanup, so actual test runtime
also includes cleanup. The first twelve-case run exposed two finite lstat
reservation omissions for full shared parent observations. The corrected V2
reservation adds the seven by-id parent child-stat observations for an owner-root
action and five registry parent observations per retired segment/registry;
actual proofs and all other limits are unchanged. The corrected twelve-case run
passes all cases in 82.215 seconds, with a slowest whole test of 14.960 seconds.
The initial ten-pass/two-resource-failure result remains retained. Nine additional
public authority/restart acceptance cases pass under their unchanged 10-second
limits. Final hosted qualification remains required.

Later composed registry-family, generated-path and maximum action-envelope
admission are source-reviewed; primitive boundary tests exercise the scanner and
8,192-byte record envelope. A genuine fresh request with 4,091 unrelated registry
names reaches the stricter inherited DELETE read reservation first; it cannot
claim execution of the later erasure packing boundary.

Performance follow-up is tracked in [#2987](https://github.com/DollhouseMCP/mcp-server/issues/2987).
The V3 rolling-publication and private-evidence designs remain deferred.

The remaining eight public/process acceptance additions pass across distinct
focused runs: six actual nested-directory/owner-root rmdir-to-sync-to-close crash
prefixes, a genuine outer lease-release failure after captured completion, and
an inherited wide-registry admission refusal with full preservation. The latter
returns the original phase-aware `EHEADCONFLICT` with its exact `EHEADRESOURCE`
scan-budget cause; no head deletion or erasure publication occurred. Earlier
incorrect test checkpoint/error expectations remain in the qualification record.

The current capacity harness measures the complete whole case after awaited
cleanup, including setup, operation and every assertion. A measured deadline
failure is reported only after all case work settles. A real referenced
60-second terminal watchdog exits the entire capacity process before the
65-second Jest observer can advance with unfinished writes. These are fail-only
safety guards, not passing allowances. A hard exit may retain the temporary root
and proves neither successful cleanup nor protocol sync/close. CI invokes this
suite alone; a broader local Jest invocation would also be terminated. Use the
dedicated `--runInBand --runTestsByPath` capacity command. Earlier pre-cleanup
diagnostics and failed hosted 30-second cases remain historical evidence.
