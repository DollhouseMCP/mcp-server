# Undici 6.28.1 beta security qualification

Tracking: [#2918](https://github.com/DollhouseMCP/mcp-server/issues/2918). This is a direct runtime dependency patch, isolated from archive publication work.

## Baseline and advisory evidence

Beta `c9ee484ae48b186cc50b6332883d444b71318ca7` and archive head `e301` share root lock SHA-256 `24db00caf1b5dffe126026566457864116e829a2b033b460760c0d6d4b746c9e`, with one direct `node_modules/undici@6.28.0` record. Fresh npm audit on September 29 reports 1 high, 18 moderate and 1 low; production-only audit reports 1 high and 10 moderate. Earlier zero-high results do not supersede newly surfaced advisory data.

The high advisory is [GHSA-rfgv-xxqx-mfg5](https://github.com/nodejs/undici/security/advisories/GHSA-rfgv-xxqx-mfg5), affecting `>=6.7.0 <6.28.1`: an unrequested WebSocket subprotocol can cause an uncaught handshake exception. [GHSA-3wwx-pv8p-q78v](https://github.com/nodejs/undici/security/advisories/GHSA-3wwx-pv8p-q78v) is moderate, affecting `>=6.25.0 <6.28.1`, and concerns an unhandled WebSocket decompression error. [GHSA-r53p-7pc4-xj5r](https://github.com/nodejs/undici/security/advisories/GHSA-r53p-7pc4-xj5r) is low, affecting `<6.28.1`, and concerns retry response framing. All three are fixed in 6.28.1. The high advisory entered GitHub's reviewed database September 29; its upstream publication was September 4.

The complete installed chain is the root package → exact runtime `undici@6.28.0`; no child runtime dependencies are present. `PinnedOutboundFactory` imports Agent/fetch for vetted DNS-bound integration HTTP requests. Repository source inspection found no undici WebSocket or retry-interceptor invocation. This establishes the inspected capability, not a general claim that every deployment is unexploitable or that the installed advisory is a false positive.

## Candidate and supply-chain review

Choose exact `6.28.1`, the smallest compatible fixed version. npm publication is **2026-09-04 14:23:45.648 UTC**, over 25 days before this review and beyond [#2452](https://github.com/DollhouseMCP/mcp-server/issues/2452)'s default 21-day cooling period. Audit-suggested 6.29.0 was published September 25 and is unnecessary and younger than that period. Node support remains `>=18.17`.

Registry repository and maintainers match 6.28.0: `nodejs/undici`, matteo.collina, ronag and ethan_arrowood. Registry `gitHead` and upstream v6.28.1 tag both identify `ffc8aa0fdd4c54024f384e57784d5047c8b4085a`. Downloaded candidate SHA-512 matches registry integrity. Registry publication and SLSA provenance subjects match that artifact; provenance identifies the upstream `.github/workflows/release.yml` workflow at the same commit. `npm audit signatures` verifies 1,058 installed package registry signatures and 103 attestations. These checks establish observed identity/provenance; they do not prove absence of undisclosed ownership or token incidents.

The [official release](https://github.com/nodejs/undici/releases/tag/v6.28.1) contains the three fixes plus EventSource parser allocation and HTTP/1 idle-timer performance changes. Upstream comparison has six commits and 12 changed files including regression tests/benchmarks. Both published tarballs contain 176 files: no additions/removals; changes are package.json and five runtime files (HTTP/1 dispatcher, EventSource parser, retry handler and two WebSocket files). No runtime children or install/preinstall/postinstall hooks appear. The source prepare script is unchanged. Install used `npm ci --ignore-scripts`; no dependency install scripts ran.

## Scope and qualification

The entire lock diff changes only the root exact pin and the single undici version/resolved URL/integrity record. The safety workspace lock is unchanged. No broad audit fix, dependency range relaxation, audit suppression, deployment or production repair is included.

Four focused outbound/provider suites pass **66/66** tests. Production build and full lint pass. Required pre-commit passes 108 security tests, scripts typecheck and the high-severity audit gate. Full npm audit now reports **0 high/critical, 18 moderate, 1 low**; production-only audit reports **0 high/critical, 10 moderate**. Remaining findings retain their separate tracking under #2837. Full PR CI and fresh Codex/Claude/Sonar review are required before merge.

Rollback is the prior exact 6.28.0 manifest/lock record via a separately reviewed revert and reproducible script-disabled install. That rollback reintroduces these advisory ranges and must be assessed as such; it is not an automatic fallback to a safe version.
