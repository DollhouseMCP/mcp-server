# Cloudflare Alpha OAuth/MCP Client Smoke Test

Repeatable operator checklist for validating that a Cloudflare-fronted hosted
DollhouseMCP alpha deployment works with a real streamable HTTP MCP client.

This is the client-level follow-up to the deploy helper's endpoint checks. The
helper can verify `/healthz`, `/readyz`, and unauthenticated `/mcp`; this smoke
test verifies OAuth discovery, GitHub sign-in, Dollhouse client consent, bearer
token use, and a basic MCP request through the Cloudflare edge.

Issue: [#2260](https://github.com/DollhouseMCP/mcp-server/issues/2260)

## When To Run

Run this after:

- a hosted alpha deployment or update
- Cloudflare DNS, WAF, rate-limit, bot, or cache rule changes
- GitHub OAuth app credential or callback changes
- auth allowlist, DCR, consent page, or token handling changes
- any change that touches streamable HTTP transport, Caddy, or hosted deploy
  rendering

## Test Target

Alpha target:

```text
Base URL: https://mcp.dollhousemcp.com
MCP URL:  https://mcp.dollhousemcp.com/mcp
```

For another Cloudflare-fronted deployment, replace the base URL throughout.

## Preconditions

- The deployment is on the hosted HTTP integration branch/ref under test.
- DNS for the hostname is proxied through Cloudflare.
- Direct origin access is blocked or otherwise not a valid public path.
- The GitHub OAuth app callback URL is:

  ```text
  https://mcp.dollhousemcp.com/auth/social/github/callback
  ```

- `DOLLHOUSE_PUBLIC_BASE_URL` matches the public HTTPS origin exactly:

  ```text
  https://mcp.dollhousemcp.com
  ```

- `DOLLHOUSE_AUTH_PROVIDER=embedded`.
- `DOLLHOUSE_AUTH_METHODS` includes `github`.
- `DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED=true`.
- The tester's GitHub identity is either the bootstrapped admin or present in
  the allowlist.
- `DOLLHOUSE_AUTH_OPEN_DCR=true` for alpha clients that rely on Dynamic Client
  Registration.
- Cloudflare WAF/rate-limit rules allow legitimate requests to:

  ```text
  /.well-known/*
  /reg
  /auth
  /token
  /interaction/*
  /auth/social/github/callback
  /mcp
  ```

  `/auth` is the OAuth authorization endpoint advertised by discovery metadata.
  GitHub-specific callback traffic still returns through `/auth/social/github/callback`.

## 1. Endpoint Preflight

Run these before opening a real MCP client. They are intentionally boring; if
one fails, fix that before testing OAuth.

```bash
BASE_URL=https://mcp.dollhousemcp.com

curl -fsS "${BASE_URL}/healthz" | jq
curl -fsS "${BASE_URL}/readyz" | jq
curl -fsS "${BASE_URL}/.well-known/oauth-authorization-server" | jq
curl -fsS "${BASE_URL}/.well-known/oauth-protected-resource" | jq
curl -i -sS "${BASE_URL}/mcp" -o /tmp/dollhouse-mcp-unauth.body
```

Expected:

| Check | Expected result |
|---|---|
| `/healthz` | HTTP 200, `ok: true`, `transport: "streamable-http"` |
| `/readyz` | HTTP 200 after bootstrap is complete |
| `/.well-known/oauth-authorization-server` | HTTP 200, issuer is the public base URL |
| `/.well-known/oauth-protected-resource` | HTTP 200, metadata points clients at the authorization server |
| unauthenticated `/mcp` | HTTP 401 with `WWW-Authenticate: Bearer resource_metadata="..."` |

If `/readyz` returns `503` with `bootstrap_required`, run `bootstrap-admin` and
repeat the preflight. If `/mcp` returns `200` without a bearer token, stop; auth
is not protecting the MCP endpoint.

The hosted helper covers the first, second, and fifth checks:

```bash
DOLLHOUSE_PUBLIC_BASE_URL="${BASE_URL}" npm run hosted:deploy -- verify
```

## 2. Direct-Origin Check

Confirm the Cloudflare hostname is the supported public path and that clients
are not accidentally bypassing the edge.

Use the current origin IP from the deployment inventory or VPS dashboard:

```bash
ORIGIN_IP=203.0.113.10
HOSTNAME=mcp.dollhousemcp.com

curl -k -i --resolve "${HOSTNAME}:443:${ORIGIN_IP}" \
  "https://${HOSTNAME}/healthz"
```

Expected:

- timeout, connection refused, 403, or another deliberate block
- not the same successful Cloudflare-fronted response path as normal public
  traffic

If the direct origin succeeds, verify host firewall rules, Cloudflare origin
lockdown, and any temporary debug ports before inviting external testers.

## 3. Real MCP Client OAuth Flow

Known alpha path: Claude.ai custom connector using the streamable HTTP MCP URL.
The same expected states apply to any client that supports streamable HTTP MCP
and OAuth discovery.

Use a clean client state when possible:

- disconnect any previous Dollhouse Alpha connector
- start a fresh browser profile or private window if the previous OAuth flow
  failed midway
- do not reuse an old interaction or callback URL

Client configuration:

```text
Name: Dollhouse Alpha Test
URL:  https://mcp.dollhousemcp.com/mcp
```

Expected flow:

1. The client probes `/mcp` and receives HTTP 401 with OAuth resource metadata.
2. The client reads OAuth discovery from `/.well-known/oauth-authorization-server`.
3. If the client uses DCR, it registers a client successfully through `/reg`.
4. The browser is redirected into GitHub OAuth unless an existing GitHub session
   can be reused.
5. GitHub redirects back to `/auth/social/github/callback`.
6. Dollhouse shows its own client consent page, for example "Authorize Claude".
7. Click the consent button once and wait for the redirect to complete.
8. The client returns to its UI and reports the server as connected.

Notes:

- Seeing GitHub only on the first run is normal if the browser keeps a valid
  GitHub session.
- Seeing the Dollhouse consent page after GitHub is expected. GitHub authenticates
  the user; Dollhouse authorizes the MCP client.
- If the consent button appears to do nothing, do not repeatedly click it. Check
  server logs, then restart the connector flow from a fresh client state.

## 4. Basic MCP Request Flow

Once the client says it is connected, run two read-only checks.

Natural-language prompt:

```text
Use DollhouseMCP to read build info with the get_build_info operation, then list available personas.
```

Raw MCP-AQL shape, if the client exposes tool arguments:

```text
mcp_aql_read { "operation": "get_build_info" }
```

```text
mcp_aql_read { "operation": "list_elements", "element_type": "personas" }
```

Expected:

- The client can call `mcp_aql_read`.
- `get_build_info` returns version/build/runtime metadata.
- `list_elements` returns persona records or an empty-but-successful list for a
  deliberately empty portfolio.
- No OAuth re-prompt occurs during these read calls.
- No Cloudflare challenge, CAPTCHA, or rate-limit page appears in the client.

## 5. Logs And Cloudflare Inspection

Capture the timestamp window around the test before logs roll.

On the VPS:

```bash
cd /opt/dollhousemcp

docker compose --project-name dollhousemcp \
  --env-file .env.production \
  -f compose.yml \
  logs --since 20m --tail 300 dollhousemcp caddy
```

Look for:

- OAuth discovery, authorize, callback, token, and MCP requests in the expected
  order
- Caddy access logs with `code`, `state`, `token`, `access_token`,
  `refresh_token`, `client_secret`, and `invite` values redacted
- no raw bearer tokens, GitHub OAuth codes, or client secrets in logs
- no unexpected 429, 403, 500, or 502 responses during the flow

In Cloudflare:

- Security Events: confirm no WAF rule blocked legitimate OAuth, DCR, callback,
  token, or `/mcp` traffic
- Analytics: inspect 4xx/5xx spikes for the test window
- Rate limiting: confirm the real client did not trigger a rule while opening a
  streamable HTTP session
- Cache rules: confirm auth, token, callback, interaction, and MCP paths are not
  cached

## 6. Pass Criteria

The smoke test passes when:

- endpoint preflight matches expected HTTP behavior
- direct origin access is blocked or intentionally unavailable
- a real streamable HTTP MCP client completes OAuth and consent through
  Cloudflare
- the client successfully calls `get_build_info`
- the client successfully performs at least one additional read operation
- no secrets appear in Caddy/app logs
- Cloudflare did not block, challenge, cache, or rate-limit legitimate client
  traffic

## 7. Common Failure Modes

| Symptom | Likely cause | First place to check |
|---|---|---|
| `/readyz` returns `bootstrap_required` | first admin not bootstrapped, or bootstrap wrote to the wrong auth store | `bootstrap-admin`, `.env.production`, app logs |
| Client never reaches GitHub | OAuth discovery, DCR, or WAF blocking `/.well-known/*`, `/reg`, or `/auth` | browser network log, Cloudflare Security Events, Caddy logs |
| GitHub callback returns `github_callback_failed` | wrong GitHub client ID/secret or callback URL | GitHub OAuth app settings, app logs |
| Consent page returns `invalid_interaction` | stale interaction URL, expired session, or repeated old callback | restart the client flow from a fresh browser/client state |
| Consent click appears to do nothing | client/browser state is stale or backend returned an error not visible in the page | app logs, browser devtools, repeat from clean state |
| Client says connected but MCP calls 401 | bearer token not stored/sent, token expired, or issuer/public URL mismatch | client logs, `/token` response, `DOLLHOUSE_PUBLIC_BASE_URL` |
| Client hits 403/429 only through Cloudflare | WAF, bot, cache, or rate-limit false positive | Cloudflare Security Events and rate-limit logs |
| OAuth works but admin surfaces deny access | user authenticated but is not the bootstrapped/admin identity | allowlist/admin bootstrap state, web console admin surfaces, app logs |
| Direct origin succeeds | origin firewall or Cloudflare-origin lockdown missing | VPS firewall, provider firewall, Cloudflare DNS/proxy mode |

## 8. Test Record Template

Copy this into the deployment notes or the issue/PR that triggered the smoke
test.

```text
Date/time UTC:
Operator:
Deployment ref:
Hostname:
Client tested:
Tester GitHub identity:

Endpoint preflight:
- /healthz:
- /readyz:
- /.well-known/oauth-authorization-server:
- /.well-known/oauth-protected-resource:
- unauthenticated /mcp:
- direct-origin check:

OAuth/client flow:
- DCR/discovery:
- GitHub sign-in:
- Dollhouse consent:
- Client connected:
- get_build_info:
- list personas/read operation:

Cloudflare/log review:
- WAF/rate-limit events:
- 4xx/5xx anomalies:
- secret redaction verified:

Follow-up issues created:
```

Create a GitHub issue for any failed item that is not an operator setup mistake.
Label it with the relevant area (`area: security`, `area: testing`, `oauth`, or
hosted deployment labels as appropriate) and link it back to
[#2260](https://github.com/DollhouseMCP/mcp-server/issues/2260).
