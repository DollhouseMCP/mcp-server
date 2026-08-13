# Beta to Hosted HTTP Reconciliation Ledger (#2459)

## Frozen Baseline

| Ref | Commit |
| --- | --- |
| Hosted HTTP integration | `72cab247b1957976a203baee6ee73533106cc3eb` |
| Beta | `1d32a76e3d48147326e8b2a7c97961aca39e35b7` |
| Merge base | `4d5aed90d0705f0d04c1d4c9698adc98b7887d99` |
| Develop (reference only) | `8fb70780645e0c701844e535314b5efaff310df2` |
| Main (reference only) | `8695a0a11504696a181238efdbf8ed8a215a90a5` |

The frozen range contains 104 beta-only commits (83 non-merge commits and 21
merge commits) and 171 hosted-integration-only commits. The exact beta inventory
is reproducible with:

```bash
git rev-list --reverse 72cab247b1957976a203baee6ee73533106cc3eb..1d32a76e3d48147326e8b2a7c97961aca39e35b7
```

The reconciliation branch was created from the hosted tip. Beta was merged as a
second parent; neither history was rebased, squashed, or recreated. The 34
commits authored by `insomnolence` that were reachable at the freeze remain
reachable with their original hashes and authorship.

## Beta Integration Units

The 104 commits are organized by their first-parent integration units:

| Unit | Persistent purpose |
| --- | --- |
| Initial hosted-to-beta merge | Establish beta from hosted integration without rewriting hosted history |
| Beta branch CI coverage | Validate beta changes before promotion |
| PR #2278 | Security audit and console request hardening |
| PR #2277 | Manual beta release and VPS deployment workflows |
| PR #2298 | Main hotfix synchronization, permissive description policy, and portability fixes |
| PR #2310 | Allowlist CLI packaging and production `commander` dependency |
| PR #2311 | PostgreSQL admin/bootstrap URL behavior |
| PR #2324 | OAuth helper diagnostics and token handoff hardening |
| PRs #2336 and #2337 | Memory save-loss recovery, deletion probes, and anti-resurrection guards |
| PR #2340 | NVM launcher test isolation and client-config protection |
| PR #2312 | Web-console package assets |
| PRs #2345 and #2347 | Symlinked ancestor and canonical output containment |
| PR #2350 | `2.1.0-beta.1` package identity |
| PR #2352 | Prerelease publish-channel guards |
| PR #2437 | Agent `activates` slug resolution |
| PR #2470 | Agent lifecycle, ownership, orphan recovery, deadlock relief, memory policy, cache, and supply-chain hotfixes |

The remaining first-parent entries are supporting CI/model pinning, provenance
documentation, and merge commits for those units. Draft PR #1894 is unrelated
and excluded.

## Conflict Decisions

### Delivery, CI, and Package Identity

| Files | Decision | Rationale | Verification |
| --- | --- | --- | --- |
| `.github/workflows/build-artifacts.yml`, `codeql.yml`, `core-build-test.yml`, `docker-testing.yml` | Run on both `beta` and `codex/hosted-http-integration` in addition to stable branches | Hosted checks and beta promotion checks are both persistent delivery controls | Workflow validation tests; hosted PR checks |
| `.github/workflows/doc-validation.yml` | Keep the current pinned Sonnet model and concise rationale | Both branches selected the same model; integration wording is branch-neutral | Workflow validation tests |
| `CHANGELOG.md` | Keep the 2.1 beta entries ahead of the 2.0.36-2.0.38 hotfix history | Both release lines are historically valid | Changelog inspection |
| `manifest.json`, `server.json`, `src/generated/version.ts` | Preserve `2.1.0-beta.1` identity | Reconciliation is a 2.1 beta candidate, not a 2.0 stable package | Version consistency tests/build regeneration |
| `package.json`, `package-lock.json` | Preserve beta identity and reproducible `npm ci --ignore-scripts` setup; retain integration runtime-asset copier and authenticated E2E preflight | Keeps beta supply-chain policy without regressing the complete console package | Build, package verification, production-only install |
| `src/cli/allowlist.ts` | Add the Node shebang required by the package `bin` contract | Production-only installation showed npm linked the CLI correctly, but the operating system interpreted the compiled JavaScript as a shell script without the shebang | Package-bin unit test and installed `dollhouse-allowlist --help` |
| `scripts/verify-npm-package-assets.mjs` | Retain integration's complete console asset inventory | Integration contains the newer compiled console delivery contract | `npm run verify:package-assets` |

### OAuth Helper and Token Handoff

| Files | Decision | Rationale | Verification |
| --- | --- | --- | --- |
| `oauth-helper.mjs`, `src/handlers/GitHubAuthHandler.ts` | Retain integration implementation | Device code stays out of argv; encrypted, flow-bound handoff imports through the per-session filesystem or PostgreSQL token store. It already includes beta slow-down, cleanup, diagnostics, and stale plaintext removal | OAuth helper and handler unit tests |
| `tests/unit/auth/oauth-helper.test.ts`, `tests/unit/handlers/GitHubAuthHandler.test.ts` | Retain integration suites | They are supersets covering encrypted handoff, flow isolation, process races, diagnostics, and legacy cleanup | Focused Jest run |

### Collection Cache and Path Security

| Files | Decision | Rationale | Verification |
| --- | --- | --- | --- |
| `src/cache/CollectionCache.ts`, `src/di/registrars/CollectionServiceRegistrar.ts` | Combine integration shared-store backend with beta canonical `PathService` cache directory | Hosted PostgreSQL must not fall back to disk, while filesystem mode must not double-nest the canonical cache path | Collection cache unit/integration tests |
| `tests/unit/cache/CollectionCache.test.ts` | Keep shared-store tests and add canonical-directory coverage | Pins both behaviors | Focused Jest run |
| `src/collection/shared-pool/SharedPoolInstaller.ts` | Retain integration realpath containment, unique temporary files, and atomic rename | Beta's lexical path check would regress symlink protection and concurrent writes | Shared-pool tests/security audit |
| `src/utils/pathSecurity.ts` | Retain integration implementation and contract documentation | Beta differs only by dropping the boundary rationale | Path-security tests |
| `src/security/pathValidator.ts` | Canonicalize non-existent allowlist subtrees and requested paths through their nearest existing ancestor | Full HTTP verification exposed a pre-existing false denial when an alias such as macOS `/var` -> `/private/var` was cached before the user subtree existed. Resolving both sides through the same existing ancestor preserves symlink-escape protection without broadening the allowlist | PathValidator regression plus HTTP parity, CRUD, session, filesystem, backup, and cross-user leak suites |

### Agents, Ensembles, and MCP-AQL

| Files | Decision | Rationale | Verification |
| --- | --- | --- | --- |
| `src/elements/agents/AgentManager.ts` | Combine integration service typing with beta serialization locks, execution generations, ownership, and orphan recovery | Both hosted DI and beta lifecycle correctness are required | Agent unit/integration tests |
| `src/elements/ensembles/EnsembleManager.ts` | Retain integration's decomposed parser | It preserves maintainability and receives beta's permissive description limit through `SECURITY_LIMITS.MAX_DESCRIPTION_LENGTH` | Ensemble and description-limit tests |
| `src/handlers/mcp-aql/MCPAQLHandler.ts` | Combine hosted metrics/cache/session types with beta deadlock rate limiting and canonical agent identity; remove a duplicate memory-cleanup call/method produced by auto-merge | Keeps hosted observability and beta lifecycle protections without double cleanup | MCP-AQL and deadlock tests |
| `tests/unit/handlers/mcp-aql/MCPAQLHandler.test.ts`, `UnifiedEndpoint.test.ts` | Use the current sanitized memory-receipt mocks and canonical agent identity seam | Matches reconciled mutation and lifecycle contracts | Focused Jest run |

### Memory Persistence and Policy

| Files | Decision | Rationale | Verification |
| --- | --- | --- | --- |
| `src/elements/memories/MemoryManager.ts` | Combine integration structure-only YAML parsing with beta control-field validation, 256 KiB save/load parity, deletion probes, and preflight persistence | Historical prose must not brick append-only memories, while metadata/instructions and YAML structure remain protected | Memory save-limit and policy tests |
| `src/handlers/mcp-aql/MemorySaveHandler.ts` | Use integration per-user context capture/restoration plus beta deletion probes, anti-resurrection retries, authoritative-instance recovery, and sanitized mutation receipts | Prevents wrong-user writes, silent loss, deleted-memory resurrection, and response-time content bypass | Ledger, persistence, multi-user, shutdown tests |
| `src/storage/DatabaseMemoryStorageLayer.ts`, `MemoryMetadataExtractor.ts` | Use the memory-size ceiling and structure-only parser, then validate memory control fields | Large memories retain entry/metadata synchronization without exempting control fields | Database memory and extractor tests |
| `tests/integration/mcp-aql/memory-addentry-persistence.test.ts`, `tests/unit/elements/memories/MemoryManager.saveLimits.test.ts` | Keep beta non-echoing receipt, historical prose, trusted revalidation, flagged rendering, and control-field cases | These tests pin the intended policy boundary | Focused Jest run |

### YAML and Audit Security

| Files | Decision | Rationale | Verification |
| --- | --- | --- | --- |
| `src/security/contentValidator.ts`, `src/security/secureYamlParser.ts` | Retain PR #2472's bounded structure/content policy API | It supersedes beta's boolean bypass while preserving safe schema, Unicode, alias, depth, expanded-node, and scalar validation | Security parser suites and custom audit |
| `src/security/audit/SecurityAuditor.ts` | Retain the current matcher and add beta's project-relative candidate for absolute scanner paths | Suppressions work from local and CI paths without broadening rule scope | Auditor unit tests |
| `tests/security/contentValidator.test.ts`, `tests/unit/security/audit/SecurityAuditor.test.ts` | Keep semantic description constant and the stricter isolated auditor configuration | Matches the reconciled policy and avoids unrelated scanners masking the assertion | Focused Jest run |

### Web Console

| Files | Decision | Rationale | Verification |
| --- | --- | --- | --- |
| `src/web-console/modules/integrations/IntegrationService.ts` | Retain provider-generic encryption contexts and provider dispatch; add beta security events and constant-time comparison | Avoids restoring GitHub-only assumptions while keeping beta audit and timing hardening | Integration module unit/E2E tests |
| `src/web-console/services/runtime/PostgresRuntimeSessionControlStore.ts` | Import both `notExists` and the `SQL` type | Both branches added required query behavior | Runtime-session store tests |
| `tests/integration/web-console-e2e/setup/globalSetup.ts` | Use structured debug output | Equivalent behavior with clearer diagnostics | Console E2E preflight |

## Auto-Merged Areas Requiring Explicit Review

Git did not report conflicts for several overlapping changes. They remain part
of the semantic review and verification:

- Beta deploy/publish workflows and channel guards.
- `commander` production dependency and allowlist/admin database CLI behavior.
- Agent state-store and execution-handler ownership changes.
- Memory entry synchronization, deletion probes, and database schema behavior.
- Console normalization, audit events, allowlist stores, and packaged assets.
- Supply-chain install policy and security suppressions.
- PostgreSQL migrations and migration metadata ordering.
- Permission-hook activation warnings across both clean CI hosts and developer machines with a hook already installed.

## Verification Record

| Check | Result |
| --- | --- |
| Conflict markers and `git diff --check` | Passed |
| TypeScript build | Passed |
| Lint and script typecheck | Passed |
| Focused reconciliation suites | Passed: 606 focused unit/security tests; 71 focused integration tests with 3 PostgreSQL-dependent skips; 182 workflow/package-policy tests; 115 HTTP transport/isolation tests |
| Full unit suite | 12,874 tests passed. Two BuildInfo timing/cache suites failed only under end-of-run resource contention and passed independently (24 tests); no functional assertion remained failing |
| Full integration suite | Passed: 123 suites, 2,462 tests; 2 suites / 155 tests skipped because PostgreSQL and external GitHub credentials were unavailable |
| Security audit | Passed with zero critical/high findings; existing medium/low baseline observations remain tracked |
| Package asset check | Passed |
| Production-only install check | Passed: packed `2.1.0-beta.1`, installed with dev dependencies omitted, verified `commander@13.1.0`, and executed `dollhouse-allowlist --help` from the installed package |
| Hosted deployment script tests | Passed, including render, install, update, rollback, remote, and retry paths |
| PostgreSQL migration inventory | Passed: 45 journal entries match 45 contiguous SQL migrations through `0044` |
| Hosted container/database checks | Containerized permission-hook harness passed. PostgreSQL was unavailable locally; database/RLS suites skipped and remain required in CI |
| Hosted deployment dry run | Passed for a distinct disposable instance name; no files, images, containers, clones, or HTTP requests were changed |
| GitHub quality/security checks | Pending |

## Post-Reconciliation Corrective Audit (#2489)

The audit compared the frozen hosted and beta parents with hosted integration at
`7385761de575a45c86b3f60212c259f1d0c4dc38`. The parent trees differed in
462 files. The reconciled tree retained the hosted version of 272 files, selected
the beta version of 123 files, and produced an explicit hybrid in 67 files.

The 123 beta-selected files break down into 43 runtime/security files, 46 tests,
14 workflows, 11 packaging or container files, six documentation files, and
three package/audit configuration files. The runtime/security review produced
the following classifications:

| Classification | Count | Decision |
| --- | ---: | --- |
| Intentional beta behavior | 32 | Retain token and TOTP failure auditing, canonical cache paths, admin-role CLI database access, agent execution ownership and orphan recovery, permissive description limits, memory control-field validation and safe rendering, template path hardening, console request normalization, and secret-crypto failure auditing |
| No runtime effect | 9 | Retain comment-only or trailing-newline differences; they do not change emitted behavior |
| Beta package identity | 1 | Retain `2.1.0-beta.1` generated identity until the normal release build regenerates it |
| Confirmed policy regression | 1 | Correct `src/security/audit/config/security-suppressions.json` as described below |

The workflow and packaging selections are the beta CI, release-channel,
artifact, portability, and manually dispatched alpha-deployment controls already
recorded as persistent beta integration units. Hosted-specific OAuth/DCR,
web-console composition, database migrations, storage ownership, and deployment
implementation remained hosted-selected or explicit hybrids.

### Suppression-policy correction

The merge reintroduced eleven first-party directory globs into
`security-suppressions.json`. Those globs covered future files in web-console
platform/services/stores/UI, embedded auth, context, database, DI registrars,
paths, state, and storage. It also restored a blanket `rule: '*'` suppression
for `src/web-console/ui/vendor/**/*` in `suppressions.ts`.

#2489 removes those broad entries while retaining the existing exact-file,
reasoned suppressions. Vendored JavaScript remains excluded only through the
three exact files inventoried by the vendor manifest. Regression tests now fail
if a first-party source-directory glob is added to the custom policy or if the
blanket vendored-directory rule returns.

Running the stricter policy exposed fourteen medium Unicode findings. Eleven
were reviewed as exact OAuth or normalized-console boundaries and now carry
file-specific DMCP-SEC-004 reasons. Three human-visible boundaries required
code fixes: the TOTP enrollment label, public-DCR `client_name`, and BYO
integration descriptor `display_name`/`category`. TOTP labels use the existing
security normalization, descriptor display values use NFC without cross-script
folding and reject directional or zero-width characters, DCR client names apply
the same targeted rejection before NFC normalization, and opaque protocol values
remain byte-exact. A test-only rate-limit finding is suppressed only for its exact
in-process integration harness. Eight low integration-subsystem audit-logging
observations remain visible and are tracked in #2490.

### Corrective verification

| Check | Result |
| --- | --- |
| Build and script typecheck | Passed |
| Lint and `git diff --check` | Passed |
| Focused suppression, DCR, TOTP, and descriptor tests | Passed: 111 tests |
| Broader embedded-auth and descriptor/store tests | Passed: 491 tests |
| Strict security audit (`--fail-on-high`) | Passed: zero critical, high, or medium findings; eight low observations tracked in #2490 |
| Full unit suite | 582 suites / 12,921 tests passed before four unrelated suites timed out under prolonged single-process resource contention; all four suites passed independently |
| Frozen-parent ancestry | Passed: both frozen parents remain ancestors and all 34 Todd/Insomnolence-authored commits from the hosted parent remain reachable |
| GitHub quality/security checks | Pending |

The corrective PR must not be merged without explicit approval from Mick. Any
later promotion must use merge commits so both original histories remain
visible.
