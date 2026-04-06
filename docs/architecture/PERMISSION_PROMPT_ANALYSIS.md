# Permission Prompt: Problem Analysis, Architecture, and Remaining Work

> **Issue:** [#1777](https://github.com/DollhouseMCP/mcp-server/issues/1777)
> **Date:** 2026-04-06
> **Status:** Infrastructure built, end-to-end integration incomplete

## The Problem

DollhouseMCP agents cannot run autonomously in Claude Code sessions. When a Claude Code task agent (or sub-agent) attempts to execute a DollhouseMCP agent, it is blocked at the permission layer and falls back to working as raw Claude — bypassing the entire permission architecture.

This was first observed during the Feb 2026 bridge overnight runs and documented as **FM-8** in the bridge failure analysis. The failure has been reproduced in interactive Claude Code sessions as well.

## The Failure Chain

```
1. User activates DollhouseMCP agent elements with gatekeeper policies
2. Claude Code task agent spawns a sub-agent
3. Sub-agent tries to call mcp_aql_execute (to run execute_agent)
4. Claude Code needs permission for this MCP tool call

   ┌─ WALL 1: CLI Permission Layer ─────────────────────────────┐
   │ mcp_aql_execute is not pre-approved in session              │
   │ permissionMode: default requires interactive terminal prompt │
   │ Task agent sub-sessions have no terminal for interactive     │
   │ approval (pipe mode / headless)                              │
   │                                                              │
   │ --permission-prompt-tool should delegate this decision to    │
   │ the bridge-permission-prompt MCP server, but:                │
   │   - Server may not be registered in the session              │
   │   - Server may not be receiving policy exports               │
   │   - Flag may not be passed to sub-agent sessions             │
   │                                                              │
   │ Result: PERMISSION DENIED                                    │
   └──────────────────────────────────────────────────────────────┘

5. mcp_aql_execute call is blocked — execute_agent never runs
6. Sub-agent cannot enter the execution lifecycle at all

   ┌─ WALL 2: Gatekeeper Layer (unreachable) ────────────────────┐
   │ Even if Wall 1 were resolved:                                │
   │ Agent elements without gatekeeper metadata fall through to   │
   │ default CONFIRM_SESSION policy, triggering more confirmation │
   │ prompts for every downstream operation                       │
   │                                                              │
   │ Agents need gatekeeper.allow / gatekeeper.deny sections in   │
   │ their element definitions to pre-authorize operations        │
   └──────────────────────────────────────────────────────────────┘

7. Sub-agent falls back to raw Claude processing
8. Work gets done WITHOUT the permission system:
   - Autonomy Evaluator never runs
   - Pattern matching (requiresApproval/autoApprove) never fires
   - DangerZoneEnforcer is never consulted
   - No audit trail of permission decisions
   - No element policy enforcement
```

## Why This Matters

### Immediate: Agents can't use their own permissions

Users create DollhouseMCP elements with gatekeeper policies that define what agents are authorized to do. When those agents run, the permission system should honor those policies autonomously. Currently it can't — the agent can't even enter the execution lifecycle.

### Strategic: Competitive opportunity

OpenClaw (an agentic third-party tool) has been barred from Anthropic subscription services as of early April 2026. DollhouseMCP runs through sanctioned Anthropic tools (Claude Code, Claude Desktop). Being able to run agents autonomously with proper permission management provides comparable capability within Anthropic's Terms of Service.

## Architecture: How It Should Work

### Claude Code's --permission-prompt-tool flag

When Claude Code needs permission for any tool call (Bash, Edit, Write, MCP tools):

1. Static rules (`--allowedTools`/`--disallowedTools`) are checked first
2. If no static rule matches, Claude Code calls the specified MCP tool
3. The MCP tool returns: `{"behavior": "allow"}` or `{"behavior": "deny", "message": "reason"}`

**Critical constraint:** Claude Code **removes the tool specified by `--permission-prompt-tool` from the deferred tools registry**. The tool still functions for permission decisions, but becomes invisible to `ToolSearch` and unavailable for normal calls.

This means `--permission-prompt-tool` **cannot point at any tool on the main DollhouseMCP server** (e.g., `mcp_aql_execute`), because that would remove the entire Execute endpoint from the session.

### The Two-Server Architecture

```
Claude Code session:
  ├── MCP Server 1: DollhouseMCP (all 5 CRUDE tools, untouched)
  │     └── Server-side evaluation pipeline:
  │           ToolClassification → Element Policies → Risk Assessment
  │
  └── MCP Server 2: bridge-permission-prompt (1 tool: permission_prompt)
        └── --permission-prompt-tool mcp__bridge-permission-prompt__permission_prompt
        └── Loads policies from ~/.dollhouse/bridge/imports/policies/
        └── Calls DollhouseMCP's evaluation pipeline via policy export
```

The bridge-permission-prompt server exists at:
`bridge/bridges/permission-prompt-server/`

### Auto-Dollhouse Fork: evaluate_permission

The auto-dollhouse fork has implemented an alternative/complementary approach:

- `src/auto-dollhouse/evaluatePermission.ts` — Permission evaluation with multi-platform response formatting (Claude Code, Gemini, Cursor, Windsurf, Codex)
- `src/auto-dollhouse/permissionRoutes.ts` — HTTP routes with decision tracking ring buffer
- `src/auto-dollhouse/public/` — Live permissions dashboard
- Activated via `DOLLHOUSE_AUTONOMOUS_MODE` env var or `.auto-dollhouse` marker file
- Includes `evaluate_permission` MCP-AQL operation for DrawingRoom-based permission queries

This work is production-ready with 36+ unit tests and may represent the more complete path forward.

### Server-Side Evaluation Pipeline (Built)

The evaluation pipeline in the main MCP server is fully implemented and tested:

| Stage | What It Does | Status |
|-------|-------------|--------|
| **Stage 1: Static Classification** | Auto-allow safe tools (Read, Grep, Glob), auto-deny dangerous patterns (rm -rf, sudo), classify MCP tools | Built, 69 unit tests |
| **Stage 2: Element Policy Evaluation** | Check active element gatekeeper deny/allow patterns, union semantics | Built, tested |
| **Stage 2.75: CLI Approval Records** | Session-scoped approvals with TTL, LRU eviction, single-use vs session scope | Built, tested |
| **Stage 3: Risk Assessment** | Numeric 0-100 scoring for irreversibility, network ops, credential access | Built, tested |
| **Stage 3.5: LLM Risk Evaluation** | Independent LLM session for goal drift, prompt injection detection | Not built (future) |
| **Stage 4: Decision Routing** | Route to auto-approve, human confirmation, or hard deny | Partially built |

Key files:
- `src/handlers/mcp-aql/policies/ToolClassification.ts` — Classification, risk assessment, element policies
- `src/handlers/mcp-aql/GatekeeperSession.ts` — Approval records, TTL, LRU eviction
- `src/handlers/mcp-aql/MCPAQLHandler.ts` — Handler for all permission operations
- `src/handlers/mcp-aql/Gatekeeper.ts` — Pass-through methods for CLI approvals

## What's Built vs What's Broken

| Component | Status | Notes |
|-----------|--------|-------|
| Server-side evaluation pipeline | **Built, tested** | 44 integration + 69 unit + 10 behavior tests |
| bridge-permission-prompt server | **Built** | At `bridge/bridges/permission-prompt-server/` |
| Auto-dollhouse evaluate_permission | **Built** | Multi-platform, 36+ tests, includes dashboard |
| PolicyExportService | **Built, fragile** | Writes to `~/.dollhouse/bridge/imports/policies/` but fails silently if directory missing, no consumption verification |
| End-to-end: task agent → permission prompt → execute_agent | **Not working** | The actual user-facing flow is broken |
| Agent elements with gatekeeper metadata | **Incomplete** | Most agents lack `gatekeeper` sections in their definitions |

## The Gaps to Close

### Gap 1: --permission-prompt-tool must work in all session types

The bridge-permission-prompt server exists but hasn't been verified working in:
- Interactive Claude Code terminal sessions
- Claude Code task agent sessions (`claude -p`)
- Sub-agent sessions spawned by task agents
- Claude Desktop sessions

Key questions:
- Is the server registered and visible in each session type?
- Is `--permission-prompt-tool` flag being passed through to sub-agents?
- Is the PolicyExportService writing policies and the server reading them?

### Gap 2: Agent elements need gatekeeper policies

For the "activate elements, run agent, permissions just work" flow, agent elements must include `gatekeeper` sections that pre-authorize their expected operations. Without this, every operation falls to default `CONFIRM_SESSION` and requires interactive approval.

### Gap 3: Unify the two permission evaluation paths

There are currently two implementations:
1. **bridge-permission-prompt server** (bridge repo) — standalone Node.js server, policy import from files
2. **auto-dollhouse evaluate_permission** (auto-dollhouse repo) — integrated, multi-platform, dashboard

These need to converge or have a clear handoff so the permission evaluation is consistent regardless of which path is active.

## Prior Documentation (Cross-Repo)

These documents contain detailed context but are scattered across repos:

| Document | Repo | What It Covers |
|----------|------|---------------|
| `FAILURE-ANALYSIS-2026-02-20.md` | bridge | FM-8: Agentic loop not engaged, full failure mode analysis |
| `HANDOFF_2026-02-23_AGENTIC_LOOP_COORDINATION.md` | bridge | Why the agentic loop wasn't working |
| `HANDOFF_2026-02-24_PERMISSION_RELAY.md` | bridge | Permission relay design, FM-8 root cause |
| `endpoint-reroute-execution-lifecycle-2026-02-24.md` | bridge | Why record_execution_step moved to CREATE |
| `PERMISSION-RELAY-REMAINING-WORK.md` | bridge | Outstanding work items for permission relay |
| `AGENTIC-PERMISSION-ARCHITECTURE.md` | bridge | Three-layer enforcement model |
| `HANDOFF_permission-prompt-fix.md` | bridge | Why the separate MCP server was needed |
| `SESSION_2026-03-01_PERMISSION_PROMPT_TOOL.md` | bridge | Claude Code `--permission-prompt-tool` design |
| `HANDOFF_2026-03-02_BRIDGE_PERMISSION_INTEGRATION.md` | mcp-server (v2-refactor) | Bridge integration API contract |
| `Agentic-loop-permission-process-notes.md` | auto-dollhouse | Three enforcement layers when all interactions flow through Dollhouse |

## References

- Claude Code `--permission-prompt-tool`: https://code.claude.com/docs/en/cli-reference
- Claude Code permissions: https://code.claude.com/docs/en/permissions
- Agent SDK `canUseTool` (same protocol): https://platform.claude.com/docs/en/agent-sdk/user-input
- Upstream feature request for serialized permissions: https://github.com/anthropics/claude-code/issues/29382
