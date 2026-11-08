# Beta.3 shell-free runtime candidate — qualification pending

This draft uses the Google distroless Node 24 Debian 13 multi-platform index `sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba`; AMD manifest `sha256:1dfdd0613f3163fe913861ded2540584525b281d65541749726c7d3906382c06`, ARM manifest `sha256:e87b0071f3ba73d76f841f5d3e013d73a9cfaed916dcb7274d2dcd06d7419a3f`. It retains the Debian builder, Node 24.22.1 builder toolchain and migration target; the proposed final runtime supplies Node 24.22.2 without a shell or global npm. The two builder stages propose apt and libapt-pkg7.0 3.0.4; native signed-index verification and builds remain required. The draft also stages the complete authenticated Debian `zlib1g` `1:1.3.dfsg+really1.3.1-1+deb13u1` payload and its original package control and checksum metadata, pinned by architecture-specific Debian package hash. This source change does not prove the native payload or clear the zlib findings until final images are built and scanned. The Debian security update is recent; source provenance, package age and any applicable age decision remain explicit qualification gates. Hosted graceful-stop requires `node` on PATH, and migrations continue in the builder target. Runtime package-manager or shell-dependent operations are unavailable in the final image; any further user-facing compatibility impact must be assessed before adoption.

The [zlib package pin provenance receipt](evidence/beta3-zlib-pin-provenance-2026-11-08.json) (SHA-256 `5e88a263d19b9e50faae0a337f5a48eaae8fd9c7aca06e9490c804a4d5b5a48f`) binds both package hashes to the retained Debian security package-index metadata and InRelease hash lines. That independently retained metadata was fetched over TLS; its PGP envelope was not independently verified in that receipt. The native build separately uses normal APT signed-index authentication and exact package hashes.

The base was uploaded 2026-10-31T23:43:33Z. Its age is below the 21-day threshold on 2026-11-08; the existing Node 24.22.1 exception does not cover it. The exact index keyless signature was verified with the expected Google identity, issuer, certificate and transparency checks. Registry metadata and an SPDX attestation are retained; the attestation failed schema verification and is metadata only, not verified SBOM provenance. Source provenance and any age decision remain open. Candidate native addon compatibility, permissions, writable directories, HTTP health, signal/drain and both native architectures require fresh evidence. Source changes or a green badge do not prove those properties.

## Preliminary base-only scan

A single offline scan of the selected AMD64 base, before adding the application, reported **13 High matches across seven CVEs**, 22 Medium, three Low and seven Negligible, with zero Critical and zero ignored matches. The High rows comprise two zlib, eight GCC runtime and three glibc matches. The IDs are CVE-2026-76844, CVE-2026-85091, CVE-2026-102010, CVE-2026-95619, CVE-2026-19499, CVE-2026-5435 and CVE-2026-84243. This is a base-only observation against the frozen database, not a final-image scan, waiver or claim of a zero-High outcome. The [base scan summary](evidence/beta3-distroless-amd64-base-scan-2026-11-08.json) preserves scanner, database, archive and finding bindings; the [earlier runtime-facts receipt](evidence/beta3-cve-runtime-facts-2026-11-08.json) is preliminary. The [observed Debian package inventory](evidence/beta3-distroless-amd64-observed-dpkg-2026-11-08.json) records 14 status.d entries from the exact retained AMD64 base archive; it is not an inventory of Node-bundled components or the final application image, so an absent High match does not establish bundled-code absence. The separately retained registry SPDX attestation remains metadata only, not verified provenance. Candidate selection and each residual's applicability, remediation and disposition remain open.

The linked base-scan summary is a readability-derived copy that normalizes the method limits and adds built-in scanner-rule disclosure and the raw report SHA-256 (SHA-256 `18164fb650bc024ab75311e420bc2121d0cfc3b6acec4a4abd1179d3b99e35cc`); the retained original is `edd30b52072732bc8b160c7771335b626d27eb1f39fbcc2753905a34d7a723cd` and the raw Grype report is `29be6999839d701b9241b1533cc57699b787990befadfd14cbabffc8cbd1e5a9`. The linked observed dpkg receipt adds the archive SHA-256 to the retained original `7fd09c5bd2b41f67767e27944b029710e424a5eb7be9dad5e2bf231f93cf80e9`; its derived SHA-256 is `be3c28ab13edf395afc4374b77c1b569660ee487054820eb1570cba31cb47686`.

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

## Historical 2a20 native image evidence and remaining High matches (November 8)

Docker Testing [run 42507029574](https://github.com/DollhouseMCP/mcp-server/actions/runs/42507029574) passed on both native architectures for PR head `2a20e15fd2895449af90f6fc1c0cd120d360ae0a`, tested merge `473b738dfdc8199b69e08d4d5c201109b1fcafbc`, tree `a1580d43bca32561f15bc8c11f736e4f2f1ed125`. Both exported archives were independently graph-verified against all 30 recorded ordered DiffIDs. The AMD64 archive SHA256 is `b6db7e9240a1e7173d03b2a5992dbf94f4c6fcd3602f56b874ed16b7bddcfed6`, manifest `sha256:9d5ce1a4d261ff81bcf613dc9912874a526024996904f6249e41eeaae6f3746a`, config `sha256:b6e36fdd69b10d7f647994cc6bd62bf2717cf9580e3525b6fa9a19defcf712ac`. The ARM64 archive SHA256 is `bc3a1193ae7744d44e1b088b47131513643b6d52539c62431d124b23875c8588`, manifest `sha256:621fda120eb23447132eba6060592f3e8fd09768392adf438d15f9fe90a29bad`, config `sha256:eaaa133379a33c629e603e972f11632903bb686d292645274a0fb33c2942a627`. These are historical exact-head proofs; a later source head requires its own native qualification.

The retained archives contain `zlib1g` `1:1.3.dfsg+really1.3.1-1+deb13u1`; control, symlink, library checksum and architecture-specific DEB hash were verified against the recorded package receipt. With the November 6 frozen scanner database, each image reports 13 High, 22 Medium, 3 Low and 7 Negligible findings. With the separate November 8 database, each reports 11 High, 17 Medium, 3 Low and 11 Negligible. Every scan exited 2 with zero ignored matches. A same-November-8-database control of the older fb20 images reports 13 High, including the two zlib CVEs; the newer database identifies this security package version as fixed for those two matches. The historical database still reports both against the fixed-version package. These raw results do not establish a clean image.

November 8 raw report SHA256: AMD64 `18a845d50557352a7d831e5aa99b6047a8ca9aa62ef7234408b099e601eb06d4`; ARM64 `1fae16de752500d8b71a36c90fa2ded6690291d48e23b6bf086438e834c63877`. November 6 raw report SHA256: AMD64 `9693887576fb54c0430077a619f4f270fd7d0352032b8601bfcf60ebe66e756c`; ARM64 `22d0a2049541684e68ed33779022e1c0280d94bf33be23dd2289697990749c4e`. Local raw reports and payload verification receipts are retained with the qualification evidence.

The independently reviewed [CVE-2026-95619 verdict](evidence/beta3-95619-peer-review-2026-11-08.md) (SHA-256 `dc7048a57b4e378daabec4750f6d4379e9433857c3690a662a9bd3756df987d2`) and [bounded disassembly and relocation evidence](evidence/beta3-gcc95619-bounded-peer-proof-2026-11-08.json) (SHA-256 `4a1b7dfd337e199c2a91e3b0066dedd4915c4503b359d6fb2b8fe22afefb5437`) describe the evidence for these exact libstdc++ bytes. Its local binding and raw disassembly receipts remain retained separately; the proof concerns the observed POSIX allocation path, not every GCC component or an image-wide disposition.

All 11 remaining High package matches per architecture are **open**, reviewed 2026-11-08 and due for review 2026-11-09. No scanner match is ignored or waived. Evidence below is bounded and does not establish the current live host or a complete call graph. Debian's raw scanner fix state for each is `wont-fix`.

| CVE | Matched package | Evidence and limitation |
| --- | --- | --- |
| CVE-2026-102010 | `gcc-14-base` 14.2.0-19 | Prior source and symbol census did not find the affected PBDS template, but inlined code and source-to-binary identity remain unproven for this image. |
| CVE-2026-102010 | `libgcc-s1` 14.2.0-19 | Prior source and symbol census did not find the affected PBDS template, but inlined code and source-to-binary identity remain unproven for this image. |
| CVE-2026-102010 | `libgomp1` 14.2.0-19 | Prior source and symbol census did not find the affected PBDS template, but inlined code and source-to-binary identity remain unproven for this image. |
| CVE-2026-102010 | `libstdc++6` 14.2.0-19 | Prior source and symbol census did not find the affected PBDS template, but inlined code and source-to-binary identity remain unproven for this image. |
| CVE-2026-19499 | `libc6` 2.41-12+deb13u4 | Prior review found no direct monetary-formatting imports in Node/Argon2; indirect calls and current-image identity are not fully established. |
| CVE-2026-5435 | `libc6` 2.41-12+deb13u4 | Prior review found no direct deprecated TSIG printing imports in Node/Argon2; indirect calls and current-image identity remain unproven. |
| CVE-2026-84243 | `libc6` 2.41-12+deb13u4 | Prior review found an indirect gettext import via libstdc++; locale and indirect-call conditions are not universally excluded. |
| CVE-2026-95619 | `gcc-14-base` 14.2.0-19 | The exact 2a20 libstdc++ ELF hashes match the independently reviewed POSIX aligned-allocation implementation. This applies to those bytes and ordinary resolution only; it is not a package-wide fix or waiver. |
| CVE-2026-95619 | `libgcc-s1` 14.2.0-19 | The exact 2a20 libstdc++ ELF hashes match the independently reviewed POSIX aligned-allocation implementation. This applies to those bytes and ordinary resolution only; it is not a package-wide fix or waiver. |
| CVE-2026-95619 | `libgomp1` 14.2.0-19 | The exact 2a20 libstdc++ ELF hashes match the independently reviewed POSIX aligned-allocation implementation. This applies to those bytes and ordinary resolution only; it is not a package-wide fix or waiver. |
| CVE-2026-95619 | `libstdc++6` 14.2.0-19 | The exact 2a20 libstdc++ ELF hashes match the independently reviewed POSIX aligned-allocation implementation. This applies to those bytes and ordinary resolution only; it is not a package-wide fix or waiver. |
