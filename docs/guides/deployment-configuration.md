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
- [Per-User Data Isolation](#per-user-data-isolation)
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
Use `stdio + file` — this is the default. No configuration required. Install and run. Your portfolio lives at `~/.dollhouse/portfolio/`.

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
> - Portfolio: `~/.dollhouse/portfolio/` (macOS/Linux) or `%USERPROFILE%\.dollhouse\portfolio\` (Windows)
> - Web console: enabled on port 41715 (when running in HTTP mode)

The following features require explicit opt-in — they are **not active** unless you configure them:

| Feature | How to enable |
|---------|--------------|
| HTTP Streaming transport | Set `DOLLHOUSE_TRANSPORT=streamable-http` |
| Database storage backend | Set `DOLLHOUSE_STORAGE_BACKEND=database` |
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

#### Default locations

**macOS/Linux (existing `~/.dollhouse/` install — legacy layout):**

| Directory | Purpose |
|-----------|---------|
| `~/.dollhouse/portfolio/` | Element files (personas, skills, templates, etc.) |
| `~/.dollhouse/portfolio/personas/` | Persona elements |
| `~/.dollhouse/portfolio/skills/` | Skill elements |
| `~/.dollhouse/portfolio/templates/` | Template elements |
| `~/.dollhouse/portfolio/agents/` | Agent elements |
| `~/.dollhouse/portfolio/memories/` | Memory elements |
| `~/.dollhouse/portfolio/ensembles/` | Ensemble elements |
| `~/.dollhouse/portfolio/.backups/` | Automatic backups |
| `~/.dollhouse/state/` | Activation state and session data |
| `~/.dollhouse/logs/` | Server logs |
| `~/.dollhouse/run/` | Runtime files (port files, lock files) |

**macOS (new install, no existing `~/.dollhouse/`):**

| Directory | Purpose |
|-----------|---------|
| `~/DollhouseMCP/` | Portfolio root |
| `~/Library/Preferences/DollhouseMCP/` | Config |
| `~/Library/Caches/DollhouseMCP/` | Cache |
| `~/Library/Logs/DollhouseMCP/` | Logs |

**Linux (new install, XDG layout):**

| Directory | Purpose |
|-----------|---------|
| `~/DollhouseMCP/` | Portfolio root |
| `~/.config/dollhousemcp/` | Config |
| `~/.cache/dollhousemcp/` | Cache |
| `~/.local/state/dollhousemcp/logs/` | Logs |

**Windows:**

| Directory | Purpose |
|-----------|---------|
| `%USERPROFILE%\DollhouseMCP\` | Portfolio root |
| `%APPDATA%\DollhouseMCP\Config\` | Config |
| `%LOCALAPPDATA%\DollhouseMCP\Cache\` | Cache |
| `%LOCALAPPDATA%\DollhouseMCP\Log\` | Logs |

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

### Why two connection URLs?

DollhouseMCP uses two separate PostgreSQL roles:

| Role | URL variable | Purpose |
|------|-------------|---------|
| `dollhouse` (superuser) | `DOLLHOUSE_DATABASE_ADMIN_URL` | Running migrations and creating user rows at bootstrap. Has full DDL access. |
| `dollhouse_app` (app role) | `DOLLHOUSE_DATABASE_URL` | All runtime queries. Has only SELECT, INSERT, UPDATE, DELETE. Row-Level Security is enforced against this role. |

This separation follows the principle of least privilege. Runtime application code never holds superuser credentials. If `DOLLHOUSE_DATABASE_ADMIN_URL` is not set, bootstrap falls back to using `DOLLHOUSE_DATABASE_URL` — this only works before Row-Level Security is applied to the `users` table.

### Docker quickstart (development)

The fastest way to get PostgreSQL running locally:

```bash
cd docker
docker compose -f docker-compose.db.yml up -d
```

This starts PostgreSQL 17 on port 5432 and automatically creates both roles via the `init-db.sql` initialization script.

Once the container is healthy, configure your environment:

```bash
DOLLHOUSE_STORAGE_BACKEND=database
DOLLHOUSE_DATABASE_URL=postgres://dollhouse_app:dollhouse_app@localhost:5432/dollhousemcp
DOLLHOUSE_DATABASE_ADMIN_URL=postgres://dollhouse:dollhouse@localhost:5432/dollhousemcp
```

Check container health:

```bash
docker compose -f docker-compose.db.yml ps
```

### Running migrations

Migrations do not run automatically on server startup. Run them manually with:

```bash
npm run db:migrate
```

This uses `drizzle-kit migrate` and applies all pending SQL migration files from `src/database/migrations/` in order. The migration tool tracks applied migrations in the `drizzle` schema so re-running is safe.

> **Note:** Run migrations using the admin URL (`DOLLHOUSE_DATABASE_ADMIN_URL` or via a superuser connection string), not the app role URL. Migrations create tables, indexes, and RLS policies that the app role does not have permission to modify.

### Data management scripts

Three additional CLI scripts are available for data migration and transfer. All three are operator tools — they are not accessible to LLMs via MCP.

| Script | Purpose |
|--------|---------|
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

### Setting up roles manually (without Docker)

If you are using a managed PostgreSQL instance (RDS, Cloud SQL, and so on), create the roles manually:

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

Then run the contents of `docker/init-db.sql` to grant the app role its permissions. Then run `npm run db:migrate` to apply all migrations.

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

---

## Per-User Data Isolation

### Filesystem: flat layout (default)

By default, all data belongs to a single local user. The portfolio is flat — there is no per-user subdirectory. This is correct for personal use and stdio mode.

Layout:

```
~/.dollhouse/
  portfolio/
    personas/
    skills/
    templates/
    agents/
    memories/
    ensembles/
  state/
  logs/
  run/
```

### Filesystem: per-user layout (HTTP multi-user)

In HTTP deployments with multiple users, the filesystem can use a per-user subdirectory layout under the portfolio root:

```
~/.dollhouse/
  users/
    <user-uuid>/
      portfolio/
        personas/
        skills/
        ...
      state/
      auth/
      backups/
      security/
```

This layout is selected automatically when `DOLLHOUSE_STORAGE_BACKEND=database` is combined with HTTP mode. Each user's data is sandboxed to their own subtree; path traversal outside the user's directory is blocked at the `PathValidator` level.

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

The migration moves your portfolio, state, auth, and security directories from the flat layout into a per-user subtree under `~/.dollhouse/users/<userId>/`. It does not delete your original files until each move succeeds, and it writes a marker file (`~/.dollhouse/.dollhouse-per-user-migrated`) when complete. Partial runs are safe to retry — moves that already succeeded are skipped.

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
| `DOLLHOUSE_PORTFOLIO_DIR` | *(platform default)* | Portfolio root directory. Must be an absolute path. |
| `DOLLHOUSE_CONFIG_DIR` | *(platform default)* | Config directory. Must be an absolute path. |
| `DOLLHOUSE_CACHE_DIR` | *(platform default)* | Cache directory. Must be an absolute path. |
| `DOLLHOUSE_STATE_DIR` | *(platform default)* | State directory. Must be an absolute path. |
| `DOLLHOUSE_LOG_DIR` | `~/.dollhouse/logs/` | Log directory. Must be an absolute path. |
| `DOLLHOUSE_RUN_DIR` | *(platform default)* | Runtime files directory. Must be an absolute path. |
| `DOLLHOUSE_SHARED_POOL_DIR` | *(unset)* | Directory containing seed elements for the shared pool. |

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

Portfolio lives at `~/.dollhouse/portfolio/` by default. No environment variables required.

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

# Security
DOLLHOUSE_TOKEN_SECRET=at-least-32-characters-of-random-secret-here
DOLLHOUSE_WEB_AUTH_ENABLED=true
```

Run migrations before starting the server:

```bash
DOLLHOUSE_DATABASE_ADMIN_URL=postgres://dollhouse:admin-password@db.internal:5432/dollhousemcp \
  npm run db:migrate
```

If you have an existing filesystem portfolio to carry over, import it before starting the server:

```bash
DOLLHOUSE_DATABASE_URL=postgres://dollhouse_app:strong-password@db.internal:5432/dollhousemcp \
DOLLHOUSE_DATABASE_ADMIN_URL=postgres://dollhouse:admin-password@db.internal:5432/dollhousemcp \
  npm run db:import
```

Start:

```bash
npm run start:http
```

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
cd docker

# Start PostgreSQL first
docker compose -f docker-compose.db.yml up -d

# Wait for healthy status, then run migrations
DOLLHOUSE_DATABASE_ADMIN_URL=postgres://dollhouse:dollhouse@localhost:5432/dollhousemcp \
  npm run db:migrate

# Start the HTTP server
docker compose -f docker-compose.http.yml up -d
```

**Port reference:**

| Port | Service |
|------|---------|
| `3000` | MCP HTTP endpoint (`/mcp`) |
| `5432` | PostgreSQL (internal; do not expose externally in production) |
| `41715` | Web console |
