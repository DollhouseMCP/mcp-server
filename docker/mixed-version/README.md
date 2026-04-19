# Mixed-Version Console Harness

This harness reproduces the exact class of bugs where multiple `mcp-server`
versions share one Dollhouse home directory, fight over the authenticated web
console lock file, and fail to converge on a single leader plus follower list.

It is intentionally different from the existing Docker test setups:

- all sessions share the same `HOME`
- all sessions share the same `~/.dollhouse/run` lock and port files
- all sessions share the same localhost network namespace
- one service runs the current local worktree while others run pinned published
  versions from npm

That makes it useful for debugging heterogeneous mixed-version environments
before cutting another release candidate.

## Services

- `current-local`
  - builds and runs the current checked-out worktree
- `stable-226`
  - runs `@dollhousemcp/mcp-server@2.0.26`
- `legacy-225`
  - runs `@dollhousemcp/mcp-server@2.0.25`
- `legacy-219`
  - runs `@dollhousemcp/mcp-server@2.0.19`

All of them share the same host-mounted state:

- `tmp/mixed-version/home`
- `tmp/mixed-version/logs`

## Quick Start

From the repo root:

```bash
./docker/mixed-version/reset-state.sh
docker compose -f docker/docker-compose.mixed-version.yml up -d --build
./docker/mixed-version/observe-state.sh
```

That gives you a live view of:

- the active lock file writer
- the number of `permission-server-*.port` files
- the current `/api/sessions` summary

The observer queries the console from *inside* the shared Docker namespace, so
it still works even when the web console is only bound to `127.0.0.1` inside
the harness.

If you want to try the host-facing port anyway, the default mapping is:

- [http://127.0.0.1:42715](http://127.0.0.1:42715)

but treat that as best-effort rather than the source of truth.

To capture a shareable snapshot instead of a live watch:

```bash
./docker/mixed-version/report-state.sh
```

That writes a timestamped markdown report under `tmp/mixed-version/reports/`.

## Useful Commands

Follow container logs:

```bash
docker compose -f docker/docker-compose.mixed-version.yml logs -f current-local stable-226 legacy-225 legacy-219
```

Rebuild the current local worktree image after changing code:

```bash
docker compose -f docker/docker-compose.mixed-version.yml up -d --build current-local
```

Rebuild via the injection helper:

```bash
./docker/mixed-version/inject-service.sh current-local --rebuild
```

Swap one published service to a different package version:

```bash
./docker/mixed-version/inject-service.sh legacy-225 @dollhousemcp/mcp-server@2.0.24
```

Stop the harness:

```bash
docker compose -f docker/docker-compose.mixed-version.yml down
```

Stop and remove state:

```bash
docker compose -f docker/docker-compose.mixed-version.yml down
./docker/mixed-version/reset-state.sh
```

Inspect the shared lock file directly:

```bash
cat tmp/mixed-version/home/.dollhouse/run/console-leader.auth.lock
```

Inspect the pid-specific port files:

```bash
ls -1 tmp/mixed-version/home/.dollhouse/run/permission-server-*.port
```

## Overriding Versions

You can swap the published package versions without editing the compose file:

```bash
MIXED_VERSION_STABLE_SPEC=@dollhousemcp/mcp-server@2.0.26 \
MIXED_VERSION_LEGACY_ONE_SPEC=@dollhousemcp/mcp-server@2.0.24 \
MIXED_VERSION_LEGACY_TWO_SPEC=@dollhousemcp/mcp-server@2.0.18 \
docker compose -f docker/docker-compose.mixed-version.yml up -d
```

If `42715` is already in use, move the host-facing console port:

```bash
MIXED_VERSION_HOST_PORT=43715 docker compose -f docker/docker-compose.mixed-version.yml up -d
```

## Why The Shared `netns` Service Exists

Separate containers normally get separate network namespaces, which would let
every version bind its own internal `41715` without a real conflict. The `netns`
sidecar exposes container port `41715` through host port `42715` by default, and
the session services all join that same namespace via `network_mode: service:netns`,
so they genuinely fight over the same localhost port inside the harness.

That is essential for reproducing the same “port owner vs lock writer” failures
we have been seeing on real heterogeneous machines.
