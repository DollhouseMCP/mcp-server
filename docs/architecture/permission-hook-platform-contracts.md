# Permission Hook Platform Contracts

This document is the authoritative contract for DollhouseMCP permission hook output across the supported local clients.

Keep this file in sync with:
- `src/handlers/mcp-aql/evaluatePermission.ts`
- `scripts/pretooluse-dollhouse.sh`
- `tests/unit/di/permissionServerIntegration.test.ts`
- `tests/integration/hooks/permission-hook-docker.test.ts`
- `tests/integration/mcp-aql/permission-flow-platform-adapters.test.ts`

## Principles

- Every supported hook client has one explicit, documented stdout contract.
- Shared shell wrappers may normalize server output, but they must not invent undocumented fail-open shapes.
- If a client expects structured JSON, DollhouseMCP should emit that structure explicitly for both allow and deny paths.
- Windsurf is the exception: its hook contract is exit-code based instead of stdout-JSON based.
- Hook installation assets must point each client to the wrapper script that matches its contract.

## Contract Matrix

| Client | Installed hook script | Permission platform id | Expected hook result |
| --- | --- | --- | --- |
| Claude Code | `pretooluse-dollhouse.sh` | `claude_code` | JSON on stdout: `hookSpecificOutput.hookEventName = "PreToolUse"`, `permissionDecision = "allow" | "deny" | "ask"` |
| Codex | `pretooluse-codex.sh` | `codex` | JSON on stdout: `hookSpecificOutput.hookEventName = "PreToolUse"`, `permissionDecision = "allow" | "deny"`, `permissionDecisionReason` optional but emitted as `""` on allow |
| Cursor | `pretooluse-cursor.sh` | `cursor` | JSON on stdout: `{ permission: "allow" | "deny" | "ask", reason? }` |
| VS Code / Copilot | `pretooluse-vscode.sh` | `vscode` | JSON on stdout: Claude-compatible `hookSpecificOutput` payload |
| Gemini CLI | `pretooluse-gemini.sh` | `gemini` | JSON on stdout: `{ decision: "allow" | "deny", reason? }` |
| Windsurf | `pretooluse-windsurf.sh` | `windsurf` | Exit `0` to allow, exit `2` to block; denial reason goes to stderr |

## Input Normalization

The wrappers normalize each client's native payload into the shared `/api/evaluate_permission` request shape:

```json
{
  "tool_name": "Bash",
  "input": { "command": "git status" },
  "platform": "cursor",
  "session_id": "optional"
}
```

Client-specific normalization includes:
- VS Code: converts `runTerminalCommand` and related names into `Bash`
- Windsurf: converts `pre_run_command` and `pre_mcp_tool_use` events into standard `tool_name` + `input`
- Codex/Cursor/Gemini wrappers: primarily set the platform id and delegate to the shared shell bridge

## Fail-Open Rules

- Missing permission server port file: allow / no-op
- Connection failure or timeout: allow / no-op
- Malformed server response:
  - JSON-based clients: allow with an explicit valid allow payload for that platform
  - Windsurf: allow with exit `0`
- Legacy Codex bare `{}` allow responses are normalized into an explicit `hookSpecificOutput.permissionDecision = "allow"` payload for compatibility

## Runtime Configuration Bounds

The shared shell configuration helper (`scripts/permission-hook-config.sh`) validates the runtime tuning knobs before any wrapper uses them:

| Variable | Default | Minimum | Maximum | Notes |
| --- | --- | --- | --- | --- |
| `DOLLHOUSE_HOOK_AUTHORITY_CACHE_TTL_SECONDS` | `2` | `0` | `30` | Controls how long hook wrappers reuse the authority-mode cache before rereading `permission-authority.json` |
| `DOLLHOUSE_HOOK_MAX_RETRIES` | `2` | `0` | `5` | Caps transient retry loops for the HTTP permission call |
| `DOLLHOUSE_HOOK_INITIAL_TIMEOUT` | `5` | `1` | `30` | Initial curl timeout in seconds before exponential backoff doubles it |

Invalid or out-of-range values are clamped or reset to safe defaults so local overrides cannot accidentally produce malformed fail-open behavior.

## Platform-Specific Behavior Notes

- Claude Code, Codex, and VS Code all require structured JSON on stdout even when the hook is failing open.
- Cursor and Gemini CLI preserve their native stdout contracts, but still pass through the shared port discovery and HTTP retry logic.
- Windsurf is intentionally different: it never emits a JSON allow/deny envelope. It returns exit code `0` to allow and `2` to block.
- Startup hook asset repair runs sequentially because several hosts share `~/.dollhouse/hooks/pretooluse-dollhouse.sh` and `permission-port-discovery.sh`; concurrent rewrites were flaky on Windows.
- Startup repair results are surfaced through:
  - `get_build_info`
  - `/api/permissions/status`
  - `/api/health`

## Example Payloads

### Claude Code / VS Code allow

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow"
  }
}
```

### Claude Code / VS Code deny

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Command blocked by active Dollhouse policy."
  }
}
```

### Codex allow

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": ""
  }
}
```

### Codex deny

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Command blocked by active Dollhouse policy."
  }
}
```

### Cursor allow

```json
{
  "permission": "allow"
}
```

### Cursor deny

```json
{
  "permission": "deny",
  "reason": "Command blocked by active Dollhouse policy."
}
```

### Gemini CLI allow

```json
{
  "decision": "allow"
}
```

### Gemini CLI deny

```json
{
  "decision": "deny",
  "reason": "Command blocked by active Dollhouse policy."
}
```

## Verification Matrix

- Direct shell execution coverage:
  - `tests/unit/di/permissionServerIntegration.test.ts`
- Adapter-level formatter coverage:
  - `tests/integration/mcp-aql/permission-flow-platform-adapters.test.ts`
- Dockerized wrapper coverage:
  - `tests/integration/hooks/permission-hook-docker.test.ts`
- Install/entrypoint wiring coverage:
  - `tests/unit/utils/permissionHooks.test.ts`

## Release Checklist

Before changing a hook contract:
- update this document first
- update `evaluatePermission.ts` and any wrapper scripts
- update the direct shell tests
- update the adapter tests
- update the Docker hook tests if the platform is covered there
- confirm the install-hook tests still point the client at the correct wrapper script
