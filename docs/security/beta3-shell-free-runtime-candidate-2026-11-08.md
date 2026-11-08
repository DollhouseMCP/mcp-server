# Beta.3 shell-free runtime candidate — qualification pending

This draft uses the Google distroless Node 24 Debian 13 multi-platform index `sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba`; AMD manifest `sha256:1dfdd0613f3163fe913861ded2540584525b281d65541749726c7d3906382c06`, ARM manifest `sha256:e87b0071f3ba73d76f841f5d3e013d73a9cfaed916dcb7274d2dcd06d7419a3f`. It retains the Debian builder, Node 24.22.1 builder toolchain and migration target; the proposed final runtime supplies Node 24.22.2 without a shell or global npm. The two builder stages propose apt and libapt-pkg7.0 3.0.4; native signed-index verification and builds remain required. Hosted graceful-stop requires `node` on PATH, and migrations continue in the builder target. Runtime package-manager or shell-dependent operations are unavailable in the final image; any further user-facing compatibility impact must be assessed before adoption.

The base was uploaded 2026-10-31T23:43:33Z. Its age is below the 21-day threshold on 2026-11-08; the existing Node 24.22.1 exception does not cover it. The exact index keyless signature was verified with the expected Google identity, issuer, certificate and transparency checks. Registry metadata and an SPDX attestation are retained; the attestation failed schema verification and is metadata only, not verified SBOM provenance. Source provenance and any age decision remain open. Candidate native addon compatibility, permissions, writable directories, HTTP health, signal/drain and both native architectures require fresh evidence. Source changes or a green badge do not prove those properties.

## Preliminary base-only scan

A single offline scan of the selected AMD64 base, before adding the application, reported **13 High matches across seven CVEs**, 22 Medium, three Low and seven Negligible, with zero Critical and zero ignored matches. The High rows comprise two zlib, eight GCC runtime and three glibc matches. The IDs are CVE-2026-76844, CVE-2026-85091, CVE-2026-102010, CVE-2026-95619, CVE-2026-19499, CVE-2026-5435 and CVE-2026-84243. This is a base-only observation against the frozen database, not a final-image scan, waiver or claim of a zero-High outcome. The [base scan summary](evidence/beta3-distroless-amd64-base-scan-2026-11-08.json) preserves scanner, database, archive and finding bindings; the [earlier runtime-facts receipt](evidence/beta3-cve-runtime-facts-2026-11-08.json) is preliminary. The [observed Debian package inventory](evidence/beta3-distroless-amd64-observed-dpkg-2026-11-08.json) records 14 status.d entries from the exact retained AMD64 base archive; it is not an inventory of Node-bundled components or the final application image, so an absent High match does not establish bundled-code absence. Its SPDX statement is metadata only and not verified provenance. Candidate selection and each residual's applicability, remediation and disposition remain open.

The following **base-only** entries were reviewed on 2026-11-08 for evidence completeness, not accepted as risks. Next review is due 2026-11-09. Each named package is present in the scanned AMD64 base; runtime use, applicability and final-image presence remain UNKNOWN. The frozen database supplied no fixed version for any row; its `wont-fix` or `not-fixed` state is the reason each remains unresolved, not an independent upstream conclusion.

| CVE | Observed base packages | Frozen status | Runtime use / disposition |
| --- | --- | --- | --- |
| CVE-2026-102010 | `gcc-14-base`, `libgcc-s1`, `libgomp1`, `libstdc++6` | wont-fix | UNKNOWN; review required |
| CVE-2026-95619 | `gcc-14-base`, `libgcc-s1`, `libgomp1`, `libstdc++6` | wont-fix | UNKNOWN; review required |
| CVE-2026-19499 | `libc6` | wont-fix | UNKNOWN; review required |
| CVE-2026-5435 | `libc6` | wont-fix | UNKNOWN; review required |
| CVE-2026-84243 | `libc6` | wont-fix | UNKNOWN; review required |
| CVE-2026-76844 | `zlib1g` | not-fixed | UNKNOWN; review required |
| CVE-2026-85091 | `zlib1g` | not-fixed | UNKNOWN; review required |

## Historical High finding ledger

Reviewed 2026-11-08 against the retained [e89 scan evidence](evidence/beta3-runtime-base-scan-2026-11-08.json). Each row names a historical package match and the scanner database's fix state. Presence in the candidate, runtime use, applicability and any fix are **unknown until both exact candidate images are built and scanned**. Wont-fix or not-fixed is not a waiver or risk acceptance; the report's fixed version for apt is not proof that a proposed image contains it. No suppression or changed threshold is proposed.

| CVE | Historical matched Debian binary packages | Frozen scanner fix status | Candidate presence/use and disposition |
| --- | --- | --- | --- |
| CVE-2025-69720 | `libtinfo6`, `ncurses-base`, `ncurses-bin` | wont-fix | UNKNOWN; rescan and assess |
| CVE-2026-102010 | `gcc-14-base`, `libgcc-s1`, `libstdc++6` | wont-fix | UNKNOWN; rescan and assess |
| CVE-2026-109518 | `apt`, `libapt-pkg7.0` | fixed (3.0.4) | UNKNOWN; rescan and assess |
| CVE-2026-119373 | `libsqlite3-0` | wont-fix | UNKNOWN; rescan and assess |
| CVE-2026-119374 | `libsqlite3-0` | wont-fix | UNKNOWN; rescan and assess |
| CVE-2026-119379 | `libsqlite3-0` | wont-fix | UNKNOWN; rescan and assess |
| CVE-2026-19499 | `libc-bin`, `libc6` | wont-fix | UNKNOWN; rescan and assess |
| CVE-2026-5435 | `libc-bin`, `libc6` | wont-fix | UNKNOWN; rescan and assess |
| CVE-2026-54369 | `libacl1` | wont-fix | UNKNOWN; rescan and assess |
| CVE-2026-54370 | `libacl1` | wont-fix | UNKNOWN; rescan and assess |
| CVE-2026-76642 | `bsdutils`, `libblkid1`, `liblastlog2-2`, `libmount1`, `libsmartcols1`, `libuuid1`, `login`, `mount`, `util-linux` | wont-fix | UNKNOWN; rescan and assess |
| CVE-2026-76844 | `zlib1g` | not-fixed | UNKNOWN; rescan and assess |
| CVE-2026-78408 | `bsdutils`, `libblkid1`, `liblastlog2-2`, `libmount1`, `libsmartcols1`, `libuuid1`, `login`, `mount`, `util-linux` | wont-fix | UNKNOWN; rescan and assess |
| CVE-2026-78409 | `bsdutils`, `libblkid1`, `liblastlog2-2`, `libmount1`, `libsmartcols1`, `libuuid1`, `login`, `mount`, `util-linux` | wont-fix | UNKNOWN; rescan and assess |
| CVE-2026-78410 | `bsdutils`, `libblkid1`, `liblastlog2-2`, `libmount1`, `libsmartcols1`, `libuuid1`, `login`, `mount`, `util-linux` | wont-fix | UNKNOWN; rescan and assess |
| CVE-2026-82560 | `perl-base` | wont-fix | UNKNOWN; rescan and assess |
| CVE-2026-84243 | `libc-bin`, `libc6` | wont-fix | UNKNOWN; rescan and assess |
| CVE-2026-85091 | `zlib1g` | not-fixed | UNKNOWN; rescan and assess |
| CVE-2026-9538 | `perl-base` | wont-fix | UNKNOWN; rescan and assess |
| CVE-2026-95619 | `gcc-14-base`, `libgcc-s1`, `libstdc++6` | wont-fix | UNKNOWN; rescan and assess |

All 20 IDs and 62 package rows per architecture remain in scope. Preserve raw outputs, ignored matches, exact archive/config/DiffIDs, scanner and fresh DB identity; no finding is cleared merely by using a smaller image. The existing retained base plan and scanner evidence describe the historical `e89` images, not the proposed candidate. Deployment and registry publication remain separate authorization and qualification gates.
