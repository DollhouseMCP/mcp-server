# Dormant owner-erasure qualification and draft-publication exception

This record accompanies the single draft publication for [#2903](https://github.com/DollhouseMCP/mcp-server/issues/2903), based on beta `ba1e429cec6f7db32186f3cb9c46869c9c1c9e5a`. It is not merge, deployment, activation, live erasure or dependency-change approval. The exact publication commit is recorded in the draft PR; the commit containing this record is the approved publication unit.

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
