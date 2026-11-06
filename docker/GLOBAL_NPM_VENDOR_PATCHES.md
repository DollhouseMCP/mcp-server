# Global npm vendor patch

The production images use the exact approved Node 24.22.1 index and its authenticated npm 11.19.1 bundle. The original npm bundle differs from the registry npm archive; its bytes, rather than the registry version label, define the preparer baseline. Root application manifests and locks are unchanged.

Five exact official leaf archives are checked by SRI and SHA-256 before publication. The tar 7.5.22 bundled with Node is preserved. The official http-cache-semantics 4.3.0 release fixes Vary handling; it does **not** fix mandatory-revalidation bypasses. The three explicit local changes in `global-npm-vendor-patches.json` fix policy reuse, stale fallback and explicit offline modes without changing upstream package versions.

The policy change derives from upstream http-cache-semantics PR 63, commit c84e0e37652b5762d6bdd28af65d6f42e2825224. It excludes unrelated parser, method and numeric-window changes. The two make-fetch-happen 15.0.6 caller changes are first-party changes. No-cache always requires validation; must-revalidate requires validation when stale. Ordinary stale offline cache and fresh must-revalidate reuse remain supported.

All five payloads and three exact before/after sources are validated before any replacement. Caller files must be regular, single-link files at exact real paths with mode 0644. Only those two callers may differ outside the five leaf directories. A final complete-inventory receipt is written only after all replacements and final hashes pass. Any failure stops the image build. The receipt is not a vulnerability waiver or an upstream fixed-version claim.

The three `.js.txt` fixtures under `tests/fixtures/global-npm-vendor` are nonexecuting exact preimages. The http-cache-semantics index is from the SRI-bound official 4.3.0 archive; the make-fetch-happen files are from authenticated Node source commit ce7aaf1cee78b8cf0ce17364260535c418d3ed26 (`deps/npm`). Each before/after SHA-256 and replacement anchor is declared in the vendor manifest. Runtime package license files are retained.

Mick's approval at https://github.com/DollhouseMCP/mcp-server/issues/2452#issuecomment-6481615082 covers only the exact image's age, on linux/amd64 and linux/arm64/v8. Source, runtime, image scans and any remaining vulnerabilities require separate evidence.

## Local qualification (2026-10-28)

The seventeen-file patch includes exact guarded removal of four unused final-runtime commands. All four regular-file/root/group/single-link/mode/package-ownership identities validate before any deletion; mount/umount require their original mode 04755, the other two 0755. Command removal is confined to final production stages; it removes no builder tools or package metadata. No library or raw OS finding is declared fixed by command removal.

The PR is image-only on frozen beta `88efb60caedab9937dfe901c903b8e9132691cc9`; application manifests and locks remain byte unchanged. It does not incorporate unmerged #3134, #3138 or #3146. Two explicitly distinct native ARM64 Docker-format artifacts were qualified on the isolated rootless nonproduction Podman host:

| Composition | Immutable image ID | Frozen-DB scan |
| --- | --- | --- |
| beta88 + image patch | `c8ff3a623c32896b917fa930d481c560a8edf29552a59dcbc21bb2b213af0ce8` | 185 rows: 1 Critical, 49 High, 71 Medium, 63 Low, 1 Unknown; 23 findings are old app dependency paths, zero global npm findings |
| LOCAL app93e366e + identical image patch | `6103e7979315d3a7ff1ad1b6014836bf07200091b693db09aaf21f6682ee080b` | Zero Node-package findings across 382 recognized packages; 162 OS rows: 43 High, 58 Medium, 60 Low, 1 Unknown |

The second composition is local qualification evidence; it is not adopted into this branch or beta. Both scans used verified temporary Trivy 0.76.1 and the same frozen public DB SHA-256 `1c66d0d801a194ed5df7a9c334d7991a6529d82952ab07a23cff1047c637c598` (updated 2026-10-28 19:18:03 UTC). All 162 Debian tuples exactly match the approved Node base. No compatible fixed Trixie package update was found in the bounded primary-source assessment; upstream fixes, applicability uncertainty and remaining risk are separate from that observation. **No OS residual is accepted or suppressed, and neither artifact is a clean-image or deployment approval.**

Local checks passed: 34 preparer controls, 12 staging/serial controls, 35 real cache-policy/registry-fetch cases, 20 four-tool removal/refusal controls and six existing Safety packaging controls. The actual authenticated Node npm bundle passed the preparer plus real offline npm pack/npx execution. Cache tests bind only synthetic loopback 127.0.0.1 endpoints and private temporary data. Final-image verification is intentionally check-only: the dependency stage already prepared the bundle and published its receipt. The initial beta88 native build executed the 35 cache controls and offline npm/npx smoke in all three stages. The final rebuilt artifacts reused unchanged qualified builder/dependency layers and executed the controls again on each final copied bundle. Raw exported image configs retain the original HTTP healthcheck. Native final runtime checks passed initialize and tools/list (five tools), clean EOF exit, real Argon2 hashing/verification, all three vendor post-hashes, and exact Node 24.22.1 / built-in Undici 7.30.1 / OpenSSL 3.5.9 / npm 11.19.1 versions. Execution used nonroot UID 1001, a read-only root, no network, dropped capabilities and no-new-privileges.

Final application runtime contains no TypeScript, tsx, Vitest, drizzle-kit, Safety workspace node_modules or temporary patch harness. The migration builder retains its tools; its actual drizzle-kit version command runs offline. No database migration or production database was accessed. The private memory-control directory remains UID/GID 1001 and mode 0700. Independent static inspection, bound to the raw image config and ordered layer whiteouts, confirms all four commands (infocmp, nsenter, mount, umount), their /bin aliases and same-byte executable copies are absent, and no homed/homework/homectl or Archive::Tar paths are present. Libmount and libacl bytes remain unchanged; their advisories and the util-linux version-range uncertainty require explicit assessment rather than nonroot-only dismissal.

The local host supports native ARM64 only. Both approved Node base platforms have static scans, but final AMD64 image/runtime and the native Docker restart-manager witness still require the supported CI runner. Required matching-head CI, automated reviews and Sonar evidence remain separate gates. Existing storage-capacity blockers tracked in #3090 and the separate Caddy security blockers are unchanged. Age approval grants no merge, publish or deployment authority.

## First CI correction

The first PR head `7964bce0` failed both Docker matrices before image construction: the positive preparer fixture inherited caller identity metadata from the runner's installed npm and hit the exact caller inventory guard. The CI error did not print the mismatched field; inherited mode is a hypothesis rather than measured CI evidence. An owned synthetic 0755 case reproduces the refusal. Fixtures now unlink copied caller entries and materialize fresh regular, single-link 0644 preimages. Positive executable/symlink/hardlink variants preserve their owned external targets; separate negative identity cases still exercise strict production refusal. No inherited target is chmodded. Installed-source read-only checks found the original callers regular, single-link 0644 with their exact qualified preimage hashes.

The thirteen Sonar findings prompted a focused helper refactor: exact Set membership and uniqueness replace validation sorting; contract and publication phases are named separately; default argument ordering and all callers agree; cache labels are named objects. An explicit serial Promise chain preserves input order, all-artifacts-before-publication and receipt-last behavior. Controls prove no later operation starts after rejection and no mutation remains pending. No concurrent mutation, suppression, package version, archive SRI, vendor transform or production identity guard changed.

Native Node 24.22.1 helper validation passes all 46 preparer/staging controls, all 35 cache cases and real offline npm/npx smoke. Both native Node 24.22.1 and local Node 24.16.0 reproduce the complete qualified npm receipt byte-for-byte: SHA-256 `10e4fbf0d91cc0dd00452895255f900693d37ceeb105a648fd8a7bd23a1d7639`. The earlier full-image scan/runtime artifacts above remain explicitly prior-pipeline composition evidence; fresh matching-head CI, Docker and Sonar gates are still required.

## Retained licenses

### http-cache-semantics (BSD-2-Clause)

Copyright 2016-2018 Kornel Lesiński

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.


### make-fetch-happen (ISC)

ISC License

Copyright 2017-2022 (c) npm, Inc.

Permission to use, copy, modify, and/or distribute this software for
any purpose with or without fee is hereby granted, provided that the
above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE COPYRIGHT HOLDER DISCLAIMS
ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR
CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE
OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE
USE OR PERFORMANCE OF THIS SOFTWARE.
