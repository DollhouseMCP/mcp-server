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

Render a conservative local/LAN deployment that listens on loopback only:

```bash
DOLLHOUSE_HOSTED_MODE=lan \
DOLLHOUSE_HOSTED_HOSTNAME=localhost \
  npm run hosted:deploy -- render
```

Expose the LAN deployment on all host interfaces:

```bash
DOLLHOUSE_HOSTED_MODE=lan \
DOLLHOUSE_HOSTED_HOSTNAME=dollhouse.local \
DOLLHOUSE_HOSTED_BIND_ADDRESS=0.0.0.0 \
  npm run hosted:deploy -- install
```

Render an enterprise deployment that validates tokens from an external OIDC IdP:

```bash
DOLLHOUSE_HOSTED_MODE=enterprise \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
DOLLHOUSE_AUTH_PROVIDER=oidc \
DOLLHOUSE_AUTH_METHODS='' \
DOLLHOUSE_AUTH_ISSUER=https://idp.example.com \
DOLLHOUSE_AUTH_AUDIENCE=dollhouse-mcp \
  npm run hosted:deploy -- render
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

Run an update on a remote host over SSH:

```bash
DOLLHOUSE_REMOTE_SSH_TARGET=root@203.0.113.10 \
DOLLHOUSE_REMOTE_KNOWN_HOSTS_FILE=./dollhouse_known_hosts \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
DOLLHOUSE_HOSTED_GIT_REF=codex/hosted-http-integration \
  npm run hosted:remote -- update
```

Run a side-by-side canary on the same host without taking over the production stack:

```bash
DOLLHOUSE_REMOTE_SSH_TARGET=root@203.0.113.10 \
DOLLHOUSE_REMOTE_KNOWN_HOSTS_FILE=./dollhouse_known_hosts \
DOLLHOUSE_HOSTED_DEPLOY_DIR=/opt/dollhousemcp-canary \
DOLLHOUSE_HOSTED_MODE=lan \
DOLLHOUSE_HOSTED_HOSTNAME=localhost \
DOLLHOUSE_HOSTED_HTTP_BIND_PORT=3100 \
DOLLHOUSE_HOSTED_GIT_REF=codex/hosted-lan-enterprise-setup \
  npm run hosted:remote -- --skip-local-verify update
```

The helper lives at [`scripts/hosted-deploy.sh`](../../scripts/hosted-deploy.sh).
The SSH operator wrapper lives at [`scripts/hosted-remote-deploy.sh`](../../scripts/hosted-remote-deploy.sh).

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

The remote wrapper additionally creates operator backups before it invokes the hosted helper on an existing deployment:

- a Postgres dump under `backups/pre-remote-<action>-<timestamp>.sql`
- `.env` and `.env.production` copies under `backups/`

Database readiness and `pg_dump` receive bounded retries before `update`, `migrate`, and `rollback` continue. Retry delays use exponential backoff from the configured base delay. If a dump attempt writes partial output and then fails, the wrapper moves that partial output to `backups/pre-remote-<action>-<timestamp>.sql.failed-attempt-<n>` with `0600` permissions before retrying or failing.

Set `DOLLHOUSE_REMOTE_SKIP_BACKUP=true` or pass `--skip-backup` only when a separate backup already exists.

## Configuration

Common environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `DOLLHOUSE_HOSTED_MODE` | Deployment preset: `cloud`, `lan`, or `enterprise` | `cloud` |
| `DOLLHOUSE_HOSTED_DEPLOY_DIR` | Deployment root | `/opt/dollhousemcp` |
| `DOLLHOUSE_HOSTED_INSTANCE_NAME` | Docker Compose project and container-name identity for this deployment | derived from the deployment root basename |
| `DOLLHOUSE_HOSTED_IMAGE_TAG` | Docker image tag used for the app and migration images | `dollhousemcp-hosted:alpha` for `/opt/dollhousemcp`, otherwise `<instance>-hosted:alpha` |
| `DOLLHOUSE_HOSTED_DRY_RUN` | Preview operations without writes, Docker, git clone, or HTTP checks | `false` |
| `DOLLHOUSE_HOSTED_LOG_LEVEL` | Logging mode: `quiet`, `info`, or `debug` | `info` |
| `DOLLHOUSE_HOSTED_IMPORT_LEGACY_ENV` | Import selected secrets/config from an existing `.env` into `.env.production` during upgrade | `true` |
| `DOLLHOUSE_HOSTED_HOSTNAME` | Public hostname, for example `mcp.example.com` | none |
| `DOLLHOUSE_PUBLIC_BASE_URL` | Public URL, for example `https://mcp.example.com` | derived from hostname |
| `DOLLHOUSE_HOSTED_PROXY_MODE` | Reverse proxy mode: `caddy-tls` or `caddy-http` | mode-specific |
| `DOLLHOUSE_HOSTED_BIND_ADDRESS` | IPv4 host interface for Caddy ports, for example `127.0.0.1` or `0.0.0.0` | mode-specific |
| `DOLLHOUSE_HOSTED_HTTP_BIND_PORT` | Host HTTP port for Caddy | `80` for `cloud`/`enterprise`, `3000` for `lan` |
| `DOLLHOUSE_HOSTED_HTTPS_BIND_PORT` | Host HTTPS port for Caddy TLS mode | `443` |
| `DOLLHOUSE_HTTP_ALLOWED_HOSTS` | Comma-separated Host header allowlist passed to the app | `localhost,127.0.0.1,<hostname>` |
| `DOLLHOUSE_TRUSTED_PROXIES` | Comma-separated trusted proxy CIDRs passed to the app | Docker bridge CIDR `172.16.0.0/12` |
| `DOLLHOUSE_HOSTED_SOURCE_DIR` | Local repo source to deploy | current repo when available |
| `DOLLHOUSE_HOSTED_GIT_URL` | Repo cloned when no source dir is available | GitHub mcp-server repo |
| `DOLLHOUSE_HOSTED_GIT_REF` | Branch/ref cloned when no source dir is available | `codex/hosted-http-integration` |
| `DOLLHOUSE_HOSTED_ALLOW_CREDENTIAL_GIT_URL` | Permit credentials embedded in `DOLLHOUSE_HOSTED_GIT_URL` | `false` |
| `DOLLHOUSE_AUTH_PROVIDER` | Auth provider: `embedded`, `oidc`, or `local` | `embedded` |
| `DOLLHOUSE_AUTH_METHODS` | Embedded-AS sign-in methods, for example `github` or `github,local-password` | `github` for `embedded`, empty for `oidc` |
| `DOLLHOUSE_AUTH_ISSUER` | External OIDC issuer URL for `DOLLHOUSE_AUTH_PROVIDER=oidc` | none |
| `DOLLHOUSE_AUTH_AUDIENCE` | Expected OIDC audience for `DOLLHOUSE_AUTH_PROVIDER=oidc` | none |
| `DOLLHOUSE_AUTH_JWKS_URI` | Optional OIDC JWKS URL override | derived by server when omitted |
| `DOLLHOUSE_AUTH_OIDC_REQUIRE_TYP` | Require RFC 9068 `typ: at+jwt` for OIDC bridge tokens | `false` |
| `DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED` | Require allowlist gate for user sign-in | `true` |
| `DOLLHOUSE_AUTH_ALLOWLIST_SEED_FILE` | Optional allowlist seed JSON path for GitOps-managed installs | none |
| `DOLLHOUSE_AUTH_GITHUB_CLIENT_ID` | GitHub OAuth app client ID | prompted or left unset |
| `DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret | prompted or left unset |
| `DOLLHOUSE_AUTH_OPEN_DCR` | Whether unauthenticated Dynamic Client Registration is enabled | `true` in `cloud`, `false` in `lan`/`enterprise` |
| `DOLLHOUSE_BOOTSTRAP_GITHUB_USERNAME` | Optional GitHub username to pre-claim as the first admin | none |
| `DOLLHOUSE_BOOTSTRAP_GITHUB_ID` | Optional numeric GitHub ID to pre-claim as the first admin and skip API lookup | none |
| `DOLLHOUSE_HOSTED_POSTGRES_READY_TIMEOUT` | Seconds to wait for Postgres readiness | `60` |
| `DOLLHOUSE_HOSTED_VERIFY_READY_TIMEOUT` | Seconds to wait for public `/healthz`, `/readyz`, and `/mcp` checks after app restart | `60` |

Remote wrapper variables:

| Variable | Purpose | Default |
|---|---|---|
| `DOLLHOUSE_REMOTE_SSH_TARGET` | SSH target for operator-managed remote deploys, for example `root@203.0.113.10` | none |
| `DOLLHOUSE_REMOTE_SSH_IDENTITY_FILE` | Optional SSH private key path | none |
| `DOLLHOUSE_REMOTE_SSH_PORT` | Optional SSH port | default SSH port |
| `DOLLHOUSE_REMOTE_KNOWN_HOSTS_FILE` | Optional known-hosts file used with strict host-key checking | OpenSSH default known-hosts files |
| `DOLLHOUSE_REMOTE_ACCEPT_HOST_KEY` | Permit `enroll-host` to append the scanned host key after operator verification | `false` |
| `DOLLHOUSE_REMOTE_BACKUP_RETRIES` | Attempts for remote Postgres readiness and database dump backup | `3` |
| `DOLLHOUSE_REMOTE_BACKUP_RETRY_DELAY` | Base seconds for exponential backoff between remote backup attempts | `2` |
| `DOLLHOUSE_REMOTE_SKIP_BACKUP` | Skip remote DB/env backups before running the helper | `false` |
| `DOLLHOUSE_REMOTE_SKIP_LOCAL_VERIFY` | Skip local public endpoint checks after the remote helper completes | `false` |
| `DOLLHOUSE_REMOTE_KEEP_WORKDIR` | Keep the temporary remote clone for debugging | `false` |
| `DOLLHOUSE_REMOTE_DRY_RUN` | Preview the remote plan without opening SSH | `false` |

Secrets are created once and preserved in `.env.production`. The helper does not overwrite generated secrets on later runs, except for one upgrade path: if an existing deployment already has `/opt/dollhousemcp/.env`, selected values are imported once into `.env.production` so Docker Compose interpolation does not generate credentials that differ from the initialized Postgres volume. When `.env.production` already exists, only database/connection keys are reconciled from `.env`; auth and runtime secrets already present in `.env.production` are preserved. The helper records that upgrade in `.legacy-env-imported`; remove that marker only if you intentionally need to re-import from `.env`. Set `DOLLHOUSE_HOSTED_IMPORT_LEGACY_ENV=false` to disable the import.

All helper-managed Docker Compose commands run with `--env-file .env.production`. This matters because Compose normally reads `.env` for variable interpolation, while `env_file: .env.production` only controls container environment injection.

The generated Postgres init script is a shell script (`init-db.sh`) rather than a password-filled SQL file. It receives the app role password through `DOLLHOUSE_APP_DB_PASSWORD` at container init time and passes it to `psql` as a variable, so the generated init script itself does not contain the app database password.

The helper rejects credential-bearing `DOLLHOUSE_HOSTED_GIT_URL` values by default because credentials embedded in command arguments can leak through process listings or logs. The remote wrapper applies the same check before opening SSH. Use a git credential helper, deploy key, or `DOLLHOUSE_HOSTED_SOURCE_DIR` instead. If an operator has an explicit reason to allow this, set `DOLLHOUSE_HOSTED_ALLOW_CREDENTIAL_GIT_URL=true`.

## Side-by-Side Canaries

Multiple hosted deployments can run on the same Docker host when each deployment uses a distinct deployment root and instance name. If `DOLLHOUSE_HOSTED_INSTANCE_NAME` is not supplied, the helper derives it from the basename of `DOLLHOUSE_HOSTED_DEPLOY_DIR`. For example:

- `/opt/dollhousemcp` derives `dollhousemcp`
- `/opt/dollhousemcp-canary` derives `dollhousemcp-canary`

The instance name is written to `.env.production` and used for:

- the Docker Compose project name
- generated container names: `<instance>`, `<instance>-postgres`, and `<instance>-caddy`
- the default image tag, using `<instance>-hosted:alpha` except for the backward-compatible default `dollhousemcp-hosted:alpha`

This prevents Docker container, network, volume, and image-tag collisions between production and canary stacks. Host ports are still exclusive. A canary on the same VPS must use alternate ports or a separate fronting proxy route; for example, LAN mode with `DOLLHOUSE_HOSTED_HTTP_BIND_PORT=3100`.

Once `.env.production` records an instance name, the helper rejects attempts to rename that instance inside the same deployment root.
Create a new deployment root for side-by-side canaries or migrations that need a different instance name.

## Deployment Modes

The helper supports three presets. The selected mode, hostname, public URL, proxy mode, bind address, and auth posture are written into `.env.production`, so a later `install`, `update`, or `render` can preserve the deployment shape even if the operator does not pass every variable again.

### `cloud`

`cloud` is the Dollhouse-operated alpha/demo shape. It renders:

- Caddy with automatic HTTPS on host ports `80` and `443`
- embedded Dollhouse OAuth/OIDC authorization server
- GitHub sign-in
- allowlist required
- open DCR enabled for alpha MCP-client compatibility

Use it for Dollhouse-managed cloud deployments where the server has a public hostname and Caddy can obtain certificates.

### `lan`

`lan` is for local or private-network installs. It renders:

- Caddy HTTP on `DOLLHOUSE_HOSTED_HTTP_BIND_PORT`, defaulting to `3000`
- loopback-only host binding by default: `DOLLHOUSE_HOSTED_BIND_ADDRESS=127.0.0.1`
- embedded Dollhouse OAuth/OIDC authorization server
- GitHub sign-in by default
- allowlist required
- open DCR disabled by default

To expose the server to other machines on the network, set `DOLLHOUSE_HOSTED_BIND_ADDRESS=0.0.0.0` or a specific IPv4 interface address and set `DOLLHOUSE_HOSTED_HOSTNAME` to the DNS name or IP address clients will use. For real enterprise or untrusted LAN use, put TLS in front of this path or use the `enterprise` preset with a proper hostname.

### `enterprise`

`enterprise` is for organization-controlled single-tenant deployments. It renders:

- Caddy with automatic HTTPS on host ports `80` and `443`
- allowlist required
- open DCR disabled by default
- configurable auth provider

Use `DOLLHOUSE_AUTH_PROVIDER=embedded` with `DOLLHOUSE_AUTH_METHODS=github` when the organization wants DollhouseMCP to run its own authorization server and use GitHub as the user sign-in method. Use `DOLLHOUSE_AUTH_PROVIDER=oidc` with `DOLLHOUSE_AUTH_ISSUER` and `DOLLHOUSE_AUTH_AUDIENCE` when the organization wants DollhouseMCP to validate access tokens issued by an external IdP such as Okta, Auth0, Keycloak, Google Workspace, or Microsoft Entra ID.

## Actions

### Remote Operator Wrapper

`npm run hosted:remote -- <action>` wraps the repo-owned helper for operator-managed SSH hosts. It is designed for the alpha/beta cloud path where an operator updates a VM but wants the manual safety steps automated.

Remote deploy actions use `StrictHostKeyChecking=yes`. For production-like use, enroll the host key first or provide a managed known-hosts file from your infrastructure tooling. The wrapper does not silently trust first-contact SSH keys.

It performs:

- local validation of target, hostname, ref, and options
- remote Docker Compose preflight
- remote env-file backup and database dump when an existing deployment is present
- remote clone of `DOLLHOUSE_HOSTED_GIT_URL` at `DOLLHOUSE_HOSTED_GIT_REF`
- remote execution of `scripts/hosted-deploy.sh <action>`
- remote summary of deployed revision, timestamp, portfolio size, and relevant containers
- local checks for `/healthz`, `/readyz`, and unauthenticated `/mcp`

Preview without SSH:

```bash
DOLLHOUSE_REMOTE_SSH_TARGET=root@203.0.113.10 \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
  npm run hosted:remote -- --dry-run update
```

Update with an explicit identity file and branch:

```bash
DOLLHOUSE_REMOTE_SSH_TARGET=root@203.0.113.10 \
DOLLHOUSE_REMOTE_SSH_IDENTITY_FILE=~/.ssh/dollhousemcp_alpha_hetzner_ed25519 \
DOLLHOUSE_REMOTE_KNOWN_HOSTS_FILE=./dollhouse_known_hosts \
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com \
DOLLHOUSE_HOSTED_GIT_REF=codex/hosted-http-integration \
  npm run hosted:remote -- update
```

Enroll a host key into a dedicated known-hosts file:

```bash
DOLLHOUSE_REMOTE_SSH_TARGET=root@203.0.113.10 \
DOLLHOUSE_REMOTE_KNOWN_HOSTS_FILE=./dollhouse_known_hosts \
  npm run hosted:remote -- enroll-host
```

The first pass scans the host key and prints fingerprints without writing. Verify those fingerprints out of band, for example against the provider console or your enterprise SSH host-key inventory. Then append the key explicitly:

```bash
DOLLHOUSE_REMOTE_SSH_TARGET=root@203.0.113.10 \
DOLLHOUSE_REMOTE_KNOWN_HOSTS_FILE=./dollhouse_known_hosts \
  npm run hosted:remote -- --accept-host-key enroll-host
```

Enterprise deployments can skip `enroll-host` and point `DOLLHOUSE_REMOTE_KNOWN_HOSTS_FILE` at a managed known-hosts file or host-CA-backed SSH configuration.

The wrapper does not replace `scripts/hosted-deploy.sh`; it calls it remotely after cloning the requested ref. It uploads its remote payload to a temporary `0600` script before execution so commands such as database dumps cannot consume the rest of a streamed SSH script from stdin. Use the direct helper when you are already logged into the target host or when building local/LAN and enterprise modes.

For remote actions, the wrapper forwards non-secret hosted configuration such as mode, bind ports, Host allowlists, trusted proxy CIDRs, resource limits, readiness timeouts, auth posture, OIDC settings, and bootstrap admin identity.
Those values are passed to the remote helper after the wrapper clones the requested ref.
It does not forward OAuth client secrets or other deployment secrets; place those in the remote `.env.production` or your remote secret-management flow before running the helper.

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

In `cloud` mode, the generated Compose file defaults to:

```yaml
DOLLHOUSE_AUTH_OPEN_DCR: "true"
```

This is the alpha compatibility shape for MCP clients such as claude.ai web and Gemini CLI that auto-register through Dynamic Client Registration. The server-side DCR policy validates redirect shape and records audit metadata, and user access is still governed by GitHub authentication plus the Dollhouse allowlist gate.

`lan` and `enterprise` default to:

```yaml
DOLLHOUSE_AUTH_OPEN_DCR: "false"
```

For clients that require unauthenticated DCR in a private test, explicitly set `DOLLHOUSE_AUTH_OPEN_DCR=true` before `render`, `install`, or `update`. Do that only when the endpoint is bound to loopback, protected by a trusted tunnel, or otherwise unreachable by untrusted clients.

## Current Limitations

- The public `curl | sh` installer URL does not exist yet.
- Local/LAN and enterprise modes currently cover generated deployment shape and docs; they still need real-container install/update validation in representative environments.
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

- Add a wrapper installer that can be served from a stable URL.
- Add optional real-container integration coverage for Docker environments.
