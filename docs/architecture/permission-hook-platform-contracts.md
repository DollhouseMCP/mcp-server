# Permission Hook Platform Contracts

This document is the authoritative contract for DollhouseMCP permission hook output across the supported local clients.

Keep this file in sync with:
- `/Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server/src/handlers/mcp-aql/evaluatePermission.ts`
- `/Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server/scripts/pretooluse-dollhouse.sh`
- `/Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server/tests/unit/di/permissionServerIntegration.test.ts`
- `/Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server/tests/integration/hooks/permission-hook-docker.test.ts`
- `/Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server/tests/integration/mcp-aql/permission-flow-platform-adapters.test.ts`

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
  - JSON-based clients: allow / no-op with empty stdout
  - Windsurf: allow with exit `0`
- Legacy Codex bare `{}` allow responses are normalized into an explicit `hookSpecificOutput.permissionDecision = "allow"` payload for compatibility

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
