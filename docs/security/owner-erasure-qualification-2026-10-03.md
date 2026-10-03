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
