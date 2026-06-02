# Hosted Deployment Automation

This guide tracks the executable deployment path for hosted DollhouseMCP.
It is the automation companion to the manual [Production Hosting Runbook](./production-hosting-runbook.md).

The goal is to turn the alpha-tested Docker Compose + Caddy + Postgres shape into a repeatable install/update command for:

- Dollhouse-operated alpha and demo servers
- self-hosted local or LAN containers
- enterprise-controlled single-tenant deployments

Issue: [#2223](https://github.com/DollhouseMCP/mcp-server/issues/2223)

## Current Command

From a checkout of the repository:

```bash
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  npm run hosted:deploy -- install
```

Update an existing install:

```bash
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  npm run hosted:deploy -- update
```

Run migrations for an existing install:

```bash
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  npm run hosted:deploy -- migrate
```

Bootstrap the first GitHub admin:

```bash
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME=octocat \
  npm run hosted:deploy -- bootstrap-admin
```

Verify an existing install:

```bash
DOLLHOUSE_PUBLIC_BASE_URL=https://mcp.example.com \
  npm run hosted:deploy -- verify
```

The helper lives at [`scripts/hosted-deploy.sh`](../../scripts/hosted-deploy.sh).

## What It Manages

The helper manages the deployment directory, defaulting to `/opt/dollhousemcp`:

```text
/opt/dollhousemcp/
  compose.yml
  Caddyfile
  init-db.sql
  .env.production
  server/
  portfolio/
  pgdata/
  logs/
  DEPLOYED_REVISION
  DEPLOYED_AT
  server.prev-*/
  server.rollback-from-*/
```

It preserves:

- `.env.production`
- Postgres data
- Caddy certificate/config volumes
- portfolio files
- previous server bundle snapshots
- rollback source snapshots

## Configuration

Common environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `DOLLHOUSE_HOSTED_DEPLOY_DIR` | Deployment root | `/opt/dollhousemcp` |
| `DOLLHOUSE_HOSTED_HOSTNAME` | Public hostname, for example `mcp.example.com` | none |
| `DOLLHOUSE_PUBLIC_BASE_URL` | Public URL, for example `https://mcp.example.com` | derived from hostname |
| `DOLLHOUSE_HOSTED_SOURCE_DIR` | Local repo source to deploy | current repo when available |
| `DOLLHOUSE_HOSTED_GIT_URL` | Repo cloned when no source dir is available | GitHub mcp-server repo |
| `DOLLHOUSE_HOSTED_GIT_REF` | Branch/ref cloned when no source dir is available | `codex/hosted-http-integration` |
| `DOLLHOUSE_AUTH_GITHUB_CLIENT_ID` | GitHub OAuth app client ID | prompted or left unset |
| `DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret | prompted or left unset |
| `DOLLHOUSE_AUTH_OPEN_DCR` | Whether unauthenticated Dynamic Client Registration is enabled | `true` |
| `DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME` | Optional GitHub username to pre-claim as the first admin | none |
| `DOLLHOUSE_BOOTSTRAP_GITHUB_ID` | Optional numeric GitHub ID to pre-claim as the first admin and skip API lookup | none |
| `DOLLHOUSE_HOSTED_POSTGRES_READY_TIMEOUT` | Seconds to wait for Postgres readiness | `60` |

Secrets are created once and preserved in `.env.production`. The helper does not overwrite generated secrets on later runs.

## Actions

### `render`

Writes or refreshes deployment files without starting containers:

```bash
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com npm run hosted:deploy -- render
```

### `install`

Renders files, stages the server source, builds containers, starts Postgres, runs migrations, optionally bootstraps the GitHub admin, starts the full stack, and verifies:

```bash
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com npm run hosted:deploy -- install
```

To bootstrap the admin in the same pass:

```bash
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME=octocat \
  npm run hosted:deploy -- install
```

### `update`

Renders files, stages a new server bundle, rebuilds the `dollhousemcp` image, ensures Postgres is ready, runs migrations, restarts the `dollhousemcp` service, and verifies:

```bash
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com npm run hosted:deploy -- update
```

### `migrate`

Renders files, rebuilds the current `dollhousemcp` image if needed, waits for Postgres, and runs:

```bash
docker compose run --rm dollhousemcp npm run db:migrate
```

Use this when the database needs to be brought current without staging new source:

```bash
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com npm run hosted:deploy -- migrate
```

### `bootstrap-admin`

Runs the admin pre-claim CLI inside the deployed container:

```bash
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME=octocat \
  npm run hosted:deploy -- bootstrap-admin
```

Prefer `DOLLHOUSE_BOOTSTRAP_GITHUB_ID` when you already know the numeric GitHub ID, because it skips the GitHub API lookup. If neither bootstrap variable is set and the script has a TTY, it prompts for a GitHub username.

### `rollback`

Restores the newest retained `server.prev-*` bundle, keeps the current bundle as `server.rollback-from-*`, rebuilds the app image, restarts `dollhousemcp` and Caddy, then verifies:

```bash
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com npm run hosted:deploy -- rollback
```

Rollback restores the application source bundle only. It does not roll database schema backward; use it for ordinary failed app deploys, not for a migration that requires a planned database restore.

### `verify`

Checks:

- `/healthz`
- `/readyz`
- `/mcp` returns `401` without a bearer token

```bash
DOLLHOUSE_PUBLIC_BASE_URL=https://mcp.example.com npm run hosted:deploy -- verify
```

## GitHub OAuth Setup

For GitHub sign-in, register an OAuth app with:

- Homepage URL: `https://mcp.example.com`
- Callback URL: `https://mcp.example.com/auth/social/github/callback`

Then either export the credentials before install:

```bash
export DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=...
export DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=...
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com npm run hosted:deploy -- install
```

Or enter them at the prompt during an interactive install. In noninteractive mode, add them manually to `.env.production`.

## Dynamic Client Registration

The generated Compose file defaults to:

```yaml
DOLLHOUSE_AUTH_OPEN_DCR: "true"
```

This is the alpha compatibility shape for MCP clients such as claude.ai web and Gemini CLI that auto-register through Dynamic Client Registration. The server-side DCR policy validates redirect shape and records audit metadata, and user access is still governed by GitHub authentication plus the Dollhouse allowlist gate.

For a stricter enterprise deployment where MCP clients are pre-registered or issued Initial Access Tokens, set `DOLLHOUSE_AUTH_OPEN_DCR=false` before `render`, `install`, or `update`. Future enterprise presets should make that choice explicit.

## Current Limitations

- The public `curl | sh` installer URL does not exist yet.
- Local/LAN self-hosting and enterprise IdP presets still need dedicated modes.
- The helper assumes Docker Compose and Caddy for the first production-like shape.
- Allowlist management still uses the existing `dollhouse-allowlist` CLI.

## Validation

Run the deployment helper shell checks:

```bash
npm run lint:shell
```

Run the render smoke test:

```bash
npm run test:hosted-deploy
```

## Next Steps

- Add local/LAN mode with clear binding and TLS choices.
- Add enterprise mode presets for external OIDC/IdP configuration.
- Add a wrapper installer that can be served from a stable URL.
- Broaden generated-file tests beyond the current render smoke coverage.
