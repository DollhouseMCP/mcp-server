# External API Access via MCP-AQL Adapter

> **Status:** Phase 1 covers same-machine consumers. Cross-machine consumers (browser plugins, remote LLMs) require the Phase 2 device pairing flow.

DollhouseMCP's management API on port `41715` is not just for the built-in web console. Any external tool — including a **second LLM with its own MCP server** — can build an adapter that consumes this API under the same Bearer token security model as local DollhouseMCP sessions. This document describes the three access patterns and how to build each.

---

## Why this matters

DollhouseMCP's API exposes a rich set of operations: portfolio browsing, permission evaluation, session management, log streaming, metric collection, element installation. These are powerful capabilities. With the console token auth model (#1780) they become safely available to:

- **Same-machine tools** like auto-dollhouse, the drawing room, Apple Mail integrations, CI scripts, custom dashboards
- **Browser extensions** that use a local LLM to manipulate web pages based on DollhouseMCP personas and skills (real commercial use case)
- **Remote LLMs** running on a different machine, connecting to your local DollhouseMCP for portfolio access and policy evaluation
- **Enterprise deployments** where a central DollhouseMCP serves department-scoped elements to many workstations

The common thread: these are all consumers of the management API, not replacements for it. The Bearer token is the hand-off.

---

## Pattern 1 — Same-machine consumer (file read)

**Use case:** Any process running on the same machine as DollhouseMCP, under the same OS user, can read the token file directly.

**Examples:** auto-dollhouse, drawing room, shell scripts, local monitoring agents, custom dashboards, same-machine MCP-AQL adapters.

**How:**

1. Read the token from `~/.dollhouse/run/console-token.auth.json`
2. Attach it as `Authorization: Bearer <token>` on every request
3. Call the API

**Minimal Node.js adapter example:**

```typescript
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function getConsoleToken(): Promise<string | null> {
  try {
    const content = await readFile(
      join(homedir(), '.dollhouse', 'run', 'console-token.auth.json'),
      'utf8',
    );
    const parsed = JSON.parse(content);
    return parsed.tokens?.[0]?.token ?? null;
  } catch {
    return null;
  }
}

async function dollhouseFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getConsoleToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`http://127.0.0.1:41715${path}`, { ...init, headers });
}

// Usage
const res = await dollhouseFetch('/api/elements');
const portfolio = await res.json();
console.log(`Found ${portfolio.totalCount} elements`);
```

**Shell equivalent:**

```bash
TOKEN=$(jq -r '.tokens[0].token' ~/.dollhouse/run/console-token.auth.json)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:41715/api/elements
```

**MCP-AQL adapter pattern:** If you're exposing DollhouseMCP capabilities to a different LLM via its own MCP server, wrap each DollhouseMCP endpoint you want to expose as an MCP tool in your adapter:

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

const server = new Server({ name: 'dollhouse-bridge', version: '1.0.0' }, {
  capabilities: { tools: {} },
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_portfolio_elements',
      description: 'List DollhouseMCP portfolio elements by type',
      inputSchema: { type: 'object', properties: { type: { type: 'string' } } },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'list_portfolio_elements') {
    const res = await dollhouseFetch(`/api/elements/${request.params.arguments.type}`);
    return { content: [{ type: 'text', text: await res.text() }] };
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});
```

Now a different LLM that loads this MCP server can call DollhouseMCP operations transparently — it doesn't even need to know DollhouseMCP exists, and it never sees the token.

---

## Pattern 2 — Same-machine browser consumer (meta tag)

**Use case:** A web page served by DollhouseMCP itself.

**Examples:** The built-in management console, user-created dashboards under `~/.dollhouse/pages/`, custom plugins loaded into the SPA.

**How:**

The server injects the token into `index.html` via a meta tag at request time:

```html
<meta name="dollhouse-console-token" content="abcdef0123456789...">
```

Client-side JavaScript reads the tag and uses the `DollhouseAuth` helper:

```javascript
// Attached by consoleAuth.js on every page
window.DollhouseAuth.apiFetch('/api/elements').then(r => r.json());
window.DollhouseAuth.apiEventSource('/api/logs/stream').onmessage = (e) => { /* ... */ };
```

**Never** store the token in `localStorage` or cookies — it's re-read from the freshly rendered HTML on every page load, which means rotation (Phase 2) automatically propagates on reload.

---

## Pattern 3 — Cross-machine consumer (device pairing, Phase 2)

**Use case:** A consumer that cannot read the token file because it runs in a different security context — a browser extension, a mobile app, a remote LLM on another machine, a containerized sidecar.

**Examples (planned product directions):**

- **Browser extension for DOM manipulation**: User installs a browser extension that uses an LLM to rewrite page content to match their preferences. The extension needs access to DollhouseMCP's personas and skills, but runs in the browser sandbox with no filesystem access.
- **Remote LLM with MCP server**: User runs an LLM on a separate machine (cloud, workstation at home, etc.) that needs to query their local DollhouseMCP portfolio. The remote LLM's MCP server includes a DollhouseMCP adapter that authenticates over the network.
- **Zulip bot**: A Zulip bot on a remote machine wants to consult the DollhouseMCP permission engine before executing a tool call on behalf of a user.

### Device pairing flow (not yet implemented)

Phase 2 will introduce a pairing flow in the Security tab of the web console:

1. User clicks "Pair device" and enters a friendly name (e.g. "my-browser-extension", "home-laptop-zulip-bot").
2. Server displays a 6-digit code and a QR code containing the code.
3. External device enters or scans the code, sends it to the DollhouseMCP host along with its own device identifier.
4. Server verifies the code, generates a **new scoped token** specifically for that device, and returns it.
5. External device stores the token in its own secure storage (extension storage, keychain, encrypted config, etc.).
6. Every subsequent request attaches that token as Bearer.

### Scoped tokens

Unlike the "admin" console token, device-paired tokens can be given restricted scopes:

- `read:elements` — list and fetch portfolio elements
- `read:logs` — subscribe to log streams
- `read:metrics` — subscribe to metrics streams
- `evaluate:permission` — call the permission evaluation endpoint
- `install:elements` — install collection elements
- `admin:sessions` — manage session lifecycle
- Custom scope patterns defined by enterprise deployments

A browser extension that only needs to display portfolio elements would receive a token with only `read:elements`, eliminating the risk that a compromised extension could install rogue content or kill sessions.

### Device management

The Security tab will list all paired devices with:

- Device name and type
- Last-used timestamp
- Scopes granted
- "Revoke" button (immediately invalidates that specific token without touching others)

Each paired device is a separate entry in `console-token.auth.json`, independent of the primary console token. Revoking one device has no effect on the others.

---

## Enterprise deployment considerations

For a large engineering organization running DollhouseMCP across many workstations:

- **Central token provisioning**: Tokens can be pre-seeded into `console-token.auth.json` by an MDM system or secrets manager. The schema supports multiple entries from day one.
- **Scopes and element boundaries**: Department-specific tokens can be limited to certain element categories (e.g. `allowCategories: ["eng-platform"]`, `denyCategories: ["hr", "legal"]`). Phase 3 enforces this in the API layer automatically.
- **Tenant isolation**: The `tenant` field on each token lets a single DollhouseMCP instance serve multiple isolated contexts (company vs. personal, engineering vs. design). Phase 3 flows this through all query operations.
- **Audit**: Every token carries a `labels` field for enterprise metadata (cost center, approved-by, department). Query the `lastUsedAt` field to identify dormant tokens ripe for revocation.
- **Cross-platform portability**: The same token can be used from Claude Desktop, Claude Code, Cursor, Windsurf, or any other MCP client that supports DollhouseMCP — the adapter pattern is platform-agnostic.

---

## Security model

**What holding a console token gives you (Phase 1):**

- Full admin access to the DollhouseMCP management API on the host that issued it
- Ability to list, read, install, and (with Phase 2 rotation) rotate the token
- Access to all logs, metrics, session information, permission decisions
- Ability to approve/deny tool permission requests on behalf of the user
- Ability to install MCP configs into client apps (Claude, Cursor, etc.)
- Ability to kill other sessions

**What a token does *not* grant:**

- Access to any DollhouseMCP instance on a different machine (each machine has its own token)
- Code execution on the host (the API is scoped to portfolio and policy operations)
- Access to your OS credentials, SSH keys, or any resources outside `~/.dollhouse/`

**Threat model:**

- **Localhost binding** is the first line of defense — port 41715 is not reachable from the network.
- **Bearer token** is the second line — requires knowledge of the token to make API calls.
- **File permissions (0600)** on `console-token.auth.json` prevent other local users from reading it.
- **TOTP-protected rotation** (Phase 2) prevents a leaked token from being used to lock out the legitimate user.
- **TLS** (Phase 3) adds a third line of defense if you ever need to bind beyond localhost.

---

## Related

- [Console Authentication guide](./console-auth.md) — end-user-facing documentation on the token file and environment flags
- [Security architecture](../security/architecture.md) — full defense-in-depth model
- Issue [#1780](https://github.com/DollhouseMCP/mcp-server/issues/1780) — the original motivation and rollout plan
