# Streamable HTTP Hosted Mode

This guide covers the Phase 1 hosted shape for DollhouseMCP: one container or process, one user, filesystem-backed state, and MCP exposed over Streamable HTTP instead of `stdio`.

It is intentionally narrow. This mode is the bridge between today's local MCP server and the later authenticated, multi-tenant platform work.

## What This Mode Is

- `stdio` remains the default runtime
- Streamable HTTP is an additional transport mode
- each HTTP session gets its own in-process MCP server/container wiring
- portfolio state is still filesystem-backed
- health and readiness endpoints are included for container use

## What This Mode Is Not Yet

- no built-in hosted authentication
- no database-backed state
- no shared multi-user tenancy
- no personal/business/department portfolio routing

Those are tracked by the later hosted platform issues under [#607](https://github.com/DollhouseMCP/mcp-server/issues/607).

## Local Run

Build the server, then start Streamable HTTP mode:

```bash
npm run build
npm run start:http
```

By default the hosted MCP endpoint is:

```text
http://127.0.0.1:3000/mcp
```

Supporting endpoints:

- `GET /healthz`
- `GET /readyz`
- `GET /version`

`/healthz` and `/readyz` also include process memory snapshots so hosted deployments can watch for session growth and GC pressure more easily.

## Environment Variables

The new hosted transport surface is:

```bash
DOLLHOUSE_TRANSPORT=streamable-http
DOLLHOUSE_HTTP_HOST=127.0.0.1
DOLLHOUSE_HTTP_PORT=3000
DOLLHOUSE_HTTP_MCP_PATH=/mcp
DOLLHOUSE_HTTP_ALLOWED_HOSTS=localhost,127.0.0.1
DOLLHOUSE_HTTP_RATE_LIMIT_WINDOW_MS=60000
DOLLHOUSE_HTTP_RATE_LIMIT_MAX_REQUESTS=300
DOLLHOUSE_HTTP_SESSION_IDLE_TIMEOUT_MS=900000
DOLLHOUSE_HTTP_SESSION_POOL_SIZE=0
```

Notes:

- `DOLLHOUSE_TRANSPORT=stdio` is still the default
- `PORT` is still available, but `DOLLHOUSE_HTTP_PORT` is the clearer hosted-mode setting
- if `DOLLHOUSE_HTTP_ALLOWED_HOSTS` is unset and the host is localhost, the MCP SDK's localhost protection remains in effect via `createMcpExpressApp()`
- `DOLLHOUSE_HTTP_ALLOWED_HOSTS` is validated at startup so bad allow-list entries fail fast
- `DOLLHOUSE_HTTP_RATE_LIMIT_*` controls the per-client request budget for hosted deployments
- `DOLLHOUSE_HTTP_SESSION_IDLE_TIMEOUT_MS` expires abandoned sessions before they become long-lived leaks
- `DOLLHOUSE_HTTP_SESSION_POOL_SIZE` keeps a small warm pool of pre-attached HTTP sessions for faster startup under light concurrency

## CLI Overrides

You can override the hosted runtime without changing env files:

```bash
node dist/index.js --streamable-http --host=127.0.0.1 --port=3000 --mcp-path=/mcp
```

Optional host allow-list:

```bash
node dist/index.js --streamable-http --allowed-hosts=localhost,127.0.0.1
```

## Docker Shape

The simplest hosted test shape is one container per user:

```bash
docker build -f docker/Dockerfile -t dollhousemcp-hosted .

docker run --rm -p 3000:3000 \
  -e DOLLHOUSE_TRANSPORT=streamable-http \
  -e DOLLHOUSE_HTTP_HOST=0.0.0.0 \
  -e DOLLHOUSE_HTTP_PORT=3000 \
  dollhousemcp-hosted
```

Then connect a Streamable HTTP MCP client to:

```text
http://localhost:3000/mcp
```

## Testing Notes

There is a targeted integration smoke suite at:

```text
tests/integration/transport/streamable-http.integration.test.ts
```

It is currently opt-in via `DOLLHOUSE_RUN_SOCKET_SMOKE=true` because some development and CI sandboxes block loopback socket tests. The runtime code is typechecked and the transport security coverage is active by default.
