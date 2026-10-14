# Streamable HTTP Hosted Mode

DollhouseMCP can serve MCP over Streamable HTTP instead of the default stdio transport. This enables hosted deployments where multiple MCP clients connect to a single server process over HTTP.

## What This Mode Is

- An additional transport mode alongside the default stdio
- A single shared server process serving multiple HTTP sessions
- Per-session MCP servers backed by a shared handler pipeline
- Health and readiness endpoints for container orchestration
- Session pooling, rate limiting, and idle timeout management

## Authentication

The embedded authorization server runs inside this transport when configured. It exposes standard OAuth 2.1 / OIDC endpoints (`/authorize`, `/token`, `/jwks`, `/.well-known/oauth-authorization-server`) and validates Bearer tokens on `/mcp`. Setup is its own document:

→ [auth-server-setup.md](./auth-server-setup.md) — complete operator runbook covering filesystem vs Postgres storage, method selection (trivial-consent / local-password / magic-link / github), tunnels (Cloudflare / ngrok), reverse proxies, native HTTPS, and the security checklist.

For Cloudflare-fronted alpha deployments, run the
[Cloudflare Alpha Smoke Test](./cloudflare-alpha-smoke-test.md) after endpoint
verification. It validates the real MCP client path: OAuth discovery, GitHub
sign-in, Dollhouse client consent, bearer-token use, and read-only MCP calls
through the edge.

## Current limitations

- File-backed portfolio storage by default (Postgres backend available; see auth-server-setup.md for `DOLLHOUSE_STORAGE_BACKEND=database`)
- Single-tenant per process (multi-tenant isolation is planned follow-up work)
- Per-session activation state is shared across sessions within a process

## Local Run

Build and start in HTTP mode:

```bash
npm run build
npm run start:http
```

The MCP endpoint is available at:

```
http://127.0.0.1:3000/mcp
```

Supporting endpoints:

| Endpoint | Purpose |
|----------|---------|
| `GET /healthz` | Public status and package version only |
| `GET /readyz` | Public readiness status and package version only |
| `GET /version` | Server name and version |
| `GET /` | Server info including transport type and MCP path |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_TRANSPORT` | `stdio` | Transport mode: `stdio` or `streamable-http` |
| `DOLLHOUSE_HTTP_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` in containers |
| `DOLLHOUSE_HTTP_PORT` | `3000` | HTTP server port |
| `DOLLHOUSE_HTTP_MCP_PATH` | `/mcp` | URL path for the MCP endpoint |
| `DOLLHOUSE_HTTP_ALLOWED_HOSTS` | *(unset)* | Comma-separated Host header allowlist for DNS rebinding protection |
| `DOLLHOUSE_HTTP_RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in milliseconds |
| `DOLLHOUSE_HTTP_RATE_LIMIT_MAX_REQUESTS` | `300` | Max requests per client per window |
| `DOLLHOUSE_HTTP_SESSION_IDLE_TIMEOUT_MS` | `900000` | Idle grace after the final accepted GET closes, or after a request with no stream. 0 = no idle expiry |
| `DOLLHOUSE_HTTP_STREAM_KEEPALIVE_MS` | `15000` | SDK keepalive interval in milliseconds for all MCP SSE responses, and stall-detection sampling interval for standalone GET streams. `0` disables both; minimum nonzero interval is `1000` ms. Idle expiry and presence renewal remain independent of heartbeats. |
| `DOLLHOUSE_HTTP_STREAM_MAX_LIFETIME_MS` | `0` | Optional standalone MCP stream lifetime cap in milliseconds; `0` disables the cap; minimum nonzero lifetime is `1000` ms. Positive values end streams gracefully so clients can reconnect within the idle window and retain their session. |
| `DOLLHOUSE_HTTP_STREAM_EXPIRY_GRACE_MS` | `300000` | Milliseconds after credential expiry before gracefully ending an unrenewed standalone stream. Renewal cancels the close; `0` disables it. Minimum nonzero grace is `1000` ms. Credentials without expiry are unaffected. |
| `DOLLHOUSE_HTTP_SESSION_POOL_SIZE` | `0` | Pre-warmed session pool size. 0 = disabled |

Notes:

- When `DOLLHOUSE_HTTP_ALLOWED_HOSTS` is unset and the host is localhost, the MCP SDK's built-in localhost protection remains active via `createMcpExpressApp()`
- `DOLLHOUSE_HTTP_ALLOWED_HOSTS` is validated at startup — invalid entries fail fast
- The session pool pre-creates MCP server instances for faster connection handling under load

## CLI Overrides

Override transport settings without changing environment files:

```bash
node dist/index.js --streamable-http --host=127.0.0.1 --port=3000 --mcp-path=/mcp
```

With host allowlist:

```bash
node dist/index.js --streamable-http --allowed-hosts=localhost,127.0.0.1,myservice.example.com
```

## Docker Deployment

### Quick Start

```bash
# Build the image
docker build -f docker/Dockerfile -t dollhousemcp:http .

# Run in HTTP mode
docker run --rm -p 3000:3000 \
  -e DOLLHOUSE_TRANSPORT=streamable-http \
  -e DOLLHOUSE_HTTP_HOST=0.0.0.0 \
  dollhousemcp:http
```

### Docker Compose

Use the HTTP-specific compose file:

```bash
cd docker
docker compose -f docker-compose.http.yml up --build
```

For detached mode:

```bash
docker compose -f docker-compose.http.yml up -d
```

The compose file configures:
- `DOLLHOUSE_HTTP_HOST=0.0.0.0` (required for container networking)
- Port 3000 exposed
- `restart: unless-stopped` (HTTP servers should stay running)
- Security hardening (non-root, dropped capabilities, read-only filesystem)
- Resource limits (512MB RAM, 1 CPU)

### Health Monitoring

The Docker image includes a HEALTHCHECK that probes `/healthz`:

```bash
# Check container health
docker inspect --format='{{.State.Health.Status}}' dollhousemcp-http

# View health check log
docker inspect --format='{{json .State.Health}}' dollhousemcp-http | jq
```

Public probes intentionally exclude session, authentication and process-memory diagnostics. `/healthz` returns `{"ok":true,"version":"…"}`; `/readyz` returns `{"ready":true,"version":"…"}` (or HTTP 503 with `ready:false`). Root discovery exposes endpoint information without pool or session counters.

Operators obtain aggregate HTTP diagnostics at `GET /api/v1/admin/operate/metrics/http`. This console route requires an authenticated session, the existing `console:admin:operate` capability and current administrative step-up. The operational privacy projector excludes session identities and arbitrary source fields; the existing admin audit records access. No new public metrics endpoint is provided.

## Quiet sessions and stream lifetime

An accepted standalone GET stream keeps its MCP session, active elements and
runtime presence alive during quiet work. The initial GET counts once at open;
comments and presence renewals do not increment requests or move last activity.
A same-owner reconnect replaces the old stream. Rejected GETs do not acquire
liveness. Closing the final stream starts a fresh idle grace; subsequent requests
reset it. DELETE, operator termination and shutdown dispose immediately.
Disabling an account or revoking all of its credentials in the console also
terminates that user's open MCP sessions through runtime termination commands.
This depends on registered runtime presence and the owning replica processing
the commands; the console reports termination failures or acknowledgement timeouts.

The opening credential's expiry does not immediately close an accepted stream. After expiry,
only SSE keepalive comments (the SDK's `: keepalive` frame) continue; MCP notifications, requests and responses
routed to that standalone stream are dropped, not queued for later delivery.
The server logs once at debug level when the stream becomes credential-expired.
A POST with a matching credential binding renews the current accepted stream after
authentication and the session owner check succeed. It extends the deadline to the
later of its current value and the POST token's `exp`, even if the JSON-RPC
operation fails. An exp-less token cannot extend the deadline.
A matching renewal resumes delivery on the original GET, with one debug log on
un-gating. If any payload was dropped, the server sends one `tools/list_changed`
notification to trigger resync; it never replays dropped messages. If the expired stream closes first, the next accepted stream receives the pending resync once.

Renewal requires exact equality of the verified subject, tenant (when present),
issuer, `client_id`, `azp`, `grant_id`, and `sid`. Both client claims are compared
separately when present. A claim missing on just one side rejects renewal; a claim
missing on both sides leaves the remaining comparisons in force:

- Embedded OAuth flows emit `client_id` and a `grant_id` stable across refreshes.
  Legacy tokens without `grant_id` cannot renew a GET with a new grant-bearing
  token; replace that GET once.
- External OIDC uses the signed claims supplied by the issuer. Without a grant or
  `sid`, binding is limited to subject, tenant, issuer and available client claims.
- Local development issuance has neither client nor grant identity: its fallback
  is subject and issuer, plus any tenant or other binding claims actually present.

A POST with a different binding still receives its normal response but cannot
renew or disturb the stream. This prevents another client or grant's activity
from reviving a copied bearer/session-ID stream. Providers lacking those claims
cannot distinguish sign-ins, and possession of the same grant's bearer remains
indistinguishable from its legitimate use. A replacement authenticated GET uses
its own credential and binding.

After a credential-expiry window in which payloads were dropped, renewal sends
exactly one `tools/list_changed` resync notification. Dropped notifications such as
`resources/updated`, logging and progress are not replayed; clients needing that
state should refresh it after the resync.

`DOLLHOUSE_HTTP_STREAM_MAX_LIFETIME_MS` defaults to `0` (no wall-clock cap).
A positive cap ends the stream gracefully; connected clients can reconnect within
the session idle window and retain their session and activations. Credential expiry
gates MCP messages immediately while keepalive comments continue. The default
`DOLLHOUSE_HTTP_STREAM_EXPIRY_GRACE_MS=300000` allows five minutes for a validated
credential from the same login to renew the stream before a graceful end. Renewal
cancels that deadline; `0` disables expiry-based closure. Every POST and replacement
GET still passes authentication and ownership checks.

Graceful stream closure waits up to one second for completion; a socket that cannot
drain is then destroyed. A session normally ends after disconnect plus the idle
timeout, or on DELETE, console account disable or revoke-all, shutdown, or a lapsed
presence lease. These terminal paths close sockets immediately. A refused memory
drain retains session ownership until it is safe to dispose. Setting the idle
timeout to `0` disables idle expiry. A credential without expiry never arms the
expiry deadline; with no lifetime cap, the server logs a warning once for each
accepted authenticated unbounded stream. Unauthenticated streams do not emit this warning.

The embedded authorization server issues refresh tokens when the client requests
`offline_access`, allows the `refresh_token` grant, and the user approves consent.
For direct GET authorization and unsigned PAR, the server adds consent when scope
and prompt values are plain ASCII without control characters. Unrelated request
bytes, including Unicode login hints, are preserved. Signed request objects,
non-ASCII or control characters in scope or prompt, encoded prompt keys, and
`prompt=none` pass through unchanged. These paths need explicit `prompt=consent`
for offline access; use it instead of `prompt=none`.
Refresh tokens allow clients to obtain fresh access credentials without signing in
again, but do not themselves renew an open stream until a request is made.

For occupancy planning, a stream whose socket keeps draining is treated as a
connected client and kept until an applicable expiry grace, lifetime cap or other
closure condition. If a vanished client's socket stops draining, the
stall watcher closes it after about three keepalive intervals of sustained
backpressure; this is not a deadline measured from the client's disappearance.
A proxy that keeps its origin connection open and draining after the end client
leaves keeps the stream until the proxy's own idle timeout. Disabling keepalive
also disables stall detection. Credentials without an expiry have no expiry gate;
the optional lifetime cap still applies.
Disconnect, explicit session disposal and
presence-lease loss still close it. Signing-key retirement does not terminate
existing sessions or reauthenticate an open stream: payload delivery can continue
until the current credential deadline, after which only heartbeats pass unless a
newly validated, matching credential renews it. A
non-expiring credential has no expiry gate. Console account disable and
revoke-all use the runtime termination path described above.
When idle expiry is disabled (`DOLLHOUSE_HTTP_SESSION_IDLE_TIMEOUT_MS=0`),
stream-less sessions renew presence periodically too, at the same cadence as open
streams. Healthy quiet sessions are not removed by cleanup and remain visible to admin termination;
lease-only writes do not count as requests or move last activity. With idle expiry
enabled, quiet stream-less sessions stop renewing: the idle window ends before
the presence lease (idle timeout plus a 60-second grace).

Existing-session POSTs and GET admissions check the local confirmed lease before
SDK dispatch, including after queued GET admission waits. This is a local check
of the confirmed lease; a missing, closing, or other-replica row within a still-valid
lease is detected by the next renewal or heartbeat. A lapsed lease returns
404 and disposes the session without executing the request, even if the expiry
timer is delayed. There is no quiet revalidation window or missing-row resurrection.
Open streams and idle-disabled sessions retain the confirmed-lease outage cutoff.
Admin termination reaches healthy quiet sessions through their renewed presence.
If an outage has already hidden a lapsed row from admin lookup, the local expiry
and admission guards close that session; every request also passes authentication.

Three missed comment intervals bound local backpressure only; neither a writable
proxy socket nor comment delivery proves client liveness.

Closing/wrong-replica presence results close the local session. Missing rows and
transient renewal errors retry with exponential backoff (100 ms base capped at one
renewal interval, then jittered by ±50%), inside the last confirmed lease. A slow write logs after the
smaller of five seconds and one renewal interval but stays coalesced. Successful
activity or renewal confirmations extend the expiry watchdog; without one by
lease expiry, the session closes. Initial registration retries within the service queue, bounded by one
lease window, for both streaming and POST-only clients. Disposal cancels retry
waits and fences later writes. Missing presence never triggers re-registration, including request
heartbeats, because it may represent a revoked row. Activity write errors log without immediately disposing the session. Registration
and activity writes have an expiry guard independent of streaming, so continuing
POSTs cannot keep an invisible session alive past its confirmed lease. Quiet
clients without a stream receive periodic renewal when transport idle expiry is
disabled; otherwise the idle timer closes them before their lease expires.

Local resources for all sessions start closing before waiting up to one second
for durable closes concurrently. Pending registration/write cleanup remains
ordered and replica-guarded even if that wait expires. Setting DOLLHOUSE_HTTP_STREAM_KEEPALIVE_MS to 0 disables SSE keepalive comments and stall detection, but not stream tracking, credential-expiry payload gating or grace closure, an opt-in lifetime cap or presence renewal.

During memory drain, including after a refused shutdown, retained sessions keep
healthy open streams, heartbeat comments and their normal presence renewal.
POST, GET and DELETE requests receive 503; MCP payloads are suppressed if the
presence lease or stream credential lapses. Runtime command polling is paused,
so console termination requests for retained sessions time out with
`runtime_termination_ack_timeout`; a termination whose poll was already running
when the drain began reports `local_termination_failed` instead, which the
console shows as `runtime_termination_failed`. Once the memory drain succeeds, retrying
shutdown tears down sessions, streams and presence normally.

This does not restore activations after actual session disposal or server restart.
Session activation and Gatekeeper state remain isolated between clients.

## Session durability across restarts

In `DOLLHOUSE_STORAGE_BACKEND=database` mode the JWKS signing key, the cookie-signing secret, and all OAuth state (sessions, grants, refresh tokens) live in Postgres. A `docker compose restart` of the MCP container preserves all of this — clients keep their bearer tokens, the JWKS `kid` does not change, and no user has to re-authenticate.

In filesystem mode the same state lives under the `run` directory (`~/.dollhouse/run/oauth-signing-key.json`, `~/.dollhouse/run/cookie-signing-secret.bin`, plus the `auth_kv/` directory). Containerized filesystem-mode deployments must mount this directory on a durable volume. If it lives on `tmpfs`, the signing keys and OAuth state disappear on every restart; the regenerated JWKS gets a fresh `kid`, prior tokens cannot validate, and prior sessions and grants no longer exist. Every user has to re-OAuth. Secret material is deliberately excluded from the public mode fingerprint.

The PoC stack at `docker/poc/` defaults to DB mode for this reason. If you need to run filesystem-mode in a container, bind-mount the `run` directory or accept the per-restart re-auth cost.

## Client compatibility

### Codex

**Codex client compatibility (CLI and desktop, version 0.163.0).** The server
rotates refresh tokens on every use. Reusing a spent token after the short retry
window revokes the whole login grant as possible token theft; every connection
using that login must sign in again. This security behavior is intentional.
Codex's default mode does not reliably persist rotated refresh tokens, so a
long-running window can open a fresh connection with a spent token and require
`codex mcp login <server>` again. Until Codex enables coordinated refresh by
default, enable `mcp_oauth_refresh_coordination` with
`codex --enable mcp_oauth_refresh_coordination ...`, or set
`mcp_oauth_refresh_coordination = true` under `[features]` in Codex's `config.toml`.
Coordinated refresh preserves the login and session across repeated refreshes
and client-initiated reconnects. Codex labels this flag "under development".

## Security

### DNS Rebinding Protection

The HTTP server uses the MCP SDK's `createMcpExpressApp()` which enables DNS rebinding protection by default. For localhost bindings, only requests with valid Host headers are accepted.

For non-localhost deployments, set `DOLLHOUSE_HTTP_ALLOWED_HOSTS` to your domain:

```bash
DOLLHOUSE_HTTP_ALLOWED_HOSTS=myservice.example.com,api.example.com
```

### Rate Limiting

Per-client rate limiting is enforced by IP address (or `X-Forwarded-For` header behind a proxy). Default: 300 requests per 60-second window. Exceeding the limit returns HTTP 429 with a `Retry-After` header.

### Container Binding

The default bind address is `127.0.0.1` (localhost only). In Docker containers, you must override to `0.0.0.0` so the container's port mapping works. The compose file handles this automatically.

Do not bind to `0.0.0.0` on bare-metal deployments without a reverse proxy or firewall — this exposes the server to the network.

## Web Console

When running in HTTP mode, the web management console starts automatically on port 41715 (configurable via `DOLLHOUSE_WEB_CONSOLE_PORT`). It provides:

- Real-time session monitoring — each HTTP client session appears in the session indicator with a puppet name and color
- Log viewing with session-based filtering — click a session to see only its logs
- Metrics dashboard — system health, cache efficiency, operation counts
- Portfolio browser — view and manage elements

The console starts before the HTTP transport, so sessions are visible as soon as they connect.

To disable the console (headless mode):

```bash
DOLLHOUSE_HTTP_WEB_CONSOLE=false npm run start:http
```

## Architecture

The HTTP transport uses a shared-container model:

1. One `DollhouseContainer` is bootstrapped at server startup
2. Handlers (MCPAQLHandler, ElementCRUDHandler, etc.) are created once and shared
3. Each HTTP session gets a lightweight per-session MCP Server, ToolRegistry, and ServerSetup
4. Session context (userId, sessionId, transport) is propagated through AsyncLocalStorage
5. Session-keyed state in MCPAQLHandler is cleaned up when sessions disconnect

This architecture enables efficient resource sharing — each new HTTP session adds ~1ms of overhead instead of the ~200ms+ required to bootstrap a full container.
