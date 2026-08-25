# Integration Execution Foundation Conflict Ledger

This ledger records the ancestry-preserving integration execution foundation
merged into `beta` under issue #2601 and recovery epic #2555.

## Frozen Inputs

- Beta parent: `e4e7161c8d3c3487be113fbe447daa2ab169499f`
- Hosted milestone: `7f96f127432cd512738f20471454258792ff7497`
- Hosted milestone author: Dibble
- Original feature PR: #2318
- Included hosted commits: `892bf93d`, `4cdd5dc4`, `1dd71b1e`, and
  `7f96f127`

The milestone is merged with `--no-ff`. The four original hosted commit objects
remain ancestors of the resulting branch; they are not squashed, rebased,
filtered, or reconstructed.

## Scope Boundary

This batch adds one integration execution contract:

- the gated `integration_request` gateway
- integration-aware gatekeeper policy and result provenance
- an OpenAPI-derived operation catalog
- promoted integration tools
- the allowlisted remote MCP bridge

It excludes the later curated descriptor seed loader, subsequent #2318 merge and
maintenance commits, later credential-path hardening, and rejected cleanup
inventory `bd98af2f`.

## Conflict Resolution

### `src/handlers/mcp-aql/MCPAQLHandler.ts`

Beta requires `ElementType` as a runtime value and uses
`normalizeElementType()` for memory operations. The hosted milestone introduced
direct type imports for `CacheMemoryBudget`, `MemoryMetricsSink`, and
`SessionActivationRegistry`.

The resolution keeps beta's runtime `ElementType` and normalization behavior,
then adds the three hosted type imports. This preserves beta's element handling
while accepting the imported handler dependency contracts.

### `src/web-console/modules/integrations/IntegrationPublicHostGuard.ts`

Both branches added this file independently. The hosted milestone contained its
original local IP classifier and a validation-only `void` return. Beta contains
the subsequently reviewed implementation backed by the shared canonical IP
classifier, verifies the reported address family, rejects every non-public
resolution, and returns the vetted address for connection pinning.

The resolution retains beta's complete implementation. Imported gateway and
remote-MCP callers remain compatible because they may await and ignore the
returned address, while existing beta consumers keep the stronger pinned-address
contract. The older duplicate classifier is not restored.

No other textual conflicts occurred in this batch.

## Beta Compatibility Patch

Beta already contains the reviewed pinned outbound security foundation from PR
#2587. The original hosted milestone predates that foundation and injected plain
`fetch` implementations after a DNS check, which would permit a second
connect-time resolution.

The reconciliation wires both imported credential-bearing consumers through
beta's existing `PinnedOutboundFactory`:

- `IntegrationRequestGateway` resolves once, opens a transport pinned to the
  vetted address, rejects redirects, and closes the transport after every call.
- `IntegrationRemoteMcpBridge` passes the pinned fetch implementation into the
  SDK streamable-HTTP transport and closes both client and pinned transport.
- Container and wired-test overrides now inject a pinned transport factory rather
  than a raw fetch function.
- The imported OAuth refresh fixture now uses the already-hardened configured
  provider's DNS and pinned-transport contract.

This patch preserves the imported execution behavior while preventing it from
bypassing beta's newer outbound security boundary. It does not import the later
credential-response redactor or rejected cleanup inventory.

## Required Verification

- Verify the merge commit has the frozen beta parent first and exact hosted
  milestone `7f96f127` second.
- Verify all six imported #2318 commits through this milestone remain reachable
  unchanged with Todd's original authorship and parent topology.
- Verify rejected cleanup inventory `bd98af2f` is not an ancestor.
- Run focused gateway, policy, catalog, promoted-tool, remote-MCP, gatekeeper,
  and wired integration tests.
- Run build, TypeScript, lint, security audit, and local code review.
- Run PostgreSQL, RLS, container, and HTTP/MCP coverage on Ubuntu/Podman.
- Run the complete protected `beta` matrix before promotion.
