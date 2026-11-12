# Hosted Deployment Automation

Private-beta invitation enablement has additional qualification and rollback gates in the [onboarding runbook](private-beta-onboarding-runbook.md).

This guide tracks the executable deployment path for hosted DollhouseMCP.
It is the automation companion to the manual [Production Hosting Runbook](./production-hosting-runbook.md).

The source-built Caddy cutover described here is a future deployment path. It
does not itself authorize a release or establish that a registry artifact has
been published. Before using the examples, set the explicit Caddy image and two
volume variables listed below to values qualified for the intended deployment.
The image must be a registry digest reference whose native image config and
ordered layer identities match the retained Caddy qualification evidence.

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

For Cloudflare-fronted alpha deployments, follow the endpoint verification with
the real-client [Cloudflare Alpha Smoke Test](./cloudflare-alpha-smoke-test.md).
The smoke test covers OAuth discovery, GitHub sign-in, Dollhouse client consent,
bearer-token use, MCP read calls, Cloudflare WAF/rate-limit inspection, and log
redaction checks.

### Console UI cache policy

The hosted `/ui/` HTML points all local assets into one content-versioned
`/ui/__assets/<digest>/` directory. Relative JavaScript imports (including
lazy imports) and CSS font URLs stay in that same directory, so a new page
load cannot reuse modules cached under a previous release's stable URLs.
The application also serves the entire `/ui` tree with
`Cache-Control: no-store, max-age=0, must-revalidate`. Configure Cloudflare to **bypass
cache for `/ui` and `/ui/*`**, including any Cache Everything or Edge/Browser
Cache TTL rules that would override the origin policy. Caddy only proxies this
route; it does not provide a UI cache policy.

The generated Compose deployment has one application container. For a separate
multi-replica deployment, do not round-robin `/ui/` and asset requests across
different application releases: each replica serves only its own digest.
For UI-changing releases, atomically drain old replicas before exposing the new
release, or provide a shared origin retaining both asset digests or release-aware
affinity for the shell and its complete asset graph. Rolling mixed-version UI
traffic without one of these controls can return 404 for an unknown digest.
Shared asset serving and rolling-release qualification are tracked in
[#2857](https://github.com/DollhouseMCP/mcp-server/issues/2857).

After changing an existing Cloudflare rule, purge previously cached `/ui/*`
entries once. Verify the public URL without a cache-busting query after each
update or rollback:

```bash
BASE_URL=https://mcp.example.com
ASSET_BASE="$(curl -fsS "${BASE_URL}/ui/" | grep -oE '/ui/__assets/[a-f0-9]{16}' | head -1)"
for path in /ui/ "${ASSET_BASE}/app.js" "${ASSET_BASE}/connect.js" "${ASSET_BASE}/connect-catalog.js" "${ASSET_BASE}/connect.css"; do
  curl -sSI "${BASE_URL}${path}" | grep -Ei '^(HTTP/|cache-control:|cf-cache-status:)'
done
```

Every response should retain the origin `no-store` policy; Cloudflare should
not report a cached `HIT`. Compare ordinary asset responses with the exact
deployed build when validating a release. A cache-busted query alone can hide
a stale response at the normal URL. The old unversioned `/ui/*.js` URLs remain
available during the transition and also carry `no-store`.

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

Set `DOLLHOUSE_REMOTE_SKIP_BACKUP=true` or pass `--skip-backup` only when a separate backup already exists. For the explicit `legacy-offline-update` action, skipping is refused: the existing Compose file, `.env`, `.env.production`, successful database readiness and a nonempty dump are mandatory before invoking the helper. Set `DOLLHOUSE_HOSTED_LEGACY_CHECKPOINT` to the protected absolute checkpoint directory on the remote host; it is forwarded as one quoted argument only for that action, never persisted or inherited from stale remote state. These standard SQL/env backups supplement the independently verified VM dump and restore proof; see [the one-time handoff contract](legacy-maintenance-checkpoint.md).

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
| `DOLLHOUSE_HOSTED_CADDY_IMAGE` | Qualified Caddy image as `registry/repository@sha256:<digest>` | required |
| `DOLLHOUSE_HOSTED_CADDY_DATA_VOLUME` | Explicit named Caddy data volume | required |
| `DOLLHOUSE_HOSTED_CADDY_CONFIG_VOLUME` | Explicit, distinct named Caddy config volume | required |
| `DOLLHOUSE_HTTP_ALLOWED_HOSTS` | Comma-separated Host header allowlist passed to the app | `localhost,127.0.0.1,<hostname>` |
| `DOLLHOUSE_TRUSTED_PROXIES` | Comma-separated trusted proxy CIDRs passed to the app | Docker bridge CIDR `172.16.0.0/12` |
| `DOLLHOUSE_HOSTED_CADDY_ACCESS_LOG` | Enable Caddy access logs with OAuth/token query values redacted | `true` for `cloud`/`enterprise`, `false` for `lan` |
| `DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES` | Comma-separated edge proxy CIDRs Caddy may trust for client IP headers, for example Cloudflare ranges | none |
| `DOLLHOUSE_HOSTED_DOCKER_LOG_MAX_SIZE` | Docker `json-file` stdout/stderr rotation size for generated Compose services | `25m` |
| `DOLLHOUSE_HOSTED_DOCKER_LOG_MAX_FILE` | Docker `json-file` stdout/stderr rotated file count for generated Compose services | `5` |
| `DOLLHOUSE_HOSTED_SOURCE_DIR` | Local repo source to deploy | current repo when available |
| `DOLLHOUSE_HOSTED_GIT_URL` | Repo cloned when no source dir is available | GitHub mcp-server repo |
| `DOLLHOUSE_HOSTED_GIT_REF` | Branch/ref cloned when no source dir is available | `codex/hosted-http-integration` |
| `DOLLHOUSE_HOSTED_ALLOW_CREDENTIAL_GIT_URL` | Permit credentials embedded in `DOLLHOUSE_HOSTED_GIT_URL` | `false` |
| `DOLLHOUSE_AUTH_PROVIDER` | Auth provider: `embedded`, `oidc`, or `local` | `embedded` |
| `DOLLHOUSE_AUTH_METHODS` | Embedded-AS sign-in methods, for example `github` or `github,local-password` | `github` for `embedded`, empty for `oidc` |
| `DOLLHOUSE_AUTH_GENERATION` | Monotonic global authorization-invalidation generation; increment for cookie-secret rotation or intentional global sign-out | `0` |
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

For deployments behind a public edge proxy such as Cloudflare, keep `DOLLHOUSE_TRUSTED_PROXIES` scoped to the proxy that directly connects to the app container, usually the Docker bridge CIDR. Put the public edge CIDRs in `DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES` instead. Caddy then validates the edge hop before forwarding a normalized client IP to the app. The helper validates `DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES` as a comma-separated CIDR list with sane IPv4/IPv6 prefix lengths; use Cloudflare's published API to verify provider ownership/currentness. The generated Caddy access logs redact common OAuth, invite, and token query parameters such as `code`, `state`, `token`, `invite`, `access_token`, and `client_secret`.

When migrating an older Cloudflare-fronted deployment that stored public edge CIDRs in `DOLLHOUSE_TRUSTED_PROXIES`, set `DOLLHOUSE_HOSTED_CADDY_TRUSTED_PROXIES` on the update and leave `DOLLHOUSE_TRUSTED_PROXIES` unset. The helper will reset the app trusted-proxy list to the direct Caddy/Docker hop default. Set `DOLLHOUSE_TRUSTED_PROXIES` explicitly only when the direct hop uses a custom Docker network or VPC CIDR.

For Cloudflare, validate the CIDR list at deploy time rather than copying an old list blindly:

```bash
curl -fsS https://api.cloudflare.com/client/v4/ips |
  jq -r '[.result.ipv4_cidrs[], .result.ipv6_cidrs[]] | join(",")'
```

As of 2026-06-08, Cloudflare published these ranges for the hosted alpha deployment:

```text
173.245.48.0/20,103.21.244.0/22,103.22.200.0/22,103.31.4.0/22,141.101.64.0/18,108.162.192.0/18,190.93.240.0/20,188.114.96.0/20,197.234.240.0/22,198.41.128.0/17,162.158.0.0/15,104.16.0.0/13,104.24.0.0/14,172.64.0.0/13,131.0.72.0/22,2400:cb00::/32,2606:4700::/32,2803:f800::/32,2405:b500::/32,2405:8100::/32,2a06:98c0::/29,2c0f:f248::/32
```

Cloudflare WAF and rate-limit rules are configured in Cloudflare, not by this helper. Before making a Cloudflare-fronted deployment generally available, validate that rules exist for auth callbacks, DCR/client registration, MCP endpoints, and admin surfaces, and that the rule actions are tested against legitimate OAuth and streamable HTTP clients.

Use the [Cloudflare Alpha Smoke Test](./cloudflare-alpha-smoke-test.md) after
changing those edge rules.

All helper-managed Docker Compose commands run with `--env-file .env.production`. This matters because Compose normally reads `.env` for variable interpolation, while `env_file: .env.production` only controls container environment injection.

Generated Compose files set per-service Docker `json-file` log rotation for
Postgres, DollhouseMCP, the migration container, and Caddy. This preserves
container-native `docker compose logs` behavior while bounding stdout/stderr
growth on long-running hosts. The defaults keep up to five 25 MB files per
container; set `DOLLHOUSE_HOSTED_DOCKER_LOG_MAX_SIZE` and
`DOLLHOUSE_HOSTED_DOCKER_LOG_MAX_FILE` before `render`, `install`, or `update`
to change that local retention policy. Centralized log shipping and longer
retention are separate production/beta concerns.

The generated Postgres init script is a shell script (`init-db.sh`) rather than a password-filled SQL file. It receives the app role password through `DOLLHOUSE_APP_DB_PASSWORD` at container init time and passes it to `psql` as a variable, so the generated init script itself does not contain the app database password.

The generated Compose file uses the explicitly selected, qualified Caddy
digest. Before a proxy-changing start, the helper verifies the native image
against retained source, config, and layer evidence; later Compose starts use
`--pull never`. An unchanged, verified hardened proxy remains running.

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

Renders files, stages a new server bundle, rebuilds the `dollhousemcp` image, ensures Postgres is ready, runs migrations, restarts the `dollhousemcp` service, and verifies. An unchanged qualified hardened Caddy proxy and its volumes remain in place; a changed proxy requires an offline migration and its own recovery receipt.

```bash
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com npm run hosted:deploy -- update
```

Both `install` and a proxy-changing `update` qualify the selected Caddy image before stopping an existing app. Preparation checks the immutable running PostgreSQL container without recreating it and rechecks that Compose still selects the same container. A running app with absent or stopped PostgreSQL refuses preparation; PostgreSQL may be initialized only when no app is running. Readiness is an availability check, not an authentication or grant test.

The hosted host requires Python 3.11 or newer, a local Linux Docker daemon,
and `flock`. The private deployment environment file is a trusted-administrator
shell input; protect it accordingly. The helper verifies the native daemon
platform and Caddy image configuration, source labels, and ordered DiffIDs,
then uses `--pull never` for the admitted proxy. A registry digest alone is
not qualification of an arbitrary image. A first install creates only new,
transaction-labeled volumes and checks the image's UID 1001 data/config layout;
existing names require the matching protected creation receipt.
Mutating `render`, migration, and bootstrap preparation also acquire the
deployment lock before writing files; dry-run does not acquire it or mutate files.

For a legacy proxy or a changed hardened proxy, select two **new**, explicit
destination volume names and run `prepare-caddy-offline` in an approved offline
window using the host-local helper; the remote wrapper does not accept this
action. It checks the original running proxy, image, source, volume identities,
other writers and selected replacement before issuing SIGTERM with an infinite
daemon grace period. It then verifies the exact clean stop before cloning.
The Docker client has a bounded wait: a timeout means the stop outcome is
**unknown**, not that ingress is closed. See the [Docker stop reference](https://docs.docker.com/reference/cli/docker/container/stop/).
The old proxy container, source, and data and config volumes remain in place.

```bash
DOLLHOUSE_HOSTED_CADDY_IMAGE='registry.example/caddy@sha256:<qualified-digest>' \
DOLLHOUSE_HOSTED_CADDY_DATA_VOLUME='new-caddy-data' \
DOLLHOUSE_HOSTED_CADDY_CONFIG_VOLUME='new-caddy-config' \
  npm run hosted:deploy -- prepare-caddy-offline
```

After a successful preparation ingress is closed, and nothing has begun that
`recover-caddy-proxy` could recover from. If the window is given up before the
update starts, for example because the checkpoint that follows cannot be
completed, bring the same proxy back with `abandon-caddy-offline`, using the
same image and destination volume names:

```bash
DOLLHOUSE_HOSTED_CADDY_IMAGE='registry.example/caddy@sha256:<qualified-digest>' \
DOLLHOUSE_HOSTED_CADDY_DATA_VOLUME='new-caddy-data' \
DOLLHOUSE_HOSTED_CADDY_CONFIG_VOLUME='new-caddy-config' \
  npm run hosted:deploy -- abandon-caddy-offline
```

It verifies the stopped proxy against the preparation's clone receipt (the same
container, its full profile, a clean stop, free ports), starts that one
container once, and requires its recorded Caddy configuration and the public
legacy acceptance within bounded waits. If a check fails after the start, it
stops the proxy once more without force and refuses: ingress is closed again.
The clone, its receipt and the new volumes stay. A later preparation needs new
destination volume names.

A reconciled legacy proxy is bound to one boot. `abandon-caddy-offline` records
the new boot in a write-once record beside the reconciled serving record, and
later actions follow those records. If Docker or the host restarted that proxy,
`accept-caddy-restart` checks that the running container is the same one, with
the same profile, configuration and public acceptance, and records its new boot
with the host's and the Docker daemon's start times. It starts and stops
nothing. Without such a record, a proxy with another boot is refused. One
reconciled proxy can have at most 32 recorded later boots. At that bound both
actions refuse before they start or record anything.

Before stopping ingress, preparation runs that same copier's full source
validation in a source-only, read-only helper. It mounts only the two original
volumes and its script; no destination volume is mounted or created. Source
refusal or unconfirmed helper cleanup leaves the original proxy serving. Live
content can change after this preliminary check, so the later stopped clone
and verification still take their own authoritative inventory.

Only root-owned (`0:0`), immediate `data/caddy` and `config/caddy` source
directories with exact mode `01777` receive legacy compatibility treatment.
Their originals stay unchanged; their destination copies become `0750`, owned
by `1001:1001`. The receipt retains the raw source modes and inventory hash.
Other unsafe paths, owners, modes, links and file types remain refused.
Bounded Docker failures emit exit/UNKNOWN status, stderr, elapsed time and the
time budget before owned helper cleanup; keep the operator log private.
After any failed attempt, retain its partial volumes and receipts and select
new, absent destination names for a separately approved window. Never reuse
partial destinations or clear an unknown-outcome fence to retry.

The clone uses the separately approved, locally available pinned Node helper,
checks the full tree and certificate hashes, and writes a protected receipt
binding the proxy, source bundle, config, and volume identities. No other
container or host process may write either source or destination during this
procedure. The deployment lock coordinates this helper only; Docker does not
provide an atomic lease against other administrators. A protected stop-issued
fence blocks subsequent deployment operations if the stop times out or the
process crashes; it is not automatically cleared from a later stopped state.
An operator must reconcile that uncertain operation before further mutation.
Partial destination volumes remain for inspection and must not be reused.

Successful preparation deliberately leaves ingress closed; it does not run
the app handoff or an update. The receipt reserves a future previous-bundle
path, but the bundle is not staged yet, so `recover-caddy-proxy` is not ready
on that receipt alone. Complete the separately qualified legacy handoff first;
the later guarded update stages that bundle, rechecks the clone, starts and
verifies the normal serving profile, and completes its transition. Select the
same qualified image and destination volume names for that update; preparation
does not persist these inputs. Subsequent
ordinary updates preserve an unchanged qualified proxy without another offline
clone. Keep other writers stopped through the update. Unsupported
container profiles, ambiguous receipts, unexpected files, and changed source
or volume identities refuse the operation. Actual host and Docker-profile
qualification remains a separate predeployment gate.

`recover-caddy-proxy` is a proxy-only operation: it checks the selected prior
bundle and protected receipt, verifies the prior image and original volumes,
and restores their recorded supported proxy contract. It does not move source
or change the app or database. Manual `rollback` also requires the matching
proxy receipt and continues its existing app/source rollback; the operator
must establish a compatible app and database recovery plan. A recovered proxy
may use a protected config snapshot and original volumes rather than the
current generated Compose selection, so do not recreate it from that selection
without a separately reviewed cutover. There is no automatic app or schema
rollback after a proxy failure.
The protected transition state keeps the last completed source pointer while
recording an in-progress replacement separately. It publishes the new pointer
only after the existing public verification succeeds. An unfinished transition
blocks app/source rollback instead of guessing from bundle names. Explicit
proxy-only recovery can use the matching pending receipt when its source and
proxy still validate. A first-install retry requires its own managed volume
receipt, matching staged-source identity, no deployment markers, and no
existing app, PostgreSQL, or Caddy container for the selected instance. Unreceipted volumes or an
ambiguous interrupted transition remain for operator inspection.
The replaced proxy container is retained stopped after a successful recovery.
That can leave more than one container with the same Compose service labels;
later Caddy automation refuses the ambiguous selection until an operator has
reviewed and resolved it. The helper does not delete the retained container or
its volumes automatically. A private `.caddy-transactions/success-*.json` record
binds the retained container ID and its validated image and runtime profile to
the prior source receipt. Inspect that exact stopped container and the active
proxy before resolving duplicate labels. Preserve the record, images and both
sets of volumes; do not remove volumes when resolving the container ambiguity.

The non-force graceful-stop fence precedes migrations, grants, and optional admin bootstrap. Those writes cannot safely run alongside an old app without a separately established compatibility contract. Migration, grant, or bootstrap failure leaves the app stopped. Replacement or proxy failure can leave a partially replaced stack; inspect its actual state before deliberate recovery from a compatible image and database point. The helper does not automatically restart the old app against a possibly changed schema. Keep ingress closed during recovery and verify the selected recovery state before reopening it.

The private control profile supports only the hosted Streamable HTTP transport. Opting in on stdio or standalone `--web` refuses before the private listener or normal owner graph is created; standard non-opted stdio is unchanged. Future stdio qualification is tracked in [#3056](https://github.com/DollhouseMCP/mcp-server/issues/3056).

The fence requires the `org.dollhousemcp.memory-upgrade-drain=v2` image capability and the hosted renderer's explicit `DOLLHOUSE_MEMORY_UPGRADE_CONTROL_DIR=/app/.memory-upgrade-control` setting. It refuses a read-only container root or any mount covering that directory. This private directory belongs to the container's writable layer, outside temporary and customer portfolio mounts. Read-only HTTP profiles and older images do not acquire this contract automatically.

The operator client first requests a durable, nonce-bound drain acknowledgement from the existing root lifecycle through a private Unix socket. Admission remains closed, and the persisted intent and drain state prevent a restarted process in that same container from accepting new work. Requested, failed, corrupt, or unknown state cannot become a successful drain merely because the restarted process has empty memory. A known drained successor exposes only the closure protocol. Neither state is automatically cleared or reopened.

The helper requires an initially running selected container. An already stopped container cannot supply the live acknowledgement and is refused even if its exit code was zero; it is never automatically started to obtain one.

Only a validated acknowledgement with zero original obligations permits the helper's single Docker TERM. Every failure or deadline before that acknowledgement leaves Docker's restart policy and manual-stop state untouched. After acknowledgement, a close failure still refuses replacement without escalation. The helper never changes the restart policy, sends a forced kill, or exposes a public maintenance endpoint. The existing total and per-command deadlines remain in force; a disconnected client does not cancel or replay original work. These guarantees require both process and Docker-engine qualification; fixture adapter tests alone do not prove restart eligibility.

The unchanged 10-second command cap also applies to the drain client. A drain taking 10–30 seconds can therefore finish after that client has disconnected, while the helper has already refused replacement. Keep the original process alive with admission closed; an explicit later invocation may read its settled, durable acknowledgement without replaying accepted work. Neither a client timeout nor empty successor accounting supplies that acknowledgement.

Deployed revision and time markers are recorded only after replacement succeeds. Failed preparation or drain refusal can leave the prepared source and image tag different from the healthy running image, with the prior bundle retained under `server.prev-*`. A post-drain failure can likewise leave prepared source with the old markers; neither state is a completed update or proof that the source pointer was restored. The subsequent health verification remains a separate step.

### `migrate`

Renders files, rebuilds the current `dollhousemcp` image if needed, waits for Postgres, and runs:

```bash
docker compose --env-file .env.production run --rm dollhousemcp-migrate
```

The `dollhousemcp-migrate` service uses the shell-free `migration` target. It requires `DOLLHOUSE_DATABASE_ADMIN_URL` and runs the compiled Drizzle ORM migrator against the same SQL journal and migration history table. The hosted bootstrap command also requires that administrator URL and runs directly with Node. The separate builder target remains available for development; it is not the hosted maintenance image. URL `sslmode` settings are preserved; conflicting explicit `DOLLHOUSE_DATABASE_SSL` settings and URL-specified certificate or key file paths are refused rather than silently ignored. A receipt-bound rollback builds only the selected application image and does not run migrations; assess schema compatibility before rolling back.

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

#### How the first admin is claimed

You name one GitHub account and that account becomes the admin by signing in. There is no setup code to copy, and nothing secret is printed or logged.

1. `bootstrap-admin` resolves the username to GitHub's numeric account ID once and prints the ID it resolved. Check it is the account you meant. The server stores the ID, not the username.
2. The first time that account signs in to the console at `/ui/` it is the admin. It is admitted even when the sign-in allowlist is required and still empty. Everyone else has to be on the allowlist or invited.
3. Signing in does not elevate. Admin actions still need an authenticator app, set up under Security, and a step-up with its code.

What to rely on:

- **The match is on the account ID.** Renaming the GitHub account does not change who the admin is, and a different account that later takes the old username gets nothing.
- **It can be claimed once.** Re-running `bootstrap-admin` for the same account is harmless. Running it for a different account is refused; transferring admin is a separate operation. Two claims made at the same moment settle on exactly one.
- **It is audited.** The claim is recorded as `auth.bootstrap.completed` with the account and how it was designated.
- **Until it is done, nobody can sign in.** Every sign-in is refused with `bootstrap_required` and `/readyz` reports not ready.

An install done by hand, without this tooling, has to run the same command once inside the container, because the server does not read the bootstrap variables itself (#3235):

```bash
dollhouse-admin-bootstrap --method github --github-username octocat
```

### `rollback`

Validates the selected previous source bundle and its unique proxy receipt.
Rollback proceeds only when that receipt matches the unchanged running proxy;
a rollback requiring a different proxy is refused before source or proxy
mutation. It retains the current source as `server.rollback-from-*`, rebuilds
the app image, and checks PostgreSQL. It then verifies a restricted Caddy
profile before the non-force app drain and replacement. Public acceptance runs
behind that profile; only after it passes does the operation activate and
read back the normal profile, finish the receipt, and write deployed markers.

This control requires rootful Linux, fixed system `nsenter`, `curl`, and Docker
tools, and permission to enter the selected proxy's network namespace. The
temporary persisted profile permits only the three unauthenticated HTTP/1.1
GET probes with an empty body; it binds their responses to the transition.
Authenticated acceptance requires a separately qualified private probe before
release. A failed or unacknowledged activation remains pending: a bounded stop
is attempted, but an unknown stop can leave ingress active. Retain the
recovery point and reconcile it explicitly; the pending marker is not itself
a network fence. Normal operation restores the ordinary HTTP/1.1 and HTTP/2
profile and does not require another clone for an unchanged proxy.

The shared PostgreSQL preparation checks the pinned running container without recreation and refuses if a running app has no running PostgreSQL. It may start PostgreSQL only when no app is running.

```bash
DOLLHOUSE_HOSTED_HOSTNAME=mcp.example.com npm run hosted:deploy -- rollback
```

Rollback restores the application source bundle only. It does not roll database schema backward; use it for ordinary failed app deploys, not for a migration that requires a planned database restore.

After rolling back to a source bundle that predates slim maintenance, `migrate` and `bootstrap-admin` are unavailable until the server is rolled forward to a supported source and rendered again. Rollback builds only the application image and does not run migrations.

A preparation failure leaves the running app and deployed revision/timestamp markers in place; `server` and image tags may already contain the prepared rollback candidate, while `server.rollback-from-*` retains the current source. The prepared source/tag may therefore differ from the running image; this is not a completed rollback or a restored active source pointer. Use the retained bundle for source recovery. Deployed markers change only after successful replacement. A drain refusal prevents replacement and retains the old process and its work. No forced stop follows that refusal.

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

For private-beta invitation onboarding, also register the exact enrollment callback and complete the [onboarding runbook’s provider prerequisites](private-beta-onboarding-runbook.md#provider-and-log-prerequisites) before enablement. The ordinary sign-in callback above remains required.

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

### Digest-selected application images

Set `DOLLHOUSE_HOSTED_IMAGE_MODE=registry` with independent immutable
`DOLLHOUSE_HOSTED_RUNTIME_IMAGE` and `DOLLHOUSE_HOSTED_MIGRATION_IMAGE`
references in `registry/repository@sha256:<digest>` form. These operands are
persisted for subsequent local and remote operations. Registry mode renders no
application or maintenance build sections. It pulls and checks both image roles
and their native platform before draining the application, then rechecks the
selected identities before maintenance and replacement. Their matching source
labels express pair consistency only; separately qualify image provenance and
security before selection.

After a successful drain, the application is always recreated with a fresh
private control layer, even when both digest selections are unchanged. The
unchanged qualified Caddy proxy is retained. Registry-mode rollback is refused
before proxy recovery or source movement: select a separately qualified
roll-forward plan instead. Switching an existing registry deployment back to
build mode in place is also refused. Existing Caddy migration and one-time legacy offline
handoff gates still apply; selecting application digests does not bypass them.
