# Remote Agent Approval Pattern

## Overview

When a Dollhouse agent runs on a remote or external interface (chat platforms, API gateways, headless sessions), the user may not be physically present at the terminal where the agent executes. Permission requests must reach the user through the same channel the agent communicates on.

This document describes the **Remote Agent Approval Pattern** — a universal protocol for forwarding DollhouseMCP Gatekeeper approval requests to any external interface. This is not specific to any single platform; it applies to any system where a Dollhouse agent operates through an external communication channel.

---

## The Problem

DollhouseMCP has a multi-layer permission architecture:

1. **Gatekeeper** — gates MCP operations with `confirm_operation` flow
2. **Autonomy Evaluator** — evaluates agent action hints through a 5-stage pipeline
3. **DangerZoneEnforcer** — hard-blocks agents for dangerous actions

When an agent runs interactively in a terminal, Gatekeeper `confirm_operation` requests appear as prompts the user can immediately respond to. But when the agent runs remotely (e.g., monitoring a chat platform, responding to API requests, running in a headless session), those prompts have no audience.

The Remote Agent Approval Pattern solves this by making the agent responsible for forwarding approval requests through its communication channel.

---

## The Pattern

### 1. Gatekeeper Approval Forwarding

When an MCP operation returns a `confirm_operation` needed response, the agent:

1. **Detects** the confirmation requirement from the MCP response:
   ```
   "Operation requires user confirmation. Use confirm_operation with
   params { operation: "<op>", element_type: "<type>" } to approve."
   ```

2. **Forwards** the request to the external interface with enough context for the user to make an informed decision:
   ```
   [approval-needed] <operation> on <element>: <what and why>
   ```

3. **Polls** the external interface for the user's response, verifying identity through platform-native mechanisms (e.g., verified sender email, authenticated API caller)

4. **On approval**: Calls `confirm_operation` via `mcp_aql_execute` and retries the original operation

5. **On denial**: Logs the denial and continues normal operation

### 2. Self-Gating for Non-MCP Actions

The Gatekeeper only gates MCP operations. Agents also use platform-native tools (shell commands, file writes, API calls) that the Gatekeeper cannot intercept. For these, the agent implements **behavioral self-gating**:

1. **Before** any external-facing action, the agent announces its intent on the communication channel:
   ```
   [action-approval] I need to <action description>. Approve?
   ```

2. **Waits** for explicit approval from an authorized user

3. **Executes** only after approval

This is behavioral enforcement — the agent voluntarily gates its own actions based on its instructions. It complements the Gatekeeper's technical enforcement.

### 3. Next Action Hint Integration

The `nextActionHint` field in `record_execution_step` connects self-gating to the Autonomy Evaluator:

```
Agent plans action → reports via nextActionHint
    → Autonomy Evaluator assesses risk
    → If requires approval: agent forwards to external interface
    → User approves/denies on external interface
    → Agent proceeds or skips
```

The Autonomy Evaluator's pattern matching (`requiresApproval`, `autoApprove` glob lists) determines which actions need approval. The agent's self-gating instructions should align with these patterns.

---

## Agent Definition Requirements

For the Remote Agent Approval Pattern to work correctly, agent definitions must include:

### In the Agent's Steps

```yaml
steps:
  - <normal operation steps>
  - Call record_execution_step via mcp_aql_execute to report cycle results
  - If Gatekeeper returns confirm_operation needed, follow Approval Forwarding Protocol
  - <continue normal operation>
```

### In the Agent's Instructions

The agent's behavioral instructions must explicitly describe:

1. **How to detect** a Gatekeeper confirmation requirement (the error message format)
2. **How to format** the approval request for the external interface
3. **How to verify** the approver's identity (platform-specific authentication)
4. **How to handle** approval vs denial
5. **What actions require self-gating** (external-facing actions not covered by Gatekeeper)
6. **What actions are routine** and do not need approval

### Example: Approval Forwarding in Agent Instructions

```markdown
## Approval Forwarding Protocol

When any MCP operation returns a response indicating confirmation is needed:

1. Extract the operation description and what is being requested
2. Write an approval request to the communication channel:
   "[approval-needed] <description of what needs approval and why>"
3. Poll for a response from an authorized user
   (verify identity by <platform-specific mechanism>)
4. If approved, call confirm_operation via mcp_aql_execute
5. If denied, log the denial and continue normal operation
```

### Example: Self-Gating in Agent Instructions

```markdown
## Self-Gating for External Actions

Before taking ANY external-facing action beyond routine operations:

1. Announce the planned action on the communication channel:
   "[action-approval] I need to <action>. Approve?"
2. Wait for explicit approval from an authorized user
3. Execute only after approval

Requires approval: GitHub operations, shell commands modifying external state,
API calls to external services, file modifications outside I/O paths

Does NOT require approval: Reading input, writing responses, reading elements,
polling intervals, execution state updates
```

---

## Autonomy Configuration

The agent's autonomy config should reflect the approval pattern:

```yaml
autonomy:
  riskTolerance: moderate
  maxAutonomousSteps: 15
  requiresApproval:
    - "*delete*"
    - "*edit_element*"
    - "*push*"
    - "*create_element*"
    - "*gh issue*"
    - "*gh pr*"
  autoApprove:
    - "*read*"
    - "*search*"
    - "*get*"
    - "*list*"
    - "*record_execution_step*"
```

When `nextActionHint` matches a `requiresApproval` pattern, the Autonomy Evaluator returns `continue: false`. The agent should then forward the approval request to the external interface.

---

## Platform-Specific Implementation

The approval pattern is platform-agnostic at the protocol level. Platform-specific details include:

| Aspect | Platform Responsibility |
|--------|----------------------|
| Message format | How `[approval-needed]` requests are displayed |
| Identity verification | How the approver's identity is confirmed |
| Polling mechanism | How the agent checks for approval responses |
| Response parsing | How approval/denial is extracted from the response |
| Timeout handling | What happens if no response arrives within a window |

### Example: Chat Platform (Zulip, Slack, Discord)

- **Format**: Post approval request as a channel message
- **Identity**: Verify by authenticated sender email/ID (not display name)
- **Polling**: Read the message inbox for responses from authorized users
- **Response**: Natural language ("approved", "go ahead", "deny", etc.)
- **Timeout**: Continue polling loop; re-request if no response after N cycles

### Example: API Gateway

- **Format**: Return HTTP 202 with approval request in response body
- **Identity**: Verify by API authentication token
- **Polling**: Wait for callback or poll approval endpoint
- **Response**: Structured JSON `{ "approved": true/false }`
- **Timeout**: Return 408 timeout, allow client to retry

---

## The Two Permission Layers

Remote agents encounter two distinct permission layers:

| Layer | What It Gates | Detection | Forwarding |
|-------|--------------|-----------|------------|
| **Gatekeeper** (MCP-level) | MCP operations: `execute_agent`, `edit_element`, `create_element` | Agent sees `confirm_operation` error in MCP response | Automatic: agent posts to external interface |
| **Host Runtime** (tool-level) | Platform-native tools: shell, file I/O, HTTP | Agent cannot intercept; prompt appears in host terminal | Behavioral: agent self-gates before executing |

Both layers must be addressed for the pattern to be complete. The Gatekeeper provides technical enforcement (the operation is blocked until confirmed). Self-gating provides behavioral enforcement (the agent announces before acting).

---

## Why This Matters

This pattern enables DollhouseMCP agents to operate safely on **any LLM platform with any external interface**:

- Chat platforms (Zulip, Slack, Discord, Teams)
- API gateways and webhooks
- Headless CLI sessions (`claude -p`)
- Voice interfaces
- Mobile apps
- Browser extensions

The agent's instructions encode the approval behavior, so any LLM following those instructions will implement the same safety protocol. The Gatekeeper provides server-side enforcement. Together they create a portable, platform-agnostic permission model for remote agent operation.

---

## Related Documentation

- [Gatekeeper implementation](../../src/handlers/mcp-aql/Gatekeeper.ts) — Policy enforcement engine
- [Autonomy Evaluator](../../src/elements/agents/autonomyEvaluator.ts) — 5-stage evaluation pipeline
- [DangerZoneEnforcer](../../src/security/DangerZoneEnforcer.ts) — Persistent agent blocking
- [Agent Execution](../../src/elements/agents/) — Agent lifecycle management

---

*This document describes the Remote Agent Approval Pattern as of 2026-02-23. The pattern is implemented in the DollhouseBridge (`zulip-inbox-watcher` agent) and is intended as a universal reference for all remote agent implementations.*
