# Dormant immediate memory mutation qualification

Issue [#2993](https://github.com/DollhouseMCP/mcp-server/issues/2993) implements the immediate MCP-AQL append/clear slice of [#2906](https://github.com/DollhouseMCP/mcp-server/issues/2906). Base: beta `658f02690448588e64f1a06fe19cdff1e0274e2c`. Production dependency injection remains unchanged. This is not writer activation, migration, maintenance execution or deployment authorization.

## Behavior and authority

Authenticated session/name slots are claimed before lookup awaits. Fresh duplicate-preserving file metadata discovery fails closed on discovery/read/stat failures and does not use cached mtimes as name authority. Database discovery uses existing fresh row queries. This is not an atomic global name snapshot. Selected mutation authority comes only from subsequent same-read guarded head hydration.

Only the deeply copied preview candidate receives the source's privately captured full authority. Candidate commit never advances the unchanged source's token/content. Direct source and candidate saves compete under the existing conditional backend primitive. Unknown outcomes block source and previously derived siblings through a shared unresolved marker; a later already-dispatched success cannot clear it. Explicit fresh load creates a separate lineage.

Guarded append/clear waits for conditional save and publication before returning success or emitting mutation/removal audit. Preview clear suppresses its old premature clear event. Known-committed handler audit failure retains explicit status, candidate, manager and exact cause. Plain response fields are prepared before save; network delivery durability is not claimed. Guarded operations create no debounce timer or legacy failure-ledger entry. Cleanup/flush retain and report aggregate counts without paths, tokens or content and perform no guarded replay. Non-guarded behavior is unchanged.

## Local qualification

The final four-suite serial command used existing dependencies:

```sh
NODE_OPTIONS=--experimental-vm-modules node node_modules/jest/bin/jest.js \
  --config tests/jest.config.cjs --runInBand --runTestsByPath \
  tests/unit/storage/MemoryHeadUpdateAdapter.test.ts \
  tests/unit/storage/MemoryStorageLayer.test.ts \
  tests/unit/handlers/mcp-aql/MemorySaveHandler.test.ts \
  tests/unit/handlers/mcp-aql/MemorySaveHandler.ledger.test.ts
```

All 89 tests passed in 5.540 seconds: 29 adapter/actual-file/handler cases, 38 storage cases and 22 existing legacy-handler cases. The file tests include separate-process interference for actual append and clear, same-mtime rename-to-duplicate refusal, stale-cache same-read lookup, both source/candidate CAS orders, prederived sibling blocking after unknown and late success, predurable audit barriers, eviction audit, tenant/session isolation and retained outcomes without replay.

Meaningful red controls are retained locally: the old unconditional preview clear event fails the held precommit audit assertion; the old incremental indexed lookup accepts an actual duplicate whose metadata name changed with unchanged mtime. Each source control was restored exactly before final qualification. The initial combined run's one failure counted legitimate `_index.json` discovery publication as a legacy head write; the corrected assertion permits only index writes and all assertions remain present. No failed result is represented as a pass.

Production `tsc --noEmit`, scoped changed-unit TypeScript and changed-file ESLint passed; `git diff --check` passed. The scoped unit compiler inherits repository settings and types. Source security audit exited zero with no critical/high findings and three low findings in unchanged file evidence/fence/abort-codec modules.

Normal `npm run pre-commit` ran without bypass. Rapid security passed 108 tests with 46 selected skips across nine suites; script typecheck passed. The final dependency audit failed: 57 total, 37 high, 19 moderate, one low, zero critical. Fresh full audit SHA-256: `1f237e25163f3baf72a04228ef4701a3edaafcce12472a36921667a58b4e01ed`. The high cohort is unchanged and rooted only in GHSA-vfj7-8cjw-p6xm development chains, tracked in [#2988](https://github.com/DollhouseMCP/mcp-server/issues/2988). No manifests, lockfiles, dependencies or packaging changed. Durable evidence: [full unmodified audit JSON](evidence/guarded-aql-mutations/2026-10-04-full-audit.json), [normal precommit output](evidence/guarded-aql-mutations/2026-10-04-precommit.txt) and [source audit output](evidence/guarded-aql-mutations/2026-10-04-source-audit.txt). Text copies normalize trailing whitespace only; original text receipts remain local, and JSON bytes are unchanged. Prior PR exceptions do not automatically authorize this publication; the bounded decision is separate from local qualification.

Recorded prior image evidence showed the safety workspace contained braces/micromatch. The unchanged Dockerfile copies workspace packages wholesale, so development declarations do not prove absence from an image. Prior scan of 1,026 built JavaScript files found no direct imports; dynamic/transitive reachability was not excluded. No new live image inspection is claimed.

## Hosted qualification and deferred scope

Mick approved carrying the unchanged braces-only advisory exception through this PR's publication, qualification corrections and conditional merge on 2026-10-04 at 03:08:11 UTC, in response to the scoped request at 01:57:51 UTC. The approval was relayed by the coordinating conversation with the original message identifiers. It does not permit new high/critical findings, dependency changes, suppressions, deployment or activation. All other checks and final-head reviews remain required. The publication refresh matches the other previously retained audit variant byte-for-byte: SHA-256 `94d49ccda4919564e3159719642d3b192460b6988ef2aa653e0a40e51dc29720`, [retained JSON](evidence/database-reconciliation-2026-10-03-final-full-audit.json), with unchanged advisories and severity counts. The variants differ in effects-edge metadata; neither introduces a new high/critical advisory.

The post-merge beta Core run [37167752674](https://github.com/DollhouseMCP/mcp-server/actions/runs/37167752674/job/111335154781) failed one authentication timing assertion: unknown-account login measured 29 ms, below a 34 ms threshold derived from the wrong-password sample (68 or 69 ms). This was not a timeout. The [qualified PR run](https://github.com/DollhouseMCP/mcp-server/actions/runs/37166038347/job/111330397799) passed the same suite on an identical source tree, Node 20.20.2 and runner image. Both paths use real Argon2 verification with the same cost settings; scheduling variation is plausible but unproven. This slice does not change authentication or dependencies. That baseline failure is retained, not waived, and the new candidate requires its own passing CI. No retry lottery or threshold relaxation is authorized by this record.

Seven isolated actual PostgreSQL handler cases are authored and independently source-reviewed, but have not run locally. They cover append/clear, child/tag invalidation, source-winner conflict, dirty refusal, captured tenant/RLS and actual commit followed by an injected publication failure. Required CI execution is pending. Scoped integration typing reports only inherited diagnostics reproduced by an existing handler-suite control; this is not a strict-clean test tree claim. Integration lint passed.

Fresh exact-head CI, Codex/Claude review and Sonar gates remain required before merge. Guarded coalescing/debounce, retry/rebase, shutdown durability, other writer routes, lifecycle/rollover and the existing activation inventory remain deferred. No test/workload/job timeout, gate, infrastructure or production routing setting changed.
