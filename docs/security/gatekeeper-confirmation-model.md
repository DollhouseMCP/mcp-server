# Gatekeeper Confirmation & Sandbox Model

## Overview

DollhouseMCP's Gatekeeper enforces a multi-layer permission system on every MCP-AQL operation. This document describes how confirmation flows work, how elements control them, and how the sandbox model prevents automated abuse — including through agentic loop integrations like Zulip bridges.

## The Confirmation Flow

When an operation requires confirmation (e.g., `create_element`, `execute_agent`), the flow is:

1. **LLM calls operation** → Gatekeeper evaluates 4 layers → blocks with `confirmationPending`
2. **LLM calls `confirm_operation`** → handler records the confirmation
3. **LLM retries operation** → Gatekeeper finds the session confirmation → allows

This is the same flow regardless of client: Claude Code, Zulip bridge, any MCP client.

## Permission Levels

Every operation has a default permission level:

| Level | Behavior | Operations |
|---|---|---|
| **AUTO_APPROVE** | No confirmation needed | All reads, search, list, activate, deactivate, introspect |
| **CONFIRM_SESSION** | One confirmation unlocks for the entire session | create, import, install, submit, sync, auth setup |
| **CONFIRM_SINGLE_USE** | Fresh confirmation required every time | edit, delete, clear, execute_agent, abort |
| **DENY** | Hard-blocked, cannot be confirmed | (none by default — elements can add) |

## Element Policy Controls

Active elements (personas, skills, agents, ensembles) can declare gatekeeper policies that modify these defaults:

```yaml
gatekeeper:
  # Internal operations (MCP-AQL layer)
  allow:
    - read_*
    - list_*
    - search_*
    - get_*
  confirm:
    - edit_*
    - update_*
    - execute_agent
  deny:
    - delete_*
    - clear_*

  # External tool calls (CLI layer)
  externalRestrictions:
    description: "Read-only development session"
    allowPatterns:
      - "Read:*"
      - "Glob:*"
      - "Grep:*"
    confirmPatterns:
      - "Edit:*"
      - "Write:*"
      - "Bash:git push*"
    denyPatterns:
      - "Bash:rm *"
      - "WebSearch:*"
```

Priority: **element deny > element confirm > element allow > route default**

Both systems (internal and external) are evaluated across all active elements on every request. A single element definition controls both the MCP operation surface and the external tool surface.

### Choose the Right Policy Surface

Use the two policy surfaces differently:

- `gatekeeper.allow / confirm / deny`
  - For Dollhouse / MCP-AQL operation names such as `read_*`, `edit_*`, `delete_element`, or `execute_agent`
- `gatekeeper.externalRestrictions.allowPatterns / confirmPatterns / denyPatterns`
  - For external tool or hook patterns such as `Read:*`, `Edit:*`, `Write:*`, `Bash:git status*`, or `Bash:rm *`

`externalRestrictions` must stay nested under `gatekeeper`, and it must include a non-empty `description`.

### Directly Usable Profiles

#### Read-only analyst

```yaml
gatekeeper:
  allow:
    - read_*
    - list_*
    - search_*
    - get_*
    - browse_*
    - query_*
  deny:
    - create_*
    - edit_*
    - update_*
    - delete_*
    - clear_*
    - execute_agent
  externalRestrictions:
    description: "Read-only shell and tool usage"
    allowPatterns:
      - "Read:*"
      - "Glob:*"
      - "Grep:*"
    denyPatterns:
      - "Edit:*"
      - "Write:*"
      - "Bash:*"
      - "WebSearch:*"
```

#### Confirm writes, deny destructive shell commands

```yaml
gatekeeper:
  allow:
    - read_*
    - list_*
    - search_*
    - get_*
  confirm:
    - create_*
    - edit_*
    - update_*
  deny:
    - delete_*
  externalRestrictions:
    description: "Confirm writes, block high-risk external actions"
    allowPatterns:
      - "Read:*"
      - "Glob:*"
      - "Grep:*"
    confirmPatterns:
      - "Edit:*"
      - "Write:*"
      - "Bash:git push*"
    denyPatterns:
      - "Bash:rm *"
      - "Bash:sudo *"
      - "WebFetch:*"
```

## The Sandbox Model

### Nuclear Sandbox: `deny: ['confirm_operation']`

When any active element has `deny: ['confirm_operation']` in its gatekeeper policy, **ALL confirmations are blocked**. The LLM cannot unlock any gated operation — the session becomes effectively read-only.

Operations still available:
- All AUTO_APPROVE operations (read, search, list, activate, deactivate, export, introspect)

Operations blocked:
- All CONFIRM_SESSION operations (create, import, install, submit, sync)
- All CONFIRM_SINGLE_USE operations (edit, delete, clear, execute_agent, abort)

The human can restore confirmation capability by deactivating the sandboxing element (deactivate_element is AUTO_APPROVE).

**This is critical for safety.** See "Why This Matters" below.

### Granular Lockdown: `deny: ['specific_operation']`

Denying specific operations creates targeted restrictions:

```yaml
gatekeeper:
  deny:
    - execute_agent     # Cannot run agents
    - delete_element    # Cannot delete anything
```

`confirm_operation` cannot override a deny. The operation is hard-blocked regardless of confirmation state. The element must be deactivated or edited to restore access.

### Advisory: `confirm: ['confirm_operation']`

When an active element has `confirm: ['confirm_operation']`, confirmations still work but the response includes an advisory message: *"Note: persona 'careful-reviewer' requests additional scrutiny for confirmations."*

This surfaces the element author's intent for human awareness without blocking the flow.

## Why This Matters: The Session-Allow Problem

MCP clients like Claude Code have their own permission system. When the LLM calls an MCP tool, the client asks the user: "Allow once" / "Allow for session" / "Deny."

**If the user clicks "Allow for session" for the MCP AQL execute endpoint**, the client stops asking. All subsequent tool calls go through automatically. At this point, **the DollhouseMCP Gatekeeper is the only protection** between the LLM and destructive operations.

Without a sandbox, the LLM can automate the confirmation loop:

1. Call `execute_agent` → gatekeeper blocks
2. Call `confirm_operation` → gatekeeper records confirmation
3. Retry `execute_agent` → passes
4. Repeat indefinitely

The human clicked "allow for session" once and isn't reviewing individual operations. The LLM rubber-stamps its own confirmations.

**`deny: ['confirm_operation']` breaks this loop.** Step 2 fails — the sandbox blocks the confirmation. The LLM cannot proceed regardless of what the MCP client allows.

This is the same class of problem that caused the widely-reported incident where an LLM destroyed 2.5 years of Terraform infrastructure in an automated session.

## Agentic Loop Flow (Zulip Bridge, etc.)

In bridge integrations, the bridge IS the human-in-the-loop:

1. Agent calls `execute_agent` → Gatekeeper blocks → `confirmationPending`
2. Block bubbles up through the agentic loop
3. Bridge surfaces the request to the human (e.g., Zulip chat message)
4. Human approves → bridge calls `confirm_operation` on behalf of the human
5. Handler evaluates the TARGET operation with **full element policies** (deny/confirm/allow)
6. If target is denied → hard refusal, bridge reports denial to human
7. If target needs confirmation → records it, agent retries → passes
8. For CONFIRM_SINGLE_USE operations → confirmation consumed, next call needs fresh approval

**Key architectural property:** The `confirm_operation` handler skips element policies for itself (preventing cascading loops) but evaluates them fully for the target operation. This means element policies like `deny: ['execute_agent']` are respected through the bridge — the bridge cannot override element-level denials.

The sandbox (`deny: ['confirm_operation']`) also works through bridges — if the sandboxing element is active, the bridge's confirm call is rejected, and the human is informed that the session is sandboxed.

## Interactive Session Flow

In direct MCP client sessions (Claude Code, etc.):

1. LLM calls operation → Gatekeeper blocks → failure message with human-readable summary: *"Approval needed: Create a new agent called 'code-reviewer'"*
2. LLM calls `confirm_operation` → `skipElementPolicies` in primary enforcement ensures this always reaches the handler
3. Handler checks for nuclear sandbox (`deny: ['confirm_operation']` on any active element) → if found, hard refusal with clear message
4. Handler checks for advisory (`confirm: ['confirm_operation']` on any active element) → if found, advisory included in response
5. Handler evaluates target operation with full element policies → determines confirmation level
6. Records confirmation → returns human-readable summary with advisory if applicable
7. LLM retries → passes

## Implementation Details

### Two Related Operation Sets

**UNGATABLE_OPERATIONS**: Operations that must never appear in element policies. Pure internal plumbing — `verify_challenge`, `approve_cli_permission`, `permission_prompt`. Stripped from all policy lists during sanitization.

**GATEKEEPER_INFRA_OPERATIONS**: Superset of UNGATABLE_OPERATIONS plus `confirm_operation`. Operations that skip Layer 2 (element policy evaluation) in the primary enforcement path. `confirm_operation` is in this set because its element policies are enforced through a separate code path in the confirm handler, not through the normal `enforce()` flow.

### canBeElevated: false

Some operations have `canBeElevated: false` in their route policy, meaning element `allow` lists cannot elevate them to AUTO_APPROVE. This includes:
- `execute_agent` — always CONFIRM_SINGLE_USE
- `delete_element` — always CONFIRM_SINGLE_USE
- `clear` — always CONFIRM_SINGLE_USE
- `confirm_operation` — always AUTO_APPROVE (cannot be downgraded by allow)

This is a server-side invariant that element authors cannot override.

### Parallel Enforcement

| Layer | Internal (MCP-AQL) | External (CLI tools) |
|---|---|---|
| **Policy source** | `gatekeeper.allow/confirm/deny` | `gatekeeper.externalRestrictions.allowPatterns/confirmPatterns/denyPatterns` |
| **Enforcement** | `Gatekeeper.enforce()` | `ToolClassification.evaluateElementPolicies()` |
| **Priority** | deny > confirm > allow > route default | deny > confirm > allow > static classification |
| **Scope** | All active elements evaluated | All active elements evaluated |
| **Export** | Via MCP-AQL introspection | Via `PolicyExportService` to bridge imports |

Both systems are defined in the same element, enforced per-request, and respect the same priority hierarchy.
