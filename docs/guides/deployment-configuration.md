# Deployment & Configuration Guide

This guide covers everything you need to deploy and configure DollhouseMCP. It is written for operators, sysadmins, and AI engineers — not for developers contributing to the codebase.

---

## Contents

- [Overview: Transport and Storage Modes](#overview-transport-and-storage-modes)
- [Which configuration should I use?](#which-configuration-should-i-use)
- [Transport: Benefits and Tradeoffs](#transport-benefits-and-tradeoffs)
- [Defaults](#defaults)
- [Transport Configuration](#transport-configuration)
  - [Stdio mode (default)](#stdio-mode-default)
  - [HTTP Streaming mode](#http-streaming-mode)
- [Storage Backend Configuration](#storage-backend-configuration)
  - [Filesystem (default)](#filesystem-default)
  - [Database backend](#database-backend)
- [PostgreSQL Setup](#postgresql-setup)
  - [Automated setup (Docker — recommended)](#automated-setup-docker--recommended)
  - [Running migrations manually](#running-migrations-manually)
  - [Manual setup (managed PostgreSQL)](#manual-setup-managed-postgresql--rds-cloud-sql-and-so-on)
- [Per-User Data Isolation](#per-user-data-isolation)
- [Authentication](#authentication)
  - [How it works](#how-it-works)
  - [Local dev setup (recommended starting point)](#local-dev-setup-recommended-starting-point)
  - [Generating tokens for specific users](#generating-tokens-for-specific-users)
  - [Configuring MCP clients to send tokens](#configuring-mcp-clients-to-send-tokens)
  - [OIDC provider setup](#oidc-provider-setup)
  - [What changes when auth is enabled](#what-changes-when-auth-is-enabled)
  - [Authentication environment variables](#authentication-environment-variables)
- [Shared Pool and Public Elements](#shared-pool-and-public-elements)
- [Migrating Existing Setups](#migrating-existing-setups)
- [Environment Variable Reference](#environment-variable-reference)
- [Common Deployment Scenarios](#common-deployment-scenarios)

---

## Overview: Transport and Storage Modes

DollhouseMCP supports two independent configuration axes:

| Axis | Options |
|------|---------|
| **Transport** | `stdio` (default) or `streamable-http` |
| **Storage** | `file` (default) or `database` (PostgreSQL) |

These combine into four deployment configurations:

| Configuration | Transport | Storage | When to use |
|--------------|-----------|---------|-------------|
| **stdio + file** | stdio | filesystem | Local use with a single MCP client (Claude Code, Claude Desktop, etc.) — the default, zero configuration required |
| **stdio + database** | stdio | PostgreSQL | Local use, but you want durable database-backed storage for elements and session state |
| **http + file** | Streamable HTTP | filesystem | Remote or multi-client access without database infrastructure; simpler to operate but all sessions share one user identity |
| **http + database** | Streamable HTTP | PostgreSQL | Full hosted multi-user deployment with per-user data isolation enforced at the database layer |

---

## Which configuration should I use?

Choose based on your use case:

**Solo developer using Claude Code or Claude Desktop locally**
Use `stdio + file` — this is the default. No configuration required. Install and run. Your portfolio lives at `~/.dollhouse/portfolio/` on existing installs, or `~/DollhouseMCP/` on new installs.

**Developer who wants durable storage or needs database queries**
Use `stdio + database`. You get the simplicity of stdio (one client, no network exposure) with PostgreSQL-backed storage that persists independently of the filesystem and supports structured queries.

**Individual who wants remote access** — connecting from a phone, second laptop, or multiple machines
Use `http + file`. Run a persistent HTTP server at home or on a VPS. All sessions share a single user identity (no per-user isolation), so this is appropriate for personal use only.

**Team or organization deploying for multiple users**
Use `http + database` — this is the recommended production configuration. The HTTP transport handles concurrent clients; PostgreSQL with Row-Level Security ensures each user sees only their own data. Pair with a reverse proxy (nginx, Caddy) for TLS.

**CI/CD pipeline or automation**
Use `stdio + file`. Stdio is headless, ephemeral, and requires no network. Start the server process, run your automation, and let the client exit.

> **Recommended production configuration:** `http + database`. It is the only configuration that provides multi-user isolation, persistent sessions, health endpoints for monitoring, and a web console for observability. The simpler configurations exist for good reasons — but if you are deploying for others or need any of those capabilities, start here.

---

## Transport: Benefits and Tradeoffs

### Stdio

Stdio is the default and the right choice for most personal and developer use.

**Benefits:**
- Zero configuration — no ports, no addresses, no firewall rules
- Process-per-client isolation — each MCP client gets its own server process; one misbehaving session cannot affect another
- No network exposure — the MCP protocol never touches the network; there is no surface for network-based attacks
- Correct for Claude Code, Claude Desktop, Cursor, Gemini CLI, and any other client that manages the server process directly

**Limitations:**
- One client at a time per process — you cannot connect Claude Code and Claude Desktop simultaneously to the same server instance
- No remote access — stdio is local by definition; you cannot reach it from another machine
- Process lifecycle tied to the client — when the MCP client exits, the server exits; there is no persistent server to reconnect to

### HTTP (Streamable HTTP)

HTTP mode runs a persistent server that multiple clients can connect to independently.

**Benefits:**
- Multiple concurrent clients — any number of MCP clients can connect to the same server simultaneously
- Remote access — expose via a reverse proxy and connect from any machine, anywhere
- Persistent server — the server keeps running when a client disconnects; sessions can resume (subject to idle timeout)
- Session management — built-in session tracking, idle timeout, and pre-warmed session pools
- Health endpoints — `/healthz` and `/readyz` for load balancer and monitoring integration
- Web console — real-time session monitoring, per-session log filtering, and metrics dashboard at port 41715

**Limitations:**
- Requires network configuration — you must choose a bind address, port, and (for external access) an allowed-hosts list
- Security hardening required for production — for any deployment beyond localhost, you need a reverse proxy for TLS, and you should enable web console authentication (`DOLLHOUSE_WEB_AUTH_ENABLED=true`) and set a token secret (`DOLLHOUSE_TOKEN_SECRET`)
- More operational surface — a persistent process needs monitoring, restart-on-failure (Docker `restart: unless-stopped`, systemd, and so on), and log rotation

---

## Defaults

> **Default behavior (zero configuration needed):**
> - Transport: `stdio`
> - Storage: filesystem
> - Portfolio: `~/.dollhouse/portfolio/` on existing installs (legacy layout); `~/DollhouseMCP/` on new installs without an existing `~/.dollhouse/` directory
> - Web console: enabled on port 41715 (when running in HTTP mode)

The following features require explicit opt-in — they are **not active** unless you configure them:

| Feature | How to enable |
|---------|--------------|
| HTTP Streaming transport | Set `DOLLHOUSE_TRANSPORT=streamable-http` |
| Database storage backend | Set `DOLLHOUSE_STORAGE_BACKEND=database` |
| Token authentication on HTTP endpoints | Set `DOLLHOUSE_AUTH_ENABLED=true` |
| Shared public element pool | Set `DOLLHOUSE_SHARED_POOL_ENABLED=true` |
| Web console authentication | Set `DOLLHOUSE_WEB_AUTH_ENABLED=true` |

Everything else covered in this guide is either a default or a tunable that modifies existing behavior.

---

## Transport Configuration

### Stdio mode (default)

No configuration needed. When you start DollhouseMCP without any transport settings, it reads from stdin and writes to stdout using the MCP protocol. This is the correct mode for any MCP client that manages the server process directly (Claude Code, Claude Desktop, Cursor, Gemini CLI, and so on).

Your MCP client configuration points at the server binary:

```bash
# via npx
npx @dollhousemcp/mcp-server

# via local install
node /path/to/node_modules/@dollhousemcp/mcp-server/dist/index.js
```

No environment variables are required for stdio mode.

### HTTP Streaming mode

HTTP mode starts a persistent HTTP server that multiple MCP clients can connect to simultaneously. Enable it with one environment variable:

```bash
DOLLHOUSE_TRANSPORT=streamable-http
```

#### Quick start (local)

```bash
npm run build
DOLLHOUSE_TRANSPORT=streamable-http npm start
```

Or use the convenience script:

```bash
npm run start:http
```

The MCP endpoint is available at `http://127.0.0.1:3000/mcp` by default.

#### Supporting endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /healthz` | Health status with session telemetry and memory usage |
| `GET /readyz` | Readiness status with pool and telemetry details |
| `GET /version` | Server name and version |
| `GET /` | Server info including transport type and MCP path |

#### HTTP environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_TRANSPORT` | `stdio` | Transport mode. Set to `streamable-http` to enable HTTP. |
| `DOLLHOUSE_HTTP_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` inside containers. |
| `DOLLHOUSE_HTTP_PORT` | `3000` | HTTP server port. |
| `DOLLHOUSE_HTTP_MCP_PATH` | `/mcp` | URL path for the MCP endpoint. |
| `DOLLHOUSE_HTTP_ALLOWED_HOSTS` | *(unset)* | Comma-separated Host header allowlist. Required when binding to `0.0.0.0`. |
| `DOLLHOUSE_HTTP_RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in milliseconds. |
| `DOLLHOUSE_HTTP_RATE_LIMIT_MAX_REQUESTS` | `300` | Maximum requests per client per window. |
| `DOLLHOUSE_HTTP_SESSION_IDLE_TIMEOUT_MS` | `900000` | Session idle timeout (15 minutes). Set to `0` to disable. |
| `DOLLHOUSE_HTTP_SESSION_POOL_SIZE` | `0` | Pre-warmed session pool size. `0` disables the pool. |
| `DOLLHOUSE_HTTP_WEB_CONSOLE` | `true` | Start the web console alongside the HTTP transport. |

> **HTTP keep-alive (cycle 24):** the server sets `keepAliveTimeout=120s` and `headersTimeout=130s` on the listening socket. Node.js's defaults (5s and 60s) caused transient "MCP ERROR" pop-ups in clients that hold a Streamable HTTP connection across short idle gaps (Gemini CLI confirmed). The 120s window matches reverse-proxy industry norms (AWS ALB 60s, GCP LB 600s, Cloudflare 100s) and is hard-coded — not env-var configurable today. Operators behind a reverse proxy whose idle timeout is shorter than 120s should align the upstream value; otherwise the proxy closes the socket before the app does.

#### CLI overrides

You can override transport settings on the command line without modifying environment files:

```bash
node dist/index.js --streamable-http --host=127.0.0.1 --port=3000 --mcp-path=/mcp
```

With an allowed hosts list:

```bash
node dist/index.js --streamable-http --allowed-hosts=localhost,127.0.0.1,myservice.example.com
```

#### DNS rebinding protection

The HTTP server enforces DNS rebinding protection by default. For localhost bindings, the built-in MCP SDK protection is active automatically.

When binding to `0.0.0.0` (required inside containers or behind a reverse proxy), set `DOLLHOUSE_HTTP_ALLOWED_HOSTS` to the hostnames your clients will use:

```bash
DOLLHOUSE_HTTP_ALLOWED_HOSTS=myservice.example.com,api.example.com
```

> **Warning:** Do not bind to `0.0.0.0` on bare-metal without a reverse proxy or firewall rule. This exposes the MCP endpoint to your network.

#### Web console

When running in HTTP mode, a web management console starts automatically on port 41715. It provides real-time session monitoring, log viewing with per-session filtering, a metrics dashboard, and a portfolio browser.

To disable the console for headless deployments:

```bash
DOLLHOUSE_HTTP_WEB_CONSOLE=false
```

The console port is configurable via `DOLLHOUSE_WEB_CONSOLE_PORT`.

#### Docker deployment

Build and run the HTTP server in Docker:

```bash
# Build the image
docker build -f docker/Dockerfile -t dollhousemcp:http .

# Run in HTTP mode
docker run --rm -p 3000:3000 \
  -e DOLLHOUSE_TRANSPORT=streamable-http \
  -e DOLLHOUSE_HTTP_HOST=0.0.0.0 \
  dollhousemcp:http
```

Using Docker Compose:

```bash
cd docker
docker compose -f docker-compose.http.yml up --build

# Detached:
docker compose -f docker-compose.http.yml up -d
```

The compose file pre-configures `DOLLHOUSE_HTTP_HOST=0.0.0.0`, port mapping, security hardening (non-root user, dropped capabilities, read-only filesystem), and resource limits (512 MB RAM, 1 CPU).

Check container health:

```bash
docker inspect --format='{{.State.Health.Status}}' dollhousemcp-http
```

---

## Storage Backend Configuration

### Filesystem (default)

No configuration needed. DollhouseMCP reads and writes elements as YAML/Markdown files in your local portfolio directory.

#### Directory layout

DollhouseMCP uses one of two filesystem layouts depending on your install history. The layout is detected automatically on startup — you do not need to configure it.

**Legacy layout (existing `~/.dollhouse/` install — stdio and single-user HTTP):**

```
~/.dollhouse/
  portfolio/
    personas/
    skills/
    templates/
    agents/
    memories/
    ensembles/
    .backups/
  state/
  logs/
  run/
  shared/
  .auth/
  security/
```

This layout applies when `~/.dollhouse/` exists on disk and the per-user migration has not been run. All element files live directly under `portfolio/`; there is no per-user subdirectory. User identity is effectively single — all sessions read from and write to the same portfolio.

**Per-user layout (HTTP multi-user, or migrated legacy install):**

```
~/.dollhouse/
  users/
    <userId>/
      portfolio/
        personas/
        skills/
        templates/
        agents/
        memories/
        ensembles/
        .backups/
      state/
      auth/
      backups/
      security/
  shared/
```

This layout applies after running `npm run migrate:per-user` on a legacy install, or automatically on a fresh install that uses HTTP mode. Each user's data is sandboxed under their own `users/<userId>/` subtree. Cross-user filesystem access is blocked at the `PathValidator` level.

**New installs (no existing `~/.dollhouse/` directory):**

On a fresh machine with no prior DollhouseMCP installation, the portfolio root moves to a platform-visible location and internal directories follow platform conventions. The per-user layout is used from the start.

*macOS:*

| Directory | Purpose |
|-----------|---------|
| `~/DollhouseMCP/` | Portfolio root (contains `users/` subtree) |
| `~/Library/Preferences/DollhouseMCP/` | Config |
| `~/Library/Caches/DollhouseMCP/` | Cache |
| `~/Library/Application Support/DollhouseMCP/` | State |
| `~/Library/Logs/DollhouseMCP/` | Logs |
| `~/Library/Application Support/DollhouseMCP/run/` | Runtime files |

*Linux (XDG layout):*

| Directory | Purpose |
|-----------|---------|
| `~/DollhouseMCP/` | Portfolio root (contains `users/` subtree) |
| `~/.config/dollhousemcp/` | Config |
| `~/.cache/dollhousemcp/` | Cache |
| `~/.local/state/dollhousemcp/` | State |
| `~/.local/state/dollhousemcp/logs/` | Logs |
| `~/.local/state/dollhousemcp/run/` | Runtime files |

*Windows:*

| Directory | Purpose |
|-----------|---------|
| `%USERPROFILE%\DollhouseMCP\` | Portfolio root (contains `users\` subtree) |
| `%APPDATA%\DollhouseMCP\Config\` | Config |
| `%LOCALAPPDATA%\DollhouseMCP\Cache\` | Cache |
| `%LOCALAPPDATA%\DollhouseMCP\Data\` | State |
| `%LOCALAPPDATA%\DollhouseMCP\Log\` | Logs |
| `%LOCALAPPDATA%\DollhouseMCP\Run\` | Runtime files |

DollhouseMCP creates all required directories on startup. You do not need to create them manually.

#### Overriding paths

Any directory can be overridden with an environment variable. All overrides must be absolute paths.

| Variable | What it overrides |
|----------|------------------|
| `DOLLHOUSE_PORTFOLIO_DIR` | Portfolio root directory |
| `DOLLHOUSE_CONFIG_DIR` | Config directory |
| `DOLLHOUSE_CACHE_DIR` | Cache directory |
| `DOLLHOUSE_STATE_DIR` | State directory |
| `DOLLHOUSE_LOG_DIR` | Log directory |
| `DOLLHOUSE_RUN_DIR` | Runtime files directory |
| `DOLLHOUSE_SHARED_POOL_DIR` | Shared pool seed directory |

Example:

```bash
DOLLHOUSE_PORTFOLIO_DIR=/data/dollhouse/portfolio
```

### Database backend

Set `DOLLHOUSE_STORAGE_BACKEND=database` to switch from filesystem to PostgreSQL. You must also provide a connection URL:

```bash
DOLLHOUSE_STORAGE_BACKEND=database
DOLLHOUSE_DATABASE_URL=postgres://dollhouse_app:yourpassword@localhost:5432/dollhousemcp
```

See [PostgreSQL Setup](#postgresql-setup) for complete setup instructions.

---

## PostgreSQL Setup

### Automated setup (Docker — recommended)

`npm run db:setup` is the fastest way to get PostgreSQL running locally. It handles everything in one command:

1. Checks that Docker and Docker Compose are available
2. Starts the `dollhousemcp-postgres` container if it is not already running (uses `docker/docker-compose.db.yml`)
3. Waits for the container to reach healthy status
4. Creates the `dollhousemcp` database if it does not exist
5. Runs `docker/init-db.sql` to configure roles and permissions
6. Runs all Drizzle migrations
7. Re-applies grants after migrations (so permissions cover all newly created tables)
8. Prints the environment variables you need to configure

```bash
npm run db:setup
```

When complete, the script prints your environment variables:

```
=== Setup Complete ===

Add these to your environment or .env.local:

  DOLLHOUSE_STORAGE_BACKEND=database
  DOLLHOUSE_DATABASE_URL=postgres://dollhouse_app:dollhouse_app@localhost:5432/dollhousemcp
  DOLLHOUSE_DATABASE_ADMIN_URL=postgres://dollhouse:dollhouse@localhost:5432/dollhousemcp
```

Copy those into your `.env.local` or shell environment, then you are ready to use the database backend.

The script is idempotent — running it a second time checks the current state and skips steps that are already complete.

#### Starting fresh with `--reset`

If you need to wipe the database and start over — for example, after a migration conflict or corrupted state — pass the `--reset` flag:

```bash
npm run db:setup -- --reset
```

This drops the `dollhousemcp` database, recreates it, and runs the full setup sequence again. Your Docker container is not affected; only the database contents are cleared.

> **Warning:** `--reset` is irreversible. Any data in the database is permanently deleted. Re-import your portfolio afterward if needed.

#### Quickstart: database backend end-to-end

```bash
# 1. Start PostgreSQL, run migrations, print env vars
npm run db:setup

# 2. Copy the printed env vars into your environment, then import your portfolio
npm run db:import -- --user <your-username>

# 3. Start the server
npm run start:http
```

That is the complete path from zero to a running database-backed server.

---

### Why two connection URLs?

DollhouseMCP uses two separate PostgreSQL roles:

| Role | URL variable | Purpose |
|------|-------------|---------|
| `dollhouse` (superuser) | `DOLLHOUSE_DATABASE_ADMIN_URL` | Running migrations and creating user rows at bootstrap. Has full DDL access. |
| `dollhouse_app` (app role) | `DOLLHOUSE_DATABASE_URL` | All runtime queries. Has only SELECT, INSERT, UPDATE, DELETE. Row-Level Security is enforced against this role. |

This separation follows the principle of least privilege. Runtime application code never holds superuser credentials. If `DOLLHOUSE_DATABASE_ADMIN_URL` is not set, bootstrap falls back to using `DOLLHOUSE_DATABASE_URL` — this only works before Row-Level Security is applied to the `users` table.

### Running migrations manually

If you used `npm run db:setup`, migrations have already run. The following applies if you need to run migrations independently — for example, after pulling a new release that adds migration files:

```bash
npm run db:migrate
```

This uses `drizzle-kit migrate` and applies all pending SQL migration files from `src/database/migrations/` in order. The migration tool tracks applied migrations in the `drizzle` schema so re-running is safe.

> **Note:** Run migrations using the admin URL (`DOLLHOUSE_DATABASE_ADMIN_URL` or via a superuser connection string), not the app role URL. Migrations create tables, indexes, and RLS policies that the app role does not have permission to modify.

### Data management scripts

These CLI scripts are operator tools — they are not accessible to LLMs via MCP.

| Script | Purpose |
|--------|---------|
| `npm run db:setup` | One-command setup: start container, run migrations, print env vars (Docker required) |
| `npm run db:setup -- --reset` | Drop and recreate the database, then run full setup |
| `npm run db:migrate` | Apply pending migrations only (no container management) |
| `npm run db:import` | Import filesystem portfolio files into the database |
| `npm run db:export` | Export database elements to filesystem files |
| `npm run migrate:per-user` | Migrate a flat portfolio layout to the per-user directory layout |

All require `DOLLHOUSE_DATABASE_URL` and `DOLLHOUSE_DATABASE_ADMIN_URL` to be set (except `migrate:per-user`, which works on the filesystem only and does not touch the database). See [Migrating Existing Setups](#migrating-existing-setups) for full usage details.

#### What migrations create

| Migration | What it does |
|-----------|-------------|
| `0000` | Core tables: `users`, `elements`, `sessions`, `memories`, `ensembles`, `agent_states`, tags, relationships |
| `0001–0003` | Schema additions and index refinements |
| `0004` | Full-text search vector on elements; Row-Level Security policies for all tables |
| `0005` | Visibility-aware RLS: public elements are readable cross-user; mutations remain owner-only |
| `0006` | Visibility-aware RLS for element tags |
| `0007` | Visibility-aware RLS for element relationships |
| `0008` | `element_provenance` table and SYSTEM user for the shared element pool |

### What happens on first run

When `DOLLHOUSE_STORAGE_BACKEND=database` and the server starts for the first time:

1. The server connects using `DOLLHOUSE_DATABASE_URL` (app role).
2. If `DOLLHOUSE_DATABASE_ADMIN_URL` is set, a short-lived admin connection opens to create the initial user row in the `users` table (the app role cannot write to `users` after RLS is applied).
3. The user is identified by OS username in stdio mode, or by the authentication layer in HTTP mode.
4. The admin connection closes. All subsequent queries use the app role connection pool.

### Connection options

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_DATABASE_URL` | *(required)* | Application database URL (app role, RLS enforced) |
| `DOLLHOUSE_DATABASE_ADMIN_URL` | *(falls back to `DOLLHOUSE_DATABASE_URL`)* | Admin database URL (superuser, for bootstrap and migrations only) |
| `DOLLHOUSE_DATABASE_POOL_SIZE` | `10` | Maximum connections in the pool |
| `DOLLHOUSE_DATABASE_SSL` | `prefer` | SSL mode: `disable`, `prefer`, or `require` |

Connection pool settings (not configurable via env, applied automatically):

- Connect timeout: 10 seconds
- Idle timeout: 20 seconds
- Maximum connection lifetime: 30 minutes

### Manual setup (managed PostgreSQL — RDS, Cloud SQL, and so on)

`npm run db:setup` requires Docker and is intended for local development. If you are using a managed PostgreSQL instance where Docker is not in the picture, set up the database manually.

**Step 1: Create the roles and database**

Connect to your PostgreSQL instance as a superuser and run:

```sql
-- Create the superuser/admin role (used for migrations)
CREATE ROLE dollhouse WITH LOGIN PASSWORD 'your-strong-password-here' SUPERUSER;

-- Create the application role (used by the running server)
CREATE ROLE dollhouse_app WITH LOGIN PASSWORD 'your-strong-app-password-here'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- Create the database
CREATE DATABASE dollhousemcp OWNER dollhouse;

-- Connect to dollhousemcp and run the init script
\c dollhousemcp
```

**Step 2: Apply permissions**

Run the contents of `docker/init-db.sql` against the `dollhousemcp` database to grant the app role its permissions.

**Step 3: Run migrations**

```bash
DOLLHOUSE_DATABASE_ADMIN_URL=postgres://dollhouse:your-strong-password-here@your-host:5432/dollhousemcp \
  npm run db:migrate
```

After migrations complete, re-apply `docker/init-db.sql` so that the grants cover the newly created tables.

### Production considerations

**Use strong passwords.** DollhouseMCP refuses to start in production (`NODE_ENV=production`) if `DOLLHOUSE_DATABASE_URL` contains the known development passwords `dollhouse` or `dollhouse_app`. It also checks the `PGPASSWORD` environment variable.

**Enable SSL.** For any non-localhost connection:

```bash
DOLLHOUSE_DATABASE_SSL=require
```

**Size the pool appropriately.** The default pool size is 10 connections. For high-traffic HTTP deployments, increase this — but stay within your database's `max_connections` limit:

```bash
DOLLHOUSE_DATABASE_POOL_SIZE=25
```

**Do not use the admin role for runtime.** Only set `DOLLHOUSE_DATABASE_ADMIN_URL` — the server uses it for bootstrap only, then discards it. Use a separate, non-superuser credential for `DOLLHOUSE_DATABASE_URL`.

### Managed Postgres providers

If you don't want to operate Postgres yourself, any standards-compliant managed provider works. Choose based on what your deployment already touches:

| Provider | Notes |
|---|---|
| **Supabase** | Postgres + connection pooler (pgbouncer) bundled. Use the direct connection string for migrations (`DOLLHOUSE_DATABASE_ADMIN_URL`) and the pooler string at runtime (`DOLLHOUSE_DATABASE_URL` with `?pgbouncer=true&connection_limit=1`). |
| **Neon** | Serverless Postgres; auto-scales, suspends on idle. Cold-start adds ~1s on first connection after suspension. Free tier sufficient for a hobbyist deploy. |
| **AWS RDS / Google Cloud SQL / Azure Database** | Standard managed Postgres. Pair with VPC peering or private IP from your app host. Use `DOLLHOUSE_DATABASE_SSL=require` (or `verify-full` if your CA is configured). |
| **Crunchy Bridge** | Postgres-experts vendor with point-in-time recovery on by default. Quality-of-life small-team option. |
| **Self-hosted on a separate VM** | You own backups, replication, version upgrades. Cheapest, most work. Use SSL `require` and firewall the PG port to your app host. |

Whatever you pick, set `DOLLHOUSE_DATABASE_SSL=require` (or stricter) and constrain `DOLLHOUSE_DATABASE_POOL_SIZE` to fit inside the provider's `max_connections` allowance — serverless providers often have lower caps than self-hosted.

For a production deploy walkthrough that includes the managed-PG bootstrap path, see the [Production Hosting Runbook](./production-hosting-runbook.md).

---

## Per-User Data Isolation

DollhouseMCP supports two mechanisms for user data isolation: filesystem layout and database Row-Level Security. They are independent and can be combined.

### Filesystem: legacy flat layout (stdio, single user)

By default, existing `~/.dollhouse/` installs use the flat layout. There is no per-user subdirectory — all data belongs to a single local user. This is correct for personal use and stdio mode.

**Legacy layout (stdio, single user):**

```
~/.dollhouse/
  portfolio/
    personas/
    skills/
    templates/
    agents/
    memories/
    ensembles/
    .backups/
  state/
  logs/
  run/
  shared/
  .auth/
  security/
```

### Filesystem: per-user layout (HTTP multi-user)

In HTTP deployments with multiple users, the filesystem uses a per-user subdirectory layout. This layout is selected automatically when:

- The server is a fresh install with no pre-existing `~/.dollhouse/` directory, **or**
- You have run `npm run migrate:per-user` on a legacy install (which writes a marker file that triggers per-user layout on the next startup).

**Per-user layout (HTTP multi-user, or migrated legacy install):**

```
~/.dollhouse/           (or ~/DollhouseMCP/ on new installs)
  users/
    <userId>/
      portfolio/
        personas/
        skills/
        templates/
        agents/
        memories/
        ensembles/
        .backups/
      state/
      auth/
      backups/
      security/
  shared/
```

Each user's data is sandboxed under their own `users/<userId>/` subtree. Path traversal outside a user's directory is blocked at the `PathValidator` level.

> **Note:** The filesystem layout is detected from disk at startup, not controlled by a configuration variable. To migrate a flat install to per-user layout, see [Migrating Existing Setups](#migrating-existing-setups).

### Database: Row-Level Security (automatic)

When using the database backend, Row-Level Security is enforced at the PostgreSQL level. No additional configuration is required — it is applied by migrations `0004` through `0008`.

How it works:

- Every query from the application role runs inside a transaction that sets `app.current_user_id` to the current user's UUID.
- RLS policies on all tables filter rows to those owned by that user, or (for read operations) rows marked `visibility = 'public'`.
- Write operations (INSERT, UPDATE, DELETE) are always owner-only. A user cannot modify another user's data even if they can read it.
- If no user context is set, the context resolves to `NULL`, which matches no rows — this is the fail-secure behavior.
- The `users` table uses a SELECT-only policy for the app role. Creating user rows requires the admin role.

Tables protected by RLS:

- `elements`
- `memory_entries`
- `ensemble_members`
- `agent_states`
- `user_settings`
- `sessions`
- `element_tags`
- `element_relationships`
- `element_provenance`
- `users` (SELECT-only for app role)

---

## Authentication

Authentication is **disabled by default**. The feature flag `DOLLHOUSE_AUTH_ENABLED` must be set to `true` to activate it. When disabled, the server behaves exactly as it always has — no tokens, no headers, no changes to existing setups.

Auth applies only to **HTTP transport**. Stdio mode is unaffected regardless of this setting.

> **When do you need this?** Enable auth when you run the HTTP server and want each connecting user to have their own isolated identity — their own database rows, their own portfolio data. Without auth, all HTTP sessions share a single anonymous identity.

### How it works

JWT (JSON Web Token) is an open standard for passing identity information as a cryptographically signed string. The client includes the token in every request using the `Authorization: Bearer <token>` HTTP header. The server validates the signature and, if valid, reads the `sub` (subject) claim as the user's identity. That `sub` maps to a row in the `users` table, which all Row-Level Security policies reference.

DollhouseMCP supports two ways to issue and validate tokens:

| Mode | Variable | Who issues tokens | When to use |
|------|----------|-------------------|-------------|
| `local` (default) | `DOLLHOUSE_AUTH_PROVIDER=local` | The server itself, using a self-signed key pair | Development, testing, single-operator deployments |
| `oidc` | `DOLLHOUSE_AUTH_PROVIDER=oidc` | An external identity provider (Auth0, Keycloak, Google, and so on) | Production, enterprise, anywhere users already have accounts |

---

### Local dev setup (recommended starting point)

The `local` provider is self-contained — no external service required. The server generates an ECDSA (ES256) key pair on first startup, saves it to `~/.dollhouse/run/auth-keypair.json`, and uses it to sign and verify tokens. The key pair is reused across restarts, so tokens you generate remain valid until they expire.

**Step 1: Enable auth**

Add one line to your environment:

```bash
DOLLHOUSE_AUTH_ENABLED=true
```

You can put this in a `.env` file alongside your other environment variables, or export it in your shell before starting the server.

**Step 2: Start the server**

```bash
DOLLHOUSE_AUTH_ENABLED=true npm run start:http
```

On startup, the server prints a ready-to-use token to stderr:

```
[DollhouseMCP Auth] Token for 'bob' (24h TTL):
  eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ0b2RkIi...

Use in MCP client config:
  "headers": { "Authorization": "Bearer eyJhbGciOiJFUzI1NiJ9..." }
```

The subject (`sub`) defaults to your OS username. Copy the token — you will use it in your MCP client configuration in the next step.

> **Note:** The startup token is printed to stderr, not stdout. This keeps it visible in your terminal without interfering with MCP's stdio protocol.

**Step 3: Add the token to your MCP client**

See [Configuring MCP clients to send tokens](#configuring-mcp-clients-to-send-tokens) below.

That is the complete local dev setup. The server auto-generates the key pair; you copy the printed token into your client config.

---

### Generating tokens for specific users

The startup token uses your OS username as the subject. For multi-user setups — or to create tokens with additional claims like a display name or email — use the `auth:token` script:

```bash
npm run auth:token -- --sub bob
```

This prints a token to stdout and a summary to stderr:

```
eyJhbGciOiJFUzI1NiJ9...

Token generated for 'bob' (TTL: 86400s)
Key file: /home/bob/.dollhouse/run/auth-keypair.json
```

**Available flags:**

| Flag | Required | Description |
|------|----------|-------------|
| `--sub <username>` | Yes | Subject — the user identity. Becomes the user's DB key. |
| `--display-name <name>` | No | Human-readable name stored in the token. |
| `--email <email>` | No | Email address stored in the token. |
| `--ttl <seconds>` | No | Token lifetime. Default: `86400` (24 hours). |
| `--key-file <path>` | No | Override the key pair file. Defaults to `~/.dollhouse/run/auth-keypair.json`. |

Examples:

```bash
# Minimal: just a subject
npm run auth:token -- --sub alice

# With display name and email
npm run auth:token -- --sub alice --display-name "Alice K" --email alice@example.com

# Long-lived token (7 days) for a service account
npm run auth:token -- --sub ci-runner --ttl 604800

# Capture the token to a variable for scripting
TOKEN=$(npm run auth:token -- --sub alice 2>/dev/null)
```

> **Important:** The `--sub` value is the permanent identity for that user. If you generate a new token for the same `--sub`, the user's existing data remains intact — the token is just a credential, not the identity itself. If you use a different `--sub`, you create a new user with an empty portfolio.

The script uses the same key pair as the running server (`~/.dollhouse/run/auth-keypair.json`). Tokens generated here are valid for that server instance.

---

### Configuring MCP clients to send tokens

Every HTTP request to the MCP endpoint must include the token in the `Authorization` header.

#### Claude Code

In your Claude Code MCP server configuration (`.claude/settings.json` or via `claude mcp add`):

```json
{
  "mcpServers": {
    "dollhousemcp": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer eyJhbGciOiJFUzI1NiJ9..."
      }
    }
  }
}
```

Replace the token value with the one printed by the server at startup or generated by `npm run auth:token`.

#### Generic HTTP client or custom integration

Add the header to every request:

```
Authorization: Bearer eyJhbGciOiJFUzI1NiJ9...
```

For SSE/EventSource clients that cannot set headers, the token can also be passed as a query parameter:

```
GET /mcp?token=eyJhbGciOiJFUzI1NiJ9...
```

#### Web console

The web console accepts both JWT tokens (the same tokens used for MCP requests) and the legacy console token (`DOLLHOUSE_TOKEN_SECRET`-based auth). Both work simultaneously — you do not need to choose one.

If the web console has auth enabled (`DOLLHOUSE_WEB_AUTH_ENABLED=true`), pass the JWT in the console's `Authorization` header the same way.

---

### OIDC provider setup

OIDC (OpenID Connect) lets users authenticate through an external identity provider — Auth0, Keycloak, Google Workspace, Azure AD, Okta, and any other standards-compliant provider. The server validates tokens issued by the provider; it does not issue tokens itself.

Set these variables:

```bash
DOLLHOUSE_AUTH_ENABLED=true
DOLLHOUSE_AUTH_PROVIDER=oidc
DOLLHOUSE_AUTH_ISSUER=https://your-tenant.auth0.com/
DOLLHOUSE_AUTH_AUDIENCE=dollhousemcp
```

`DOLLHOUSE_AUTH_ISSUER` is the base URL of your identity provider. The server fetches public keys from `<issuer>/.well-known/jwks.json` automatically. If your provider uses a non-standard JWKS path, override it:

```bash
DOLLHOUSE_AUTH_JWKS_URI=https://your-tenant.example.com/custom/jwks
```

The token's `sub` claim becomes the user's identity in DollhouseMCP. Most providers use a stable, opaque ID (for example, `auth0|64abc123`) — this becomes the user's key in the database.

#### Optional: enforce RFC 9068 `typ: at+jwt` (`DOLLHOUSE_AUTH_OIDC_REQUIRE_TYP`)

The OIDC bridge validates every incoming JWT against the configured issuer + audience + signing algorithm allowlist + the `mcp` scope. By default it does **not** require the RFC 9068 `typ: at+jwt` header, because many managed IdPs (Auth0, Okta, Keycloak, AWS Cognito) do not stamp `typ` on access tokens. Hard-requiring it would break those deployments.

Set this to `true` if your IdP **does** stamp `typ: at+jwt`:

```bash
DOLLHOUSE_AUTH_OIDC_REQUIRE_TYP=true
```

**Why you might want it on.** Some IdPs issue both `id_token` and access-token JWTs for the same audience. id_tokens commonly carry `typ: JWT` or no `typ` at all, and depending on your IdP's configuration they may also surface scopes including `mcp` (Auth0 with custom claims, Keycloak with mapper rules). Without typ enforcement an id_token can satisfy the resource-server check and be replayed as an access token. When your IdP supports `typ: at+jwt`, enabling this option closes the gap.

**Verify before flipping it on.** Mint a token from your IdP and decode it:

```bash
curl -s "$ISSUER/.well-known/openid-configuration" | jq .id_token_signing_alg_values_supported
# obtain an access token via your IdP, then:
echo "$ACCESS_TOKEN" | cut -d. -f1 | base64 -d | jq .typ
```

If `.typ` is `"at+jwt"`, you can enable the option. If it's `"JWT"` or missing, leave the option off (default) until you can configure your IdP to stamp the access-token typ.

#### Auth0 example

1. In the Auth0 dashboard, create a new **API**:
   - Identifier: `dollhousemcp` (this becomes your audience)
   - Signing algorithm: RS256

2. In your Auth0 application settings, note your tenant domain (for example, `your-tenant.auth0.com`).

3. Configure the server:

```bash
DOLLHOUSE_AUTH_ENABLED=true
DOLLHOUSE_AUTH_PROVIDER=oidc
DOLLHOUSE_AUTH_ISSUER=https://your-tenant.auth0.com/
DOLLHOUSE_AUTH_AUDIENCE=dollhousemcp
```

4. Obtain a token for a user via the Auth0 Management API or device authorization flow, then pass it to your MCP client as shown above.

#### Keycloak example

1. In Keycloak, create a new **Client** (for example, `dollhousemcp`) with "Service accounts" enabled.

2. Note your realm name and Keycloak base URL.

3. Configure the server:

```bash
DOLLHOUSE_AUTH_ENABLED=true
DOLLHOUSE_AUTH_PROVIDER=oidc
DOLLHOUSE_AUTH_ISSUER=https://keycloak.example.com/realms/your-realm
DOLLHOUSE_AUTH_AUDIENCE=dollhousemcp
```

Keycloak's JWKS endpoint is derived automatically as `https://keycloak.example.com/realms/your-realm/.well-known/jwks.json`.

---

### Embedded authorization server (`DOLLHOUSE_AUTH_PROVIDER=embedded`)

The `embedded` provider runs a full OAuth 2.1 / OIDC authorization server **inside this server** — no external IdP needed. This is the production target shape: hosted multi-tenant with PostgreSQL storage, multi-method authentication (GitHub, magic-link email, local passwords, or trivial-consent for solo dev), atomic refresh-token rotation, and admin-bootstrap CLI.

> **Operator runbook:** [auth-server-setup.md](./auth-server-setup.md) walks through the four common setup paths (solo localhost smoke test, local-password on filesystem, github on filesystem, full Postgres-backed) end-to-end including bootstrap, tunnels, reverse-proxy, native HTTPS, and verification. The section below is the env-var reference.

#### Choosing methods

```
DOLLHOUSE_AUTH_PROVIDER=embedded
DOLLHOUSE_AUTH_METHODS=github
```

Comma-separated list. Multi-method deployments expose all methods at the same `/interaction` endpoint and present a chooser. Recognized values:

| Method | Use case | Required setup |
|---|---|---|
| `github` | Hosted, users sign in with GitHub | Register GitHub OAuth app (web flow with callback URL); set `DOLLHOUSE_AUTH_GITHUB_CLIENT_ID` + `DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET`. The legacy `DOLLHOUSE_GITHUB_CLIENT_ID` / `_SECRET` pair (originally for portfolio sync) still works as a fallback with a deprecation warning. |
| `local-password` | Self-hosted, operator-issued accounts | None at the env level — admin uses `dollhouse-create-user` to issue invite URLs |
| `magic-link` | Hosted, email-based passwordless | SMTP config (`DOLLHOUSE_SMTP_*`) |
| `trivial-consent` | Solo localhost dev only | None — refuses to start on non-loopback bind |

#### TLS termination

Two supported deployment shapes:

**Native HTTPS** (TLS at this server, no upstream proxy):
```
DOLLHOUSE_TLS_CERT_PATH=/path/to/cert.pem
DOLLHOUSE_TLS_KEY_PATH=/path/to/key.pem
DOLLHOUSE_TRUSTED_PROXIES=loopback
```
The `loopback` keyword tells Express to ignore X-Forwarded-* headers from external clients. `req.ip` resolves to the TCP peer.

**Behind a TLS-terminating reverse proxy** (Cloudflare Tunnel, nginx, ALB, Cloud Run):
```
# Do NOT set DOLLHOUSE_TLS_CERT_PATH / KEY_PATH (proxy handles TLS)
DOLLHOUSE_TRUSTED_PROXIES=10.0.0.0/8   # the proxy's CIDR range
DOLLHOUSE_PUBLIC_BASE_URL=https://your.deployment.example
```

The startup safety guard (`assertHostedDeploymentSafety`) refuses to start in misconfigured states with operator-actionable error messages: it requires `DOLLHOUSE_AUTH_ENABLED=true` and a non-empty `DOLLHOUSE_TRUSTED_PROXIES` whenever you bind to a non-loopback host with a multi-user method configured. Setting `loopback`-only without native TLS while bound to a non-loopback host is also refused — that combination silently collapses per-IP rate limits to the proxy's egress IP.

#### Bootstrap

Multi-user methods refuse to serve auth flows until an operator pre-claims the admin identity. This eliminates the "first-to-arrive becomes admin" race.

For GitHub or magic-link:
```
dollhouse-admin-bootstrap --method github --github-username <name>
# OR
dollhouse-admin-bootstrap --method magic-link --email <admin@example.com>
```

For local-password, the first invocation of `dollhouse-create-user` auto-claims:
```
dollhouse-create-user --username admin --email admin@example.com
```

`/readyz` returns 503 with `reason: "bootstrap_required"` until the bootstrap completes — Kubernetes will hold traffic correctly. After bootstrap, `/readyz` returns 200 and the admin's first sign-in stamps `roles: ["admin"]` on their JWT.

#### Storage backend

```
DOLLHOUSE_AUTH_STORAGE_BACKEND=postgres   # 'memory' | 'filesystem' | 'postgres'
DOLLHOUSE_STORAGE_BACKEND=database         # required alongside auth=postgres
DOLLHOUSE_DATABASE_URL=postgres://...
```

`postgres` is the recommended production target. `filesystem` is the default for solo / small-team deployments. `memory` is dev/test only — refuses to run with durable methods (`local-password`, `magic-link`) unless `DOLLHOUSE_ALLOW_MEMORY_AUTH_STORAGE=true` is set explicitly.

#### Signing secrets — multi-replica HA

For deployments running multiple replicas behind a load balancer, set the signing secrets via env so every replica reads the same key:

```
DOLLHOUSE_COOKIE_SIGNING_SECRET=<64+ hex chars>   # generate via:
                                                   # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
DOLLHOUSE_INVITE_TOKEN_SECRET=<base64 secret>     # for invite + magic-link tokens
```

Without these, each replica generates its own keys at first run and stores them in the run directory. Single-replica deployments are unaffected; multi-replica without env-var secrets produces non-deterministic JWKS and revoked refresh-token sessions on rotation. Multi-replica HA has additional limitations beyond signing-secret sharing (rate limits are per-replica; mode-switch invalidation can race across replicas; key rotation is not coordinated) — these are documented separately and tracked as follow-up work.

The `DOLLHOUSE_COOKIE_SIGNING_SECRET` value is also used as the HMAC salt for IP/UA hashes when the optional `refreshRotationCheckIpUa: true` rotation-grace IP/UA gate is enabled.

#### Refresh-token rotation grace

Time-only grace window (industry-standard pattern from Auth0, better-auth, Apideck): a consumed refresh token's `consumed` marker stays hidden from `find()` for 30 seconds, so legitimate concurrent rotations succeed. Configurable via `EmbeddedAuthorizationServerOptions.refreshRotationGraceMs`. Optional IP/UA-bound gating via `refreshRotationCheckIpUa: true` (off by default — NAT/CGNAT realities make per-IP gating unreliable for legitimate users). DPoP (RFC 9449) sender-binding is a planned follow-up.

#### Disaster recovery

See `/dollhouse/docs/SECTION-8.1-DR-RUNBOOK.md` (filesystem-only) for backup/restore procedures covering the four critical state pieces: auth tables (Postgres), JWKS signing keyfile, cookie signing secret, invite token secret.

---

### What changes when auth is enabled

| Endpoint | Auth required? |
|----------|---------------|
| `POST /mcp` | Yes — 401 without a valid Bearer token |
| `GET /healthz` | No — always public |
| `GET /readyz` | No — always public (returns 503 pre-bootstrap when embedded AS is in multi-user mode) |
| `GET /version` | No — always public |
| `GET /auth/admin/me` | Yes — 401 without admin role (embedded AS only) |
| `/.well-known/oauth-*` | No — always public (embedded AS only) |
| Web console (`/`) | Depends on `DOLLHOUSE_WEB_AUTH_ENABLED` |

- **Stdio mode is completely unaffected.** Auth has no effect on stdio connections regardless of how `DOLLHOUSE_AUTH_ENABLED` is set.
- **User creation is automatic.** When a valid token reaches the server for the first time, the server creates a user row in the database (using the admin connection) and sets up that user's data space. No manual user provisioning is needed.
- **The `sub` claim is permanent.** Changing the `sub` for a user effectively creates a new user. Existing data stays associated with the original `sub`.
- **Tokens are validated on every request.** There is no session-level caching of auth state — each request validates its token independently.

---

### Authentication environment variables

> **Boolean env var behavior:** Boolean variables use strict parsing. Only `'true'` and `'1'` are treated as true. Any other non-empty value — including `'false'` — is treated as false. Earlier versions treated any non-empty string as true; this has been corrected.

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_AUTH_ENABLED` | `false` | Master switch. Set to `true` to enable token authentication on HTTP endpoints. |
| `DOLLHOUSE_AUTH_PROVIDER` | `local` | Auth provider: `local` (self-signed JWTs), `oidc` (external IdP), or `embedded` (full OAuth 2.1 / OIDC AS in-process). |
| `DOLLHOUSE_AUTH_ISSUER` | *(unset)* | OIDC issuer URL. **Required when `DOLLHOUSE_AUTH_PROVIDER=oidc`**. |
| `DOLLHOUSE_AUTH_AUDIENCE` | *(unset)* | Expected `aud` claim. **Required when `DOLLHOUSE_AUTH_PROVIDER=oidc`**. |
| `DOLLHOUSE_AUTH_JWKS_URI` | *(auto-derived)* | JWKS endpoint. Defaults to `<issuer>/.well-known/jwks.json`. Override only if your provider uses a non-standard path. |
| `DOLLHOUSE_AUTH_OIDC_REQUIRE_TYP` | `false` | When `true`, require RFC 9068 `typ: at+jwt` on incoming JWTs. Default off because many managed IdPs (Auth0, Okta, Keycloak, AWS Cognito) don't stamp typ on access tokens — hard-requiring it would break those deployments. Enable for hardening when your IdP stamps the typ; see [OIDC provider setup → Optional: enforce RFC 9068](#optional-enforce-rfc-9068-typ-atjwt-dollhouse_auth_oidc_require_typ) for the verification procedure. |
| `DOLLHOUSE_AUTH_LOCAL_KEY_FILE` | `~/.dollhouse/run/auth-keypair.json` | Key pair file for the local provider. Auto-generated on first use. |
| `DOLLHOUSE_AUTH_LOCAL_DEFAULT_SUB` | *(OS username)* | Subject for the startup convenience token printed to stderr. Defaults to your OS username. |

#### Embedded authorization server (`DOLLHOUSE_AUTH_PROVIDER=embedded`)

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_AUTH_METHODS` | `trivial-consent` | Comma-separated list. Recognized: `github`, `magic-link`, `local-password`, `trivial-consent`. Multi-method deployments expose all configured methods at the same `/interaction` endpoint. |
| `DOLLHOUSE_PUBLIC_BASE_URL` | *(derived from bind)* | Public-facing base URL of this server. **Required behind a reverse proxy** so issued JWTs and `/.well-known/*` documents advertise the correct public origin. |
| `DOLLHOUSE_AUTH_STORAGE_BACKEND` | `filesystem` | One of `memory`, `filesystem`, `postgres`. `postgres` requires `DOLLHOUSE_STORAGE_BACKEND=database` and `DOLLHOUSE_DATABASE_URL` to be set. |
| `DOLLHOUSE_ALLOW_MEMORY_AUTH_STORAGE` | `false` | Required to be `true` for `BACKEND=memory` when durable methods (`local-password`, `magic-link`) are configured — otherwise refused at startup, since password hashes and pending invites would silently disappear on restart. Dev/test only. |
| `DOLLHOUSE_COOKIE_SIGNING_SECRET` | *(per-replica random)* | 64+ hex chars used to sign /interaction session cookies AND as the HMAC salt for IP/UA hashes. **Required for multi-replica HA** — without it, each replica generates its own key, so cross-replica session cookies fail to verify. Generate via `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `DOLLHOUSE_INVITE_TOKEN_SECRET` | *(per-replica random)* | Base64 secret used to sign invite + magic-link tokens. **Required for multi-replica HA** — without it, an invite issued by replica A can't be redeemed on replica B. |
| `DOLLHOUSE_AUTH_GITHUB_CLIENT_ID` | *(unset)* | GitHub OAuth app client ID for the embedded-AS user-auth flow. **Required when `github` is in `DOLLHOUSE_AUTH_METHODS`.** Register a web-flow OAuth app at <https://github.com/settings/developers> with the callback URL `<DOLLHOUSE_PUBLIC_BASE_URL>/auth/social/github/callback`. Falls back to the legacy `DOLLHOUSE_GITHUB_CLIENT_ID` (with a deprecation warning) when unset, so existing deployments don't break. |
| `DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET` | *(unset)* | GitHub OAuth app client secret for the embedded-AS user-auth flow. **Required when `github` is in `DOLLHOUSE_AUTH_METHODS`.** Treat as a deployment secret. Falls back to the legacy `DOLLHOUSE_GITHUB_CLIENT_SECRET` when unset. |
| `DOLLHOUSE_GITHUB_CLIENT_ID` | *(unset)* | Legacy GitHub OAuth client ID. Originally introduced for the portfolio-sync feature (server → GitHub, device flow). Still used by `setup_github_auth`; also serves as the user-auth fallback when `DOLLHOUSE_AUTH_GITHUB_CLIENT_ID` is unset. |
| `DOLLHOUSE_GITHUB_CLIENT_SECRET` | *(unset)* | Legacy GitHub OAuth client secret. User-auth fallback only — portfolio-sync device flow does not need a secret. |
| `DOLLHOUSE_TLS_CERT_PATH` | *(unset)* | Path to TLS certificate (PEM). Setting this AND `DOLLHOUSE_TLS_KEY_PATH` enables native HTTPS termination on this server. Leave unset when terminating TLS at an upstream proxy. |
| `DOLLHOUSE_TLS_KEY_PATH` | *(unset)* | Path to TLS private key (PEM). Permissions must be 0600 or stricter. |
| `DOLLHOUSE_TRUSTED_PROXIES` | `loopback` | Express `trust proxy` setting that controls how `req.ip` resolves. `loopback` for native-HTTPS deployments; explicit CIDR (e.g. `10.0.0.0/8`) for hosted deployments behind a reverse proxy. **Misconfiguring this collapses per-IP rate limits to the proxy's egress IP.** |
| `DOLLHOUSE_AUTH_OPEN_DCR` | `false` | When `true`, the `/reg` Dynamic Client Registration endpoint accepts unauthenticated registrations (no Initial Access Token required). **Localhost-only dev escape hatch** for MCP clients that auto-register without an IAT (Gemini CLI, claude.ai web). Default-off is the production shape. See [Dynamic Client Registration](#dynamic-client-registration-dollhouse_auth_open_dcr) for the trade-off and remote-deployment guidance. |

> **Operator action — multi-replica HA:** if `DOLLHOUSE_AUTH_STORAGE_BACKEND=postgres` is set without `DOLLHOUSE_COOKIE_SIGNING_SECRET` and `DOLLHOUSE_INVITE_TOKEN_SECRET`, the server logs a warning at startup that brute-force protection is per-replica and that interaction sessions will not survive cross-replica routing. Set both env vars to the same value across all replicas.

#### Dynamic Client Registration (`DOLLHOUSE_AUTH_OPEN_DCR`)

The embedded AS supports RFC 7591 Dynamic Client Registration at `/reg`. MCP clients that don't have a pre-registered client_id — including Gemini CLI and claude.ai's web client — auto-register here on first connection to obtain a `client_id` they can use through the OAuth flow.

DCR has two operating modes:

**Default (`DOLLHOUSE_AUTH_OPEN_DCR=false`) — IAT-gated.** `/reg` requires an Initial Access Token (IAT) as a bearer credential. Random callers on the network cannot register clients. This is the production-target shape because it prevents a hostile caller from registering a client with an attacker-controlled `redirect_uri` and harvesting authorization codes intended for legitimate users. **IAT issuance is currently a deferred admin-channel feature** (see `L-R5-13` in `SECTION-8.1-STATUS.md`), so this mode effectively rejects MCP clients that don't already know a pre-registered `client_id`.

**Escape hatch (`DOLLHOUSE_AUTH_OPEN_DCR=true`) — open registration.** `/reg` accepts unauthenticated registrations. Any caller who can reach the endpoint can self-register. Use this **only on loopback dev** where the AS is unreachable from the network.

```bash
# Localhost smoke test with Gemini CLI / claude.ai web:
DOLLHOUSE_AUTH_OPEN_DCR=true
DOLLHOUSE_HTTP_HOST=127.0.0.1
```

**Do not enable this on a deployment exposed to the public internet.** A remote attacker would be able to register a client with `redirect_uri=https://attacker.example.com/cb` and use that registration to phish authorization codes from legitimate user OAuth flows on your AS. Three paths exist for remote deployments that need MCP-client DCR support:

1. **Tunnel the local AS** (Cloudflare Tunnel, ngrok). AS still binds loopback, `DOLLHOUSE_AUTH_OPEN_DCR=true` stays safe (nobody hits `/reg` directly — they hit the tunnel which proxies). MCP clients connect to the tunnel URL. This is the documented `npx dollhousemcp` shape.

2. **Wait for constrained DCR.** Planned for §8.2: oidc-provider `features.registration.policies` to enforce `application_type: 'native'` + loopback-only `redirect_uris`. Lets Gemini CLI register but rejects attacker registrations regardless of network position.

3. **Pre-registered client (no DCR).** The embedded AS pre-registers `DEFAULT_CLIENT_ID = 'dollhouse-claude-connector'` with native-app loopback policy. Claude Desktop and Claude Code can be configured to use this fixed `client_id` and skip DCR entirely. Gemini CLI does not currently expose configuration for a fixed `client_id`.

Pre-cycle-24 deployments left DCR gated and the smoke-test of an MCP client that auto-registers (Gemini CLI) surfaced this gap. The cycle-24 docs above are the operator-facing answer.

> **Operator action — admin bootstrap:** before the embedded AS will serve auth flows in any non-`trivial-consent` method, an operator must pre-claim the admin identity via `dollhouse-admin-bootstrap` (for `github` / `magic-link`) or via the first invocation of `dollhouse-create-user` (for `local-password`). `/readyz` returns 503 with `reason: "bootstrap_required"` until this completes.

---

## Shared Pool and Public Elements

The shared pool is an opt-in feature that allows operators to seed a set of public elements discoverable by all users on a deployment.

> **Default:** The shared pool is disabled. Enable it with `DOLLHOUSE_SHARED_POOL_ENABLED=true`.

### What works today

- **Discovery:** Users can include public elements in search results using the `include_public` flag in `list_elements` and search operations.
- **Collection install to pool:** Operators can install elements from the DollhouseMCP community collection directly into the shared pool.
- **Deployment seeds:** Operators can place seed elements in a directory and have them loaded into the pool at startup (configured via `DOLLHOUSE_SHARED_POOL_DIR`).
- **Provenance tracking:** The `element_provenance` table records the origin, source URL, version, and content hash for every shared element. Duplicate installs are detected at the database level.

### What is not yet available

There is currently no user-facing flow for a regular user to publish their own element to the shared pool. Element promotion to the shared pool is an operator task.

### How to seed the shared pool

Place element files in the directory pointed to by `DOLLHOUSE_SHARED_POOL_DIR`. On startup, DollhouseMCP loads these files as shared elements owned by the internal SYSTEM user (`dollhousemcp-system`). Once loaded, they are visible to all users via `include_public` queries.

```bash
DOLLHOUSE_SHARED_POOL_ENABLED=true
DOLLHOUSE_SHARED_POOL_DIR=/etc/dollhousemcp/pool
```

### Custom collection URL

By default, `install_collection_content` fetches from the DollhouseMCP GitHub collection. To point at a self-hosted or private collection:

```bash
DOLLHOUSE_COLLECTION_URL=https://your-collection.example.com
DOLLHOUSE_COLLECTION_ALLOWLIST=your-collection.example.com
```

---

## Migrating Existing Setups

### Flat filesystem to per-user filesystem layout

If you have an existing single-user `~/.dollhouse/` installation and want to move to the per-user layout (required for HTTP multi-user deployments on the filesystem backend), use the `migrate:per-user` CLI tool.

**Before migration — legacy flat layout:**

```
~/.dollhouse/
  portfolio/
    personas/
    skills/
    templates/
    agents/
    memories/
    ensembles/
    .backups/
  state/
  logs/
  run/
  shared/
  .auth/
  security/
```

**After migration — per-user layout:**

```
~/.dollhouse/
  users/
    <userId>/
      portfolio/
        personas/
        skills/
        templates/
        agents/
        memories/
        ensembles/
        .backups/
      state/
      auth/
      backups/
      security/
  shared/
  .dollhouse-per-user-migrated   ← marker file; triggers per-user layout on next startup
```

The migration moves your portfolio, state, auth, and security directories from the flat layout into a per-user subtree under `~/.dollhouse/users/<userId>/`. It does not delete your original files until each move succeeds, and it writes the marker file (`.dollhouse-per-user-migrated`) when complete. Partial runs are safe to retry — moves that already succeeded are skipped.

**The migration is not automatic.** It is triggered explicitly from the command line:

```bash
# Check whether migration is needed
npm run migrate:per-user -- status

# Preview what would be moved (dry run — no changes)
npm run migrate:per-user -- preview

# Perform the migration
npm run migrate:per-user -- execute
```

Options:

| Flag | Default | Description |
|------|---------|-------------|
| `--user-id <id>` | `local-user` | Target user ID to migrate data into |
| `--home-dir <dir>` | OS home directory | Override home directory detection |

To migrate data into a specific user ID:

```bash
npm run migrate:per-user -- execute --user-id alice
```

Once the marker file exists, the migration will not run again. The tool is idempotent — re-running it after completion exits cleanly with no changes.

> **Note:** This operation was previously available as the `migrate_portfolio_layout` MCP-AQL operation. That operation has been removed. Migration is now CLI-only, which prevents an LLM session from accidentally triggering a data restructure.

### Filesystem to database (file → database)

Use `npm run db:import` to copy existing filesystem portfolio content into PostgreSQL. When you switch `DOLLHOUSE_STORAGE_BACKEND` from `file` to `database`, the database starts empty — `db:import` is the supported path for bringing your existing elements across.

The import uses upserts, so it is safe to re-run. Your filesystem files are not modified or deleted.

#### Importing your portfolio

```bash
# Preview what would be imported (no changes)
npm run db:import -- --dry-run

# Import from the default portfolio directory
npm run db:import

# Import from a specific directory
npm run db:import -- --portfolio-dir /path/to/portfolio

# Import with per-element output
npm run db:import -- --verbose
```

Required environment variables:

```bash
DOLLHOUSE_DATABASE_URL=postgres://dollhouse_app:password@localhost:5432/dollhousemcp
DOLLHOUSE_DATABASE_ADMIN_URL=postgres://dollhouse:password@localhost:5432/dollhousemcp
```

The import resolves user identity from the OS username via `bootstrapDatabase()`, the same mechanism the server uses on first run. All element types are supported, including memories (with full entry sync).

#### Exporting your portfolio from the database

Use `npm run db:export` to write elements from the database back to the filesystem. The export reads the raw stored content, so the round-trip is lossless — files are byte-identical after an import followed by an export.

```bash
# Preview what would be exported (no changes)
npm run db:export -- --dry-run

# Export to the default portfolio directory
npm run db:export

# Export to a specific directory (for backups)
npm run db:export -- --output-dir /tmp/dollhouse-backup

# Export only skills and personas
npm run db:export -- --type skills --type personas

# Export a specific element by name
npm run db:export -- --name "code-reviewer"

# Export multiple named elements
npm run db:export -- --name "code-reviewer" --name "architect"

# Overwrite existing files (default: skip files that already exist)
npm run db:export -- --output-dir /tmp/backup --overwrite

# Show per-file details
npm run db:export -- --verbose
```

Valid values for `--type`: `personas`, `skills`, `templates`, `agents`, `memories`, `ensembles`.

Both `--type` and `--name` can be specified together to narrow the export to a specific subset.

There is no risk of data loss during a filesystem-to-database switch — the filesystem portfolio remains intact throughout. The backends are independent; switching `DOLLHOUSE_STORAGE_BACKEND` does not modify or delete filesystem files.

### Stdio to HTTP transport

Switching transport does not affect your portfolio content. Transport and storage are independent axes.

What changes when you switch from stdio to HTTP:

- **User identity.** In stdio mode, the user is identified by OS username. In HTTP mode, identity comes from the authentication layer. If you are using filesystem storage, all HTTP sessions share a single user identity (the same portfolio). If you are using the database backend, each authenticated user gets their own row.
- **Session lifecycle.** Stdio sessions end when the client process exits. HTTP sessions persist until idle timeout (`DOLLHOUSE_HTTP_SESSION_IDLE_TIMEOUT_MS`, default 15 minutes) and can be resumed by reconnecting before the timeout.
- **Activation state.** Active personas, skills, and other elements are tracked per-session in HTTP mode. If a session expires and a client reconnects, activation state starts fresh.
- **Configuration.** You must set `DOLLHOUSE_TRANSPORT=streamable-http` and decide on a bind address and port. For anything beyond localhost, set `DOLLHOUSE_HTTP_ALLOWED_HOSTS`.

There are no data format differences between the two transports. Your portfolio files and database records are the same regardless of how clients connect.

---

## Environment Variable Reference

All variables are optional unless marked **required**. Variables with no default shown require explicit configuration before the feature they control will work.

> **Boolean env var behavior:** Variables documented with `true` or `false` defaults use strict parsing — only `'true'` and `'1'` are treated as true. Setting `DOLLHOUSE_AUTH_ENABLED=false` correctly disables auth; setting it to any other non-`'true'` value also disables it.

### General

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Runtime environment: `development`, `test`, or `production` |
| `LOG_LEVEL` | `info` | Log verbosity: `error`, `warn`, `info`, `debug` |
| `PORT` | `3000` | Legacy port variable (prefer `DOLLHOUSE_HTTP_PORT` for HTTP mode) |
| `ENABLE_DEBUG` | `false` | Enable verbose debug output |

### GitHub integration

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | *(unset)* | Personal access token for GitHub portfolio sync and collection operations |
| `GITHUB_USERNAME` | *(unset)* | GitHub username for portfolio sync |
| `GITHUB_REPOSITORY` | *(unset)* | GitHub repository name for portfolio sync |

### Transport

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_TRANSPORT` | `stdio` | Transport mode: `stdio` or `streamable-http` |
| `DOLLHOUSE_HTTP_HOST` | `127.0.0.1` | HTTP bind address. Set to `0.0.0.0` inside containers. |
| `DOLLHOUSE_HTTP_PORT` | `3000` | HTTP server port |
| `DOLLHOUSE_HTTP_MCP_PATH` | `/mcp` | URL path for the MCP endpoint |
| `DOLLHOUSE_HTTP_ALLOWED_HOSTS` | *(unset)* | Comma-separated Host header allowlist. Required when binding to `0.0.0.0`. |
| `DOLLHOUSE_HTTP_RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in milliseconds |
| `DOLLHOUSE_HTTP_RATE_LIMIT_MAX_REQUESTS` | `300` | Maximum requests per client per window |
| `DOLLHOUSE_HTTP_SESSION_IDLE_TIMEOUT_MS` | `900000` | Session idle timeout in milliseconds. `0` disables the timeout. |
| `DOLLHOUSE_HTTP_SESSION_POOL_SIZE` | `0` | Pre-warmed session pool size. `0` disables pooling. |
| `DOLLHOUSE_HTTP_WEB_CONSOLE` | `true` | Start the web console when running in HTTP mode |

### Storage and database

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_STORAGE_BACKEND` | `file` | Storage backend: `file` or `database` |
| `DOLLHOUSE_DATABASE_URL` | *(unset)* | **Required for database mode.** PostgreSQL connection URL for the app role (RLS enforced). |
| `DOLLHOUSE_DATABASE_ADMIN_URL` | *(falls back to `DOLLHOUSE_DATABASE_URL`)* | PostgreSQL connection URL for the admin role (superuser, used for bootstrap and migrations only). |
| `DOLLHOUSE_DATABASE_POOL_SIZE` | `10` | Maximum database connection pool size (1–100) |
| `DOLLHOUSE_DATABASE_SSL` | `prefer` | SSL mode: `disable`, `prefer`, or `require` |

### Path overrides

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_PORTFOLIO_DIR` | *(platform default — see [Directory layout](#directory-layout))* | Portfolio root directory. Must be an absolute path. |
| `DOLLHOUSE_CONFIG_DIR` | *(platform default)* | Config directory. Must be an absolute path. |
| `DOLLHOUSE_CACHE_DIR` | *(platform default)* | Cache directory. Must be an absolute path. |
| `DOLLHOUSE_STATE_DIR` | *(platform default)* | State directory. Must be an absolute path. |
| `DOLLHOUSE_LOG_DIR` | `~/.dollhouse/logs/` | Log directory. Must be an absolute path. |
| `DOLLHOUSE_RUN_DIR` | *(platform default)* | Runtime files directory. Must be an absolute path. |
| `DOLLHOUSE_SHARED_POOL_DIR` | *(unset)* | Directory containing seed elements for the shared pool. |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_AUTH_ENABLED` | `false` | Enable token authentication on HTTP endpoints. Has no effect on stdio mode. |
| `DOLLHOUSE_AUTH_PROVIDER` | `local` | Auth provider: `local`, `oidc`, or `embedded`. See [Choosing an auth provider](#choosing-an-auth-provider). |
| `DOLLHOUSE_AUTH_ISSUER` | *(unset)* | OIDC issuer URL. Required when `DOLLHOUSE_AUTH_PROVIDER=oidc`. |
| `DOLLHOUSE_AUTH_AUDIENCE` | *(unset)* | Expected `aud` claim. Required when `DOLLHOUSE_AUTH_PROVIDER=oidc`. |
| `DOLLHOUSE_AUTH_JWKS_URI` | *(auto-derived from issuer)* | JWKS endpoint URL. Override only if your provider uses a non-standard path. |
| `DOLLHOUSE_AUTH_LOCAL_KEY_FILE` | `~/.dollhouse/run/auth-keypair.json` | Key pair file for the local provider. Auto-generated on first use. |
| `DOLLHOUSE_AUTH_LOCAL_DEFAULT_SUB` | *(OS username)* | Subject used for the startup convenience token printed to stderr. |
| `DOLLHOUSE_AUTH_METHODS` | `trivial-consent` | Embedded AS only. Comma-separated: `github`, `magic-link`, `local-password`, `trivial-consent`. |
| `DOLLHOUSE_AUTH_STORAGE_BACKEND` | `filesystem` | Embedded AS only. One of `memory`, `filesystem`, `postgres`. |
| `DOLLHOUSE_ALLOW_MEMORY_AUTH_STORAGE` | `false` | Embedded AS only. Required to be `true` for `BACKEND=memory` with durable methods. Dev/test only. |
| `DOLLHOUSE_PUBLIC_BASE_URL` | *(derived)* | Embedded AS only. Public-facing base URL. Required behind a reverse proxy. |
| `DOLLHOUSE_COOKIE_SIGNING_SECRET` | *(per-replica random)* | Embedded AS only. 64+ hex chars. Required for multi-replica HA. |
| `DOLLHOUSE_INVITE_TOKEN_SECRET` | *(per-replica random)* | Embedded AS only. Base64 secret for invite + magic-link tokens. Required for multi-replica HA. |
| `DOLLHOUSE_AUTH_GITHUB_CLIENT_ID` | *(unset)* | Embedded AS only. User-auth (web flow). Required when `github` is in `DOLLHOUSE_AUTH_METHODS`. |
| `DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET` | *(unset)* | Embedded AS only. User-auth secret. Required when `github` is in `DOLLHOUSE_AUTH_METHODS`. Deployment secret. |
| `DOLLHOUSE_GITHUB_CLIENT_ID` | *(unset)* | Legacy: portfolio-sync device flow. Also user-auth fallback when the AUTH-prefixed var is unset. |
| `DOLLHOUSE_GITHUB_CLIENT_SECRET` | *(unset)* | Legacy: user-auth fallback only. |
| `DOLLHOUSE_TLS_CERT_PATH` | *(unset)* | Path to TLS certificate (PEM). Enables native HTTPS termination. Leave unset when terminating TLS at an upstream proxy. |
| `DOLLHOUSE_TLS_KEY_PATH` | *(unset)* | Path to TLS private key (PEM). Permissions must be 0600 or stricter. |
| `DOLLHOUSE_TRUSTED_PROXIES` | `loopback` | Express `trust proxy` setting. Use explicit CIDR (e.g. `10.0.0.0/8`) when behind a reverse proxy. |

### Web console

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_WEB_CONSOLE` | `true` | Enable the unified web console (logs and metrics tabs) |
| `DOLLHOUSE_WEB_CONSOLE_PORT` | `41715` | Port the web console binds to |
| `DOLLHOUSE_WEB_AUTH_ENABLED` | `false` | Require Bearer token authentication on the web console API |
| `DOLLHOUSE_CONSOLE_TOKEN_FILE` | *(under `~/.dollhouse/run/`)* | Override the console token file location |
| `DOLLHOUSE_CONSOLE_LEADER_LOCK_FILE` | *(under `~/.dollhouse/run/`)* | Override the leader election lock file location |
| `DOLLHOUSE_CONSOLE_ROTATION_REQUIRE_CONFIRMATION` | `true` | Require confirmation for token rotation. Set to `false` for headless CI. |
| `DOLLHOUSE_CONSOLE_MAX_FORWARD_FAILURES` | `10` | Failures before a follower attempts self-promotion as leader |
| `DOLLHOUSE_CONSOLE_BIND_RETRY_DELAYS` | *(unset)* | Comma-separated backoff delays in ms for port bind retries (default: `1000,2000,4000`) |

### MCP interface

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_INTERFACE_MODE` | `mcpaql` | Tool interface mode: `mcpaql` (recommended) or `discrete` (legacy v1 tool names) |
| `MCP_AQL_ENDPOINT_MODE` | `crude` | MCP-AQL endpoint style: `crude` (5 CRUDE endpoints, ~4,300 tokens) or `single` (1 endpoint, ~350 tokens) |

### Security

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_GATEKEEPER_ENABLED` | `true` | Enable the Gatekeeper permission enforcement pipeline |
| `DOLLHOUSE_GATEKEEPER_ELEMENT_POLICY_OVERRIDES` | `true` | Allow active elements to override default permission levels |
| `DOLLHOUSE_POLICY_EXPORT_ENABLED` | `true` | Export security policy blueprint to disk on activation changes |
| `DOLLHOUSE_PERMISSION_SERVER` | `true` | Start the HTTP permission evaluation server for PreToolUse hooks |
| `DOLLHOUSE_TOKEN_SECRET` | *(unset)* | Minimum 32-character secret for token encryption. Strongly recommended for shared or multi-user environments. |
| `DOLLHOUSE_DISABLE_ENCRYPTION` | `false` | Disable memory pattern encryption |
| `DOLLHOUSE_ENCRYPTION_SECRET` | *(unset)* | Secret for memory pattern encryption |
| `DOLLHOUSE_ENCRYPTION_SALT` | *(unset)* | Salt for memory pattern encryption |

### Shared pool and collection

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_SHARED_POOL_ENABLED` | `false` | Enable the shared public element pool |
| `DOLLHOUSE_COLLECTION_URL` | *(unset)* | Override the upstream collection base URL |
| `DOLLHOUSE_COLLECTION_ALLOWLIST` | *(unset)* | Comma-separated additional hostnames for the GitHub client SSRF allowlist |
| `DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION` | `false` | Automatically submit created elements to the community collection |

### Storage layer tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_SCAN_COOLDOWN_MS` | `1000` | Minimum milliseconds between portfolio directory scans |
| `DOLLHOUSE_INDEX_DEBOUNCE_MS` | `2000` | Debounce delay for index rebuild after file changes |
| `DOLLHOUSE_ELEMENT_CACHE_TTL_MS` | `3600000` | Element cache TTL in milliseconds (1 hour) |
| `DOLLHOUSE_PATH_CACHE_TTL_MS` | `3600000` | Path resolution cache TTL in milliseconds (1 hour) |
| `DOLLHOUSE_TOOL_CACHE_TTL_MS` | `60000` | Tool registration cache TTL in milliseconds (1 minute) |
| `DOLLHOUSE_GLOBAL_CACHE_MEMORY_MB` | `150` | Maximum memory budget for caches in megabytes |

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_LOG_FORMAT` | `text` | Log output format: `text` or `jsonl` |
| `DOLLHOUSE_LOG_RETENTION_DAYS` | `30` | Days to retain general log files |
| `DOLLHOUSE_LOG_SECURITY_RETENTION_DAYS` | `7` | Days to retain security log files |
| `DOLLHOUSE_LOG_FLUSH_INTERVAL_MS` | `5000` | Log buffer flush interval in milliseconds |
| `DOLLHOUSE_LOG_BUFFER_SIZE` | `2000` | In-memory log buffer capacity |
| `DOLLHOUSE_LOG_MEMORY_CAPACITY` | `5000` | Total in-memory log entries across all categories |
| `DOLLHOUSE_LOG_FILE_MAX_SIZE` | `104857600` | Maximum log file size in bytes (100 MB) |
| `DOLLHOUSE_LOG_MAX_ENTRY_SIZE` | `16384` | Maximum size of a single log entry in bytes |

### Metrics

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_METRICS_ENABLED` | `true` | Enable metrics collection |
| `DOLLHOUSE_METRICS_COLLECTION_INTERVAL_MS` | `15000` | Metrics collection interval in milliseconds |
| `DOLLHOUSE_METRICS_MEMORY_SNAPSHOT_CAPACITY` | `240` | Number of memory snapshots to retain |

### Permission prompts

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_CLI_APPROVAL_MAX` | `50` | Maximum CLI approval records before LRU eviction |
| `DOLLHOUSE_CLI_APPROVAL_TTL_MS` | `300000` | TTL for CLI approval records in milliseconds (5 minutes) |
| `DOLLHOUSE_PERMISSION_PROMPT_RATE_LIMIT` | `100` | Maximum permission prompt requests per window |
| `DOLLHOUSE_CLI_APPROVAL_RATE_LIMIT` | `20` | Maximum CLI approval creation requests per window |
| `DOLLHOUSE_PERMISSION_RATE_WINDOW_MS` | `60000` | Rate limit window for permission prompts in milliseconds |

---

## Common Deployment Scenarios

> **For a real production deploy with a public hostname**, follow the [Production Hosting Runbook](./production-hosting-runbook.md). It's the end-to-end "I have mcp.example.com, here's how to deploy" walkthrough covering DNS, reverse proxy + Let's Encrypt, Postgres bootstrap, secret generation, GitHub OAuth on a stable URL, admin pre-claim, smoke verification, log location, and a production checklist. The scenarios below are starting points; the runbook is the full operational picture.

### Container vs bare binary on a host

For HTTP-mode deployments, you have two supervisor options:

| | Container (Docker Compose) | Bare binary (Node + systemd) |
|---|---|---|
| **Best for** | Operators comfortable with Docker; multi-service deployments | Operators with existing Node infrastructure or managed-PG customers |
| **Setup** | One compose file, one command | systemd unit + log rotation + user setup |
| **Updates** | `docker compose pull && docker compose up -d` | `git pull && npm ci && npm run build && systemctl restart` |
| **Process supervision** | Docker daemon (`restart: unless-stopped`) | systemd (`Restart=on-failure`) |
| **Logging surface** | `docker compose logs` + JSON log drivers | `journalctl -u dollhousemcp` + `/var/log/dollhousemcp/` |
| **Image reproducibility** | Pinned digest = same code everywhere | Whatever's checked out + built |

**Default recommendation: container.** Removes the "right Node version" class of issue and gives a reproducible deploy unit. Bare binary makes sense if you already operate Node services this way. Both paths are documented in the [Production Hosting Runbook](./production-hosting-runbook.md).

### Local development (defaults, zero configuration)

No configuration needed. Install and run:

```bash
# Via npx (always latest)
npx @dollhousemcp/mcp-server

# Or local install
npm install @dollhousemcp/mcp-server
node node_modules/@dollhousemcp/mcp-server/dist/index.js
```

Add to Claude Code:

```bash
claude mcp add -s user dollhousemcp -- npx -y @dollhousemcp/mcp-server
```

**Legacy layout (existing `~/.dollhouse/` install):**

```
~/.dollhouse/
  portfolio/
    personas/
    skills/
    ...
```

**New install (no existing `~/.dollhouse/`):**

```
~/DollhouseMCP/
  users/
    <userId>/
      portfolio/
        personas/
        skills/
        ...
```

No environment variables required.

---

### Personal remote access (HTTP + filesystem)

Run a persistent server you can connect to from multiple clients, without database infrastructure.

```bash
# .env file
DOLLHOUSE_TRANSPORT=streamable-http
DOLLHOUSE_HTTP_HOST=127.0.0.1
DOLLHOUSE_HTTP_PORT=3000
DOLLHOUSE_HTTP_SESSION_IDLE_TIMEOUT_MS=900000

# If exposing behind a reverse proxy:
# DOLLHOUSE_HTTP_ALLOWED_HOSTS=yourdomain.example.com
```

Start:

```bash
npm run start:http
```

**Legacy layout (existing `~/.dollhouse/` install):**

```
~/.dollhouse/
  portfolio/
    personas/
    skills/
    ...
```

**Per-user layout (new install or after migration):**

```
~/.dollhouse/           (or ~/DollhouseMCP/ on new installs)
  users/
    <userId>/
      portfolio/
        personas/
        skills/
        ...
```

> **Note:** All HTTP sessions share a single user identity in filesystem mode. This configuration is appropriate for personal use only.

---

### Team or hosted deployment (HTTP + database)

Full multi-user deployment with per-user data isolation.

```bash
# .env file
NODE_ENV=production

# Transport
DOLLHOUSE_TRANSPORT=streamable-http
DOLLHOUSE_HTTP_HOST=0.0.0.0
DOLLHOUSE_HTTP_PORT=3000
DOLLHOUSE_HTTP_ALLOWED_HOSTS=mcp.yourdomain.example.com
DOLLHOUSE_HTTP_RATE_LIMIT_MAX_REQUESTS=300

# Storage
DOLLHOUSE_STORAGE_BACKEND=database
DOLLHOUSE_DATABASE_URL=postgres://dollhouse_app:strong-password@db.internal:5432/dollhousemcp
DOLLHOUSE_DATABASE_ADMIN_URL=postgres://dollhouse:admin-password@db.internal:5432/dollhousemcp
DOLLHOUSE_DATABASE_SSL=require
DOLLHOUSE_DATABASE_POOL_SIZE=20

# Authentication
DOLLHOUSE_AUTH_ENABLED=true
DOLLHOUSE_AUTH_PROVIDER=oidc
DOLLHOUSE_AUTH_ISSUER=https://your-tenant.auth0.com/
DOLLHOUSE_AUTH_AUDIENCE=dollhousemcp

# Security
DOLLHOUSE_TOKEN_SECRET=at-least-32-characters-of-random-secret-here
DOLLHOUSE_WEB_AUTH_ENABLED=true
```

For teams not yet using an external identity provider, substitute the auth block with local provider settings:

```bash
DOLLHOUSE_AUTH_ENABLED=true
DOLLHOUSE_AUTH_PROVIDER=local
```

Then issue tokens for each user individually:

```bash
npm run auth:token -- --sub alice --display-name "Alice K" --email alice@example.com
npm run auth:token -- --sub bob --display-name "Bob M" --email bob@example.com
```

**Set up PostgreSQL.** For a local or Docker-based database, use `npm run db:setup`:

```bash
npm run db:setup
```

For a managed database (RDS, Cloud SQL, and so on), run migrations manually after creating the roles:

```bash
DOLLHOUSE_DATABASE_ADMIN_URL=postgres://dollhouse:admin-password@db.internal:5432/dollhousemcp \
  npm run db:migrate
```

**Import an existing portfolio** (if you have one to carry over):

```bash
DOLLHOUSE_DATABASE_URL=postgres://dollhouse_app:strong-password@db.internal:5432/dollhousemcp \
DOLLHOUSE_DATABASE_ADMIN_URL=postgres://dollhouse:admin-password@db.internal:5432/dollhousemcp \
  npm run db:import
```

Start:

```bash
npm run start:http
```

Each user's data is isolated by database Row-Level Security. The filesystem is not used for element storage in this configuration.

---

### Multi-user HTTP with per-user identity (local tokens)

Use this configuration when you want multiple distinct users on a single HTTP deployment, but do not have an external identity provider. This is the simplest path to per-user data isolation.

```bash
# .env file
DOLLHOUSE_TRANSPORT=streamable-http
DOLLHOUSE_HTTP_HOST=127.0.0.1
DOLLHOUSE_HTTP_PORT=3000

# Storage
DOLLHOUSE_STORAGE_BACKEND=database
DOLLHOUSE_DATABASE_URL=postgres://dollhouse_app:password@localhost:5432/dollhousemcp
DOLLHOUSE_DATABASE_ADMIN_URL=postgres://dollhouse:password@localhost:5432/dollhousemcp

# Authentication
DOLLHOUSE_AUTH_ENABLED=true
DOLLHOUSE_AUTH_PROVIDER=local
```

Start the server:

```bash
npm run start:http
```

The server prints a startup token for your OS user to stderr. For each additional user, generate a token using their identifier as the subject:

```bash
npm run auth:token -- --sub alice
npm run auth:token -- --sub bob --ttl 604800
```

Each user copies their token into their MCP client's `Authorization: Bearer <token>` header. The first time each token reaches the server, a new user row is created and an empty portfolio is initialized. Their data is isolated from all other users via Row-Level Security.

**Per-user layout (database mode — user data in PostgreSQL, not filesystem):**

```
~/.dollhouse/           (or ~/DollhouseMCP/ on new installs)
  run/
    auth-keypair.json   ← shared key pair used to sign all user tokens
  logs/
```

> **Key management note:** All tokens for a given server instance are signed with the same key pair at `~/.dollhouse/run/auth-keypair.json`. If you rotate or delete that file, all existing tokens are immediately invalidated. Generate new tokens for all users after a key rotation.

---

### Docker deployment

**HTTP transport, filesystem storage:**

```bash
docker build -f docker/Dockerfile -t dollhousemcp:latest .

docker run -d \
  --name dollhousemcp \
  -p 3000:3000 \
  -e DOLLHOUSE_TRANSPORT=streamable-http \
  -e DOLLHOUSE_HTTP_HOST=0.0.0.0 \
  -e DOLLHOUSE_HTTP_ALLOWED_HOSTS=localhost,127.0.0.1 \
  -v /data/dollhouse:/home/node/.dollhouse \
  dollhousemcp:latest
```

**Using Docker Compose (HTTP only):**

```bash
cd docker
docker compose -f docker-compose.http.yml up -d
```

**Using Docker Compose (HTTP + PostgreSQL):**

```bash
# Set up PostgreSQL (starts container, runs migrations, prints env vars)
npm run db:setup

# Start the HTTP server
cd docker
docker compose -f docker-compose.http.yml up -d
```

**Port reference:**

| Port | Service |
|------|---------|
| `3000` | MCP HTTP endpoint (`/mcp`) |
| `5432` | PostgreSQL (internal; do not expose externally in production) |
| `41715` | Web console |
