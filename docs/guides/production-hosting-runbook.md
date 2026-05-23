# Production Hosting Runbook

End-to-end walkthrough for deploying DollhouseMCP as a hosted HTTP service on a real domain. The deployment shape is:

- HTTP transport (Streamable HTTP) terminating TLS at a reverse proxy
- PostgreSQL storage backend with per-user Row-Level Security
- Embedded OAuth/OIDC authorization server with the GitHub method
- A small number of authenticated users (single team, friend-hosted, or small SaaS)

This guide assumes you have read [Auth Server Setup](./auth-server-setup.md) and chose **Path D — Postgres-backed (production-shape)**. That guide explains the auth model in depth; this one is the operations counterpart that takes you from "I have a domain" to "the deploy is live, observable, and recoverable."

For a vendor-specific Cloudflare Tunnel ingress (no port forwarding, no Caddy), see [Cloudflare Tunnel ingress](#cloudflare-tunnel-ingress-appendix) at the end.

---

## Contents

- [Decision: container vs bare binary](#decision-container-vs-bare-binary)
- [Prerequisites](#prerequisites)
- [Pre-deploy decisions](#pre-deploy-decisions)
- [Path A — Container behind Caddy + Let's Encrypt (recommended)](#path-a--container-behind-caddy--lets-encrypt-recommended)
- [Path B — Bare binary on a host with systemd](#path-b--bare-binary-on-a-host-with-systemd)
- [Managed Postgres notes](#managed-postgres-notes)
- [Public endpoint allowlist](#public-endpoint-allowlist)
- [Ongoing operations](#ongoing-operations)
- [Production checklist](#production-checklist)
- [Cloudflare Tunnel ingress (appendix)](#cloudflare-tunnel-ingress-appendix)
- [Troubleshooting](#troubleshooting)

---

## Decision: container vs bare binary

Both deployment shapes are supported. Pick based on what you already know how to operate.

| | Container (Docker Compose) | Bare binary (Node + systemd) |
|---|---|---|
| **Best for** | Operators comfortable with Docker; multi-service deployments; teams without a configuration-management story | Operators with existing Node infrastructure; managed Postgres customers; host-level observability stacks |
| **Setup time** | ~30 min for first deploy | ~45 min for first deploy (systemd unit, log rotation, user setup) |
| **Update cadence** | `docker compose pull && docker compose up -d` | `git pull && npm install && npm run build && systemctl restart dollhousemcp` |
| **Postgres co-location** | Same compose, named volume (simplest) | Usually a separate service (managed Postgres or self-hosted on a different unit) |
| **Process supervision** | Docker daemon (`restart: unless-stopped`) | systemd (`Restart=on-failure`) |
| **Logging surface** | `docker compose logs`; JSON drivers can ship to a host log shipper | `journalctl` or `StandardOutput=append:` direct to `/var/log` |
| **Resource limits** | Compose `deploy.resources.limits` or `--memory`/`--cpus` | systemd `MemoryMax=`, `CPUQuota=` |
| **Filesystem isolation** | Container filesystem (volume mounts for portfolio + Postgres data) | Host filesystem (recommend `User=dollhouse` + `ProtectSystem=strict`) |
| **Image immutability** | Pinned image digest (recommended) — same code on every host | Whatever's checked out + built |

**Default recommendation: container.** It removes one entire class of "I need to install the right Node version" issue and the deploy unit is reproducible across hosts. Choose bare binary if you already operate Node services this way and your tooling assumes it.

The remainder of this runbook documents Path A (container) as the primary; [Path B](#path-b--bare-binary-on-a-host-with-systemd) is a complete bare-binary alternative.

---

## Prerequisites

- A domain you control with DNS access (Cloudflare, Route 53, Namecheap, etc. — any provider that lets you add A/AAAA records)
- A host with a public IP (VPS, dedicated server, friend's home server with port forwarding, etc.) and SSH access
- The host has Docker + Docker Compose (Path A) or Node 22+ and PostgreSQL access (Path B)
- A GitHub account that can own the OAuth app
- Roughly 30 minutes for the first deploy

If you do not have a host yet, any of Hetzner Cloud, DigitalOcean, Linode, Vultr, AWS Lightsail, or Oracle Cloud Free Tier are fine for a small deploy. A 2 GB / 1 vCPU machine handles a dozen concurrent users comfortably.

---

## Pre-deploy decisions

Resolve these before touching the host. Each one is small but inverting them later is expensive.

### TLS termination strategy

| Option | When to pick | Pros | Cons |
|---|---|---|---|
| **Caddy + Let's Encrypt** (Path A default) | Single host, simple setup | Auto-renewing certs, one-line config, host owns its own IP | Need port 80/443 open inbound |
| **nginx + Let's Encrypt via certbot** | You already operate nginx | Familiar tooling, fine-grained config | More moving parts; cron-based renewal |
| **Cloudflare Tunnel** | Zero port-forwarding desired; CGNAT or behind-NAT host | No inbound ports; CF handles TLS + DDoS | Vendor dependency; egress-only bandwidth from origin to CF |

Pick one. The Caddy and nginx paths are equivalent below; Cloudflare Tunnel is documented in the [appendix](#cloudflare-tunnel-ingress-appendix).

### Postgres location

| Option | When to pick |
|---|---|
| **Same Docker Compose as the server, named volume for `pgdata`** | Single-host friend-hosted deploy. Simplest backups (one volume). Default unless you have a reason. |
| **Managed Postgres** (Supabase, Neon, RDS, Cloud SQL, Crunchy Bridge) | Multi-host scaling, point-in-time recovery, automated backups. The convenience tax is real if you're going to run a deploy for more than a few months. |
| **Self-hosted Postgres on a separate host** | You already run Postgres for other things and have a process for it. Adds TLS + firewall + auth complexity vs option 1. |

The same-compose layout is the assumed default below. The [Managed Postgres notes](#managed-postgres-notes) subsection covers what to change.

### Authenticated-user allowlist

GitHub OAuth via the embedded AS will let any GitHub-account holder complete the OAuth flow and obtain a regular-user JWT unless you gate sign-up. For production deployments, gate it — see Pattern 1 below.

Five patterns exist; the **built-in allowlist (Pattern 1)** is the recommended starting point because it requires no extra infrastructure and covers MCP and web console uniformly. The other patterns are fits for specific operational constraints (existing GitHub Org, defense-in-depth at the edge, etc.).

| Pattern | Where the gate lives | Gates MCP? | Gates console? | MCP client impact |
|---|---|---|---|---|
| **1. Built-in allowlist** (recommended) | DollhouseMCP `auth_allowlist` table or `~/.dollhouse/auth/allowlist.json` | Yes | Yes | None — gate is invisible when the user is on the list. |
| **2. GitHub Org membership check** | GitHub's OAuth-app config | Yes | Yes | None. Non-members fail at GitHub's consent screen. |
| **3. Cloudflare Access in front of the hostname** | Cloudflare edge | Yes | Yes | MCP clients need Cloudflare service tokens. Browser users SSO normally. |
| **4. `oauth2-proxy` sidecar in front of everything** | Reverse proxy layer | Yes | Yes | MCP clients need a static-token bypass; adds a service to operate. |
| **5. No allowlist + admin-only pre-claim** | Nothing | No | No | None. Anyone with a GitHub account can sign in; only the pre-claimed account is admin. |

#### Pattern 1: Built-in sign-in allowlist (recommended)

DollhouseMCP ships an `auth_allowlist` table (DB mode) or `~/.dollhouse/auth/allowlist.json` (filesystem mode). The gate fires on **every** sign-in method — GitHub OAuth, magic-link, and local-password — uniformly. The bootstrap admin always passes, so you cannot lock yourself out.

**Enforcement mode:** controlled by `DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED`.

| Setting | Behavior |
|---|---|
| `false` (default) | Empty list = no gate (back-compat). Once you add a first entry, the gate activates. |
| `true` (recommended for hosted production) | Empty list = bootstrap admin only. Even unconfigured deploys won't sit open to the public internet. |

When `REQUIRED=false` AND the server binds to a non-loopback host AND a social method (`github` / `magic-link`) is configured, a startup warning fires naming the open-sign-in risk. Set `REQUIRED=true` to silence it.

**Managing the list:** the dedicated `dollhouse-allowlist` CLI. NOT exposed through MCP-AQL (security policy stays out of AI-mediated surfaces).

```bash
# Add by email
docker compose run --rm dollhousemcp \
  npx dollhouse-allowlist add --kind email --value mick@example.com --note "engineering"

# Add by GitHub username (case-insensitive)
docker compose run --rm dollhousemcp \
  npx dollhouse-allowlist add --kind github_username --value insomnolence

# Add by stable GitHub numeric ID (survives rename)
docker compose run --rm dollhousemcp \
  npx dollhouse-allowlist add --kind github_id --value 1125822 --note "founder"

# List entries (sorted by kind)
docker compose run --rm dollhousemcp \
  npx dollhouse-allowlist list

# Remove
docker compose run --rm dollhousemcp \
  npx dollhouse-allowlist remove --kind email --value mick@example.com

# Update note (kind/value are immutable — remove + re-add to change those)
docker compose run --rm dollhousemcp \
  npx dollhouse-allowlist update --id <uuid> --note "new note"
```

For **filesystem mode** (no DB), the same CLI works, OR you can edit `~/.dollhouse/auth/allowlist.json` directly — the server picks up changes within ~1 second via fsnotify, no restart needed.

**Match rules:** the gate ORs across all configured kinds. An entry matches if **any** of the verified identity values (email, GitHub username, GitHub numeric ID) is on the list. Values are lowercased on insert; matching is case-insensitive for emails and usernames.

**Denial behavior:** a denied user sees an "Access denied" HTML page (not a raw JSON error), and an `auth.allowlist_denied` event lands in `auth_identity_events` with their identity values for operator diagnosis. The audit log is queryable via `psql` or the future web console.

**Optional seed file:** for GitOps shops, set `DOLLHOUSE_AUTH_ALLOWLIST_SEED_FILE=/path/to/seed.json`. On startup, the AS idempotently upserts each entry from the seed file into the active store. Useful for keeping the allowlist alongside the rest of your infrastructure-as-code:

```json
{
  "entries": [
    { "kind": "email", "value": "todd@example.com", "note": "founder" },
    { "kind": "github_username", "value": "insomnolence" }
  ]
}
```

The seed file is **additive** — entries already in the store stay, even if not in the seed. To remove an entry, use the CLI.

#### Pattern 2: GitHub Organization membership

Fits "I have a team org and only that org should sign in." Stacks cleanly on Pattern 1 if you want both.

1. Create or use a private GitHub org. Add every user who should have access.
2. In the GitHub OAuth app's settings → **Organization access** → request OAuth access for the org. Approve as the org owner.
3. In the org's settings → **Third-party access** → restrict to approved apps OR open access; your OAuth app must be approved.
4. Anyone who isn't a member of the org sees "You don't have access" at GitHub's consent screen and never reaches the callback.

Gates both MCP and console because both flow through the same `/auth/social/github/callback`.

#### Pattern 3: Cloudflare Access

Strongest defense-in-depth — unallowed users can't even see the AS endpoints. Stacks with Pattern 1 if you want belt-and-suspenders.

1. Add the hostname to a Cloudflare Access policy (Zero Trust → Access → Applications → Add → Self-hosted).
2. Configure the identity provider (Google Workspace, GitHub, one-time PIN, etc.) and allow rules.
3. **For MCP clients**, create a Service Token (Zero Trust → Access → Service Auth → Service Tokens). The token is a `CF-Access-Client-Id` + `CF-Access-Client-Secret` header pair. Configure your MCP client to send these on every request.
4. **For browser users**, Cloudflare handles SSO transparently.

Setup time: ~30 min. Free tier supports up to 50 users.

#### Pattern 4: `oauth2-proxy` sidecar

Run [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) as a reverse-proxy sidecar. Configure it as an OIDC client of the embedded AS (or against an external IdP) and gate all paths behind an `OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE` allowlist.

MCP clients need a static-token bypass (`OAUTH2_PROXY_SKIP_AUTH_ROUTES` for specific paths, or a Bearer-token validation extension). The most operational complexity of the four; use only if Patterns 1–3 don't fit.

#### Pattern 5: No allowlist (back-compat default)

`DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED=false` with an empty list. Anyone with a GitHub account can sign in. Only acceptable for personal-use deploys where every account is welcome. Combine with secure-by-default — `DOLLHOUSE_AUTH_OPEN_DCR=false`, host hardening, etc. — to bound the blast radius. The runbook's checklist nudges you toward Pattern 1 for production.

---

## Path A — Container behind Caddy + Let's Encrypt (recommended)

### A.1 Host hardening (boring but essential)

Before deploying anything:

- **Disable password SSH.** `PasswordAuthentication no` in `/etc/ssh/sshd_config`. Key-only.
- **Enable unattended security updates.** `apt install unattended-upgrades` on Debian/Ubuntu; equivalent on RHEL-family. The MCP server runs in a container so most CVEs come via the host, not the app.
- **Default-deny inbound firewall.** Only allow SSH, HTTP, HTTPS. `ufw default deny incoming; ufw allow ssh; ufw allow http; ufw allow https; ufw enable`.
- **Non-root operator account.** Create a dedicated user for running compose commands so the docker daemon's privileges don't cascade through your shell history.

### A.2 DNS

Create a single A record (or AAAA, if you have IPv6) pointing `mcp.your-domain.com` to the host's public IP. Wait for propagation:

```bash
dig +short mcp.your-domain.com
# Should print the host IP
```

The hostname can be whatever you want — `dollhouse.your-domain.com`, `agents.your-domain.com`, the apex `your-domain.com`, etc. The MCP service, the embedded AS, and the web console all live at this single hostname.

### A.3 Project layout on the host

```
/opt/dollhousemcp/
  compose.yml             # the Docker Compose file (below)
  Caddyfile               # Caddy reverse proxy config
  .env.production         # secrets + config (mode 0600)
  pgdata/                 # Postgres data volume (created on first start)
  portfolio/              # DollhouseMCP file portfolio (created on first start)
  logs/                   # optional, only if you mount logs out of the container
```

`mkdir -p /opt/dollhousemcp && cd /opt/dollhousemcp`, then create the files below.

### A.4 Generate secrets

These are the secrets your deployment needs. Generate them once and persist them in `.env.production`:

```bash
echo "DOLLHOUSE_COOKIE_SIGNING_SECRET=$(openssl rand -hex 32)"
echo "DOLLHOUSE_INVITE_TOKEN_SECRET=$(openssl rand -hex 32)"
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
echo "POSTGRES_ADMIN_PASSWORD=$(openssl rand -hex 24)"
```

Append the output to `.env.production`, then `chmod 0600 .env.production`. **Never commit this file.** Back it up encrypted (`age` / `gpg` / a secrets manager) separately from the Postgres data backup, so a single bucket compromise doesn't yield both data and keys.

For the GitHub OAuth app credentials, generate them in step [A.6](#a6-register-the-github-oauth-app) and add them to the same file.

### A.5 `compose.yml`

```yaml
services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: dollhouse
      POSTGRES_PASSWORD: ${POSTGRES_ADMIN_PASSWORD}
      POSTGRES_DB: dollhousemcp
    volumes:
      - ./pgdata:/var/lib/postgresql/data
      # init-db.sql is generated in step A.7. Mounted read-only; postgres
      # runs it once on first boot, before accepting connections.
      - ./init-db.sql:/docker-entrypoint-initdb.d/00-create-roles.sql:ro
    # No host port mapping — only reachable from the docker network.
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U dollhouse -d dollhousemcp"]
      interval: 10s
      timeout: 3s
      retries: 5

  dollhousemcp:
    image: ghcr.io/dollhousemcp/mcp-server:latest  # pin to a digest for production
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    env_file:
      - .env.production
    environment:
      # Transport
      DOLLHOUSE_TRANSPORT: streamable-http
      DOLLHOUSE_HTTP_HOST: 0.0.0.0
      DOLLHOUSE_HTTP_PORT: 3000
      DOLLHOUSE_HTTP_ALLOWED_HOSTS: mcp.your-domain.com
      DOLLHOUSE_TRUSTED_PROXIES: 172.16.0.0/12   # docker default bridge CIDR; adjust if you use custom networks

      # Public-facing URL — issued JWTs and discovery docs advertise this
      DOLLHOUSE_PUBLIC_BASE_URL: https://mcp.your-domain.com

      # Storage backend = Postgres for everything
      DOLLHOUSE_STORAGE_BACKEND: database
      DOLLHOUSE_DATABASE_URL: postgres://dollhouse_app:${POSTGRES_PASSWORD}@postgres:5432/dollhousemcp
      DOLLHOUSE_DATABASE_ADMIN_URL: postgres://dollhouse:${POSTGRES_ADMIN_PASSWORD}@postgres:5432/dollhousemcp
      DOLLHOUSE_DATABASE_SSL: disable  # docker bridge is private; if PG is elsewhere set to 'require'
      DOLLHOUSE_DATABASE_POOL_SIZE: 20

      # Embedded AS
      DOLLHOUSE_AUTH_ENABLED: "true"
      DOLLHOUSE_AUTH_PROVIDER: embedded
      DOLLHOUSE_AUTH_METHODS: github
      DOLLHOUSE_AUTH_STORAGE_BACKEND: postgres
      DOLLHOUSE_AUTH_OPEN_DCR: "false"  # production: pre-register clients; do NOT leave open

      # Web console — bind to loopback only, never exposed via Caddy
      DOLLHOUSE_WEB_AUTH_ENABLED: "true"
    volumes:
      - ./portfolio:/home/node/.dollhouse
    # Internal port only — Caddy reaches it through the docker network.
    expose:
      - "3000"

  caddy:
    image: caddy:2
    restart: unless-stopped
    depends_on:
      - dollhousemcp
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  caddy_data:
  caddy_config:
```

Notes on this compose:

- **Postgres has no `ports:` mapping.** It is reachable from the `dollhousemcp` container over the default docker network but not from the host or the internet. Removing this is one of the easiest production mistakes — if you `ports: ["5432:5432"]` it, anyone who finds your host's IP can knock on the Postgres port.
- **dollhousemcp uses `expose:` not `ports:`.** Same reasoning — Caddy reaches it inside the docker network. Adding `ports:` lets clients bypass Caddy and TLS.
- **Image pinning.** Replace `:latest` with a digest (`@sha256:…`) for production. `latest` is a moving target — pinning is how you sleep at night.
- **`DOLLHOUSE_DATABASE_URL`** uses the `dollhouse_app` role (RLS-enforced), not `dollhouse` (superuser). The compose only creates the superuser. The first container start runs migrations as superuser (via `DOLLHOUSE_DATABASE_ADMIN_URL`), then `init-db.sql` creates the `dollhouse_app` role with `${POSTGRES_PASSWORD}`. See [A.7](#a7-bootstrap-the-database) for the bootstrap sequence.
- **`DOLLHOUSE_DATABASE_ADMIN_URL` must point at a role with `BYPASSRLS` (or a superuser).** The audit-event, rate-limit, and audit-HMAC tables are configured with `FORCE ROW LEVEL SECURITY` and no permissive policy — they deny all reads/writes to non-bypass roles by design. System-context paths (`AuditHmacKeyResolver`, `PostgresRateLimitStore`, `DatabaseAuditSink`, the `dollhouse-audit` CLI) all route through this connection and will fail loudly if it's not privileged. The `dollhouse` superuser provisioned by `init-db.sql` satisfies this; a managed-host equivalent should use either a superuser or a role created with `WITH BYPASSRLS`.

### A.6 Register the GitHub OAuth app

1. Open [github.com/settings/developers](https://github.com/settings/developers) → **New OAuth App**.
2. Application name: whatever you want (e.g., `DollhouseMCP — your-domain`).
3. Homepage URL: `https://mcp.your-domain.com`.
4. Authorization callback URL: `https://mcp.your-domain.com/auth/social/github/callback`.
5. Note the **Client ID**. Click **Generate a new client secret** and note the **Client Secret**.
6. Append to `.env.production`:
   ```bash
   DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=<your client id>
   DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=<your client secret>
   ```

**The GitHub OAuth app callback URL is fixed once.** Unlike the cloudflared quick-tunnel PoC, you set this once and never touch it.

### A.7 Bootstrap the database

The Postgres container runs any `.sql` file mounted at `/docker-entrypoint-initdb.d/` on first boot, before accepting connections. We use this to create the `dollhouse_app` role with the password from your env file. Migrations come next, applied by the dollhousemcp container.

```bash
# 1. Generate the init script with the password substituted in.
#    (Unquoted heredoc allows shell expansion of $POSTGRES_PASSWORD.)
set -a; source .env.production; set +a
cat > init-db.sql <<EOF
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dollhouse_app') THEN
    CREATE ROLE dollhouse_app WITH LOGIN PASSWORD '${POSTGRES_PASSWORD}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
\$\$;
GRANT CONNECT ON DATABASE dollhousemcp TO dollhouse_app;
GRANT USAGE ON SCHEMA public TO dollhouse_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dollhouse_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO dollhouse_app;
EOF
chmod 0600 init-db.sql

# (The compose.yml in A.5 already mounts this file into the postgres
# container at /docker-entrypoint-initdb.d/00-create-roles.sql.)

# 2. Start Postgres — it runs init-db.sql exactly once, on first boot.
docker compose up -d postgres
until docker compose exec -T postgres pg_isready -U dollhouse -d dollhousemcp; do
  sleep 2
done

# 3. Run migrations as admin — creates tables, RLS policies, sequences;
#    also re-applies grants so the app role can use newly-created tables.
docker compose run --rm dollhousemcp npm run db:migrate

# 4. Verify
docker compose exec -T postgres psql -U dollhouse -d dollhousemcp -c '\dt'
# Should list: users, elements, sessions, memory_entries, agent_states,
#              auth_accounts, auth_kv, auth_signing_keys, ...
```

If you need to re-bootstrap (e.g., after `docker compose down -v` wiped pgdata), the init script runs again on the next first-boot. The role is gated by `IF NOT EXISTS` semantics — re-runs are safe.

### A.8 Pre-claim the admin identity

Before the AS will serve auth flows, claim your GitHub username as admin:

```bash
docker compose run --rm dollhousemcp \
  npx dollhouse-admin-bootstrap --method github --github-username YOUR-GITHUB-USERNAME
```

If you have a stale `GITHUB_TOKEN` in the host environment that fails the lookup, look up your numeric GitHub ID (`curl https://api.github.com/users/YOUR-USERNAME | jq .id`) and use `--github-id` instead.

For co-admins (e.g., the friend hosting the box), repeat for each. Bootstrap is one-shot per identity.

### A.9 `Caddyfile`

```caddy
mcp.your-domain.com {
    encode gzip

    reverse_proxy dollhousemcp:3000 {
        header_up Host {host}
        header_up X-Forwarded-Proto https
        # Streamable HTTP connections idle longer than Caddy's 30s default.
        # 1h is generous; tune downward only if you've measured client
        # behavior. Below ~5 min, Gemini CLI sees "MCP ERROR" pop-ups.
        transport http {
            read_timeout 1h
            write_timeout 1h
            dial_timeout 30s
        }
    }
}
```

Caddy auto-acquires a Let's Encrypt cert on first run. Cert renewal is automatic. **Port 80 must be reachable from the public internet** — that's the HTTP-01 ACME challenge. If your firewall blocks 80, switch to DNS-01 challenge (requires API token from your DNS provider; see Caddy docs).

### A.10 First start

```bash
docker compose up -d
docker compose logs -f dollhousemcp
```

In the logs you should see:

```
[AuthProviderFactory] Resolved auth configuration { provider: 'embedded', methods: ['github'], ... }
[EmbeddedAuthorizationServer] initialized { issuer: 'https://mcp.your-domain.com', kid: 'dh-...' }
[StreamableHttpServer] listening on 0.0.0.0:3000
```

Caddy logs:

```
[INFO] http: certificate obtained successfully {"identifier": "mcp.your-domain.com"}
```

### A.11 Smoke verify

Without a token (public endpoints):

```bash
curl https://mcp.your-domain.com/healthz
# {"ok":true,"transport":"streamable-http", ...}

curl https://mcp.your-domain.com/readyz
# 200 once bootstrap completed; 503 with reason: "bootstrap_required" if you forgot A.8

curl https://mcp.your-domain.com/.well-known/oauth-authorization-server | jq
# Should show issuer = "https://mcp.your-domain.com" and the AS endpoints
```

With a token (any authenticated user):

1. Open `https://mcp.your-domain.com` in a browser. The web console redirects you through GitHub OAuth.
2. Approve the consent prompt. You should land back in the console as `roles: ['admin']`.
3. Run `curl -H "Authorization: Bearer $(your-token)" https://mcp.your-domain.com/auth/admin/me` to verify the admin role.

For MCP client setup (Claude Code, Claude Desktop, Gemini CLI, etc.), see [Auth Server Setup → Connecting an MCP client](./auth-server-setup.md#connecting-an-mcp-client). Your hostname is `mcp.your-domain.com`; the rest of the per-client setup is identical.

---

## Path B — Bare binary on a host with systemd

Use this when you already operate Node services and prefer host-level supervision. Same security posture, same env vars; only the supervision layer changes.

### B.1 Host prep

```bash
# Node 22+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs

# Dedicated user
sudo adduser --system --group --home /opt/dollhousemcp dollhouse

# Directories
sudo mkdir -p /opt/dollhousemcp /var/log/dollhousemcp /var/lib/dollhousemcp /etc/dollhousemcp
sudo chown -R dollhouse:dollhouse /opt/dollhousemcp /var/log/dollhousemcp /var/lib/dollhousemcp
sudo chown dollhouse:dollhouse /etc/dollhousemcp
sudo chmod 0750 /etc/dollhousemcp
```

### B.2 Install the server

```bash
sudo -u dollhouse bash <<'EOF'
cd /opt/dollhousemcp
git clone https://github.com/DollhouseMCP/mcp-server.git server
cd server
npm ci --omit=dev
npm run build
EOF
```

For updates: `git pull && npm ci --omit=dev && npm run build && sudo systemctl restart dollhousemcp`.

### B.3 Environment file

`/etc/dollhousemcp/dollhousemcp.env` (mode 0640, owner root, group dollhouse):

```env
# Transport
DOLLHOUSE_TRANSPORT=streamable-http
DOLLHOUSE_HTTP_HOST=127.0.0.1
DOLLHOUSE_HTTP_PORT=3000
DOLLHOUSE_HTTP_ALLOWED_HOSTS=mcp.your-domain.com
DOLLHOUSE_TRUSTED_PROXIES=loopback

# Public URL
DOLLHOUSE_PUBLIC_BASE_URL=https://mcp.your-domain.com

# Storage
DOLLHOUSE_STORAGE_BACKEND=database
DOLLHOUSE_DATABASE_URL=postgres://dollhouse_app:<password>@<db-host>:5432/dollhousemcp
DOLLHOUSE_DATABASE_ADMIN_URL=postgres://dollhouse:<admin-password>@<db-host>:5432/dollhousemcp
DOLLHOUSE_DATABASE_SSL=require  # managed Postgres or remote — use require
DOLLHOUSE_DATABASE_POOL_SIZE=20

# Embedded AS
DOLLHOUSE_AUTH_ENABLED=true
DOLLHOUSE_AUTH_PROVIDER=embedded
DOLLHOUSE_AUTH_METHODS=github
DOLLHOUSE_AUTH_STORAGE_BACKEND=postgres
DOLLHOUSE_AUTH_OPEN_DCR=false
DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=<from github>
DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=<from github>

# Signing secrets — generate once, never rotate without planning the impact
DOLLHOUSE_COOKIE_SIGNING_SECRET=<openssl rand -hex 32>
DOLLHOUSE_INVITE_TOKEN_SECRET=<openssl rand -hex 32>

# Web console
DOLLHOUSE_WEB_AUTH_ENABLED=true

# Path overrides (write outside the user's home for systemd ProtectHome=yes)
DOLLHOUSE_PORTFOLIO_DIR=/var/lib/dollhousemcp/portfolio
DOLLHOUSE_STATE_DIR=/var/lib/dollhousemcp/state
DOLLHOUSE_RUN_DIR=/var/lib/dollhousemcp/run
DOLLHOUSE_LOG_DIR=/var/log/dollhousemcp
DOLLHOUSE_CONFIG_DIR=/var/lib/dollhousemcp/config
DOLLHOUSE_CACHE_DIR=/var/lib/dollhousemcp/cache
```

### B.4 systemd unit

`/etc/systemd/system/dollhousemcp.service`:

```ini
[Unit]
Description=DollhouseMCP HTTP server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dollhouse
Group=dollhouse
WorkingDirectory=/opt/dollhousemcp/server
EnvironmentFile=/etc/dollhousemcp/dollhousemcp.env
ExecStart=/usr/bin/node /opt/dollhousemcp/server/dist/index.js
Restart=on-failure
RestartSec=5s
StandardOutput=append:/var/log/dollhousemcp/server.log
StandardError=append:/var/log/dollhousemcp/server.err

# Hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/log/dollhousemcp /var/lib/dollhousemcp
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes

# Resource limits
MemoryMax=2G
CPUQuota=200%

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dollhousemcp
sudo systemctl status dollhousemcp
```

### B.5 Reverse proxy (Caddy or nginx)

Same as Path A but the upstream is `127.0.0.1:3000` instead of `dollhousemcp:3000`:

**Caddy** (`/etc/caddy/Caddyfile`):

```caddy
mcp.your-domain.com {
    reverse_proxy 127.0.0.1:3000 {
        header_up Host {host}
        header_up X-Forwarded-Proto https
        transport http {
            read_timeout 1h
            write_timeout 1h
            dial_timeout 30s
        }
    }
}
```

**nginx** (`/etc/nginx/sites-available/mcp`):

```nginx
server {
  listen 443 ssl http2;
  server_name mcp.your-domain.com;

  ssl_certificate     /etc/letsencrypt/live/mcp.your-domain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/mcp.your-domain.com/privkey.pem;

  proxy_buffering off;
  proxy_read_timeout 1h;
  proxy_send_timeout 1h;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
server {
  listen 80;
  server_name mcp.your-domain.com;
  return 301 https://$host$request_uri;
}
```

For nginx + certbot: `sudo certbot --nginx -d mcp.your-domain.com` issues + auto-installs the cert and configures the redirect.

### B.6 Log rotation

`/etc/logrotate.d/dollhousemcp`:

```
/var/log/dollhousemcp/*.log /var/log/dollhousemcp/*.err {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0640 dollhouse dollhouse
    sharedscripts
    postrotate
        systemctl reload dollhousemcp > /dev/null 2>&1 || true
    endscript
}
```

The server itself rotates `~/.dollhouse/logs/*.log` files by date — this logrotate handles the systemd-captured stdout/stderr.

### B.7 Bootstrap (admin pre-claim)

Same CLI as Path A, run as the dollhouse user with the production env file sourced:

```bash
sudo -u dollhouse bash <<'EOF'
set -a
. /etc/dollhousemcp/dollhousemcp.env
set +a
cd /opt/dollhousemcp/server
npx dollhouse-admin-bootstrap --method github --github-username YOUR-USERNAME
EOF
```

`set -a` flags every subsequent assignment for export, then `.` sources the env file in-place. `set +a` unflags. Without this the bootstrap CLI can't reach `DOLLHOUSE_DATABASE_URL`, `DOLLHOUSE_AUTH_*`, etc.

For co-admins, re-run with each GitHub username. Bootstrap is one-shot per identity.

### B.8 Smoke verify

Same curls as [A.11](#a11-smoke-verify). The hostname is the same; only the deployment shape differs.

---

## Managed Postgres notes

If you chose managed Postgres in [Pre-deploy decisions](#pre-deploy-decisions), the changes from the in-compose Postgres setup are:

- **No `postgres:` service in `compose.yml`.** Remove the entry. Remove `depends_on: postgres` from `dollhousemcp`. The data volume is the provider's problem.
- **`DOLLHOUSE_DATABASE_URL` points at the managed host.** Form: `postgres://dollhouse_app:<password>@your-db.host.example.com:5432/dollhousemcp?sslmode=require`.
- **`DOLLHOUSE_DATABASE_SSL=require`.** Mandatory for any non-localhost Postgres.
- **Bootstrap differs.** Use the provider's console to create the database, then connect from your operator machine to create the `dollhouse_app` role and run migrations:
  ```bash
  DOLLHOUSE_DATABASE_ADMIN_URL=postgres://your-admin-user:pass@your-db.host:5432/dollhousemcp?sslmode=require \
    npm run db:migrate
  ```
- **Connection pooling.** Set `DOLLHOUSE_DATABASE_POOL_SIZE` to a value that fits comfortably inside the managed instance's `max_connections`. Default 10–20 is reasonable; serverless providers (Neon) may have lower caps.

Provider notes:

| Provider | Notes |
|---|---|
| **Supabase** | Includes Postgres + connection pooler (pgbouncer). Use the direct connection string for migrations and the pooler string at runtime (`?pgbouncer=true&connection_limit=1`). |
| **Neon** | Serverless; cold-start adds ~1s on first connection. Connection-pool-friendly. Free tier suitable for a hobbyist deploy. |
| **AWS RDS / Cloud SQL / Azure Database** | Standard managed Postgres. Use SSL `require` or `verify-full`. Configure VPC peering or use Private IP from your host. |
| **Crunchy Bridge** | Postgres-experts vendor. Includes PITR backups by default. Quality-of-life small-team option. |
| **Self-hosted on a separate VM** | You own all of it — backups, replication, version upgrades. Cheapest, most work. |

Backups: managed providers handle this automatically (verify the retention policy + test restore). For self-hosted Postgres or in-compose Postgres, see [Ongoing operations → Backups](#ongoing-operations).

---

## Audit log redaction

CLI approval audit records store a redacted `toolInputDigest` and keyed `toolInputHash` by default. Raw tool parameters are not retained unless `DOLLHOUSE_AUDIT_RETAIN_RAW_INPUT=true` is set before the approval is written.

Set `DOLLHOUSE_AUDIT_HMAC_SECRET=$(openssl rand -hex 32)` in hosted deployments so audit hashes remain stable across restarts and replicas. If unset, DollhouseMCP auto-generates and persists a key in the `audit_hmac_keys` table or `~/.dollhouse/secrets/audit-hmac-key`.

Every stored hash is prefixed `keyId:hex`, where `keyId` is the `kid` of the `audit_hmac_keys` row that produced it (or `env` / `file` for those sources). **Never delete rows from `audit_hmac_keys`.** Rotated rows (`active = false`) are still needed to verify hashes on historical audit records — the operational cost is one indefinitely-retained 32-byte secret per rotation. Backups must cover this table for the same reason.

**Rotation requires a process restart.** The audit HMAC resolver caches the resolved key material for the process lifetime, so rotating `DOLLHOUSE_AUDIT_HMAC_SECRET` or marking a new `audit_hmac_keys` row active does not take effect until the server is restarted. On startup the server logs `[Audit] Using audit HMAC key (source=db|file|env, kid=…)` once — use that line to confirm which key the running process is holding.

Raw detail retrieval is CLI-only for this PR:

```bash
dollhouse-audit find <sessionId>
dollhouse-audit show <sessionId> <approvalId>
```

`show` writes a durable `audit.raw_input_accessed` event before returning detail and a paired `audit.raw_input_access_result` event after — the second event's `metadata.found` field indicates whether data was actually returned. If raw retention was disabled for the requested record, the lookup returns `null` and `found` is `false`.

## Public endpoint allowlist

Both the MCP server (`:3000`) and the web management console (`:41715`) live in the same process. Only the MCP server should be reachable from the internet.

### Must be public

| Path | Purpose |
|---|---|
| `/mcp`, `/mcp/*` | MCP protocol endpoint |
| `/healthz`, `/readyz`, `/version` | Health probes for monitoring |
| `/.well-known/*` | OAuth/OIDC discovery |
| `/auth`, `/auth/*` | Authorization endpoint + GitHub callback |
| `/token` | OAuth token endpoint |
| `/jwks` | JWKS public keys |
| `/reg` | DCR endpoint (only matters if you ever flip `DOLLHOUSE_AUTH_OPEN_DCR=true`) |
| `/interaction/*` | Consent / login UI |
| `/me`, `/session/*` | OAuth session endpoints |

The Caddy/nginx examples above forward all `/`-prefixed paths to the server. That works because the server itself returns the web console SPA at `/` and the SPA's `/api/*` calls require either a JWT (`DOLLHOUSE_AUTH_ENABLED=true`) or the console Bearer token (`DOLLHOUSE_WEB_AUTH_ENABLED=true`). Make sure both are `true` in production.

### Must NOT be public

| What | Why | How to keep it private |
|---|---|---|
| Web console on port `41715` | Different security model (console Bearer token, not JWT). Binds to `127.0.0.1` by default. | Leave `DOLLHOUSE_WEB_CONSOLE_PORT` at default. Do not add a `ports:` mapping for it in compose. Do not proxy port 41715 in Caddy. |
| Postgres port `5432` | Database superuser access if reachable. | `expose:` only inside docker network. No `ports:`. For managed PG, use private networking / VPC peering / IP allowlists. |
| `/api/*` and `/pages/*` on the public MCP port | Web console SPA paths. Bearer-token-only by default; weak authorization model for public exposure. | Set `DOLLHOUSE_WEB_AUTH_ENABLED=true` so the JWT gate also covers these. Or strip them at the proxy (see [Two-port deployment](#two-port-deployment) below). |

### Two-port deployment

If you want to be maximally certain the web console SPA is never reachable from the public hostname (rather than relying on the in-server JWT gate), front MCP and the web console on different ports:

```yaml
# dollhousemcp service block additions
environment:
  DOLLHOUSE_HTTP_HOST: 0.0.0.0
  DOLLHOUSE_HTTP_PORT: 3000
  DOLLHOUSE_WEB_CONSOLE_PORT: 41715   # default
# expose 3000 publicly via Caddy
# DO NOT proxy 41715 publicly
```

Then in `Caddyfile`, restrict the public hostname to MCP and AS paths only:

```caddy
mcp.your-domain.com {
    @public {
        path /mcp /mcp/*
        path /healthz /readyz /version
        path /.well-known/*
        path /auth /auth/* /token /jwks /reg
        path /interaction/* /me /session /session/*
    }
    handle @public {
        reverse_proxy dollhousemcp:3000 {
            header_up Host {host}
            header_up X-Forwarded-Proto https
            transport http {
                read_timeout 1h
                write_timeout 1h
                dial_timeout 30s
            }
        }
    }
    handle {
        respond 404
    }
}
```

To reach the web console as an operator, SSH-tunnel:

```bash
ssh -L 41715:localhost:41715 your-host
# then open http://localhost:41715
```

This is the strongest containment: the web console is unreachable without SSH access to the host even if a future bug weakens its in-process auth.

---

## Ongoing operations

### Backups

For in-compose Postgres, the bare minimum is a daily `pg_dump`:

```bash
# /etc/cron.daily/dollhousemcp-backup
#!/bin/bash
set -euo pipefail
TS=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR=/var/backups/dollhousemcp
mkdir -p "$BACKUP_DIR"

docker compose -f /opt/dollhousemcp/compose.yml exec -T postgres \
  pg_dump -U dollhouse dollhousemcp \
  | gzip > "$BACKUP_DIR/dollhousemcp-$TS.sql.gz"

# Encrypt with age (install: apt install age)
age -r age1... < "$BACKUP_DIR/dollhousemcp-$TS.sql.gz" > "$BACKUP_DIR/dollhousemcp-$TS.sql.gz.age"
rm "$BACKUP_DIR/dollhousemcp-$TS.sql.gz"

# Keep 14 days locally
find "$BACKUP_DIR" -name '*.sql.gz.age' -mtime +14 -delete

# Ship off-host (S3, B2, rsync.net, etc.) — example with rclone:
rclone copy "$BACKUP_DIR/dollhousemcp-$TS.sql.gz.age" remote:dollhousemcp-backups/
```

Things to back up:

1. **Postgres** (above) — contains `auth_accounts`, `auth_kv`, `auth_signing_keys` (rotation key + cookie secret), `users`, `elements`, `memory_entries`, `agent_states`, etc.
2. **`.env.production`** — encrypted, stored separately from the data backup so a single compromise doesn't get both.
3. **Portfolio volume** — if you have `DOLLHOUSE_STORAGE_BACKEND=database` you can skip this (everything is in Postgres). The volume only holds caches and per-user filesystem fallback state.

**Test restore quarterly.** Untested backups aren't backups. Spin up a scratch host, restore the most recent dump, hit `/healthz` and `/readyz`, verify a sample user can sign in.

### Updates

**Container:**

```bash
cd /opt/dollhousemcp
# Pull the new image (replace the tag with a specific digest in production)
docker compose pull dollhousemcp
docker compose up -d dollhousemcp
docker compose logs -f dollhousemcp
```

**Bare binary:**

```bash
sudo -u dollhouse bash <<'EOF'
cd /opt/dollhousemcp/server
git pull
npm ci --omit=dev
npm run build
EOF
sudo systemctl restart dollhousemcp
sudo journalctl -u dollhousemcp -f
```

Migrations run automatically on startup. Watch `/readyz` — it returns 503 with `reason: "migrations_pending"` during a migration window and 200 once everything is current.

### Monitoring

The minimum-viable monitoring stack:

- **Uptime probe** against `https://mcp.your-domain.com/healthz` every 60s from an external service (UptimeRobot, BetterStack, Healthchecks.io free tier). Alert on 5xx or timeout.
- **Cert renewal alert.** Caddy renews automatically but log a daily check (`docker compose logs caddy | grep -i certificate`).
- **Disk usage on the host.** Postgres growth + log retention can fill a disk fast. Alert at 80%.
- **`/readyz`** is a stricter probe than `/healthz` — it returns 503 during bootstrap, mid-migration, or if Postgres is unreachable. Use this as the readiness gate in any load balancer.

### Logs

Where logs land:

| Deployment | Server logs | systemd / docker logs |
|---|---|---|
| Container | Inside the container at `/home/node/.dollhouse/logs/*.log`; reach them via `docker compose logs dollhousemcp` or mount the directory out (volume `./logs:/home/node/.dollhouse/logs`) | `docker compose logs -f` |
| Bare binary | `/var/log/dollhousemcp/*.log` (from `DOLLHOUSE_LOG_DIR` override) | `/var/log/dollhousemcp/server.{log,err}` via systemd, also `journalctl -u dollhousemcp` |

For deeper debugging, see [Logging](./logging.md) — the in-memory buffer + `query_logs` MCP tool + browser viewer are unchanged in production. The "Operational logging in production" section there covers shipping logs off-host to Better Stack / Grafana Cloud / equivalents.

### Secret rotation

Rotate cookie signing secret, invite token secret, GitHub OAuth secret, and Postgres password at least annually OR after any suspected compromise. See [Secret Rotation Runbook](./secret-rotation-runbook.md) for the per-secret procedure, invalidation impact, and multi-replica coordination.

---

## Production checklist

Don't go live until all of these are true:

**Identity and access**
- [ ] `DOLLHOUSE_AUTH_ENABLED=true`
- [ ] `DOLLHOUSE_AUTH_PROVIDER=embedded`
- [ ] `DOLLHOUSE_AUTH_METHODS` does NOT include `trivial-consent`
- [ ] `DOLLHOUSE_AUTH_OPEN_DCR=false` (or absent — defaults to false)
- [ ] Admin identity pre-claimed via `dollhouse-admin-bootstrap`
- [ ] `/readyz` returns 200 (not 503 with `bootstrap_required`)
- [ ] `DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED=true` AND the allowlist is populated (or you've consciously chosen a different gate from [Patterns 2–4](#authenticated-user-allowlist)). If you're on Pattern 5 (no allowlist), document why.
- [ ] If using Pattern 1: at least one allowlist entry covering you (the operator) — check with `dollhouse-allowlist list`. The bootstrap admin pre-claim handles the lockout case, but explicit entries make the list self-documenting.

**Secrets**
- [ ] `DOLLHOUSE_COOKIE_SIGNING_SECRET` and `DOLLHOUSE_INVITE_TOKEN_SECRET` generated fresh, set via env, 64+ hex chars
- [ ] `DOLLHOUSE_AUTH_GITHUB_CLIENT_ID` and `DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET` registered with the correct production callback URL
- [ ] Postgres passwords generated fresh (not `dollhouse` / `dollhouse_app` — the server refuses to start in `NODE_ENV=production` with the dev passwords)
- [ ] `.env.production` mode 0600, owned by the operator user, NOT in git
- [ ] Secrets backed up encrypted, separately from the data backup

**Network**
- [ ] `DOLLHOUSE_HTTP_ALLOWED_HOSTS` set to your public hostname
- [ ] `DOLLHOUSE_PUBLIC_BASE_URL` set to `https://mcp.your-domain.com` (matches the issued JWT `iss` claim)
- [ ] `DOLLHOUSE_TRUSTED_PROXIES` set to the proxy CIDR (Docker bridge, `loopback`, or your VPC range) — not blank, not `loopback` if you bind to `0.0.0.0`
- [ ] Postgres NOT reachable from outside the docker network or VPC (no host `ports:` mapping)
- [ ] Web console (41715) NOT proxied to the public hostname
- [ ] Host firewall default-deny inbound except 22/80/443
- [ ] SSH key-only

**TLS**
- [ ] Caddy / nginx / Cloudflare has a valid cert for the public hostname
- [ ] Cert renewal automated and verified (Caddy: automatic; certbot: timer enabled; Cloudflare: edge-managed)
- [ ] `X-Forwarded-Proto https` set by the proxy (`Secure` cookie flag depends on it)

**Database**
- [ ] `DOLLHOUSE_STORAGE_BACKEND=database` and `DOLLHOUSE_AUTH_STORAGE_BACKEND=postgres`
- [ ] `DOLLHOUSE_DATABASE_SSL=require` (for managed or remote Postgres; `disable` is only OK on a private docker bridge)
- [ ] Two roles: `dollhouse` (superuser, ADMIN_URL only) and `dollhouse_app` (NOBYPASSRLS, runtime URL)
- [ ] Migrations have run (`docker compose run --rm dollhousemcp npm run db:migrate`)
- [ ] Daily `pg_dump` configured + at least one tested restore

**Operations**
- [ ] Uptime monitor probing `/healthz` from an external service
- [ ] Disk-usage alert configured on the host (Postgres growth)
- [ ] Update procedure documented somewhere your team can find (this runbook qualifies)
- [ ] Secret rotation cadence on the calendar (annual baseline)

If any item is unchecked, don't expose the hostname yet. Park the deploy on a private subdomain, finish the checklist, then flip DNS.

---

## Cloudflare Tunnel ingress (appendix)

If you'd rather not open ports on the origin host, Cloudflare Tunnel publishes the server via an outbound-only connection to Cloudflare's edge. The deploy shape is the same as Path A but without Caddy and without inbound 80/443.

Conceptual differences from Path A:

| | Path A (Caddy + LE) | Cloudflare Tunnel |
|---|---|---|
| Origin needs inbound ports? | Yes (80, 443) | No (only outbound to CF) |
| TLS termination | Caddy on the origin | Cloudflare edge |
| DNS record | A record → origin IP | CNAME → Cloudflare tunnel hostname |
| Cert renewal | Caddy automatic via LE | Cloudflare auto-managed (Universal SSL) |
| Rate limiting | Caddy or upstream | Cloudflare WAF + rate-limit rules (free tier) |
| DDoS protection | Whatever your host has | Cloudflare edge |
| Cost | Free | Free |

### Setup (named tunnel)

```bash
# On the origin host
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb

# One-time auth — opens a browser, authenticates to your CF account
cloudflared tunnel login

# Create a named tunnel
cloudflared tunnel create dollhousemcp-prod
# Note the tunnel UUID printed

# Route DNS — creates the CNAME in your CF zone
cloudflared tunnel route dns dollhousemcp-prod mcp.your-domain.com

# Config — /etc/cloudflared/config.yml
sudo tee /etc/cloudflared/config.yml <<EOF
tunnel: dollhousemcp-prod
credentials-file: /home/dollhouse/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: mcp.your-domain.com
    service: http://localhost:3000
  - service: http_status:404
EOF

# Install + start as a service
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

### Compose changes from Path A

Drop the `caddy:` service. Have `dollhousemcp` bind to `127.0.0.1:3000` on the host:

```yaml
dollhousemcp:
  # ...
  ports:
    - "127.0.0.1:3000:3000"   # cloudflared on the host reaches it via 127.0.0.1
```

Or run cloudflared in compose as a sidecar — see Cloudflare's compose examples.

### Cloudflare Tunnel + bare binary

For Path B, leave the systemd unit as-is (binds to 127.0.0.1:3000). Drop the reverse-proxy step entirely; cloudflared takes its place.

### What you lose vs Path A

- **Origin IP visible to your friend who hosts.** Tunnel is outbound; Cloudflare doesn't see the origin IP, but the friend running the box obviously does. Not a meaningful change.
- **No origin-side rate limiting on internal services.** All rate limiting is at Cloudflare's edge — fine for the public hostname, but if your /healthz probe runs on the same host you'll need a separate path for it.
- **Cloudflare is in the request path.** If CF has an outage, your deploy is unreachable. Path A with a generic VPS has no such dependency.

### What you gain

- **No inbound ports, ever.** Origin firewall is default-deny inbound, period. No 80/443 reasoning needed.
- **CF edge controls.** Free-tier WAF, Bot Fight Mode, rate limiting, country blocking are useful even for a tiny deploy.
- **No cert management on the origin.** Universal SSL is free, auto-renews, never breaks.

For Cloudflare-specific tuning beyond the basic tunnel setup (WAF rules, rate limiting at the edge, Bot Fight Mode, country blocking), refer to Cloudflare's own documentation. The Tunnel + Caddy/nginx + Postgres deployment shapes described in this runbook all benefit equally from Cloudflare's free-tier edge controls if you choose to put them in front.

---

## Troubleshooting

### Caddy fails to obtain a Let's Encrypt cert

- **Port 80 not reachable from the public internet.** ACME HTTP-01 challenge fails. Either open 80 inbound or switch to DNS-01 (requires API token from your DNS provider; see Caddy docs).
- **DNS not propagated.** `dig +short mcp.your-domain.com` from a third-party host (Google DNS, 1.1.1.1) — if it doesn't match your host's IP, wait. Propagation can take up to 48h for new domains but is usually minutes.
- **LE rate limit.** Five failed attempts per hostname per hour. Stop, fix, wait an hour, retry. The error message tells you when you can retry.

### `/healthz` returns 200 but `/mcp` returns 502 from the proxy

The proxy can reach the server but the server is unhealthy. Check:

- `docker compose logs dollhousemcp` for startup errors
- `/readyz` (not `/healthz`) — returns 503 with a `reason` field that tells you what's wrong (`bootstrap_required`, `migrations_pending`, `database_unreachable`, etc.)

### "iss claim mismatch" when validating JWTs

The server's `DOLLHOUSE_PUBLIC_BASE_URL` doesn't match what the client validated against. Causes:

- Set to `http://` when the public URL is `https://`
- Set to a different hostname than the one the client connected to
- Caddy/nginx isn't forwarding the `Host` header (the AS computes `iss` from `req.host`, but only when `DOLLHOUSE_PUBLIC_BASE_URL` is unset; the env-var-set form wins)

Fix: set `DOLLHOUSE_PUBLIC_BASE_URL` to exactly your public URL, restart the server, re-authenticate (old JWTs were issued with the old `iss` and will fail validation).

### Postgres connection refused on first start

`depends_on: postgres: condition: service_healthy` should handle this, but if you removed that block (e.g., to point at managed Postgres) the server can race ahead of the DB being ready. Either:

- Add `depends_on` back if Postgres is in the same compose
- Add a retry wrapper around the server's startup (the server itself does some retry, but caps quickly)
- For managed Postgres, just retry the compose up after a few seconds — the connect pool establishes eventually

### Sign-in flow returns 400 "redirect_uri mismatch"

The GitHub OAuth app's callback URL doesn't match what the AS sent. Verify in the GitHub app config:

- Exactly `https://mcp.your-domain.com/auth/social/github/callback`
- No trailing slash difference
- `https` not `http`
- Hostname matches `DOLLHOUSE_PUBLIC_BASE_URL`

### "DOLLHOUSE_TRUSTED_PROXIES required" startup error

You bound to `0.0.0.0` (any container or non-loopback host) with a multi-user auth method configured, but didn't set `DOLLHOUSE_TRUSTED_PROXIES`. Either:

- Set it to the proxy's CIDR (Docker default bridge is `172.16.0.0/12`, or check `docker network inspect bridge`)
- Set it to `loopback` (only correct if no proxy is in front — i.e., native HTTPS or development-only)
- Set it to a single IP (the loopback `127.0.0.1` is fine if Caddy and the server are on the same host)

Misconfiguring this collapses per-IP rate limiting to the proxy's egress IP, which is why the server refuses to start with the wrong combination.

### Container restart loses user sessions

In `DOLLHOUSE_STORAGE_BACKEND=database` mode, restarts preserve sessions because JWKS keys, cookie secrets, and grants all live in Postgres. If you're seeing all users re-auth on restart, you accidentally have `DOLLHOUSE_AUTH_STORAGE_BACKEND=filesystem` with the auth keyfiles on `tmpfs`. Switch to `postgres` (matching the storage backend).

### Updates introduce migrations that take too long

Run migrations during a low-traffic window. `/readyz` returns 503 with `migrations_pending` during the window, so any load balancer correctly skips the instance. If migration time is consistently a problem, pre-stage the migration:

```bash
# Run migrations against a separate temporary container, then restart the main one
docker compose run --rm dollhousemcp npm run db:migrate
docker compose restart dollhousemcp
```

---

## Related

- [Auth Server Setup](./auth-server-setup.md) — the four setup paths and the auth model in depth
- [Deployment Configuration](./deployment-configuration.md) — full env-var reference
- [Secret Rotation Runbook](./secret-rotation-runbook.md) — per-secret rotation procedures
- [Logging](./logging.md) — log queries, redaction, and the operational-logging section
- [Console Authentication](./console-auth.md) — web console token, TOTP, rotation
