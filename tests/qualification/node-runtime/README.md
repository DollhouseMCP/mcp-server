# Test-only signed Node runtime qualification

This additive harness is for one independently reviewed, root-approved hosted
qualification of the exact signed Node 24.22.1 binary/header overlay from source
`ddc97975f9ab792adfd3950c19e2495bf624fc77`. It changes no production recipe,
artifact pin, application code, npm leaf control, original workflow command,
original job timeout, scan policy, or release/deployment control. The owner
testing record is issue2452 comment6501614339; the final harness successor still
requires independent exact-head review and a public source binding before use.

An additive three-minute hosted precheck runs the genuine shell/process fixture
with inert Docker/timeout mocks and its unchanged20-second per-attempt cap.
Both original native and Compose jobs depend on that precheck, so a failed or
timed-out fixture prevents candidate builds. Raw mock proof/cleanup/exit files
are retained. This precheck is unqualified locally: an initial subprocess test
attempt exceeded its20-second fixture bound under host low-priority scheduling,
and the interrupted attempt's available raw records and EE log are preserved
outside the repository. The process fixture was not rerun locally. Tiny
in-process receipt-module fixture PASS results are separate evidence and do not
establish shell EXIT-trap or process-cleanup coverage.

Existing Docker Testing builds the builder and production targets on native
AMD64 and ARM64. The added step reuses the existing Buildx cache to load the
unchanged node-base stage. All proof containers are nonroot, network-none,
read-only, capability-free, without a Docker socket, secrets, host ports or
providers. Only the isolated containers bind loopback HTTP/TLS listeners. The
compiler writes a tiny test addon to a unique runner-temp directory; downloaded
or compiled target bytes are never executed on the host. Exact named proof
container cleanup is attempted on shell exit, including failed/time-limited
commands. Receipts distinguish observed absence/removal from UNKNOWN cleanup;
cleanup or finalization failure cannot turn a failing proof into success.

The proof asserts actual Node24.22.1, modules137 and npm11.19.0 CLI behavior,
selected binary size/hash, all458 matching headers and their tree hash, and the
helper's complete receipt. It independently recomputes the prefix digest on
node-base. Builder/production preserve that receipt but legitimately change
the prefix through existing npm preparation and optional-tool removal; they
are not represented as byte-identical full prefixes. Existing build steps run
the patched-npm inventory and scripts-disabled/offline pack/npx, node-gyp's
Undici, socks, query and minimatch consumer smokes under the candidate Node.

A test-only legacy addon is compiled offline with explicit C++20 against the matching headers and
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
AMD64 initialization steps remain unchanged; the additive precheck dependency
also gates that job.

Source/run/platform and selected job-built image IDs are retained before probes.
All probes use the captured immutable image IDs. Phase start/finish records,
separate stderr logs, a terminal exit/cleanup receipt and file hashes survive
ordinary command failures under `set -e`. An initial IN_PROGRESS receipt is not
proof of completion if the process is killed before finalization. Finalization
is limited to15seconds,64files,32MiB per file,64MiB total and10seconds of hash
work; exceeding a bound retains an incomplete state/failure, never a clean claim.
The additional base-stage load can fail after builder/production IDs are bound;
that failure does not invent a node-base image identity.

Evidence is uploaded before the blocking scanner. No exact scanner execution
authority was established by this harness preparation: historical Grype source
reviews and prior controlled runs are not a new Go-tool admission. Therefore
the added AMD64 authority preflight deliberately fails before the unchanged
scan. Its original always-run applicability capture cannot complete without the
scanner-produced target identity and retains an incomplete failure summary;
enforcement also fails without an actual scan report. No scanner, successful
applicability capture or clean-image result is invented. ARM64 has no
scanner in the original workflow. Any such run is PARTIAL qualification and
all vulnerability/adoption/release gates remain HOLD. This proposal neither
executes nor admits the separately held Caddy Go/native runner.

Local checks are syntax, shellcheck, YAML parsing, original-step preservation,
production/control byte identity, tiny in-process evidence/failure fixtures and
the retained seven mocked helper tests. No local compiler/runtime test is claimed.
Root explicitly allowed a source-preparation exception to local `npm run
pre-commit`, `npm run lint`, `npm run build` and `npm test` to preserve the
reserved host build slot. Those commands were not run and are not waived for
merge/adoption. No host/VM container build, candidate execution, publication or
dispatch is implied by this source proposal.
