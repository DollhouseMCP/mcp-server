# Beta.3 application runtime base: remediation plan

**Status: draft plan, not an image fix or vulnerability disposition.** The published beta.3 source and package remain unchanged. The two retained application images fail the High-severity scan gate and are not cleared for hosted deployment. This document proposes investigation and qualification; it does not select a replacement digest, approve an exception, change a pin, or assert that a rebuild will eliminate the findings.

## Evidence and scope

The exact beta source is `e89e6a4456d70e9559f707009e5aa02d7055d628`, tree `1c0cb2eed20841326660cdde230097bab1e9c60f`. [Docker Testing run 42489482818](https://github.com/DollhouseMCP/mcp-server/actions/runs/42489482818), attempt 1, produced native AMD64 and ARM64 application archives. Their artifact ZIPs, archives, source labels, config identities and 23 ordered DiffIDs per architecture were independently checked before the offline scan. The [machine-readable evidence](evidence/beta3-runtime-base-scan-2026-11-08.json) binds archive, report, scanner and database hashes; the raw reports and full graph receipts are retained in the qualification evidence outside this repository.

Grype 0.120.1 scanned the unchanged archives offline with the database built `2026-11-06T06:21:59Z`. Both reports returned exit 2 at the High threshold: **183 raw package matches each, including 62 High, 64 Medium, 11 Low and 46 Negligible; zero ignored matches**. The 62 High rows represent 20 distinct CVE IDs across 23 Debian binary packages, not 62 independent vulnerabilities. No application npm package appears among these High matches. Default scanner matching and its built-in kernel rules are disclosed in each raw report; zero ignored rows does not establish complete coverage. The findings below are scanner-reported package matches, not conclusions about exploitability or applicability.

| Debian source/package family | High rows per architecture | Raw report fix status | CVE IDs |
| --- | ---: | --- | --- |
| apt | 2 | fixed version reported: 3.0.4 | CVE-2026-109518 |
| util-linux | 36 | wont-fix | CVE-2026-76642, CVE-2026-78408, CVE-2026-78409, CVE-2026-78410 |
| gcc-14 | 6 | wont-fix | CVE-2026-102010, CVE-2026-95619 |
| glibc | 6 | wont-fix | CVE-2026-5435, CVE-2026-19499, CVE-2026-84243 |
| sqlite3 | 3 | wont-fix | CVE-2026-119373, CVE-2026-119374, CVE-2026-119379 |
| ncurses | 3 | wont-fix | CVE-2025-69720 |
| acl | 2 | wont-fix | CVE-2026-54369, CVE-2026-54370 |
| perl | 2 | wont-fix | CVE-2026-9538, CVE-2026-82560 |
| zlib | 2 | not-fixed | CVE-2026-76844, CVE-2026-85091 |

These statuses are the frozen scanner database's observations: 58 rows marked `wont-fix`, two `not-fixed`, and two `fixed`. They are not acceptance of residual risk or an independent statement of current Debian policy. A later assessment must retain raw findings and independently check advisory, package version, affected component and fix status.

## Proposed next investigation

1. Inspect authenticated Debian Trixie release metadata and signed package indexes for both architectures, source/version relationships and actual package publication dates. In particular, establish whether exact `apt` and `libapt-pkg7.0` 3.0.4 are available and appropriate before proposing a pin. The reported fix date alone does not establish package age or provenance; the applicable dependency-age policy and any needed decision remain separate gates.
2. Examine supported Trixie updates or backports and the remaining 58 `wont-fix` plus two `not-fixed` rows with upstream evidence. Assess whether packages can be removed without breaking required behavior and whether a supported base refresh changes the result. Do not suppress matches, relax thresholds, assume unfixed rows disappear, or promise a zero-High outcome. A distro/ABI switch requires a distinct compatibility and security assessment.
3. If evidence supports a concrete candidate, propose the smallest synchronized change to the `node-base` stages of `docker/Dockerfile` and `docker/Dockerfile.prebuilt`. Preserve the existing Node 24.22.1 index `sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea` and current pins until an alternative is independently justified. A new base digest requires its own immutable source, provenance, age and native-platform review; the existing exception does not automatically cover it. No npm manifest or lock change is proposed.
4. Review the full Dockerfile change and run the repository's required build, unit, security and Docker checks. Build exact final candidates on native AMD64 and ARM64, retain source/tree/config/archive/ordered-DiffID bindings, and run admitted scanner inputs against both exact images. Preserve raw matches and ignored entries, assess all residuals explicitly and retain real exit status. Validate npm/cache controls, runtime startup and the supported application/hosted migration behavior separately. Required CI, independent review and exact-image registry qualification remain gates.

The database snapshot and its age limit make these results time-bound. A future fresh database can change matches; historical scans or successful image builds alone cannot qualify final registry bytes. Any hosted deployment, backup, migration or live-host action requires its own authorization and safety evidence.
