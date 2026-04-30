# ADR-002: Version-Aware Web Console Leadership

**Status:** Accepted
**Date:** 2026-04-16
**Authors:** DollhouseMCP Team

## Context

The authenticated web console can be open in multiple browser tabs while multiple `mcp-server` processes are also running on the same machine. Before this change, leadership was primarily based on liveness and lock ownership. That allowed an older process to remain leader even after a newer process started.

That mismatch created two concrete problems:

1. An older leader could keep serving stale UI assets and session metadata after a newer server was available.
2. Browser tabs connected to that older leader could miss controls, rendering paths, or session fields introduced by the newer server.

The console needed a deterministic rule for choosing which process should lead, plus a browser-side recovery path so already-open tabs would reconnect to the newest compatible leader.

## Decision

We make web console leadership **version-aware and compatibility-aware**.

### Leader selection

- Each leader lock and session heartbeat now includes:
  - `serverVersion`
  - `consoleProtocolVersion`
- A candidate may replace the current leader only when:
  - both processes are compatible at the console protocol level, and
  - the candidate's package version is strictly newer
- Equal versions do not trigger takeover, which avoids leadership flapping.
- Leaders without version/protocol metadata are treated as legacy and therefore older than any authenticated-console leader that includes the new fields.

### Browser recovery

- The HTML shell is served with `no-cache, no-store, must-revalidate`.
- Local CSS, JS, and image assets are stamped with `?v=<asset version>`.
- The sessions client compares the loaded console version to the active MCP leader version returned by `/api/sessions`.
- When the leader is newer, the tab schedules a short debounced forced reload to a cache-busted URL so it reconnects to the newest compatible leader and fetches fresh assets.

## Consequences

### Benefits

1. Open browser tabs converge toward the newest compatible server automatically.
2. Older leaders naturally lose authority when a newer compatible process starts.
3. Asset cache invalidation is tied to the server version, reducing stale frontend state.
4. Legacy leaders remain detectable and replaceable without requiring a separate migration path.

### Trade-offs

1. Leadership is no longer purely "first live process wins"; version metadata becomes part of the election contract.
2. Browser tabs may reload during upgrades, which is a small UX interruption but preferable to serving incompatible UI.
3. Future breaking console changes must increment `consoleProtocolVersion` so incompatible leaders are never elected over one another.

## Compatibility Matrix

| Existing leader | Candidate | Result |
|----------------|-----------|--------|
| Same protocol, older version | Same protocol, newer version | Candidate takes leadership |
| Same protocol, same version | Same protocol, same version | Existing leader stays |
| Older/legacy metadata | Current authenticated-console process | Current process takes leadership |
| Different protocol version | Any newer package version | Existing leader stays; no forced takeover |

## Related Documents

- [Architecture Overview](./overview.md)
- [ADR-001: CRUDE Protocol for MCP-AQL Endpoints](./ADR-001-CRUDE-PROTOCOL.md)

## References

- Issue #2025: Prefer newest compatible web console leader
- PR #2028: Version-aware console leadership and cache-busted reloads
