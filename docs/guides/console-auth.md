# Console Authentication

> **Status:** Authenticated console — `DOLLHOUSE_WEB_AUTH_ENABLED` is **off by default** during rollout.
> **Current capabilities:** TOTP enrollment, token rotation with TOTP confirmation, structured error codes, isolated port (5907) and state files, legacy console detection.
> **Roadmap:** CLI rotation command, Security tab UI, then flipping the auth default to **on** once consumer updates (DollhouseBridge, browser helpers) have landed.

DollhouseMCP's web management console on port `5907` protects its API with a session token. The token is generated automatically on first run, persists across restarts, and is required on every protected endpoint when the `DOLLHOUSE_WEB_AUTH_ENABLED` environment variable is `true`.

> **Port change from earlier versions.** Pre-authentication DollhouseMCP releases bound the web console to port `3939`. The authenticated console binds to `5907` instead (with `.auth` suffixes on the state files) so that a legacy installation and an authenticated installation can coexist on the same machine with zero cross-contamination. Both consoles use fully independent ports, lock files, and token files. If your deployment has a collision on 5907 — for example, [Stellar Cyber](https://docs.stellarcyber.ai/6.3.xs/Configure/Ports/Firewall-Ports-for-Parsers.htm) uses it for its HTTP Google Kubernetes Engine log parser — override it via the `DOLLHOUSE_WEB_CONSOLE_PORT` env var without touching any code.

## Configuration via environment variables

| Env var | Default | Purpose |
|---|---|---|
| `DOLLHOUSE_WEB_CONSOLE_PORT` | `5907` | Port the authenticated console binds to. Any 1024-65535. |
| `DOLLHOUSE_CONSOLE_LEADER_LOCK_FILE` | `~/.dollhouse/run/console-leader.auth.lock` | Leader election lock file path. |
| `DOLLHOUSE_CONSOLE_TOKEN_FILE` | `~/.dollhouse/run/console-token.auth.json` | Token storage file path. |
| `DOLLHOUSE_WEB_AUTH_ENABLED` | `false` | Enforce Bearer auth on protected endpoints (Phase 3 default). |

All four are read from `src/config/env.ts`, which is the single source of truth. Changing any of them is a one-line env change, no code edits required.

This guide covers what the token is, where it lives, how to use it, and how to opt in or out.

---

## Quick start

```bash
# 1. Your token is in this file (created automatically on first run)
cat ~/.dollhouse/run/console-token.auth.json | jq .

# 2. Attach it to curl requests
TOKEN=$(jq -r '.tokens[0].token' ~/.dollhouse/run/console-token.auth.json)
curl -H "Authorization: Bearer $TOKEN" http://localhost:5907/api/elements

# 3. Or define a shell helper (~/.zshrc or ~/.bashrc)
dh-token() { jq -r '.tokens[0].token' ~/.dollhouse/run/console-token.auth.json; }
dh-curl() { curl -H "Authorization: Bearer $(dh-token)" "$@"; }

# Usage
dh-curl http://localhost:5907/api/elements
dh-curl -X POST http://localhost:5907/api/install -d '{"path":"library/personas/creative-writer.md","name":"creative-writer","type":"persona"}'
```

---

## Why authentication?

Port 5907 binds to `127.0.0.1` only, so it is not reachable from the network. Binding alone is the **current** security boundary. Adding authentication raises that boundary so that:

- Other local processes cannot inject fake logs, approve tool permissions, or kill sessions without the token
- Shared workstations (multi-user Linux, containers with port mapping) can safely run DollhouseMCP without exposing the console to other users
- External tools that want to integrate with DollhouseMCP can do so under a well-defined auth model (see [External API Access](./external-api-access.md))

---

## The token file

**Location:** `~/.dollhouse/run/console-token.auth.json`
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
    "backupCodes": [],
    "enrolledAt": null
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
| `POST` | `/api/console/token/rotate` | Rotate the primary console token (always-on auth + TOTP) |
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

### Known Phase 1 gaps

These are **intentionally** unprotected in Phase 1 and will be addressed in later phases:

- **`/pages/*` — user-generated HTML dashboards** under `~/.dollhouse/pages/`. These are served as static files and the auth middleware (mounted at `/api`) never sees them. Direct navigation to a page URL does not carry a Bearer header, so protecting them requires a full meta-tag injection + cooperative fetch refactor. **If you store sensitive information in a user page, do not enable `DOLLHOUSE_WEB_AUTH_ENABLED=true` in production until Phase 2 lands.** Tracked in issue #1788.

- **Leader election race window.** Between the moment a process claims leadership (writing `~/.dollhouse/run/console-leader.auth.lock`) and the moment it finishes writing the token file (`~/.dollhouse/run/console-token.auth.json`), there is a brief window where a follower booting concurrently may see the lock but no token. The follower's `LeaderForwardingSink` handles this with backoff + retry — failed ingest POSTs are re-attempted — so the gap is benign and self-healing.

- **`401` rate limiting.** Not implemented yet. A 256-bit token cannot be brute-forced in any practical sense, but a flood of wrong-token requests could saturate the verify path as a DoS. Deferred to Phase 3.

- **Windows file permissions.** `chmod(0o600)` is a no-op on Windows because the file system uses ACLs instead of POSIX modes. A one-time warning is logged on startup when the token file is created on Windows. In multi-user Windows environments, restrict access with `icacls`:

  ```powershell
  icacls "%USERPROFILE%\.dollhouse\run\console-token.auth.json" /inheritance:r /grant:r "%USERNAME%:RW"
  ```

  This removes inherited permissions and grants read/write only to the current user — the Windows equivalent of `chmod 0600`.

---

## How the browser UI gets the token

The server injects the current token into `index.html` via a `<meta name="dollhouse-console-token">` tag at request time. The browser's auth helper (`consoleAuth.js`) reads the tag on page load and automatically attaches the token to every fetch and SSE call via a thin wrapper (`window.DollhouseAuth.apiFetch`, `window.DollhouseAuth.apiEventSource`).

The token is never exposed in `localStorage` or cookies — it's re-read from the freshly rendered HTML on every page load. After a rotation, the browser helper's `DollhouseAuth.refresh(newToken)` method updates the cached token in memory so the active tab switches to the new value without a full page reload. A manual reload also works — the server injects the current token into the HTML on each request.

---

## How follower processes get the token

DollhouseMCP uses a leader/follower model for multi-session deployments. The leader owns the token file; followers read it on startup and attach the token to their `/api/ingest/*` POSTs. If the file is missing when a follower starts (unusual — the leader creates it), the follower simply omits the Bearer header and relies on the auth flag being off.

After a rotation, the new token value is written to disk atomically; followers that restart will pick up the new value automatically. Long-lived followers that encounter a `401` should re-read the token file — automated read-on-401 recovery is tracked in issue #1792.

---

## Troubleshooting

### "Authentication required" on every request

The feature flag is on but your requests aren't attaching the token. Check:

1. `cat ~/.dollhouse/run/console-token.auth.json` — does the file exist and contain a `tokens` array?
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
TOKEN=$(jq -r '.tokens[0].token' ~/.dollhouse/run/console-token.auth.json)
```

### I want to reset my token without restarting

Use the rotation endpoint (requires TOTP enrollment):

```bash
TOKEN=$(jq -r '.tokens[0].token' ~/.dollhouse/run/console-token.auth.json)
curl -s -H "Authorization: Bearer $TOKEN" -X POST http://localhost:5907/api/console/token/rotate \
  -H 'Content-Type: application/json' -d '{"confirmationCode":"<6-digit TOTP code>"}' | jq .
```

The response contains the new token. Update your shell variable and you're back in business. See [Token rotation](#token-rotation) below for the full walkthrough.

If you haven't enrolled TOTP yet, the fallback is to delete the file and restart:

```bash
rm ~/.dollhouse/run/console-token.auth.json
# restart the server
```

---

## TOTP (authenticator) enrollment — Phase 2

Phase 2 adds a second factor: a time-based one-time password (TOTP) that pairs with any standard authenticator app (Google Authenticator, 1Password, Authy, Bitwarden, etc.). Enrollment is optional in Phase 2 and becomes required for privileged operations like token rotation once the rotation endpoint lands.

**What enrollment gives you:**

- **Second-factor confirmation** for token rotation and other sensitive operations — merely holding the token is not enough; you also need the live 6-digit code from your authenticator.
- **10 one-shot backup codes** generated at enrollment time, shown exactly once, for recovery if you lose your authenticator.

**Endpoints (under `/api/console/totp`, always require auth regardless of `DOLLHOUSE_WEB_AUTH_ENABLED`):**

| Endpoint | Purpose |
|---|---|
| `GET /status` | Returns `{enrolled, enrolledAt, backupCodesRemaining}` |
| `POST /enroll/begin` | Generates a pending secret, returns `{pendingId, secret, otpauthUri, qrSvgDataUrl, expiresAt}` |
| `POST /enroll/confirm` | Verifies `{pendingId, code}`, persists enrollment, returns `{enrolled, enrolledAt, backupCodes}` (plaintext, **shown once**) |
| `POST /disable` | Verifies `{code}` (TOTP or backup code), clears enrollment |

**Error responses** include both a human-readable `error` message and a machine-readable `code` field so programmatic clients (CLI, UI) can branch on the failure reason:

| Code | Status | Meaning |
|---|---|---|
| `MISSING_FIELDS` | 400 | Required body field not present |
| `INVALID_TOTP_CODE` | 400 | Code did not match the pending or stored secret |
| `PENDING_NOT_FOUND` | 400 | Pending enrollment ID unknown or expired |
| `NOT_ENROLLED` | 400 | `/disable` called but no enrollment exists |
| `ALREADY_ENROLLED` | 409 | `/enroll/begin` called while TOTP is already enrolled |
| `RATE_LIMITED` | 429 | Too many code-verification attempts; back off and retry |

**CLI walkthrough (until the Security tab UI lands):**

```bash
TOKEN=$(jq -r '.tokens[0].token' ~/.dollhouse/run/console-token.auth.json)
H="Authorization: Bearer $TOKEN"

# 1. Start enrollment — shows a QR-code-rendered otpauth URI you can scan
curl -s -H "$H" -X POST http://localhost:5907/api/console/totp/enroll/begin \
  -H 'Content-Type: application/json' -d '{"label":"My laptop"}' | jq .

# 2. Scan the QR (or paste the secret into your authenticator manually)
# 3. Confirm with the live 6-digit code
curl -s -H "$H" -X POST http://localhost:5907/api/console/totp/enroll/confirm \
  -H 'Content-Type: application/json' \
  -d '{"pendingId":"...","code":"123456"}' | jq .

# Write down the 10 backup codes it returns — you will never see them again.

# Check enrollment state
curl -s -H "$H" http://localhost:5907/api/console/totp/status | jq .

# Disable later (needs a valid TOTP or backup code)
curl -s -H "$H" -X POST http://localhost:5907/api/console/totp/disable \
  -H 'Content-Type: application/json' -d '{"code":"123456"}'
```

**How backup codes work:**

- 10 codes × 8 characters each, drawn from an unambiguous Crockford base32 alphabet (no `I`, `L`, `O`, or `U`).
- Each code is single-use — consuming one removes it from the store permanently.
- Stored as `sha256` hex hashes, never plaintext. If the token file leaks, your backup codes don't.
- Backup codes can be typed with optional dashes or spaces (`ABCD-EFGH` and `ABCDEFGH` are both accepted).

**Validation window — timing tolerance for slow transports:**

TOTP codes are validated with a **±60-second tolerance** (window=2, 150 seconds total validity). This is deliberately wider than the RFC 6238 default (±30s) to cover two real-world scenarios:

1. **Chat-bridge transports** like DollhouseBridge over Zulip can add 10–60 seconds of latency between the user typing a code and the MCP server seeing it. With the default ±30s, a code typed with only a few seconds of step-lifetime remaining can age out mid-transit.
2. **Clock drift** — containers, VMs, and phones with lazy NTP sync can disagree with the server by tens of seconds. ±60s absorbs routine drift without user intervention.

If you consistently see invalid-code errors, especially over a chat bridge:
- **Submit codes with plenty of step-lifetime remaining.** If your authenticator shows 5 seconds left before the next code, wait for the next one before typing it.
- **Check the clock on whatever generates the code.** Most phones sync via NTP automatically; desktop authenticators may not.
- **Check the clock on the MCP server host.** `timedatectl status` (Linux), `sntp -sS time.apple.com` (macOS).

**Security notes specific to TOTP:**

- The TOTP secret is stored in plaintext alongside the token inside `console-token.auth.json`, which is `0600`. This matches standard file-based TOTP storage (SSH keys, age identity files, 1Password vault backups). Encrypting the secret with an OS keychain is a future enhancement.
- Enrollment endpoints rate-limit code attempts to 10 per minute to cap brute-force exposure of the 6-digit code space. With the ±60s window, 5 codes out of 10⁶ are valid at any instant — brute-force success probability remains below 5×10⁻⁵ per minute.
- Enrolling a second factor does **not** replace the console token — both still work. The token is "something you have (on disk)", TOTP is "something you have (on your phone)". Token rotation requires **both** — you must present the console token (via auth middleware) **and** a valid TOTP code (via the confirmation code parameter).
- Every failed verification fires a `TOTP_VERIFICATION_FAILED` event to SecurityMonitor (deduped per 60s window), so aggregate failure rates can be surfaced for brute-force detection.

---

## Token rotation

The rotation endpoint lets you invalidate the current console token and get a fresh one in a single request — no restart, no file editing. Rotation requires TOTP confirmation (you must be enrolled first; see [TOTP enrollment](#totp-authenticator-enrollment) above).

**Rotation flow:**

```
  Browser / CLI              Server                    Token File
       │                       │                           │
       │  POST /rotate         │                           │
       │  Authorization: Bearer OLD_TOKEN                  │
       │  { confirmationCode } │                           │
       │──────────────────────>│                           │
       │                       │  1. Verify Bearer token   │
       │                       │  2. Verify TOTP code      │
       │                       │  3. Stash OLD in grace    │
       │                       │     buffer (15s TTL)      │
       │                       │  4. Generate NEW token    │
       │                       │  5. Write atomically ────>│
       │                       │  6. Rebuild buffer cache  │
       │   { token: NEW,       │                           │
       │     rotatedAt, graceUntil }                       │
       │<──────────────────────│                           │
       │                       │                           │
       │  DollhouseAuth.refresh(NEW)                       │
       │  (in-memory update,   │                           │
       │   no page reload)     │                           │
       │                       │                           │
       │  ── 15s grace ──      │                           │
       │  OLD still accepted   │                           │
       │  ── grace expires ──  │                           │
       │  OLD rejected         │                           │
```

**Endpoint:** `POST /api/console/token/rotate` (always requires auth regardless of `DOLLHOUSE_WEB_AUTH_ENABLED`)

**Request body:**

```json
{ "confirmationCode": "<6-digit TOTP code or backup code>" }
```

**Response (200):**

```json
{
  "token": "a1b2c3d4...64 hex chars...",
  "rotatedAt": "2026-04-05T19:00:00.000Z",
  "graceUntil": 1743879615000
}
```

**Error codes:**

| Code | Status | Meaning |
|---|---|---|
| `MISSING_FIELDS` | 400 | `confirmationCode` not present in request body |
| `INVALID_TOTP_CODE` | 400 | Code did not match the stored secret or any backup code |
| `TOTP_REQUIRED` | 403 | TOTP not enrolled — enroll before rotating |
| `RATE_LIMITED` | 429 | Too many rotation attempts; back off and retry |

**Grace window:** After rotation, the old token continues to authenticate for **15 seconds** so in-flight requests from the rotating tab or other local processes don't fail. After the grace window, only the new token works.

**CLI walkthrough:**

```bash
TOKEN=$(jq -r '.tokens[0].token' ~/.dollhouse/run/console-token.auth.json)
H="Authorization: Bearer $TOKEN"

# Rotate (provide a live TOTP code from your authenticator)
RESULT=$(curl -s -H "$H" -X POST http://localhost:5907/api/console/token/rotate \
  -H 'Content-Type: application/json' -d '{"confirmationCode":"123456"}')
echo "$RESULT" | jq .

# Update your shell variable to the new token
TOKEN=$(echo "$RESULT" | jq -r .token)

# Or re-read from the file (the new value is already persisted)
TOKEN=$(jq -r '.tokens[0].token' ~/.dollhouse/run/console-token.auth.json)
```

**Browser integration:** After the rotation response, the active tab calls `DollhouseAuth.refresh(newToken)` to update the in-memory cache without a page reload. The `graceUntil` field lets the UI display a countdown while the old token is still accepted.

**What changes on disk after rotation:**

- The `token` field in `console-token.auth.json` is updated to the new 64-hex value
- `createdAt` is set to the rotation timestamp
- `createdVia` changes from `"initial-setup"` (or previous value) to `"rotation"`
- `lastUsedAt` is reset to `null`
- The entry `id` and `name` are preserved — the UI identity of the token slot doesn't change

**Security event:** Every rotation emits a `CONSOLE_TOKEN_ROTATED` event (severity `HIGH`) to SecurityMonitor with the token's `id`, rotation timestamp, grace duration, and confirmation method (`totp` or `backup`). No secret material is included in the event payload.

---

## CLI token management

The `dollhouse-console-token` command provides a terminal interface for token operations. All commands support `--json` for scripted consumption.

**Show the current token:**

```bash
# Print the raw token (for piping to clipboard or env vars)
dollhouse-console-token show

# JSON output with metadata
dollhouse-console-token show --json

# Masked (safe for screen sharing)
dollhouse-console-token show --masked
```

**Rotate the token (requires TOTP enrollment):**

```bash
# Interactive — prompts for TOTP code
dollhouse-console-token rotate

# Non-interactive — pass the code directly
dollhouse-console-token rotate --code 123456

# JSON output for scripts
dollhouse-console-token rotate --json --code 123456
```

**Revoke the token (rotate + invalidate all sessions):**

```bash
dollhouse-console-token revoke
dollhouse-console-token revoke --code 123456 --json
```

**Exit codes:**

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | User error (missing file, invalid args) |
| `2` | Auth/confirmation failure (wrong TOTP, not enrolled) |

---

## Security notes

- **Treat the token like an SSH key or API key.** Anyone who holds it has full admin access to the local management API — including the ability to install MCP configs, approve tool permissions, kill sessions, and read all logs on the host.
- **Don't commit `console-token.auth.json` anywhere.** It lives under `~/.dollhouse/` which isn't a git repo by default, but if anyone symlinks or copies that directory, the token goes with it.
- **Don't paste the token into chat, email, or pull request descriptions.** It's localhost-only, but paranoia is cheap.
- **Don't expose port 5907 beyond localhost without TLS.** The binding is still `127.0.0.1` only. Bearer-over-HTTP is fine for localhost but unsafe the moment you change the bind address.
- **If you suspect token compromise, rotate immediately.** Use `dollhouse-console-token rotate` or `POST /api/console/token/rotate` with a TOTP code. If you haven't enrolled TOTP, delete the token file and restart the server as a fallback.

---

## Related

- [External API Access via MCP-AQL adapter](./external-api-access.md) — how external tools and LLMs can consume the DollhouseMCP management API
- [Security architecture](../security/architecture.md#layer-7-oauth--api-security) — where console auth fits in the full threat model
- [Environment variables reference](./environment-variables.md#dollhouse_web_auth_enabled)
