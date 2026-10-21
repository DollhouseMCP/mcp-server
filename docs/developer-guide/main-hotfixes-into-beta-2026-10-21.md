# Main 2.0.43 hotfix integration into beta

This branch is a real two-parent merge of beta and main. It preserves beta’s newer storage, parser and ZIP designs while carrying the remaining main hotfix behavior and regressions. It does not update beta to 2.0.43 or to beta.3. Dependency remediation and release preparation remain separate branches.

## Source boundary

- Beta parent: `d0278ad58d962a3386be34379475c40600c141a1`.
- Main parent: `b2b93accf670c8c3dfa884e9f6c379bf93768001`.
- Common ancestor: `7de1f2983bc17469233ea6fb50254b49e2ff302f`.
- Main-only history: 20 commits (11 non-merge commits and 9 merge commits).
- Initial merge: 22 conflicted files and 55 conflict hunks. All were resolved explicitly; no merge strategy discarded an entire parent.
- Root/Safety manifests and lockfiles, manifest.json and server.json retain the exact beta payload. Safety remains 1.0.5 and the application remains 2.1.0-beta.2. The build refreshed only the generated timestamp; that incidental timestamp was restored after proving every other byte equal to beta. No functional source changed after validation.

## Behavior and regression mapping

| Main hotfix | Integration choice | Regression proof |
| --- | --- | --- |
| #3003 memory | Keep beta DI, Map/onFull policies, tenant/storage guards, quiet candidates and newest-first wire order. Add oversized legacy direct-append refusal before mutation, preserve that runtime flag through preview/persistence/fingerprint, and synchronously propagate opted-in on-load enforcement errors. Keep the public retention method async; remove expired search-index entries. Reused-instance deserialize refreshes the loaded capacity and removes the prior derived index IDs before replacing the Map. | Added capacity, retentionFailures and legacyRecovery suites; existing concurrent/saveLimits/Memory/index suites. |
| #3007 ZIP | Keep beta yauzl streaming, entry/type/link/size bounds, exclusive extraction root and archive-close ownership. Preserve all main link/sentinel/root cleanup assertions in a separate exact main regression suite. | zipExtraction.test.ts plus zipExtraction.main-hotfix.test.ts. |
| #3008 / #3026 YAML and exported helpers | Keep beta bounded raw parser, owned YAML/JSON engines, CORE-schema derived index, FileOperationsService and service-object DI. Existing main behavior is already present or stronger. Add missing exact DEFAULT_SCHEMA regression file. | languageSafety, frontmatterSafety, defaultSchemaSafety, ElementFileOperations.frontmatterSecurity and EnhancedIndexManager. |
| #3013 danger-zone persistence | Keep beta serialized whole-snapshot persistence and catch-safe continuation; main ordering regression already present. | DangerZoneEnforcer.persistenceOrdering.test.ts. |
| Command execution smoke | Keep beta mocked spawn/env/stdin/output assertions; no real git status checkout scan is run. | CommandValidator.test.ts. |
| Proxy/shell-quote and YAML pins | Beta already carries the approved proxy-addr 2.0.8, shell-quote 1.11.0 and js-yaml 4.3.2 pins; retain its complete lock graph. | Exact manifest/lock equality to beta; existing parser/security suites. |
| Safety trusted UUID | Implementation and test already match main; retain newer beta Safety 1.0.5 metadata. | Standalone Safety suite and main/beta blob comparison. |
| Stable release metadata | Preserve beta identity; add main’s exact 2.0.43 changelog section without deleting beta history. | Metadata/lock equality and changelog section comparison. |

### Test adaptations

- Main positional MemoryManager constructors and static resolver hooks are replaced with beta dependency injection and storage/event factories. Assertions still cover admission counts, exact content sets, byte preservation, error identity and write limits.
- Main insertion-order assertions are compared by entry identity/content because beta persists newest-first. No entry/content assertion is removed.
- Added suppressLoadPolicy and search-index expiry checks. Read-only tests also verify preview and persistence copies refuse mutation; the flag is intentionally absent from serialized data.
- The main DEFAULT_SCHEMA and separate ZIP regression files are byte-exact main payloads.

## Conflict decisions

Every original hunk’s line interval, beta/main content digest and resolution is recorded in [the conflict ledger](evidence/main-hotfixes-into-beta-2026-10-21-conflicts.json). Line intervals refer to the original unresolved merge, not the final file.

| File | Hunks | Resolution |
| --- | ---: | --- |
| `CHANGELOG.md` | 1 | Combine beta history with exact main2.0.43 section; preserve both release histories without changing beta version. |
| `manifest.json` | 1 | Keep beta2.1 prerelease manifest; main2.0.43 metadata belongs to stable release, not beta. |
| `package-lock.json` | 6 | Keep newer beta whole lock; main proxy2.0.8/shellquote1.11/jsyaml4.3.2 and SafetyUUID fixes already represented. No Phase2 resolution or main extract-zip downgrade. |
| `package.json` | 4 | Keep beta2.1 metadata and newer reviewed dependency graph; main security pins already equal. No dependency remediation mixed into merge. |
| `packages/safety/package-lock.json` | 2 | Keep beta Safety1.0.5 lock; UUID implementation/test exact main, newer beta development pins retained. |
| `packages/safety/package.json` | 1 | Keep beta Safety1.0.5/floor; UUID behavior already exact main1.0.4. No version downgrade. |
| `server.json` | 2 | Keep beta registry version at both required locations; do not import stable2.0.43 identity. |
| `src/cli/convert.ts` | 2 | Keep beta typed yauzl extraction/callback and exact private-root cleanup; main cleanup semantics already met without older exists precheck. |
| `src/cli/zipExtraction.ts` | 2 | Keep beta newer sequential yauzl validation/stream ceilings/fd-close ownership. Main link refusal/private-root semantics covered by added main-hotfix archive suite. |
| `src/elements/memories/Memory.ts` | 8 | Retain beta DI, authoritative Map/onFull rules, persisted ordering, policy counters and guarded candidates; port main synchronous enforcement failure boundary, index cleanup and oversized append refusal explicitly. |
| `src/elements/memories/MemoryManager.ts` | 2 | Retain beta storage/tenant/load hooks and metadata normalization; bind main read-only behavior to existing captured raw-content hook, not old file-only loader. |
| `src/elements/memories/constants.ts` | 1 | Keep beta documented limits: same256Ki/2Mi string-unit values as main; no raised limits. |
| `src/generated/version.ts` | 1 | Keep the exact beta generated version file; discard build-only timestamp churn, never import stable2.0.43. |
| `src/storage/MemoryMetadataExtractor.ts` | 1 | Keep beta recovery-aware extractor; main limit/name recovery behavior already met. |
| `tests/unit/base/ElementFileOperations.frontmatterSecurity.test.ts` | 7 | Keep beta FileOperationsService DI and read/write-limit assertions; same main owned-engine and no-write cases retained. |
| `tests/unit/cli/zipExtraction.test.ts` | 2 | Keep all stronger beta archive tests and add exact main tests separately; do not discard link/private-root/sibling coverage. |
| `tests/unit/elements/memories/Memory.api.test.ts` | 1 | Keep beta copy-safe lookup by entryID rather than mutating stale returned object; main trust-selection assertion preserved. |
| `tests/unit/elements/memories/Memory.test.ts` | 1 | Keep beta explicit expiring/evicting case; main permanent-capacity rejection preserved in adapted dedicated capacity suite. |
| `tests/unit/elements/memories/Memory.timestamp.test.ts` | 6 | Keep beta typed Map and content-addressed timestamp mutations; no insertion-position assumption or assertion weakening. |
| `tests/unit/logging/sinks/FileLogSink.test.ts` | 1 | Keep beta deterministic clock near midnight; same main retention filename behavior/assertions. |
| `tests/unit/security/CommandValidator.test.ts` | 1 | Keep beta mocked spawn/env/stdin/output boundary; no real checkout git-status scan or platform skip added. |
| `tests/unit/services/SerializationService.frontmatterSafety.test.ts` | 2 | Keep beta service-object DI/event/storage factory; same main frontmatter admission/body precedence assertions. |

## All main-only commits

| Commit | Subject |
| --- | --- |
| `b2b93accf670c8c3dfa884e9f6c379bf93768001` | Merge pull request #3040 from DollhouseMCP/hotfix/main-safety-104-release-prerequisite |
| `5779bdc3a296c0363ecad04018a96a56fc220b95` | fix(safety): prepare trusted UUID challenge release 1.0.4 |
| `4546ef32b06ccb1e1290ccdfe8d8d830f69c8b81` | Merge pull request #3030 from DollhouseMCP/hotfix/2.0.43-release-metadata |
| `8c3e98bf89ba2c37ca1587672264b58b70aacb8d` | Merge remote-tracking branch 'origin/main' into hotfix/2.0.43-release-metadata |
| `bd89f8578533bcf0cb4e0764307a78448780f6f1` | Merge pull request #3033 from DollhouseMCP/hotfix/main-default-yaml-security |
| `2728d1d6eae395b2f0465b0d7a2a1c1a98bfe2ad` | fix(security): pin supported default YAML parser |
| `a66f3ffc9f875b874288ed935654804ade0655f8` | Merge remote-tracking branch 'origin/main' into hotfix/main-default-yaml-security |
| `4e37df472374e66ccd8105232a5fe6e0b2d8d903` | fix(security): use owned frontmatter engines in exported file helper (#3026) |
| `8b86a82e525deb643e15b163c7069f0596e04104` | chore(release): prepare 2.0.43 metadata and notes |
| `39faeea8b481ed199b2c4c32e666e890b75123de` | Merge remote-tracking branch 'origin/main' into hotfix/main-element-file-safety |
| `7ffedb08b559172d2b35bebc2385d8bb3b9e528a` | Merge pull request #3021 from DollhouseMCP/hotfix/2999-main-audit-blockers |
| `d0f6e633b341f67fd9f7b556574c643e081a8350` | fix(security): use owned frontmatter engines in exported file helper |
| `5c8dad32fbd45bf5cde353ec62b3a020c49b87e3` | fix(deps): pin approved proxy and shell quote security patches |
| `d6feb92259760bab5f167c6c699b936ee006bf27` | Merge pull request #3013 from DollhouseMCP/hotfix/main-dangerzone-persistence |
| `69d9ca37ecfee2252ac79dcaf049488ac57971a0` | test(security): isolate command execution smoke from checkout scan |
| `230a03690930fad153d36efbb0093397ee98cf11` | Merge remote-tracking branch 'origin/main' into hotfix/main-dangerzone-persistence-ff-publication |
| `1493490ae698b09dbdc371328851f9eaae204c0c` | fix(security): restrict frontmatter and index YAML parsers (#3008) |
| `156991825c29b4dd728b343ede72d21e647360ac` | fix(security): order main danger-zone block persistence |
| `63b110f70339466f03b57081a6615a50674924f0` | fix(cli): refuse ZIP links and preserve cleanup ownership (#3007) |
| `1b4f8eb90027ce6be4e7e9c4f83a791d2565ef02` | fix(memory): preserve permanent entries and recover legacy heads on main (#3003) |

## Validation and remaining blockers

**This is a reviewable merge candidate, not merge-ready.** The full default suite failed; local integration was interrupted and is incomplete because required PostgreSQL/CI prerequisites are unavailable. No failing assertion, deadline or skip condition was weakened and no unchanged test wave was retried.

Environment: macOS arm64, Node 24.16.0, npm 11.13.0. Heavy waves ran sequentially. Counts below are separate runs and must not be summed as unique coverage.

| Check / exact command | Result |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | Exit 0; existing locked graph only. |
| `npm run build` | Exit 0; Safety locked setup/build, root TypeScript and runtime asset copy. |
| Critical memory/YAML/index/ZIP selection below | Exit 0; 13 suites / 187 tests passed, 8.498s. |
| `npm test -- --maxWorkers=2` | Exit 1; 802 passed / 3 failed / 1 skipped suites (806 total); 18,561 passed / 4 failed / 14 skipped tests (18,579 total), 554.178s. |
| `npm run test:performance -- --runInBand` | Exit 0; 10 suites / 120 tests passed, 8.94s. |
| `npm test -- --runInBand` in `packages/safety` | Exit 0; 3 suites / 79 tests passed, 2.411s. |
| `DOCKER_AVAILABLE=false npm run test:integration -- --runInBand` | **Interrupted / incomplete** after 27+ minutes: 126 passing and 10 failing suite reports observed. These are partial observations, not terminal full-suite/test totals. |
| Static resolution/metadata checks | No unmerged entries; all 22 conflict files / 55 hunks and 20 full commit IDs recorded. Six metadata/lock files and final generated version remain byte-exact beta. `git diff --check` passed. |

The first default run was explicitly stopped at 217 passing suite reports / zero recorded failures after independent review found two additional main deserialize behaviors. It is superseded and is not a complete passing run. The final-source run above is the completed default result. Rebuild and targeted rerun were justified by those source corrections; there was no unchanged retry.

### Completed default-suite failures

| File | Observed failure / limit |
| --- | --- |
| `tests/unit/services/BuildInfoService.parallel.test.ts` | `getBuildInfo` resolved and the preceding shape checks passed; elapsed 1,313ms failed the existing strict local `< 1,000ms` assertion. No stage-level cause is known; this is not a Jest timeout or demonstrated parallelism defect. |
| `tests/security/docker-security.test.ts` | Two Docker build/run checks failed because the configured Podman compatibility endpoint could not be reached. No successful image/engine test operation is established; no VM/service startup or manual Docker retry was performed. |
| `tests/unit/auth/embedded-as/EmbeddedAuthorizationServer.assets.test.ts` | `/fonts.css` returned 404 instead of 200. Later CSS/logo/font assertions were not reached. Source and asset bytes match beta; files present afterward do not identify the failing runtime resolution or establish that the failure predated this merge. |

Relevant unchanged bodies rule out direct changes to those bodies; they do not prove a preexisting failure, absence of merge interaction or a host-load cause. All failures remain failures.

### Incomplete integration and capability limits

PostgreSQL setup reported unavailable. Some tests have explicit CI-service refusals; others failed fixture user queries, `SELECT 1`, or catalog-fixture setup with `AggregateError`. Their subsequent SQL guard, RLS, ownership, tag, catalog and race assertions are not qualified. Passing/early-returning availability-gated cases are not database execution proof.

Failed files observed before the stop:

- `tests/integration/database/DatabaseStorageLayer.test.ts`
- `tests/integration/database/DatabaseMemoryTagHeadRevision.test.ts`
- `tests/integration/database/DatabaseMemoryInvalidationStructureVerifier.test.ts`
- `tests/integration/database/DatabaseMemoryAdmissionGate.test.ts`
- `tests/integration/database/DatabaseMemoryLegacyTagAuditor.test.ts`
- `tests/integration/database/DatabaseMemoryMaintenanceCatalogVerifier.test.ts`
- `tests/integration/database/portfolio-persistence.test.ts`
- `tests/integration/database/DatabaseMemoryArchiveCleanup.test.ts`
- `tests/integration/database/invitation-lifecycle-migration.test.ts`
- `tests/integration/database/DatabaseMemoryInvalidationCatalogVerifier.test.ts`

The configured integration selection contained 199 test files. Because the run was interrupted, no full integration denominator or skipped-case total is asserted. Existing `DOCKER_AVAILABLE=false` capability handling left all eight `tests/integration/hooks/permission-hook-docker.test.ts` cases unexecuted; PostgreSQL-gated cases were also unavailable. No production SMTP/OAuth/GitHub credentials were enabled. Live E2E/browser and credential-dependent tests were not enabled or claimed as covered.

The session stop was an explicit orchestration decision after repeated unavailable prerequisites, not an invented test timeout, timing waiver or passing qualification. Only the verified owned Jest PID was sent SIGINT. No descendants were recorded at the stop, and the recorded Jest/cross-env/npm chain ended. The interrupted run did not produce a full teardown/quiescence proof; its ignored `.test-tmp` directory was retained. The shell's exit 0 after SIGINT is not a passing integration result. Normal CI with its required PostgreSQL and Docker services remains necessary; no CI success is predicted or inherited.

### Critical command

```bash
npm test -- --runInBand --runTestsByPath \
  tests/unit/elements/memories/Memory.capacity.test.ts \
  tests/unit/elements/memories/Memory.retentionFailures.test.ts \
  tests/unit/elements/memories/MemoryManager.legacyRecovery.test.ts \
  tests/unit/elements/memories/Memory.test.ts \
  tests/unit/elements/memories/Memory.concurrent.test.ts \
  tests/unit/elements/memories/MemoryManager.saveLimits.test.ts \
  tests/security/secureYamlParser.languageSafety.test.ts \
  tests/unit/services/SerializationService.frontmatterSafety.test.ts \
  tests/unit/services/SerializationService.defaultSchemaSafety.test.ts \
  tests/unit/base/ElementFileOperations.frontmatterSecurity.test.ts \
  tests/unit/portfolio/EnhancedIndexManager.test.ts \
  tests/unit/cli/zipExtraction.test.ts \
  tests/unit/cli/zipExtraction.main-hotfix.test.ts
```

Independent source CODE and distinct DESIGN reviews cleared the resolved hotfix behavior, including the two reused-instance deserialize corrections. A separate read-only memory/YAML review cleared the raw-content flag, persistence/preview propagation, fingerprint and synchronous retention boundary. These source reviews do not waive the failed/incomplete runtime checks.

Safety's locked build setup still reports **41 vulnerabilities: 36 High and 5 Moderate**. This branch neither resolves nor accepts those findings. Dependency remediation remains separate; beta.3 release preparation is unchanged. No PR, beta merge, tag, release, registry publication, deployment or live-server action is authorized by this branch.
