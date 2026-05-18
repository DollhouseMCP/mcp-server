# Auth Server Setup

This guide is the end-to-end operator runbook for the DollhouseMCP authentication system: an embedded OAuth 2.1 / OIDC authorization server that runs inside your DollhouseMCP HTTP transport. MCP clients authenticate to your server via a real OAuth flow; your server issues JWTs that the MCP endpoint validates.

> **Scope.** This guide covers user authentication TO your DollhouseMCP server. For the separate "DollhouseMCP authenticates to GitHub on your behalf" feature (portfolio sync, the `setup_github_auth` tool, device flow), see [oauth-setup.md](./oauth-setup.md). The two features are independent; you can run both, neither, or just one.
>
> **Transport.** The embedded auth server only applies to the HTTP transport (`npm run start:http`). The stdio transport is unauthenticated by definition — the parent process owns the connection.

## Table of contents

- [What the embedded auth server is](#what-the-embedded-auth-server-is)
- [Decision tree](#decision-tree)
- [Path A — Solo localhost smoke test (zero config)](#path-a--solo-localhost-smoke-test-zero-config)
- [Path B — Local-password on filesystem (single-user real flow)](#path-b--local-password-on-filesystem-single-user-real-flow)
- [Path C — GitHub OAuth on filesystem (small team)](#path-c--github-oauth-on-filesystem-small-team)
- [Path D — Postgres-backed (production-shape)](#path-d--postgres-backed-production-shape)
- [Storage backend: filesystem vs Postgres](#storage-backend-filesystem-vs-postgres)
- [Auth methods: choosing one](#auth-methods-choosing-one)
- [Exposing the server safely](#exposing-the-server-safely)
- [HTTPS: native vs reverse proxy vs tunnel](#https-native-vs-reverse-proxy-vs-tunnel)
- [Security checklist](#security-checklist)
- [Verifying the install](#verifying-the-install)
- [Connecting an MCP client](#connecting-an-mcp-client)
- [Troubleshooting](#troubleshooting)
- [Reset / disaster recovery](#reset--disaster-recovery)
- [Reference](#reference)

---

## What the embedded auth server is

A normal OAuth/OIDC authorization server, hosted inside the DollhouseMCP process. Three parts:

1. **Authorization server** — exposes `/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/jwks`, `/interaction/:uid`, `/auth/admin/me`, plus method-specific routes (`/auth/email/verify`, `/auth/social/github/callback`, `/auth/local/invite`).
2. **Auth methods** — pluggable identity-verification flows: `trivial-consent`, `local-password`, `magic-link`, `github`. Selected by env. Multiple can run side by side.
3. **Storage layer** — abstracted via `IAuthStorageLayer` with three backends (`memory`, `filesystem`, `postgres`).

When an MCP client connects to your server's `/mcp` endpoint without a token, it gets a 401 with a `WWW-Authenticate` header pointing at the discovery document. The client follows the discovery, drives a PKCE auth-code flow, and ends up with an access token it sends as `Authorization: Bearer …` on subsequent requests.

You — the operator — control:
- which methods are active (env: `DOLLHOUSE_AUTH_METHODS`)
- which backend stores accounts/tokens (env: `DOLLHOUSE_AUTH_STORAGE_BACKEND`)
- how the server is exposed (loopback, tunnel, proxy, native HTTPS)
- which identity gets the admin role (one-time bootstrap CLI)

## Decision tree

```
What are you doing?
├─ Just smoke-testing that auth works → Path A (trivial-consent, ~30 seconds)
├─ Solo dev with a real account flow → Path B (local-password, filesystem)
├─ Small team (≤10) on a shared box → Path C (github, filesystem)
└─ Production-shape (hosted, durable, multi-method-ready) → Path D (Postgres)
```

All four paths build on the same core. Pick the one that matches your goal; you can promote (A→B→C→D) by changing env vars and re-bootstrapping. Operator setup time:

| Path | Operator time (first time) | End-user time per sign-in |
|---|---|---|
| A (trivial-consent) | ~30 sec | 1 click |
| B (local-password) | ~2 min + per-user invite-issue | enter password |
| C (github) | ~3 min (register OAuth app) | click "Sign in with GitHub" |
| D (Postgres + any method) | A/B/C time + `npm run db:setup` | same as A/B/C |

**One thing to think about before picking**: which MCP clients will connect to your server? Most clients work with any path. But **Gemini CLI and claude.ai web** auto-register via DCR and need `DOLLHOUSE_AUTH_OPEN_DCR=true` set on the server. **Claude Desktop and Claude Code** use the pre-registered client_id and work everywhere. See [MCP client compatibility](#mcp-client-compatibility) for the full matrix.

---

## Path A — Solo localhost smoke test (zero config)

Fastest possible verification. No accounts, no bootstrap, no GitHub app. Server boots, every MCP connect prompts you with a single "Approve Connector" page, and you're in.

```bash
cd /mnt/devstuff/Development/Projects/dollhouse/mcp-server
npm install
npm run build

DOLLHOUSE_AUTH_ENABLED=true \
DOLLHOUSE_AUTH_PROVIDER=embedded \
DOLLHOUSE_AUTH_METHODS=trivial-consent \
DOLLHOUSE_HTTP_HOST=127.0.0.1 \
DOLLHOUSE_HTTP_PORT=3000 \
DOLLHOUSE_AUTH_OPEN_DCR=true \
npm run start:http
```

Point your MCP client at `http://127.0.0.1:3000/mcp`. The client triggers OAuth, you click Approve, you have a token.

**About `DOLLHOUSE_AUTH_OPEN_DCR=true`** — required if your MCP client auto-registers via DCR (Gemini CLI, claude.ai web). Safe on loopback. Claude Desktop / Claude Code use a pre-registered client_id and don't need it. See [MCP client compatibility](#mcp-client-compatibility).

**Limits.** trivial-consent refuses to start on a non-loopback bind. It is for solo localhost only.

---

## Path B — Local-password on filesystem (single-user real flow)

Username + argon2 password. Persisted to `~/.dollhouse/auth/`. Survives restarts. First user issued via the CLI is auto-claimed as admin.

```bash
# One-time setup
cd /mnt/devstuff/Development/Projects/dollhouse/mcp-server
npm install && npm run build

# Pin signing secrets so they survive restarts. Do this once and persist them.
export DOLLHOUSE_COOKIE_SIGNING_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
export DOLLHOUSE_INVITE_TOKEN_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
# (Save those two values somewhere safe — your shell rc, a .env file, a secret store.)

# Auth + storage env
export DOLLHOUSE_AUTH_ENABLED=true
export DOLLHOUSE_AUTH_PROVIDER=embedded
export DOLLHOUSE_AUTH_METHODS=local-password
export DOLLHOUSE_AUTH_STORAGE_BACKEND=filesystem
export DOLLHOUSE_HTTP_HOST=127.0.0.1
export DOLLHOUSE_HTTP_PORT=3000

# 1. Issue the first invite (auto-claims admin)
npx dollhouse-create-user --username todd --email todd@example.com
# → prints: http://127.0.0.1:3000/auth/local/invite?invite=<token>

# 2. Start the server
npm run start:http

# 3. Open the invite URL in a browser, set a password (≥12 chars).
# 4. Connect your MCP client. Token issued via the OAuth flow carries roles:['admin'].
```

To add more users later: run `npx dollhouse-create-user --username <name> --email <email>` with the server running. Subsequent users are regular accounts.

---

## Path C — GitHub OAuth on filesystem (small team)

Users sign in with their GitHub identity. Filesystem storage. Operator pre-claims one GitHub user as admin.

```bash
# 1. Register a GitHub OAuth app at https://github.com/settings/developers
#    Application name:      <whatever>
#    Homepage URL:          http://127.0.0.1:3000
#    Callback URL:          http://127.0.0.1:3000/auth/social/github/callback
#    Note the Client ID and Client Secret.

# 2. Env
export DOLLHOUSE_AUTH_ENABLED=true
export DOLLHOUSE_AUTH_PROVIDER=embedded
export DOLLHOUSE_AUTH_METHODS=github
export DOLLHOUSE_AUTH_STORAGE_BACKEND=filesystem
export DOLLHOUSE_HTTP_HOST=127.0.0.1
export DOLLHOUSE_HTTP_PORT=3000

# User-auth credentials (separate from the legacy portfolio-sync vars)
export DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=<from GitHub>
export DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=<from GitHub>

# Pin signing secrets
export DOLLHOUSE_COOKIE_SIGNING_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
export DOLLHOUSE_INVITE_TOKEN_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# 3. Pre-claim yourself as admin
#    OPTION A — by username (CLI looks up your numeric ID via GitHub's public API):
npx dollhouse-admin-bootstrap --method github --github-username <your-username>
#
#    OPTION B — by numeric ID directly. USE THIS IF you have a stale GITHUB_TOKEN
#    in your environment (the CLI uses it for higher rate limits but gets 401
#    if it's invalid). Find your ID via:
#      curl https://api.github.com/users/<your-username> | jq .id
#    Then:
npx dollhouse-admin-bootstrap --method github --github-id <numeric-id>

# 4. (Optional) If your MCP client auto-registers via DCR (Gemini CLI, claude.ai web)
#    enable the open-DCR escape hatch — loopback-only, see MCP client compatibility.
export DOLLHOUSE_AUTH_OPEN_DCR=true

# 5. Start
npm run start:http

# 5. MCP client → /authorize → bounced to GitHub → consent → token with roles:['admin'].
```

**About the env-var pair.** `DOLLHOUSE_AUTH_GITHUB_CLIENT_ID` / `_CLIENT_SECRET` are the canonical names for the user-auth flow. The legacy `DOLLHOUSE_GITHUB_CLIENT_ID` / `_CLIENT_SECRET` (used by portfolio sync) still works as a fallback with a deprecation warning, so existing deployments don't break. New deployments should use the `AUTH_` pair to keep the two features cleanly separated.

---

## Path D — Postgres-backed (production-shape)

Same flows as A/B/C but state lives in Postgres. Multiple AS replicas can share the database. This is the path you'll use for any deployment where filesystem storage is not enough.

### Prereqs

- Docker (the setup script uses `docker compose` to bring up Postgres locally; if you have Postgres elsewhere, point `DOLLHOUSE_DATABASE_URL` at it instead)
- Node 22+ for the dev environment

### One-time database setup

```bash
cd /mnt/devstuff/Development/Projects/dollhouse/mcp-server
npm install && npm run build
npm run db:setup
```

`db:setup`:
- starts `dollhousemcp-postgres` via `docker/docker-compose.db.yml`
- creates two roles: `dollhouse` (admin/superuser, used for migrations) and `dollhouse_app` (NOBYPASSRLS, used at runtime)
- runs all migrations including the auth tables (`auth_kv`, `auth_accounts`, `auth_audit_events`)
- applies post-migration permissions (RLS, grants on auth tables)

Verify:
```bash
docker exec -it dollhousemcp-postgres psql -U dollhouse -d dollhousemcp -c '\dt auth_*'
# Should list: auth_accounts, auth_audit_events, auth_kv
```

### Env

```bash
# Storage
export DOLLHOUSE_STORAGE_BACKEND=database
export DOLLHOUSE_DATABASE_URL='postgres://dollhouse_app:dollhouse_app@localhost:5432/dollhousemcp'
export DOLLHOUSE_DATABASE_ADMIN_URL='postgres://dollhouse:dollhouse@localhost:5432/dollhousemcp'
export DOLLHOUSE_DATABASE_POOL_SIZE=10
export DOLLHOUSE_DATABASE_SSL=disable          # local Docker; use 'require' for production

# Auth tables in the same Postgres
export DOLLHOUSE_AUTH_ENABLED=true
export DOLLHOUSE_AUTH_PROVIDER=embedded
export DOLLHOUSE_AUTH_STORAGE_BACKEND=postgres
export DOLLHOUSE_AUTH_METHODS=local-password    # or github / magic-link / a comma-separated combo

# Pin signing secrets — REQUIRED for multi-replica HA
export DOLLHOUSE_COOKIE_SIGNING_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
export DOLLHOUSE_INVITE_TOKEN_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# HTTP transport
export DOLLHOUSE_HTTP_HOST=127.0.0.1
export DOLLHOUSE_HTTP_PORT=3000
export DOLLHOUSE_TRUSTED_PROXIES=loopback        # see "Exposing the server" below
```

For GitHub-method deployments, also set:
```bash
export DOLLHOUSE_AUTH_GITHUB_CLIENT_ID=<from GitHub>
export DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET=<from GitHub>
```

For magic-link, also set the SMTP env vars (`DOLLHOUSE_SMTP_HOST/USER/PASSWORD/FROM/PORT`).

### Bootstrap

The CLIs use `DOLLHOUSE_DATABASE_URL` automatically. Run BEFORE first start (or while `/readyz` is sitting at 503):

```bash
# local-password
npx dollhouse-create-user --username todd --email todd@example.com

# github
npx dollhouse-admin-bootstrap --method github --github-username <your-username>

# magic-link
npx dollhouse-admin-bootstrap --method magic-link --email <admin@example.com>
```

The CLI inserts a row in `auth_kv` with `model='BootstrapState'` claiming you as admin. `/readyz` returns 503 with `{reason: 'bootstrap_required'}` until that row exists.

### Start

```bash
npm run start:http
```

You should see in stderr:
```
[AuthProviderFactory] Resolved auth configuration { provider: 'embedded', methods: ['local-password'], ... }
[EmbeddedAuthorizationServer] initialized { issuer: 'http://127.0.0.1:3000', kid: 'dh-…' }
[StreamableHttpServer] listening on 127.0.0.1:3000
```

### What lives in Postgres in DB mode

When `DOLLHOUSE_STORAGE_BACKEND=database` is set, **all persistent server state lives in Postgres**. There is no fallback to filesystem for any persistent item — the deployment is honest about being all-DB.

| State | Table |
|---|---|
| Element content (personas, skills, memories, agents, templates, ensembles) | `elements`, `memory_entries`, etc. |
| Operator-level config (console port, enhanced-index limits, license attestation) | `operator_settings` (single row) |
| Per-user config (sync prefs, GitHub PAT, autoload list, retention policy, wizard state, display prefs) | `user_settings` (one row per user, RLS-enforced) |
| Collection index cache (public catalog) | `shared_cache` (TTL-aware) |
| OAuth state (sessions, grants, refresh tokens, codes) | `auth_kv` (model-discriminated K/V) |
| User accounts + identity | `auth_accounts`, `users` |
| Audit log | `auth_identity_events` (append-only) |
| JWKS signing key + cookie-signing secret | `auth_signing_keys` (rotation invariant: at most one active per kind) |
| Agent runtime state (goals, decisions, context) | `agent_states` (RLS-enforced; uniquely keyed by `(agent_id, session_id)`, with `user_id` FK for ownership) |

**Agent runtime state is session-scoped in DB mode.** Concurrent MCP sessions for the same user and the same agent get independent goal/decision/context streams — switching tabs or opening a second client doesn't merge agent execution histories. `session_id` is part of the unique index, so sessions are isolated even within a single user account.

**Container restart durability:** The `auth_signing_keys` table is the reason a containerized hosted deployment survives `docker compose restart` without invalidating user sessions. Filesystem-mode keyfiles in a `tmpfs` mount regenerate on every restart, which changes the JWKS `kid`, which trips mode-fingerprint detection, which wipes all `auth_kv` state — every user has to re-OAuth. DB-mode keys persist across restarts so the mode-fingerprint stays stable and tokens remain valid.

### Filesystem-to-Postgres config migration

When you switch an existing filesystem deployment to DB mode (e.g. `DOLLHOUSE_STORAGE_BACKEND=file` → `database`), the server auto-migrates `~/.dollhouse/config.yml` plus the JWKS keyfile and cookie-signing secret into the new tables on first startup. The operation is idempotent — rerunning is a no-op once the marker `~/.dollhouse/.migrated-to-db` is written. The original files are NOT deleted, so a roll-back is reversible.

To inspect / dry-run / re-run the migration manually:

```bash
# Status: is the marker present?
npx tsx scripts/migrate-config-to-database.ts status

# Preview: parse the legacy state and print what would be migrated, no writes
npx tsx scripts/migrate-config-to-database.ts preview

# Execute: actually migrate. Idempotent.
npx tsx scripts/migrate-config-to-database.ts execute
```

The JWKS keyfile is migrated with its **original `kid`** preserved, so any tokens issued before the migration remain valid. The cookie secret is migrated as the original byte sequence under a fresh opaque kid.

User accounts created in filesystem auth-storage mode do NOT follow over — those are scoped to the auth backend (`DOLLHOUSE_AUTH_STORAGE_BACKEND`) and re-creating them is one CLI invocation per user.

---

## Storage backend: filesystem vs Postgres

| | Filesystem | Postgres |
|---|---|---|
| When to use | Solo dev, single replica, ≤500 accounts | Multi-replica HA, hosted, GDPR / audit / compliance, scale |
| Setup | `npm run build` + start | `npm run db:setup` once, then start |
| State location | `~/.dollhouse/auth/` (or `DOLLHOUSE_RUN_DIR` / platform-equivalent) | `auth_*` tables in Postgres |
| Durability | OS file durability + manual backups | Postgres replication, point-in-time recovery, `pg_dump` |
| Concurrent CLI safety | OS-level `O_EXCL` create on bootstrap.json | Atomic `INSERT ... ON CONFLICT` |
| Audit log | `audit.jsonl`, rotates to `.1` at 50MB | `auth_identity_events` table (append-only) |
| TTL cleanup | Lazy on `genericGet` + `sweepExpiredKv` (call manually for now) | Lazy + `sweepExpiredKv` + future cron sweep |
| Account lookup performance | O(n) full-file read on `findAccount` | O(log n) via index on `sub` |
| Multi-replica | NOT supported (each replica's filesystem is separate) | Supported, but cookie + invite secrets MUST be set via env identically across replicas |
| Tooling | `cat ~/.dollhouse/auth/bootstrap.json` | `psql` / Drizzle Studio (`npm run db:studio`) |

**The hard constraint:** `DOLLHOUSE_AUTH_STORAGE_BACKEND=postgres` requires `DOLLHOUSE_STORAGE_BACKEND=database` and a valid `DATABASE_URL`. Auth tables and app tables live in the same Postgres instance.

**Migration path filesystem → Postgres:**
1. Stand up Postgres (`npm run db:setup`).
2. Re-bootstrap admin (state isn't auto-migrated): `npx dollhouse-admin-bootstrap …` against the new `DATABASE_URL`.
3. Switch `DOLLHOUSE_AUTH_STORAGE_BACKEND=filesystem` → `postgres` and add `DOLLHOUSE_STORAGE_BACKEND=database`.
4. Existing user accounts on the filesystem won't follow over — operator-issued accounts must be re-created against Postgres.

(There's no built-in account migration tool because it would need the operator's password-hash trust model; it's a minute of CLI per user.)

---

## Auth methods: choosing one

| Method | Use case | Required setup |
|---|---|---|
| `trivial-consent` | Solo localhost dev only | None — refuses to start on non-loopback bind |
| `local-password` | Solo, small team, fully self-hosted | None at the env level — admin uses `dollhouse-create-user` to issue invite URLs |
| `magic-link` | Hosted, email-based, no GitHub dependency | SMTP env vars (`DOLLHOUSE_SMTP_HOST/USER/PASSWORD/FROM/PORT`) |
| `github` | Hosted, users have GitHub accounts | Register GitHub OAuth app (web flow); set `DOLLHOUSE_AUTH_GITHUB_CLIENT_ID/SECRET` |

Multi-method is supported: `DOLLHOUSE_AUTH_METHODS=github,magic-link` exposes both at the same `/interaction` endpoint and presents a chooser.

---

## Exposing the server safely

The DollhouseMCP HTTP transport binds to `DOLLHOUSE_HTTP_HOST`:`DOLLHOUSE_HTTP_PORT` (defaults `127.0.0.1:3000`). How you expose it to clients matters for both auth correctness and security.

### Loopback only (local dev)

```bash
DOLLHOUSE_HTTP_HOST=127.0.0.1
DOLLHOUSE_TRUSTED_PROXIES=loopback
```

Server only reachable from the same machine. No TLS needed. trivial-consent is allowed; multi-user methods work but are operator-only since nobody else can reach the port.

### Cloudflare Tunnel (zero-port-forward dev/staging)

Cloudflare Tunnel terminates TLS at Cloudflare's edge and forwards plaintext to your local port. Your server stays on localhost; the tunnel makes it reachable as `https://your-name.example.com`.

```bash
# 1. Install cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
brew install cloudflared        # or apt / equivalent

# 2. Authenticate the tunnel against your Cloudflare account
cloudflared tunnel login

# 3. Create a named tunnel and point it at localhost:3000
cloudflared tunnel create dollhousemcp-dev
cloudflared tunnel route dns dollhousemcp-dev dollhousemcp.your-domain.com

# 4. Run the tunnel (in a separate terminal from the server)
cloudflared tunnel run --url http://127.0.0.1:3000 dollhousemcp-dev

# 5. DollhouseMCP env — the public URL clients will see
export DOLLHOUSE_HTTP_HOST=127.0.0.1            # local bind stays loopback
export DOLLHOUSE_PUBLIC_BASE_URL=https://dollhousemcp.your-domain.com
export DOLLHOUSE_TRUSTED_PROXIES=loopback        # tunnel hits localhost; X-F-F headers from Cloudflare
```

For GitHub method, register the OAuth app's callback URL as `https://dollhousemcp.your-domain.com/auth/social/github/callback`.

**About `DOLLHOUSE_TRUSTED_PROXIES`.** When the tunnel forwards a request, your server sees the connection coming from `127.0.0.1` — Cloudflare's headers tell you the real client IP. With `loopback` Express ignores those headers (safe default). If you want per-IP rate limiting to use the real client IP, set `DOLLHOUSE_TRUSTED_PROXIES` to the loopback CIDR explicitly so Express trusts X-Forwarded-For from `127.0.0.1`. For Cloudflare Tunnel specifically, the spoofing risk is limited because the tunnel daemon is what sets the headers — but the simpler answer for dev is to leave `loopback` and accept that rate limits collapse to one bucket per host.

### ngrok / similar (alternative to Cloudflare Tunnel)

Same pattern — local server stays on loopback, ngrok publishes a public HTTPS URL.

```bash
# Start the server first
npm run start:http &

# In another terminal:
ngrok http 3000
# → ngrok prints a URL like https://abcd1234.ngrok-free.app

export DOLLHOUSE_PUBLIC_BASE_URL=https://abcd1234.ngrok-free.app
# Restart the server with the new PUBLIC_BASE_URL — JWTs need to advertise it as `iss`
```

ngrok URLs change on free-tier restart; for stable URLs use a paid plan or Cloudflare Tunnel.

### Reverse proxy with TLS (production hosted shape)

The proxy terminates TLS; DollhouseMCP serves plaintext on the loopback or a private interface.

#### nginx example

```nginx
server {
  listen 443 ssl http2;
  server_name dollhousemcp.example.com;

  ssl_certificate     /etc/letsencrypt/live/dollhousemcp.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/dollhousemcp.example.com/privkey.pem;

  # MCP clients use Streamable HTTP — long-running responses, gzip-friendly
  proxy_buffering off;
  proxy_read_timeout 1h;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

#### Caddy example (auto-TLS)

```
dollhousemcp.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

#### DollhouseMCP env behind a proxy

```bash
export DOLLHOUSE_HTTP_HOST=127.0.0.1
export DOLLHOUSE_HTTP_PORT=3000
# Do NOT set DOLLHOUSE_TLS_CERT_PATH — proxy handles TLS.
export DOLLHOUSE_PUBLIC_BASE_URL=https://dollhousemcp.example.com
export DOLLHOUSE_TRUSTED_PROXIES='10.0.0.0/8'        # the proxy's CIDR; or '127.0.0.1' if proxy is co-located
```

The startup safety guard refuses to start when `DOLLHOUSE_AUTH_METHODS` includes a multi-user method on a non-loopback bind without an explicit `DOLLHOUSE_TRUSTED_PROXIES`. Setting `loopback` only (the default) on a non-loopback bind is also refused — that combination silently collapses per-IP rate limits to the proxy's egress IP.

### Native HTTPS (no proxy)

DollhouseMCP terminates TLS itself. Useful for single-process deployments without a reverse proxy.

```bash
export DOLLHOUSE_TLS_CERT_PATH=/path/to/fullchain.pem
export DOLLHOUSE_TLS_KEY_PATH=/path/to/privkey.pem      # mode 0600 or stricter
export DOLLHOUSE_HTTP_HOST=0.0.0.0                       # bind all interfaces
export DOLLHOUSE_HTTP_PORT=443                           # or 8443; needs root or CAP_NET_BIND_SERVICE for <1024
export DOLLHOUSE_PUBLIC_BASE_URL=https://dollhousemcp.example.com
export DOLLHOUSE_TRUSTED_PROXIES=loopback                # no upstream proxy; req.ip is the TCP peer
```

The TLS config pins minimum version to TLSv1.2 and uses Node's default cipher list.

---

## HTTPS: native vs reverse proxy vs tunnel

| | Best for | Rotation | TLS termination | Setup time |
|---|---|---|---|---|
| Loopback (no TLS) | Local dev only | n/a | None | seconds |
| Cloudflare Tunnel | Dev / staging without port forward | Cloudflare auto | Cloudflare edge | minutes |
| ngrok | Quick demo / one-off | ngrok auto | ngrok edge | seconds |
| Reverse proxy (nginx/Caddy) | Production hosted | Let's Encrypt + cron / Caddy auto | Proxy | 30 min |
| Native HTTPS | Single-process production, no proxy needed | Manual or external cert tool | DollhouseMCP | 30 min |

**Recommendation for testers:** Cloudflare Tunnel. Stable HTTPS URL in 5 minutes, no port forwarding, no certbot, the tunnel handles TLS rotation. For real production, reverse proxy + Let's Encrypt (Caddy is the lowest-effort option).

---

## Security checklist

Before you expose this server beyond loopback, confirm each:

- [ ] `DOLLHOUSE_AUTH_ENABLED=true` — without this, `/mcp` accepts unauthenticated requests
- [ ] `DOLLHOUSE_AUTH_PROVIDER=embedded` (or `oidc` if you have an external IdP)
- [ ] `DOLLHOUSE_AUTH_METHODS` is set to something OTHER than `trivial-consent` for any non-loopback bind
- [ ] Bootstrap admin claimed via `dollhouse-admin-bootstrap` or `dollhouse-create-user` — `/readyz` returns 200 (not 503)
- [ ] `DOLLHOUSE_PUBLIC_BASE_URL` is set to your public HTTPS URL — issued JWTs and `/.well-known/*` documents advertise this as `iss`
- [ ] `DOLLHOUSE_TRUSTED_PROXIES` matches your deployment shape — `loopback` for native HTTPS / no proxy; proxy CIDR (e.g. `10.0.0.0/8`) for reverse-proxy or tunnel deployments
- [ ] `DOLLHOUSE_COOKIE_SIGNING_SECRET` and `DOLLHOUSE_INVITE_TOKEN_SECRET` set via env (≥32 hex chars) — required if you're going to run multiple replicas, recommended even for single-replica so secrets survive run-dir wipes
- [ ] TLS in place — native (`DOLLHOUSE_TLS_CERT_PATH/_KEY_PATH`), reverse proxy (Caddy / nginx with Let's Encrypt), or tunnel (Cloudflare / ngrok)
- [ ] For GitHub method: `DOLLHOUSE_AUTH_GITHUB_CLIENT_ID` and `DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET` registered as a web-flow OAuth app with the correct callback URL
- [ ] For magic-link: SMTP credentials configured AND tested via the AS startup logs (verify-on-boot is automatic)
- [ ] If using Postgres backend: `DOLLHOUSE_DATABASE_SSL=require` for production
- [ ] Operator runbook for cert rotation, secret rotation, audit-log review

---

## Verifying the install

```bash
# Public — no auth needed
curl https://your.deployment/healthz                  # {ok: true, ...}
curl https://your.deployment/readyz                   # 200 once bootstrap completes; 503 with reason:bootstrap_required before
curl https://your.deployment/.well-known/oauth-authorization-server | jq

# Admin-only — requires Bearer token with roles:['admin'] (you get this from the OAuth flow as the bootstrap admin)
curl -H "Authorization: Bearer $TOKEN" https://your.deployment/auth/admin/me | jq

# MCP — needs any authenticated user's Bearer token
curl -X POST https://your.deployment/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"curl","version":"1"},"capabilities":{}}}'
```

For the Postgres backend, you can also inspect state directly:
```bash
docker exec -it dollhousemcp-postgres psql -U dollhouse -d dollhousemcp
\dt auth_*
SELECT sub, provider, email, roles, last_auth_at FROM auth_accounts;
SELECT model, count(*) FROM auth_kv GROUP BY model;
SELECT type, sub, created_at FROM auth_audit_events ORDER BY created_at DESC LIMIT 20;
```

---

## Connecting an MCP client

### What end users actually do

Once the operator has finished one of Paths A–D above, every other person connecting to your server goes through the same short flow regardless of which auth method you chose:

1. Add the server URL to their MCP client config (Claude Desktop config file, `gemini mcp add`, etc.)
2. Trigger auth in the client (the client does it automatically on first tool call, or you can force it with e.g. `/mcp auth dollhouse` in Gemini CLI)
3. A browser tab opens to your DollhouseMCP server's consent page
4. They click "Sign in with GitHub" / "Approve Connector" / enter credentials, depending on the method
5. The browser redirects back to the client's local callback
6. The client has a token. MCP tools work.

End users never run CLI commands, never touch env vars, never register OAuth apps. The operator does all that once.

### MCP client compatibility

Different MCP clients handle the OAuth-client-registration step differently. This matters because the DollhouseMCP AS supports two registration models, and the right one depends on the client.

| Client | OAuth client model | Operator action |
|---|---|---|
| **Claude Desktop** | Uses the pre-registered `DEFAULT_CLIENT_ID` (`dollhouse-claude-connector`) with native-app loopback policy. No DCR. | None. Works out of the box. |
| **Claude Code** | Same — pre-registered client_id, native loopback. | None. |
| **Gemini CLI** | Auto-performs RFC 7591 Dynamic Client Registration (DCR) at `/reg` with no Initial Access Token. | Set `DOLLHOUSE_AUTH_OPEN_DCR=true` (loopback-only escape hatch). See "Dynamic Client Registration" below. |
| **claude.ai web** | Same as Gemini — auto-DCR, no IAT support. | Same — `DOLLHOUSE_AUTH_OPEN_DCR=true`. |
| **Custom SDK clients** | Whatever PKCE+token logic you implement — DollhouseMCP's discovery doc at `/.well-known/oauth-authorization-server` gives you all the endpoints. | None if you use the pre-registered `DEFAULT_CLIENT_ID`. |

### Dynamic Client Registration (`DOLLHOUSE_AUTH_OPEN_DCR`)

DollhouseMCP supports RFC 7591 Dynamic Client Registration so MCP clients that don't know a fixed `client_id` (Gemini CLI, claude.ai web) can register themselves and obtain one. DCR has two modes:

| Mode | Operator setup | Security |
|---|---|---|
| `DOLLHOUSE_AUTH_OPEN_DCR=false` (default) | Production-target shape. `/reg` requires an Initial Access Token bearer. **IAT issuance is currently a deferred admin-channel feature** — until it lands, this mode effectively rejects MCP clients that auto-DCR. | Strong. Random callers cannot register clients. |
| `DOLLHOUSE_AUTH_OPEN_DCR=true` | Localhost-dev escape hatch. `/reg` accepts unauthenticated registrations. | Acceptable on loopback bind; UNSAFE on a publicly-reachable AS — an attacker could register a client with their own `redirect_uri` and phish authorization codes. |

```bash
# For localhost smoke tests with Gemini CLI / claude.ai web:
export DOLLHOUSE_AUTH_OPEN_DCR=true
export DOLLHOUSE_HTTP_HOST=127.0.0.1
```

**For remote deployments that need auto-DCR clients**: tunnel your local AS (Cloudflare Tunnel, ngrok). The AS stays bound to loopback and open DCR stays safe because nobody hits `/reg` directly — they hit the tunnel which proxies. Clients connect to the tunnel URL. This is the documented `npx dollhousemcp` shape.

### Claude Desktop

Configure DollhouseMCP as an MCP server in Claude Desktop's settings file. Claude Desktop drives the OAuth flow automatically when it sees a 401 with the discovery document. You authenticate in your browser the first time, then Claude caches the token. **No `DOLLHOUSE_AUTH_OPEN_DCR` needed** — Claude Desktop uses the pre-registered `DEFAULT_CLIENT_ID`.

### Gemini CLI

```bash
gemini mcp add dollhouse http://your.deployment/mcp
gemini
# inside gemini:
/mcp auth dollhouse
# Browser opens, you approve, you're in.
```

The server must have `DOLLHOUSE_AUTH_OPEN_DCR=true` for Gemini CLI's auto-DCR to succeed. Without it, you'll see `Client registration failed: 401 Unauthorized`.

### SDK / custom clients

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(new URL('https://your.deployment/mcp'), {
  // Token obtained out-of-band via the OAuth flow.
  // Many SDKs ship a helper to drive PKCE against the discovery URL.
  requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
});
const client = new Client({ name: 'my-client', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
```

The OAuth flow uses standard PKCE — your client library should follow the discovery document at `https://your.deployment/.well-known/oauth-authorization-server` to find `/authorize` and `/token`. If you can hard-code the client_id, use `dollhouse-claude-connector` (the pre-registered native-app client) and avoid DCR entirely.

---

## Troubleshooting

### `/readyz` returns 503 forever

```json
{"ready":false,"reason":"bootstrap_required"}
```

You haven't claimed the admin identity. Run the appropriate bootstrap CLI for your method:
- `local-password`: `npx dollhouse-create-user --username … --email …`
- `magic-link`: `npx dollhouse-admin-bootstrap --method magic-link --email …`
- `github`: `npx dollhouse-admin-bootstrap --method github --github-username …`

### Server refuses to start: "DOLLHOUSE_AUTH_METHODS configures a multi-user method ... DOLLHOUSE_AUTH_ENABLED is false"

You set up the auth server (`DOLLHOUSE_AUTH_PROVIDER=embedded`) but forgot the master switch. Set `DOLLHOUSE_AUTH_ENABLED=true`. Without this, the MCP endpoint accepts unauthenticated requests, which is exactly the misconfig the guard catches.

### Server refuses to start: "non-loopback bind ... requires DOLLHOUSE_TRUSTED_PROXIES"

You're binding to a non-loopback host (Docker, container, public interface) but `DOLLHOUSE_TRUSTED_PROXIES` is at the default. Set it to the proxy CIDR (`10.0.0.0/8`, your VPC range, etc.), or to `loopback` only if you're terminating TLS on this server with no proxy in front.

### GitHub callback returns 400 "redirect_uri mismatch"

The callback URL registered with GitHub doesn't match what DollhouseMCP sends. The correct callback URL is `<DOLLHOUSE_PUBLIC_BASE_URL>/auth/social/github/callback`. Common mistakes:
- Setting `DOLLHOUSE_PUBLIC_BASE_URL` to `http://...` when GitHub knows about `https://...`
- Mixing up the user-auth callback (`/auth/social/github/callback`) with the legacy portfolio-sync URL
- Trailing slash in either side

### Magic-link emails never arrive

Check the AS startup log for the `[NodemailerEmailSender] SMTP connection verified` line. If it's not there, the SMTP verify failed at boot — credentials are wrong, the relay refused STARTTLS, or DNS is unreachable. Re-run with the SMTP env vars corrected. The AS refuses to start with magic-link configured but SMTP failing verify.

### Token validates locally but `/mcp` returns 401

- Token expired (default access token TTL is 1 hour): refresh via the standard refresh-token flow
- `iss` claim doesn't match `DOLLHOUSE_PUBLIC_BASE_URL`: the AS rotated mode (e.g., method change) and minted a new key — re-authenticate
- `aud` claim doesn't match the resource: your client should request `resource=<base>/mcp` on the token call

### Multi-replica HA: cookie-signed cookies fail across replicas

Each replica generated its own cookie signing key. Set `DOLLHOUSE_COOKIE_SIGNING_SECRET` to the same value across all replicas (and `DOLLHOUSE_INVITE_TOKEN_SECRET` for invite + magic-link tokens).

### Client gets `401 Unauthorized` from `/reg` ("Client registration failed")

Your MCP client (Gemini CLI, claude.ai web) is trying to auto-register via DCR and the AS is rejecting because no Initial Access Token was provided. Set `DOLLHOUSE_AUTH_OPEN_DCR=true` for localhost dev (and tunnel the AS rather than exposing it for remote use). See "Dynamic Client Registration" in [Connecting an MCP client](#connecting-an-mcp-client).

### Client gets `400 Bad Request: scope must only contain Authorization Server supported scope values`

Pre-cycle-24 bug — the AS's `scopes` config was missing `mcp`/`profile`/`email`. Already fixed in current builds. If you see this, you're on an old build; pull latest and rebuild.

### Approve button on the consent page does nothing / cycles to a new `/interaction/<uid>`

Pre-cycle-24 bug — the grant's scope binding was single-dimension and oidc-provider re-prompted because half the scopes were missing from each dimension. Already fixed in current builds. If you see this loop, pull latest and rebuild.

### `npx dollhouse-admin-bootstrap --method github --github-username …` returns "GitHub API 401 Unauthorized"

A stale or invalid `GITHUB_TOKEN` in your environment is being sent to GitHub's API and rejected. Two fixes:

1. **Clear `GITHUB_TOKEN` for the call**:
   ```bash
   GITHUB_TOKEN="" npx dollhouse-admin-bootstrap --method github --github-username insomnolence
   ```
2. **Skip the lookup, pass the numeric ID directly** (find via `curl https://api.github.com/users/<username> | jq .id`):
   ```bash
   npx dollhouse-admin-bootstrap --method github --github-id 1125822
   ```

### Transient "MCP ERROR" pop-ups in client during idle

Pre-cycle-24 issue — Node's default HTTP `keepAliveTimeout=5s` and `requestTimeout=300s` killed long-lived MCP Streamable HTTP connections during idle. Cycle 24 bumped both at the server-side. If you're on an old build, update. If you're behind a reverse proxy, make sure the proxy's idle timeout exceeds 120 seconds.

### I changed `DOLLHOUSE_AUTH_METHODS` and now all my clients are signed out

That's intentional. The AS computes a mode-fingerprint from `(provider, methodIds, issuer, primaryKid, primaryCookieKey)` and any change triggers a deliberate invalidation: K/V state is cleared, JWKS rotates, cookie secret rotates. Outstanding tokens fail validation (must-fix #14). Clients re-auth via the new method on next connect. Account rows (`auth_accounts`) survive — users keep their identity and per-user data — only sessions and grants reset.

If you're toggling between methods during testing and want to preserve auth state, don't change `DOLLHOUSE_AUTH_METHODS`; instead configure multiple methods at once and let the chooser handle which one the user picks (`DOLLHOUSE_AUTH_METHODS=github,local-password`).

---

## Reset / disaster recovery

### Filesystem backend

```bash
# Nuke ALL auth state (sessions, accounts, bootstrap, audit log, signing keys)
rm -rf ~/.dollhouse/auth/
rm ~/.dollhouse/run/oauth-signing-key.json     # forces fresh JWKS
rm ~/.dollhouse/run/cookie-signing-secret.bin  # only if you didn't pin via env

# Or surgically — reset just bootstrap state
rm ~/.dollhouse/auth/bootstrap.json
# Restart server, re-run bootstrap CLI.
```

### Postgres backend

```bash
docker exec -it dollhousemcp-postgres psql -U dollhouse -d dollhousemcp -c \
  "TRUNCATE auth_accounts, auth_kv, auth_audit_events;"
rm ~/.dollhouse/run/oauth-signing-key.json     # JWKS still on disk
# Restart, re-run bootstrap.

# Full nuke — drops the database, re-migrates
docker compose -f docker/docker-compose.db.yml down -v
npm run db:setup
```

### Backup (production)

For Postgres:
```bash
pg_dump -h $PGHOST -U dollhouse -d dollhousemcp \
  --table=auth_accounts --table=auth_kv --table=auth_audit_events \
  -f auth-backup-$(date -u +%Y%m%dT%H%M%SZ).sql
```

For filesystem:
```bash
tar czf auth-backup-$(date -u +%Y%m%dT%H%M%SZ).tar.gz \
  ~/.dollhouse/auth/ \
  ~/.dollhouse/run/oauth-signing-key.json \
  ~/.dollhouse/run/cookie-signing-secret.bin \
  ~/.dollhouse/run/invite-token-secret.bin
```

The four critical pieces of state to back up: auth tables (or `~/.dollhouse/auth/`), JWKS signing key, cookie signing secret, invite token secret. See [`SECTION-8.1-DR-RUNBOOK.md`](../../../docs/SECTION-8.1-DR-RUNBOOK.md) (filesystem-only) for the full DR procedure.

---

## Reference

- Env-var reference: [deployment-configuration.md § Authentication](./deployment-configuration.md#authentication-environment-variables)
- Architectural overview: [`docs/PRODUCTION-AUTH-ARCHITECTURE.md`](../../../docs/PRODUCTION-AUTH-ARCHITECTURE.md)
- Disaster recovery runbook: [`docs/SECTION-8.1-DR-RUNBOOK.md`](../../../docs/SECTION-8.1-DR-RUNBOOK.md)
- Storage layer architecture: [storage-and-database.md](../architecture/storage-and-database.md)
- Legacy GitHub portfolio sync (different feature): [oauth-setup.md](./oauth-setup.md)
- Streamable HTTP transport details: [streamable-http-hosted-mode.md](./streamable-http-hosted-mode.md)
