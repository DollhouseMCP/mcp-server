# Streamable HTTP Hosted Mode

DollhouseMCP can serve MCP over Streamable HTTP instead of the default stdio transport. This enables hosted deployments where multiple MCP clients connect to a single server process over HTTP.

## What This Mode Is

- An additional transport mode alongside the default stdio
- A single shared server process serving multiple HTTP sessions
- Per-session MCP servers backed by a shared handler pipeline
- Health and readiness endpoints for container orchestration
- Session pooling, rate limiting, and idle timeout management

## What This Mode Is Not Yet

- No built-in authentication (Phase 3 will add JWT)
- No database-backed state (file-backed portfolio storage)
- No multi-tenant isolation (all sessions share one user identity)
- No per-session activation state (shared across sessions)

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
| `GET /healthz` | Health status with session telemetry and memory usage |
| `GET /readyz` | Readiness status with pool and telemetry details |
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
| `DOLLHOUSE_HTTP_SESSION_IDLE_TIMEOUT_MS` | `900000` | Session idle timeout (15 minutes). 0 = no timeout |
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

The `/healthz` response includes session telemetry:

```json
{
  "ok": true,
  "transport": "streamable-http",
  "version": "2.0.12",
  "sessions": {
    "active": 2,
    "pooled": 0,
    "created": 15,
    "disposed": 13,
    "expired": 0,
    "poolHits": 0,
    "poolMisses": 15,
    "rateLimitedRequests": 0
  },
  "memory": {
    "rss": 215056384,
    "heapTotal": 134934528,
    "heapUsed": 112370048,
    "external": 3976256,
    "arrayBuffers": 318641
  }
}
```

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

## Architecture

The HTTP transport uses a shared-container model:

1. One `DollhouseContainer` is bootstrapped at server startup
2. Handlers (MCPAQLHandler, ElementCRUDHandler, etc.) are created once and shared
3. Each HTTP session gets a lightweight per-session MCP Server, ToolRegistry, and ServerSetup
4. Session context (userId, sessionId, transport) is propagated through AsyncLocalStorage
5. Session-keyed state in MCPAQLHandler is cleaned up when sessions disconnect

This architecture enables efficient resource sharing — each new HTTP session adds ~1ms of overhead instead of the ~200ms+ required to bootstrap a full container.
