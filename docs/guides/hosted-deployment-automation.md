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

Preview an install without changing files or starting containers:

```bash
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  npm run hosted:deploy -- --dry-run install
```

The same dry-run mode is also available through the environment:

```bash
DOLLHOUSE_HOSTED_DRY_RUN=true \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  npm run hosted:deploy -- install
```

Run the install:

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

The entrypoint stays intentionally thin. Implementation modules live under [`scripts/hosted-deploy/`](../../scripts/hosted-deploy/):

- `config.sh`: defaults, usage text, and CLI parsing
- `logging.sh`: `quiet`, `info`, and `debug` logging modes
- `validation.sh`: input, URL, hostname, port, boolean, and git URL validation
- `env.sh`: environment file, generated secrets, and env loading
- `render.sh`: Compose, Caddy, and Postgres init file generation
- `source.sh`: local source archive, remote clone, bundle snapshots, and rollback candidates
- `runtime.sh`: Docker Compose, migrations, bootstrap, rollback, and verification actions
- `dry-run.sh`: read-only operation planning
- `actions.sh`: action dispatch

## What It Manages

The helper manages the deployment directory, defaulting to `/opt/dollhousemcp`:

```text
/opt/dollhousemcp/
  compose.yml
  Caddyfile
  init-db.sh
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
| `DOLLHOUSE_HOSTED_DRY_RUN` | Preview operations without writes, Docker, git clone, or HTTP checks | `false` |
| `DOLLHOUSE_HOSTED_LOG_LEVEL` | Logging mode: `quiet`, `info`, or `debug` | `info` |
| `DOLLHOUSE_HOSTED_IMPORT_LEGACY_ENV` | Import selected secrets/config from an existing `.env` into `.env.production` during upgrade | `true` |
| `DOLLHOUSE_HOSTED_HOSTNAME` | Public hostname, for example `mcp.example.com` | none |
| `DOLLHOUSE_PUBLIC_BASE_URL` | Public URL, for example `https://mcp.example.com` | derived from hostname |
| `DOLLHOUSE_HOSTED_SOURCE_DIR` | Local repo source to deploy | current repo when available |
| `DOLLHOUSE_HOSTED_GIT_URL` | Repo cloned when no source dir is available | GitHub mcp-server repo |
| `DOLLHOUSE_HOSTED_GIT_REF` | Branch/ref cloned when no source dir is available | `codex/hosted-http-integration` |
| `DOLLHOUSE_HOSTED_ALLOW_CREDENTIAL_GIT_URL` | Permit credentials embedded in `DOLLHOUSE_HOSTED_GIT_URL` | `false` |
| `DOLLHOUSE_AUTH_GITHUB_CLIENT_ID` | GitHub OAuth app client ID | prompted or left unset |
| `DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret | prompted or left unset |
| `DOLLHOUSE_AUTH_OPEN_DCR` | Whether unauthenticated Dynamic Client Registration is enabled | `true` |
| `DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME` | Optional GitHub username to pre-claim as the first admin | none |
| `DOLLHOUSE_BOOTSTRAP_GITHUB_ID` | Optional numeric GitHub ID to pre-claim as the first admin and skip API lookup | none |
| `DOLLHOUSE_HOSTED_POSTGRES_READY_TIMEOUT` | Seconds to wait for Postgres readiness | `60` |
| `DOLLHOUSE_HOSTED_VERIFY_READY_TIMEOUT` | Seconds to wait for public `/healthz`, `/readyz`, and `/mcp` checks after app restart | `60` |

Secrets are created once and preserved in `.env.production`. The helper does not overwrite generated secrets on later runs, except for one upgrade path: if an existing deployment already has `/opt/dollhousemcp/.env`, selected values are imported once into `.env.production` so Docker Compose interpolation does not generate credentials that differ from the initialized Postgres volume. When `.env.production` already exists, only database/connection keys are reconciled from `.env`; auth and runtime secrets already present in `.env.production` are preserved. The helper records that upgrade in `.legacy-env-imported`; remove that marker only if you intentionally need to re-import from `.env`. Set `DOLLHOUSE_HOSTED_IMPORT_LEGACY_ENV=false` to disable the import.

All helper-managed Docker Compose commands run with `--env-file .env.production`. This matters because Compose normally reads `.env` for variable interpolation, while `env_file: .env.production` only controls container environment injection.

The generated Postgres init script is a shell script (`init-db.sh`) rather than a password-filled SQL file. It receives the app role password through `DOLLHOUSE_APP_DB_PASSWORD` at container init time and passes it to `psql` as a variable, so the generated init script itself does not contain the app database password.

The helper rejects credential-bearing `DOLLHOUSE_HOSTED_GIT_URL` values by default because credentials embedded in command arguments can leak through process listings or logs. Use a git credential helper, deploy key, or `DOLLHOUSE_HOSTED_SOURCE_DIR` instead. If an operator has an explicit reason to allow this, set `DOLLHOUSE_HOSTED_ALLOW_CREDENTIAL_GIT_URL=true`.

## Actions

### `render`

Writes or refreshes deployment files without starting containers:

```bash
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com npm run hosted:deploy -- render
```

Any action can be previewed with `--dry-run`. Dry-run mode validates the deploy inputs and prints the planned filesystem, source, Docker, migration, bootstrap, rollback, and verification steps without writing deployment files, moving source bundles, starting containers, cloning repositories, or making HTTP requests.

Logging can be adjusted with `--quiet`, `--debug`, `--log-level quiet|info|debug`, or `DOLLHOUSE_HOSTED_LOG_LEVEL`. `quiet` suppresses normal progress output but still reports errors. `debug` prints the resolved action, dry-run flag, and deployment directory to stderr before running.

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

If no bootstrap identity is supplied and no admin has been claimed yet, `/readyz` can report `bootstrap_required` after the stack starts. `install`, `update`, and `rollback` treat that as an expected pre-bootstrap state and print a warning instead of failing the deployment. Run `bootstrap-admin` once the intended admin identity is available. The standalone `verify` action remains strict and expects `/readyz` to return 200.

### `update`

Renders files, stages a new server bundle, rebuilds the `dollhousemcp` image, ensures Postgres is ready, runs migrations, restarts the `dollhousemcp` service, and verifies:

```bash
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com npm run hosted:deploy -- update
```

### `migrate`

Renders files, rebuilds the current `dollhousemcp` image if needed, waits for Postgres, and runs:

```bash
docker compose --env-file .env.production run --rm dollhousemcp-migrate
```

The `dollhousemcp-migrate` service is built from the Dockerfile `builder` target so `drizzle-kit` and the Drizzle config are available without adding migration tooling to the runtime production image.

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

Each public HTTP check retries for up to `DOLLHOUSE_HOSTED_VERIFY_READY_TIMEOUT` seconds. This absorbs the brief 502 window that can occur while Caddy reconnects to a just-restarted app container.

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

## Troubleshooting

### Legacy `.env` Import

On upgrade from an earlier helper-generated deployment, the helper imports selected keys from `/opt/dollhousemcp/.env` into `.env.production` once, then writes `.legacy-env-imported`. If `.env.production` already exists, the import is limited to database/connection keys so existing GitHub OAuth, cookie, audit, and encryption secrets are not overwritten by stale legacy values. The import log lists key names for auditability, but never prints values.

If the import is not desired, set `DOLLHOUSE_HOSTED_IMPORT_LEGACY_ENV=false` before running the helper. If `.env` exists but cannot be read, fix its permissions or disable the import. To intentionally repeat the import, remove `.legacy-env-imported` after confirming `.env` contains the values you want to preserve.

### Bootstrap Required

`bootstrap_required` means the server is running but no first admin has been claimed. Set `DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME` or `DOLLHOUSE_BOOTSTRAP_GITHUB_ID`, then run:

```bash
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME=octocat \
  npm run hosted:deploy -- bootstrap-admin
```

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

Run the hosted deployment smoke tests:

```bash
npm run test:hosted-deploy
```

This runs both the generated-file render test and a Docker-stubbed workflow test covering install, update, rollback, migrations, verification, and an invalid source error path.

## Next Steps

- Add local/LAN mode with clear binding and TLS choices.
- Add enterprise mode presets for external OIDC/IdP configuration.
- Add a wrapper installer that can be served from a stable URL.
- Add optional real-container integration coverage for Docker environments.
