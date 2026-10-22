# Beta.3 dependency remediation — 2026-10-22 verification in progress

The latest reviewed source and reconciled lock now audit clean: root and standalone Safety each have **0 critical, 0 high, 0 moderate** findings (both exit 0). The `gray-matter` and `install-mcp` dependencies are replaced by bounded, licensed source adapters; the vulnerable consumer chains are absent. The hosted font regression and permission fixture isolation are fixed. This remains a draft; no release or deployment is authorized by these results.

The direct, user-authorized `npm install --package-lock-only ...` attempt was rejected by the local PreToolUse hook (`Dangerous command pattern: npm install *`). The staged files were restored immediately. A separately reviewed **declarative file reconciliation**, using existing package records and no dependency resolver, then repaired the lock. This is not npm regeneration. Root lock SHA-256 is `cc268f6a2c365a3fbd742a85ba1bd16ba110776199ee8b8c9487fd5e891c530c`; all retained package versions and integrity values are unchanged. A fresh script-disabled ci, strict actual/virtual raw/override/peer edge checks, npm ls, signatures and full build passed.

Current validation: root signatures **880 / 109 attestations**; Safety **512 / 56**. The full unit wave finished in 587.52 seconds with **18,550 passed, zero assertion failures, 17 skipped**, but exits **1** because `tests/unit/cli/cliAuthStorage.test.ts` could not run after a Jest worker out-of-memory crash (801 passed suites, one failed, one skipped). That file will receive one isolated run with unchanged budgets after integration. Performance passed **10 suites / 120 tests**, exit 0. The full **199-file integration inventory is currently running against a newly created, owned PostgreSQL 17 cluster**, with required-PG flags and an explicit Ubuntu VM Docker context. No terminal integration totals are claimed yet.

An override-free, local packed-artifact consumer installed successfully and audits **0**, with all **391 raw/peer edges** valid in both actual and virtual trees. It uses the actual local server and unpublished Safety1.0.6 tarballs, both MIT notices, and one explicitly reviewed aged parent `express-rate-limit@8.5.1` admitted by SDK's `^8.2.1` range. This is exact-artifact reproducibility, not a fresh registry resolution guarantee. Its `npm audit signatures` command exits 1 because npm tries to look up unpublished local Safety1.0.6 in the registry; the new registry parent's signature was verified directly against npm's official key, and all other registry records match the signature-verified root graph. This command limitation is retained, not reported as a pass.

The final report and sanitized per-file integration evidence will replace this progress note after the active run and owned-service cleanup complete. The material below is the **superseded October21 snapshot**, retained temporarily to preserve the earlier failed/incomplete verification history; its uses of “current” refer to that historical candidate only.

---

# Beta.3 dependency remediation — 2026-10-21

Status: **draft backup only; security remediation remains incomplete**. The root audit still has 37 high and 7 moderate affected package entries. Standalone Safety is clean. This branch is not release or deployment clearance.

Base and PR target: `beta` at `d0278ad58d962a3386be34379475c40600c141a1`. Backup branch: `fix/beta3-dependency-findings`. No main-only commits were merged or cherry-picked; [the separate inventory](beta3-main-only-commits-2026-10-21.md) lists all 20. The separate release branch is unchanged. No publication, tag, release, SSH or deployment was performed.

## Literal audit before and after

| Graph / exact command | Before high | Before moderate | Current high | Current moderate | Current critical | Affected package entries, before → current | Current exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Root workspace: `npm audit --json` | 38 | 7 | 37 | 7 | 0 | 45 → 44 | 1 |
| Standalone Safety: `npm audit --json --workspaces=false` from `packages/safety` | 36 | 5 | 0 | 0 | 0 | 41 → 0 | 0 |

The preserved earlier isolated `install-mcp@1.10.2` lock-only consumer reproduction reported 2 high, 0 moderate and 1 critical affected package entries (3 total), exit 1. It was not rerun or represented as a fresh consumer installation. Root and Safety were freshly audited during this verification. Counts include propagated package findings, not independent vulnerabilities: the root residuals represent two advisory IDs; the earlier installer consumer graph contains 12 underlying tar advisories. The original “Safety findings” were emitted by `cd packages/safety && npm ci --ignore-scripts --workspaces=false && npm run build`; they were npm findings, not a separate scanner.

[Complete before inventory](evidence/beta3-dependency-findings-2026-10-21-before.json) and [complete current inventory and raw audits](evidence/beta3-dependency-findings-2026-10-21-after.json) retain affected package versions/nodes, advisory objects, dependency routes, npm-suggested fixes and current input hashes. Findings are not suppressed, allowlisted or waived.

## Changes prepared

- Root and Safety Jest are pinned to `30.3.0`; TypeScript-ESLint parser/plugin to `8.48.1`; Safety Jest types to `30.0.0`. The standalone Safety lock resolves these parent upgrades and eliminates its affected paths. The root lock still contains stale nested Safety tooling.
- Safety source is prepared as `1.0.6`, with the root dependency floor `^1.0.6`, to avoid reusing published `1.0.5` for changed metadata. Safety 1.0.6 has not been published.
- Hono is overridden to aged `4.13.11`, the smallest patched release for GHSA-5r4p-p66f-jhc7. The root SDK is exactly `1.32.0`. SDK/Hono advisory rows are absent from the fresh audit.
- Existing js-yaml 3.15.2 consumers receive a scoped intended `argparse@2.0.1` override; forcing js-yaml 4 would break gray-matter's `safeLoad` API. There is no patched published sprintf-js leaf release. The current root lock has not realized the argparse replacement.
- `ts-jest-resolver@2.0.1` receives an intended child override to aged `jest-resolve@30.3.0`; its unused runtime/type-only dependency otherwise retains a Jest 29 braces path. This override is prepared in the manifest but unresolved in the current root lock.
- The failed bundling experiment is removed from the manifest. The pre-repair root lock still records root `bundleDependencies: ["gray-matter", "install-mcp"]` and 55 derived `inBundle` flags; this manifest/lock discrepancy is part of the blocked draft. Bundling is not a downstream fix: npm validates bundled children using upstream raw ranges, which request argparse 1 and tar 6. No third-party metadata is patched or vendored.

## Current lock identity and remaining root findings

The available root lock is SHA-256 `f677d4d2405a19ef8c5b32c6826c983acc4e4a988272202dd111cc18ac4271fe`; standalone Safety is `73c2c4aae0ebd9a5c405bf8e0b715a29eb328ace1c483d3bb54d8c4ad5f50c5c`. This root hash equals the corrected helper's recorded **pre-repair input**, and the preserved older `/tmp/beta3-lock-run2.log` receipt. The corrected command file is SHA-256 `ca3643136be3047391fdf4cd85d376dc3f7d88889152889b3a341f78b4e4c40f`; helper `9ccf2fb102ed4498884d9e142250613f494a240935395148a776b7a18b11fb67`. No corrected composition receipt or pending recovery journal exists locally. Therefore the reported newer successful execution cannot be corroborated by the current files. This describes available local evidence, not what the user did elsewhere.

The fresh root audit still reports:

- **GHSA-vfj7-8cjw-p6xm**, braces, high: stale nested Safety Jest 29/TypeScript-ESLint 7 graph and `ts-jest-resolver -> jest-resolve@29.7.0` retain affected braces/micromatch parent routes.
- **GHSA-hp3w-g68c-fv3c**, sprintf-js, moderate: gray-matter and `@istanbuljs/load-nyc-config` retain nested `argparse@1.0.10 -> sprintf-js@1.0.3`. A fresh physical root installation confirms both argparse 1 copies and sprintf 1 remain.

The already prepared targeted resolver reconstruction is intended to remove these paths; its output remains unverified. Merely declaring the overrides has not fixed the checked-in graph. There is no patched braces or sprintf-js leaf release to bump directly in the reviewed registry snapshot. The corrected Jarvis-only helper preserves exactly 133 stale input records in evidence, clears 55 introduced bundle flags and asks npm to rebuild exact existing Jest/parser/plugin dependencies under the age cutoff. It preserves the completed standalone Safety lock and composes only the approved SDK record. A successful real resolver output, independent lock review, fresh installation/audits and final-candidate tests are still required. The existing helper is bound to HEAD `d0278ad`; after the requested backup commit it is historical and will reject the changed HEAD. A future run needs a fresh reviewed recipe bound to that backup commit, with effective-graph postconditions; do not run the old command as a current handoff. Codex has not executed `npm install`, an equivalent resolver, or a hook bypass.

## Dependency age and provenance

The aged lane cutoff is `2026-09-30T00:00:00Z`. Exact SDK `1.32.0`, published `2026-10-02T17:32:51.427Z`, is the sole approved exception under [#2452](https://github.com/DollhouseMCP/mcp-server/issues/2452#issuecomment-6327546083); its 21-day date is October 23 at the same UTC time. Mick approved that exact version through Jarvis's voice relay. The exact current lock hashes match the prior reviewed candidate. Its official registry publication-time/integrity review covered 401 affected after-records / 204 unique package-version pairs; it is not a new full-lock age proof or successful resolution claim. There is exactly one SDK node at 1.32.0, composed with unchanged dependency/peer/engine declarations and exact registry artifact integrity. The exception does not waive other young versions, vulnerabilities or checks. Optional SDK element-budget/audience controls remain off by default.

## Downstream consumer blockers and concrete fix

Root overrides do not propagate to consumers. Two production dependency chains remain blocked:

1. **#2668:** `install-mcp@1.10.2 -> giget@1.2.5 -> tar@6.2.1`. Official registry latest install-mcp is still 1.10.2; no direct dependency bump is currently available. Investigation of the published entry and upstream source found no giget import/use. The smallest concrete upstream patch is deleting the unused `"giget": "^1.2.5"` dependency, refreshing its Bun lock through an authorized resolver, validating build/tests/client behavior, and publishing a patch. This project can then bump to that fixed release after provenance/age review and verify a clean isolated packaged consumer. No upstream PR or publication was performed. Replacing the dependency locally would require preserving 14 clients' paths and JSON/YAML/TOML schemas, so it is not a small safe rewrite in this dependency task. Absence of an observed runtime call does not waive the vulnerable installed graph.
2. `gray-matter@4.0.3 -> js-yaml@3.15.2 -> argparse@1.0.10 -> sprintf-js@1.0.3`, affected by GHSA-hp3w-g68c-fv3c. Official package metadata confirms these raw ranges. The repository's scoped argparse 2 override cannot fix a packaged consumer. A compatible upstream parent release or a separately reviewed replacement is required, followed by isolated packed-artifact verification. This consumer chain has not received a fresh standalone audit in this run; the parent/leaf metadata and vulnerability are recorded independently.

No root audit result can establish downstream consumer clearance. There is no current consumer override, bundle, vendor patch or risk acceptance being claimed.

## Fresh verification of the available candidate

The validation source was copied from all current tracked and untracked worktree files, including the modified manifests/locks, and initialized with the same base objects. It is not an old HEAD-only checkout. The evidence directory is `/Users/mick/.codex/evidence/beta3-dependency-findings-phase2-20261021/final-candidate-20261021`; command logs, exit-result JSON, source hashes and independent review receipts are preserved there. Build-generated files remain in that isolated source copy.

| Check | Literal result |
| --- | --- |
| Fresh root `npm ci --ignore-scripts --no-audit --no-fund` | Exit 0; 1,009 packages added |
| `npm run build` | Exit 0; Safety TypeScript, root TypeScript and runtime assets pass |
| Original standalone Safety ci/build inside prebuild | Exit 0; 515 packages added, 516 audited, zero vulnerabilities |
| Root `npm audit signatures` before standalone build replaces workspace node_modules | Exit 0; 1,008 verified signatures, 113 verified attestations |
| Safety `npm audit signatures --workspaces=false` | Exit 0; 512 verified signatures, 56 verified attestations |

Signature verification is registry provenance evidence, not vulnerability clearance. The root build runs standalone Safety setup, replacing its physical tooling with the clean Safety graph; this does not repair the root virtual lock's stale nodes.

## Repository full-suite stages — failed / incomplete

The repository defines `test:all` as default unit/Safety, performance and integration stages. Each stage was launched independently with `CI=true` and JSON result paths so an earlier failure did not short-circuit the remaining stages. Repository assertions/timeouts are unchanged. Live-credential E2E and browser suites have separate commands and are not part of `test:all`. **The complete full suite did not finish: required PostgreSQL coverage was unavailable.**

| Stage | Literal exit / disposition | Suites | Tests |
| --- | --- | --- | --- |
| `npm test` (includes Safety) | 1; failed | 798 passed, 2 failed, 1 skipped; 801 total | 18,526 passed, 2 failed, 17 skipped; 18,545 total |
| `npm run test:performance` | 0; passed | 10 passed | 120 passed |
| `npm run test:integration` | Wrapper 0 **after scoped SIGINT; interrupted, not passed** | 11 completed failed files observed; full totals unavailable | Full assertion totals unavailable; no Jest JSON report |
| One focused two-file rerun | 1; failed | 1 passed, 1 failed | 24 passed, 1 failed; 25 total |

The full unit wave failed in two assertions: `tests/unit/web/permissionRoutes.test.ts:679` expected one decision but observed an additional live tool command reaching the advertised test permission server; `tests/unit/auth/embedded-as/EmbeddedAuthorizationServer.assets.test.ts:24` expected `/fonts.css` HTTP 200 and received 404, although both source and built asset files exist. No unchanged-base comparison or dependency-causality conclusion is claimed.

The single quiet two-file rerun passed the permission router tests; the hosted auth `/fonts.css` 404 persisted. This focused result does not replace the failed full-unit wave. No further test wave, timeout adjustment or assertion weakening was used. Unit skips include existing platform/timing, Docker image, rate-limit and device-poll cases; their sanitized names are retained in the evidence JSON.

Integration ran for **2,000.07 seconds (33m20s)** before a scoped graceful SIGINT to its verified owned Jest process. PostgreSQL setup was unavailable; some DB suites skipped, but other required-PG suites failed. At the 25- and 30-minute checks, the log/file progress stopped; the worker remained idle with stable memory. A bounded source/cache/socket/owned-process check supported repeated unavailable-prerequisite SQL assertions/cleanup timeouts. The latest transform inferred `MemoryHeadInvalidationRuns.test.ts`, whose source explicitly requires real PostgreSQL with no skip/fallback. This is not proof of a JavaScript deadlock. No host service was signaled or provisioned. Cleanup found no remaining owned fixture processes.

The npm/Jest wrapper returned literal **0 following SIGINT**, and produced no integration JSON totals. This is **partial/interrupted verification**, not a successful test exit or completed coverage. Eleven failed file records were observed before interruption: ten database suites and `permission-hook-docker.test.ts`; their paths are preserved in the sanitized evidence. Passed/skipped/total integration counts must not be invented. Required service coverage must be rerun in a prepared environment before release consideration.

[Draft backup PR #3129](https://github.com/DollhouseMCP/mcp-server/pull/3129) records these blockers. Raw test logs and live permission command payloads remain outside the repository. Root lock reconstruction, both production consumer dependency fixes, the persistent asset test failure and complete final-candidate verification remain unresolved.
