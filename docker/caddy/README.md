# Caddy security qualification

This directory prepares a custom rebuilt Caddy 2.11.7 runtime. It does not
change the hosted renderer, publish an image, or authorize deployment. The
existing renderer/pull/rollback path cannot consume an unpublished archive;
qualified artifact intake and proxy recovery remain separate release gates.

Input age exceptions approved by Mick on October 29, 2026:
[exact approval](https://github.com/DollhouseMCP/mcp-server/issues/2452#issuecomment-6502164159).
The decision covers only Go 1.26.10 Alpine 3.23 index
`sha256:34414731924cf2263160f0021f5cf6e1807382d85248f7cb419d4187b96d5e43`
(its two reviewed Linux children), x/net v0.60.0 and go-jose/v4 v4.1.6.
It grants no residual-risk, publication, merge or deployment approval.

The runtime input is the previously approved exact Caddy 2.11.7 index
`sha256:504a44d7d74bd2bc28a66afc4774912fc21223ca8a67734af1c54ab2f999b489`.
The package contracts come from that input's authenticated installed database,
not a new APK resolution. `remove-curl.sh` requires the exact 32-package/world
baseline, performs normal **offline** APK removal of only the curl world root,
and requires exactly 23 unchanged package versions afterwards. It preserves
ssl_client's conditional installation and checks inherited CA/MIME/default
configuration/welcome data. A failure after APK mutation fails the build;
this helper does not claim transactional rollback of a failed build layer.

`build/main.go` is byte-identical to official source commit
`72dd0fb067f6d7826c7f79907670ba4a713bfe37/cmd/caddy/main.go`, including its
Apache notice, embedded timezone data and standard-module imports. The
official release uses CGO disabled, `nobadger,nomysql,nopgx`, `-trimpath`,
`-mod=readonly` and `-ldflags='-s -w'`. No xcaddy or extra module is selected.
These three files under `build/` are intentional checked-in source/locks,
not generated binary artifacts. Qualified SHA256 values:

| File | SHA256 |
| --- | --- |
| main.go | `ac320c3ac47ad8abed7a0d2595639d78f9ff55cf1dba8494a66cd8851c5d076e` |
| go.mod | `b155a2815a958feea056cc386d28e47f5014e0bb2bc199d9a8be0c54725c42a2` |
| go.sum | `5c668b3ebdfce4153468ccafaba4df8b73e38e5d23cca1aa547f4dc8835d3a23` |

Standard authenticated Go/SumDB resolution and `go mod verify` passed for
this actual wrapper. The 596-module official source graph becomes 597 only
because the wrapper adds its main module and requires Caddy as the same
exact v2.11.7 source dependency. Only the two approved external module
versions change; no other external version was added or raised. Committed
mod/sum bytes are checked before download, after verification and after
compilation. Age approval does not extend to another dependency.

## Hardened first-party runtime

The output deliberately changes the upstream runtime profile. Its executable
is root-owned `0:0`, a single regular file with mode `0755` and
`cap_net_bind_service=ep`. A dedicated non-login account runs as
`1001:1001`. Only the image-layer `/data`, `/data/caddy`, `/config` and
`/config/caddy` directories become `1001:1001`, mode `0750`. There is no
recursive ownership change or migration of an existing persistent volume.
CMD, four public ENV entries, WORKDIR, ports, CA/MIME/welcome assets and all
23 retained package versions remain unchanged. The original runtime-config
contract remains an input record; the evidence helper explicitly derives
the hardened output's `User` rather than relabeling upstream defaults.

## Local qualification checkpoint — October 29, 2026

Hardened native ARM candidate:
`a792e4b45d70aff72b1276d3ce4ef9432f60bb99410660325a756842cf9df398`.
Its Docker archive SHA256 is
`84842217e1534c26000cc92eb4320e83d4c029e1a0a68e3304efc00a56149620`.
This is a local correction candidate, not a published digest or an artifact
from the initial PR head. All ten archive layer DiffIDs, actual config and
functional build inputs were independently bound. The earlier `8796e143`
prototype used upstream root/default-owner behavior and does not qualify
this hardened profile. Both native CI jobs and their source-bound final
archives remain required after the correction commit.

- Real offline APK removal passed: exactly nine removals, 23 unchanged
  retained versions, expected world roots and unchanged public assets.
  Nineteen local guard/evidence controls pass, including baseline, solver,
  retained-curl, CA-data, source-parent, ENV, profile and sequential-startup
  refusals. Existing workflow validation passes all 171 assertions; the five
  new Bash run steps now declare their shell explicitly.
- Selected full upstream unit packages: **1,630 test passes, 16 package
  passes, zero failures**; six packages have no tests and one original
  external-network test skips under its default `extnet=false`. No new skip,
  short mode or deadline change. Coverage includes Caddy config/parser,
  reverse proxy, headers, encoders, TLS, all go-jose/v4 subpackages and x/net
  HTTP2, with release CGO/tags/readonly resolution. This is not the entire
  upstream suite or race testing. Pre/post module and lock verification pass.
- Initial readonly-unit-container failures were fixture writes: parser tests
  create/remove their own testdata and internal PKI needs a data directory.
  The unit container uses a private writable overlay, the validated testdata
  directory and private XDG paths. No shared source/cache or assertion was
  changed. The initial CI lock manifest under `/tmp` was masked by the
  runtime tmpfs; it now lives under `/src`, preserving all checksum checks.
- Actual unchanged beta-renderer HTTP, trusted/untrusted forwarding,
  query/header access-log redaction and completed-request reload pass. TLS
  uses the renderer plus the explicitly labeled `local_certs` fixture option
  to avoid external ACME/email. Real ports 80/443, a private internal network
  and fresh named volumes are used. A separate owned fixture publisher
  supplies public configuration through a read-only Caddyfile volume; it
  grants no Caddy configuration write privilege.
- Native daemon/image architectures match. Actual PID 1 has UID/GID 1001,
  `NoNewPrivs=1`, effective/bounding capabilities `0x400` only, read-only root
  and `net.ipv4.ip_unprivileged_port_start=1024`. The positive service binds
  real low ports with only NET_BIND_SERVICE. Without that capability the
  same file-capability executable fails at OCI exec with `Operation not
  permitted`, exit 1, stopped and not OOM-killed, **before binding**. This
  proves the kernel execution boundary, not a bare bind-call EACCES result.
- Concurrent MCP-like **POST text/event-stream over TLS HTTP/1.1 and HTTP/2**
  pass with complete-event quiet gaps of **76,027.92 ms** and **76,013.63 ms**.
  Each exceeds 75 seconds; buffering both events until completion fails the
  assertions. The original 80-second request/90-second client bounds remain.
  Normal stop is exit 0, not running and not OOM-killed; restart preserves
  the private CA. Cleanup completes. Reload occurs around completed requests,
  not during an active SSE stream.
- A controlled root-owned, mode-0700 **DATA-only** fixture is refused without
  changing its marker or ownership. This is not proof about an existing live
  volume, a legacy config volume, or a migration procedure. Existing-volume
  preflight, controlled migration and rollback backup remain release gates.

The initial PR head's CI is terminal with 32 successful checks, 16 failures
and two no-op skips. Failures include the corrected lock-manifest location,
workflow shell declarations and Sonar findings, plus the still-real JOSE v3
dependency-review gate. Several ordinary unit jobs actually ran; their
workflow-validation failures are not merely downstream guard refusals.
These local corrections do not establish fresh CI or Sonar success.

The `a9509bd6` correction subsequently received matching-head Sonar zero
issues/hotspots and a nonblocking Claude review. Both native CI jobs passed
the 19 controls and checksum/module verification, then all 16 test packages
failed to execute their generated binaries under `/tmp` with permission
denied, before any test case ran. [Docker's tmpfs implementation](https://github.com/moby/moby/blob/master/daemon/oci_linux.go)
includes `noexec` by default; the CI logs did not capture their effective mount table.
A separate native kernel probe measured explicit `/tmp:noexec`, reproduced
the same real Go test's execution refusal there, and passed the identical
test using a fresh private `0700` scratch directory under `/src`.

Only `GOTMPDIR` now uses that disposable builder-overlay directory; cache
and PKI state stay under private `/tmp`. Cleanup covers both owned paths.
The workflow explicitly preserves `/tmp:noexec` across Docker and Podman.
The unchanged selected upstream suite then passed again with that exact
profile: 1,630 tests, 16 packages, six no-test packages and one original
external-network skip. Production image bytes/profile, module locks,
resource bounds, assertions and test selection are unchanged by this
bootstrap correction. Fresh head-specific CI/reviews/Sonar/artifacts remain
required; `a9509bd6` clearance is historical after the next commit.

## Security remains blocked

Against the same frozen Trivy DB as the approved base, the hardened ARM
artifact reports **74 → 5 raw findings**, **49 → 0 OS rows**, **25 → 5 Go
rows**. A separate fresh official DB, updated October 29 at 13:09:46 UTC and
downloaded at 17:33:22 UTC, reports **zero OS rows and seven Go rows: one
High, three Medium and three Unknown**. The fresh result includes both JOSE
Moderates absent from the frozen DB. Actual inventory remains 23 Alpine
packages and 149 Go modules. Raw rows, both DB identities and their union
are retained; none is suppressed, accepted or called fixed. Deleted package
and old binary bytes persist in lower layers; merged-runtime results do not
claim historical archive blobs disappeared.

| Component | Fresh raw findings | Evidence and boundary |
| --- | --- | --- |
| go-jose/v3 v3.0.5 | High CVE-2026-116587; Medium CVE-2026-116585 and CVE-2026-116586; no patched v3 release reported | Private RSA/JWK validation and recursive JSON parsing are compiled and reachable before signature checks through the optional standard `acme_server` route. Current hosted rendering omits it. CBC-HMAC panic code is also selected; a current proxy/ACME-JWS-to-JWE-decrypt route was not demonstrated. No general safety, repaired-v3 or residual-acceptance claim follows. |
| chi/v5 v5.3.2 | Medium CVE-2026-114437; fixed v5.4.0 | ClientIPFromXFF belongs to `chi/middleware`, absent from both exact release-tagged package graphs. Preserve the row and source/build binding; no unused upgrade hides it. |
| x/crypto v0.57.0 | Unknown GO-2026-5932, OpenPGP | OpenPGP is absent from both exact tagged compiled-package graphs. Module inventory alone does not prove callable code; stripped symbol absence is not used as proof. |
| x/net v0.60.0 | Unknown CVE-2026-78661 and CVE-2026-97045; fixed v0.62.0 | HTML parsing/rendering is selected through Smallstep CLI help-report code; no current renderer HTTP route was demonstrated. The fix remains pending a separate exact-input decision, not waived. |

The three primary v3 advisories are
[RSA/JWK validation](https://github.com/go-jose/go-jose/security/advisories/GHSA-mgcc-cww5-fp2q),
[CBC-HMAC panic](https://github.com/go-jose/go-jose/security/advisories/GHSA-4w3g-jfj2-cw2q)
and [JSON stack panic](https://github.com/go-jose/go-jose/security/advisories/GHSA-vvm8-gf78-28g4).
V4 upgrades do not clear v3. No custom fork, dependency-review allowlist or
residual waiver is authorized.

The prospective HTML fix resolves exactly seven raises: x/net v0.62.0,
x/crypto v0.58.0, x/sys v0.49.0, x/term v0.47.0, x/text v0.43.0,
x/sync v0.24.0 and x/tools v0.51.0. The separate age question for net,
crypto, term and text is **pending**. Canonical source, SumDB and graph
research is qualified; candidate locks and versions are **not adopted**.
A component-only prospective scan is not a new runtime qualification or
clearance of the unchanged v3 dependency.

Fresh matching-head CI, Codex/Claude reviews, Sonar zero-new-issue/hotspot
proof and native amd64/arm64 runtime/archive scans remain required. Successful
local compatibility and zero OS scan rows do not clear release gates.

See [tracking issue #3168](https://github.com/DollhouseMCP/mcp-server/issues/3168).
Required operational handoff includes archive SHA/source tree/native platform,
manifest-to-config-to-local-engine identity, supported no-pull image intake,
pre-start identity recheck, prior proxy image/config/volume receipt, existing
volume ownership preflight and controlled migration with tested rollback.
No live volume is recursively chowned. No flags or artifact digests for that
future intake route are invented here. Hosted renderer/runtime-helper files
and application package inputs are unchanged by this producer PR.
