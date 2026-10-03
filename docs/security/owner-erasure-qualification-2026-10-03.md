# Dormant owner-erasure qualification and bounded publication exceptions

This record accompanies the initial draft publication and one explicitly approved correction for [#2903](https://github.com/DollhouseMCP/mcp-server/issues/2903), based on beta `ba1e429cec6f7db32186f3cb9c46869c9c1c9e5a`. It is not merge, deployment, activation, live erasure or dependency-change approval. Each exact publication commit is recorded in the draft PR. The initial publication is `6dc9b52501ec1ac9656abf194c3b807819b17181`; the correction has its own narrowly scoped approval below.

## Behavior and local evidence

The [owner-erasure guide](../guides/file-memory-owner-erasure.md) describes the dormant internal APIs, strict V1 compatibility, V2 unrelated-metadata policy, unchanged shared-name/alias checkpoints, eager selected proofs, finite bounds and acknowledgment limits. Normal DELETE remains head-only. V3 publication and private-layout redesigns are deferred; performance follow-up [#2987](https://github.com/DollhouseMCP/mcp-server/issues/2987) remains open.

- All twelve populated cases passed in 82.215 seconds; the slowest whole case was 14.960 seconds. Only these twelve cases use the explicitly approved 30-second whole-case allowance, with setup, operation, every verification and cleanup retained. Workloads, directory-read caps, proof checkpoints, other timeouts and 900-second CI job ceilings are unchanged.
- The initial run under that allowance passed ten cases and failed two with resource exhaustion. Independent accounting review found omitted child-stat work in seven full shared by-id parent observations and five full registry parent observations per retired segment/registry. The correction adds only the derived V2 lstat allowance; no actual proof or other bound changed. The subsequent changed-source twelve-case run passed.
- Nine public authority/restart cases passed in 7.367 seconds under unchanged 10-second deadlines, including first-missing witnesses and actual multi-segment suffix recovery.
- Six actual nested-directory/owner-root rmdir-to-parent-sync/close SIGKILL prefixes and a genuine outer lease-release failure passed. A separate corrected public wide-registry refusal passed in 2.333 seconds, with full head/sidecar/archive/registry preservation. Its actual outer error is `EHEADCONFLICT` with the exact `EHEADRESOURCE` scan-limit cause; no erasure publication occurred. The earlier tests incorrectly expected READY and then a top-level resource code; both failed runs are retained, not represented as production failures.
- Earlier separately qualified evidence includes 62 affected lifecycle/process cases, three focused fanout cases, primitive/refusal checks and five genuine pre-change V1 fixtures. These distinct runs are not described as one fresh all-suite run.
- Production compilation, strict typing of all changed tests and full lint passed. Discovery is exactly 722 suites: 715 existing plus seven new erasure suites. Both workflows preserve ordinary suites and run populated erasure in a separate serial required stage.

The historical 10-second capacity failures remain failures even where assertions completed late. The scoped allowance is not a production latency or worst-case promise. Full exact-head CI, substantive Codex/Claude review and actual Sonar qualification remain required before any merge.

## Failed normal gate and exact exception

`npm run pre-commit` ran normally. Rapid security passed 108 tests with 46 skipped, and script typecheck passed. Its final `npm audit --audit-level=high` failed: 57 findings, including 37 high, 19 moderate and one low, with zero critical. The complete [failed audit report](evidence/owner-erasure-2026-10-03-failed-audit.txt) is preserved with trailing whitespace normalized; the full JSON receipt is unmodified.

A fresh full lock audit (`npm audit --package-lock-only --json`) independently reports the same counts. Every high package path resolves solely to [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), the `braces <=3.0.3` stack-exhaustion advisory. The [full JSON receipt](evidence/owner-erasure-2026-10-03-full-audit.json) and [per-package high-root mapping](evidence/owner-erasure-2026-10-03-high-roots.json) retain all findings, not a filtered passing audit. Raw JSON SHA-256: `1f237e25163f3baf72a04228ef4701a3edaafcce12472a36921667a58b4e01ed`.

On October 3, 2026 at 03:00 UTC, Mick explicitly authorized proceeding with one commit, push and **draft** PR for this unchanged advisory, with a remediation issue and an explanation of the exception. The authorization does not permit gate edits, audit suppression, dependency changes, another high/critical advisory, hook bypass, merge or deployment. The failed gate remains failed. All ordinary Git hooks are retained; no hook-disabling flags are used. Remediation and image hygiene are tracked in [#2988](https://github.com/DollhouseMCP/mcp-server/issues/2988).

The development-toolchain declarations do **not** establish runtime absence. The installed safety workspace contains `braces@3.0.3` and `micromatch@4.0.8`, and the Dockerfile copies the packages workspace wholesale. Source/built-file review found no demonstrated runtime invocation path, but direct-import absence does not exclude dynamic or transitive use. The user's initial runtime-absence rationale is therefore qualified by this explicit packaging/reachability caveat. No claim of harmlessness, false positive or runtime exclusion is made.

## Frozen source and unchanged dependencies

Executor blob: `4af961c66c35e2a7dfc0d928adf60202f969b839`; SHA-256 `685ccea15c193d63c46b62ef8f21930d4e750b46275620f46a549dd61bd63539`. Inspection blob: `2fb1ecf237c052868ab6f68bf79fe2c0e1c39977`; SHA-256 `62bf254622fe0c77e7dbb38950d0a6dfb60cb6b16c5344d4ef67808b64336228`. Both have independent exact-source review; the executor includes the reviewed shared child-stat correction.

No root, safety or workers manifest/lockfile changes are included. Root package SHA-256 is `cb5418442320ed77a017b1b587ebde16721b9831bef7b22da004f30a0c6ec2c0`; root lock is `f85a846cafae58adc6a0f62a87a9aaac7cd33613119ae154c8bc55d0f8a59446`. Safety package is `9197df54868218114f9993f882ff7487176d87034cb08f9bd3dc75700b884b24`; safety lock is `0afd60629da48c0e024b04422ee093d8ad12a3945e542b357d23a20776efb01f`.

## One approved selector/sort correction

At 04:05 UTC on October 3, 2026, Mick replied “Yes you may” to the explicit
request to extend the same braces-only exception to one correction commit and
push, with fresh audit, CI and reviews still required. This covers only four
explicit protocol sorts, the private ownership-selector rename, and this
qualification/evidence update. It does not authorize another source change,
dependency change, gate edit, suppression, merge, deployment or activation.

The private selector is now named `expectedOwnership`, distinguishing an owned
head's concurrency evidence from credential secrets. Public `expectedToken`,
error strings, evaluation order and returned-promise semantics are unchanged.
The four typed-string sorts use the existing `evidenceOrdinal` comparator,
which exactly retains default UTF-16 code-unit ordering. No locale ordering,
proof, checkpoint, accounting limit, V1/V2 policy or deadline changes are made.
Independent exact-source review accepted both files before qualification.

Twelve existing affected ordinary lifecycle/suffix cases pass in 14.828 seconds
across two suites. They are distinct from the twelve populated capacity cases;
capacity was not repeated for this behavior-preserving correction. Production
compilation and focused lint pass. The actual default-config source auditor
reports 190 scanned files, zero high/critical findings and the same three
inherited LOW logging observations. The original hosted scanner's credential
finding was a literal-regex false positive on the ownership selector, rather
than a hardcoded secret; its [failed hosted report](https://github.com/DollhouseMCP/mcp-server/pull/2989#issuecomment-5964939925) remains preserved.

The fresh full lock audit still fails with 37 high paths, zero critical,
19 moderate and one low. All high paths and their nodes are unchanged and
resolve solely to GHSA-vfj7-8cjw-p6xm. No manifest or lockfile changes exist.
The [fresh correction audit](evidence/owner-erasure-correction-2026-10-03-full-audit.json)
has raw SHA-256 `94d49ccda4919564e3159719642d3b192460b6988ef2aa653e0a40e51dc29720`.
The correction's normal precommit passed 108 rapid-security tests with 46 skipped
and script typecheck, then failed on the same 37-high advisory cohort. Ordinary
Git hooks remain in place; the advisory exception
is recorded, not transformed into a passing dependency gate. [#2988](https://github.com/DollhouseMCP/mcp-server/issues/2988)
continues to own remediation. The safety workspace's `braces@3.0.3` and
`micromatch@4.0.8` are included by Docker's wholesale packages copy. A direct
scan of 1,026 built JavaScript files found no direct imports, which does not
exclude dynamic or transitive runtime invocation.

The correction's reviewed OwnerSnapshots blob is
`603a326715ece71d39e79aa3893199c042046dd8`, SHA-256
`5e6a255dac26de36386d50fdd19ddfc0ece906a9e6f204850aa829116e6ab617`.
The executor blob is `5da629edde1d2b84e19ca682e38e7bb79f5fbfb6`, SHA-256
`2a4f550e4ca75ea257e5ec6c3ab88fbd4d4305ecdc831f3811605829b00ba3bb`.
The 95 nonblocking maintainability findings, including deliberate sequential
proof and async-rejection contracts, are tracked in [#2990](https://github.com/DollhouseMCP/mcp-server/issues/2990).
Performance work remains in #2987; V3 remains deferred.

## Original-head hosted qualification remains incomplete

Fresh Codex [comment 5964965126](https://github.com/DollhouseMCP/mcp-server/pull/2989#issuecomment-5964965126)
found no major issues for `6dc9b52501`. Claude found no blocking issue; the
workflow's checked-out-head and current-head guards independently substantiate
its exact-head association. These reviews do not transfer to the correction.

All four cancelled original-head matrix jobs hit their unchanged 15-minute job
limit. [Core Ubuntu 20](https://github.com/DollhouseMCP/mcp-server/actions/runs/37092134289/job/111114517315)
completed only five erasure cases before cancellation;
[extended Ubuntu 22](https://github.com/DollhouseMCP/mcp-server/actions/runs/37092134279/job/111114517546)
completed only eight. [Extended Ubuntu 20](https://github.com/DollhouseMCP/mcp-server/actions/runs/37092134279/job/111114517498)
completed all twelve erasure cases and required enforcement, then was cancelled
in post-cache cleanup. These outcomes remain distinct from a successful job.

[Core macOS 20](https://github.com/DollhouseMCP/mcp-server/actions/runs/37092134289/job/111114517176)
also has a real erasure case failure: the 1,000-owner, flat, ten-volume case
exceeded its approved 30-second limit. The operation completed in 31.998 seconds
and assertions completed late at 38.697 seconds; late completion is not a pass.
That suite had eleven passes and one failure before later job cancellation.
The selector/sort correction makes no capacity or job-duration fix claim.
Fresh exact-head CI and reviews, including actual Sonar, remain required;
no old-head runtime pass or review is transferred as new-head qualification.

## Required erasure matrix isolation

On 2026-10-03 at 04:32 UTC, Mick answered “Yes go ahead” to separating
required serial erasure qualification into its own jobs while preserving cases,
platform coverage and limits, and extending the same braces-only exception to
remaining qualification commits within this draft PR. This permits no dependency,
production behavior, test timeout, gate suppression, merge or deployment change.

Both workflows share their original platform/Node matrix with a new erasure job
through a YAML anchor. Each erasure job retains the 15-minute ceiling and runs
only the existing complete serial capacity suite after install/build. Windows
retains that suite's existing intentional POSIX skip. Existing protected `Test`
contexts and `Extended` contexts keep their names and depend on their workflow's
entire erasure matrix. Their first gate runs even after dependency failure and
requires exactly `success`; the erasure job also independently enforces its
actual test-step outcome, refusing failed, cancelled, skipped or missing results.
No branch protection settings change. Waiting for dependencies does not consume
the ordinary job's runner time. This scheduling change makes no capacity latency
promise and preserves the earlier real macOS 30-second failure.

The existing static workflow suite passes 165 tests. Additional configuration
validation confirms complete matrix parity and rejects omitted jobs, commands,
platforms, dependencies, conditional matrix skipping and tolerated failures.
The actual extracted Bash guards each reject failure, cancellation, skipping,
empty and unset outcomes, accepting only success. These local checks validate
configuration and enforcement logic; fresh hosted execution remains required.
No unchanged capacity or runtime test was repeated for this workflow-only change.

Normal precommit again passes 108 rapid-security tests (46 skipped) and script
typecheck, then fails the unchanged dependency audit. The fresh full audit has
identical raw SHA-256 `94d49ccda4919564e3159719642d3b192460b6988ef2aa653e0a40e51dc29720`
and is already preserved in the linked correction audit above: 37 high paths,
zero critical, 19 moderate and one low. All high paths/nodes remain unchanged
and rooted only in GHSA-vfj7-8cjw-p6xm. Ordinary hooks remain intact. The #2988
exception and the safety image's development-tree presence and unproven dynamic
or transitive runtime reachability remain material caveats.

The superseded `42dcd993d257f3c0493e69d986e404934990703d` head ended
with 22 successful checks and two 15-minute job timeouts; those results do not
transfer to the scheduling correction. Beta's three protected core Test contexts
are unchanged. Extended contexts are not branch-protected; each still enforces
its own complete six-lane prerequisite matrix, and final review requires their
actual hosted outcomes as well.

## Cleanup-inclusive capacity lifecycle correction

On 2026-10-03 at 14:18 UTC, Mick answered “Yes you may proceed” to the
reviewed cleanup-safe harness and a 45-second whole-case allowance ONLY for
the flat and nested 1,000-owner/ten-volume cases. The other ten populated cases
retain 30 seconds. Setup, operation, every assertion and awaited cleanup remain
one whole case; no production protocol, workload, proof, resource cap, platform
matrix or 900-second job ceiling changes.

The old `6806f8d598186e1f543861297cdd179c23a1acf9` hosted result is
24 successful checks and nine failures, including propagated matrix failure.
Its isolated Extended Ubuntu 20 job had ten passes and two genuine 30-second
failures; late assertions completed around 31.6 seconds before cleanup.
Extended macOS 22 likewise failed the two largest cases. These remain failures,
not transferred passes. Core Windows 20 also had a separate npm installation
EEXIST/EPERM cache cleanup failure, unrelated to erasure authority or timing.
The new local qualification below does not establish a fresh hosted pass.

Fixture creation is now covered by the outer lifecycle. Its isolated temporary
root is registered immediately after allocation and before realpath/setup can
reject. Setup failures await helper cleanup; outer cleanup is idempotent.
Body and cleanup failures preserve their original causes. Measured deadline
failure is emitted only after all body work and cleanup settle, preventing
ordinary timing failures from leaving writes running into the next case.

A real, referenced 60-second terminal watchdog is armed before the first await.
It emits a bounded synchronous best-effort diagnostic and exits nonzero even if
that diagnostic throws. The 65-second Jest observer is only a fail-safe guard;
neither value is a passing allowance. A hard hang terminates the entire dedicated
capacity process rather than advancing to another case. Its temporary root may
remain, and no successful cleanup or protocol sync/close is claimed. The timer
remains armed through awaited cleanup and final diagnostics. CI invokes the
capacity suite alone; a broader local Jest invocation would also be terminated.
Event-loop blocking may delay timers; a completed case still fails its measured
whole-case limit. This is test lifecycle control, not production cancellation.

Independent exact-source review accepted the five-file harness/fixture/test/guide
freeze before runtime. Eight small harness regressions pass in 1.289 seconds:
cleanup-inclusive timing, setup root rejection/removal, body plus cleanup failure
ordering, sole cleanup failure, drained late writes, and actual child-process
terminal exits for setup hang, cleanup hang and diagnostic failure. Child teardown
awaits actual process closure before removing the isolated fixture, including
error paths. Focused lint and strict changed-test typing pass.

The full twelve populated cases then pass once in 80.235 seconds with twelve
post-cleanup completion markers. The largest flat case measures 14.171594 seconds
including 0.121118-second cleanup; nested measures 14.331963 seconds including
0.125476-second cleanup. All assertions and workloads remain intact. Whole time
is sampled after awaited cleanup and before the final diagnostic; Jest's reported
case duration additionally includes that bounded diagnostic/return overhead.
No old-head pass is transferred, and no timing or CI guarantee is inferred from
these local measurements. Fresh exact-head hosted qualification remains required.

Normal precommit passes 108 rapid-security tests (46 skipped) and script typecheck,
then fails only the unchanged authorized audit cohort. The fresh full lock audit
again has 37 high, zero critical, 19 moderate and one low, with identical high
paths/nodes rooted solely in GHSA-vfj7-8cjw-p6xm and raw SHA-256
`94d49ccda4919564e3159719642d3b192460b6988ef2aa653e0a40e51dc29720`.
The durable correction audit linked above therefore preserves the identical full
report. Manifests, lockfiles, workflows and production blobs are unchanged by
this harness correction. The ordinary hooks and standing narrowly scoped #2988
qualification-publication exception remain in force; no suppression, merge or
deployment waiver is introduced. The safety image contains the affected
braces/micromatch development tree, and the scan of 1,026 built JavaScript files
with no direct imports does not exclude dynamic/transitive runtime reachability.

Suite discovery is 723: the previous 722 suites plus the single new small harness
suite. No prior suite is removed. Reviewed lifecycle helper SHA-256 is
`e300b5321467fc6630be9b9a13082a895ef56fc45797fbf8f3e7fdae6083b7c0`;
capacity test SHA-256 is
`307e8b8a3735785c440d2ab584bfcfab9507391f745c5b683e047d261561360c`.
All reviewed file hashes remained unchanged through qualification.

## Ordinary erasure isolation and drain correction

Exact head `84332b804257e8c170d003afd96e3044f97ba33e` finished with
30 successful checks, one core macOS ordinary failure and two extended macOS
15-minute cancellations. All nine populated capacity jobs succeeded: 72 actual
POSIX cases passed and 36 Windows cases intentionally skipped. Those results
remain distinct from the ordinary failures and do not transfer to this change.

Core macOS had five unchanged ten-second lifecycle timeouts and one demonstrated
cross-test fault-injection failure. The timed-out release test retained a global
prototype spy until its still-running async finally restored it; the next
fixture's adoption received that exact controlled post-release EIO. The current
correction scopes the fault to its actual fixture instance. Every case in this
one ordinary lifecycle suite uses the existing cleanup-safe helper with a measured
ten-second whole passing budget. Original bodies, assertions and finally blocks
remain; a terminal 60-second watchdog and 65-second observer are fail-only.
Fixture registration before setup supplies a once-only cleanup promise shared by
the original finally and outer drain. A rejected cleanup stays rejected without
retry; the same identical cause encountered twice is reported once. Distinct
body/cleanup causes remain preserved by the helper, but an unchanged body finally
can still mask its earlier error before the adapter receives its final rejection.

The required serial storage matrices now own the existing CREATE, cleanup,
RENAME and DELETE suites plus the ordinary erasure lifecycle suite. Their platform
and Node definitions alias the same original matrices, their job ceilings remain
900 seconds, and final always gates require success for every actual suite step.
Existing Test/Extended contexts retain their names and require BOTH entire
capacity and serial-storage matrices to succeed, refusing failed, cancelled,
skipped or missing aggregate results. Extended remains separately enforced within
its workflow and is not silently represented as branch-protected. No production,
dependency, passing allowance, workload, platform or proof changes are included.

This addresses demonstrated budget starvation: both extended macOS ordinary
matrices passed 16,751 tests before their jobs reached fifteen minutes in the
following serial storage stages. It is scheduling isolation, not a demonstrated
cure or latency promise for the five ordinary timeouts. Fresh source review and
changed-path qualification are required before publication.

Independent final nine-file review accepted the test/fixture/guide/workflow freeze
before execution. Changed-path qualification passes 226 tests across three suites
in 56.944 seconds: all 50 retained ordinary erasure cases plus the genuine A/B
fixture regression (51), the eight retained helper cases plus two once-only
cleanup regressions (10), and 165 existing workflow-validation cases. All 51
ordinary completion markers are within the measured ten-second whole budget,
with no failed flag; the largest is 2.461065 seconds. The helper's intentionally
rejected cleanup marker is expected failure evidence asserted by its passing
regression, not a failed ordinary case. Cached cleanup executes once across body
finally and outer drain, and identical reobserved error identity remains exact.
All reviewed hashes remained unchanged through this qualification.

Both actual aggregate shell gates were validated over 36 combinations of the two
matrix results, accepting only two successes. Each serial-storage gate was
validated over 30 per-stage success/failure/cancelled/skipped/empty/unset outcomes.
Seven omitted/skipped/tolerated-failure configuration mutations per workflow are
rejected. Shared matrix parity, original protected names, 900-second ceilings,
unchanged capacity job objects and the exact ordinary suite partition were
checked. These configuration tests are not a substitute for hosted execution.
Strict changed-test types and focused lint pass. No unchanged populated capacity
suite was repeated locally; the new head must qualify every hosted capacity lane.

Normal precommit passes 108 rapid-security tests (46 skipped) and script types,
then fails only the standing authorized dependency advisory cohort. Fresh full
lock audit reports 37 high, zero critical, 19 moderate and one low. All high
paths/nodes remain unchanged and rooted solely in GHSA-vfj7-8cjw-p6xm. Its raw
SHA-256 `1f237e25163f3baf72a04228ef4701a3edaafcce12472a36921667a58b4e01ed`
exactly matches the original full durable audit linked above. No manifest,
lockfile or production source change exists. Ordinary hooks remain intact;
#2988's narrowly scoped qualification-publication exception does not waive merge,
deployment or activation. The safety image contains the affected development
tree, and the 1,026-file built-JavaScript direct-import scan does not exclude
dynamic/transitive runtime reachability. Fresh exact-head CI/reviews/Sonar remain
required; the earlier failed head remains unqualified despite its capacity passes.
