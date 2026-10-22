# Beta.3 dependency remediation — 2026-10-22

Root, standalone Safety and the override-free local artifact consumer now audit **0 critical, 0 high, 0 moderate** findings. The final full unit run passes. All 199 integration files have successful executed evidence across the original run and one corrected Docker-file rerun. **The PR remains a draft into beta; these results do not publish or deploy anything.**

## Audit results

| Graph | Before high | Before moderate | Current critical / high / moderate | Current exit |
| --- | ---: | ---: | --- | ---: |
| Root workspace | 38 | 7 | 0 / 0 / 0 | 0 |
| Standalone Safety | 36 | 5 | 0 / 0 / 0 | 0 |
| Exact local artifact consumer | Different historical graph; see note | — | 0 / 0 / 0 | 0 |

The earlier isolated install-mcp consumer reproduction had 2 high and 1 critical affected package entries. It is a different graph, not an invented before-count for the complete server artifact. Counts are affected package entries, not independent advisories. [Complete original inventory](evidence/beta3-dependency-findings-2026-10-21-before.json), [current audits and verification evidence](evidence/beta3-dependency-findings-2026-10-21-after.json), and [all 199 integration file results](evidence/beta3-dependency-findings-2026-10-22-integration.json) are committed. No findings are suppressed, allowlisted or waived.

## Dependency and consumer corrections

- Root and Safety tooling use Jest 30.3.0 and TypeScript-ESLint 8.48.1; Safety Jest types use 30.0.0. Safety is prepared as 1.0.6 with root floor ^1.0.6; it remains unpublished.
- Hono 4.13.11 and exact SDK 1.32.0 remain selected. The sole age exception is SDK 1.32.0 under [#2452](https://github.com/DollhouseMCP/mcp-server/issues/2452#issuecomment-6327546083). The aged cutoff is 2026-09-30T00:00:00Z; SDK was published2026-10-02T17:32:51.427Z, reaching21 days on October 23 at that UTC time. Optional SDK budget/audience controls remain off by default.
- Removed gray-matter and install-mcp, plus their obsolete overrides. Bounded source adapters use the existing direct js-yaml/smol-toml dependencies. Frontmatter retains the used parsing/stringifying contract and secure wrapper engines. Installation preserves supported client paths/schemas, unrelated settings, managed symlinks and atomic writes; invalid configs fail without replacement. Both source packages' official tarball integrity and MIT notices were independently reviewed; the notices ship in the package.
- Gray-matter→js-yaml 3→argparse 1→sprintf-js and install-mcp→giget→tar 6 are absent. No third-party package manifest was patched, and no bundled dependency workaround remains. Stale Safety tooling and ts-jest-resolver's Jest 29 closure are removed; current overrides are effective.

## Direct npm rejection and reviewed lock reconciliation

The user-authorized direct command was attempted visibly:

```sh
npm install --package-lock-only --ignore-scripts --no-audit --no-fund --save-dev --save-exact --prefer-dedupe --workspaces --include-workspace-root --before=2026-09-30T00:00:00Z jest@30.3.0 @typescript-eslint/parser@8.48.1 @typescript-eslint/eslint-plugin@8.48.1
```

The local PreToolUse hook rejected it: **`Dangerous command pattern: npm install *`**. The staged SDK/lock files were restored immediately; standalone Safety files were verified unchanged. No alternate installer, hidden resolver or hook disable was used.

A separately authorized and independently reviewed **declarative file reconciliation** then repaired the lock; this is not npm regeneration. All retained package versions, URLs and integrity values are unchanged. The transformation reconciled root metadata, removed 144 obsolete paths, cleared the 25 surviving bundle flags (55 existed before deleted records), and restored 30 original Safety ESLint 8/Node20-types closure records that the historical broad staging packet had over-removed. It retained 981 package records. Read-only Arborist validation checked all ordinary, override and peer edges; fresh ci and npm ls independently confirmed the installed graph. Root lock SHA-256 is `cc268f6a2c365a3fbd742a85ba1bd16ba110776199ee8b8c9487fd5e891c530c`; standalone Safety remains `73c2c4aae0ebd9a5c405bf8e0b715a29eb328ace1c483d3bb54d8c4ad5f50c5c`.

## Fresh installation, provenance and package proof

| Check | Literal result |
| --- | --- |
| Fresh root ci, lifecycle scripts disabled | Exit 0; 881 packages added |
| Root virtual / actual graph | 981 nodes/2067 edges and 883 nodes/2058 edges; 0 invalid required edges, 0 version/path mismatches |
| Root npm ls / root and Safety audits | Exit 0 |
| Full Safety/server TypeScript build and runtime assets | Exit 0 |
| Root registry signatures | Exit 0; 880 verified signatures  / 109 attestations |
| Standalone Safety registry signatures | Exit 0; 512  / 56 |
| Package runtime-asset verifier | Exit 0; complete UI/assets |
| Override-free local artifact consumer ci / audit / npm ls | Exit 0; 234 packages added; 0 findings |
| Consumer virtual and actual graphs | Each235 nodes/391raw+peer edges; 0 invalid required edges or version/path mismatches |
| Compiled packed adapters | YAML roundtrip and all 14 adapted client configurations pass; both MIT notices included |

The consumer fixture installs the actual local server and Safety 1.0.6 tarballs. A raw consumer check first rejected express-rate-limit 8.3.1→exact ip-address 10.1.0: that legitimate raw leaf has1high/1moderate affected entries and five underlying advisories. The separately reviewed aged parent8.5.1 (publishedMay 6) is admitted by SDK's raw ^8.2.1 range and permits the existing patched ip-address 10.7.1. This is the fixture's only new registry version; main lock versions are unchanged. The fixture has no overrides and proves a clean, raw-range-compatible closure for these exact artifacts, **not a fresh registry resolution guarantee**.

Consumer `npm audit signatures` literally exits1 (`ETARGET`) because npm looks up unpublished local Safety 1.0.6 in the registry. It is not reported as a pass. Both local tarball SHA-512 values match the pack receipts; every other registry version/SRI matches the signature-verified root graph. The sole consumer-only parent's official registry signature was additionally verified cryptographically against npm's official key, and its downloaded archive matches registry SHA-512/SHA-1.

## Final tests and retained failure history

Repository assertions, heap limits, concurrency and timeouts are unchanged. Full stages ran independently with CI=true; integration required real PostgreSQL and used an explicit Ubuntu VM Docker context.

| Run | Exit | Suites | Tests |
| --- | ---: | --- | --- |
| Initial full unit | 1 | 801 passed, 1 OOM failed, 1 skipped; 803 total | 18,550 passed, 0 assertion failures, 17 skipped; 18,567 discovered |
| Original CLI-file diagnostic | 1 | 1 OOM failed | 0 executed |
| CLI after fixture correction | 0 | 1 passed | 8 passed |
| **Final full unit confirmation** | **0** | **802 passed, 1 skipped; 803 total** | **18,558 passed, 0 failed, 17 skipped; 18,575 total** |
| Performance | 0 | 10 passed | 120 passed |
| Complete original integration | 1 | 198 passed, 1Docker-fixture failed; 199 total | 4,125 passed, 8 failed, 24 skipped; 4,157 total |
| Corrected Docker integration file | 0 | 1 passed | The same 8 cases passed |
| Integration case union across recorded runs | Not a single new full invocation | 199 files with successful executed evidence | 4,133 passed, 0 failed, 24 skipped |

The initial full unit run took 587.52 seconds. Its CLI file and one156.22-second isolated diagnostic exhausted the 4 GB V8 heap before reporting assertions. A boolean-only reproduction proved the negative test inherited cached parsed database URLs: deleting only process.env's app URL still resolved a large Drizzle handle rather than rejecting. The reviewed fixture now clears and restores both parsed and process URL fields, preserving the exact error assertion. Its8 tests passed in 0.55 seconds; the unchanged full unit command then passed in 552.95 seconds. No speculative memory tuning was used. Fonts and permission-router tests also pass in the full run.

The full integration invocation completed in 953.76 seconds with all 199 file results. Every PostgreSQL suite passed. Docker's cached setup layer lacked curl/jq and the hookrunner account because an initial `|| true` had swallowed setup failure. Removing that misplaced fallback preserves mandatory package/user setup and the final nonroot ownership step. A fresh build succeeded and runtime uid/gid 1001 was verified; the one focused file then passed8 / 8 with unchanged budgets. The [per-file ledger](evidence/beta3-dependency-findings-2026-10-22-integration.json) preserves the failed original wave, matches actual Docker case identities before replacement, and derives the union from actual assertion records. **The original full integration exit 1 is not relabeled exit 0.**

## Isolation, source identity and cleanup

Verification used a fresh copy of current source with isolated installs. After ci/build/audits/signatures, only the two reviewed test-fixture files changed; 2,583 source/test/script/package paths were compared with the final source. Non-generated bytes match. The build's generated version file differs only in BUILD_TIMESTAMP; production logic and all four dependency input hashes are unchanged.

PostgreSQL 17 used a new owned tmpfs cluster reached only through an owned loopback SSH forward to the development VM. Global teardown removed the dedicated test database and test directory. Cluster/container/forward identities were checked before cleanup; the owned container, inspection containers, forward process, listener and temporary fixture/preflight image tags are verified absent. No shared database, daemon configuration, global cache prune or host SSH server was changed. Raw logs and tool ingress payloads remain outside the repository; committed evidence contains sanitized aggregates and proof hashes.

[Draft PR #3129](https://github.com/DollhouseMCP/mcp-server/pull/3129) targets beta at `d0278ad58d962a3386be34379475c40600c141a1`. [Main-only commit inventory](beta3-main-only-commits-2026-10-21.md) is unchanged; none was merged. The October 21 failed/incomplete snapshot remains in Git history at `085d3a07182bcf3c1d4c322d82cce3f9a2b7853d`. Safety publication and release approval remain separate prerequisites. No publication, tag, release, merge or deployment occurred.
