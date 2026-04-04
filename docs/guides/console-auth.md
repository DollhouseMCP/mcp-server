# Console Authentication

> **Status:** Phase 1 (infrastructure) — `DOLLHOUSE_WEB_AUTH_ENABLED` is **off by default**.
> Phase 2 adds token rotation with TOTP/authenticator confirmation.
> Phase 3 flips the default to **on** once the DollhouseBridge permission-prompt server has been updated.

DollhouseMCP's web management console on port `3939` protects its API with a session token. The token is generated automatically on first run, persists across restarts, and is required on every protected endpoint when the `DOLLHOUSE_WEB_AUTH_ENABLED` environment variable is `true`.

This guide covers what the token is, where it lives, how to use it, and how to opt in or out.

---

## Quick start

```bash
# 1. Your token is in this file (created automatically on first run)
cat ~/.dollhouse/run/console-token.json | jq .

# 2. Attach it to curl requests
TOKEN=$(jq -r '.tokens[0].token' ~/.dollhouse/run/console-token.json)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3939/api/elements

# 3. Or define a shell helper (~/.zshrc or ~/.bashrc)
dh-token() { jq -r '.tokens[0].token' ~/.dollhouse/run/console-token.json; }
dh-curl() { curl -H "Authorization: Bearer $(dh-token)" "$@"; }

# Usage
dh-curl http://localhost:3939/api/elements
dh-curl -X POST http://localhost:3939/api/install -d '{"path":"library/personas/creative-writer.md","name":"creative-writer","type":"persona"}'
```

---

## Why authentication?

Port 3939 binds to `127.0.0.1` only, so it is not reachable from the network. Binding alone is the **current** security boundary. Adding authentication raises that boundary so that:

- Other local processes cannot inject fake logs, approve tool permissions, or kill sessions without the token
- Shared workstations (multi-user Linux, containers with port mapping) can safely run DollhouseMCP without exposing the console to other users
- External tools that want to integrate with DollhouseMCP can do so under a well-defined auth model (see [External API Access](./external-api-access.md))

---

## The token file

**Location:** `~/.dollhouse/run/console-token.json`
**Permissions:** `0600` — owner read/write only
**Created by:** The leader process, on first run
**Lifecycle:** Persistent across restarts. Only changes when explicitly rotated.

**Schema (version 1):**

```json
{
  "version": 1,
  "tokens": [
    {
      "id": "018e1a2b-3c4d-7e5f-8901-abcdef123456",
      "name": "Kermit on my-laptop",
      "kind": "console",
      "token": "a1b2c3d4...",
      "scopes": ["admin"],
      "elementBoundaries": null,
      "tenant": null,
      "platform": "local",
      "labels": {},
      "createdAt": "2026-04-04T20:00:00.000Z",
      "lastUsedAt": null,
      "createdVia": "initial-setup"
    }
  ],
  "totp": {
    "enrolled": false,
    "secret": null,
    "backupCodes": []
  }
}
```

**Field notes:**

- `id` / `name` — stable identifiers. The `name` defaults to a randomly chosen puppet plus your hostname and is editable in the Security tab (Phase 2).
- `token` — the 64-hex-character (256-bit) Bearer value. This is what you send on requests.
- `scopes`, `elementBoundaries`, `tenant`, `platform`, `labels` — forward-compatible fields for enterprise deployments. Phase 1 treats every token as admin-scoped. Phase 2 and 3 will begin enforcing these.
- `lastUsedAt` — updated in memory every time the token is verified. Persisted to disk on rotation (Phase 2).
- `totp` — TOTP enrollment state. Populated in Phase 2.

---

## Attaching the token

### Authorization header (preferred)

```
Authorization: Bearer <token>
```

Works for every protected endpoint. This is what the browser UI and follower processes do automatically.

### Query parameter (SSE fallback)

```
GET /api/logs/stream?token=<token>
```

`EventSource` in the browser cannot set custom headers, so SSE streams accept the token as a `?token=` query parameter. The middleware treats both methods identically. Do **not** use the query parameter for non-SSE calls — server access logs may record URLs but not headers.

---

## Feature flag

**Env var:** `DOLLHOUSE_WEB_AUTH_ENABLED`
**Default:** `false` (Phase 1)

When `false`, the auth middleware is a pass-through: every request is allowed, and the token file is still generated so you can attach it preemptively. This is the default during Phase 1 rollout so that existing consumers (browser, followers, DollhouseBridge) don't break.

When `true`, every protected endpoint requires a valid token. Set this in `.env.local`:

```bash
DOLLHOUSE_WEB_AUTH_ENABLED=true
```

The default will flip to `true` in a follow-up PR once all first-party consumers have been updated.

---

## Protected vs. public endpoints

### Protected (require a token when `DOLLHOUSE_WEB_AUTH_ENABLED=true`)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/setup/install` | Install DollhouseMCP to an MCP client |
| `POST` | `/api/setup/open-config` | Open MCP client config in an editor |
| `POST` | `/api/install` | Install a collection element into the portfolio |
| `POST` | `/api/evaluate_permission` | Evaluate a tool permission decision |
| `GET`  | `/api/permissions/status` | Current permission policies + recent decisions |
| `GET`  | `/api/logs` | Query logs |
| `GET`  | `/api/logs/stream` | SSE log stream |
| `GET`  | `/api/logs/stats` | Log buffer stats |
| `GET`  | `/api/metrics` | Query metrics |
| `GET`  | `/api/metrics/stream` | SSE metrics stream |
| `GET`  | `/api/sessions` | List active sessions |
| `POST` | `/api/sessions/:id/kill` | Terminate a session |
| `POST` | `/api/ingest/logs` | Follower log forwarding |
| `POST` | `/api/ingest/metrics` | Follower metric forwarding |
| `POST` | `/api/ingest/session` | Follower session lifecycle |
| `GET`  | `/api/elements*` | List / read portfolio elements |
| `GET`  | `/api/stats` | Portfolio stats |
| `GET`  | `/api/collection*` | Community collection browsing |
| `GET`  | `/api/pages` | List user-created console pages |

### Public (never require a token)

| Method | Path | Reason |
|---|---|---|
| `GET` | `/` and static assets | SPA entry point and browser resources |
| `GET` | `/api/health` | Monitoring probes |
| `GET` | `/api/setup/version` | Public version info (calls GitHub releases API) |
| `GET` | `/api/setup/detect` | Reads local MCP client config files (no server state) |
| `GET` | `/api/setup/mcpb` | Redirect to public GitHub release asset |

---

## How the browser UI gets the token

The server injects the current token into `index.html` via a `<meta name="dollhouse-console-token">` tag at request time. The browser's auth helper (`consoleAuth.js`) reads the tag on page load and automatically attaches the token to every fetch and SSE call via a thin wrapper (`window.DollhouseAuth.apiFetch`, `window.DollhouseAuth.apiEventSource`).

The token is never exposed in `localStorage` or cookies — it's re-read from the freshly rendered HTML on every page load. After a rotation (Phase 2), a page reload picks up the new token immediately.

---

## How follower processes get the token

DollhouseMCP uses a leader/follower model for multi-session deployments. The leader owns the token file; followers read it on startup and attach the token to their `/api/ingest/*` POSTs. If the file is missing when a follower starts (unusual — the leader creates it), the follower simply omits the Bearer header and relies on the auth flag being off.

Rotation handling for long-lived followers will land in Phase 2 (read-on-401 with file refresh).

---

## Troubleshooting

### "Authentication required" on every request

The feature flag is on but your requests aren't attaching the token. Check:

1. `cat ~/.dollhouse/run/console-token.json` — does the file exist and contain a `tokens` array?
2. Are you sending `Authorization: Bearer <token>` (not `Basic`, not just the token value)?
3. For SSE streams, are you appending `?token=<token>` to the URL?
4. Has the token been rotated recently? Re-read the file.

### Token file doesn't exist

The leader hasn't run yet. Start the server with `--web` or let a normal MCP stdio session elect itself as leader. The file is created on first leader election.

### Followers can't ingest logs after enabling auth

Restart the follower processes. They read the token file on startup; they don't currently watch it for changes (Phase 2 feature).

### I rotated the token in another window and my scripts stopped working

That's expected — tokens are the unit of access, and rotation invalidates the old one by design. Re-read the file:

```bash
TOKEN=$(jq -r '.tokens[0].token' ~/.dollhouse/run/console-token.json)
```

### I want to reset my token without restarting

Not supported in Phase 1. You can delete the file and restart the server to force a fresh token:

```bash
rm ~/.dollhouse/run/console-token.json
# restart the server
```

Phase 2 will add a "rotate" button in the web UI and a `dollhouse console token rotate` CLI command with authenticator-based confirmation.

---

## Security notes

- **Treat the token like an SSH key or API key.** Anyone who holds it has full admin access to the local management API — including the ability to install MCP configs, approve tool permissions, kill sessions, and read all logs on the host.
- **Don't commit `console-token.json` anywhere.** It lives under `~/.dollhouse/` which isn't a git repo by default, but if anyone symlinks or copies that directory, the token goes with it.
- **Don't paste the token into chat, email, or pull request descriptions.** It's localhost-only, but paranoia is cheap.
- **Don't expose port 3939 beyond localhost without TLS.** The binding is still `127.0.0.1` only. Bearer-over-HTTP is fine for localhost but unsafe the moment you change the bind address.
- **Rotation is manual in Phase 1.** If you suspect compromise, stop the server, delete the token file, and restart.

---

## Related

- [External API Access via MCP-AQL adapter](./external-api-access.md) — how external tools and LLMs can consume the DollhouseMCP management API
- [Security architecture](../security/architecture.md#layer-7-oauth--api-security) — where console auth fits in the full threat model
- [Environment variables reference](./environment-variables.md#dollhouse_web_auth_enabled)
