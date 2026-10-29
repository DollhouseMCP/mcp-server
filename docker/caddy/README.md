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

## Local qualification checkpoint — October 29, 2026

Pre-commit native ARM candidate: local image
`8796e143d17f3aae275819b18ec754e149327d0ba0e57de4d6edef943db3ab40`.
This is not a published digest or final PR-head/merged-release artifact.
Input layers, complete archive/config/DiffIDs and copied module/guard inputs
were independently bound. Both native CI jobs and their exact source-bound
final image archives remain required at the pushed head.

- Real offline APK removal passed: exactly nine removals, 23 unchanged
  retained versions, remaining world roots and CA/MIME/default-config/welcome
  data. Binary UID/GID 1001:1001, mode 0755 and restored capability passed.
  CMD, four public ENV entries, default user, WORKDIR and exposed ports match
  the approved base.
- Sixteen local guard/evidence controls pass, including changed baseline,
  wrong solver output, retained curl, changed CA data, fake commit-message
  parents and unexpected runtime ENV refusal.
- Selected full upstream unit packages: **1,630 test passes, 16 package
  passes, zero failures**; six packages have no tests and one original
  external-network test skips under its default `extnet=false`. No new skip,
  short mode or deadline change. Coverage includes Caddy config/parser,
  reverse proxy, headers, encoders, TLS, all go-jose/v4 subpackages and x/net
  HTTP2, with release CGO/tags/readonly resolution. This is not the entire
  upstream suite or race testing. Pre/post module and lock verification pass.
- Initial readonly-unit-container failures were exact fixture writes: two
  parser tests create/remove files in their own testdata, and internal PKI
  needs a data directory. The corrected unit container has a private writable
  overlay, makes only that validated testdata directory owner-writable and
  uses private XDG data/config. No host/shared source/cache, production
  profile, assertion, deadline or HOME variable changed.
- Actual renderer-derived HTTP, trusted/untrusted forwarding, query/header
  log redaction, reload, TLS/HTTP2 and persistent internal PKI pass. Source
  hash identifies the unchanged beta renderer. TLS is explicitly a capability
  fixture: `local_certs` and port 8443 avoid real ACME/email/external services.
  An owned internal network and fresh volumes contain state. The daemon's
  native architecture is checked independently of the client.
- Quiet SSE first data is at 11.49 ms, completion at 76,028.41 ms:
  **76,016.92 ms between first and final data**, exceeding 75 s without
  buffering both events. Existing 80 s request/90 s client bounds remain.
  Normal stop requires exit 0, not running and not OOM-killed. Restart retains
  the private CA; all owned-resource cleanup completed. Reload was around
  completed requests, not during an active SSE stream.

## Security remains blocked

The same frozen Trivy DB as the approved base reports **74 → 5 raw findings**
on native ARM: **49 → 0 OS rows**, **25 → 5 Go rows**. Actual inventory is
23 Alpine packages and 149 Go modules. Remaining rows are **one High, one
Medium and three Unknown**; none is suppressed, accepted or called fixed.
Old binary/deleted package bytes remain in lower layers; merged-runtime
results do not claim historical archive blobs disappeared. Current
intelligence and both final native CI artifacts still require qualification.

| Remaining component | Raw finding | Current evidence and boundary |
| --- | --- | --- |
| go-jose/v3 v3.0.5 | High CVE-2026-116587; no v3 fix reported | Vulnerable private RSA/JWK validation is compiled. The optional standard `acme_server` route can reach it before signature checks. Current hosted rendering does not enable that route; this is a profile boundary, not a repaired or generally safe module. No fork or residual acceptance is authorized. |
| chi/v5 v5.3.2 | Medium CVE-2026-114437; fixed v5.4.0 | ClientIPFromXFF is in `chi/middleware`, absent from both exact release-tagged package graphs. Preserve the row and require final binary/source binding; no unused upgrade hides it. |
| x/crypto v0.57.0 | Unknown GO-2026-5932, OpenPGP | OpenPGP is absent from both exact tagged compiled-package graphs; final source/build binding remains required. Module presence alone is not callable-code proof. |
| x/net v0.60.0 | Unknown CVE-2026-78661 and CVE-2026-97045; fixed v0.62.0 | HTML parsing/rendering is selected through Smallstep CLI help-report code; no current renderer HTTP path was demonstrated. A possible v0.62.0 upgrade requires six additional transitive raises and a separate exact-input decision. Candidate locks are not adopted here. |

The [JOSE advisory](https://github.com/go-jose/go-jose/security/advisories/GHSA-mgcc-cww5-fp2q)
is not cleared for v3 by upgrading v4. Missing stripped-binary names are not
proof. Actual function/import/config evidence and raw rows remain visible.
OS remediation and successful compatibility tests do not clear release gates.

Qualification is incomplete until actual native amd64/arm64 artifacts retain
the expected interfaces, ownership/capability and runtime behavior and pass
the documented security checks. v3/OpenPGP vulnerable-function applicability
must use precise source/import/config evidence; v4 upgrades and missing names
in a stripped binary do not establish non-applicability. All findings remain
reported until resolved or explicitly decided.

See [tracking issue #3168](https://github.com/DollhouseMCP/mcp-server/issues/3168).
Required operational handoff includes archive SHA/source tree/native platform,
manifest-to-config-to-local-engine identity, supported no-pull image intake,
pre-start identity recheck, prior proxy image/config/volume receipt, and a
tested rollback. No flags or artifact digests for that future route are
invented here. Existing hosted files, defaults and application package inputs
are unchanged by this qualification source.
