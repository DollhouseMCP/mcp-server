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
- Shared shell wrappers normalize server output to the installed host's hook contract.
- If a client expects structured JSON, DollhouseMCP should emit that structure explicitly for supported decision paths.
- Windsurf is the exception: its hook contract is exit-code based instead of stdout-JSON based.
- Hook installation assets must point each client to the wrapper script that matches its contract.

## Contract Matrix

| Client | Installed hook script | Permission platform id | Expected hook result |
| --- | --- | --- | --- |
| Claude Code | `pretooluse-dollhouse.sh` | `claude_code` | JSON on stdout: `hookSpecificOutput.hookEventName = "PreToolUse"`, `permissionDecision = "allow" | "deny" | "ask"` |
| Codex | `pretooluse-codex.sh` | `codex` | Allow: exit `0` with zero stdout bytes. Deny: JSON on stdout: `hookSpecificOutput.hookEventName = "PreToolUse"`, `permissionDecision = "deny"`, `permissionDecisionReason` optional |
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
  "session_id": "optional",
  "cwd": "optional"
}
```

`cwd` is forwarded verbatim when the client supplies it. The ownership policy
(below) uses it so `gh` can infer the repository and current branch.

Client-specific normalization includes:
- VS Code: converts `runTerminalCommand` and related names into `Bash`
- Windsurf: converts `pre_run_command` and `pre_mcp_tool_use` events into standard `tool_name` + `input`
- Codex/Cursor/Gemini wrappers: primarily set the platform id and delegate to the shared shell bridge

## Ownership Policy Stage

Issue #3153 adds an authorship-aware stage between static classification and
element policies, applied identically to `evaluate_permission` (hooks) and
`permission_prompt` (`--permission-prompt-tool`):

- Detected mutations: `gh pr merge|update-branch|edit|close|ready|reopen|lock|unlock`,
  `gh issue edit|close|reopen|delete|transfer|lock|unlock|pin|unpin`, mutating
  `gh api` calls on `repos/*/pulls/N` or `repos/*/issues/N`, `git push` to a
  branch that is the head of an open PR, GitHub MCP write tools
  (`merge_pull_request`, `update_pull_request`, `update_pull_request_branch`,
  `update_issue`, `push_files`, ...) and Dollhouse `integration_request`
  writes to the same REST paths.
- Not detected (always pass this stage): views, diffs, checks, comments and
  reviews on any PR or issue.
- Ownership is resolved once per explicit target per session through the
  operator's own `gh` authentication and cached; current-branch lookups are
  never cached because a checkout can change what "current" means.
- Decision: author is the configured owner or a listed teammate → pass;
  otherwise `DOLLHOUSE_GITHUB_OWNERSHIP_POLICY` decides (`confirm` → `ask`,
  `deny` → `deny`). A failed lookup, an unknown owner identity or an
  unidentifiable target always yields `ask` (fail closed). An element
  `denyPatterns` match still wins over an ownership `ask`.

## Outage Behavior

Missing port discovery, malformed hook input, exhausted connection retries,
unexpected HTTP replies, and responses with `{"status":"outage"}` all use the
same outage rules.

| Client or hook event | High risk or unclassifiable | Low risk or authority off |
| --- | --- | --- |
| Claude Code and VS Code | `hookSpecificOutput.permissionDecision: "ask"` | No output |
| Cursor `preToolUse` | `permission: "deny"` with `user_message` | No output |
| Cursor `beforeShellExecution` and `beforeMCPExecution` | `permission: "ask"` with `user_message` | No output |
| Codex | `hookSpecificOutput.permissionDecision: "deny"` | No output |
| Gemini CLI | `decision: "deny"` with `reason` | No output |
| Windsurf | Exit `2` with the reason on stderr | Exit `0`, no output |

Codex, Gemini CLI, Windsurf, and Cursor's installed `preToolUse` event cannot
require a native prompt. Their hooks block a high-risk operation during an
outage. Cursor's dedicated shell and MCP events can request a prompt when those
events are configured.

The first high-risk call in an outage shows the failure and recovery steps.
The warning distinguishes a missing port or refused connection from a
timeout. A `session_unavailable` warning points to hook authentication, and
hook input errors give configuration advice without using the outage warning
marker. Later calls show the short reason. A valid evaluation clears the marker.

The default high-risk tools include Bash, PowerShell, Monitor, Write, Edit,
MultiEdit, NotebookEdit, WebFetch, and Cursor Delete. Native names such as
Gemini's `run_shell_command` use their equivalent tool's classification. An
unidentifiable call uses the high-risk outcome.

During an outage, MCP calls are high-risk unless their tool name starts with
a whole read-only verb (`get`, `list`, `read`, `search`, `find`, `view`,
`describe`, or `status`) and contains no write, execute, or joining word.
The hook checks whole words separated by underscores, hyphens, periods,
colons, slashes, or camel case. For example, `get_settings` defers, while
`get_or_create_issue` is high-risk. `query` is high-risk. The explicit
`fetch-without-side-effects` name also defers. Classification uses the tool
portion of both `mcp__server__tool` and Cursor `MCP:tool` names.

`DOLLHOUSE_HOOK_OUTAGE_HIGH_RISK_TOOLS` overrides the space-separated
high-risk tools. `DOLLHOUSE_HOOK_OUTAGE_MCP_READ_ONLY_PATTERN` overrides the
Bash extended regular expression for a leading read-only word. The existing
`DOLLHOUSE_HOOK_OUTAGE_MCP_HIGH_RISK_PATTERN` can promote an MCP call to
high risk. Matching ignores case. Empty values use the defaults, and an
invalid expression keeps MCP calls high-risk.

## Runtime Configuration Bounds

The shared shell configuration helper (`scripts/permission-hook-config.sh`) validates the runtime tuning knobs before any wrapper uses them:

| Variable | Default | Minimum | Maximum | Notes |
| --- | --- | --- | --- | --- |
| `DOLLHOUSE_HOOK_AUTHORITY_CACHE_TTL_SECONDS` | `2` | `0` | `30` | Controls how long hook wrappers reuse the authority-mode cache before rereading `permission-authority.json` |
| `DOLLHOUSE_HOOK_MAX_RETRIES` | `2` | `0` | `5` | Caps transient retry loops for the HTTP permission call |
| `DOLLHOUSE_HOOK_INITIAL_TIMEOUT` | `5` | `1` | `30` | Initial curl timeout in seconds before exponential backoff doubles it |
| `DOLLHOUSE_HOOK_REQUEST_BUDGET_SECONDS` | `15` | `1` | `20` | Total network retry budget in seconds, including backoff |

Invalid or out-of-range values are clamped or reset to the defaults.
Each attempt is capped at the time remaining in the budget. Keeping the budget
below the host's hook timeout leaves time to emit the outage decision.

## Platform-Specific Behavior Notes

- Codex `PreToolUse` currently supports deny/block only; explicit `permissionDecision: "allow"` and `"ask"` are parsed by Codex but not supported, so DollhouseMCP leaves the allow path as zero stdout bytes.
- Codex allow/no-op tests must assert exact empty stdout, not `trim() === ""`, because even a lone newline is still hook output.
- All platform wrappers use the shared port discovery, HTTP retry, and outage logic.
- Windsurf is intentionally different: it never emits a JSON allow/deny envelope. It returns exit code `0` to allow and `2` to block.
- Startup hook asset repair runs sequentially because several hosts share `~/.dollhouse/hooks/pretooluse-dollhouse.sh` and `permission-port-discovery.sh`; concurrent rewrites were flaky on Windows.
- Startup repair results are surfaced through:
  - `get_build_info`
  - `/api/permissions/status`
  - `/api/health`
- Shared hook diagnostics are appended to `~/.dollhouse/run/permission-hook-diagnostics.jsonl`, and the latest record is surfaced through the same runtime health/status endpoints. The JSONL record includes raw input, normalized/emitted response lengths, retry data, and the final stage so silent Codex allow paths are still inspectable.

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

Codex `PreToolUse` allow is a zero-byte stdout success path:

```text
[no stdout]
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
