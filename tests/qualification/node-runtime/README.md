# Test-only signed Node runtime qualification

This additive harness is for one independently reviewed, root-approved hosted
qualification of the exact signed Node 24.22.1 binary/header overlay from source
`ddc97975f9ab792adfd3950c19e2495bf624fc77`. It changes no production recipe,
artifact pin, application code, npm leaf control, original workflow command,
original job timeout, scan policy, or release/deployment control. The owner
testing record is issue2452 comment6501614339; the final harness successor still
requires independent exact-head review and a public source binding before use.

Existing Docker Testing builds the builder and production targets on native
AMD64 and ARM64. The added step reuses the existing Buildx cache to load the
unchanged node-base stage. All proof containers are nonroot, network-none,
read-only, capability-free, without a Docker socket, secrets, host ports or
providers. Only the isolated containers bind loopback HTTP/TLS listeners. The
compiler writes a tiny test addon to a unique runner-temp directory; downloaded
or compiled target bytes are never executed on the host. Exact named proof
containers are removed on shell exit, including failed/time-limited commands.

The proof asserts actual Node24.22.1, modules137 and npm11.19.0 CLI behavior,
selected binary size/hash, all458 matching headers and their tree hash, and the
helper's complete receipt. It independently recomputes the prefix digest on
node-base. Builder/production preserve that receipt but legitimately change
the prefix through existing npm preparation and optional-tool removal; they
are not represented as byte-identical full prefixes. Existing build steps run
the patched-npm inventory and scripts-disabled/offline pack/npx, node-gyp's
Undici, socks, query and minimatch consumer smokes under the candidate Node.

A test-only legacy addon is compiled offline against the matching headers and
loaded under both builder and production Node, testing actual ABI compatibility.
This does not qualify every application native module. Additional proof covers
HTTP Agent socket reuse, a trusted TLS handshake and wrong-hostname rejection,
Brotli round-trip and truncated-input rejection, AES-GCM round-trip and bad-tag
rejection, and provider-free application MCP initialize/tools-list. These are
bounded compatibility/security smokes, not exhaustive upstream regressions.
No exact CVE-2026-111497 exploit fixture, DNS rebinding, snapshot-entropy or
permission-model exploit regression is supplied. Random-byte inequality is not
an entropy proof. The prebuilt Dockerfile, full Jest/application/security suite,
migrations and ARM64 scan remain separate unexecuted gates. Original Compose
AMD64 initialization remains unchanged.

Evidence is uploaded before the blocking scanner. No exact scanner execution
authority was established by this harness preparation: historical Grype source
reviews and prior controlled runs are not a new Go-tool admission. Therefore
the added AMD64 authority preflight deliberately fails before the unchanged
scan. Its original always-run applicability capture and enforcement still run
and retain failures; no scanner or clean-image result is invented. ARM64 has no
scanner in the original workflow. Any such run is PARTIAL qualification and
all vulnerability/adoption/release gates remain HOLD. This proposal neither
executes nor admits the separately held Caddy Go/native runner.

Local checks are syntax, shellcheck, YAML parsing, original-step preservation,
production/control byte identity and the existing seven mocked helper tests.
Root explicitly allowed a source-preparation exception to local `npm run
pre-commit`, `npm run lint`, `npm run build` and `npm test` to preserve the
reserved host build slot. Those commands were not run and are not waived for
merge/adoption. No host/VM container build, candidate execution, publication or
dispatch is implied by this source proposal.
